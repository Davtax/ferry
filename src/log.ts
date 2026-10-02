import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel('Ferry');
  return channel;
}

export function log(message: string): void {
  channel?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

/** Runs async work with up to `limit` tasks in flight. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  token?: vscode.CancellationToken,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !token?.isCancellationRequested) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
