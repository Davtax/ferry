import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager, ServerConfig } from './config';
import SftpClient from 'ssh2-sftp-client';
import { ConnectionManager, tildify } from './connection';
import { ProfileStore, authOf, identity } from './profiles';
import { log } from './log';

type AuthKind = 'password' | 'key' | 'agent';

/** Values edited in the form; secrets are only sent back from the webview, never to it. */
interface FormData {
  name: string;
  host: string;
  port: string;
  username: string;
  auth: AuthKind;
  password: string;
  savePassword: boolean;
  privateKeyPath: string;
  passphrase: string;
  agentSocket: string;
  remotePath: string;
  localPath: string;
  makeDefault: boolean;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'browseKey' }
  | { type: 'browseLocal' }
  | { type: 'test'; data: FormData }
  | { type: 'detectHome'; data: FormData }
  | { type: 'browse'; data: FormData; path?: string }
  | { type: 'browseMkdir'; data: FormData; path: string; name: string }
  | { type: 'browseClose' }
  | { type: 'pickProfile'; id: string }
  | { type: 'forgetProfile'; id: string }
  | { type: 'save'; data: FormData }
  | { type: 'cancel' };

export interface ServerFormHooks {
  /** Called after the config was written; `oldName` is set when an existing server was edited. */
  saved(server: ServerConfig, oldName: string | undefined): Promise<void>;
}

/** PyCharm-style "SSH / SFTP server" dialog as a webview panel, used to add or edit a server. */
export class ServerForm {
  private static readonly open = new Map<string, ServerForm>();

  static show(
    config: ConfigManager, conns: ConnectionManager, profiles: ProfileStore, hooks: ServerFormHooks, existing?: ServerConfig,
  ): void {
    const key = existing ? `edit:${existing.name}` : 'add';
    const current = ServerForm.open.get(key);
    if (current) {
      current.panel.reveal();
      return;
    }
    ServerForm.open.set(key, new ServerForm(key, config, conns, profiles, hooks, existing));
  }

  private readonly panel: vscode.WebviewPanel;
  /** Connection kept open while the remote folder browser is shown, keyed by the login it was made with. */
  private browser?: { login: string; client: Promise<SftpClient> };

  private constructor(
    private readonly key: string,
    private readonly config: ConfigManager,
    private readonly conns: ConnectionManager,
    private readonly profiles: ProfileStore,
    private readonly hooks: ServerFormHooks,
    private readonly existing?: ServerConfig,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'ferry.serverForm',
      existing ? `Ferry: ${existing.name}` : 'Ferry: Add SFTP Server',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] },
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      ServerForm.open.delete(this.key);
      void this.closeBrowser();
    });
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => {
      this.handle(m).catch((err) => this.post({ type: 'status', kind: 'error', text: errorText(err) }));
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.sendInitial();
      case 'browseKey': {
        const sshDir = vscode.Uri.file(path.join(os.homedir(), '.ssh'));
        const files = await vscode.window.showOpenDialog({ defaultUri: sshDir, title: 'Select private key', canSelectMany: false });
        if (files?.length) {
          this.post({ type: 'set', field: 'privateKeyPath', value: tildify(files[0].fsPath) });
        }
        return;
      }
      case 'browseLocal': {
        const root = this.config.workspaceFolder?.uri;
        const dirs = await vscode.window.showOpenDialog({
          defaultUri: root, title: 'Select local directory', canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        });
        if (dirs?.length && root) {
          const rel = path.relative(root.fsPath, dirs[0].fsPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            this.post({ type: 'status', kind: 'error', text: 'The local directory must be inside the workspace folder.' });
          } else {
            this.post({ type: 'set', field: 'localPath', value: rel.split(path.sep).join('/') });
          }
        }
        return;
      }
      case 'test':
        return this.test(m.data);
      case 'detectHome':
        return this.detectHome(m.data);
      case 'browse':
        return this.browse(m.data, m.path);
      case 'browseMkdir':
        return this.browseMkdir(m.data, m.path, m.name);
      case 'browseClose':
        return this.closeBrowser();
      case 'pickProfile':
        return this.pickProfile(m.id);
      case 'forgetProfile':
        await this.profiles.remove(parseIdentity(m.id));
        this.post({ type: 'profiles', profiles: this.profileList() });
        this.post({ type: 'status', kind: 'ok', text: `Removed ${m.id} from the saved servers on this computer.` });
        return;
      case 'save':
        return this.save(m.data);
      case 'cancel':
        this.panel.dispose();
        return;
    }
  }

  private async sendInitial(): Promise<void> {
    const s = this.existing;
    const folder = this.config.workspaceFolder?.name ?? 'project';
    const data: FormData = {
      name: s?.name ?? '',
      host: s?.host ?? '',
      port: String(s?.port ?? 22),
      username: s?.username ?? '',
      auth: s ? authOf(s) : 'password',
      password: '',
      savePassword: true,
      privateKeyPath: (s && authOf(s) === 'key' && (await this.conns.resolveKeyPath(s, false))) || '',
      passphrase: '',
      agentSocket: typeof s?.agent === 'string' ? s.agent : '',
      remotePath: s?.remotePath ?? '',
      localPath: s?.localPath ?? '',
      makeDefault: s ? this.config.activeServer?.name === s.name : this.config.servers.length === 0,
    };
    const stored = s ? await this.conns.hasStoredCredentials(s) : { password: false, passphrase: false };
    this.post({
      type: 'init',
      data,
      editing: !!s,
      stored: { password: stored.password || !!s?.password, passphrase: stored.passphrase || !!s?.passphrase },
      remoteHint: `/home/<user>/${folder}`,
      profiles: s ? [] : this.profileList(),
    });
  }

  /** Saved servers offered in the "Saved server" picker (no secrets). */
  private profileList(): { id: string; label: string }[] {
    return this.profiles.all().map((p) => ({ id: identity(p), label: `${p.name} — ${identity(p)}` }));
  }

  /** Fills the form from a saved server. */
  private async pickProfile(id: string): Promise<void> {
    const p = this.profiles.get(parseIdentity(id));
    if (!p) return;
    const taken = (n: string) => !!this.config.getServer(n);
    let name = p.name;
    for (let i = 2; taken(name); i++) name = `${p.name} (${i})`;
    const stored = await this.conns.hasStoredCredentials({ ...p, name, remotePath: p.remotePath ?? '/' });
    this.post({
      type: 'applyProfile',
      data: {
        name, host: p.host, port: String(p.port), username: p.username, auth: p.auth,
        privateKeyPath: p.privateKeyPath ?? '', agentSocket: typeof p.agent === 'string' ? p.agent : '', remotePath: p.remotePath ?? '',
      },
      stored,
    });
  }

  /** Returns field errors; an empty object means the form is valid. */
  private validate(d: FormData): Record<string, string> {
    const errors: Record<string, string> = {};
    const name = d.name.trim();
    if (!name) errors.name = 'Required';
    else if (name !== this.existing?.name && this.config.getServer(name)) errors.name = 'A server with this name already exists';
    if (!d.host.trim()) errors.host = 'Required';
    if (!/^\d+$/.test(d.port) || Number(d.port) < 1 || Number(d.port) > 65535) errors.port = 'Port must be 1–65535';
    if (!d.username.trim()) errors.username = 'Required';
    if (d.auth === 'key' && !d.privateKeyPath.trim()) errors.privateKeyPath = 'Select a private key file';
    if (!d.remotePath.trim().startsWith('/')) errors.remotePath = 'Must be an absolute path, e.g. /home/user/project';
    if (d.localPath.trim() && (path.isAbsolute(d.localPath) || d.localPath.split(/[\\/]/).includes('..'))) {
      errors.localPath = 'Must be relative to the workspace folder';
    }
    return errors;
  }

  private toServer(d: FormData): ServerConfig {
    const server: ServerConfig = {
      name: d.name.trim(),
      host: d.host.trim(),
      port: Number(d.port),
      username: d.username.trim(),
      remotePath: d.remotePath.trim().replace(/\/+$/, '') || '/',
    };
    if (d.auth === 'key') server.privateKeyPath = d.privateKeyPath.trim();
    server.auth = d.auth;
    if (d.auth === 'agent') server.agent = d.agentSocket.trim() || true;
    if (d.localPath.trim()) server.localPath = d.localPath.trim().replace(/[\\/]+$/, '');
    return server;
  }

  /** Server for a one-off connection from the form, or undefined (after reporting errors) if fields are invalid. */
  private connectable(d: FormData, needsRemotePath: boolean): ServerConfig | undefined {
    const errors = this.validate(d);
    delete errors.name; // the name does not matter for connecting
    delete errors.localPath;
    if (!needsRemotePath) delete errors.remotePath;
    if (Object.keys(errors).length) {
      this.post({ type: 'errors', errors });
      return undefined;
    }
    const server = this.toServer(d);
    // Typed secrets win; otherwise those stored for the server being edited are used.
    if (d.auth === 'password' && d.password) server.password = d.password;
    if (d.auth === 'key' && d.passphrase) server.passphrase = d.passphrase;
    if (this.existing) {
      if (d.auth === 'password' && !server.password) server.password = this.existing.password;
      if (d.auth === 'key' && !server.passphrase) server.passphrase = this.existing.passphrase;
    }
    return server;
  }

  /** Fills the deployment path with the home directory reported by the server. */
  private async detectHome(d: FormData): Promise<void> {
    const server = this.connectable(d, false);
    if (!server) return;
    this.post({ type: 'status', kind: 'busy', text: `Detecting home directory on ${server.host}…` });
    try {
      const home = (await this.conns.homeDir(server, this.existing)).replace(/\/+$/, '') || '/';
      this.post({ type: 'set', field: 'remotePath', value: home });
      this.post({ type: 'status', kind: 'ok', text: `Home directory is ${home}.` });
    } catch (err) {
      log(`Detect home failed: ${errorText(err)}`);
      this.post({ type: 'status', kind: 'error', text: `Connection failed: ${errorText(err)}` });
    }
  }

  /** Connection for the folder browser, reopened when the login fields changed. */
  private browserClient(server: ServerConfig): Promise<SftpClient> {
    const login = JSON.stringify([server.host, server.port, server.username, server.password, server.privateKeyPath,
      server.passphrase, server.agent]);
    if (this.browser?.login !== login) {
      void this.closeBrowser();
      const client = this.conns.connectOnce(server, this.existing);
      client.catch(() => {
        if (this.browser?.client === client) this.browser = undefined;
      });
      this.browser = { login, client };
    }
    return this.browser.client;
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.client.then((c) => c.end()).catch(() => undefined);
  }

  /** Shows the folders of `dir` (default: the deployment path, else the home directory) in the browser. */
  private async browse(d: FormData, dir?: string): Promise<void> {
    const server = this.connectable(d, false);
    if (!server) return;
    this.post({ type: 'browseBusy', text: `Connecting to ${server.host}…` });
    try {
      const client = await this.browserClient(server);
      const home = await client.realPath('.');
      let target = dir?.trim() || d.remotePath.trim() || home;
      if (target === '~' || target.startsWith('~/')) {
        target = path.posix.join(home, target.slice(1));
      }
      let note: string | undefined;
      if (!target.startsWith('/') || (await client.exists(target)) !== 'd') {
        note = `${target} does not exist; showing your home directory.`;
        target = home;
      }
      const current = await client.realPath(target);
      const dirs = (await client.list(current))
        .filter((e) => e.type === 'd')
        .map((e) => e.name)
        .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b));
      this.post({ type: 'browseShow', path: current, home, dirs, note });
    } catch (err) {
      log(`Browse failed: ${errorText(err)}`);
      void this.closeBrowser();
      this.post({ type: 'browseError', text: `Connection failed: ${errorText(err)}` });
    }
  }

  private async browseMkdir(d: FormData, dir: string, name: string): Promise<void> {
    const server = this.connectable(d, false);
    if (!server) return;
    name = name.trim();
    if (!name || name === '.' || name === '..' || name.includes('/')) {
      this.post({ type: 'browseError', text: 'Enter a folder name without "/".' });
      return;
    }
    try {
      const client = await this.browserClient(server);
      const created = path.posix.join(dir, name);
      if (await client.exists(created)) {
        this.post({ type: 'browseError', text: `${created} already exists.` });
        return;
      }
      await client.mkdir(created, false);
      log(`Created ${created} on ${server.host}`);
      await this.browse(d, created);
    } catch (err) {
      this.post({ type: 'browseError', text: `Cannot create folder: ${errorText(err)}` });
    }
  }

  private async test(d: FormData): Promise<void> {
    const server = this.connectable(d, false);
    if (!server) return;
    const target = `${server.username}@${server.host}:${server.port}`;
    this.post({ type: 'status', kind: 'busy', text: `Connecting to ${target}…` });
    try {
      await this.conns.test(server, this.existing);
      this.post({ type: 'status', kind: 'ok', text: `Connection to ${target} successful.` });
    } catch (err) {
      log(`Test connection failed: ${errorText(err)}`);
      this.post({ type: 'status', kind: 'error', text: `Connection failed: ${errorText(err)}` });
    }
  }

  private async save(d: FormData): Promise<void> {
    const errors = this.validate(d);
    if (Object.keys(errors).length) {
      this.post({ type: 'errors', errors });
      return;
    }
    const server = this.toServer(d);
    const old = this.existing;
    if (old) {
      await this.conns.close(old.name);
      await this.conns.moveCredentials(old, server);
      await this.config.updateServer(old.name, {
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        auth: server.auth,
        privateKeyPath: undefined,
        agent: server.agent,
        remotePath: server.remotePath,
        localPath: server.localPath,
        // A newly typed secret moves out of ferry.json into secret storage; switching auth drops stale ones.
        password: d.auth === 'password' && !d.password ? old.password : undefined,
        passphrase: d.auth === 'key' && !d.passphrase ? old.passphrase : undefined,
      });
    } else {
      await this.config.addServer({ ...server, privateKeyPath: undefined, ignore: [] });
    }
    await this.profiles.save({
      name: server.name, host: server.host, port: server.port ?? 22, username: server.username, auth: d.auth,
      privateKeyPath: server.privateKeyPath, agent: server.agent, remotePath: server.remotePath,
    });
    if (d.auth === 'password' && d.password && d.savePassword) {
      await this.conns.storeCredentials(server, { password: d.password });
    }
    if (d.auth === 'key' && d.passphrase && d.savePassword) {
      await this.conns.storeCredentials(server, { passphrase: d.passphrase });
    }
    if (d.makeDefault && this.config.activeServer?.name !== server.name) {
      await this.config.setDefaultServer(server.name);
    }
    this.post({ type: 'status', kind: 'busy', text: 'Saving…' });
    await this.createRemoteRoot(d, server);
    await this.hooks.saved(server, old?.name);
    vscode.window.setStatusBarMessage(`Ferry: ${old ? 'updated' : 'added'} "${server.name}"`, 4000);
    this.panel.dispose();
  }

  /** Silently creates the deployment folder if it is missing; failures (e.g. no saved password) are only logged. */
  private async createRemoteRoot(d: FormData, server: ServerConfig): Promise<void> {
    const withSecrets: ServerConfig = { ...server };
    if (d.auth === 'password' && d.password) withSecrets.password = d.password;
    if (d.auth === 'key' && d.passphrase) withSecrets.passphrase = d.passphrase;
    try {
      if (await this.conns.ensureRemoteRoot(withSecrets)) {
        log(`Created ${server.remotePath} on ${server.name}`);
      }
    } catch (err) {
      log(`Could not check/create ${server.remotePath} on ${server.name}: ${errorText(err)}`);
    }
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 24px; max-width: 680px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
  fieldset { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 10px 14px 4px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-weight: 600; }
  .row { display: grid; grid-template-columns: 150px 1fr; align-items: start; gap: 8px; margin-bottom: 10px; }
  .row > label { padding-top: 5px; }
  .ctl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .inline { display: flex; gap: 6px; align-items: center; }
  .inline input[type=text], .inline input[type=password] { flex: 1; min-width: 0; }
  .port { width: 80px; flex: none !important; }
  input[type=text], input[type=password] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 4px 6px; font: inherit; outline: none;
  }
  input:focus, select:focus { border-color: var(--vscode-focusBorder); }
  select {
    flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; padding: 4px 6px; font: inherit; outline: none;
  }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .err { color: var(--vscode-errorForeground); font-size: 0.9em; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .radios { display: flex; gap: 16px; padding-top: 5px; flex-wrap: wrap; }
  .radios label, .check { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
  button {
    font: inherit; padding: 4px 12px; border-radius: 2px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
  .spacer { flex: 1; }
  #status { margin: 0 0 16px; padding: 6px 10px; border-radius: 3px; display: none; align-items: center; gap: 10px; }
  #status.show { display: flex; }
  #status.ok {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 18%, transparent);
    border: 1px solid var(--vscode-testing-iconPassed, #73c991);
  }
  #status.warn, #status.busy { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  #status.error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  #statusText { flex: 1; overflow-wrap: anywhere; }
  .hidden { display: none !important; }
  #browser { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-start; justify-content: center; padding-top: 6vh; z-index: 10; }
  .dlg {
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.4)); border-radius: 6px; padding: 14px 16px; width: min(600px, 92vw);
    display: flex; flex-direction: column; gap: 8px;
  }
  .dlg-title { font-weight: 600; font-size: 1.1em; }
  #bList {
    list-style: none; margin: 0; padding: 2px 0; height: 300px; overflow-y: auto;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); background: var(--vscode-input-background);
  }
  #bList li { padding: 3px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bList li:hover { background: var(--vscode-list-hoverBackground); }
  #bList li.dot { color: var(--vscode-descriptionForeground); }
  #bList li.empty { cursor: default; color: var(--vscode-descriptionForeground); font-style: italic; }
  #bList li.empty:hover { background: none; }
  #bList.loading { opacity: 0.5; }
  .dlg .actions { margin-top: 0; }
</style>
</head>
<body>
<h1 id="title">Add SFTP Server</h1>
<div class="sub">Settings are saved to <code>.vscode/ferry.json</code>; passwords go to VS Code's secret storage.</div>

<form id="form" autocomplete="off">
<fieldset id="savedBox" class="hidden">
  <legend>Saved servers</legend>
  <div class="row"><label for="saved">Load from</label>
    <div class="ctl"><div class="inline"><select id="saved"></select><button type="button" id="forgetSaved" title="Remove from this computer's saved servers">Forget</button></div>
      <span class="hint">Servers saved on this computer (in VS Code, not in the project). Loads host, user, key and deployment path.</span></div></div>
</fieldset>

<fieldset>
  <legend>Connection</legend>
  <div class="row"><label for="host">Host</label>
    <div class="ctl"><div class="inline"><input type="text" id="host" placeholder="example.com or 192.168.0.10">
      <label for="port">Port</label><input type="text" id="port" class="port"></div>
      <span class="err" data-for="host"></span><span class="err" data-for="port"></span></div></div>
  <div class="row"><label for="username">User name</label>
    <div class="ctl"><input type="text" id="username"><span class="err" data-for="username"></span></div></div>
  <div class="row"><label>Authentication</label>
    <div class="ctl"><div class="radios">
      <label><input type="radio" name="auth" value="password"> Password</label>
      <label><input type="radio" name="auth" value="key"> Key pair</label>
      <label><input type="radio" name="auth" value="agent"> OpenSSH agent</label>
    </div></div></div>

  <div class="row auth-password"><label for="password">Password</label>
    <div class="ctl"><input type="password" id="password">
      <label class="check"><input type="checkbox" id="savePassword"> Save password</label>
      <span class="hint" id="passwordHint"></span></div></div>

  <div class="row auth-key"><label for="privateKeyPath">Private key file</label>
    <div class="ctl"><div class="inline"><input type="text" id="privateKeyPath" placeholder="~/.ssh/id_ed25519"><button type="button" id="browseKey">Browse…</button></div>
      <span class="hint">Remembered on this computer only, so every machine can use its own path.</span>
      <span class="err" data-for="privateKeyPath"></span></div></div>
  <div class="row auth-key"><label for="passphrase">Passphrase</label>
    <div class="ctl"><input type="password" id="passphrase" placeholder="leave empty if the key has none">
      <label class="check"><input type="checkbox" id="savePassphrase"> Save passphrase</label>
      <span class="hint" id="passphraseHint"></span></div></div>

  <div class="row auth-agent"><label for="agentSocket">Agent socket</label>
    <div class="ctl"><input type="text" id="agentSocket" placeholder="default (SSH_AUTH_SOCK / Windows OpenSSH agent)">
      <span class="hint">Optional. A socket path, a named pipe, or <code>pageant</code>.</span></div></div>
</fieldset>

<fieldset>
  <legend>Mappings</legend>
  <div class="row"><label for="localPath">Local path</label>
    <div class="ctl"><div class="inline"><input type="text" id="localPath" placeholder="(whole workspace)"><button type="button" id="browseLocal">Browse…</button></div>
      <span class="hint">Relative to the workspace folder.</span><span class="err" data-for="localPath"></span></div></div>
  <div class="row"><label for="remotePath">Deployment path</label>
    <div class="ctl"><div class="inline"><input type="text" id="remotePath"><button type="button" id="detectHome" title="Connect and use your home directory on the server">Detect</button><button type="button" id="browseRemote" title="Pick a folder on the server">Browse…</button></div>
      <span class="hint">Absolute directory on the server. <b>Detect</b> fills in your home directory (it is not always under /home); <b>Browse…</b> lets you pick or create a folder.</span><span class="err" data-for="remotePath"></span></div></div>
</fieldset>

<fieldset>
  <legend>General</legend>
  <div class="row"><label for="name">Name</label>
    <div class="ctl"><input type="text" id="name"><span class="hint">Shown in the status bar and server lists.</span><span class="err" data-for="name"></span></div></div>
  <div class="row"><label></label>
    <div class="ctl"><label class="check"><input type="checkbox" id="makeDefault"> Use as default server</label></div></div>
</fieldset>

<div id="status"><span id="statusText"></span></div>

<div id="browser" class="hidden" role="dialog" aria-modal="true" aria-label="Choose remote folder">
  <div class="dlg">
    <div class="dlg-title">Choose deployment folder</div>
    <div class="inline">
      <button type="button" id="bUp" title="Parent folder">↑</button>
      <button type="button" id="bHome" title="Home directory">⌂</button>
      <input type="text" id="bPath" spellcheck="false">
      <button type="button" id="bGo">Go</button>
    </div>
    <div id="bNote" class="hint"></div>
    <ul id="bList"></ul>
    <div class="inline">
      <input type="text" id="bNewName" placeholder="New folder name" spellcheck="false">
      <button type="button" id="bNew">Create Folder</button>
    </div>
    <div id="bErr" class="err"></div>
    <div class="actions">
      <span class="spacer"></span>
      <button type="button" id="bCancel">Cancel</button>
      <button type="button" id="bSelect" class="primary">Select This Folder</button>
    </div>
  </div>
</div>

<div class="actions">
  <button type="button" id="test">Test Connection</button>
  <span class="spacer"></span>
  <button type="button" id="cancel">Cancel</button>
  <button type="submit" id="save" class="primary">Save</button>
</div>
</form>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const text = ['name', 'host', 'port', 'username', 'password', 'privateKeyPath', 'passphrase', 'agentSocket', 'remotePath', 'localPath'];
  let nameTouched = false;
  let remoteTouched = false;

  const auth = () => document.querySelector('input[name=auth]:checked')?.value ?? 'password';
  const collect = () => {
    const d = {};
    text.forEach((f) => (d[f] = $(f).value));
    d.auth = auth();
    d.savePassword = d.auth === 'key' ? $('savePassphrase').checked : $('savePassword').checked;
    d.makeDefault = $('makeDefault').checked;
    return d;
  };
  const showAuth = () => {
    const a = auth();
    for (const kind of ['password', 'key', 'agent']) {
      document.querySelectorAll('.auth-' + kind).forEach((el) => el.classList.toggle('hidden', a !== kind));
    }
  };
  const clearErrors = () => {
    document.querySelectorAll('.err').forEach((el) => (el.textContent = ''));
    document.querySelectorAll('input.invalid').forEach((el) => el.classList.remove('invalid'));
  };
  const setStatus = (kind, msg) => {
    const s = $('status');
    s.className = kind ? 'show ' + kind : '';
    $('statusText').textContent = msg ?? '';
    $('test').disabled = $('detectHome').disabled = $('browseRemote').disabled = $('save').disabled = kind === 'busy';
  };

  // Suggest a name and deployment path until the user edits them.
  const suggest = () => {
    if (!nameTouched) $('name').value = $('host').value.trim().split('.')[0];
    if (!remoteTouched && $('username').value.trim()) $('remotePath').value = remoteHint.replace('<user>', $('username').value.trim());
  };
  let remoteHint = '';
  $('host').addEventListener('input', suggest);
  $('username').addEventListener('input', suggest);
  $('name').addEventListener('input', () => (nameTouched = true));
  $('remotePath').addEventListener('input', () => (remoteTouched = true));
  document.querySelectorAll('input[name=auth]').forEach((r) => r.addEventListener('change', showAuth));

  $('browseKey').addEventListener('click', () => vscode.postMessage({ type: 'browseKey' }));
  $('browseLocal').addEventListener('click', () => vscode.postMessage({ type: 'browseLocal' }));
  $('test').addEventListener('click', () => { clearErrors(); vscode.postMessage({ type: 'test', data: collect() }); });
  $('detectHome').addEventListener('click', () => { clearErrors(); remoteTouched = true; vscode.postMessage({ type: 'detectHome', data: collect() }); });
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('form').addEventListener('submit', (e) => { e.preventDefault(); clearErrors(); vscode.postMessage({ type: 'save', data: collect() }); });

  // --- saved servers
  const showStored = (stored) => {
    $('password').placeholder = stored.password ? '•••••••• (saved)' : '';
    $('passwordHint').textContent = stored.password
      ? 'Leave empty to keep the saved password.' : 'If not saved, you are asked on first connect.';
    $('passphrase').placeholder = stored.passphrase ? '•••••••• (saved)' : 'leave empty if the key has none';
    $('passphraseHint').textContent = stored.passphrase ? 'Leave empty to keep the saved passphrase.' : '';
  };
  const showProfiles = (profiles) => {
    const sel = $('saved');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = profiles.length ? '— choose a saved server —' : '';
    sel.appendChild(none);
    profiles.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    });
    $('savedBox').classList.toggle('hidden', !profiles.length);
    $('forgetSaved').disabled = true;
  };
  $('saved').addEventListener('change', () => {
    $('forgetSaved').disabled = !$('saved').value;
    if ($('saved').value) vscode.postMessage({ type: 'pickProfile', id: $('saved').value });
  });
  $('forgetSaved').addEventListener('click', () => $('saved').value && vscode.postMessage({ type: 'forgetProfile', id: $('saved').value }));

  // --- remote folder browser
  let bCurrent = '';
  let bHome = '';
  const posixParent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  const posixJoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
  const browseTo = (p) => {
    $('bErr').textContent = '';
    $('bList').classList.add('loading');
    vscode.postMessage({ type: 'browse', data: collect(), path: p });
  };
  const closeBrowser = () => {
    $('browser').classList.add('hidden');
    vscode.postMessage({ type: 'browseClose' });
    $('browseRemote').focus();
  };
  $('browseRemote').addEventListener('click', () => {
    clearErrors();
    bCurrent = '';
    $('bList').innerHTML = '';
    $('bNote').textContent = '';
    $('bErr').textContent = '';
    $('bPath').value = $('remotePath').value;
    $('bSelect').disabled = true;
    $('browser').classList.remove('hidden');
    browseTo(undefined);
  });
  $('bUp').addEventListener('click', () => bCurrent && browseTo(posixParent(bCurrent)));
  $('bHome').addEventListener('click', () => browseTo(bHome || '~'));
  $('bGo').addEventListener('click', () => browseTo($('bPath').value));
  $('bPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); browseTo($('bPath').value); } });
  const mkdir = () => {
    if (!bCurrent) return;
    $('bErr').textContent = '';
    vscode.postMessage({ type: 'browseMkdir', data: collect(), path: bCurrent, name: $('bNewName').value });
  };
  $('bNew').addEventListener('click', mkdir);
  $('bNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mkdir(); } });
  $('bCancel').addEventListener('click', closeBrowser);
  $('bSelect').addEventListener('click', () => {
    if (!bCurrent) return;
    $('remotePath').value = bCurrent;
    remoteTouched = true;
    closeBrowser();
  });
  $('browser').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeBrowser(); } });
  const showFolders = (m) => {
    bCurrent = m.path;
    bHome = m.home;
    $('bPath').value = m.path;
    $('bNote').textContent = m.note ?? '';
    $('bNewName').value = '';
    const list = $('bList');
    list.classList.remove('loading');
    list.innerHTML = '';
    const add = (label, cls, target) => {
      const li = document.createElement('li');
      li.textContent = label;
      if (cls) li.className = cls;
      if (target) li.addEventListener('click', () => browseTo(target));
      list.appendChild(li);
    };
    if (m.path !== '/') add('📁 ..', '', posixParent(m.path));
    m.dirs.forEach((d) => add('📁 ' + d, d.startsWith('.') ? 'dot' : '', posixJoin(m.path, d)));
    if (!m.dirs.length) add('No subfolders', 'empty');
    $('bSelect').disabled = false;
  };

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'init') {
      const d = m.data;
      text.forEach((f) => ($(f).value = d[f] ?? ''));
      document.querySelector('input[name=auth][value=' + d.auth + ']').checked = true;
      $('savePassword').checked = d.savePassword;
      $('savePassphrase').checked = d.savePassword;
      $('makeDefault').checked = d.makeDefault;
      remoteHint = m.remoteHint;
      nameTouched = remoteTouched = m.editing;
      if (m.editing) {
        $('title').textContent = 'Edit SFTP Server';
      }
      showStored(m.stored);
      showProfiles(m.profiles);
      showAuth();
      $('host').focus();
    } else if (m.type === 'profiles') {
      showProfiles(m.profiles);
    } else if (m.type === 'applyProfile') {
      for (const [f, v] of Object.entries(m.data)) {
        if (f === 'auth') document.querySelector('input[name=auth][value=' + v + ']').checked = true;
        else $(f).value = v;
      }
      $('password').value = '';
      $('passphrase').value = '';
      nameTouched = remoteTouched = true;
      showStored(m.stored);
      showAuth();
      clearErrors();
      setStatus('ok', 'Loaded "' + m.data.name + '". Check the deployment path for this project, then Save.');
    } else if (m.type === 'set') {
      $(m.field).value = m.value;
    } else if (m.type === 'errors') {
      if (!$('browser').classList.contains('hidden')) closeBrowser();
      let first;
      for (const [field, msg] of Object.entries(m.errors)) {
        const el = document.querySelector('.err[data-for=' + field + ']');
        if (el) el.textContent = msg;
        $(field)?.classList.add('invalid');
        first ??= $(field);
      }
      first?.focus();
      setStatus('error', 'Please fix the highlighted fields.');
    } else if (m.type === 'status') {
      setStatus(m.kind, m.text);
    } else if (m.type === 'browseShow') {
      showFolders(m);
    } else if (m.type === 'browseBusy') {
      $('bList').classList.add('loading');
      $('bNote').textContent = m.text;
    } else if (m.type === 'browseError') {
      $('bList').classList.remove('loading');
      $('bNote').textContent = '';
      $('bErr').textContent = m.text;
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function parseIdentity(id: string): { username: string; host: string; port: number } {
  const at = id.lastIndexOf('@');
  const colon = id.lastIndexOf(':');
  return { username: id.slice(0, at), host: id.slice(at + 1, colon), port: Number(id.slice(colon + 1)) };
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
