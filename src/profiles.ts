import * as vscode from 'vscode';
import { ServerConfig } from './config';

/**
 * A server remembered on this machine (VS Code global storage, not part of the synced project), so it can be
 * reused in other projects and so machine-specific settings such as the private key path stay out of ferry.json.
 */
export interface ServerProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key' | 'agent';
  privateKeyPath?: string;
  agent?: boolean | string;
  /** Deployment path used the last time this server was saved in a project. */
  remotePath?: string;
  updated: number;
}

const KEY = 'ferry.profiles';

export function identity(s: { username: string; host: string; port?: number }): string {
  return `${s.username}@${s.host}:${s.port ?? 22}`;
}

export function authOf(s: ServerConfig): ServerProfile['auth'] {
  return s.agent ? 'agent' : s.auth === 'key' || s.privateKeyPath ? 'key' : 'password';
}

/** Saved servers, one per user@host:port. */
export class ProfileStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): ServerProfile[] {
    return [...(this.memento.get<ServerProfile[]>(KEY) ?? [])].sort((a, b) => b.updated - a.updated);
  }

  get(s: { username: string; host: string; port?: number }): ServerProfile | undefined {
    const id = identity(s);
    return this.all().find((p) => identity(p) === id);
  }

  /** Private key path of this server on this machine, if one was saved. */
  keyPath(s: ServerConfig): string | undefined {
    return this.get(s)?.privateKeyPath;
  }

  async save(profile: Omit<ServerProfile, 'updated'>): Promise<void> {
    const id = identity(profile);
    const others = this.all().filter((p) => identity(p) !== id);
    await this.memento.update(KEY, [{ ...profile, updated: Date.now() }, ...others]);
  }

  async setKeyPath(s: ServerConfig, privateKeyPath: string): Promise<void> {
    const existing = this.get(s);
    await this.save({
      ...(existing ?? { name: s.name, host: s.host, port: s.port ?? 22, username: s.username, remotePath: s.remotePath }),
      auth: 'key',
      privateKeyPath,
    });
  }

  /** Adds servers of a project's ferry.json that are not saved on this machine yet (existing ones are kept). */
  async importMissing(servers: ServerConfig[], keyPathOf: (s: ServerConfig) => Promise<string | undefined>): Promise<void> {
    for (const s of servers) {
      if (!s.host || !s.username || this.get(s)) continue;
      const auth = authOf(s);
      await this.save({
        name: s.name, host: s.host, port: s.port ?? 22, username: s.username, auth, agent: s.agent, remotePath: s.remotePath,
        privateKeyPath: auth === 'key' ? await keyPathOf(s) : undefined,
      });
    }
  }

  async remove(s: { username: string; host: string; port?: number }): Promise<void> {
    const id = identity(s);
    await this.memento.update(KEY, this.all().filter((p) => identity(p) !== id));
  }
}
