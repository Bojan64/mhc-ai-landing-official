import { describe, expect, it } from "vitest";
import { backoffDelay, DEFAULT_RETRY, isRetryable, withRetry } from "../src/runner/retry";
import { Limiter } from "../src/runner/limiter";
import { redact } from "../src/util/redact";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const noSleep = { sleep: async () => {} };

describe("retry with backoff", () => {
  it("retries 429, 408, 5xx and network errors, not 400/401/404", () => {
    for (const s of [429, 408, 500, 503]) expect(isRetryable(httpError(s))).toBe(true);
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    for (const s of [400, 401, 404]) expect(isRetryable(httpError(s))).toBe(false);
  });

  it("succeeds after transient failures", async () => {
    let n = 0;
    const attempts: number[] = [];
    const r = await withRetry(async () => (++n < 3 ? Promise.reject(httpError(429)) : "ok"), {
      ...DEFAULT_RETRY, ...noSleep, onAttempt: (a) => attempts.push(a),
    });
    expect(r).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("gives up after 4 attempts", async () => {
    let n = 0;
    await expect(withRetry(async () => (n++, Promise.reject(httpError(503))), { ...DEFAULT_RETRY, ...noSleep })).rejects.toThrow();
    expect(n).toBe(4);
  });

  it("does not retry a bad request", async () => {
    let n = 0;
    await expect(withRetry(async () => (n++, Promise.reject(httpError(400))), { ...DEFAULT_RETRY, ...noSleep })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("backoff grows exponentially with jitter and is capped", () => {
    const o = { ...DEFAULT_RETRY, baseDelayMs: 1000, maxDelayMs: 5000 };
    expect(backoffDelay(1, o, () => 1)).toBe(1000);
    expect(backoffDelay(3, o, () => 1)).toBe(4000);
    expect(backoffDelay(10, o, () => 1)).toBe(5000);
    expect(backoffDelay(3, o, () => 0.5)).toBe(2000);
  });
});

describe("rate limiter", () => {
  it("never runs more than `concurrency` calls at once", async () => {
    const lim = new Limiter(2, 60_000);
    let active = 0;
    let peak = 0;
    const task = () => lim.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });

  it("spaces call starts by 60s / requests_per_minute", async () => {
    let clock = 0;
    const waits: number[] = [];
    const lim = new Limiter(10, 30, () => clock, async (ms) => { waits.push(ms); });
    await Promise.all([1, 2, 3].map(() => lim.run(async () => {})));
    expect(waits).toEqual([2000, 4000]);
  });
});

describe("redaction", () => {
  it("removes API keys from text", () => {
    const env = { OPENAI_API_KEY: "custom-secret-123456" };
    const text = "bad key custom-secret-123456 and sk-ant-abcdefghij1234 and AIzaSyA1234567890abcdefghijk";
    const out = redact(text, env);
    expect(out).not.toContain("custom-secret");
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain("AIza");
  });
});
