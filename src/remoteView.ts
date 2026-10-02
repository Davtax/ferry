import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager, ServerConfig } from './config';
import { ConnectionManager } from './connection';
import { IgnoreManager } from './ignore';

export interface RemoteNode {
  server: string;
  /** Absolute remote path. */
  abs: string;
  /** POSIX path relative to the server's remotePath, or undefined outside the project mapping. */
  rel?: string;
  isDir: boolean;
  size: number;
  ignored: boolean;
  /** The ".." row that navigates to the parent of the current root. */
  up?: boolean;
}

export const REMOTE_TREE_SCHEME = 'ferry-remote-tree';
const PROJECT_COLOR = 'charts.blue';

function isAncestor(dir: string, of: string): boolean {
  return dir === '/' ? of !== '/' : of.startsWith(dir + '/');
}

/** Colors the project folder's label (and marks it with a badge) in the Remote Host tree. */
export class ProjectFolderDecorator implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly config: ConfigManager) {
    config.onDidChange(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const server = this.config.activeServer;
    if (uri.scheme !== REMOTE_TREE_SCHEME || !server || uri.path !== server.remotePath) {
      return undefined;
    }
    return new vscode.FileDecoration('P', 'Project folder', new vscode.ThemeColor(PROJECT_COLOR));
  }
}

/**
 * "Remote Host" tree: lazily browses the default server. It starts at the project's
 * remotePath, but the root can be moved anywhere (parent, home, any absolute path).
 */
export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Current browse root per server; absent means the project's remotePath. */
  private readonly roots = new Map<string, string>();

  constructor(
    private readonly config: ConfigManager,
    private readonly conns: ConnectionManager,
    private readonly ignores: IgnoreManager,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  root(server: ServerConfig): string {
    return this.roots.get(server.name) ?? server.remotePath;
  }

  setRoot(server: ServerConfig, abs: string | undefined): void {
    const normalized = abs && path.posix.normalize(abs).replace(/(.)\/+$/, '$1');
    if (!normalized || normalized === server.remotePath) {
      this.roots.delete(server.name);
    } else {
      this.roots.set(server.name, normalized);
    }
    this.refresh();
  }

  isAtProjectRoot(server: ServerConfig): boolean {
    return this.root(server) === server.remotePath;
  }

  node(server: ServerConfig, abs: string, isDir: boolean, size = 0): RemoteNode {
    const rel = this.config.remoteToRel(server, abs);
    const ignored = rel ? this.ignores.matcher(server).isIgnored(rel, isDir) : false;
    return { server: server.name, abs, rel, isDir, size, ignored };
  }

  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    const server = node ? this.config.getServer(node.server) : this.config.activeServer;
    if (!server) {
      return [];
    }
    const dir = node?.abs ?? this.root(server);
    try {
      const items = await this.conns.withClient(server, (c) => c.list(dir));
      const children = items
        .filter((it) => it.name !== '.' && it.name !== '..')
        .map((it) => this.node(server, path.posix.join(dir, it.name), it.type === 'd', it.size))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.abs.localeCompare(b.abs));
      if (!node && dir !== '/') {
        children.unshift({ ...this.node(server, path.posix.dirname(dir), true), up: true });
      }
      return children;
    } catch (err) {
      void vscode.window.showErrorMessage(`Ferry: cannot list ${server.name}:${dir} — ${(err as Error).message}`);
      return node || dir === '/' ? [] : [{ ...this.node(server, path.posix.dirname(dir), true), up: true }];
    }
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    if (node.up) {
      const item = new vscode.TreeItem('..', vscode.TreeItemCollapsibleState.None);
      item.id = `${node.server}:up`;
      item.iconPath = new vscode.ThemeIcon('arrow-up');
      item.description = node.abs;
      item.tooltip = `Go up to ${node.abs}`;
      item.contextValue = 'remoteUp';
      item.command = { command: 'ferry.remote.goUp', title: 'Go Up' };
      return item;
    }
    const item = new vscode.TreeItem(
      path.posix.basename(node.abs) || '/',
      node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${node.server}:${node.abs}`;
    item.resourceUri = vscode.Uri.from({ scheme: REMOTE_TREE_SCHEME, path: node.abs });
    item.iconPath = node.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    // ".ext" marks nodes outside the project mapping: no local counterpart to compare or download into.
    item.contextValue = (node.isDir ? 'remoteDir' : 'remoteFile') + (node.rel === undefined ? '.ext' : '');
    item.tooltip = node.abs;
    const server = this.config.getServer(node.server);
    if (server && node.isDir && node.rel === '') {
      item.iconPath = new vscode.ThemeIcon('root-folder', new vscode.ThemeColor(PROJECT_COLOR));
      item.description = 'project';
      item.tooltip = `${node.abs}\nProject folder (mapped to the local workspace)`;
    } else if (server && node.isDir && isAncestor(node.abs, server.remotePath)) {
      item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor(PROJECT_COLOR));
      item.tooltip = `${node.abs}\nContains the project folder`;
    }
    if (node.ignored) {
      item.description = 'ignored';
    }
    if (!node.isDir) {
      item.command = { command: 'ferry.remote.open', title: 'Open', arguments: [node] };
    }
    return item;
  }
}
