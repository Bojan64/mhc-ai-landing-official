import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  EnginesFileSchema, HotelsFileSchema, PLACEHOLDERS, PromptsFileSchema,
  ScoringSchema, SourceDomainsSchema,
  type EnginesConfig, type Hotel, type PromptTemplate, type ScoringConfig, type SourceDomains,
} from "./schemas";

export interface AppConfig {
  hotels: Hotel[];
  prompts: PromptTemplate[];
  engines: EnginesConfig;
  scoring: ScoringConfig;
  sourceDomains: SourceDomains;
  /** sha256 over the raw contents of all config files */
  hash: string;
}

export interface ConfigResult {
  config: AppConfig | null;
  errors: string[];
  warnings: string[];
}

const FILES = {
  hotels: "hotels.json",
  prompts: "prompts.json",
  engines: "engines.json",
  scoring: "scoring.json",
  sourceDomains: "source-domains.json",
} as const;

/** Load all config files, validate them, and run cross-file checks. */
export function loadConfig(configDir: string): ConfigResult {
  const errors: string[] = [];
  const hash = createHash("sha256");

  const read = <T>(file: string, schema: z.ZodType<T>): T | null => {
    const path = join(configDir, file);
    if (!existsSync(path)) {
      errors.push(`${file}: file not found`);
      return null;
    }
    const raw = readFileSync(path, "utf8");
    hash.update(file).update(raw);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      errors.push(`${file}: not valid JSON (${(e as Error).message})`);
      return null;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${file}: ${describePath(json, issue.path)} — ${issue.message}`);
      }
      return null;
    }
    return parsed.data;
  };

  const hotels = read(FILES.hotels, HotelsFileSchema);
  const prompts = read(FILES.prompts, PromptsFileSchema);
  const engines = read(FILES.engines, EnginesFileSchema);
  const scoring = read(FILES.scoring, ScoringSchema);
  const sourceDomains = read(FILES.sourceDomains, SourceDomainsSchema);

  if (!hotels || !prompts || !engines || !scoring || !sourceDomains) {
    return { config: null, errors, warnings: [] };
  }

  const config: AppConfig = { hotels, prompts, engines, scoring, sourceDomains, hash: hash.digest("hex") };
  const cross = crossCheck(config);
  errors.push(...cross.errors);
  return { config: errors.length ? null : config, errors, warnings: cross.warnings };
}

/** Make zod error paths readable, e.g. "hotel HX → ground_truth.parking". */
function describePath(json: unknown, path: PropertyKey[]): string {
  if (path.length === 0) return "(whole file)";
  const first = path[0];
  if (Array.isArray(json) && typeof first === "number") {
    const item = json[first] as Record<string, unknown> | undefined;
    const label = item?.hotel_id ?? item?.id ?? `item #${first + 1}`;
    const rest = path.slice(1).join(".");
    return rest ? `${String(label)} → ${rest}` : String(label);
  }
  return path.map(String).join(".");
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((v) => (seen.has(v) ? true : (seen.add(v), false))))];
}

/** Checks that span several files or several entries. */
export function crossCheck(c: Omit<AppConfig, "hash">): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const hotelIds = new Set(c.hotels.map((h) => h.hotel_id));
  for (const d of duplicates(c.hotels.map((h) => h.hotel_id))) errors.push(`hotels.json: duplicate hotel_id "${d}"`);
  for (const d of duplicates(c.prompts.map((p) => p.id))) errors.push(`prompts.json: duplicate id "${d}"`);
  for (const d of duplicates(c.engines.engines.map((e) => e.engine_id)))
    errors.push(`engines.json: duplicate engine_id "${d}"`);

  for (const h of c.hotels) {
    for (const cid of h.competitor_ids) {
      if (cid === h.hotel_id) errors.push(`hotels.json: ${h.hotel_id} lists itself as a competitor`);
      else if (!hotelIds.has(cid)) errors.push(`hotels.json: ${h.hotel_id} → competitor "${cid}" does not exist`);
    }
    if (!h.ground_truth_confirmed_by_hotel)
      warnings.push(`${h.hotel_id}: ground truth NOT confirmed by the hotel (will be marked in the report)`);
    const gtStars = h.ground_truth.star_rating;
    if (gtStars !== undefined && gtStars !== h.stars)
      warnings.push(`${h.hotel_id}: stars (${h.stars}) differs from ground_truth.star_rating (${gtStars})`);
  }

  const allowed = new Set<string>(PLACEHOLDERS);
  for (const p of c.prompts) {
    for (const m of p.text.matchAll(/\{([^}]*)\}/g)) {
      if (!allowed.has(m[1])) errors.push(`prompts.json: ${p.id} uses unknown placeholder {${m[1]}}`);
    }
    const namesHotel = p.text.includes("{hotel_name}");
    if (p.type === "discovery" && namesHotel)
      errors.push(`prompts.json: ${p.id} is "discovery" but names the hotel ({hotel_name})`);
    if (p.type === "brand" && !namesHotel)
      errors.push(`prompts.json: ${p.id} is "brand" but does not contain {hotel_name}`);
  }

  const enabled = c.engines.engines.filter((e) => e.enabled);
  if (enabled.length === 0) errors.push("engines.json: no engine is enabled");
  for (const e of enabled) {
    if (!(e.engine_id in c.scoring.engine_weights))
      errors.push(`scoring.json: engine_weights has no entry for enabled engine "${e.engine_id}"`);
    const missing = Object.entries(e.pricing).filter(([, v]) => v === null).map(([k]) => k);
    if (missing.length)
      warnings.push(`${e.engine_id}: pricing not filled in (${missing.join(", ")}) — cost estimate incomplete, "run" will refuse`);
    if (e.temperature !== null)
      warnings.push(`${e.engine_id}: temperature is forced to ${e.temperature}; spec says use provider default (null)`);
  }

  const weightSum = Object.values(c.scoring.weights).reduce((a, b) => a + b, 0);
  if (weightSum <= 0) errors.push("scoring.json: weights must add up to more than 0");

  return { errors, warnings };
}
