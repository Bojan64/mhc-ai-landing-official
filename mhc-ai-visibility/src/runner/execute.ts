import type { AppConfig } from "../config/load";
import type { Engine } from "../config/schemas";
import type { DB } from "../db/db";
import {
  getRun, markFailed, markRunEnded, markRunStarted, recordAttempt, runSpentUsd, saveResponse, selectJobs,
  type JobRow,
} from "../db/repository";
import { createAdapter, type AdapterFactory } from "../engines";
import type { EngineAdapter } from "../engines/types";
import { redact } from "../util/redact";
import { budgetReached, callCostUsd, checkBudgetBeforeRun, estimateCost } from "./cost";
import { Limiter } from "./limiter";
import { DEFAULT_RETRY, errorStatus, withRetry, type RetryOptions } from "./retry";

export interface ExecuteOptions {
  /** "run" = first start of a planned run; "resume" = continue a started run. */
  kind: "run" | "resume";
  /** At most this many jobs per engine in this invocation (smoke tests). */
  limitPerEngine?: number;
  engine?: string;
  hotel?: string;
  /** resume only: also retry jobs that failed before. */
  retryFailed?: boolean;
  budgetEur: number | null;
  log?: (line: string) => void;
  adapterFactory?: AdapterFactory;
  retry?: Partial<RetryOptions>;
  /** Checked before each job; return true to stop cleanly (e.g. Ctrl+C). */
  shouldStop?: () => boolean;
  now?: () => number;
}

export interface ExecuteSummary {
  selected: number;
  done: number;
  failed: number;
  notStarted: number;
  spentThisSessionUsd: number;
  stopReason: "completed" | "budget" | "interrupted";
  runStatus: string;
}

/** Thrown when a run may not start; the message explains why in plain language. */
export class RunRefused extends Error {}

export async function executeRun(db: DB, config: AppConfig, runId: string, o: ExecuteOptions): Promise<ExecuteSummary> {
  const log = o.log ?? console.log;
  const now = o.now ?? Date.now;
  const run = getRun(db, runId);
  if (!run) throw new RunRefused(`Run "${runId}" does not exist. Create it first with: plan --run-name "${runId}"`);
  if (o.kind === "run" && run.status !== "planned")
    throw new RunRefused(`Run "${runId}" has already started. Use "resume" to continue it.`);
  if (o.kind === "resume" && run.status === "planned")
    throw new RunRefused(`Run "${runId}" has not started yet. Use "run" first.`);
  if (run.config_hash !== config.hash)
    log("⚠ The config files changed since this run was planned (fine for prices; models and prompts stay as planned).");

  const engines = new Map(config.engines.engines.map((e) => [e.engine_id, e]));
  if (o.engine && !engines.has(o.engine)) throw new RunRefused(`Unknown engine "${o.engine}".`);

  const statuses: JobRow["status"][] = o.kind === "resume" && o.retryFailed ? ["pending", "failed"] : ["pending"];
  const jobs = limitPerEngine(selectJobs(db, runId, { engine: o.engine, hotel: o.hotel, statuses }), o.limitPerEngine);
  if (jobs.length === 0) {
    log("Nothing to do: no matching jobs are waiting.");
    return { selected: 0, done: 0, failed: 0, notStarted: 0, spentThisSessionUsd: 0, stopReason: "completed", runStatus: run.status };
  }

  for (const j of jobs) {
    const e = engines.get(j.engine_id);
    if (!e || !e.enabled) throw new RunRefused(`Engine "${j.engine_id}" is no longer enabled in engines.json.`);
    if (e.model !== j.model)
      throw new RunRefused(
        `Engine "${j.engine_id}" now uses model "${e.model}", but this run was planned with "${j.model}". ` +
          "Start a new run (plan with a new --run-name) to test a different model.",
      );
  }

  // Budget check before any call: tracked spend so far + estimate for what we are about to do.
  const rate = config.engines.usd_to_eur;
  const spentBeforeUsd = runSpentUsd(db, runId);
  const estimate = estimateCost(config, jobs);
  const check = checkBudgetBeforeRun(estimate, o.budgetEur, spentBeforeUsd * rate);
  if (!check.ok) throw new RunRefused(`Run refused:\n  - ${check.reasons.join("\n  - ")}`);
  const budgetEur = o.budgetEur as number;

  // Create adapters first, so a missing API key stops us before any call.
  const factory = o.adapterFactory ?? createAdapter;
  const adapters = new Map<string, EngineAdapter>();
  for (const id of new Set(jobs.map((j) => j.engine_id))) adapters.set(id, factory(engines.get(id)!, config.engines));

  log(
    `Starting ${jobs.length} job(s). Estimated cost €${estimate.knownEur.toFixed(2)}; ` +
      `already spent on this run €${(spentBeforeUsd * rate).toFixed(2)}; budget €${budgetEur.toFixed(2)}.`,
  );
  markRunStarted(db, runId);

  const retry: RetryOptions = { ...DEFAULT_RETRY, ...o.retry };
  let spentUsd = 0;
  let stopReason: ExecuteSummary["stopReason"] = "completed";
  let done = 0;
  let failed = 0;

  const shouldStop = () => {
    if (stopReason !== "completed") return true;
    if (budgetReached((spentBeforeUsd + spentUsd) * rate, budgetEur)) stopReason = "budget";
    else if (o.shouldStop?.()) stopReason = "interrupted";
    return stopReason !== "completed";
  };

  const runJob = async (job: JobRow, engine: Engine, limiter: Limiter) => {
    const adapter = adapters.get(job.engine_id)!;
    const tag = `${job.engine_id.padEnd(10)} ${job.hotel_id} ${job.prompt_id.padEnd(8)} ${job.mode.padEnd(10)} rep${job.repetition}`;
    let latency = 0;
    try {
      const result = await withRetry(
        () =>
          limiter.run(async () => {
            const t0 = now();
            try {
              return await adapter.call({ prompt: job.prompt_text_rendered, mode: job.mode });
            } finally {
              latency = now() - t0;
            }
          }),
        { ...retry, onAttempt: () => recordAttempt(db, job.job_id) },
      );
      const cost =
        result.provider_cost_usd ??
        callCostUsd(engine.pricing, {
          input_tokens: result.input_tokens ?? 0,
          output_tokens: result.output_tokens ?? 0,
          searches: result.search_count,
        });
      saveResponse(db, job.job_id, {
        raw_answer: result.answer,
        api_citations_json: JSON.stringify(result.citations ?? null),
        raw_api_response_json: JSON.stringify(result.raw),
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        search_count: result.search_count,
        latency_ms: latency,
        cost_estimate: cost,
      });
      spentUsd += cost ?? 0;
      done++;
      log(
        `${tag} ok     tokens=${result.input_tokens ?? "?"}/${result.output_tokens ?? "?"} ` +
          `searches=${result.search_count} ${latency}ms $${(cost ?? 0).toFixed(4)}`,
      );
    } catch (e) {
      const status = errorStatus(e);
      const msg = redact(`${status ? `HTTP ${status}: ` : ""}${(e as Error).message ?? String(e)}`).slice(0, 1000);
      markFailed(db, job.job_id, msg);
      failed++;
      log(`${tag} FAILED ${msg.split("\n")[0].slice(0, 200)}`);
    }
  };

  // One queue per engine, worked by `max_concurrency` workers that share the engine's limiter.
  const workers: Promise<void>[] = [];
  for (const [engineId, engineJobs] of groupBy(jobs, (j) => j.engine_id)) {
    const engine = engines.get(engineId)!;
    const limiter = new Limiter(engine.max_concurrency, engine.requests_per_minute);
    const queue = [...engineJobs];
    for (let w = 0; w < engine.max_concurrency; w++) {
      workers.push(
        (async () => {
          while (queue.length && !shouldStop()) await runJob(queue.shift()!, engine, limiter);
        })(),
      );
    }
  }
  await Promise.all(workers);

  const runStatus = markRunEnded(db, runId);
  const reason = stopReason as ExecuteSummary["stopReason"]; // mutated inside closures
  if (reason === "budget") log(`■ Stopped: the budget of €${budgetEur.toFixed(2)} has been reached.`);
  if (reason === "interrupted") log("■ Stopped on request. Continue later with \"resume\".");
  return {
    selected: jobs.length,
    done,
    failed,
    notStarted: jobs.length - done - failed,
    spentThisSessionUsd: spentUsd,
    stopReason: reason,
    runStatus,
  };
}

/**
 * Keep at most `limit` jobs per engine, spread evenly over the engine's modes
 * (e.g. --limit 4 → 2 no_search + 2 web_search), keeping the randomized order.
 */
export function limitPerEngine<T extends { engine_id: string; mode: string }>(jobs: T[], limit?: number): T[] {
  if (!limit) return jobs;
  const keep = new Set<T>();
  for (const engineJobs of groupBy(jobs, (j) => j.engine_id).values()) {
    const queues = [...groupBy(engineJobs, (j) => j.mode).values()];
    let taken = 0;
    for (let round = 0; taken < limit && queues.some((q) => q.length > round); round++) {
      for (const q of queues) {
        if (taken < limit && q[round]) (keep.add(q[round]), taken++);
      }
    }
  }
  return jobs.filter((j) => keep.has(j));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}
