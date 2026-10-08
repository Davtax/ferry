import * as vscode from 'vscode';
import * as path from 'path';
import { ServerConfig } from './config';
import { ConnectionManager, expandHome } from './connection';
import { authOf } from './profiles';

/** Quotes a string for a POSIX shell (also valid in fish). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Terminal options that run the system `ssh` client and open a login shell in `dir` on the server
 * (the project folder by default). Password and passphrase prompts happen in the terminal itself.
 */
export async function sshTerminalOptions(
  server: ServerConfig, conns: ConnectionManager, dir = server.remotePath,
): Promise<vscode.TerminalOptions> {
  const args = ['-t'];
  if (server.port && server.port !== 22) {
    args.push('-p', String(server.port));
  }
  const env: Record<string, string> = {};
  const auth = authOf(server);
  if (auth === 'key') {
    const key = await conns.resolveKeyPath(server, true);
    if (key) args.push('-i', expandHome(key));
  } else if (auth === 'agent' && typeof server.agent === 'string') {
    env.SSH_AUTH_SOCK = server.agent;
  }
  // If the folder is missing, still open a shell (in the home directory) instead of closing the terminal.
  args.push(`${server.username}@${server.host}`, `cd ${shellQuote(dir)} || echo 'Ferry: staying in home directory'; exec $SHELL -l`);
  return {
    name: `${server.name}: ${path.posix.basename(dir) || dir}`,
    shellPath: 'ssh',
    shellArgs: args,
    env,
    iconPath: new vscode.ThemeIcon('server'),
  };
}
