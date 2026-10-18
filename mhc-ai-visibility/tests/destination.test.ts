import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AdapterFactory } from "../src/engines";
import type { EngineResult } from "../src/engines/types";
import { aggregate, classifyUrl, extractUrls, nameKey, type AnswerForAggregation } from "../src/destination/aggregate";
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerUserMessage, type AnalyzeFn } from "../src/destination/analyzer";
import { loadDestinationConfig, type DestinationConfig } from "../src/destination/config";
import { destJobCounts, openDestDb, saveDestAnalysis, savePlannedDestRun, selectDestAnswers } from "../src/destination/db";
import { buildDestinationJobs, checkDestinationBudget, estimateDestinationCost } from "../src/destination/plan";
import { buildReport, renderHeader, renderHotelTable, renderMarkdown } from "../src/destination/report";
import { executeDestinationRun, DestRunRefused } from "../src/destination/run";
import { AnalysisSchema, parseStoredAnalysis, type Analysis, type Destination } from "../src/destination/schemas";
import { CONFIG_DIR } from "./helpers";

const quiet = { log: () => {}, retry: { sleep: async () => {}, maxAttempts: 2 } };
const BLED: Destination = { destination_id: "bled", name: "Bled", country: "Slovenia", location_match: ["bled"] };

function cfgWith(edit?: (dir: string) => void): DestinationConfig {
  const dir = mkdtempSync(join(tmpdir(), "mhc-dest-"));
  cpSync(CONFIG_DIR, dir, { recursive: true });
  edit?.(dir);
  const { config, errors } = loadDestinationConfig(dir);
  if (!config) throw new Error(errors.join("\n"));
  return config;
}

/** Shipped config with the OpenAI token prices blanked, to test the "price missing" refusal. */
function cfgWithoutOpenAiPrice(): DestinationConfig {
  const c = cfgWith();
  c.engines.engines.find((e) => e.engine_id === "openai")!.pricing.input_per_million = null;
  return c;
}

/** Config with all prices filled in and no rate limiting, like a user who entered the OpenAI price. */
function pricedConfig(): DestinationConfig {
  const c = cfgWith();
  for (const e of c.engines.engines) {
    e.pricing = { input_per_million: 1, output_per_million: 1, per_search: 0.01 };
    e.requests_per_minute = 600_000;
  }
  c.engines.analyzer.requests_per_minute = 600_000;
  return c;
}

const hotelsIn = (names: string[], overrides: Partial<Analysis["hotels"][number]> = {}): Analysis => ({
  hotels: names.map((name) => ({
    name, lodging_type: "hotel" as const, location_stated: "Bled", sentiment: "recommended" as const, sentiment_quote: `try ${name}`,
    booking_target: "unspecified" as const, booking_evidence: null, cited_sources: [] as string[], linked_urls: [] as string[],
    possible_duplicate_of: null, quote: name, ...overrides,
  })),
  no_hotels_reason: null,
});

const okResult = (answer: string, inTok = 1000, outTok = 1000): EngineResult => ({
  answer, citations: [], raw: { fake: true }, input_tokens: inTok, output_tokens: outTok, search_count: 1, provider_cost_usd: null,
});

function fakeAnalyzer(names = ["Hotel Alpha", "Hotel Beta"]): { fn: AnalyzeFn; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    fn: async () => {
      n++;
      return { analysis: hotelsIn(names), raw_output: "{}", error: null, input_tokens: 500, output_tokens: 100, cost_usd: 0.001 };
    },
  };
}

function setupRun(cfg: DestinationConfig, reps = 1, engines?: string[]) {
  const db = openDestDb(":memory:");
  const jobs = buildDestinationJobs(cfg, BLED, reps, engines);
  savePlannedDestRun(db, "r", { config_hash: cfg.hash, config_snapshot_json: "{}", destination_id: "bled", destination_name: "Bled", repetitions: reps }, jobs);
  return { db, jobs };
}

describe("destination config", () => {
  it("the real destination.json is valid, has 8 questions and the approved wording", () => {
    const c = cfgWith();
    expect(c.destination.questions).toHaveLength(8);
    expect(c.destination.questions.find((q) => q.id === "D5")!.text).toBe("Small, family-run hotel in {d} with personal service.");
    expect(c.destination.engines).toEqual(["openai", "gemini", "anthropic"]);
  });

  it("rejects a question without {d} and an unknown engine", () => {
    const edit = (f: (j: any) => void) => (dir: string) => {
      const p = join(dir, "destination.json");
      const j = JSON.parse(readFileSync(p, "utf8"));
      f(j);
      writeFileSync(p, JSON.stringify(j));
    };
    const dir1 = mkdtempSync(join(tmpdir(), "mhc-dest-"));
    cpSync(CONFIG_DIR, dir1, { recursive: true });
    edit((j) => (j.questions[0].text = "Where to stay?"))(dir1);
    expect(loadDestinationConfig(dir1).errors.join()).toContain("no {d} placeholder");

    const dir2 = mkdtempSync(join(tmpdir(), "mhc-dest-"));
    cpSync(CONFIG_DIR, dir2, { recursive: true });
    edit((j) => j.engines.push("nope"))(dir2);
    expect(loadDestinationConfig(dir2).errors.join()).toContain('engine "nope" is not defined');
  });
});

describe("planning and cost", () => {
  it("builds questions × engines × repetitions, all rendered with the destination name", () => {
    const c = cfgWith();
    const jobs = buildDestinationJobs(c, BLED, 3);
    expect(jobs).toHaveLength(8 * 3 * 3);
    expect(jobs.every((j) => j.prompt_text_rendered.includes("Bled") && !j.prompt_text_rendered.includes("{d}"))).toBe(true);
    expect(new Set(jobs.map((j) => `${j.question_id}|${j.engine_id}|${j.repetition}`)).size).toBe(jobs.length);
  });

  it("is incomplete while the OpenAI price is missing, and the run is refused", () => {
    const c = cfgWithoutOpenAiPrice();
    const est = estimateDestinationCost(c, buildDestinationJobs(c, BLED, 1));
    expect(est.incomplete).toBe(true);
    const check = checkDestinationBudget(est, 20);
    expect(check.ok).toBe(false);
    expect(check.reasons.join()).toContain("openai");
  });

  it("splits verified and unverified prices", () => {
    const c = pricedConfig();
    const est = estimateDestinationCost(c, buildDestinationJobs(c, BLED, 1));
    const sum = (s: string) => est.lines.filter((l) => l.priceStatus === s).reduce((a, l) => a + (l.totalUsd ?? 0), 0);
    expect(est.verifiedUsd).toBeCloseTo(sum("verified"));
    expect(est.unverifiedUsd).toBeCloseTo(sum("unverified"));
    expect(est.verifiedUsd + est.unverifiedUsd).toBeCloseTo(est.knownUsd);
    expect(est.lines.find((l) => l.key === "anthropic")!.priceStatus).toBe("verified");
    expect(est.lines.find((l) => l.key === "openai")!.priceStatus).toBe("verified");
    expect(est.lines.find((l) => l.key === "gemini")!.priceStatus).toBe("unverified");
  });

  it("requires a budget and refuses an estimate above it", () => {
    const c = pricedConfig();
    const est = estimateDestinationCost(c, buildDestinationJobs(c, BLED, 1));
    expect(checkDestinationBudget(est, null).reasons.join()).toContain("BUDGET_EUR is not set");
    expect(checkDestinationBudget(est, 0.01).reasons.join()).toContain("exceeds BUDGET_EUR");
    expect(checkDestinationBudget(est, 20).ok).toBe(true);
  });
});

describe("links, names and aggregation", () => {
  it("classifies URLs with source-domains.json and extracts links from text", () => {
    const d = cfgWith().sourceDomains;
    expect(classifyUrl("https://www.booking.com/hotel/si/x.html", d)).toBe("ota");
    expect(classifyUrl("https://www.expedia.de/Bled-Hotels", d)).toBe("ota");
    expect(classifyUrl("https://www.google.com/travel/hotels", d)).toBe("metasearch");
    expect(classifyUrl("https://www.google.com/search?q=x", d)).toBe("other");
    expect(classifyUrl("https://www.tripadvisor.co.uk/Hotel", d)).toBe("review");
    expect(classifyUrl("https://hotel-x.si/book", d)).toBe("other");
    expect(extractUrls("See [Hotel](https://hotel-x.si/book). Also https://booking.com/a, and https://hotel-x.si/book)")).toEqual([
      "https://hotel-x.si/book", "https://booking.com/a",
    ]);
  });

  it("normalises hotel names", () => {
    expect(nameKey("Hotel Vila Bled")).toBe("vila bled");
    expect(nameKey("Grand Hotel Toplice")).toBe("grand toplice");
    expect(nameKey("Vila  Bled!")).toBe("vila bled");
    expect(nameKey("Hôtel Café Žiga")).toBe("cafe ziga");
  });

  const ans = (job_id: number, engine_id: string, names: string[], extra: Partial<AnswerForAggregation> = {}, over: Partial<Analysis["hotels"][number]> = {}): AnswerForAggregation => ({
    job_id, engine_id, question_id: "D1", repetition: 1, analysis: hotelsIn(names, over), sourceText: "", hasSources: false, ...extra,
  });

  it("counts a hotel once per answer, orders by mentions, averages the position", () => {
    const agg = aggregate([
      ans(1, "openai", ["Hotel Alpha", "Hotel Beta", "Hotel Alpha"]),
      ans(2, "gemini", ["Hotel Beta", "Hotel Alpha"]),
      ans(3, "openai", ["Hotel Alpha"]),
    ], BLED);
    expect(agg.totalAnswers).toBe(3);
    const alpha = agg.hotels.find((h) => h.name === "Hotel Alpha")!;
    expect(alpha.mentions).toBe(3);
    expect(alpha.byEngine).toEqual({ openai: 2, gemini: 1 });
    expect(alpha.avgPosition).toBeCloseTo((1 + 2 + 1) / 3);
    expect(agg.hotels[0].name).toBe("Hotel Alpha");
    expect(agg.hotels.find((h) => h.name === "Hotel Beta")!.mentions).toBe(2);
  });

  it("flags hotels that need a manual check", () => {
    const agg = aggregate([
      ans(1, "openai", ["Hotel Alpha", "Hotel Single"]),
      ans(2, "gemini", ["Hotel Alpha"]),
    ], BLED);
    expect(agg.hotels.find((h) => h.name === "Hotel Alpha")!.flags).toEqual([]);
    const single = agg.hotels.find((h) => h.name === "Hotel Single")!;
    expect(single.flags).toContain("only in 1 answer");
    expect(single.flags).toContain("only one engine");

    const far = aggregate([ans(1, "openai", ["Hotel Far"], {}, { location_stated: "Bohinj" }), ans(2, "gemini", ["Hotel Far"], {}, { location_stated: "Bohinj" })], BLED);
    expect(far.hotels[0].flags.join()).toContain("location differs: Bohinj");

    const noLoc = aggregate([ans(1, "openai", ["Hotel X"], {}, { location_stated: null }), ans(2, "gemini", ["Hotel X"], {}, { location_stated: null })], BLED);
    expect(noLoc.hotels[0].flags).toContain("location never stated");
  });

  it("shows the analyzer's possible-duplicate mark as a manual check and does not merge the hotels", () => {
    const agg = aggregate([
      ans(1, "openai", ["Penzion Berc", "Garni Hotel Berc"], {}, {}),
    ], BLED);
    expect(agg.hotels).toHaveLength(2);
    const flagged = aggregate([{
      ...ans(1, "openai", ["Penzion Berc", "Garni Hotel Berc"]),
      analysis: { ...hotelsIn(["Penzion Berc", "Garni Hotel Berc"]), hotels: hotelsIn(["Penzion Berc", "Garni Hotel Berc"]).hotels.map((h, i) => (i === 1 ? { ...h, possible_duplicate_of: "Penzion Berc" } : h)) },
    }], BLED);
    expect(flagged.hotels).toHaveLength(2);
    expect(flagged.hotels.find((h) => h.name === "Garni Hotel Berc")!.flags).toContain('analyzer: possible duplicate of "Penzion Berc"');
  });

  it("counts recommended and not recommended answers and the new booking targets", () => {
    const agg = aggregate([
      ans(1, "openai", ["Hotel A"], {}, { sentiment: "not_recommended", booking_target: "direct" }),
      ans(2, "gemini", ["Hotel A"], {}, { sentiment: "recommended", booking_target: "ota" }),
      ans(3, "gemini", ["Hotel A"], {}, { sentiment: "neutral", booking_target: "portal" }),
    ], BLED);
    const a = agg.hotels[0];
    expect([a.recommended, a.notRecommended]).toEqual([1, 1]);
    expect(a.booking).toEqual({ direct: 1, ota: 1, portal: 1, unspecified: 0 });
  });

  it("flags names missing from the sources, and possible duplicates", () => {
    const withSrc = (job: number, eng: string, names: string[], text: string) => ans(job, eng, names, { sourceText: text, hasSources: true });
    const agg = aggregate([
      withSrc(1, "openai", ["Hotel Ghost Palace"], "visit bled slovenia travel guide"),
      withSrc(2, "gemini", ["Hotel Ghost Palace"], "another page about lakes"),
      withSrc(3, "openai", ["Vila Bled"], "vila bled official site"),
      withSrc(4, "gemini", ["Vila Bled", "Vila Bled Residence"], "vila bled residence"),
    ], BLED);
    expect(agg.hotels.find((h) => h.name === "Hotel Ghost Palace")!.flags).toContain("name not found in any source");
    expect(agg.hotels.find((h) => h.name === "Vila Bled")!.flags.join()).toContain('maybe same as "Vila Bled Residence"');
    expect(agg.hotels.find((h) => h.name === "Vila Bled")!.flags).not.toContain("name not found in any source");
  });
});

describe("analyzer prompt and schema", () => {
  it("puts link types and the answer into the analyzer message, and never asks for facts about existence", () => {
    const msg = buildAnalyzerUserMessage(
      { question: "Q?", answer: "Book at https://www.booking.com/hotel/x and https://hotel-x.si", destination: BLED },
      cfgWith().sourceDomains,
    );
    expect(msg).toContain("[ota]");
    expect(msg).toContain("[other]");
    expect(msg).toContain("Destination: Bled (Slovenia)");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("Do not judge whether a hotel exists");
  });

  it("schema is a strict object that can become a JSON tool schema", () => {
    const js = z.toJSONSchema(AnalysisSchema) as any;
    expect(js.type).toBe("object");
    const props = js.properties.hotels.items.properties;
    expect(props.booking_target.enum).toEqual(["direct", "ota", "portal", "unspecified"]);
    expect(props.sentiment.enum).toEqual(["recommended", "neutral", "not_recommended"]);
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["cited_sources", "linked_urls", "possible_duplicate_of", "sentiment_quote"]));
    expect(AnalysisSchema.safeParse(hotelsIn(["A"])).success).toBe(true);
    expect(AnalysisSchema.safeParse({ hotels: [{ name: "A" }], no_hotels_reason: null }).success).toBe(false);
  });

  it("limits the sentiment quote to 25 words", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(AnalysisSchema.safeParse(hotelsIn(["A"], { sentiment_quote: words(25) })).success).toBe(true);
    expect(AnalysisSchema.safeParse(hotelsIn(["A"], { sentiment_quote: words(26) })).success).toBe(false);
  });

  it("tells the analyzer that only an explicit instruction is a booking pointer, and to flag duplicates without merging", () => {
    expect(ANALYZER_SYSTEM_PROMPT).toContain("ONLY from an explicit instruction");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("a score, rating or review taken from Booking.com, Tripadvisor");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("link to the accommodation's own website that is only there as a source");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("never merge or drop entries");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("AT MOST 25 words");
  });

  it("still reads analyses stored by the first analyzer version, without guessing their booking data", () => {
    const old = JSON.stringify({
      hotels: [
        { name: "A", lodging_type: "hotel", recommended: false, location_stated: "Bled", booking_target: "ota", booking_evidence: "Booking.com score 9", quote: "A" },
        { name: "B", lodging_type: "hotel", recommended: true, location_stated: null, booking_target: "hotel_site", booking_evidence: "https://b.si", quote: "B" },
      ],
      no_hotels_reason: null,
    });
    const r = parseStoredAnalysis(old)!;
    expect(r.legacy).toBe(true);
    expect(r.analysis.hotels.map((h) => [h.sentiment, h.booking_target])).toEqual([["not_recommended", "unspecified"], ["recommended", "unspecified"]]);
    expect(r.analysis.hotels[1].linked_urls).toEqual(["https://b.si"]);
    const fresh = parseStoredAnalysis(JSON.stringify(hotelsIn(["A"])))!;
    expect(fresh.legacy).toBe(false);
    expect(parseStoredAnalysis("{}")).toBeNull();
    expect(parseStoredAnalysis("not json")).toBeNull();
  });
});

describe("run (fake engines and analyzer, no real API calls)", () => {
  const fake = (behave?: (engineId: string, n: number) => void): { factory: AdapterFactory; calls: () => number } => {
    let n = 0;
    return {
      calls: () => n,
      factory: (engine) => ({
        engine,
        call: async (req) => {
          n++;
          behave?.(engine.engine_id, n);
          return okResult(`${engine.engine_id}: ${req.prompt}`);
        },
      }),
    };
  };
  const httpError = (status: number) => Object.assign(new Error(`HTTP ${status} quota`), { status });

  it("refuses to start while a price is missing, before any call", async () => {
    const c = cfgWithoutOpenAiPrice();
    const { db } = setupRun(c);
    const f = fake();
    await expect(executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet })).rejects.toThrow(DestRunRefused);
    expect(f.calls()).toBe(0);
    expect(destJobCounts(db, "r")).toEqual({ pending: 24 });
  });

  it("refuses without a budget", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c);
    await expect(executeDestinationRun(db, c, "r", BLED, { budgetEur: null, adapterFactory: fake().factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet })).rejects.toThrow(/BUDGET_EUR/);
  });

  it("asks every question, stores answers with sources, analyses each answer, finishes the run", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 2);
    const f = fake();
    const an = fakeAnalyzer();
    const s = await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => an.fn, ...quiet });
    expect(f.calls()).toBe(48);
    expect(an.calls()).toBe(48);
    expect(s.analyzed).toBe(48);
    expect(s.runStatus).toBe("finished");
    expect(s.stopReason).toBe("completed");
    expect(s.engines.every((e) => e.done === 16 && !e.unavailable)).toBe(true);
    const answers = selectDestAnswers(db, "r");
    expect(answers).toHaveLength(48);
    expect(answers.every((a) => a.analysis_json && a.created_at)).toBe(true);
  });

  it("marks an engine unavailable after repeated failures, finishes the others and says so in the report", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    const f = fake((id) => { if (id === "gemini") throw httpError(429); });
    const s = await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    const gem = s.engines.find((e) => e.engine_id === "gemini")!;
    expect(gem.unavailable).toBe(true);
    expect(gem.done).toBe(0);
    expect(gem.failed).toBeGreaterThanOrEqual(3); // calls already in flight when the breaker trips still finish
    expect(gem.failed + gem.notStarted).toBe(8);
    expect(gem.notStarted).toBeGreaterThan(0);
    expect(s.engines.find((e) => e.engine_id === "openai")!.done).toBe(8);
    expect(s.runStatus).toBe("stopped");

    const rep = buildReport(db, c, "r");
    const header = renderHeader(rep);
    expect(header).toContain("ENGINE MISSING: gemini");
    expect(header).toContain("anthropic, openai");
    expect(rep.agg.engines).toEqual(["anthropic", "openai"]);
    expect(renderMarkdown(rep)).toContain("ENGINE MISSING: gemini");
  });

  it("can be restricted to some engines (e.g. leaving Gemini out) and the others stay pending", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    const f = fake();
    const s = await executeDestinationRun(db, c, "r", BLED, { engines: ["openai", "anthropic"], budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    expect(f.calls()).toBe(16);
    expect(s.engines.map((e) => e.engine_id).sort()).toEqual(["anthropic", "openai"]);
    expect(destJobCounts(db, "r")).toEqual({ done: 16, pending: 8 });
  });

  it("hard budget: stops before the next call once real costs are above the estimate", async () => {
    const c = pricedConfig();
    c.engines.usd_to_eur = 1;
    c.engines.engines.find((e) => e.engine_id === "anthropic")!.max_concurrency = 1;
    const { db } = setupRun(c, 1, ["anthropic"]);
    const est = estimateDestinationCost(c, buildDestinationJobs(c, BLED, 1, ["anthropic"]));
    const budget = est.knownEur * 1.2; // passes the pre-run check
    // every real call is far dearer than estimated: 3,000,000 tokens × $1 per million ≈ $3
    const dear: AdapterFactory = (engine) => ({ engine, call: async () => okResult("dear", 3_000_000, 0) });
    const s = await executeDestinationRun(db, c, "r", BLED, { budgetEur: budget, adapterFactory: dear, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    expect(s.stopReason).toBe("budget");
    const anthropic = s.engines.find((e) => e.engine_id === "anthropic")!;
    expect(anthropic.done).toBe(1); // the first call is only known to be dear afterwards; the second is not started
    expect(anthropic.notStarted).toBe(7);
  });

  it("resume analyses answers that still lack a valid analysis, without asking questions again", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1, ["openai"]);
    const f = fake();
    let first = true;
    const flaky: AnalyzeFn = async () => {
      if (first) { first = false; return { analysis: null, raw_output: "{bad", error: "schema: x", input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 }; }
      return { analysis: hotelsIn(["Hotel Alpha"]), raw_output: "{}", error: null, input_tokens: 10, output_tokens: 5, cost_usd: 0.0001 };
    };
    const s1 = await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => flaky, ...quiet });
    expect(s1.analysisFailed).toBe(1);
    expect(s1.runStatus).toBe("stopped");
    const callsAfterFirst = f.calls();
    const s2 = await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: f.factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    expect(f.calls()).toBe(callsAfterFirst); // no new question was asked
    expect(s2.analyzed).toBe(1);
    expect(s2.runStatus).toBe("finished");
  });

  it("builds a report with the hotel table, manual checks, cost comparison and verbatim answers", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: fake().factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    const rep = buildReport(db, c, "r");
    expect(rep.agg.hotels.map((h) => h.name).sort()).toEqual(["Hotel Alpha", "Hotel Beta"]);
    expect(rep.agg.hotels[0].mentions).toBe(24);
    expect(renderHotelTable(rep)).toContain("24/24");
    const md = renderMarkdown(rep);
    expect(md).toContain("Verbatim answers");
    expect(md).toContain("openai: Where should I stay in Bled?");
    expect(md).toContain("Actual = tokens and searches reported by each provider");
    expect(rep.cost.actualUsd).toBeGreaterThan(0);
    expect(md).toContain('recommended ("try Hotel Alpha")');
    expect(md).toContain("book dir/ota/portal/unspec");
    expect(rep.legacyAnalyses).toBe(0);
  });

  it("warns in the report when an answer still has a first-version analysis", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: fake().factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    const old = JSON.stringify({ hotels: [{ name: "Old", lodging_type: "hotel", recommended: true, location_stated: "Bled", booking_target: "ota", booking_evidence: "x", quote: "Old" }], no_hotels_reason: null });
    const jobId = (db.prepare("SELECT job_id FROM dest_jobs ORDER BY job_id LIMIT 1").get() as { job_id: number }).job_id;
    saveDestAnalysis(db, jobId, { analyzer_model: "old", analysis_json: old, raw_output: old, schema_valid: true, error: null, input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    const rep = buildReport(db, c, "r");
    expect(rep.legacyAnalyses).toBe(1);
    expect(renderHeader(rep)).toContain("first analyzer version");
  });
});
