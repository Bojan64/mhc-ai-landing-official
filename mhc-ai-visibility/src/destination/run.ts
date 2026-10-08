import type { Engine } from "../config/schemas";
import { createAdapter, type AdapterFactory } from "../engines";
import type { EngineAdapter } from "../engines/types";
import { Limiter } from "../runner/limiter";
import { DEFAULT_RETRY, errorStatus, withRetry, type RetryOptions } from "../runner/retry";
import { redact } from "../util/redact";
import { createAnthropicAnalyzer, type AnalyzeFn } from "./analyzer";
import type { DestinationConfig } from "./config";
import {
  destSpentUsd, getDestRun, markDestFailed, markDestRunEnded, markDestRunStarted, recordDestAttempt,
  saveDestAnalysis, saveDestResponse, selectDestJobs, selectUnanalyzed, type DestDB, type DestJobRow,
} from "./db";
import { callCost, checkDestinationBudget, estimateDestinationCost } from "./plan";
import { type Destination } from "./schemas";

export class DestRunRefused extends Error {}

export interface DestRunOptions {
  /** Only these engines (e.g. leave Gemini out when its key does not work). */
  engines?: string[];
  retryFailed?: boolean;
  /** At most this many answer jobs per engine (smoke tests). */
  limitPerEngine?: number;
  budgetEur: number | null;
  /** An engine is declared unavailable after this many failed jobs in a row (and its remaining jobs are left pending). */
  breakerAfter?: number;
  log?: (line: string) => void;
  adapterFactory?: AdapterFactory;
  analyzerFactory?: (cfg: DestinationConfig) => AnalyzeFn;
  retry?: Partial<RetryOptions>;
  shouldStop?: () => boolean;
  now?: () => number;
}

export interface EngineOutcome {
  engine_id: string;
  planned: number;
  done: number;
  failed: number;
  notStarted: number;
  unavailable: boolean;
  lastError: string | null;
}

export interface DestRunSummary {
  engines: EngineOutcome[];
  analyzed: number;
  analysisFailed: number;
  spentThisSessionUsd: number;
  spentTotalUsd: number;
  stopReason: "completed" | "budget" | "interrupted";
  runStatus: string;
}

export async function executeDestinationRun(
  db: DestDB, cfg: DestinationConfig, runId: string, dest: Destination, o: DestRunOptions,
): Promise<DestRunSummary> {
  const log = o.log ?? console.log;
  const now = o.now ?? Date.now;
  const run = getDestRun(db, runId);
  if (!run) throw new DestRunRefused(`Run "${runId}" does not exist. Create it first with: destination-plan --run-name "${runId}"`);
  if (run.status === "finished" && !o.retryFailed) log("This run is already finished. Nothing new will be asked unless failed jobs are retried.");
  if (run.config_hash !== cfg.hash) log("⚠ The config files changed since this run was planned (fine for prices; questions and models stay as planned).");

  const engines = new Map(cfg.engines.engines.map((e) => [e.engine_id, e]));
  for (const id of o.engines ?? []) if (!engines.has(id)) throw new DestRunRefused(`Unknown engine "${id}".`);

  const statuses: DestJobRow["status"][] = o.retryFailed ? ["pending", "failed"] : ["pending"];
  const jobs = limitJobs(selectDestJobs(db, runId, { engines: o.engines, statuses }), o.limitPerEngine);

  for (const j of jobs) {
    const e = engines.get(j.engine_id);
    if (!e || !e.enabled) throw new DestRunRefused(`Engine "${j.engine_id}" is no longer enabled in engines.json.`);
    if (e.model !== j.model)
      throw new DestRunRefused(`Engine "${j.engine_id}" now uses model "${e.model}", but this run was planned with "${j.model}". Plan a new run to test another model.`);
  }

  // Budget gate before any call: cost of this session's jobs + their analysis, plus what the run has already cost.
  const rate = cfg.engines.usd_to_eur;
  const spentBeforeUsd = destSpentUsd(db, runId);
  const unanalyzedBefore = selectUnanalyzed(db, runId, o.engines).length;
  const est = estimateDestinationCost(cfg, jobs);
  // the analyzer line of `est` covers the jobs about to run; add analyses still owed from earlier sessions
  const extraAnalyses = unanalyzedBefore * (est.perCallUsd.analyzer ?? 0);
  const estWithExtra = { ...est, knownUsd: est.knownUsd + extraAnalyses, knownEur: (est.knownUsd + extraAnalyses) * rate };
  const check = checkDestinationBudget(estWithExtra, o.budgetEur, spentBeforeUsd * rate);
  if (!check.ok) throw new DestRunRefused(`Run refused:\n  - ${check.reasons.join("\n  - ")}`);
  const budgetEur = o.budgetEur as number;

  // Adapters and analyzer first, so a missing key stops us before any call.
  const factory = o.adapterFactory ?? createAdapter;
  const adapters = new Map<string, EngineAdapter>();
  for (const id of new Set(jobs.map((j) => j.engine_id))) adapters.set(id, factory(engines.get(id)!, cfg.engines));
  const analyze = (o.analyzerFactory ?? ((c) => createAnthropicAnalyzer(c.engines, c.sourceDomains)))(cfg);

  log(
    `Starting ${jobs.length} answer job(s) for run "${runId}" (${dest.name}). Estimated cost €${estWithExtra.knownEur.toFixed(2)}; ` +
      `already spent on this run €${(spentBeforeUsd * rate).toFixed(2)}; hard budget €${budgetEur.toFixed(2)}.`,
  );
  markDestRunStarted(db, runId);

  const retry: RetryOptions = { ...DEFAULT_RETRY, ...o.retry };
  const breakerAfter = o.breakerAfter ?? 3;
  let spentUsd = 0;
  let reservedUsd = 0; // estimated cost of calls in flight
  let stopReason: DestRunSummary["stopReason"] = "completed";
  const outcome = new Map<string, EngineOutcome>();
  for (const id of new Set(jobs.map((j) => j.engine_id)))
    outcome.set(id, { engine_id: id, planned: jobs.filter((j) => j.engine_id === id).length, done: 0, failed: 0, notStarted: 0, unavailable: false, lastError: null });
  const consecutiveFails = new Map<string, number>();
  // Largest real cost seen per engine: if calls turn out dearer than estimated, the reserve before the next call grows with them.
  const observedMax = new Map<string, number>();
  const reserveFor = (engineId: string) => Math.max(est.perCallUsd[engineId] ?? 0, observedMax.get(engineId) ?? 0);

  const overBudget = (nextCallUsd: number) => (spentBeforeUsd + spentUsd + reservedUsd + nextCallUsd) * rate > budgetEur;
  const shouldStop = (nextCallUsd = 0) => {
    if (stopReason !== "completed") return true;
    if (overBudget(nextCallUsd)) stopReason = "budget";
    else if (o.shouldStop?.()) stopReason = "interrupted";
    return stopReason !== "completed";
  };

  const runJob = async (job: DestJobRow, engine: Engine, limiter: Limiter) => {
    const out = outcome.get(job.engine_id)!;
    const adapter = adapters.get(job.engine_id)!;
    const tag = `${job.engine_id.padEnd(10)} ${job.question_id} rep${job.repetition}`;
    const reserve = reserveFor(job.engine_id);
    reservedUsd += reserve;
    let latency = 0;
    try {
      const result = await withRetry(
        () => limiter.run(async () => {
          const t0 = now();
          try { return await adapter.call({ prompt: job.prompt_text_rendered, mode: "web_search" }); }
          finally { latency = now() - t0; }
        }),
        { ...retry, onAttempt: () => recordDestAttempt(db, job.job_id) },
      );
      const cost = result.provider_cost_usd ??
        callCost(engine.pricing, { input_tokens: result.input_tokens ?? 0, output_tokens: result.output_tokens ?? 0, searches: result.search_count }).totalUsd;
      saveDestResponse(db, job.job_id, {
        raw_answer: result.answer,
        api_citations_json: JSON.stringify(result.citations ?? null),
        raw_api_response_json: JSON.stringify(result.raw),
        input_tokens: result.input_tokens, output_tokens: result.output_tokens, search_count: result.search_count,
        latency_ms: latency, cost_estimate: cost,
      });
      spentUsd += cost ?? 0;
      observedMax.set(job.engine_id, Math.max(observedMax.get(job.engine_id) ?? 0, cost ?? 0));
      out.done++;
      consecutiveFails.set(job.engine_id, 0);
      log(`${tag} ok     tokens=${result.input_tokens ?? "?"}/${result.output_tokens ?? "?"} searches=${result.search_count} ${latency}ms $${(cost ?? 0).toFixed(4)}`);
    } catch (e) {
      const status = errorStatus(e);
      const msg = redact(`${status ? `HTTP ${status}: ` : ""}${(e as Error).message ?? String(e)}`).slice(0, 1000);
      markDestFailed(db, job.job_id, msg);
      out.failed++;
      out.lastError = msg.split("\n")[0].slice(0, 200);
      const n = (consecutiveFails.get(job.engine_id) ?? 0) + 1;
      consecutiveFails.set(job.engine_id, n);
      if (n >= breakerAfter && !out.unavailable) {
        out.unavailable = true;
        log(`■ ${job.engine_id}: ${n} failed jobs in a row — marked UNAVAILABLE, its remaining jobs are skipped. (${out.lastError})`);
      }
      log(`${tag} FAILED ${out.lastError}`);
    } finally {
      reservedUsd -= reserve;
    }
  };

  // Step 1: answers. One queue per engine, `max_concurrency` workers sharing the engine's limiter.
  const workers: Promise<void>[] = [];
  const byEngine = new Map<string, DestJobRow[]>();
  for (const j of jobs) byEngine.set(j.engine_id, [...(byEngine.get(j.engine_id) ?? []), j]);
  for (const [engineId, engineJobs] of byEngine) {
    const engine = engines.get(engineId)!;
    const limiter = new Limiter(engine.max_concurrency, engine.requests_per_minute);
    const queue = [...engineJobs];
    for (let w = 0; w < engine.max_concurrency; w++) {
      workers.push((async () => {
        while (queue.length && !outcome.get(engineId)!.unavailable && !shouldStop(reserveFor(engineId))) await runJob(queue.shift()!, engine, limiter);
      })());
    }
  }
  await Promise.all(workers);
  for (const [engineId, engineJobs] of byEngine) {
    const out = outcome.get(engineId)!;
    out.notStarted = engineJobs.length - out.done - out.failed;
  }

  // Step 2: analysis of every answer that has no valid analysis yet.
  const toAnalyze = selectUnanalyzed(db, runId, o.engines);
  const analyzerRetry: RetryOptions = { ...retry, onAttempt: undefined };
  const aLimiter = new Limiter(cfg.engines.analyzer.max_concurrency, cfg.engines.analyzer.requests_per_minute);
  const aQueue = [...toAnalyze];
  let analyzed = 0;
  let analysisFailed = 0;
  const perAnalysis = est.perCallUsd.analyzer ?? 0;
  const aWorkers = Array.from({ length: cfg.engines.analyzer.max_concurrency }, async () => {
    while (aQueue.length && !shouldStop(perAnalysis)) {
      const job = aQueue.shift()!;
      reservedUsd += perAnalysis;
      try {
        const question = job.prompt_text_rendered;
        const out = await withRetry(() => aLimiter.run(() => analyze({ question, answer: job.raw_answer, destination: dest })), analyzerRetry);
        saveDestAnalysis(db, job.job_id, {
          analyzer_model: cfg.engines.analyzer.model,
          analysis_json: out.analysis ? JSON.stringify(out.analysis) : null,
          raw_output: out.raw_output, schema_valid: out.analysis !== null, error: out.error,
          input_tokens: out.input_tokens, output_tokens: out.output_tokens, cost_estimate: out.cost_usd,
        });
        spentUsd += out.cost_usd ?? 0;
        if (out.analysis) { analyzed++; log(`analyzer  ${job.engine_id} ${job.question_id} rep${job.repetition} ok (${out.analysis.hotels.length} hotels)`); }
        else { analysisFailed++; log(`analyzer  ${job.engine_id} ${job.question_id} rep${job.repetition} INVALID: ${out.error}`); }
      } catch (e) {
        analysisFailed++;
        log(`analyzer  ${job.engine_id} ${job.question_id} rep${job.repetition} FAILED ${redact((e as Error).message).split("\n")[0].slice(0, 200)}`);
      } finally {
        reservedUsd -= perAnalysis;
      }
    }
  });
  await Promise.all(aWorkers);

  const runStatus = markDestRunEnded(db, runId);
  const reason = stopReason as DestRunSummary["stopReason"]; // mutated inside closures
  if (reason === "budget") log(`■ Stopped: the next call would exceed the hard budget of €${budgetEur.toFixed(2)}.`);
  if (reason === "interrupted") log("■ Stopped on request. Continue later with \"destination-run\" again.");
  return {
    engines: [...outcome.values()], analyzed, analysisFailed,
    spentThisSessionUsd: spentUsd, spentTotalUsd: spentBeforeUsd + spentUsd, stopReason: reason, runStatus,
  };
}

/** At most `limit` jobs per engine, keeping the randomized order. */
export function limitJobs<T extends { engine_id: string }>(jobs: T[], limit?: number): T[] {
  if (!limit) return jobs;
  const taken = new Map<string, number>();
  return jobs.filter((j) => {
    const n = taken.get(j.engine_id) ?? 0;
    if (n >= limit) return false;
    taken.set(j.engine_id, n + 1);
    return true;
  });
}
