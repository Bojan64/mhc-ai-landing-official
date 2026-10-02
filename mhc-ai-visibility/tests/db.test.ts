import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { getRun, jobStatusCounts, savePlannedRun } from "../src/db/repository";
import { buildJobs } from "../src/runner/plan";
import { realConfig } from "./helpers";

function setup() {
  const db = openDb(":memory:");
  const c = realConfig();
  const jobs = buildJobs(c, 1);
  savePlannedRun(db, "t1", c, 1, jobs);
  return { db, c, jobs };
}

describe("database", () => {
  it("saves a planned run with all jobs pending", () => {
    const { db, jobs } = setup();
    expect(getRun(db, "t1")?.status).toBe("planned");
    expect(jobStatusCounts(db, "t1")).toEqual({ pending: jobs.length });
  });

  it("re-planning replaces jobs while nothing has started", () => {
    const { db, c } = setup();
    const { replanned } = savePlannedRun(db, "t1", c, 2, buildJobs(c, 2));
    expect(replanned).toBe(true);
    expect(getRun(db, "t1")?.repetitions).toBe(2);
  });

  it("refuses to re-plan a run that has started", () => {
    const { db, c } = setup();
    db.prepare("UPDATE jobs SET attempts = 1 WHERE sequence = 1").run();
    expect(() => savePlannedRun(db, "t1", c, 1, buildJobs(c, 1))).toThrow(/already started/);
  });

  it("responses can never be updated or deleted", () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO responses (job_id, raw_answer, api_citations_json, raw_api_response_json, created_at)
       VALUES (1, 'answer', '[]', '{}', 'now')`,
    ).run();
    expect(() => db.prepare("UPDATE responses SET raw_answer = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM responses").run()).toThrow(/append-only/);
  });

  it("does not delete jobs that already have responses", () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO responses (job_id, raw_answer, api_citations_json, raw_api_response_json, created_at)
       VALUES (1, 'a', '[]', '{}', 'now')`,
    ).run();
    expect(() => db.prepare("DELETE FROM jobs WHERE job_id = 1").run()).toThrow(/FOREIGN KEY/);
  });
});
