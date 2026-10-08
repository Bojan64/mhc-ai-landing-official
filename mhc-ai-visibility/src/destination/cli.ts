import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadDotEnv, readEnv } from "../config/env";
import { apiKeyFor, API_KEY_VARS } from "../engines";
import { redact } from "../util/redact";
import { eur, table, usd } from "../util/table";
import { loadDestinationConfig, type DestinationConfig } from "./config";
import { getDestRun, openDestDb, savePlannedDestRun } from "./db";
import { buildDestinationJobs, checkDestinationBudget, estimateDestinationCost, findDestination } from "./plan";
import { buildReport, renderMarkdown, renderTerminal } from "./report";
import { DestRunRefused, executeDestinationRun } from "./run";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG_DIR = join(ROOT, "config");
const DB_PATH = join(ROOT, "data", "destination.db");

export const DESTINATION_COMMANDS = ["destination-validate", "destination-plan", "destination-run", "destination-report"] as const;

export async function destinationMain(command: string, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "run-name": { type: "string" },
      destination: { type: "string" },
      repetitions: { type: "string" },
      engines: { type: "string" },
      limit: { type: "string" },
      notes: { type: "string" },
      "retry-failed": { type: "boolean" },
      out: { type: "string" },
      examples: { type: "string" },
      "max-chars": { type: "string" },
    },
    strict: true,
  });
  loadDotEnv(join(ROOT, ".env"));
  const engineList = values.engines ? values.engines.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  switch (command) {
    case "destination-validate": return validate();
    case "destination-plan":
      return plan(runName(values["run-name"]), values.destination, int(values.repetitions, "--repetitions"), engineList, values.notes);
    case "destination-run":
      return run(runName(values["run-name"]), engineList, values["retry-failed"], int(values.limit, "--limit"));
    case "destination-report":
      return report(runName(values["run-name"]), values.out, int(values.examples, "--examples") ?? 3, int(values["max-chars"], "--max-chars") ?? 1200);
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

function runName(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Please give a run name with letters, digits, "-", "_" or ".", e.g. --run-name "bled-trial-01"');
  return name;
}

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number ≥ 1`);
  return n;
}

function load(): DestinationConfig | null {
  const { config, errors, warnings } = loadDestinationConfig(CONFIG_DIR);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (!config) console.log(`\nConfig is NOT valid (${errors.length} error(s)). Please fix the lines marked ✗.`);
  return config;
}

function validate(): number {
  const cfg = load();
  if (!cfg) return 1;
  const d = cfg.destination;
  console.log(`\nDestinations: ${d.destinations.map((x) => `${x.destination_id} (${x.name})`).join(", ")}`);
  console.log(`Questions (${d.questions.length}), all asked in web_search mode:`);
  for (const q of d.questions) console.log(`  ${q.id} [${q.segment}] ${q.text}`);
  const rows: string[][] = [["engine", "model", "API key", "pricing in engines.json"]];
  for (const id of d.engines) {
    const e = cfg.engines.engines.find((x) => x.engine_id === id)!;
    const missing = Object.entries(e.pricing).filter(([, v]) => v === null).map(([k]) => k);
    rows.push([id, e.model, apiKeyFor(e.provider) ? "set" : `missing (${API_KEY_VARS[e.provider]})`, missing.length ? `MISSING: ${missing.join(", ")}` : "filled"]);
  }
  console.log(`\nEngines:\n${table(rows)}`);
  const a = cfg.engines.analyzer;
  console.log(`\nAnalyzer: ${a.model}   API key: ${apiKeyFor("anthropic") ? "set" : `missing (${API_KEY_VARS.anthropic})`}`);
  console.log("\nConfig is valid.");
  return 0;
}

function plan(name: string, destId: string | undefined, repsFlag: number | undefined, engineList: string[] | undefined, notes?: string): number {
  const cfg = load();
  if (!cfg) return 1;
  const env = readEnv();
  const reps = repsFlag ?? env.repetitions;
  const dest = findDestination(cfg.destination, destId);
  const engineIds = engineList ?? cfg.destination.engines;
  for (const id of engineIds) if (!cfg.destination.engines.includes(id)) throw new Error(`Engine "${id}" is not in destination.json → engines.`);
  const jobs = buildDestinationJobs(cfg, dest, reps, engineIds);
  const est = estimateDestinationCost(cfg, jobs);

  console.log(`\nPlan for run "${name}" — destination ${dest.name}, ${cfg.destination.questions.length} questions × ${engineIds.length} engines × ${reps} repetition(s). No API is called.\n`);

  const rows: (string | number)[][] = [["item", "calls", "tokens USD", "search USD", "total USD", "total EUR", "prices"]];
  for (const l of est.lines) {
    rows.push([l.label, l.calls, usd(l.tokensUsd), usd(l.searchUsd), usd(l.totalUsd), eur(l.totalUsd === null ? null : l.totalUsd * cfg.engines.usd_to_eur), l.priceStatus]);
  }
  rows.push(["TOTAL (priced items)", jobs.length * 2, "", "", usd(est.knownUsd), eur(est.knownEur), ""]);
  console.log(`Estimated cost:\n${table(rows)}\n`);

  console.log(`  of which VERIFIED prices:    ${usd(est.verifiedUsd)} ≈ ${eur(est.verifiedUsd * cfg.engines.usd_to_eur)}`);
  console.log(`  of which UNVERIFIED prices:  ${usd(est.unverifiedUsd)} ≈ ${eur(est.unverifiedUsd * cfg.engines.usd_to_eur)}`);
  for (const l of est.lines) console.log(`    ${l.key}: ${l.priceStatus} — ${l.priceNote}`);
  console.log("  Token counts per call (e.g. ~32,000 input tokens with search) are ASSUMPTIONS from engines.json, measured only for Claude.");
  console.log(`  USD→EUR rate ${cfg.engines.usd_to_eur} is unverified.`);

  const check = checkDestinationBudget(est, env.budgetEur);
  console.log(`\nHard budget (BUDGET_EUR): ${eur(env.budgetEur)}`);
  for (const r of check.reasons) console.log(`  ⚠ ${r} — "destination-run" would refuse to start.`);
  if (check.ok) console.log("  ✓ estimate is within the budget and all prices are filled in.");

  const db = openDestDb(DB_PATH);
  try {
    const { replanned } = savePlannedDestRun(db, name, {
      config_hash: cfg.hash, destination_id: dest.destination_id, destination_name: dest.name, repetitions: reps, notes,
      config_snapshot_json: JSON.stringify({ destination: cfg.destination, engines: cfg.engines, sourceDomains: cfg.sourceDomains }),
    }, jobs);
    console.log(`\n${replanned ? "Updated" : "Saved"} run "${name}" with ${jobs.length} pending answer jobs in ${DB_PATH}.`);
  } finally {
    db.close();
  }
  return 0;
}

async function run(name: string, engineList: string[] | undefined, retryFailed: boolean | undefined, limit: number | undefined): Promise<number> {
  const cfg = load();
  if (!cfg) return 1;
  const env = readEnv();
  const db = openDestDb(DB_PATH);
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nStopping after the calls in progress… (press Ctrl+C again to quit immediately)");
  };
  process.on("SIGINT", onSigint);
  try {
    const stored = getDestRun(db, name);
    if (!stored) throw new DestRunRefused(`Run "${name}" does not exist. Create it first with: destination-plan --run-name "${name}"`);
    const dest = cfg.destination.destinations.find((d) => d.destination_id === stored.destination_id);
    if (!dest) throw new DestRunRefused(`Destination "${stored.destination_id}" is no longer in destination.json.`);
    const s = await executeDestinationRun(db, cfg, name, dest, {
      engines: engineList, retryFailed, limitPerEngine: limit, budgetEur: env.budgetEur, shouldStop: () => interrupted,
    });
    const rate = cfg.engines.usd_to_eur;
    const rows: (string | number)[][] = [["engine", "answers ok", "failed", "not started", "state"]];
    for (const e of s.engines) rows.push([e.engine_id, e.done, e.failed, e.notStarted, e.unavailable ? "UNAVAILABLE" : e.done === e.planned ? "ok" : "incomplete"]);
    console.log(`\n${table(rows)}`);
    for (const e of s.engines.filter((x) => x.unavailable || (x.done === 0 && x.planned > 0))) {
      console.log(`⚠ ${e.engine_id} gave NO usable answers${e.lastError ? ` (${e.lastError})` : ""}. Results come only from the other engines — this is marked in the report.`);
    }
    console.log(`Analyses: ${s.analyzed} valid, ${s.analysisFailed} failed or invalid.`);
    console.log(`Cost this session: ${usd(s.spentThisSessionUsd)} ≈ ${eur(s.spentThisSessionUsd * rate)}; total for this run ${eur(s.spentTotalUsd * rate)} of ${eur(env.budgetEur)} budget. Run status: ${s.runStatus}.`);
    console.log(`Next: destination-report --run-name "${name}"`);
    return s.engines.some((e) => e.failed) || s.analysisFailed ? 2 : 0;
  } catch (e) {
    if (e instanceof DestRunRefused) {
      console.log(e.message);
      return 1;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    db.close();
  }
}

function report(name: string, out: string | undefined, examples: number, maxChars: number): number {
  const cfg = load();
  if (!cfg) return 1;
  const db = openDestDb(DB_PATH);
  try {
    const r = buildReport(db, cfg, name);
    console.log(`\n${renderTerminal(r, { examples, maxChars })}`);
    if (out) {
      const path = join(ROOT, out.startsWith("/") ? out.slice(1) : out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderMarkdown(r));
      console.log(`\nFull report with every verbatim answer written to ${path}`);
    } else {
      console.log(`\n(Add --out data/${name}.md to write a file with every full answer.)`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export function reportError(e: unknown): string {
  return redact((e as Error).message);
}
