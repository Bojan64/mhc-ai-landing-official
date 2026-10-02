import { describe, expect, it } from "vitest";
import type { Engine } from "../src/config/schemas";
import { openDb } from "../src/db/db";
import { getRun, jobStatusCounts, savePlannedRun, selectResponses } from "../src/db/repository";
import type { AdapterFactory } from "../src/engines";
import type { EngineResult } from "../src/engines/types";
import { executeRun } from "../src/runner/execute";
import { buildJobs } from "../src/runner/plan";
import { realConfig } from "./helpers";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function testConfig() {
  const c = realConfig();
  for (const e of c.engines.engines) {
    e.pricing = { input_per_million: 1, output_per_million: 1, per_search: 0.01 };
    e.requests_per_minute = 600_000; // no waiting in tests
  }
  return c;
}

const okResult = (e: Engine, prompt: string): EngineResult => ({
  answer: `${e.engine_id} answer to: ${prompt}`,
  citations: [],
  raw: { fake: true },
  input_tokens: 1000,
  output_tokens: 1000,
  search_count: 0,
  provider_cost_usd: null,
});

/** Fake adapters; `behave` can throw to simulate errors. */
function fakeFactory(behave?: (e: Engine, callNo: number) => void): { factory: AdapterFactory; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    factory: (engine) => ({
      engine,
      call: async (req) => {
        n++;
        behave?.(engine, n);
        return okResult(engine, req.prompt);
      },
    }),
  };
}

function setup(reps = 1) {
  const db = openDb(":memory:");
  const config = testConfig();
  savePlannedRun(db, "r", config, reps, buildJobs(config, reps));
  return { db, config };
}

const quiet = { log: () => {}, retry: { sleep: async () => {} } };

describe("runner (fake engines, no real API calls)", () => {
  it("runs all jobs, stores responses and finishes the run", async () => {
    const { db, config } = setup();
    const f = fakeFactory();
    const s = await executeRun(db, config, "r", { kind: "run", budgetEur: 1000, adapterFactory: f.factory, ...quiet });
    expect(s.failed).toBe(0);
    expect(s.done).toBe(s.selected);
    expect(jobStatusCounts(db, "r")).toEqual({ done: s.selected });
    expect(getRun(db, "r")?.status).toBe("finished");
    const r = selectResponses(db, "r")[0];
    expect(r.raw_answer).toContain("answer to:");
    expect(r.cost_estimate).toBeCloseTo(0.002); // 1000+1000 tokens at $1/M
  });

  it("--limit runs at most N jobs per engine, the rest stay pending", async () => {
    const { db, config } = setup();
    const s = await executeRun(db, config, "r", {
      kind: "run", limitPerEngine: 2, budgetEur: 1000, adapterFactory: fakeFactory().factory, ...quiet,
    });
    expect(s.done).toBe(2 * 4);
    expect(getRun(db, "r")?.status).toBe("stopped");
  });

  it("retries a 429 and then succeeds", async () => {
    const { db, config } = setup();
    const f = fakeFactory((_, n) => { if (n === 1) throw httpError(429); });
    const s = await executeRun(db, config, "r", {
      kind: "run", engine: "anthropic", limitPerEngine: 1, budgetEur: 1000, adapterFactory: f.factory, ...quiet,
    });
    expect(s.done).toBe(1);
    expect(f.calls()).toBe(2);
    const row = db.prepare("SELECT attempts FROM jobs WHERE status = 'done'").get() as { attempts: number };
    expect(row.attempts).toBe(2);
  });

  it("marks a job failed after 4 attempts and continues with the others", async () => {
    const { db, config } = setup();
    const f = fakeFactory((e) => { if (e.engine_id === "gemini") throw httpError(503); });
    const s = await executeRun(db, config, "r", {
      kind: "run", limitPerEngine: 1, budgetEur: 1000, adapterFactory: f.factory, ...quiet,
    });
    expect(s.failed).toBe(1);
    expect(s.done).toBe(3);
    const failed = db.prepare("SELECT attempts, error FROM jobs WHERE status = 'failed'").get() as { attempts: number; error: string };
    expect(failed.attempts).toBe(4);
    expect(failed.error).toContain("HTTP 503");
  });

  it("resume continues where the run stopped, and can retry failed jobs", async () => {
    const { db, config } = setup();
    let fail = true;
    const f = fakeFactory(() => { if (fail) throw httpError(400); });
    await executeRun(db, config, "r", { kind: "run", limitPerEngine: 1, budgetEur: 1000, adapterFactory: f.factory, ...quiet });
    expect(jobStatusCounts(db, "r").failed).toBe(4);
    fail = false;
    await expect(executeRun(db, config, "r", { kind: "run", budgetEur: 1000, adapterFactory: f.factory, ...quiet }))
      .rejects.toThrow(/already started/);
    const s = await executeRun(db, config, "r", {
      kind: "resume", retryFailed: true, budgetEur: 1000, adapterFactory: f.factory, ...quiet,
    });
    expect(s.failed).toBe(0);
    expect(getRun(db, "r")?.status).toBe("finished");
    expect(jobStatusCounts(db, "r")).toEqual({ done: s.selected });
  });

  it("refuses to start when the estimate exceeds the budget", async () => {
    const { db, config } = setup(3);
    const f = fakeFactory();
    await expect(executeRun(db, config, "r", { kind: "run", budgetEur: 0.01, adapterFactory: f.factory, ...quiet }))
      .rejects.toThrow(/exceeds BUDGET_EUR/);
    expect(f.calls()).toBe(0);
  });

  it("refuses to start while prices are missing", async () => {
    const { db, config } = setup();
    config.engines.engines[0].pricing.input_per_million = null;
    await expect(executeRun(db, config, "r", { kind: "run", budgetEur: 1000, adapterFactory: fakeFactory().factory, ...quiet }))
      .rejects.toThrow(/prices .* missing/);
  });

  it("stops cleanly once actual spend reaches the budget", async () => {
    const { db, config } = setup();
    // Tiny estimate assumptions so the pre-check passes…
    config.engines.cost_assumptions.no_search = { input_tokens: 1, output_tokens: 1, searches_per_call: 0 };
    config.engines.cost_assumptions.web_search = { input_tokens: 1, output_tokens: 1, searches_per_call: 0 };
    config.engines.cost_assumptions.analyzer = { input_tokens: 1, output_tokens: 1 };
    for (const e of config.engines.engines) { e.cost_assumptions = undefined; e.max_concurrency = 1; }
    // …but every real call costs $1 (provider-reported), so the budget runs out after a few calls.
    const factory: AdapterFactory = (engine) => ({
      engine,
      call: async (req) => ({ ...okResult(engine, req.prompt), provider_cost_usd: 1 }),
    });
    const s = await executeRun(db, config, "r", { kind: "run", budgetEur: 2, adapterFactory: factory, ...quiet });
    expect(s.stopReason).toBe("budget");
    expect(s.done).toBeLessThanOrEqual(4); // ≤ one call in flight per engine when the limit is hit
    expect(s.notStarted).toBeGreaterThan(0);
    expect(getRun(db, "r")?.status).toBe("stopped");
  });

  it("refuses if an engine's model changed after planning", async () => {
    const { db, config } = setup();
    config.engines.engines.find((e) => e.engine_id === "openai")!.model = "other-model";
    await expect(executeRun(db, config, "r", { kind: "run", budgetEur: 1000, adapterFactory: fakeFactory().factory, ...quiet }))
      .rejects.toThrow(/planned with "gpt-6-astra"/);
  });

  it("refuses before any call when an API key is missing", async () => {
    const { db, config } = setup();
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(executeRun(db, config, "r", { kind: "run", engine: "openai", budgetEur: 1000, ...quiet }))
      .rejects.toThrow(/OPENAI_API_KEY is not set/);
    if (saved) process.env.OPENAI_API_KEY = saved;
  });
});
