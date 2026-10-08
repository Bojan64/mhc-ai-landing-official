import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { EnginesFileSchema, SourceDomainsSchema, type EnginesConfig, type SourceDomains } from "../config/schemas";
import { DestinationFileSchema, PLACEHOLDER, type DestinationFile } from "./schemas";

export interface DestinationConfig {
  destination: DestinationFile;
  engines: EnginesConfig;
  sourceDomains: SourceDomains;
  hash: string;
}

export interface DestinationConfigResult {
  config: DestinationConfig | null;
  errors: string[];
  warnings: string[];
}

/**
 * Load the files destination mode needs: destination.json, engines.json, source-domains.json.
 * (hotels.json, prompts.json and scoring.json belong to the hotel mode and are not read.)
 */
export function loadDestinationConfig(configDir: string): DestinationConfigResult {
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
      for (const issue of parsed.error.issues) errors.push(`${file}: ${issue.path.join(".") || "(whole file)"} — ${issue.message}`);
      return null;
    }
    return parsed.data;
  };

  const destination = read("destination.json", DestinationFileSchema);
  const engines = read("engines.json", EnginesFileSchema);
  const sourceDomains = read("source-domains.json", SourceDomainsSchema);
  if (!destination || !engines || !sourceDomains) return { config: null, errors, warnings: [] };

  const cross = crossCheckDestination(destination, engines);
  errors.push(...cross.errors);
  const config = { destination, engines, sourceDomains, hash: hash.digest("hex") };
  return { config: errors.length ? null : config, errors, warnings: cross.warnings };
}

export function crossCheckDestination(d: DestinationFile, e: EnginesConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dup = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

  for (const x of dup(d.questions.map((q) => q.id))) errors.push(`destination.json: duplicate question id "${x}"`);
  for (const x of dup(d.destinations.map((q) => q.destination_id))) errors.push(`destination.json: duplicate destination_id "${x}"`);
  for (const x of dup(d.engines)) errors.push(`destination.json: engine "${x}" listed twice`);
  for (const q of d.questions) {
    if (!q.text.includes(PLACEHOLDER)) errors.push(`destination.json: question ${q.id} has no ${PLACEHOLDER} placeholder`);
    const other = [...q.text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((p) => `{${p}}` !== PLACEHOLDER);
    if (other.length) errors.push(`destination.json: question ${q.id} uses unknown placeholder {${other[0]}}`);
  }
  for (const id of d.engines) {
    const eng = e.engines.find((x) => x.engine_id === id);
    if (!eng) errors.push(`destination.json: engine "${id}" is not defined in engines.json`);
    else {
      if (!eng.modes.includes("web_search")) errors.push(`destination.json: engine "${id}" has no web_search mode`);
      if (!eng.enabled) warnings.push(`engine "${id}" is disabled in engines.json but listed in destination.json`);
      if (eng.temperature !== null) warnings.push(`${id}: temperature is forced to ${eng.temperature}; destination mode expects the provider default`);
      const missing = Object.entries(eng.pricing).filter(([, v]) => v === null).map(([k]) => k);
      if (missing.length) warnings.push(`${id}: pricing not filled in (${missing.join(", ")}) — "destination-run" will refuse until it is`);
    }
    if (!(id in d.price_status)) warnings.push(`destination.json: price_status has no entry for "${id}" (it will count as unverified)`);
  }
  return { errors, warnings };
}

export function priceStatus(d: DestinationFile, key: string): { status: "verified" | "unverified"; note: string } {
  const s = d.price_status[key];
  return typeof s === "object" && s ? s : { status: "unverified", note: "no entry in price_status" };
}
