-- MHC AI Visibility Engine 0.1 — schema version 1.
-- Raw data is append-only: responses and analyses can never be updated or deleted.

CREATE TABLE runs (
  run_id               TEXT PRIMARY KEY,          -- the run name, e.g. "pilot-01"
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  config_hash          TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,             -- full config at plan time, for reproducibility
  repetitions          INTEGER NOT NULL,
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned', 'running', 'stopped', 'finished'))
);

CREATE TABLE jobs (
  job_id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  sequence             INTEGER NOT NULL,          -- randomized execution order
  hotel_id             TEXT NOT NULL,
  prompt_id            TEXT NOT NULL,
  prompt_type          TEXT NOT NULL CHECK (prompt_type IN ('discovery', 'brand')),
  prompt_text_rendered TEXT NOT NULL,
  engine_id            TEXT NOT NULL,
  model                TEXT NOT NULL,
  mode                 TEXT NOT NULL CHECK (mode IN ('no_search', 'web_search')),
  repetition           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  updated_at           TEXT,
  UNIQUE (run_id, hotel_id, prompt_id, engine_id, mode, repetition),
  UNIQUE (run_id, sequence)
);
CREATE INDEX idx_jobs_run_status ON jobs (run_id, status);
CREATE INDEX idx_jobs_run_engine ON jobs (run_id, engine_id);
CREATE INDEX idx_jobs_run_hotel ON jobs (run_id, hotel_id);

CREATE TABLE responses (
  response_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id                INTEGER NOT NULL REFERENCES jobs(job_id),
  raw_answer            TEXT NOT NULL,
  api_citations_json    TEXT NOT NULL,            -- citations exactly as the provider returned them
  raw_api_response_json TEXT NOT NULL,            -- full provider response
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  search_count          INTEGER,
  latency_ms            INTEGER,
  cost_estimate         REAL,                     -- USD
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_responses_job ON responses (job_id);

CREATE TABLE analyses (
  analysis_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         INTEGER NOT NULL REFERENCES jobs(job_id),
  analyzer_model TEXT NOT NULL,
  analysis_json  TEXT,
  schema_valid   INTEGER NOT NULL CHECK (schema_valid IN (0, 1)),
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_estimate  REAL,                            -- USD
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_analyses_job ON analyses (job_id, analyzer_model);

CREATE TABLE test_metrics (
  metric_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id              INTEGER NOT NULL REFERENCES jobs(job_id),
  analysis_id         INTEGER NOT NULL REFERENCES analyses(analysis_id),
  mentioned           INTEGER NOT NULL,
  recommended         INTEGER,
  position            INTEGER,
  position_confidence REAL,
  sentiment           TEXT,
  booking_channel     TEXT CHECK (booking_channel IN ('none', 'direct', 'ota', 'mixed')),
  needs_review        INTEGER NOT NULL,
  sources_json        TEXT NOT NULL,
  fact_checks_json    TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_metrics_job ON test_metrics (job_id);
CREATE INDEX idx_metrics_analysis ON test_metrics (analysis_id);

CREATE TABLE validation_labels (
  label_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(job_id),
  field       TEXT NOT NULL,
  human_value TEXT,
  annotator   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_labels_job ON validation_labels (job_id, field);

-- Append-only guarantees for raw data.
CREATE TRIGGER responses_no_update BEFORE UPDATE ON responses
BEGIN SELECT RAISE(ABORT, 'responses are append-only'); END;
CREATE TRIGGER responses_no_delete BEFORE DELETE ON responses
BEGIN SELECT RAISE(ABORT, 'responses are append-only'); END;
CREATE TRIGGER analyses_no_update BEFORE UPDATE ON analyses
BEGIN SELECT RAISE(ABORT, 'analyses are append-only'); END;
CREATE TRIGGER analyses_no_delete BEFORE DELETE ON analyses
BEGIN SELECT RAISE(ABORT, 'analyses are append-only'); END;
