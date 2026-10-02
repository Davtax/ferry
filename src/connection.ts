import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { ServerConfig } from './config';
import { log } from './log';
import { ProfileStore, authOf } from './profiles';

/** Keys tried, like ssh does, when no key path is known on this machine. */
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

const IDLE_MS = 10 * 60 * 1000;

interface Pooled {
  client: Promise<SftpClient>;
  idleTimer?: NodeJS.Timeout;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Writes paths inside the home directory as ~/…, which works across machines and OSes. */
export function tildify(p: string): string {
  const home = os.homedir() + path.sep;
  const inside = process.platform === 'win32' ? p.toLowerCase().startsWith(home.toLowerCase()) : p.startsWith(home);
  return inside ? '~/' + p.slice(home.length).split(path.sep).join('/') : p;
}

function agentSocket(agent: boolean | string): string | undefined {
  return typeof agent === 'string'
    ? agent
    : process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
}

function serverKey(s: ServerConfig): string {
  return `${s.username}@${s.host}:${s.port ?? 22}`;
}

function isAuthError(err: unknown): boolean {
  return /authentication|auth fail|permission denied/i.test(String((err as Error)?.message ?? err));
}

function isPassphraseError(err: unknown): boolean {
  return /passphrase|encrypted private/i.test(String((err as Error)?.message ?? err));
}

function isConnectionLost(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  const code = (err as { code?: string })?.code ?? '';
  return /no sftp connection|not connected|ECONNRESET|socket|channel|ended|closed/i.test(msg)
    || ['ECONNRESET', 'ERR_NOT_CONNECTED', 'ERR_GENERIC_CLIENT'].includes(code);
}

/** Keeps one SFTP connection per server, prompting for credentials when needed. */
export class ConnectionManager implements vscode.Disposable {
  private readonly pool = new Map<string, Pooled>();

  constructor(private readonly secrets: vscode.SecretStorage, private readonly profiles?: ProfileStore) {}

  /**
   * Private key file for a key-auth server on this machine: the path saved on this machine, then the one in
   * ferry.json, then the usual ~/.ssh keys. With `ask`, the user picks one (remembered) if none exists.
   */
  async resolveKeyPath(server: ServerConfig, ask: boolean): Promise<string | undefined> {
    const candidates = [
      this.profiles?.keyPath(server),
      server.privateKeyPath,
      ...DEFAULT_KEYS.map((k) => `~/.ssh/${k}`),
    ].filter((p): p is string => !!p);
    for (const candidate of candidates) {
      if (fs.existsSync(expandHome(candidate))) {
        return candidate;
      }
    }
    if (!ask) {
      return undefined;
    }
    const pick = await vscode.window.showWarningMessage(
      `Ferry: no private key for ${serverKey(server)} is set up on this computer.`, { modal: true }, 'Select Key File…');
    const files = pick && await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')), title: `Private key for ${serverKey(server)}`, canSelectMany: false,
    });
    if (!files?.length) {
      throw new Error('Cancelled');
    }
    const chosen = tildify(files[0].fsPath);
    await this.profiles?.setKeyPath(server, chosen);
    return chosen;
  }

  /** Runs `fn` with a connected client, reconnecting once if the connection dropped. */
  async withClient<T>(server: ServerConfig, fn: (c: SftpClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.get(server));
    } catch (err) {
      if (!isConnectionLost(err)) {
        throw err;
      }
      log(`Connection to ${server.name} lost (${err}); reconnecting`);
      await this.close(server.name);
      return fn(await this.get(server));
    }
  }

  async get(server: ServerConfig): Promise<SftpClient> {
    let entry = this.pool.get(server.name);
    if (!entry) {
      entry = { client: this.connect(server) };
      this.pool.set(server.name, entry);
      entry.client.catch(() => this.pool.delete(server.name));
    }
    this.touch(server.name, entry);
    return entry.client;
  }

  async close(name: string): Promise<void> {
    const entry = this.pool.get(name);
    if (!entry) {
      return;
    }
    this.pool.delete(name);
    clearTimeout(entry.idleTimer);
    try {
      await (await entry.client).end();
    } catch {
      // already closed
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((n) => this.close(n)));
  }

  async forgetCredentials(server: ServerConfig): Promise<void> {
    await this.secrets.delete(`ferry:pw:${serverKey(server)}`);
    await this.secrets.delete(`ferry:pp:${serverKey(server)}`);
    await this.close(server.name);
  }

  /** Stores a password / key passphrase in secret storage for the server's user@host:port. */
  async storeCredentials(server: ServerConfig, creds: { password?: string; passphrase?: string }): Promise<void> {
    if (creds.password) {
      await this.secrets.store(`ferry:pw:${serverKey(server)}`, creds.password);
    }
    if (creds.passphrase) {
      await this.secrets.store(`ferry:pp:${serverKey(server)}`, creds.passphrase);
    }
  }

  /** Moves stored credentials when user, host or port of a server change. */
  async moveCredentials(from: ServerConfig, to: ServerConfig): Promise<void> {
    if (serverKey(from) === serverKey(to)) {
      return;
    }
    for (const kind of ['pw', 'pp']) {
      const value = await this.secrets.get(`ferry:${kind}:${serverKey(from)}`);
      if (value !== undefined) {
        await this.secrets.store(`ferry:${kind}:${serverKey(to)}`, value);
        await this.secrets.delete(`ferry:${kind}:${serverKey(from)}`);
      }
    }
  }

  /** Whether a password or passphrase is stored for this user@host:port. */
  async hasStoredCredentials(server: ServerConfig): Promise<{ password: boolean; passphrase: boolean }> {
    return {
      password: (await this.secrets.get(`ferry:pw:${serverKey(server)}`)) !== undefined,
      passphrase: (await this.secrets.get(`ferry:pp:${serverKey(server)}`)) !== undefined,
    };
  }

  /**
   * Connects once outside the pool, without prompting, to check the login. `credentialsOf` names the server whose
   * stored secrets to use (for an edited server whose user, host or port changed).
   */
  async test(server: ServerConfig, credentialsOf = server): Promise<void> {
    await this.once(server, credentialsOf, async () => undefined);
  }

  /** Creates `remotePath` if it does not exist yet, using a one-off connection. Returns true if it was created. */
  async ensureRemoteRoot(server: ServerConfig, credentialsOf = server): Promise<boolean> {
    return this.once(server, credentialsOf, async (client) => {
      if (await client.exists(server.remotePath)) {
        return false;
      }
      await client.mkdir(server.remotePath, true);
      return true;
    });
  }

  /** The user's home directory on the server (where an SFTP session starts), using a one-off connection. */
  async homeDir(server: ServerConfig, credentialsOf = server): Promise<string> {
    return this.once(server, credentialsOf, (client) => client.realPath('.'));
  }

  /** Runs `fn` on a fresh connection that is closed afterwards; never prompts (see `test`). */
  private async once<T>(server: ServerConfig, credentialsOf: ServerConfig, fn: (c: SftpClient) => Promise<T>): Promise<T> {
    const client = await this.connectOnce(server, credentialsOf);
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Opens a connection outside the pool without prompting; the caller must `end()` it. */
  async connectOnce(server: ServerConfig, credentialsOf = server): Promise<SftpClient> {
    const options: SftpClient.ConnectOptions = {
      host: server.host,
      port: server.port ?? 22,
      username: server.username,
      readyTimeout: 20000,
    };
    if (server.agent) {
      options.agent = agentSocket(server.agent);
    }
    if (authOf(server) === 'key') {
      // An explicit path (typed in the server form) wins over what is remembered for this machine.
      const keyPath = server.privateKeyPath ?? (await this.resolveKeyPath(server, false));
      if (!keyPath) {
        throw new Error('Select a private key file.');
      }
      options.privateKey = await fs.promises.readFile(expandHome(keyPath));
      options.passphrase = server.passphrase ?? (await this.secrets.get(`ferry:pp:${serverKey(credentialsOf)}`));
    } else if (!server.agent) {
      options.password = server.password ?? (await this.secrets.get(`ferry:pw:${serverKey(credentialsOf)}`));
      if (!options.password) {
        throw new Error('Enter a password first.');
      }
    }
    const client = new SftpClient(`ferry-once-${server.name}`);
    log(`One-off connection to ${serverKey(server)}…`);
    try {
      await client.connect(options);
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
    client.on('error', (e: Error) => log(`[${server.name}] ${e.message}`));
    return client;
  }

  private touch(name: string, entry: Pooled): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      log(`Closing idle connection to ${name}`);
      void this.close(name);
    }, IDLE_MS);
  }

  private async connect(server: ServerConfig): Promise<SftpClient> {
    const pwKey = `ferry:pw:${serverKey(server)}`;
    const ppKey = `ferry:pp:${serverKey(server)}`;

    const options: SftpClient.ConnectOptions = {
      host: server.host,
      port: server.port ?? 22,
      username: server.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
    };

    if (server.agent) {
      options.agent = agentSocket(server.agent);
    }
    let passphrase = server.passphrase ?? (await this.secrets.get(ppKey));
    const keyPath = !server.agent && authOf(server) === 'key' ? await this.resolveKeyPath(server, true) : undefined;
    if (keyPath) {
      options.privateKey = await fs.promises.readFile(expandHome(keyPath));
    }
    const usesKey = !!(options.privateKey || options.agent);
    let password = server.password ?? (await this.secrets.get(pwKey));
    let promptedPassword = false;
    let promptedPassphrase = false;

    if (!usesKey && !password) {
      password = await this.prompt(`Password for ${serverKey(server)}`, true);
      promptedPassword = true;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const client = new SftpClient(`ferry-${server.name}`);
      try {
        log(`Connecting to ${serverKey(server)}…`);
        await client.connect({ ...options, password, passphrase });
        client.on('error', (e: Error) => log(`[${server.name}] ${e.message}`));
        client.on('close', () => {
          // Drop the pooled entry only if it still points at this client.
          void this.pool.get(server.name)?.client.then((current) => {
            if (current === client) {
              this.pool.delete(server.name);
            }
          }, () => undefined);
        });
        if (promptedPassword && password && !server.password) {
          await this.secrets.store(pwKey, password);
        }
        if (promptedPassphrase && passphrase && !server.passphrase) {
          await this.secrets.store(ppKey, passphrase);
        }
        log(`Connected to ${server.name}`);
        return client;
      } catch (err) {
        await client.end().catch(() => undefined);
        log(`Connection to ${server.name} failed: ${err}`);
        if (options.privateKey && isPassphraseError(err) && !server.passphrase) {
          await this.secrets.delete(ppKey);
          passphrase = await this.prompt(`Passphrase for ${keyPath}`, true);
          promptedPassphrase = true;
          continue;
        }
        if (isAuthError(err) && !server.password) {
          await this.secrets.delete(pwKey);
          password = await this.prompt(`Authentication failed. Password for ${serverKey(server)}`, true);
          promptedPassword = true;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Could not authenticate to ${serverKey(server)}`);
  }

  private async prompt(title: string, secret: boolean): Promise<string> {
    const value = await vscode.window.showInputBox({ title: 'Ferry', prompt: title, password: secret, ignoreFocusOut: true });
    if (value === undefined) {
      throw new Error('Cancelled');
    }
    return value;
  }

  dispose(): void {
    void this.closeAll();
  }
}
