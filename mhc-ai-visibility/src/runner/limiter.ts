/**
 * Per-engine limiter: at most `concurrency` calls at once and at most
 * `perMinute` call starts per minute (evenly spaced).
 */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;
  private readonly spacingMs: number;

  constructor(
    private readonly concurrency: number,
    perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.spacingMs = 60_000 / perMinute;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      const t = this.now();
      const start = Math.max(t, this.nextStart);
      this.nextStart = start + this.spacingMs;
      if (start > t) await this.sleep(start - t);
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
