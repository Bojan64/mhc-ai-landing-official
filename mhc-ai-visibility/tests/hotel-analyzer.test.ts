import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load";
import { checkBudgetBeforeRun, estimateCost } from "../src/runner/cost";
import { buildJobs } from "../src/runner/plan";
import { CONFIG_DIR, realConfig } from "./helpers";

// The hotel mode keeps reading engines.json "analyzer"; destination mode has its own analyzer in destination.json.
// This pins the hotel-mode analyzer so a change for destination mode cannot touch it unnoticed.
describe("hotel mode analyzer stays Haiku 4.5 with temperature 0", () => {
  it("engines.json analyzer is unchanged", () => {
    const { config, errors } = loadConfig(CONFIG_DIR);
    expect(errors).toEqual([]);
    expect(config!.engines.analyzer).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      temperature: 0,
      max_concurrency: 4,
      requests_per_minute: 50,
      pricing: { input_per_million: 1, output_per_million: 5, per_search: 0 },
    });
    expect(config!.engines.cost_assumptions.analyzer).toEqual({ input_tokens: 2600, output_tokens: 1000 });
  });

  it("the hotel-mode cost estimate prices its analyzer with the Haiku figures", () => {
    const c = realConfig();
    for (const e of c.engines.engines) {
      e.pricing.input_per_million ??= 1;
      e.pricing.output_per_million ??= 4;
    }
    const est = estimateCost(c, buildJobs(c, 1));
    expect(est.incomplete).toBe(false);
    expect(checkBudgetBeforeRun(est, 1000).ok).toBe(true);
    // one analysis = 2,600 input + 1,000 output tokens at $1 / $5 per million
    expect(est.analyzer.usd).toBeCloseTo(est.analyzer.calls * (2600 * 1 + 1000 * 5) / 1e6);
  });
});
