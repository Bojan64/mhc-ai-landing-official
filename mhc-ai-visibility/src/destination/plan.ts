import { randomInt } from "node:crypto";
import type { CallAssumption, Engine, EnginesConfig, Pricing } from "../config/schemas";
import { shuffle } from "../runner/plan";
import { priceStatus } from "./config";
import type { DestinationConfig } from "./config";
import { PLACEHOLDER, type Destination, type DestinationFile } from "./schemas";
import type { NewDestJob } from "./db";

export function renderQuestion(text: string, d: Destination): string {
  return text.split(PLACEHOLDER).join(d.name);
}

export function findDestination(file: DestinationFile, id: string | undefined): Destination {
  if (!id) {
    if (file.destinations.length === 1) return file.destinations[0];
    throw new Error(`Please give --destination (one of: ${file.destinations.map((d) => d.destination_id).join(", ")})`);
  }
  const d = file.destinations.find((x) => x.destination_id === id);
  if (!d) throw new Error(`Unknown destination "${id}". Known: ${file.destinations.map((x) => x.destination_id).join(", ")}`);
  return d;
}

/** Destination × question × engine × repetition, in random order. All calls use web_search. */
export function buildDestinationJobs(
  cfg: DestinationConfig,
  dest: Destination,
  repetitions: number,
  engineIds: string[] = cfg.destination.engines,
  random: (n: number) => number = (n) => randomInt(n),
): NewDestJob[] {
  const jobs: NewDestJob[] = [];
  for (const q of cfg.destination.questions) {
    for (const id of engineIds) {
      const engine = cfg.engines.engines.find((e) => e.engine_id === id)!;
      for (let rep = 1; rep <= repetitions; rep++) {
        jobs.push({
          question_id: q.id, segment: q.segment, prompt_text_rendered: renderQuestion(q.text, dest),
          engine_id: id, model: engine.model, repetition: rep,
        });
      }
    }
  }
  return shuffle(jobs, random);
}

// ---------------- cost estimate ----------------

export interface CallCost {
  /** null = a needed price is missing */
  tokensUsd: number | null;
  searchUsd: number | null;
  totalUsd: number | null;
}

export function callCost(p: Pricing, a: { input_tokens: number; output_tokens: number; searches: number }): CallCost {
  const tokensUsd = p.input_per_million === null || p.output_per_million === null
    ? null
    : (a.input_tokens * p.input_per_million + a.output_tokens * p.output_per_million) / 1_000_000;
  const searchUsd = a.searches === 0 ? 0 : p.per_search === null ? null : a.searches * p.per_search;
  return { tokensUsd, searchUsd, totalUsd: tokensUsd === null || searchUsd === null ? null : tokensUsd + searchUsd };
}

export function assumptionForEngine(engines: EnginesConfig, engine: Engine): CallAssumption {
  return engine.cost_assumptions?.web_search ?? engines.cost_assumptions.web_search;
}

export interface CostLine {
  key: string; // engine_id or "analyzer"
  label: string;
  calls: number;
  perCall: CallCost;
  tokensUsd: number | null;
  searchUsd: number | null;
  totalUsd: number | null;
  priceStatus: "verified" | "unverified";
  priceNote: string;
}

export interface DestCostEstimate {
  lines: CostLine[];
  /** Sum of everything that could be priced. */
  knownUsd: number;
  verifiedUsd: number;
  unverifiedUsd: number;
  knownEur: number;
  incomplete: boolean;
  /** Estimated worst-case-ish cost of one call per engine (used as the reserve before each call). */
  perCallUsd: Record<string, number>;
}

export function estimateDestinationCost(cfg: DestinationConfig, jobs: { engine_id: string }[]): DestCostEstimate {
  const lines: CostLine[] = [];
  const perCallUsd: Record<string, number> = {};
  const engineIds = [...new Set(jobs.map((j) => j.engine_id))];
  for (const id of engineIds) {
    const engine = cfg.engines.engines.find((e) => e.engine_id === id)!;
    const calls = jobs.filter((j) => j.engine_id === id).length;
    const a = assumptionForEngine(cfg.engines, engine);
    const perCall = callCost(engine.pricing, { input_tokens: a.input_tokens, output_tokens: a.output_tokens, searches: a.searches_per_call });
    const ps = priceStatus(cfg.destination, id);
    if (perCall.totalUsd !== null) perCallUsd[id] = perCall.totalUsd;
    lines.push({
      key: id, label: `${id} (${engine.model})`, calls, perCall,
      tokensUsd: perCall.tokensUsd === null ? null : perCall.tokensUsd * calls,
      searchUsd: perCall.searchUsd === null ? null : perCall.searchUsd * calls,
      totalUsd: perCall.totalUsd === null ? null : perCall.totalUsd * calls,
      priceStatus: ps.status, priceNote: ps.note,
    });
  }
  const an = cfg.engines.analyzer;
  const aa = cfg.engines.cost_assumptions.analyzer;
  const aPer = callCost(an.pricing, { input_tokens: aa.input_tokens, output_tokens: aa.output_tokens, searches: 0 });
  const aps = priceStatus(cfg.destination, "analyzer");
  perCallUsd.analyzer = aPer.totalUsd ?? 0;
  lines.push({
    key: "analyzer", label: `analyzer (${an.model})`, calls: jobs.length, perCall: aPer,
    tokensUsd: aPer.tokensUsd === null ? null : aPer.tokensUsd * jobs.length,
    searchUsd: 0,
    totalUsd: aPer.totalUsd === null ? null : aPer.totalUsd * jobs.length,
    priceStatus: aps.status, priceNote: aps.note,
  });

  const sum = (f: (l: CostLine) => boolean) => lines.filter(f).reduce((s, l) => s + (l.totalUsd ?? 0), 0);
  const knownUsd = sum(() => true);
  return {
    lines, knownUsd,
    verifiedUsd: sum((l) => l.priceStatus === "verified"),
    unverifiedUsd: sum((l) => l.priceStatus === "unverified"),
    knownEur: knownUsd * cfg.engines.usd_to_eur,
    incomplete: lines.some((l) => l.totalUsd === null),
    perCallUsd,
  };
}

/** May a run start? Needs a budget, complete prices and an estimate within the budget. */
export function checkDestinationBudget(est: DestCostEstimate, budgetEur: number | null, alreadySpentEur = 0): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (budgetEur === null) reasons.push("BUDGET_EUR is not set (use BUDGET_EUR=20 in .env or the environment settings)");
  const missing = est.lines.filter((l) => l.totalUsd === null).map((l) => l.key);
  if (missing.length) reasons.push(`prices are missing in engines.json for: ${missing.join(", ")} — the cost cannot be estimated`);
  const total = est.knownEur + alreadySpentEur;
  if (budgetEur !== null && total > budgetEur)
    reasons.push(`estimated cost €${total.toFixed(2)}${alreadySpentEur > 0 ? ` (incl. €${alreadySpentEur.toFixed(2)} already spent)` : ""} exceeds BUDGET_EUR €${budgetEur.toFixed(2)}`);
  return { ok: reasons.length === 0, reasons };
}
