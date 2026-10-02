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
