import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager, ServerConfig } from './config';
import { ConnectionManager, expandHome, tildify } from './connection';
import { IgnoreManager } from './ignore';
import { initLog, log } from './log';
import { REMOTE_SCHEME, RemoteContentProvider } from './remoteContent';
import { RemoteFileSystem, SFTP_SCHEME } from './remoteFs';
import { ProjectFolderDecorator, RemoteNode, RemoteTreeProvider } from './remoteView';
import { SyncAction, SyncEngine, SyncEntry } from './sync';
import { ProfileStore } from './profiles';
import { ServerForm } from './serverForm';
import { SyncNode, SyncTreeProvider, isGroup } from './syncView';
import { sshTerminalOptions } from './terminal';

export function activate(context: vscode.ExtensionContext): void {
  const output = initLog();
  const config = new ConfigManager();
  const profiles = new ProfileStore(context.globalState);
  const conns = new ConnectionManager(context.secrets, profiles);
  const ignores = new IgnoreManager(config);
  const remoteContent = new RemoteContentProvider(config, conns);
  const remoteFs = new RemoteFileSystem(config, conns);
  const engine = new SyncEngine(config, conns, ignores, remoteContent, context.workspaceState);
  const syncTree = new SyncTreeProvider();
  const remoteTree = new RemoteTreeProvider(config, conns, ignores);

  remoteFs.onDidWrite = (server, abs, added) => {
    remoteContent.invalidate(server.name, abs);
    if (added) remoteTree.refresh();
  };

  const syncView = vscode.window.createTreeView('ferry.sync', { treeDataProvider: syncTree, showCollapseAll: true });
  const remoteView = vscode.window.createTreeView('ferry.remote', { treeDataProvider: remoteTree, showCollapseAll: true, canSelectMany: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'ferry.menu';

  context.subscriptions.push(
    output, config, conns, ignores, syncView, remoteView, status,
    vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteContent),
    vscode.workspace.registerFileSystemProvider(SFTP_SCHEME, remoteFs, { isCaseSensitive: true }),
    vscode.window.registerFileDecorationProvider(new ProjectFolderDecorator(config)),
  );

  // ------------------------------------------------------------------ helpers

  /** Remembers this project's servers on this machine so other projects can reuse them. */
  const importProfiles = () =>
    profiles.importMissing(config.servers, async (s) => {
      const found = await conns.resolveKeyPath(s, false);
      return found && tildify(expandHome(found));
    }).catch((err) => log(`Saving servers on this computer failed: ${err}`));

  const updateUi = () => {
    const server = config.activeServer;
    void vscode.commands.executeCommand('setContext', 'ferry.hasServer', !!server);
    if (server) {
      status.text = `$(server) ${server.name}${config.uploadOnSave ? ' $(cloud-upload)' : ''}`;
      status.tooltip = new vscode.MarkdownString(
        `**Ferry** — ${server.username}@${server.host}:${server.remotePath}\n\n` +
        `Upload on save: **${config.uploadOnSave ? 'on' : 'off'}**\n\nClick for actions`,
      );
      status.show();
      updateRemoteDescription();
    } else {
      status.hide();
      remoteView.description = undefined;
    }
  };

  const requireServer = async (): Promise<ServerConfig | undefined> => {
    const server = config.activeServer;
    if (server) {
      return server;
    }
    const pick = await vscode.window.showWarningMessage('Ferry: no SFTP server configured.', 'Add Server');
    if (pick) {
      await vscode.commands.executeCommand('ferry.addServer');
    }
    return config.activeServer;
  };

  const errorMessage = (err: unknown) => String((err as Error)?.message ?? err);

  const reportError = (what: string, err: unknown) => {
    if (errorMessage(err) === 'Cancelled') {
      return;
    }
    log(`${what}: ${errorMessage(err)}`);
    void vscode.window.showErrorMessage(`Ferry: ${what} — ${errorMessage(err)}`, 'Show Log').then((p) => p && output.show());
  };

  /** URIs targeted by a command: explorer multi-selection, a single URI, or the active editor. */
  const targetUris = (uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] => {
    if (uris?.length) {
      return uris;
    }
    if (uri instanceof vscode.Uri) {
      return [uri];
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return active ? [active] : [];
  };

  const relOf = (server: ServerConfig, uri: vscode.Uri): string | undefined => {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const rel = config.toRel(server, uri.fsPath);
    if (rel === undefined) {
      void vscode.window.showWarningMessage(`Ferry: ${uri.fsPath} is outside the local mapping of "${server.name}".`);
    }
    return rel;
  };

  const showDiff = async (server: ServerConfig, rel: string, hasLocal: boolean, hasRemote: boolean) => {
    const name = path.posix.basename(rel);
    const localUri = vscode.Uri.file(config.toLocal(server, rel));
    const remoteUri = RemoteContentProvider.uri(server.name, config.toRemote(server, rel));

    // Large or binary files would be loaded fully into memory and shown as garbage text.
    const localSize = hasLocal ? (await fs.promises.stat(localUri.fsPath)).size : 0;
    const remoteSize = hasRemote ? (await conns.withClient(server, (c) => c.stat(remoteUri.path))).size : 0;
    const limit = vscode.workspace.getConfiguration('ferry').get<number>('maxContentCompareSize', 10 * 1024 * 1024);
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    const sizes = [hasLocal && `local ${mb(localSize)}`, hasRemote && `remote ${mb(remoteSize)}`].filter(Boolean).join(', ');
    if (Math.max(localSize, remoteSize) > limit) {
      void vscode.window.showInformationMessage(`Ferry: ${rel} is too large to show a diff (${sizes}).`);
      return;
    }
    if (hasLocal && localSize > 0) {
      const fh = await fs.promises.open(localUri.fsPath, 'r');
      const head = Buffer.alloc(Math.min(localSize, 8000));
      await fh.read(head, 0, head.length, 0).finally(() => fh.close());
      if (head.includes(0)) {
        void vscode.window.showInformationMessage(`Ferry: ${rel} is a binary file (${sizes}); no text diff available.`);
        return;
      }
    }

    if (hasLocal && hasRemote) {
      await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri, `${name} (${server.name} ↔ Local)`, { preview: true });
    } else if (hasLocal) {
      await vscode.window.showTextDocument(localUri, { preview: true });
    } else {
      await vscode.window.showTextDocument(remoteUri, { preview: true });
    }
  };

  const runApply = async (server: ServerConfig, entries: SyncEntry[], title: string) => {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const result = await engine.apply(server, entries, progress, token);
        if (result.failed.length) {
          const first = result.failed[0];
          void vscode.window.showErrorMessage(
            `Ferry: ${result.failed.length} operation(s) failed, e.g. ${first.entry.rel}: ${first.error}`,
            'Show Log',
          ).then((p) => p && output.show());
        }
        return result;
      },
    );
  };

  let lastIdentical = 0;

  /** Keeps the message above the Sync Changes tree in line with what Apply Sync will do. */
  const updateSyncMessage = () => {
    if (!syncTree.serverName) {
      syncView.message = undefined;
      return;
    }
    if (!syncTree.entries.length) {
      syncView.message = `Everything is in sync (${lastIdentical} identical file(s)).`;
      return;
    }
    const count = (a: SyncAction) => syncTree.entries.filter((e) => e.action === a).length;
    const parts = [
      count('upload') && `upload ${count('upload')}`,
      count('download') && `download ${count('download')}`,
      count('deleteRemote') + count('deleteLocal') && `delete ${count('deleteRemote') + count('deleteLocal')}`,
    ].filter(Boolean);
    syncView.message = parts.length
      ? `Ready to ${parts.join(', ')} file(s). Nothing is transferred until you press ✓✓ Apply Sync (or ▶ Sync Now on a file).`
      : `All ${syncTree.entries.length} difference(s) are set to skip. Choose ↑ upload or ↓ download per file.`;
  };
  context.subscriptions.push(syncTree.onDidChangeTreeData(updateSyncMessage));

  const runCompare = async (server: ServerConfig, scope: string) => {
    await vscode.commands.executeCommand('ferry.sync.focus');
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Ferry: comparing with ${server.name}`, cancellable: true },
        (progress, token) => engine.compare(server, scope, progress, token),
      );
      lastIdentical = result.identical;
      syncTree.setResult(server.name, scope, result.entries);
      syncView.description = `${server.name} · /${scope}`;
      const ignored = result.ignoredDiffs ? ` (${result.ignoredDiffs} differ only in line endings/whitespace)` : '';
      log(`Compared /${scope} with ${server.name}: ${result.entries.length} difference(s), ${result.identical} identical${ignored}`);
    } catch (err) {
      reportError('compare failed', err);
    }
  };

  const syncTargets = (node?: SyncNode, nodes?: SyncNode[]): SyncEntry[] => {
    const selected = nodes?.length ? nodes : node ? [node] : [...syncView.selection];
    return selected.flatMap((n) => syncTree.entriesOf(n));
  };

  const setAction = (action: SyncAction) => (node?: SyncNode, nodes?: SyncNode[]) =>
    syncTree.setAction(syncTargets(node, nodes), action);

  /** Drops entries from the sync view that became ignored. */
  const pruneIgnored = () => {
    const server = config.getServer(syncTree.serverName);
    if (!server) {
      return;
    }
    const matcher = ignores.matcher(server);
    const isIgnored = (rel: string) => {
      const parts = rel.split('/');
      return parts.some((_, i) => matcher.isIgnored(parts.slice(0, i + 1).join('/'), i < parts.length - 1));
    };
    syncTree.remove(syncTree.entries.filter((e) => isIgnored(e.rel)));
  };

  const updateDiffContext = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const open = input instanceof vscode.TabInputTextDiff && input.original.scheme === REMOTE_SCHEME;
    void vscode.commands.executeCommand('setContext', 'ferry.diffOpen', open);
  };

  // ------------------------------------------------------------------ upload on save

  const saveQueue = new Map<string, Promise<void>>();

  const uploadOnSave = async (doc: vscode.TextDocument) => {
    const server = config.activeServer;
    if (!config.uploadOnSave || !server || doc.uri.scheme !== 'file') {
      return;
    }
    const rel = config.toRel(server, doc.uri.fsPath);
    if (!rel) {
      return;
    }
    const matcher = ignores.matcher(server);
    const parts = rel.split('/');
    if (parts.some((_, i) => matcher.isIgnored(parts.slice(0, i + 1).join('/'), i < parts.length - 1))) {
      return;
    }
    try {
      if (vscode.workspace.getConfiguration('ferry').get('uploadOnSaveCheckRemote', true)
        && !(await engine.remoteUnchangedSinceSync(server, rel))) {
        const pick = await vscode.window.showWarningMessage(
          `Ferry: ${rel} was changed on ${server.name} since the last sync. Overwrite it?`,
          'Overwrite', 'Show Diff',
        );
        if (pick === 'Show Diff') {
          await showDiff(server, rel, true, true);
        }
        if (pick !== 'Overwrite') {
          return;
        }
      }
      const entry: SyncEntry = { rel, status: 'modified', action: 'upload', suggested: 'upload', note: '' };
      const big = doc.getText().length > 5 * 1024 * 1024;
      const result = await vscode.window.withProgress(
        {
          location: big ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: `Ferry: uploading ${rel}`,
          cancellable: big,
        },
        (progress, token) => engine.apply(server, [entry], progress, token),
      );
      if (result.failed.length) {
        throw new Error(result.failed[0].error);
      }
      vscode.window.setStatusBarMessage(`$(check) Uploaded ${rel} to ${server.name}`, 3000);
      syncTree.remove(syncTree.entries.filter((e) => e.rel === rel && syncTree.serverName === server.name));
    } catch (err) {
      reportError(`upload of ${rel} failed`, err);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const key = doc.uri.toString();
      const next = (saveQueue.get(key) ?? Promise.resolve()).then(() => uploadOnSave(doc));
      saveQueue.set(key, next);
      void next.finally(() => saveQueue.get(key) === next && saveQueue.delete(key));
    }),
    config.onDidChange(() => {
      void importProfiles();
      updateUi();
      remoteTree.refresh();
    }),
    vscode.window.tabGroups.onDidChangeTabs(updateDiffContext),
    vscode.window.tabGroups.onDidChangeTabGroups(updateDiffContext),
  );

  // ------------------------------------------------------------------ commands

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('ferry.menu', async () => {
    const server = config.activeServer;
    const items: (vscode.QuickPickItem & { cmd: string })[] = [
      { label: '$(refresh) Compare with Server', cmd: 'ferry.compare' },
      { label: '$(server) Select Default Server', description: server?.name, cmd: 'ferry.selectServer' },
      { label: '$(edit) Edit Server…', cmd: 'ferry.editServer' },
      { label: '$(add) Add SFTP Server…', cmd: 'ferry.addServer' },
      { label: `$(cloud-upload) Upload on Save: ${config.uploadOnSave ? 'On' : 'Off'}`, description: 'toggle', cmd: 'ferry.toggleUploadOnSave' },
      { label: '$(eye-closed) Manage Ignore Patterns', cmd: 'ferry.manageIgnore' },
      { label: '$(terminal) Open SSH Terminal', description: 'in the project folder', cmd: 'ferry.openTerminal' },
      { label: '$(plug) Test Connection', cmd: 'ferry.testConnection' },
      { label: '$(gear) Open Configuration', cmd: 'ferry.editConfig' },
      { label: '$(output) Show Log', cmd: 'ferry.showLog' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Ferry' });
    if (pick) {
      await vscode.commands.executeCommand(pick.cmd);
    }
  });

  register('ferry.showLog', () => output.show());

  register('ferry.selectServer', async () => {
    const items: (vscode.QuickPickItem & { name?: string })[] = config.servers.map((s) => ({
      label: `${s.name === config.activeServer?.name ? '$(check) ' : ''}${s.name}`,
      description: `${s.username}@${s.host}:${s.remotePath}`,
      name: s.name,
    }));
    items.push({ label: '$(add) Add SFTP Server…' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Ferry: default server' });
    if (!pick) {
      return;
    }
    if (!pick.name) {
      await vscode.commands.executeCommand('ferry.addServer');
      return;
    }
    await config.setDefaultServer(pick.name);
    syncTree.clear();
    syncView.description = undefined;
  });

  const serverFormHooks = {
    saved: async (server: ServerConfig, oldName: string | undefined) => {
      if (oldName && oldName !== server.name) {
        await engine.renameState(oldName, server.name);
      }
      if (oldName && syncTree.serverName === oldName) {
        // Mapping or host may have changed, so the old comparison is stale.
        syncTree.clear();
        syncView.description = undefined;
      }
      remoteTree.refresh();
    },
  };

  register('ferry.addServer', () => {
    if (!config.workspaceFolder) {
      void vscode.window.showErrorMessage('Ferry: open a folder first.');
      return;
    }
    ServerForm.show(config, conns, profiles, serverFormHooks);
  });

  register('ferry.editServer', async () => {
    let server = config.activeServer;
    if (config.servers.length > 1) {
      const pick = await vscode.window.showQuickPick(
        config.servers.map((s) => ({ label: s.name, description: `${s.username}@${s.host}`, server: s })),
        { title: 'Ferry: edit which server?' },
      );
      server = pick?.server;
    }
    if (server) {
      ServerForm.show(config, conns, profiles, serverFormHooks, server);
    }
  });

  register('ferry.renameServer', async () => {
    let server = config.activeServer;
    if (config.servers.length > 1) {
      const pick = await vscode.window.showQuickPick(
        config.servers.map((s) => ({ label: s.name, description: `${s.username}@${s.host}`, server: s })),
        { title: 'Ferry: rename which server?' },
      );
      server = pick?.server;
    }
    if (!server) return;
    const oldName = server.name;
    const newName = (await vscode.window.showInputBox({
      title: 'Ferry: rename server',
      prompt: `New display name for ${server.username}@${server.host}`,
      value: oldName,
      validateInput: (v) => (!v.trim() ? 'Required' : v.trim() !== oldName && config.getServer(v.trim()) ? 'A server with that name exists' : undefined),
    }))?.trim();
    if (!newName || newName === oldName) return;
    try {
      await conns.close(oldName);
      await engine.renameState(oldName, newName);
      await config.renameServer(oldName, newName);
      if (syncTree.serverName === oldName) {
        syncTree.serverName = newName;
        syncView.description = `${newName} · /${syncTree.scope}`;
      }
      vscode.window.setStatusBarMessage(`Ferry: renamed "${oldName}" to "${newName}"`, 4000);
    } catch (err) {
      reportError('rename failed', err);
    }
  });

  register('ferry.editConfig', async () => {
    try {
      const file = await config.ensureFile();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } catch (err) {
      reportError('cannot open configuration', err);
    }
  });

  register('ferry.testConnection', async (name?: string) => {
    const server = typeof name === 'string' ? config.getServer(name) : await requireServer();
    if (!server) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Ferry: connecting to ${server.name}…` },
        async () => {
          await conns.close(server.name);
          const kind = await conns.withClient(server, (c) => c.exists(server.remotePath));
          if (kind === 'd') {
            void vscode.window.showInformationMessage(`Ferry: connected to ${server.name}; ${server.remotePath} exists.`);
          } else {
            const pick = await vscode.window.showWarningMessage(
              `Ferry: connected, but ${server.remotePath} does not exist on ${server.name}.`, 'Create It');
            if (pick) {
              await conns.withClient(server, (c) => c.mkdir(server.remotePath, true));
            }
          }
        },
      );
      remoteTree.refresh();
    } catch (err) {
      reportError(`connection to ${server.name} failed`, err);
    }
  });

  register('ferry.forgetPassword', async () => {
    const server = await requireServer();
    if (server) {
      await conns.forgetCredentials(server);
      void vscode.window.showInformationMessage(`Ferry: forgot stored credentials for ${server.name}.`);
    }
  });

  register('ferry.toggleUploadOnSave', async () => {
    if (!(await requireServer())) return;
    await config.setUploadOnSave(!config.uploadOnSave);
    vscode.window.setStatusBarMessage(`Ferry: upload on save ${config.uploadOnSave ? 'enabled' : 'disabled'}`, 3000);
  });

  // --- compare / sync view

  register('ferry.compare', async (uri?: vscode.Uri) => {
    const server = await requireServer();
    if (!server) return;
    let scope = '';
    if (uri instanceof vscode.Uri) {
      const rel = relOf(server, uri);
      if (rel === undefined) return;
      scope = rel;
    }
    await runCompare(server, scope);
  });

  register('ferry.showDiff', async (node?: SyncNode) => {
    const entry = node ?? syncView.selection[0];
    if (!entry || isGroup(entry)) return;
    const server = config.getServer(syncTree.serverName);
    if (!server) return;
    try {
      await showDiff(server, entry.rel, !!entry.local, !!entry.remote);
    } catch (err) {
      reportError(`cannot show ${entry.rel}`, err);
    }
  });

  register('ferry.setUpload', setAction('upload'));
  register('ferry.setDownload', setAction('download'));
  register('ferry.setSkip', setAction('skip'));
  register('ferry.setDeleteRemote', setAction('deleteRemote'));
  register('ferry.setDeleteLocal', setAction('deleteLocal'));
  register('ferry.setAllUpload', () => syncTree.setAction(syncTree.entries, 'upload'));
  register('ferry.setAllDownload', () => syncTree.setAction(syncTree.entries, 'download'));
  register('ferry.setAllSkip', () => syncTree.setAction(syncTree.entries, 'skip'));
  register('ferry.resetActions', () => {
    syncTree.entries.forEach((e) => (e.action = e.suggested));
    syncTree.refresh();
  });
  register('ferry.clearSync', () => {
    syncTree.clear();
    syncView.description = undefined;
  });

  register('ferry.syncNow', async (node?: SyncNode, nodes?: SyncNode[]) => {
    const server = config.getServer(syncTree.serverName);
    if (!server) return;
    const entries = syncTargets(node, nodes).filter((e) => e.action !== 'skip');
    if (!entries.length) {
      void vscode.window.showInformationMessage('Ferry: this file is set to skip. Choose ↑ upload or ↓ download first.');
      return;
    }
    if (entries.some((e) => e.action === 'deleteLocal' || e.action === 'deleteRemote')) {
      const ok = await vscode.window.showWarningMessage(`Ferry: this includes deletions. Continue?`, { modal: true }, 'Continue');
      if (!ok) return;
    }
    try {
      const result = await runApply(server, entries, `Ferry: syncing ${entries.length} file(s)`);
      syncTree.remove(result.done);
    } catch (err) {
      reportError('sync failed', err);
    }
  });

  register('ferry.applySync', async () => {
    const server = config.getServer(syncTree.serverName);
    if (!server) return;
    const todo = syncTree.entries.filter((e) => e.action !== 'skip');
    if (!todo.length) {
      void vscode.window.showInformationMessage('Ferry: nothing to do — every file is set to skip.');
      return;
    }
    const count = (a: SyncAction) => todo.filter((e) => e.action === a).length;
    const deletes = count('deleteLocal') + count('deleteRemote');
    const summary = [
      count('upload') && `${count('upload')} upload(s)`,
      count('download') && `${count('download')} download(s)`,
      count('deleteRemote') && `${count('deleteRemote')} remote deletion(s)`,
      count('deleteLocal') && `${count('deleteLocal')} local deletion(s) (to trash)`,
    ].filter(Boolean).join(', ');
    if (deletes) {
      const ok = await vscode.window.showWarningMessage(`Ferry: apply ${summary} on ${server.name}?`, { modal: true }, 'Apply');
      if (!ok) return;
    }
    try {
      const result = await runApply(server, todo, `Ferry: ${summary}`);
      syncTree.remove(result.done);
      if (!result.failed.length) {
        vscode.window.setStatusBarMessage(`$(check) Ferry: ${summary}`, 4000);
      }
    } catch (err) {
      reportError('sync failed', err);
    }
  });

  // --- explorer / editor file actions

  const transfer = async (action: 'upload' | 'download', uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const server = await requireServer();
    if (!server) return;
    const targets = targetUris(uri, uris);
    try {
      const entries: SyncEntry[] = [];
      for (const target of targets) {
        const rel = relOf(server, target);
        if (rel === undefined) continue;
        const isLocalFile = fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isFile();
        const isSingleFile = action === 'upload'
          ? isLocalFile
          : (await conns.withClient(server, (c) => c.exists(config.toRemote(server, rel)))) === '-';
        if (isSingleFile) {
          // Explicitly chosen files are transferred even when ignored.
          entries.push({ rel, status: 'modified', action, suggested: action, note: '' });
        } else {
          entries.push(...(await engine.entriesFor(server, rel, action)));
        }
      }
      if (!entries.length) {
        void vscode.window.showInformationMessage('Ferry: nothing to transfer.');
        return;
      }
      if (action === 'download' && entries.length > 1) {
        const ok = await vscode.window.showWarningMessage(
          `Ferry: download ${entries.length} files from ${server.name}, overwriting local copies?`, { modal: true }, 'Download');
        if (!ok) return;
      }
      const verb = action === 'upload' ? 'Uploading' : 'Downloading';
      const result = await runApply(server, entries, `Ferry: ${verb} ${entries.length} file(s)`);
      if (result.done.length) {
        vscode.window.setStatusBarMessage(`$(check) ${verb.replace('ing', 'ed')} ${result.done.length} file(s)`, 4000);
      }
      const doneRels = new Set(result.done.map((e) => e.rel));
      syncTree.remove(syncTree.entries.filter((e) => doneRels.has(e.rel) && syncTree.serverName === server.name));
    } catch (err) {
      reportError(`${action} failed`, err);
    }
  };

  register('ferry.uploadFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => transfer('upload', uri, uris));
  register('ferry.downloadFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => transfer('download', uri, uris));

  register('ferry.compareFile', async (uri?: vscode.Uri) => {
    const server = await requireServer();
    if (!server) return;
    const [target] = targetUris(uri);
    if (!target) return;
    const rel = relOf(server, target);
    if (rel === undefined) return;
    try {
      const remoteKind = await conns.withClient(server, (c) => c.exists(config.toRemote(server, rel)));
      if (!remoteKind) {
        void vscode.window.showInformationMessage(`Ferry: ${rel} does not exist on ${server.name}.`);
        return;
      }
      remoteContent.invalidate(server.name, config.toRemote(server, rel));
      await showDiff(server, rel, fs.existsSync(target.fsPath), true);
    } catch (err) {
      reportError(`cannot compare ${rel}`, err);
    }
  });

  // --- ignore management

  register('ferry.exclude', async (arg?: vscode.Uri | SyncNode, args?: (vscode.Uri | SyncNode)[]) => {
    const server = arg instanceof vscode.Uri || !arg ? await requireServer() : config.getServer(syncTree.serverName);
    if (!server) return;
    const items = args?.length ? args : arg ? [arg] : [];
    const patterns: string[] = [];
    for (const item of items) {
      if (item instanceof vscode.Uri) {
        const rel = relOf(server, item);
        if (!rel) continue;
        const isDir = fs.existsSync(item.fsPath) && fs.statSync(item.fsPath).isDirectory();
        patterns.push(`/${rel}${isDir ? '/' : ''}`);
      } else if (!isGroup(item)) {
        patterns.push(`/${item.rel}`);
      }
    }
    if (!patterns.length) return;
    await ignores.addPatterns(server, patterns);
    pruneIgnored();
    vscode.window.setStatusBarMessage(`Ferry: excluded ${patterns.join(', ')}`, 4000);
  });

  register('ferry.editIgnore', async () => {
    const server = await requireServer();
    if (!server) return;
    const file = ignores.ignoreFilePath(server);
    if (!fs.existsSync(file)) {
      await fs.promises.writeFile(file, '# Ferry ignore patterns (gitignore syntax), relative to the mapped folder\n');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  });

  register('ferry.manageIgnore', async () => {
    const server = await requireServer();
    if (!server) return;
    const settings = vscode.workspace.getConfiguration('ferry');
    const gitignore = settings.get<boolean>('respectGitignore', false);
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file-add) Choose files/folders to exclude…', id: 'pick' },
        { label: '$(add) Add pattern…', description: 'gitignore syntax, e.g. *.log or /data/', id: 'add' },
        { label: '$(remove) Remove patterns…', description: `${ignores.filePatterns(server).length} in .ferryignore`, id: 'remove' },
        { label: '$(edit) Edit .ferryignore', id: 'edit' },
        { label: `$(git-branch) Respect .gitignore: ${gitignore ? 'On' : 'Off'}`, description: 'toggle', id: 'git' },
        { label: '$(settings) Default patterns for all servers', description: 'ferry.defaultIgnore setting', id: 'defaults' },
        { label: '$(json) Server-specific patterns', description: `"ignore" of ${server.name} in ferry.json`, id: 'server' },
      ],
      { title: `Ferry: ignore patterns (${server.name})` },
    );
    switch (choice?.id) {
      case 'pick': {
        const uris = await vscode.window.showOpenDialog({
          title: 'Exclude from sync',
          defaultUri: vscode.Uri.file(config.localRoot(server)),
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Exclude',
        });
        if (uris?.length) {
          await vscode.commands.executeCommand('ferry.exclude', uris[0], uris);
        }
        break;
      }
      case 'add': {
        const pattern = await vscode.window.showInputBox({ title: 'Add ignore pattern', prompt: 'gitignore syntax, e.g. *.log, /build/, data/*.csv' });
        if (pattern?.trim()) {
          await ignores.addPatterns(server, [pattern.trim()]);
          pruneIgnored();
        }
        break;
      }
      case 'remove': {
        const current = ignores.filePatterns(server);
        if (!current.length) {
          void vscode.window.showInformationMessage('Ferry: .ferryignore has no patterns.');
          break;
        }
        const picks = await vscode.window.showQuickPick(current, { canPickMany: true, title: 'Select patterns to remove' });
        if (picks?.length) {
          await ignores.removePatterns(server, picks);
        }
        break;
      }
      case 'edit':
        await vscode.commands.executeCommand('ferry.editIgnore');
        break;
      case 'git':
        await settings.update('respectGitignore', !gitignore, vscode.ConfigurationTarget.Workspace);
        pruneIgnored();
        break;
      case 'defaults':
        await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'ferry.defaultIgnore');
        break;
      case 'server':
        await vscode.commands.executeCommand('ferry.editConfig');
        break;
    }
  });

  // --- remote host view

  const updateRemoteDescription = () => {
    const server = config.activeServer;
    remoteView.description = server ? `${server.name}:${remoteTree.root(server)}` : undefined;
    void vscode.commands.executeCommand('setContext', 'ferry.remoteOutsideProject', !!server && !remoteTree.isAtProjectRoot(server));
  };

  const browseTo = (server: ServerConfig, abs: string | undefined) => {
    remoteTree.setRoot(server, abs);
    updateRemoteDescription();
  };

  register('ferry.remote.refresh', () => remoteTree.refresh());

  register('ferry.remote.goUp', () => {
    const server = config.activeServer;
    if (!server) return;
    browseTo(server, path.posix.dirname(remoteTree.root(server)));
  });

  register('ferry.remote.goProject', () => {
    const server = config.activeServer;
    if (server) browseTo(server, undefined);
  });

  register('ferry.remote.goHome', async () => {
    const server = config.activeServer;
    if (!server) return;
    try {
      browseTo(server, await conns.withClient(server, (c) => c.realPath('.')));
    } catch (err) {
      reportError('cannot resolve the home directory', err);
    }
  });

  register('ferry.remote.goTo', async () => {
    const server = config.activeServer;
    if (!server) return;
    const input = (await vscode.window.showInputBox({
      title: `Ferry: browse ${server.name}`,
      prompt: 'Absolute path, or ~ for your home directory (e.g. /scratch, ~/data)',
      value: remoteTree.root(server),
      validateInput: (v) => (v.trim().startsWith('/') || v.trim().startsWith('~') ? undefined : 'Use an absolute path or ~'),
    }))?.trim();
    if (!input) return;
    try {
      const target = await conns.withClient(server, async (c) => {
        const abs = input.startsWith('~')
          ? path.posix.join(await c.realPath('.'), input.slice(1))
          : input;
        const kind = await c.exists(abs);
        if (kind !== 'd') {
          throw new Error(kind ? `${abs} is not a directory` : `${abs} does not exist`);
        }
        return abs;
      });
      browseTo(server, target);
    } catch (err) {
      reportError('cannot browse there', err);
    }
  });

  register('ferry.remote.browseHere', (node?: RemoteNode) => {
    const target = node ?? remoteView.selection[0];
    const server = target && config.getServer(target.server);
    if (server && target.isDir) browseTo(server, target.abs);
  });

  register('ferry.remote.open', async (node: RemoteNode) => {
    const server = config.getServer(node.server);
    if (!server) return;
    try {
      // Opened through the SFTP file system, so the file can be edited and saved back to the server.
      await vscode.commands.executeCommand('vscode.open', RemoteFileSystem.uri(server.name, node.abs), { preview: true });
    } catch (err) {
      reportError(`cannot open ${node.abs}`, err);
    }
  });

  register('ferry.remote.download', async (node: RemoteNode) => {
    const server = config.getServer(node.server);
    if (!server || node.rel === undefined) return;
    await transfer('download', vscode.Uri.file(config.toLocal(server, node.rel)));
  });

  register('ferry.remote.saveAs', async (node: RemoteNode) => {
    const server = config.getServer(node.server);
    if (!server || node.isDir) return;
    const dest = await vscode.window.showSaveDialog({
      title: `Download ${node.abs}`,
      defaultUri: vscode.Uri.file(path.join(config.workspaceFolder?.uri.fsPath ?? os.homedir(), path.posix.basename(node.abs))),
    });
    if (!dest) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Ferry: downloading ${path.posix.basename(node.abs)}` },
        () => conns.withClient(server, (c) => c.fastGet(node.abs, dest.fsPath)),
      );
      log(`downloaded ${node.abs} -> ${dest.fsPath}`);
      const pick = await vscode.window.showInformationMessage(`Ferry: saved to ${dest.fsPath}`, 'Open');
      if (pick) await vscode.window.showTextDocument(dest);
    } catch (err) {
      reportError(`cannot download ${node.abs}`, err);
    }
  });

  register('ferry.remote.compare', async (node: RemoteNode) => {
    const server = config.getServer(node.server);
    if (!server || node.rel === undefined) return;
    if (node.isDir) {
      await runCompare(server, node.rel);
    } else {
      const local = config.toLocal(server, node.rel);
      remoteContent.invalidate(server.name, node.abs);
      await showDiff(server, node.rel, fs.existsSync(local), true);
    }
  });

  // --- remote host: file management

  /** Nodes a remote command applies to: the multi-selection, the clicked node, or the focused one. */
  const remoteTargets = (node?: RemoteNode, nodes?: RemoteNode[]): RemoteNode[] =>
    (nodes?.length ? nodes : node ? [node] : [...remoteView.selection]).filter((n) => !n.up);

  /** Server and absolute directory for "new"/"upload here": a folder, a file's folder, or the browse root. */
  const remoteDirOf = (node?: RemoteNode): { server?: ServerConfig; dir: string } => {
    const target = node ?? remoteView.selection[0];
    if (!target || target.up) {
      const server = config.activeServer;
      return { server, dir: server ? remoteTree.root(server) : '/' };
    }
    return { server: config.getServer(target.server), dir: target.isDir ? target.abs : path.posix.dirname(target.abs) };
  };

  const validName = (v: string) =>
    !v.trim() ? 'Required' : /[/\\]/.test(v) ? 'A name cannot contain slashes' : undefined;

  register('ferry.remote.rename', async (node?: RemoteNode) => {
    const target = remoteTargets(node)[0];
    const server = target && config.getServer(target.server);
    if (!target || !server) return;
    const oldName = path.posix.basename(target.abs);
    const dot = oldName.lastIndexOf('.');
    const newName = (await vscode.window.showInputBox({
      title: 'Ferry: rename on server',
      prompt: target.abs,
      value: oldName,
      valueSelection: [0, !target.isDir && dot > 0 ? dot : oldName.length],
      validateInput: validName,
    }))?.trim();
    if (!newName || newName === oldName) return;
    const from = target.abs;
    const to = path.posix.join(path.posix.dirname(from), newName);
    try {
      await conns.withClient(server, async (c) => {
        if (await c.exists(to)) {
          throw new Error(`${newName} already exists`);
        }
        await c.rename(from, to);
      });
      if (target.rel !== undefined) await engine.forget(server, target.rel);
      remoteContent.invalidate(server.name, from);
      log(`renamed ${from} -> ${to}`);
      remoteTree.refresh();
    } catch (err) {
      reportError(`cannot rename ${oldName}`, err);
    }
  });

  register('ferry.remote.delete', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
    const targets = remoteTargets(node, nodes);
    const server = targets[0] && config.getServer(targets[0].server);
    if (!server) return;
    const label = targets.length === 1
      ? `"${targets[0].abs}"${targets[0].isDir ? ' and everything in it' : ''}`
      : `${targets.length} items`;
    const ok = await vscode.window.showWarningMessage(
      `Delete ${label} on ${server.name}?`,
      { modal: true, detail: 'This permanently deletes the remote files. Local files are not touched.' },
      'Delete',
    );
    if (!ok) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Ferry: deleting ${label}` }, () =>
        conns.withClient(server, async (c) => {
          for (const t of targets) {
            if (t.isDir) {
              await c.rmdir(t.abs, true);
            } else {
              await c.delete(t.abs);
            }
            if (t.rel !== undefined) await engine.forget(server, t.rel);
            remoteContent.invalidate(server.name, t.abs);
            log(`deleted remote ${t.abs}`);
          }
        }),
      );
    } catch (err) {
      reportError('delete failed', err);
    }
    remoteTree.refresh();
  });

  const createRemote = async (node: RemoteNode | undefined, kind: 'file' | 'folder') => {
    const { server, dir } = remoteDirOf(node);
    if (!server) return;
    const name = (await vscode.window.showInputBox({
      title: `Ferry: new ${kind} on ${server.name}`,
      prompt: `In ${dir}`,
      validateInput: validName,
    }))?.trim();
    if (!name) return;
    const abs = path.posix.join(dir, name);
    try {
      await conns.withClient(server, async (c) => {
        if (await c.exists(abs)) {
          throw new Error(`${name} already exists`);
        }
        if (kind === 'folder') {
          await c.mkdir(abs, true);
        } else {
          await c.put(Buffer.alloc(0), abs);
        }
      });
      log(`created remote ${kind} ${abs}`);
      remoteTree.refresh();
      if (kind === 'file') {
        await vscode.commands.executeCommand('vscode.open', RemoteFileSystem.uri(server.name, abs));
      }
    } catch (err) {
      reportError(`cannot create ${name}`, err);
    }
  };
  register('ferry.remote.newFolder', (node?: RemoteNode) => createRemote(node, 'folder'));
  register('ferry.remote.newFile', (node?: RemoteNode) => createRemote(node, 'file'));

  register('ferry.remote.uploadHere', async (node?: RemoteNode) => {
    const { server, dir } = remoteDirOf(node);
    if (!server) return;
    const files = await vscode.window.showOpenDialog({
      title: `Upload to ${dir}`,
      canSelectMany: true,
      openLabel: 'Upload',
      defaultUri: config.workspaceFolder?.uri,
    });
    if (!files?.length) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Ferry: uploading ${files.length} file(s)`, cancellable: true },
        (progress, token) =>
          conns.withClient(server, async (c) => {
            if (!(await c.exists(dir))) await c.mkdir(dir, true);
            // Files are placed by name into this folder, wherever they live locally.
            for (let i = 0; i < files.length && !token.isCancellationRequested; i++) {
              const name = path.basename(files[i].fsPath);
              progress.report({ message: `${name} (${i + 1}/${files.length})`, increment: 100 / files.length });
              await c.put(fs.createReadStream(files[i].fsPath), path.posix.join(dir, name));
              log(`uploaded ${files[i].fsPath} -> ${path.posix.join(dir, name)}`);
            }
          }),
      );
    } catch (err) {
      reportError('upload failed', err);
    }
    remoteTree.refresh();
  });

  /** SSH terminal in a Remote Host folder (or a file's folder), or in the project folder when invoked without one. */
  register('ferry.openTerminal', async (node?: RemoteNode) => {
    const { server, dir } = node ? remoteDirOf(node) : { server: await requireServer(), dir: undefined };
    if (!server) return;
    try {
      const terminal = vscode.window.createTerminal(await sshTerminalOptions(server, conns, dir));
      terminal.show();
    } catch (err) {
      reportError('cannot open a terminal', err);
    }
  });

  context.subscriptions.push(vscode.window.registerTerminalProfileProvider('ferry.ssh', {
    provideTerminalProfile: async () => {
      const server = config.activeServer;
      if (!server) {
        throw new Error('Ferry: no SFTP server configured.');
      }
      return new vscode.TerminalProfile(await sshTerminalOptions(server, conns));
    },
  }));

  register('ferry.remote.copyPath', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
    const paths = remoteTargets(node, nodes).map((t) => t.abs);
    if (paths.length) {
      await vscode.env.clipboard.writeText(paths.join('\n'));
      vscode.window.setStatusBarMessage(`Copied ${paths.length === 1 ? paths[0] : `${paths.length} paths`}`, 3000);
    }
  });

  register('ferry.remote.revealLocal', async (node?: RemoteNode) => {
    const target = remoteTargets(node)[0];
    const server = target && config.getServer(target.server);
    if (!target || !server || target.rel === undefined) return;
    const local = config.toLocal(server, target.rel);
    if (!fs.existsSync(local)) {
      void vscode.window.showInformationMessage(`Ferry: ${target.rel} does not exist locally.`);
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(local));
  });

  void importProfiles();
  updateUi();
  updateDiffContext();
  log('Ferry activated');
}

export function deactivate(): void {
  // Connections are closed by ConnectionManager.dispose().
}
