import { describe, expect, it } from "vitest";
import { budgetReached, callCostUsd, checkBudgetBeforeRun, estimateCost } from "../src/runner/cost";
import { buildJobs } from "../src/runner/plan";
import { realConfig } from "./helpers";

const fullPrices = () => {
  const c = realConfig();
  for (const e of c.engines.engines) {
    e.pricing.input_per_million ??= 1;
    e.pricing.output_per_million ??= 4;
  }
  return c;
};

describe("cost estimate and budget cap", () => {
  it("prices one call: tokens per million plus searches", () => {
    const p = { input_per_million: 2, output_per_million: 10, per_search: 0.01 };
    expect(callCostUsd(p, { input_tokens: 1_000_000, output_tokens: 100_000, searches: 3 })).toBeCloseTo(2 + 1 + 0.03);
  });

  it("returns null when a needed price is missing", () => {
    expect(callCostUsd({ input_per_million: null, output_per_million: 1, per_search: 0 },
      { input_tokens: 1, output_tokens: 1, searches: 0 })).toBeNull();
    expect(callCostUsd({ input_per_million: 1, output_per_million: 1, per_search: null },
      { input_tokens: 1, output_tokens: 1, searches: 1 })).toBeNull();
  });

  it("marks the estimate incomplete while prices are missing, and refuses to run", () => {
    const c = realConfig();
    const est = estimateCost(c, buildJobs(c, 1));
    expect(est.incomplete).toBe(true);
    expect(checkBudgetBeforeRun(est, 1000).ok).toBe(false);
  });

  it("allows a run within budget and refuses one above it", () => {
    const c = fullPrices();
    const est = estimateCost(c, buildJobs(c, 3));
    expect(est.incomplete).toBe(false);
    expect(est.knownEur).toBeCloseTo(est.knownUsd * c.engines.usd_to_eur);
    expect(checkBudgetBeforeRun(est, est.knownEur + 1).ok).toBe(true);
    const over = checkBudgetBeforeRun(est, est.knownEur / 2);
    expect(over.ok).toBe(false);
    expect(over.reasons.join()).toContain("exceeds BUDGET_EUR");
  });

  it("refuses to run without a budget", () => {
    const c = fullPrices();
    expect(checkBudgetBeforeRun(estimateCost(c, buildJobs(c, 1)), null).reasons.join()).toContain("BUDGET_EUR is not set");
  });

  it("uses per-engine cost assumptions (Perplexity: 1 search per call)", () => {
    const c = fullPrices();
    const jobs = buildJobs(c, 1).filter((j) => j.engine_id === "perplexity");
    const est = estimateCost(c, jobs);
    const p = c.engines.engines.find((e) => e.engine_id === "perplexity")!.pricing;
    const one = (60 * p.input_per_million! + 900 * p.output_per_million!) / 1e6 + p.per_search!;
    expect(est.perEngine[0].usd).toBeCloseTo(one * jobs.length);
  });

  it("stops once actual spend reaches the budget", () => {
    expect(budgetReached(9.99, 10)).toBe(false);
    expect(budgetReached(10, 10)).toBe(true);
  });
});
