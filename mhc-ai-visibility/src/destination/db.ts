import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DestDB = Database.Database;

// Destination mode keeps its own database file, so the hotel-mode schema and data are never touched.
// Raw data is append-only (answers and analyses can never be updated or deleted).
const SCHEMA = `
CREATE TABLE dest_runs (
  run_id               TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  config_hash          TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  destination_id       TEXT NOT NULL,
  destination_name     TEXT NOT NULL,
  repetitions          INTEGER NOT NULL,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'stopped', 'finished'))
);

CREATE TABLE dest_jobs (
  job_id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES dest_runs(run_id),
  sequence             INTEGER NOT NULL,
  question_id          TEXT NOT NULL,
  segment              TEXT NOT NULL,
  prompt_text_rendered TEXT NOT NULL,
  engine_id            TEXT NOT NULL,
  model                TEXT NOT NULL,
  repetition           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  updated_at           TEXT,
  UNIQUE (run_id, question_id, engine_id, repetition),
  UNIQUE (run_id, sequence)
);
CREATE INDEX idx_dest_jobs_run_status ON dest_jobs (run_id, status);

CREATE TABLE dest_responses (
  response_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id                INTEGER NOT NULL REFERENCES dest_jobs(job_id),
  raw_answer            TEXT NOT NULL,
  api_citations_json    TEXT NOT NULL,
  raw_api_response_json TEXT NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  search_count          INTEGER,
  latency_ms            INTEGER,
  cost_estimate         REAL,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_dest_responses_job ON dest_responses (job_id);

CREATE TABLE dest_analyses (
  analysis_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES dest_jobs(job_id),
  analyzer_model TEXT NOT NULL,
  analysis_json  TEXT,
  raw_output     TEXT,
  schema_valid   INTEGER NOT NULL CHECK (schema_valid IN (0, 1)),
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_estimate  REAL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_dest_analyses_job ON dest_analyses (job_id);

CREATE TRIGGER dest_responses_no_update BEFORE UPDATE ON dest_responses BEGIN SELECT RAISE(ABORT, 'responses are append-only'); END;
CREATE TRIGGER dest_responses_no_delete BEFORE DELETE ON dest_responses BEGIN SELECT RAISE(ABORT, 'responses are append-only'); END;
CREATE TRIGGER dest_analyses_no_update BEFORE UPDATE ON dest_analyses BEGIN SELECT RAISE(ABORT, 'analyses are append-only'); END;
CREATE TRIGGER dest_analyses_no_delete BEFORE DELETE ON dest_analyses BEGIN SELECT RAISE(ABORT, 'analyses are append-only'); END;
`;

const MIGRATIONS = [SCHEMA];

export function openDestDb(path: string): DestDB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

const now = () => new Date().toISOString();

export interface DestRunRow {
  run_id: string; created_at: string; started_at: string | null; finished_at: string | null;
  config_hash: string; config_snapshot_json: string; destination_id: string; destination_name: string;
  repetitions: number; notes: string | null; status: "planned" | "running" | "stopped" | "finished";
}

export interface DestJobRow {
  job_id: number; run_id: string; sequence: number; question_id: string; segment: string;
  prompt_text_rendered: string; engine_id: string; model: string; repetition: number;
  status: "pending" | "done" | "failed"; attempts: number; error: string | null; updated_at: string | null;
}

export interface NewDestJob {
  question_id: string; segment: string; prompt_text_rendered: string;
  engine_id: string; model: string; repetition: number;
}

export function getDestRun(db: DestDB, runId: string): DestRunRow | undefined {
  return db.prepare("SELECT * FROM dest_runs WHERE run_id = ?").get(runId) as DestRunRow | undefined;
}

/** Save a new planned run. An existing run that has not started yet is replaced; a started run is never touched. */
export function savePlannedDestRun(
  db: DestDB,
  runId: string,
  meta: { config_hash: string; config_snapshot_json: string; destination_id: string; destination_name: string; repetitions: number; notes?: string },
  jobs: NewDestJob[],
): { replanned: boolean } {
  const existing = getDestRun(db, runId);
  if (existing && existing.status !== "planned")
    throw new Error(`Run "${runId}" has already started and cannot be re-planned. Use a new --run-name.`);
  db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM dest_jobs WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM dest_runs WHERE run_id = ?").run(runId);
    }
    db.prepare(
      `INSERT INTO dest_runs (run_id, created_at, config_hash, config_snapshot_json, destination_id, destination_name, repetitions, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, now(), meta.config_hash, meta.config_snapshot_json, meta.destination_id, meta.destination_name, meta.repetitions, meta.notes ?? null);
    const ins = db.prepare(
      `INSERT INTO dest_jobs (run_id, sequence, question_id, segment, prompt_text_rendered, engine_id, model, repetition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    jobs.forEach((j, i) => ins.run(runId, i + 1, j.question_id, j.segment, j.prompt_text_rendered, j.engine_id, j.model, j.repetition));
  })();
  return { replanned: !!existing };
}

export function selectDestJobs(db: DestDB, runId: string, f: { engines?: string[]; statuses: DestJobRow["status"][] }): DestJobRow[] {
  const where = ["run_id = ?", `status IN (${f.statuses.map(() => "?").join(", ")})`];
  const args: unknown[] = [runId, ...f.statuses];
  if (f.engines?.length) (where.push(`engine_id IN (${f.engines.map(() => "?").join(", ")})`), args.push(...f.engines));
  return db.prepare(`SELECT * FROM dest_jobs WHERE ${where.join(" AND ")} ORDER BY sequence`).all(...args) as DestJobRow[];
}

export function destJobCounts(db: DestDB, runId: string): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM dest_jobs WHERE run_id = ? GROUP BY status").all(runId) as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function recordDestAttempt(db: DestDB, jobId: number): void {
  db.prepare("UPDATE dest_jobs SET attempts = attempts + 1, updated_at = ? WHERE job_id = ?").run(now(), jobId);
}

export interface DestResponseInput {
  raw_answer: string; api_citations_json: string; raw_api_response_json: string;
  input_tokens: number | null; output_tokens: number | null; search_count: number;
  latency_ms: number; cost_estimate: number | null;
}

export function saveDestResponse(db: DestDB, jobId: number, r: DestResponseInput): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dest_responses (job_id, raw_answer, api_citations_json, raw_api_response_json, input_tokens,
                                   output_tokens, search_count, latency_ms, cost_estimate, created_at)
       VALUES (@job_id, @raw_answer, @api_citations_json, @raw_api_response_json, @input_tokens,
               @output_tokens, @search_count, @latency_ms, @cost_estimate, @created_at)`,
    ).run({ ...r, job_id: jobId, created_at: now() });
    db.prepare("UPDATE dest_jobs SET status = 'done', error = NULL, updated_at = ? WHERE job_id = ?").run(now(), jobId);
  })();
}

export function markDestFailed(db: DestDB, jobId: number, error: string): void {
  db.prepare("UPDATE dest_jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?").run(error, now(), jobId);
}

export function markDestRunStarted(db: DestDB, runId: string): void {
  db.prepare("UPDATE dest_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE run_id = ?").run(now(), runId);
}

export function markDestRunEnded(db: DestDB, runId: string): DestRunRow["status"] {
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM dest_jobs WHERE run_id = ? AND status = 'pending'").get(runId) as { n: number }).n;
  const unanalyzed = (
    db.prepare(
      `SELECT COUNT(*) AS n FROM dest_jobs j WHERE j.run_id = ? AND j.status = 'done'
         AND NOT EXISTS (SELECT 1 FROM dest_analyses a WHERE a.job_id = j.job_id AND a.schema_valid = 1)`,
    ).get(runId) as { n: number }
  ).n;
  const status = pending === 0 && unanalyzed === 0 ? "finished" : "stopped";
  db.prepare("UPDATE dest_runs SET status = ?, finished_at = CASE WHEN ? = 'finished' THEN ? ELSE finished_at END WHERE run_id = ?").run(status, status, now(), runId);
  return status;
}

/** Done jobs that still have no valid analysis. */
export function selectUnanalyzed(db: DestDB, runId: string, engines?: string[]): (DestJobRow & { raw_answer: string; api_citations_json: string })[] {
  const eng = engines?.length ? ` AND j.engine_id IN (${engines.map(() => "?").join(", ")})` : "";
  return db.prepare(
    `SELECT j.*, r.raw_answer, r.api_citations_json
       FROM dest_jobs j JOIN dest_responses r ON r.response_id = (SELECT MAX(response_id) FROM dest_responses WHERE job_id = j.job_id)
      WHERE j.run_id = ? AND j.status = 'done'${eng}
        AND NOT EXISTS (SELECT 1 FROM dest_analyses a WHERE a.job_id = j.job_id AND a.schema_valid = 1)
      ORDER BY j.sequence`,
  ).all(runId, ...(engines ?? [])) as (DestJobRow & { raw_answer: string; api_citations_json: string })[];
}

export interface DestAnalysisInput {
  analyzer_model: string; analysis_json: string | null; raw_output: string | null; schema_valid: boolean;
  error: string | null; input_tokens: number | null; output_tokens: number | null; cost_estimate: number | null;
}

export function saveDestAnalysis(db: DestDB, jobId: number, a: DestAnalysisInput): void {
  db.prepare(
    `INSERT INTO dest_analyses (job_id, analyzer_model, analysis_json, raw_output, schema_valid, error, input_tokens, output_tokens, cost_estimate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId, a.analyzer_model, a.analysis_json, a.raw_output, a.schema_valid ? 1 : 0, a.error, a.input_tokens, a.output_tokens, a.cost_estimate, now());
}

/** Tracked spend of a run (answers + analyses) in USD. */
export function destSpentUsd(db: DestDB, runId: string): number {
  const row = db.prepare(
    `SELECT COALESCE((SELECT SUM(r.cost_estimate) FROM dest_responses r JOIN dest_jobs j USING (job_id) WHERE j.run_id = ?), 0) +
            COALESCE((SELECT SUM(a.cost_estimate) FROM dest_analyses a JOIN dest_jobs j USING (job_id) WHERE j.run_id = ?), 0) AS usd`,
  ).get(runId, runId) as { usd: number };
  return row.usd;
}

export interface DestAnswerRow {
  job: DestJobRow;
  response_id: number;
  raw_answer: string;
  api_citations_json: string;
  created_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  search_count: number | null;
  cost_estimate: number | null;
  /** Latest valid analysis, if any. */
  analysis_json: string | null;
  analysis_cost: number | null;
}

/** Latest answer of every done job with its latest valid analysis. */
export function selectDestAnswers(db: DestDB, runId: string): DestAnswerRow[] {
  const rows = db.prepare(
    `SELECT j.*, r.response_id, r.raw_answer, r.api_citations_json, r.created_at AS answered_at,
            r.input_tokens AS r_in, r.output_tokens AS r_out, r.search_count AS r_search, r.cost_estimate AS r_cost,
            (SELECT analysis_json FROM dest_analyses a WHERE a.job_id = j.job_id AND a.schema_valid = 1 ORDER BY analysis_id DESC LIMIT 1) AS analysis_json,
            (SELECT SUM(cost_estimate) FROM dest_analyses a WHERE a.job_id = j.job_id) AS analysis_cost
       FROM dest_jobs j JOIN dest_responses r ON r.response_id = (SELECT MAX(response_id) FROM dest_responses WHERE job_id = j.job_id)
      WHERE j.run_id = ? ORDER BY j.engine_id, j.question_id, j.repetition`,
  ).all(runId) as any[];
  return rows.map((x) => ({
    job: {
      job_id: x.job_id, run_id: x.run_id, sequence: x.sequence, question_id: x.question_id, segment: x.segment,
      prompt_text_rendered: x.prompt_text_rendered, engine_id: x.engine_id, model: x.model, repetition: x.repetition,
      status: x.status, attempts: x.attempts, error: x.error, updated_at: x.updated_at,
    },
    response_id: x.response_id, raw_answer: x.raw_answer, api_citations_json: x.api_citations_json, created_at: x.answered_at,
    input_tokens: x.r_in, output_tokens: x.r_out, search_count: x.r_search, cost_estimate: x.r_cost,
    analysis_json: x.analysis_json, analysis_cost: x.analysis_cost,
  }));
}
