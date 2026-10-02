import * as vscode from 'vscode';
import SftpClient from 'ssh2-sftp-client';
import { ConfigManager, ServerConfig } from './config';
import { ConnectionManager } from './connection';
import { log } from './log';

/** Editable remote files: `ferry-sftp:/abs/path?server=<name>`. Saving writes straight to the server. */
export const SFTP_SCHEME = 'ferry-sftp';

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return e?.code === 2 || e?.code === 'ENOENT' || /no such file|not exist/i.test(String(e?.message ?? err));
}

export class RemoteFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Called after a remote file was written or removed; `added` is true when entries appeared or disappeared. */
  onDidWrite?: (server: ServerConfig, remoteAbs: string, added: boolean) => void;

  constructor(private readonly config: ConfigManager, private readonly conns: ConnectionManager) {}

  static uri(server: string, remoteAbs: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SFTP_SCHEME, path: remoteAbs, query: new URLSearchParams({ server }).toString() });
  }

  private server(uri: vscode.Uri): ServerConfig {
    const name = new URLSearchParams(uri.query).get('server') ?? '';
    const server = this.config.getServer(name);
    if (!server) {
      throw vscode.FileSystemError.Unavailable(`Ferry: unknown server "${name}"`);
    }
    return server;
  }

  /** Runs an SFTP operation, mapping "no such file" to the error VS Code expects. */
  private async run<T>(uri: vscode.Uri, fn: (c: SftpClient, s: ServerConfig) => Promise<T>): Promise<T> {
    const server = this.server(uri);
    try {
      return await this.conns.withClient(server, (c) => fn(c, server));
    } catch (err) {
      if (err instanceof vscode.FileSystemError) throw err;
      if (isNotFound(err)) throw vscode.FileSystemError.FileNotFound(uri);
      throw err;
    }
  }

  watch(): vscode.Disposable {
    // SFTP has no change notifications; VS Code compares modification times when saving instead.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(uri, async (c) => {
      const st = await c.stat(uri.path);
      return {
        type: st.isDirectory ? vscode.FileType.Directory : st.isFile ? vscode.FileType.File : vscode.FileType.Unknown,
        ctime: st.modifyTime,
        mtime: st.modifyTime,
        size: st.size,
      };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(uri, async (c) =>
      (await c.list(uri.path)).map((e): [string, vscode.FileType] => [
        e.name,
        e.type === 'd' ? vscode.FileType.Directory : e.type === 'l' ? vscode.FileType.SymbolicLink : vscode.FileType.File,
      ]));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(uri, async (c) => (await c.get(uri.path)) as Buffer);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    await this.run(uri, async (c, server) => {
      const kind = await c.exists(uri.path);
      if (kind === 'd') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (!kind && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (kind && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      await c.put(Buffer.from(content), uri.path);
      log(`saved remote ${server.name}:${uri.path} (${content.length} bytes)`);
      this.onDidWrite?.(server, uri.path, !kind);
      this.emitter.fire([{ type: kind ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.run(uri, async (c, server) => {
      await c.mkdir(uri.path, false);
      this.onDidWrite?.(server, uri.path, true);
      this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.run(uri, async (c, server) => {
      if ((await c.exists(uri.path)) === 'd') await c.rmdir(uri.path, options.recursive);
      else await c.delete(uri.path);
      this.onDidWrite?.(server, uri.path, true);
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    await this.run(oldUri, async (c, server) => {
      if (await c.exists(newUri.path)) {
        if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
        await c.delete(newUri.path);
      }
      await c.rename(oldUri.path, newUri.path);
      this.onDidWrite?.(server, oldUri.path, true);
      this.onDidWrite?.(server, newUri.path, true);
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
    });
  }
}
