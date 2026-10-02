import * as vscode from 'vscode';
import * as path from 'path';
import { EntryStatus, FileInfo, SyncAction, SyncEntry } from './sync';

export interface GroupNode {
  kind: 'group';
  status: EntryStatus;
}

export type SyncNode = GroupNode | SyncEntry;

export function isGroup(node: SyncNode | undefined): node is GroupNode {
  return (node as GroupNode | undefined)?.kind === 'group';
}

const GROUPS: { status: EntryStatus; label: string; icon: string; color?: string }[] = [
  { status: 'conflict', label: 'Conflicts', icon: 'warning', color: 'list.warningForeground' },
  { status: 'modified', label: 'Modified', icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' },
  { status: 'localOnly', label: 'Only Local', icon: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
  { status: 'remoteOnly', label: 'Only Remote', icon: 'cloud', color: 'gitDecoration.untrackedResourceForeground' },
];

const ACTION_UI: Record<SyncAction, { label: string; icon: string; color?: string }> = {
  upload: { label: '→ upload', icon: 'arrow-up', color: 'charts.blue' },
  download: { label: '← download', icon: 'arrow-down', color: 'charts.green' },
  deleteRemote: { label: '✕ delete remote', icon: 'trash', color: 'errorForeground' },
  deleteLocal: { label: '✕ delete local', icon: 'trash', color: 'errorForeground' },
  skip: { label: 'skip', icon: 'circle-slash', color: 'disabledForeground' },
};

function formatSize(n?: number): string {
  if (n === undefined) {
    return '—';
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms?: number): string {
  return ms === undefined ? '—' : new Date(ms).toLocaleString();
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(s / 86400)} d`;
}

/** What the chosen action does, shown at the bottom of the tooltip. */
function actionText(e: SyncEntry): string {
  switch (e.action) {
    case 'upload': return `$(cloud-upload) **Upload** — local → remote, ${e.remote ? 'replaces the remote file' : 'creates it on the server'}`;
    case 'download': return `$(cloud-download) **Download** — remote → local, ${e.local ? 'replaces the local file' : 'creates it locally'}`;
    case 'deleteRemote': return '$(trash) **Delete on remote** — the local side is not touched';
    case 'deleteLocal': return '$(trash) **Delete locally** — the remote side is not touched';
    case 'skip': return '$(circle-slash) **Skip** — nothing is transferred';
  }
}

/** Role of one side in the chosen action, e.g. "copied from" or "will be overwritten". */
function role(side: 'local' | 'remote', action: SyncAction, present: boolean): string {
  const source = side === 'local' ? 'upload' : 'download';
  const target = side === 'local' ? 'download' : 'upload';
  const deleted = side === 'local' ? 'deleteLocal' : 'deleteRemote';
  if (action === source) return ' — *source*';
  if (action === target) return present ? ' — *will be overwritten*' : ' — *will be created*';
  if (action === deleted) return ' — *will be deleted*';
  return '';
}

/** One block of the tooltip: heading with icon, then size and time (with which side is newer). */
function sideBlock(icon: string, title: string, info: FileInfo | undefined, other: FileInfo | undefined, roleText: string): string {
  const head = `$(${icon}) **${title}**${roleText}`;
  if (!info) {
    return `${head}  \n*not present*`;
  }
  const marks: string[] = [];
  if (other) {
    const dt = info.mtime - other.mtime;
    if (dt >= 2000) marks.push(`**newer** by ${formatAge(dt)}`);
    const ds = info.size - other.size;
    if (ds !== 0) marks.push(`${ds > 0 ? '+' : '−'}${formatSize(Math.abs(ds))}`);
  }
  return `${head}  \n${formatSize(info.size)} · ${formatTime(info.mtime)}${marks.length ? `  \n${marks.join(' · ')}` : ''}`;
}

/** The "Sync Changes" tree: differences grouped by status, each with a chosen action. */
export class SyncTreeProvider implements vscode.TreeDataProvider<SyncNode> {
  private readonly emitter = new vscode.EventEmitter<SyncNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  serverName = '';
  scope = '';
  entries: SyncEntry[] = [];

  setResult(serverName: string, scope: string, entries: SyncEntry[]): void {
    this.serverName = serverName;
    this.scope = scope;
    this.entries = entries;
    this.refresh();
  }

  clear(): void {
    this.setResult('', '', []);
  }

  remove(done: SyncEntry[]): void {
    const set = new Set(done);
    this.entries = this.entries.filter((e) => !set.has(e));
    this.refresh();
  }

  refresh(): void {
    void vscode.commands.executeCommand('setContext', 'ferry.hasEntries', this.entries.length > 0);
    this.emitter.fire();
  }

  entriesOf(node: SyncNode): SyncEntry[] {
    return isGroup(node) ? this.entries.filter((e) => e.status === node.status) : [node];
  }

  /** Sets `action` on entries where it makes sense (e.g. no "download" for local-only files). */
  setAction(entries: SyncEntry[], action: SyncAction): void {
    for (const e of entries) {
      if (action === 'upload' && !e.local) continue;
      if (action === 'download' && !e.remote) continue;
      if (action === 'deleteRemote' && (!e.remote || e.local)) continue;
      if (action === 'deleteLocal' && (!e.local || e.remote)) continue;
      e.action = action;
    }
    this.refresh();
  }

  getChildren(node?: SyncNode): SyncNode[] {
    if (!node) {
      return GROUPS.filter((g) => this.entries.some((e) => e.status === g.status)).map((g) => ({ kind: 'group', status: g.status }));
    }
    return isGroup(node) ? this.entries.filter((e) => e.status === node.status) : [];
  }

  getParent(node: SyncNode): SyncNode | undefined {
    return isGroup(node) ? undefined : { kind: 'group', status: node.status };
  }

  getTreeItem(node: SyncNode): vscode.TreeItem {
    if (isGroup(node)) {
      const g = GROUPS.find((x) => x.status === node.status)!;
      const items = this.entries.filter((e) => e.status === node.status);
      const active = items.filter((e) => e.action !== 'skip').length;
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.status}`;
      item.description = `${items.length} file${items.length === 1 ? '' : 's'}, ${active} to sync`;
      item.iconPath = new vscode.ThemeIcon(g.icon, g.color ? new vscode.ThemeColor(g.color) : undefined);
      item.contextValue = `group-${node.status}`;
      return item;
    }

    const ui = ACTION_UI[node.action];
    const dir = path.posix.dirname(node.rel);
    const item = new vscode.TreeItem(path.posix.basename(node.rel), vscode.TreeItemCollapsibleState.None);
    item.id = `entry:${node.rel}`;
    item.description = `${dir === '.' ? '' : dir + '  '}${ui.label}${node.action !== node.suggested ? ' *' : ''}`;
    item.iconPath = new vscode.ThemeIcon(ui.icon, ui.color ? new vscode.ThemeColor(ui.color) : undefined);
    item.contextValue = `entry-${node.status}`;
    item.resourceUri = vscode.Uri.parse(`ferry-entry:/${node.rel}`);
    const tip = new vscode.MarkdownString(undefined, true);
    const remoteTitle = this.serverName ? `Remote · ${escape(this.serverName)}` : 'Remote';
    tip.appendMarkdown(`**${escape(node.rel)}** — ${escape(node.note)}\n\n---\n\n`);
    tip.appendMarkdown(`${sideBlock('device-desktop', 'Local', node.local, node.remote, role('local', node.action, !!node.local))}\n\n`);
    tip.appendMarkdown(`${sideBlock('cloud', remoteTitle, node.remote, node.local, role('remote', node.action, !!node.remote))}\n\n---\n\n`);
    tip.appendMarkdown(actionText(node));
    if (node.action !== node.suggested) {
      tip.appendMarkdown(`  \n*(suggested: ${ACTION_UI[node.suggested].label})*`);
    }
    item.tooltip = tip;
    item.command = { command: 'ferry.showDiff', title: 'Show Diff', arguments: [node] };
    return item;
  }
}

/** Escapes Markdown (and theme-icon) syntax in file names. */
function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>$~]/g, '\\$&');
}
