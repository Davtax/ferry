import * as vscode from 'vscode';

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

const TICK_MS = 250;
const SPEED_WINDOW_MS = 5000;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds)) return '…';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * Turns per-file byte counters into a VS Code progress bar with transfer speed and ETA.
 * Files without bytes (deletions) count as one "file unit" so they still move the bar.
 */
export class TransferProgress {
  private doneBytes = 0;
  private doneFiles = 0;
  private readonly inflight = new Map<object, () => number>();
  private reportedPct = 0;
  private readonly samples: { t: number; bytes: number }[] = [];
  private readonly timer: NodeJS.Timeout;
  private current = '';

  constructor(
    private readonly progress: Progress,
    private readonly totalBytes: number,
    private readonly totalFiles: number,
  ) {
    this.timer = setInterval(() => this.report(), TICK_MS);
  }

  /** Registers a running transfer; `bytes` is polled on every tick. */
  start(key: object, label: string, bytes: () => number): void {
    this.inflight.set(key, bytes);
    this.current = label;
  }

  finish(key: object, bytes: number): void {
    this.inflight.delete(key);
    this.doneBytes += bytes;
    this.doneFiles++;
    this.report();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private transferred(): number {
    let n = this.doneBytes;
    for (const bytes of this.inflight.values()) n += bytes();
    return Math.min(n, this.totalBytes);
  }

  private report(): void {
    const now = Date.now();
    const bytes = this.transferred();
    this.samples.push({ t: now, bytes });
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift();

    const pct = this.totalBytes > 0
      ? (bytes / this.totalBytes) * 100
      : (this.doneFiles / Math.max(1, this.totalFiles)) * 100;
    const increment = Math.max(0, pct - this.reportedPct);
    this.reportedPct = Math.max(this.reportedPct, pct);

    const parts = [`${Math.floor(pct)}%`];
    if (this.totalBytes > 0) {
      parts.push(`${formatBytes(bytes)} / ${formatBytes(this.totalBytes)}`);
      const first = this.samples[0];
      const dt = (now - first.t) / 1000;
      if (dt >= 1) {
        const speed = (bytes - first.bytes) / dt;
        parts.push(`${formatBytes(speed)}/s`);
        parts.push(speed > 0 ? `~${formatDuration((this.totalBytes - bytes) / speed)} left` : 'stalled');
      }
    }
    if (this.totalFiles > 1) parts.push(`file ${Math.min(this.doneFiles + 1, this.totalFiles)}/${this.totalFiles}`);
    if (this.current) parts.push(this.current);
    this.progress.report({ increment, message: parts.join(' · ') });
  }
}
