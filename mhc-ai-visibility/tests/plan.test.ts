import { describe, expect, it } from "vitest";
import { buildJobs, shuffle } from "../src/runner/plan";
import { realConfig } from "./helpers";

describe("job planning", () => {
  it("builds hotel×prompt × engine×mode × repetitions", () => {
    const c = realConfig();
    // HT1: 17 prompts, HT2: 11 prompts; modes: 3 engines × 2 + perplexity × 1 = 7
    expect(buildJobs(c, 3)).toHaveLength((17 + 11) * 7 * 3);
    expect(buildJobs(c, 1)).toHaveLength((17 + 11) * 7);
  });

  it("skips disabled engines and modes an engine does not have", () => {
    const c = realConfig();
    c.engines.engines.find((e) => e.engine_id === "openai")!.enabled = false;
    const jobs = buildJobs(c, 1);
    expect(jobs.some((j) => j.engine_id === "openai")).toBe(false);
    expect(jobs.some((j) => j.engine_id === "perplexity" && j.mode === "no_search")).toBe(false);
  });

  it("every job is unique", () => {
    const jobs = buildJobs(realConfig(), 3);
    const keys = new Set(jobs.map((j) => [j.hotel_id, j.prompt_id, j.engine_id, j.mode, j.repetition].join("|")));
    expect(keys.size).toBe(jobs.length);
  });

  it("randomizes the order", () => {
    const c = realConfig();
    const a = buildJobs(c, 3).map((j) => j.engine_id).join();
    const b = buildJobs(c, 3).map((j) => j.engine_id).join();
    expect(a).not.toBe(b);
  });

  it("shuffle keeps all items", () => {
    const items = [1, 2, 3, 4, 5];
    expect(shuffle(items, () => 0).sort()).toEqual(items);
  });
});
