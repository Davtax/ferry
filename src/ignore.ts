import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';
import { ConfigManager, ServerConfig } from './config';

export const IGNORE_FILE = '.ferryignore';

export interface Matcher {
  /** `rel` is a POSIX path relative to the mapping root. */
  isIgnored(rel: string, isDir: boolean): boolean;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Combines, in gitignore syntax: the `ferry.defaultIgnore` setting, the server's
 * `ignore` list, `.ferryignore` and (optionally) `.gitignore` at the mapping root.
 */
export class IgnoreManager implements vscode.Disposable {
  private readonly cache = new Map<string, Matcher>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly config: ConfigManager) {
    const invalidate = () => this.cache.clear();
    const watcher = vscode.workspace.createFileSystemWatcher(`**/{${IGNORE_FILE},.gitignore}`);
    watcher.onDidChange(invalidate);
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);
    this.disposables.push(
      watcher,
      config.onDidChange(invalidate),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('ferry') && invalidate()),
    );
  }

  ignoreFilePath(server: ServerConfig): string {
    return path.join(this.config.localRoot(server), IGNORE_FILE);
  }

  matcher(server: ServerConfig): Matcher {
    let m = this.cache.get(server.name);
    if (!m) {
      m = this.build(server);
      this.cache.set(server.name, m);
    }
    return m;
  }

  private build(server: ServerConfig): Matcher {
    const settings = vscode.workspace.getConfiguration('ferry');
    const root = this.config.localRoot(server);
    const ig: Ignore = ignore()
      .add(settings.get<string[]>('defaultIgnore', []))
      .add(server.ignore ?? [])
      .add(readLines(path.join(root, IGNORE_FILE)));
    if (settings.get<boolean>('respectGitignore', false)) {
      ig.add(readLines(path.join(root, '.gitignore')));
    }
    return {
      isIgnored: (rel, isDir) => {
        if (!rel) {
          return false;
        }
        return ig.ignores(isDir ? `${rel}/` : rel);
      },
    };
  }

  /** Appends patterns to `.ferryignore`. */
  async addPatterns(server: ServerConfig, patterns: string[]): Promise<void> {
    const file = this.ignoreFilePath(server);
    const existing = readLines(file);
    const toAdd = patterns.filter((p) => !existing.includes(p));
    if (toAdd.length === 0) {
      return;
    }
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Ferry ignore patterns (gitignore syntax)\n';
    if (text.length && !text.endsWith('\n')) {
      text += '\n';
    }
    await fs.promises.writeFile(file, text + toAdd.join('\n') + '\n');
    this.cache.clear();
  }

  /** Removes exact pattern lines from `.ferryignore`. */
  async removePatterns(server: ServerConfig, patterns: string[]): Promise<void> {
    const file = this.ignoreFilePath(server);
    const lines = readLines(file).filter((l) => !patterns.includes(l));
    await fs.promises.writeFile(file, lines.join('\n'));
    this.cache.clear();
  }

  filePatterns(server: ServerConfig): string[] {
    return readLines(this.ignoreFilePath(server)).filter((l) => l.trim() && !l.trim().startsWith('#'));
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
