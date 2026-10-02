import type { AppConfig } from "../config/load";
import type { CallAssumption, Engine, Mode, Pricing } from "../config/schemas";
import { countBy, type JobSpec } from "./plan";

/** Cost of one call in USD, or null if any needed price is missing. */
export function callCostUsd(
  pricing: Pricing,
  usage: { input_tokens: number; output_tokens: number; searches: number },
): number | null {
  const { input_per_million: inP, output_per_million: outP, per_search: searchP } = pricing;
  if (inP === null || outP === null) return null;
  if (usage.searches > 0 && searchP === null) return null;
  return (usage.input_tokens * inP + usage.output_tokens * outP) / 1_000_000 + usage.searches * (searchP ?? 0);
}

export function assumptionFor(config: AppConfig, engine: Engine, mode: Mode): CallAssumption {
  return engine.cost_assumptions?.[mode] ?? config.engines.cost_assumptions[mode];
}

export interface EngineEstimate {
  engine_id: string;
  calls: number;
  /** null = pricing incomplete for this engine */
  usd: number | null;
}

export interface CostEstimate {
  perEngine: EngineEstimate[];
  analyzer: { calls: number; usd: number | null };
  /** Sum over everything that could be priced. */
  knownUsd: number;
  knownEur: number;
  /** true if some engine (or the analyzer) has missing prices */
  incomplete: boolean;
}

export function estimateCost(config: AppConfig, jobs: JobSpec[]): CostEstimate {
  const perEngine: EngineEstimate[] = [];
  for (const [engineId, calls] of countBy(jobs, (j) => j.engine_id)) {
    const engine = config.engines.engines.find((e) => e.engine_id === engineId)!;
    let usd: number | null = 0;
    for (const [mode, n] of countBy(jobs.filter((j) => j.engine_id === engineId), (j) => j.mode)) {
      const a = assumptionFor(config, engine, mode as Mode);
      const one = callCostUsd(engine.pricing, {
        input_tokens: a.input_tokens,
        output_tokens: a.output_tokens,
        searches: a.searches_per_call,
      });
      usd = one === null || usd === null ? null : usd + one * n;
    }
    perEngine.push({ engine_id: engineId, calls, usd });
  }

  const an = config.engines.cost_assumptions.analyzer;
  const oneAnalysis = callCostUsd(config.engines.analyzer.pricing, { ...an, searches: 0 });
  const analyzer = { calls: jobs.length, usd: oneAnalysis === null ? null : oneAnalysis * jobs.length };

  const parts = [...perEngine.map((e) => e.usd), analyzer.usd];
  const knownUsd = parts.reduce<number>((s, v) => s + (v ?? 0), 0);
  return {
    perEngine,
    analyzer,
    knownUsd,
    knownEur: knownUsd * config.engines.usd_to_eur,
    incomplete: parts.some((v) => v === null),
  };
}

export interface BudgetCheck {
  ok: boolean;
  reasons: string[];
}

/** May a run start? Needs a budget, complete prices, and an estimate within budget. */
export function checkBudgetBeforeRun(estimate: CostEstimate, budgetEur: number | null): BudgetCheck {
  const reasons: string[] = [];
  if (budgetEur === null) reasons.push("BUDGET_EUR is not set in .env");
  if (estimate.incomplete) reasons.push("some prices in engines.json are missing (null), so the cost cannot be estimated");
  if (budgetEur !== null && estimate.knownEur > budgetEur)
    reasons.push(`estimated cost €${estimate.knownEur.toFixed(2)} exceeds BUDGET_EUR €${budgetEur.toFixed(2)}`);
  return { ok: reasons.length === 0, reasons };
}

/** During a run: stop once actual tracked spend reaches the budget. */
export function budgetReached(spentEur: number, budgetEur: number): boolean {
  return spentEur >= budgetEur;
}
