import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as jsonc from 'jsonc-parser';

export interface ServerConfig {
  name: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  /** Authentication method; `key` without `privateKeyPath` means the key path is kept per machine. */
  auth?: 'password' | 'key' | 'agent';
  privateKeyPath?: string;
  passphrase?: string;
  agent?: boolean | string;
  remotePath: string;
  localPath?: string;
  ignore?: string[];
}

export interface FerryConfig {
  defaultServer?: string;
  uploadOnSave?: boolean;
  servers: ServerConfig[];
}

const FORMAT: jsonc.FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

/** Loads and edits `.vscode/ferry.json` of the first workspace folder. */
export class ConfigManager implements vscode.Disposable {
  private config: FerryConfig = { servers: [] };
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const folder = this.workspaceFolder;
    if (folder) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.vscode/ferry.json'),
      );
      const reload = () => this.reload();
      watcher.onDidChange(reload);
      watcher.onDidCreate(reload);
      watcher.onDidDelete(reload);
      this.disposables.push(watcher);
    }
    this.reload();
  }

  get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  get configPath(): string | undefined {
    const folder = this.workspaceFolder;
    return folder && path.join(folder.uri.fsPath, '.vscode', 'ferry.json');
  }

  get servers(): ServerConfig[] {
    return this.config.servers;
  }

  get uploadOnSave(): boolean {
    return !!this.config.uploadOnSave;
  }

  /** The default server, falling back to the only/first server. */
  get activeServer(): ServerConfig | undefined {
    const { servers, defaultServer } = this.config;
    return servers.find((s) => s.name === defaultServer) ?? servers[0];
  }

  getServer(name: string): ServerConfig | undefined {
    return this.config.servers.find((s) => s.name === name);
  }

  reload(): void {
    const file = this.configPath;
    let next: FerryConfig = { servers: [] };
    if (file && fs.existsSync(file)) {
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
      if (errors.length === 0 && parsed && typeof parsed === 'object') {
        next = { ...parsed, servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
      } else {
        // Keep the previous config while the user is mid-edit.
        return;
      }
    }
    this.config = next;
    this.emitter.fire();
  }

  /** Absolute local directory mapped to the server's remotePath. */
  localRoot(server: ServerConfig): string {
    const base = this.workspaceFolder?.uri.fsPath ?? '';
    return path.resolve(base, server.localPath ?? '');
  }

  /** Relative POSIX path of a local file inside the mapping, or undefined if outside. */
  toRel(server: ServerConfig, localAbs: string): string | undefined {
    const rel = path.relative(this.localRoot(server), localAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(path.sep).join('/');
  }

  /** Relative POSIX path of a remote path inside the mapping, or undefined if outside. */
  remoteToRel(server: ServerConfig, remoteAbs: string): string | undefined {
    const rel = path.posix.relative(server.remotePath, remoteAbs);
    return rel.startsWith('..') || path.posix.isAbsolute(rel) ? undefined : rel;
  }

  toLocal(server: ServerConfig, rel: string): string {
    return path.join(this.localRoot(server), ...rel.split('/').filter(Boolean));
  }

  toRemote(server: ServerConfig, rel: string): string {
    return path.posix.join(server.remotePath, rel);
  }

  async setDefaultServer(name: string): Promise<void> {
    await this.edit(['defaultServer'], name);
  }

  async setUploadOnSave(value: boolean): Promise<void> {
    await this.edit(['uploadOnSave'], value);
  }

  async addServer(server: ServerConfig): Promise<void> {
    await this.edit(['servers', this.config.servers.length], server);
    if (this.config.servers.length === 1) {
      await this.setDefaultServer(server.name);
    }
  }

  /** Replaces the given fields of a server; `undefined` removes a field. Other fields (e.g. `ignore`) are kept. */
  async updateServer(oldName: string, fields: Partial<ServerConfig>): Promise<void> {
    const index = this.config.servers.findIndex((s) => s.name === oldName);
    if (index < 0) {
      throw new Error(`Unknown server "${oldName}"`);
    }
    const changes: [jsonc.JSONPath, unknown][] = Object.entries(fields).map(([key, value]) => [['servers', index, key], value]);
    if (this.config.defaultServer === oldName && fields.name && fields.name !== oldName) {
      changes.push([['defaultServer'], fields.name]);
    }
    await this.editMany(changes);
  }

  async renameServer(oldName: string, newName: string): Promise<void> {
    const index = this.config.servers.findIndex((s) => s.name === oldName);
    if (index < 0) {
      throw new Error(`Unknown server "${oldName}"`);
    }
    const wasDefault = this.config.defaultServer === oldName;
    await this.edit(['servers', index, 'name'], newName);
    if (wasDefault) {
      await this.setDefaultServer(newName);
    }
  }

  async ensureFile(): Promise<string> {
    const file = this.configPath;
    if (!file) {
      throw new Error('Open a folder first.');
    }
    if (!fs.existsSync(file)) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const skeleton: FerryConfig = { defaultServer: '', uploadOnSave: false, servers: [] };
      await fs.promises.writeFile(file, JSON.stringify(skeleton, null, 2) + '\n');
    }
    return file;
  }

  /** Edits a single value while preserving comments and formatting. */
  private async edit(jsonPath: jsonc.JSONPath, value: unknown): Promise<void> {
    await this.editMany([[jsonPath, value]]);
  }

  /** Applies several edits in one write, so watchers never see a half-updated file. */
  private async editMany(changes: [jsonc.JSONPath, unknown][]): Promise<void> {
    const file = await this.ensureFile();
    let text = await fs.promises.readFile(file, 'utf8');
    for (const [jsonPath, value] of changes) {
      text = jsonc.applyEdits(text, jsonc.modify(text, jsonPath, value, { formattingOptions: FORMAT }));
    }
    await fs.promises.writeFile(file, text);
    this.reload();
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
