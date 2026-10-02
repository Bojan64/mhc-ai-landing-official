import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "../src/config/load";
import type { Hotel, PromptTemplate } from "../src/config/schemas";

export const CONFIG_DIR = fileURLToPath(new URL("../config", import.meta.url));

/** Copy the real config to a temp dir, apply an edit to one file, return the dir. */
export function configWith(file: string, edit: (json: any) => any): string {
  const dir = mkdtempSync(join(tmpdir(), "mhc-config-"));
  cpSync(CONFIG_DIR, dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")))));
  return dir;
}

export function realConfig(): AppConfig {
  const { config, errors } = loadConfig(CONFIG_DIR);
  if (!config) throw new Error(errors.join("\n"));
  return config;
}

export function hotel(overrides: Partial<Hotel> = {}): Hotel {
  return {
    hotel_id: "HX", name: "Hotel X", aliases: [], website_domain: "hotel-x.si",
    city: "Portorož", region: "Slovenian coast", stars: 3, tags: [],
    competitor_ids: [], extra_competitors: [], ground_truth: {},
    ground_truth_confirmed_by_hotel: true, ...overrides,
  };
}

export function prompt(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { id: "P", language: "en", category: "c", type: "discovery", applies_if: [], text: "Best hotels in {city}", ...overrides };
}
