export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called before each attempt (1-based), e.g. to record attempts in the DB. */
  onAttempt?: (attempt: number) => void;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 60_000 };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP status of an SDK error, if any. All four SDKs expose `status`. */
export function errorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** Retry on rate limits (429), timeouts (408), server errors (5xx) and network errors (no status). */
export function isRetryable(e: unknown): boolean {
  const s = errorStatus(e);
  return s === undefined || s === 408 || s === 429 || s >= 500;
}

/** Exponential backoff with full jitter: random delay in [0, base·2^(n-1)], capped. */
export function backoffDelay(attempt: number, o: RetryOptions, random: () => number): number {
  const cap = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * cap);
}

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    o.onAttempt?.(attempt);
    try {
      return await fn();
    } catch (e) {
      if (attempt >= o.maxAttempts || !isRetryable(e)) throw e;
      await sleep(backoffDelay(attempt, o, random));
    }
  }
}
