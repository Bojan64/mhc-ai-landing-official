import type { DestinationConfig } from "./config";
import { CITATION_NORMALIZERS } from "../engines";
import type { SourceRef } from "../engines/types";
import { table } from "../util/table";
import { aggregate, type Aggregation, type AnswerForAggregation, type HotelRow } from "./aggregate";
import { destSpentUsd, type DestAnswerRow, type DestDB, getDestRun, destJobCounts, selectDestAnswers, selectDestJobs } from "./db";
import { estimateDestinationCost } from "./plan";
import { AnalysisSchema, type Analysis, type Destination } from "./schemas";

export interface ReportData {
  runId: string;
  destination: Destination;
  repetitions: number;
  status: string;
  answers: DestAnswerRow[];
  analyses: Map<number, Analysis>;
  invalidAnalyses: number;
  agg: Aggregation;
  /** planned vs answered, per engine */
  engineStatus: { engine_id: string; model: string; planned: number; done: number; failed: number; pending: number; lastError: string | null }[];
  cost: CostComparison;
}

export interface CostComparison {
  rows: { key: string; estimateUsd: number | null; actualUsd: number; calls: number; status: "verified" | "unverified" }[];
  estimateUsd: number;
  actualUsd: number;
  rate: number;
}

function sourcesOf(cfg: DestinationConfig, a: DestAnswerRow): SourceRef[] {
  const engine = cfg.engines.engines.find((e) => e.engine_id === a.job.engine_id);
  if (!engine) return [];
  try {
    return CITATION_NORMALIZERS[engine.provider](JSON.parse(a.api_citations_json));
  } catch {
    return [];
  }
}

export function buildReport(db: DestDB, cfg: DestinationConfig, runId: string): ReportData {
  const run = getDestRun(db, runId);
  if (!run) throw new Error(`Run "${runId}" does not exist.`);
  const dest = cfg.destination.destinations.find((d) => d.destination_id === run.destination_id)
    ?? { destination_id: run.destination_id, name: run.destination_name, country: "", location_match: [run.destination_name.toLowerCase()] };
  const answers = selectDestAnswers(db, runId);

  const analyses = new Map<number, Analysis>();
  let invalid = 0;
  const forAgg: AnswerForAggregation[] = [];
  for (const a of answers) {
    if (!a.analysis_json) { invalid++; continue; }
    const parsed = AnalysisSchema.safeParse(JSON.parse(a.analysis_json));
    if (!parsed.success) { invalid++; continue; }
    analyses.set(a.job.job_id, parsed.data);
    const srcs = sourcesOf(cfg, a);
    forAgg.push({
      job_id: a.job.job_id, engine_id: a.job.engine_id, question_id: a.job.question_id, repetition: a.job.repetition,
      analysis: parsed.data,
      sourceText: srcs.map((s) => `${s.title ?? ""} ${s.url} ${s.domain ?? ""}`).join(" ").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(),
      hasSources: srcs.length > 0,
    });
  }
  const agg = aggregate(forAgg, dest);

  const jobs = selectDestJobs(db, runId, { statuses: ["pending", "done", "failed"] });
  const engineStatus = [...new Set(jobs.map((j) => j.engine_id))].sort().map((id) => {
    const mine = jobs.filter((j) => j.engine_id === id);
    const failed = mine.filter((j) => j.status === "failed");
    return {
      engine_id: id, model: mine[0].model, planned: mine.length,
      done: mine.filter((j) => j.status === "done").length, failed: failed.length,
      pending: mine.filter((j) => j.status === "pending").length,
      lastError: failed.length ? (failed[failed.length - 1].error ?? "").split("\n")[0].slice(0, 200) : null,
    };
  });

  // Estimate vs actual for the whole run (current config prices; token counts are the assumptions in engines.json).
  const est = estimateDestinationCost(cfg, jobs);
  const rows: CostComparison["rows"] = est.lines.map((l) => {
    const mine = answers.filter((a) => a.job.engine_id === l.key);
    const actual = l.key === "analyzer"
      ? answers.reduce((s, a) => s + (a.analysis_cost ?? 0), 0)
      : mine.reduce((s, a) => s + (a.cost_estimate ?? 0), 0);
    return { key: l.key, estimateUsd: l.totalUsd, actualUsd: actual, calls: l.key === "analyzer" ? answers.length : mine.length, status: l.priceStatus };
  });
  const cost: CostComparison = {
    rows, estimateUsd: est.knownUsd, actualUsd: destSpentUsd(db, runId), rate: cfg.engines.usd_to_eur,
  };

  return { runId, destination: dest, repetitions: run.repetitions, status: run.status, answers, analyses, invalidAnalyses: invalid, agg, engineStatus, cost };
}

// ---------------- rendering ----------------

const usd = (v: number | null) => (v === null ? "unknown" : `$${v.toFixed(3)}`);
const clip = (s: string, n: number) => (n > 0 && s.length > n ? `${s.slice(0, n)} …[cut]` : s);

export function renderHeader(r: ReportData): string {
  const lines: string[] = [];
  lines.push(`Destination: ${r.destination.name}   Run: ${r.runId}   Status: ${r.status}   Repetitions: ${r.repetitions}`);
  const rows: (string | number)[][] = [["engine", "model", "answers ok", "planned", "failed", "not started"]];
  for (const e of r.engineStatus) rows.push([e.engine_id, e.model, e.done, e.planned, e.failed, e.pending]);
  lines.push(table(rows));
  const missing = r.engineStatus.filter((e) => e.done === 0);
  const partial = r.engineStatus.filter((e) => e.done > 0 && e.done < e.planned);
  for (const e of missing)
    lines.push(`⚠ ENGINE MISSING: ${e.engine_id} produced NO answers (${e.lastError ?? "not run"}). Results below come only from: ${r.engineStatus.filter((x) => x.done > 0).map((x) => x.engine_id).join(", ") || "(none)"}.`);
  for (const e of partial) lines.push(`⚠ ${e.engine_id}: only ${e.done} of ${e.planned} planned answers (${e.lastError ?? "stopped"}). Counts for this engine are lower for that reason.`);
  if (r.invalidAnalyses) lines.push(`⚠ ${r.invalidAnalyses} answer(s) have no valid analysis and are NOT in the counts.`);
  return lines.join("\n");
}

function shortBooking(h: HotelRow): string {
  return `${h.booking.hotel_site}/${h.booking.ota}/${h.booking.other_link}/${h.booking.none}`;
}

export function renderHotelTable(r: ReportData): string {
  const { agg } = r;
  const head: string[] = ["#", "hotel", "mentions", "%", "recomm.", ...agg.engines, "avg pos", "book h/ota/oth/none", "check"];
  const rows: (string | number)[][] = [head];
  agg.hotels.forEach((h, i) => {
    rows.push([
      i + 1, h.name, `${h.mentions}/${agg.totalAnswers}`, `${Math.round((100 * h.mentions) / Math.max(1, agg.totalAnswers))}%`, h.recommended,
      ...agg.engines.map((e) => h.byEngine[e] ?? 0), h.avgPosition.toFixed(1), shortBooking(h), h.flags.length ? "CHECK" : "",
    ]);
  });
  const lines = [table(rows)];
  lines.push(`\nMentions = number of answers (out of ${agg.totalAnswers} analysed, over all engines and repetitions) in which the hotel appears; once per answer.`);
  lines.push("avg pos = average place in the order of first mention (1 = named first). book = how the answer sends the guest to book: hotel site / OTA / other link / no pointer.");
  if (agg.answersWithNoHotels) lines.push(`${agg.answersWithNoHotels} answer(s) named no hotel at all.`);
  return lines.join("\n");
}

export function renderChecks(r: ReportData): string {
  const flagged = r.agg.hotels.filter((h) => h.flags.length);
  const lines = [
    "MANUAL CHECK. The tool CANNOT confirm that a hotel exists or is really in the destination: AI assistants can invent hotels. Please check every hotel you intend to rely on.",
  ];
  if (!flagged.length) lines.push("(no hotel was flagged by the automatic rules — they still need your existence check)");
  for (const h of flagged) lines.push(`  • ${h.name} (${h.mentions} mention${h.mentions === 1 ? "" : "s"}): ${h.flags.join("; ")}${h.variants.length > 1 ? `  [also written: ${h.variants.slice(1).join(", ")}]` : ""}`);
  return lines.join("\n");
}

export function renderCost(r: ReportData): string {
  const rows: (string | number)[][] = [["item", "calls", "estimate", "actual", "prices"]];
  for (const x of r.cost.rows) rows.push([x.key, x.calls, usd(x.estimateUsd), usd(x.actualUsd), x.status]);
  rows.push(["TOTAL", "", usd(r.cost.estimateUsd), usd(r.cost.actualUsd), ""]);
  return [
    table(rows),
    `Total actual ≈ €${(r.cost.actualUsd * r.cost.rate).toFixed(2)} (estimate for all planned jobs ≈ €${(r.cost.estimateUsd * r.cost.rate).toFixed(2)}; rate ${r.cost.rate} USD→EUR, unverified).`,
    "Actual = tokens and searches reported by each provider × the prices in engines.json. It is NOT the provider's invoice; compare with the billing pages.",
  ].join("\n");
}

function renderAnalysisLine(a: Analysis | undefined): string {
  if (!a) return "  (no valid analysis)";
  if (!a.hotels.length) return `  extracted: no hotel named${a.no_hotels_reason ? ` — ${a.no_hotels_reason}` : ""}`;
  return a.hotels.map((h, i) => `  ${i + 1}. ${h.name} [${h.lodging_type}${h.recommended ? "" : ", not recommended"}] location: ${h.location_stated ?? "—"} | booking: ${h.booking_target}${h.booking_evidence ? ` (${clip(h.booking_evidence, 70)})` : ""}`).join("\n");
}

export function renderAnswers(r: ReportData, maxChars: number, only?: DestAnswerRow[]): string {
  const rows = only ?? r.answers;
  return rows.map((a) => [
    "═".repeat(78),
    `${a.job.engine_id} (${a.job.model}) · ${a.job.question_id} (${a.job.segment}) · rep ${a.job.repetition} · ${a.created_at.slice(0, 19).replace("T", " ")} UTC`,
    `Q: ${a.job.prompt_text_rendered}`,
    `tokens ${a.input_tokens ?? "?"}/${a.output_tokens ?? "?"} · searches ${a.search_count ?? "?"} · $${(a.cost_estimate ?? 0).toFixed(4)}`,
    "─".repeat(78),
    clip(a.raw_answer, maxChars),
    "─".repeat(78),
    "Extracted by analyzer:",
    renderAnalysisLine(r.analyses.get(a.job.job_id)),
  ].join("\n")).join("\n\n");
}

/** Terminal report: header, table, checks, cost, a few examples of answer vs extraction. */
export function renderTerminal(r: ReportData, o: { examples: number; maxChars: number }): string {
  const parts = [renderHeader(r), "", renderHotelTable(r), "", renderChecks(r), "", "COST (estimate vs actual)", renderCost(r)];
  if (o.examples > 0) {
    // spread the examples over different engines
    const pick: DestAnswerRow[] = [];
    const byEng = new Map<string, DestAnswerRow[]>();
    for (const a of r.answers) byEng.set(a.job.engine_id, [...(byEng.get(a.job.engine_id) ?? []), a]);
    for (let i = 0; pick.length < o.examples && i < 50; i++)
      for (const list of byEng.values()) if (list[i] && pick.length < o.examples) pick.push(list[i]);
    parts.push("", `EXTRACTION EXAMPLES (${pick.length}) — answer next to what the analyzer extracted`, renderAnswers(r, o.maxChars, pick));
  }
  return parts.join("\n");
}

/** Full Markdown report with every verbatim answer. */
export function renderMarkdown(r: ReportData): string {
  const fence = (s: string) => `\`\`\`\n${s}\n\`\`\``;
  return [
    `# AI recommendations in ${r.destination.name} — run ${r.runId}`,
    "", fence(renderHeader(r)),
    "", "## Hotels by number of mentions", fence(renderHotelTable(r)),
    "", "## Manual check", fence(renderChecks(r)),
    "", "## Cost", fence(renderCost(r)),
    "", "## Verbatim answers", fence(renderAnswers(r, 0)),
    "",
  ].join("\n");
}

export { destJobCounts };
