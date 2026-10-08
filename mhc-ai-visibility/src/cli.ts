import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadDotEnv, readEnv } from "./config/env";
import { loadConfig, type AppConfig } from "./config/load";
import { openDb } from "./db/db";
import { savePlannedRun } from "./db/repository";
import { API_KEY_VARS, apiKeyFor } from "./engines";
import { listModels } from "./engines/models";
import { applicablePrompts } from "./runner/applicability";
import { executeRun, RunRefused } from "./runner/execute";
import { showResponses } from "./runner/show";
import { redact } from "./util/redact";
import { checkBudgetBeforeRun, estimateCost } from "./runner/cost";
import { buildJobs, countBy } from "./runner/plan";
import { eur, table, usd } from "./util/table";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_DIR = join(ROOT, "config");
const DB_PATH = join(ROOT, "data", "mhc.db");

const LATER: Record<string, string> = {
  analyze: "Phase 3",
  metrics: "Phase 4", report: "Phase 4", "validation-export": "Phase 4", "validation-compare": "Phase 4",
};

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  // Destination mode is a separate module with its own commands, options and database.
  if (command?.startsWith("destination-")) {
    const { destinationMain, DESTINATION_COMMANDS } = await import("./destination/cli");
    if ((DESTINATION_COMMANDS as readonly string[]).includes(command)) return destinationMain(command, rest);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      "run-name": { type: "string" },
      notes: { type: "string" },
      limit: { type: "string" },
      engine: { type: "string" },
      hotel: { type: "string" },
      size: { type: "string" },
      "retry-failed": { type: "boolean" },
      "max-chars": { type: "string" },
    },
    strict: true,
  });
  loadDotEnv(join(ROOT, ".env"));

  switch (command) {
    case "validate-config":
      return validateConfig();
    case "plan":
      return plan(requireRunName(values["run-name"]), values.notes);
    case "run":
    case "resume":
      return runOrResume(command, requireRunName(values["run-name"]), {
        limitPerEngine: positiveInt(values.limit, "--limit"),
        engine: values.engine,
        hotel: values.hotel,
        retryFailed: values["retry-failed"],
      });
    case "list-models":
      return checkModels();
    case "show":
      return show(requireRunName(values["run-name"]), {
        engine: values.engine,
        hotel: values.hotel,
        limit: positiveInt(values.limit, "--limit"),
        maxChars: positiveInt(values["max-chars"], "--max-chars"),
      });
    case undefined:
    case "help":
    case "--help":
      printHelp();
      return 0;
    default:
      if (command in LATER) {
        console.log(`"${command}" is not built yet (planned for ${LATER[command]}).`);
        return 1;
      }
      console.error(`Unknown command "${command}".`);
      printHelp();
      return 1;
  }
}

function requireRunName(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('Please give a run name with letters, digits, "-", "_" or ".", e.g. --run-name "pilot-01"');
  }
  return name;
}

function positiveInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number ≥ 1`);
  return n;
}

/** Load config and print errors/warnings. Returns null if the config is invalid. */
function loadAndReport(): AppConfig | null {
  const { config, errors, warnings } = loadConfig(CONFIG_DIR);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (!config) console.log(`\nConfig is NOT valid (${errors.length} error(s)). Please fix the lines marked ✗.`);
  return config;
}

function validateConfig(): number {
  console.log(`Checking config in ${CONFIG_DIR}\n`);
  const config = loadAndReport();
  if (!config) return 1;

  const enabled = config.engines.engines.filter((e) => e.enabled);
  const hotelRows: (string | number)[][] = [["hotel", "city", "stars", "discovery prompts", "brand prompts", "ground truth"]];
  let problems = 0;
  for (const h of config.hotels) {
    const ps = applicablePrompts(config.prompts, h);
    const disc = ps.filter((p) => p.type === "discovery").length;
    if (disc === 0) problems++;
    hotelRows.push([
      `${h.hotel_id} ${h.name}`, h.city, h.stars, disc, ps.length - disc,
      h.ground_truth_confirmed_by_hotel ? "confirmed" : "NOT confirmed",
    ]);
  }
  const engineRows: string[][] = [["engine", "model", "modes", "API key"]];
  for (const e of enabled) {
    const keyVar = API_KEY_VARS[e.provider];
    engineRows.push([e.engine_id, e.model, e.modes.join(" + "), apiKeyFor(e.provider) ? "set" : `missing (${keyVar})`]);
  }

  console.log(`\nHotels (${config.hotels.length}):\n${table(hotelRows)}`);
  console.log(`\nPrompt templates: ${config.prompts.length}`);
  console.log(`\nEnabled engines (${enabled.length}):\n${table(engineRows)}`);
  console.log(`\nAnalyzer: ${config.engines.analyzer.model}`);
  if (problems) console.log(`\n  ⚠ ${problems} hotel(s) have no discovery prompts and cannot get a presence score.`);
  console.log("\nConfig is valid.");
  return 0;
}

function plan(runName: string, notes?: string): number {
  const config = loadAndReport();
  if (!config) return 1;
  const env = readEnv();
  const jobs = buildJobs(config, env.repetitions);
  const estimate = estimateCost(config, jobs);
  const engineById = new Map(config.engines.engines.map((e) => [e.engine_id, e]));

  console.log(`\nPlan for run "${runName}" — ${env.repetitions} repetition(s) per question. No API is called.\n`);

  const byEngine: (string | number)[][] = [["engine", "model", "calls", "est. cost USD", "est. cost EUR"]];
  for (const e of estimate.perEngine) {
    byEngine.push([
      e.engine_id, engineById.get(e.engine_id)!.model, e.calls,
      usd(e.usd), eur(e.usd === null ? null : e.usd * config.engines.usd_to_eur),
    ]);
  }
  const a = estimate.analyzer;
  byEngine.push([
    "analyzer", config.engines.analyzer.model, a.calls,
    usd(a.usd), eur(a.usd === null ? null : a.usd * config.engines.usd_to_eur),
  ]);
  console.log(`Calls and cost per engine:\n${table(byEngine)}\n`);

  const byMode: (string | number)[][] = [["engine × mode", "calls"]];
  for (const [k, n] of countBy(jobs, (j) => `${j.engine_id} / ${j.mode}`)) byMode.push([k, n]);
  for (const [k, n] of countBy(jobs, (j) => `ALL / ${j.mode}`)) byMode.push([k, n]);
  console.log(`Calls per mode:\n${table(byMode)}\n`);

  const byHotel: (string | number)[][] = [["hotel", "prompts", "calls"]];
  const hotelCalls = countBy(jobs, (j) => j.hotel_id);
  for (const h of config.hotels) {
    byHotel.push([`${h.hotel_id} ${h.name}`, applicablePrompts(config.prompts, h).length, hotelCalls.get(h.hotel_id) ?? 0]);
  }
  console.log(`Calls per hotel:\n${table(byHotel)}\n`);

  console.log(`Total tested-engine calls: ${jobs.length}`);
  console.log(`Total analyzer calls:      ${a.calls}`);
  console.log(
    `Estimated total cost:      ${usd(estimate.knownUsd)} ≈ ${eur(estimate.knownEur)}` +
      (estimate.incomplete ? "  (INCOMPLETE — some prices are missing, real cost will be higher)" : ""),
  );
  console.log("(Estimate uses the rough token/search assumptions in engines.json → cost_assumptions.)");

  const check = checkBudgetBeforeRun(estimate, env.budgetEur);
  console.log(`Budget (BUDGET_EUR):       ${eur(env.budgetEur)}`);
  for (const r of check.reasons) console.log(`  ⚠ ${r} — "run" would refuse to start.`);

  const db = openDb(DB_PATH);
  try {
    const { replanned } = savePlannedRun(db, runName, config, env.repetitions, jobs, notes);
    console.log(`\n${replanned ? "Updated" : "Saved"} run "${runName}" with ${jobs.length} pending jobs in ${DB_PATH}.`);
  } finally {
    db.close();
  }
  return 0;
}

async function runOrResume(
  kind: "run" | "resume",
  runName: string,
  filters: { limitPerEngine?: number; engine?: string; hotel?: string; retryFailed?: boolean },
): Promise<number> {
  const config = loadAndReport();
  if (!config) return 1;
  const env = readEnv();
  const db = openDb(DB_PATH);
  // First Ctrl+C: finish the calls in progress, then stop cleanly. Second Ctrl+C: quit at once.
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nStopping after the calls in progress… (press Ctrl+C again to quit immediately)");
  };
  process.on("SIGINT", onSigint);
  try {
    const s = await executeRun(db, config, runName, {
      kind, ...filters, budgetEur: env.budgetEur, shouldStop: () => interrupted,
    });
    const rate = config.engines.usd_to_eur;
    console.log(
      `\nDone: ${s.done} ok, ${s.failed} failed, ${s.notStarted} not started. ` +
        `Cost this session: ${usd(s.spentThisSessionUsd)} ≈ ${eur(s.spentThisSessionUsd * rate)}. Run status: ${s.runStatus}.`,
    );
    if (s.failed) console.log(`Failed jobs can be retried with: resume --run-name "${runName}" --retry-failed`);
    return s.failed ? 2 : 0;
  } catch (e) {
    if (e instanceof RunRefused) {
      console.log(e.message);
      return 1;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
    db.close();
  }
}

async function checkModels(): Promise<number> {
  const config = loadAndReport();
  if (!config) return 1;
  const wanted = [
    ...config.engines.engines.map((e) => ({ label: e.engine_id, provider: e.provider, model: e.model })),
    { label: "analyzer", provider: config.engines.analyzer.provider, model: config.engines.analyzer.model },
  ];
  let problems = 0;
  for (const w of wanted) {
    const keyVar = API_KEY_VARS[w.provider];
    const key = apiKeyFor(w.provider);
    if (!key) {
      console.log(`? ${w.label}: ${keyVar} not set — cannot check "${w.model}"`);
      problems++;
      continue;
    }
    try {
      const ids = await listModels(w.provider, key);
      if (ids === null) console.log(`? ${w.label}: provider has no model list; "${w.model}" is checked on the first real call`);
      else if (ids.includes(w.model)) console.log(`✓ ${w.label}: "${w.model}" is available`);
      else {
        problems++;
        const similar = ids.filter((id) => id.split(/[-.]/)[0] === w.model.split(/[-.]/)[0]).slice(-15);
        console.log(`✗ ${w.label}: "${w.model}" NOT found. Similar models on this account: ${similar.join(", ") || "(none)"}`);
      }
    } catch (e) {
      problems++;
      console.log(`✗ ${w.label}: could not list models (${redact((e as Error).message).split("\n")[0]})`);
    }
  }
  return problems ? 1 : 0;
}

function show(runName: string, f: { engine?: string; hotel?: string; limit?: number; maxChars?: number }): number {
  const config = loadConfig(CONFIG_DIR).config;
  if (!config) return loadAndReport(), 1;
  const db = openDb(DB_PATH);
  try {
    showResponses(db, config, runName, f);
    return 0;
  } finally {
    db.close();
  }
}

function printHelp(): void {
  console.log(`MHC AI Visibility Engine 0.1

Usage: npm run cli -- <command> [options]

  validate-config                       check all files in config/
  list-models                           check with each provider that the configured models exist
  plan --run-name NAME [--notes TEXT]   build the job list and estimate cost (no API calls)
  run --run-name NAME [--limit N] [--engine ID] [--hotel ID]
                                        start a planned run (--limit N = max N jobs per engine, split evenly over its modes)
  resume --run-name NAME [--retry-failed] [--limit N] [--engine ID] [--hotel ID]
                                        continue a started or stopped run
  show --run-name NAME [--limit N] [--engine ID] [--hotel ID] [--max-chars N]
                                        print stored answers with their sources

Destination mode (what do AI assistants recommend in one destination?):
  destination-validate                  check destination.json, engines and keys
  destination-plan --run-name NAME [--destination ID] [--repetitions N] [--engines a,b]
                                        build the job list and estimate cost (no API calls)
  destination-run --run-name NAME [--engines a,b] [--retry-failed] [--limit N]
                                        ask the questions, then analyse the answers (hard budget)
  destination-report --run-name NAME [--out data/FILE.md] [--examples N] [--max-chars N]
                                        hotel table, manual-check list, cost, verbatim answers

Coming in later phases: analyze, metrics, report, validation-export, validation-compare.`);
}

main().then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`Error: ${redact((e as Error).message)}`);
    process.exitCode = 1;
  },
);
