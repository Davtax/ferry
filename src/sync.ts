import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { ConfigManager, ServerConfig } from './config';
import { ConnectionManager } from './connection';
import { IgnoreManager, Matcher } from './ignore';
import { RemoteContentProvider } from './remoteContent';
import { log, runPool } from './log';
import { TransferProgress } from './progress';

export interface FileInfo {
  size: number;
  /** Modification time in ms. Remote times have 1 s resolution. */
  mtime: number;
}

export type EntryStatus = 'modified' | 'conflict' | 'localOnly' | 'remoteOnly';
export type SyncAction = 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'skip';

export interface SyncEntry {
  rel: string;
  status: EntryStatus;
  local?: FileInfo;
  remote?: FileInfo;
  action: SyncAction;
  suggested: SyncAction;
  note: string;
}

export interface CompareResult {
  entries: SyncEntry[];
  identical: number;
  /** Files counted as identical because only line endings / whitespace differ (included in `identical`). */
  ignoredDiffs: number;
}

export interface ApplyResult {
  done: SyncEntry[];
  failed: { entry: SyncEntry; error: string }[];
}

/** Sizes and mtimes of both sides at the moment of the last successful sync of a file. */
interface StateRecord {
  ls: number;
  lm: number;
  rs: number;
  rm: number;
}

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

class SyncState {
  private readonly data: Record<string, StateRecord>;

  constructor(private readonly memento: vscode.Memento, private readonly key: string) {
    this.data = { ...memento.get<Record<string, StateRecord>>(key, {}) };
  }

  get(rel: string): StateRecord | undefined {
    return this.data[rel];
  }

  set(rel: string, local: FileInfo, remote: FileInfo): void {
    this.data[rel] = { ls: local.size, lm: local.mtime, rs: remote.size, rm: remote.mtime };
  }

  delete(rel: string): void {
    delete this.data[rel];
  }

  keysUnder(scope: string): string[] {
    return Object.keys(this.data).filter((k) => !scope || k === scope || k.startsWith(scope + '/'));
  }

  save(): Thenable<void> {
    return this.memento.update(this.key, this.data);
  }
}

function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

async function localInfo(abs: string): Promise<FileInfo | undefined> {
  try {
    const st = await fs.promises.stat(abs);
    return st.isFile() ? { size: st.size, mtime: Math.floor(st.mtimeMs) } : undefined;
  } catch {
    return undefined;
  }
}

async function remoteInfo(client: SftpClient, abs: string): Promise<FileInfo | undefined> {
  try {
    const st = await client.stat(abs);
    return st.isFile ? { size: st.size, mtime: st.modifyTime } : undefined;
  } catch {
    return undefined;
  }
}

export type WhitespaceMode = 'off' | 'trailing' | 'amount';

/**
 * Text used to decide whether two files differ when line-ending or whitespace differences are ignored.
 * Works on latin1 so every byte maps to one character; only ASCII whitespace is touched.
 */
export function normalizeForCompare(buf: Buffer, ignoreLineEndings: boolean, whitespace: WhitespaceMode): string {
  let text = buf.toString('latin1');
  if (ignoreLineEndings) {
    text = text.replace(/\r\n?/g, '\n');
  }
  if (whitespace === 'amount') {
    text = text.replace(/[ \t\f\v]+/g, ' ');
  }
  if (whitespace !== 'off') {
    text = text.replace(/[ \t\f\v]+(?=\r?\n|\r|$)/g, '').replace(/(\r\n|\r|\n)+$/, '');
  }
  return text;
}

/** True when the buffers differ only in what the ignore settings allow. Binary files never match this way. */
export function equalIgnoring(a: Buffer, b: Buffer, ignoreLineEndings: boolean, whitespace: WhitespaceMode): boolean {
  if (!ignoreLineEndings && whitespace === 'off') {
    return false;
  }
  if (a.subarray(0, 8000).includes(0) || b.subarray(0, 8000).includes(0)) {
    return false;
  }
  return normalizeForCompare(a, ignoreLineEndings, whitespace) === normalizeForCompare(b, ignoreLineEndings, whitespace);
}

export class SyncEngine {
  constructor(
    private readonly config: ConfigManager,
    private readonly conns: ConnectionManager,
    private readonly ignores: IgnoreManager,
    private readonly remote: RemoteContentProvider,
    private readonly memento: vscode.Memento,
  ) {}

  private get settings() {
    return vscode.workspace.getConfiguration('ferry');
  }

  private get concurrency(): number {
    return Math.max(1, this.settings.get<number>('concurrency', 4));
  }

  /** Moves the sync history when a server is renamed. */
  async renameState(oldName: string, newName: string): Promise<void> {
    const data = this.memento.get(`ferry.state.${oldName}`);
    await this.memento.update(`ferry.state.${newName}`, data);
    await this.memento.update(`ferry.state.${oldName}`, undefined);
  }

  /** Drops sync history for a path (and everything below it) after a remote rename/delete. */
  async forget(server: ServerConfig, rel: string): Promise<void> {
    const state = this.state(server);
    state.keysUnder(rel).forEach((k) => state.delete(k));
    await state.save();
  }

  private state(server: ServerConfig): SyncState {
    return new SyncState(this.memento, `ferry.state.${server.name}`);
  }

  // ---------------------------------------------------------------- listing

  async listLocal(server: ServerConfig, scope: string, matcher: Matcher, token?: vscode.CancellationToken): Promise<Map<string, FileInfo>> {
    const out = new Map<string, FileInfo>();
    const root = this.config.localRoot(server);
    const scopeAbs = this.config.toLocal(server, scope);
    const single = await localInfo(scopeAbs);
    if (single) {
      if (!matcher.isIgnored(scope, false)) {
        out.set(scope, single);
      }
      return out;
    }
    const walk = async (rel: string): Promise<void> => {
      if (token?.isCancellationRequested) {
        return;
      }
      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        const childRel = joinRel(rel, d.name);
        let isDir = d.isDirectory();
        let isFile = d.isFile();
        if (d.isSymbolicLink()) {
          // Follow file links; skip directory links to avoid cycles.
          const st = await fs.promises.stat(path.join(root, childRel)).catch(() => undefined);
          isFile = !!st?.isFile();
          isDir = false;
        }
        if (matcher.isIgnored(childRel, isDir)) {
          continue;
        }
        if (isDir) {
          await walk(childRel);
        } else if (isFile) {
          const info = await localInfo(path.join(root, childRel));
          if (info) {
            out.set(childRel, info);
          }
        }
      }
    };
    await walk(scope);
    return out;
  }

  async listRemote(server: ServerConfig, scope: string, matcher: Matcher, token?: vscode.CancellationToken): Promise<Map<string, FileInfo>> {
    return this.conns.withClient(server, async (client) => {
      const out = new Map<string, FileInfo>();
      const scopeAbs = this.config.toRemote(server, scope);
      const kind = await client.exists(scopeAbs);
      if (!kind) {
        return out;
      }
      if (kind !== 'd') {
        const info = await remoteInfo(client, scopeAbs);
        if (info && !matcher.isIgnored(scope, false)) {
          out.set(scope, info);
        }
        return out;
      }

      const queue: string[] = [scope];
      let active = 0;
      await new Promise<void>((resolve, reject) => {
        const pump = () => {
          if (token?.isCancellationRequested || (queue.length === 0 && active === 0)) {
            resolve();
            return;
          }
          while (active < this.concurrency && queue.length > 0) {
            const rel = queue.shift()!;
            active++;
            this.listDir(client, server, rel, matcher, out, queue)
              .then(() => {
                active--;
                pump();
              })
              .catch(reject);
          }
        };
        pump();
      });
      return out;
    });
  }

  private async listDir(
    client: SftpClient,
    server: ServerConfig,
    rel: string,
    matcher: Matcher,
    out: Map<string, FileInfo>,
    queue: string[],
  ): Promise<void> {
    const items = await client.list(this.config.toRemote(server, rel));
    for (const it of items) {
      if (it.name === '.' || it.name === '..') {
        continue;
      }
      const childRel = joinRel(rel, it.name);
      if (it.type === 'd') {
        if (!matcher.isIgnored(childRel, true)) {
          queue.push(childRel);
        }
      } else if (it.type === '-') {
        if (!matcher.isIgnored(childRel, false)) {
          out.set(childRel, { size: it.size, mtime: it.modifyTime });
        }
      } else if (it.type === 'l' && !matcher.isIgnored(childRel, false)) {
        const info = await remoteInfo(client, this.config.toRemote(server, childRel));
        if (info) {
          out.set(childRel, info);
        }
      }
    }
  }

  // ---------------------------------------------------------------- compare

  async compare(server: ServerConfig, scope: string, progress: Progress, token: vscode.CancellationToken): Promise<CompareResult> {
    const matcher = this.ignores.matcher(server);
    const state = this.state(server);
    const mode = this.settings.get<'content' | 'size'>('compareMode', 'content');
    const maxSize = this.settings.get<number>('maxContentCompareSize', 10 * 1024 * 1024);
    const ignoreLineEndings = this.settings.get<boolean>('ignoreLineEndings', false);
    const whitespace = this.settings.get<WhitespaceMode>('ignoreWhitespace', 'off');
    // Files of different size can still be "equal" when line endings or whitespace are ignored.
    const lenient = ignoreLineEndings || whitespace !== 'off';
    let ignoredDiffs = 0;

    progress.report({ message: 'Scanning local files…' });
    const local = await this.listLocal(server, scope, matcher, token);
    progress.report({ message: 'Scanning remote files…' });
    const remote = await this.listRemote(server, scope, matcher, token);

    const entries: SyncEntry[] = [];
    let identical = 0;
    const needsContent: { rel: string; l: FileInfo; r: FileInfo; st?: StateRecord }[] = [];

    const push = (rel: string, status: EntryStatus, action: SyncAction, note: string) => {
      entries.push({ rel, status, local: local.get(rel), remote: remote.get(rel), action, suggested: action, note });
    };

    const decideDifferent = (rel: string, l: FileInfo, r: FileInfo, st?: StateRecord) => {
      if (st) {
        const lChanged = st.ls !== l.size || st.lm !== l.mtime;
        const rChanged = st.rs !== r.size || st.rm !== r.mtime;
        if (lChanged && rChanged) {
          push(rel, 'conflict', 'skip', 'changed on both sides since last sync');
        } else if (rChanged) {
          push(rel, 'modified', 'download', 'changed on remote');
        } else {
          push(rel, 'modified', 'upload', 'changed locally');
        }
      } else if (l.mtime >= r.mtime) {
        push(rel, 'modified', 'upload', 'local is newer');
      } else {
        push(rel, 'modified', 'download', 'remote is newer');
      }
    };

    for (const rel of new Set([...local.keys(), ...remote.keys()])) {
      const l = local.get(rel);
      const r = remote.get(rel);
      const st = state.get(rel);
      if (l && r) {
        const unchanged = st && st.ls === l.size && st.lm === l.mtime && st.rs === r.size && st.rm === r.mtime;
        if (unchanged) {
          identical++;
        } else if (l.size !== r.size && !(lenient && l.size <= maxSize && r.size <= maxSize)) {
          decideDifferent(rel, l, r, st);
        } else if (l.size !== r.size) {
          needsContent.push({ rel, l, r, st });
        } else if (mode === 'size' || l.size > maxSize) {
          if (st) {
            decideDifferent(rel, l, r, st);
          } else {
            identical++;
            state.set(rel, l, r);
          }
        } else {
          needsContent.push({ rel, l, r, st });
        }
      } else if (l) {
        if (st) {
          push(rel, 'localOnly', 'skip', 'deleted on remote since last sync');
        } else {
          push(rel, 'localOnly', 'upload', 'only exists locally');
        }
      } else if (r) {
        if (st && st.rs === r.size && st.rm === r.mtime) {
          push(rel, 'remoteOnly', 'deleteRemote', 'deleted locally since last sync');
        } else if (st) {
          push(rel, 'remoteOnly', 'skip', 'deleted locally, but changed on remote since last sync');
        } else {
          push(rel, 'remoteOnly', 'download', 'only exists on remote');
        }
      }
    }

    // Byte-compare same-size files.
    let checked = 0;
    await this.conns.withClient(server, (client) =>
      runPool(needsContent, this.concurrency, async ({ rel, l, r, st }) => {
        progress.report({ message: `Comparing contents ${++checked}/${needsContent.length}` });
        const remoteAbs = this.config.toRemote(server, rel);
        const [localBuf, remoteBuf] = await Promise.all([
          fs.promises.readFile(this.config.toLocal(server, rel)),
          client.get(remoteAbs) as Promise<Buffer>,
        ]);
        this.remote.cache(server.name, remoteAbs, remoteBuf);
        if (localBuf.equals(remoteBuf)) {
          identical++;
          state.set(rel, l, r);
        } else if (equalIgnoring(localBuf, remoteBuf, ignoreLineEndings, whitespace)) {
          // Counted as in sync; recording the state keeps it quiet until either side changes again.
          identical++;
          ignoredDiffs++;
          state.set(rel, l, r);
        } else {
          decideDifferent(rel, l, r, st);
        }
      }, token),
    );

    // Forget files that no longer exist on either side.
    for (const rel of state.keysUnder(scope)) {
      if (!local.has(rel) && !remote.has(rel)) {
        state.delete(rel);
      }
    }
    await state.save();

    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    return { entries, identical, ignoredDiffs };
  }

  // ---------------------------------------------------------------- apply

  async apply(server: ServerConfig, entries: SyncEntry[], progress: Progress, token?: vscode.CancellationToken): Promise<ApplyResult> {
    const todo = entries.filter((e) => e.action !== 'skip');
    const state = this.state(server);
    const result: ApplyResult = { done: [], failed: [] };
    // One mkdir per directory: parallel uploads into a new folder must not race to create it.
    const dirReady = new Map<string, Promise<void>>();
    const ensureRemoteDir = (client: SftpClient, dir: string): Promise<void> => {
      let ready = dirReady.get(dir);
      if (!ready) {
        ready = (async () => {
          if (await client.exists(dir)) {
            return;
          }
          const parent = path.posix.dirname(dir);
          if (parent !== dir) {
            await ensureRemoteDir(client, parent);
          }
          try {
            await client.mkdir(dir);
          } catch (err) {
            // Created concurrently by someone else (servers report this as a generic failure).
            if ((await client.exists(dir)) !== 'd') {
              throw err;
            }
          }
        })();
        dirReady.set(dir, ready);
        ready.catch(() => dirReady.delete(dir));
      }
      return ready;
    };
    // Sizes drive the byte-based progress bar; forced entries may not know them yet.
    const sizes = new Map<SyncEntry, number>();
    await this.conns.withClient(server, (client) =>
      runPool(todo, this.concurrency, async (e) => {
        let size = 0;
        if (e.action === 'upload') {
          size = e.local?.size ?? (await localInfo(this.config.toLocal(server, e.rel)))?.size ?? 0;
        } else if (e.action === 'download') {
          size = e.remote?.size ?? (await remoteInfo(client, this.config.toRemote(server, e.rel)))?.size ?? 0;
        }
        sizes.set(e, size);
      }),
    );
    const totalBytes = [...sizes.values()].reduce((a, b) => a + b, 0);
    const tracker = new TransferProgress(progress, totalBytes, todo.length);

    try {
      await this.conns.withClient(server, (client) =>
        runPool(todo, this.concurrency, async (entry) => {
          const localAbs = this.config.toLocal(server, entry.rel);
          const remoteAbs = this.config.toRemote(server, entry.rel);
          tracker.start(entry, entry.rel, () => 0);
          try {
            switch (entry.action) {
              case 'upload':
                await ensureRemoteDir(client, path.posix.dirname(remoteAbs));
                await this.upload(client, localAbs, remoteAbs, (bytes) => tracker.start(entry, entry.rel, bytes), token);
                break;
              case 'download':
                await this.download(client, remoteAbs, localAbs, (bytes) => tracker.start(entry, entry.rel, bytes), token);
                break;
              case 'deleteRemote':
                await client.delete(remoteAbs);
                break;
              case 'deleteLocal':
                await vscode.workspace.fs.delete(vscode.Uri.file(localAbs), { useTrash: true });
                break;
            }
            this.remote.invalidate(server.name, remoteAbs);
            const [l, r] = await Promise.all([localInfo(localAbs), remoteInfo(client, remoteAbs)]);
            if (l && r) {
              state.set(entry.rel, l, r);
            } else {
              state.delete(entry.rel);
            }
            log(`${entry.action} ${entry.rel}`);
            result.done.push(entry);
          } catch (err) {
            log(`FAILED ${entry.action} ${entry.rel}: ${err}`);
            result.failed.push({ entry, error: String((err as Error)?.message ?? err) });
          }
          tracker.finish(entry, sizes.get(entry) ?? 0);
        }, token),
      );
    } finally {
      tracker.dispose();
    }
    await state.save();
    return result;
  }

  /** Streams a local file to the server, exposing the bytes read so far. */
  private async upload(
    client: SftpClient,
    localAbs: string,
    remoteAbs: string,
    track: (bytes: () => number) => void,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    const rs = fs.createReadStream(localAbs);
    track(() => rs.bytesRead);
    const onCancel = token?.onCancellationRequested(() => rs.destroy(new Error('Cancelled')));
    try {
      await client.put(rs, remoteAbs);
    } finally {
      onCancel?.dispose();
      rs.destroy();
    }
  }

  /**
   * Downloads into `<file>.ferry-part` and renames it over the local file only once complete,
   * so a failed or cancelled download never leaves a truncated file behind.
   */
  private async download(
    client: SftpClient,
    remoteAbs: string,
    localAbs: string,
    track: (bytes: () => number) => void,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    await fs.promises.mkdir(path.dirname(localAbs), { recursive: true });
    const part = `${localAbs}.ferry-part`;
    const ws = fs.createWriteStream(part);
    track(() => ws.bytesWritten);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const onCancel = token?.onCancellationRequested(() => ws.destroy(new Error('Cancelled')));
    try {
      await client.get(remoteAbs, ws);
      // get() resolves when the remote read ends; wait until the file is flushed and closed.
      await closed;
      if (token?.isCancellationRequested) {
        throw new Error('Cancelled');
      }
      await fs.promises.rename(part, localAbs);
    } catch (err) {
      ws.destroy();
      await closed;
      await fs.promises.unlink(part).catch(() => undefined);
      throw err;
    } finally {
      onCancel?.dispose();
    }
  }

  /** Builds forced entries for every (non-ignored) file under `scope` on one side. */
  async entriesFor(server: ServerConfig, scope: string, action: 'upload' | 'download'): Promise<SyncEntry[]> {
    const matcher = this.ignores.matcher(server);
    const files = action === 'upload'
      ? await this.listLocal(server, scope, matcher)
      : await this.listRemote(server, scope, matcher);
    return [...files.entries()].map(([rel, info]) => ({
      rel,
      status: 'modified' as const,
      [action === 'upload' ? 'local' : 'remote']: info,
      action,
      suggested: action,
      note: '',
    }));
  }

  /** True when the remote file is unchanged since we last synced it (or we never did). */
  async remoteUnchangedSinceSync(server: ServerConfig, rel: string): Promise<boolean> {
    const st = this.state(server).get(rel);
    if (!st) {
      return true;
    }
    const r = await this.conns.withClient(server, (c) => remoteInfo(c, this.config.toRemote(server, rel)));
    return !r || (r.size === st.rs && r.mtime === st.rm);
  }
}
