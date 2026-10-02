import type { AppConfig } from "../config/load";
import type { JobSpec } from "../runner/plan";
import type { DB } from "./db";

export interface RunRow {
  run_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  config_hash: string;
  repetitions: number;
  notes: string | null;
  status: "planned" | "running" | "stopped" | "finished";
}

const now = () => new Date().toISOString();

export function getRun(db: DB, runId: string): RunRow | undefined {
  return db
    .prepare(
      "SELECT run_id, created_at, started_at, finished_at, config_hash, repetitions, notes, status FROM runs WHERE run_id = ?",
    )
    .get(runId) as RunRow | undefined;
}

/** Number of jobs in a run that are no longer pending (i.e. work was attempted). */
export function countStartedJobs(db: DB, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ? AND (status != 'pending' OR attempts > 0)")
    .get(runId) as { n: number };
  return row.n;
}

/**
 * Create a run with its jobs. If the run exists but no job has been attempted yet,
 * its job list is rebuilt (so config edits before the first call are picked up).
 * Once any job was attempted, the run is frozen and must be continued with "resume".
 */
export function savePlannedRun(
  db: DB,
  runId: string,
  config: AppConfig,
  repetitions: number,
  jobs: JobSpec[],
  notes?: string,
): { replanned: boolean } {
  const existing = getRun(db, runId);
  if (existing && countStartedJobs(db, runId) > 0) {
    throw new Error(`Run "${runId}" has already started. Use "resume", or choose a new --run-name.`);
  }
  const { hash, ...snapshot } = config;

  db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM jobs WHERE run_id = ?").run(runId);
      db.prepare(
        "UPDATE runs SET config_hash = ?, config_snapshot_json = ?, repetitions = ?, notes = COALESCE(?, notes) WHERE run_id = ?",
      ).run(hash, JSON.stringify(snapshot), repetitions, notes ?? null, runId);
    } else {
      db.prepare(
        "INSERT INTO runs (run_id, created_at, config_hash, config_snapshot_json, repetitions, notes) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(runId, now(), hash, JSON.stringify(snapshot), repetitions, notes ?? null);
    }
    const insert = db.prepare(
      `INSERT INTO jobs (run_id, sequence, hotel_id, prompt_id, prompt_type, prompt_text_rendered,
                         engine_id, model, mode, repetition)
       VALUES (@run_id, @sequence, @hotel_id, @prompt_id, @prompt_type, @prompt_text_rendered,
               @engine_id, @model, @mode, @repetition)`,
    );
    jobs.forEach((j, i) => insert.run({ ...j, run_id: runId, sequence: i + 1 }));
  })();

  return { replanned: Boolean(existing) };
}

export function jobStatusCounts(db: DB, runId: string): Record<string, number> {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE run_id = ? GROUP BY status")
    .all(runId) as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export interface JobRow {
  job_id: number;
  run_id: string;
  sequence: number;
  hotel_id: string;
  prompt_id: string;
  prompt_type: "discovery" | "brand";
  prompt_text_rendered: string;
  engine_id: string;
  model: string;
  mode: "no_search" | "web_search";
  repetition: number;
  status: "pending" | "done" | "failed" | "skipped";
  attempts: number;
  error: string | null;
}

export interface JobFilter {
  engine?: string;
  hotel?: string;
  statuses: JobRow["status"][];
}

/** Jobs of a run in execution order (randomized sequence). */
export function selectJobs(db: DB, runId: string, f: JobFilter): JobRow[] {
  const where = ["run_id = ?", `status IN (${f.statuses.map(() => "?").join(", ")})`];
  const args: unknown[] = [runId, ...f.statuses];
  if (f.engine) (where.push("engine_id = ?"), args.push(f.engine));
  if (f.hotel) (where.push("hotel_id = ?"), args.push(f.hotel));
  return db.prepare(`SELECT * FROM jobs WHERE ${where.join(" AND ")} ORDER BY sequence`).all(...args) as JobRow[];
}

export function recordAttempt(db: DB, jobId: number): void {
  db.prepare("UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE job_id = ?").run(now(), jobId);
}

export interface ResponseInput {
  raw_answer: string;
  api_citations_json: string;
  raw_api_response_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  search_count: number;
  latency_ms: number;
  cost_estimate: number | null;
}

/** Store a response and mark the job done, atomically (a crash never half-saves a job). */
export function saveResponse(db: DB, jobId: number, r: ResponseInput): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO responses (job_id, raw_answer, api_citations_json, raw_api_response_json, input_tokens,
                              output_tokens, search_count, latency_ms, cost_estimate, created_at)
       VALUES (@job_id, @raw_answer, @api_citations_json, @raw_api_response_json, @input_tokens,
               @output_tokens, @search_count, @latency_ms, @cost_estimate, @created_at)`,
    ).run({ ...r, job_id: jobId, created_at: now() });
    db.prepare("UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE job_id = ?").run(now(), jobId);
  })();
}

export function markFailed(db: DB, jobId: number, error: string): void {
  db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?").run(error, now(), jobId);
}

/** Total tracked cost of a run so far (tested engines + analyzer), in USD. */
export function runSpentUsd(db: DB, runId: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(r.cost_estimate) FROM responses r JOIN jobs j USING (job_id) WHERE j.run_id = ?), 0) +
         COALESCE((SELECT SUM(a.cost_estimate) FROM analyses a JOIN jobs j USING (job_id) WHERE j.run_id = ?), 0) AS usd`,
    )
    .get(runId, runId) as { usd: number };
  return row.usd;
}

export function markRunStarted(db: DB, runId: string): void {
  db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE run_id = ?").run(now(), runId);
}

export function markRunEnded(db: DB, runId: string): RunRow["status"] {
  const pending = (
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ? AND status = 'pending'").get(runId) as { n: number }
  ).n;
  const status = pending === 0 ? "finished" : "stopped";
  db.prepare("UPDATE runs SET status = ?, finished_at = CASE WHEN ? = 'finished' THEN ? ELSE finished_at END WHERE run_id = ?")
    .run(status, status, now(), runId);
  return status;
}

export interface StoredResponse {
  job: JobRow;
  raw_answer: string;
  api_citations_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  search_count: number | null;
  latency_ms: number | null;
  cost_estimate: number | null;
}

/** Latest response per job for a run. */
export function selectResponses(db: DB, runId: string, f: Partial<JobFilter> = {}): StoredResponse[] {
  const where = ["j.run_id = ?"];
  const args: unknown[] = [runId];
  if (f.engine) (where.push("j.engine_id = ?"), args.push(f.engine));
  if (f.hotel) (where.push("j.hotel_id = ?"), args.push(f.hotel));
  const rows = db
    .prepare(
      `SELECT j.*, r.raw_answer, r.api_citations_json, r.input_tokens, r.output_tokens, r.search_count,
              r.latency_ms, r.cost_estimate
       FROM jobs j JOIN responses r ON r.response_id = (SELECT MAX(response_id) FROM responses WHERE job_id = j.job_id)
       WHERE ${where.join(" AND ")} ORDER BY j.engine_id, j.sequence`,
    )
    .all(...args) as (JobRow & Omit<StoredResponse, "job">)[];
  return rows.map(({ raw_answer, api_citations_json, input_tokens, output_tokens, search_count, latency_ms, cost_estimate, ...job }) => ({
    job, raw_answer, api_citations_json, input_tokens, output_tokens, search_count, latency_ms, cost_estimate,
  }));
}
