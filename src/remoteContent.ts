import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { ConnectionManager } from './connection';

export const REMOTE_SCHEME = 'ferry-remote';
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/** Read-only documents with the content of remote files, used as the left side of diffs. */
export class RemoteContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly buffers = new Map<string, Buffer>();
  private cachedBytes = 0;

  constructor(private readonly config: ConfigManager, private readonly conns: ConnectionManager) {}

  static uri(server: string, remoteAbs: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REMOTE_SCHEME, path: remoteAbs, query: new URLSearchParams({ server }).toString() });
  }

  private static key(server: string, remoteAbs: string): string {
    return `${server}\0${remoteAbs}`;
  }

  cache(server: string, remoteAbs: string, buf: Buffer): void {
    const key = RemoteContentProvider.key(server, remoteAbs);
    this.drop(key);
    if (buf.length > MAX_CACHE_BYTES / 4) {
      return;
    }
    // Evict oldest entries (Map preserves insertion order).
    for (const k of this.buffers.keys()) {
      if (this.cachedBytes + buf.length <= MAX_CACHE_BYTES) {
        break;
      }
      this.drop(k);
    }
    this.buffers.set(key, buf);
    this.cachedBytes += buf.length;
  }

  invalidate(server: string, remoteAbs: string): void {
    this.drop(RemoteContentProvider.key(server, remoteAbs));
    this.emitter.fire(RemoteContentProvider.uri(server, remoteAbs));
  }

  private drop(key: string): void {
    const old = this.buffers.get(key);
    if (old) {
      this.cachedBytes -= old.length;
      this.buffers.delete(key);
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const serverName = new URLSearchParams(uri.query).get('server') ?? '';
    const key = RemoteContentProvider.key(serverName, uri.path);
    let buf = this.buffers.get(key);
    if (!buf) {
      const server = this.config.getServer(serverName);
      if (!server) {
        throw new Error(`Unknown server "${serverName}"`);
      }
      const limit = vscode.workspace.getConfiguration('ferry').get<number>('maxContentCompareSize', 10 * 1024 * 1024);
      const { size } = await this.conns.withClient(server, (c) => c.stat(uri.path));
      if (size > limit) {
        return `(file too large to preview: ${(size / 1024 / 1024).toFixed(1)} MB — limit is ferry.maxContentCompareSize)`;
      }
      buf = (await this.conns.withClient(server, (c) => c.get(uri.path))) as Buffer;
      this.cache(serverName, uri.path, buf);
    }
    if (buf.subarray(0, 8000).includes(0)) {
      return `(binary file, ${buf.length} bytes — no text preview)`;
    }
    return buf.toString('utf8');
  }
}
