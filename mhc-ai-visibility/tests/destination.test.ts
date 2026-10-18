import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AdapterFactory } from "../src/engines";
import type { EngineResult } from "../src/engines/types";
import { aggregate, classifyUrl, extractUrls, nameKey, type AnswerForAggregation } from "../src/destination/aggregate";
import { ANALYZER_SYSTEM_PROMPT, buildAnalyzerParams, buildAnalyzerUserMessage, makeAnalyzer, type AnalyzeFn } from "../src/destination/analyzer";
import { loadDestinationConfig, type DestinationConfig } from "../src/destination/config";
import { destJobCounts, openDestDb, saveDestAnalysis, savePlannedDestRun, selectDestAnswers, selectStaleAnalyses } from "../src/destination/db";
import { buildDestinationJobs, checkDestinationBudget, estimateDestinationCost } from "../src/destination/plan";
import { buildReport, renderHeader, renderHotelTable, renderMarkdown } from "../src/destination/report";
import { executeDestinationRun, DestRunRefused, executeReanalysis } from "../src/destination/run";
import { checkBooking, distinctiveTokens, finalizeAnalysis, markPossibleDuplicates, parseModelOutput } from "../src/destination/finalize";
import { ANALYZER_VERSION, AnalysisSchema, ModelAnalysisSchema, parseStoredAnalysis, truncateQuote, type Analysis, type Destination } from "../src/destination/schemas";
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
  c.destination.destination_analyzer.requests_per_minute = 600_000;
  return c;
}

const hotelsIn = (names: string[], overrides: Partial<Analysis["hotels"][number]> = {}): Analysis => ({
  analyzer_version: ANALYZER_VERSION,
  analyzer_retries: 0,
  hotels: names.map((name) => ({
    name, lodging_type: "hotel" as const, location_stated: "Bled", sentiment: "recommended" as const, sentiment_quote: `try ${name}`,
    booking_target: "unspecified" as const, booking_evidence: null, cited_sources: [] as string[], linked_urls: [] as string[],
    possible_duplicate_of: null, quote: name, quote_truncated: false,
    booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null, missing_fields: [] as string[], ...overrides,
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
    expect(flagged.hotels.find((h) => h.name === "Garni Hotel Berc")!.flags).toContain('marked as possible duplicate of "Penzion Berc"');
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

  it("never rejects an analysis for a long sentiment quote: the code cuts it at 25 words and marks it", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(truncateQuote(words(25))).toEqual({ quote: words(25), truncated: false });
    const cut = truncateQuote(words(26));
    expect(cut.truncated).toBe(true);
    expect(cut.quote).toBe(`${words(25)}…`);
    const base = (name: string, q: string) => {
      const { quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h } = hotelsIn([name]).hotels[0];
      return { ...h, sentiment_quote: q };
    };
    const model = ModelAnalysisSchema.parse({
      hotels: [base("A", words(40)), base("B", words(10))],
      no_hotels_reason: null,
    });
    const out = finalizeAnalysis(model);
    expect(out.analyzer_version).toBe(ANALYZER_VERSION);
    expect(out.hotels.map((h) => h.quote_truncated)).toEqual([true, false]);
    expect(out.hotels[0].sentiment_quote.split(/\s+/).length).toBe(25);
    expect(AnalysisSchema.safeParse(out).success).toBe(true);
    // the tool schema the model sees has neither the version nor the truncation flag
    const props = (z.toJSONSchema(ModelAnalysisSchema) as any).properties;
    expect(props.analyzer_version).toBeUndefined();
    expect(props.hotels.items.properties.quote_truncated).toBeUndefined();
    expect(props.hotels.items.properties.booking_demoted).toBeUndefined();
  });

  const hotel = (name: string, booking_target: "direct" | "ota" | "portal" | "unspecified", booking_evidence: string | null, extra: object = {}) => {
    const { quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h } = hotelsIn([name]).hotels[0];
    return { ...h, booking_target, booking_evidence, ...extra };
  };

  it("booking safety net: keeps explicit pointers, demotes ratings, bracketed links and list mentions, keeps the model's value and the reason", () => {
    const keep = [
      "Its official booking site is Charming Bled",
      "I'd start with the official Sava Hotels & Resorts website, on its Rikli Balance Hotel page",
      "book it on Booking.com",
      "Reserve directly via the hotel's website",
      "email the owners directly",
    ];
    for (const e of keep) expect(checkBooking({ booking_target: "ota", booking_evidence: e })).toMatchObject({ booking_target: "ota", booking_demoted: false });
    const demote: [string | null, RegExp][] = [
      ["On Booking.com it scores 8.8", /rating or number/],
      ["Booking.com gives it 8.8", /rating or number/],
      ['at 9.0 ("Wonderful") from about 2,200 reviews', /rating or number/],
      ["It scores 8.2 from about 1,600 reviews", /rating or number/],
      ["([bled.si](https://www.bled.si/en/accommodation/list-of-accommodations/16/vila-bled/?utm_source=openai))", /only a link/],
      ["([hoteltriglavbled.si](https://www.hoteltriglavbled.si/en/?utm_source=openai))", /only a link/],
      ["https://www.booking.com/budget/city/si/bled.en-gb.html", /only a link/],
      ["it currently appears among Booking.com's budget-friendly Bled options", /no booking verb/],
      ["bled.si", /no booking verb/],
      [null, /no booking_evidence/],
    ];
    for (const [e, reason] of demote) {
      const r = checkBooking({ booking_target: "portal", booking_evidence: e });
      expect(r).toMatchObject({ booking_target: "unspecified", booking_demoted: true, booking_demoted_from: "portal" });
      expect(r.booking_demoted_reason).toMatch(reason);
      expect(r.booking_evidence).toBe(e); // the evidence is kept for the report
    }
    expect(checkBooking({ booking_target: "unspecified", booking_evidence: null })).toMatchObject({ booking_demoted: false });
  });

  it("finalizeAnalysis demotes in the stored analysis and keeps it valid", () => {
    const model = ModelAnalysisSchema.parse({
      hotels: [hotel("Hotel Kompas", "ota", "It scores 8.2 from about 1,600 reviews"), hotel("Old Bled House", "direct", "Its official booking site is Charming Bled")],
      no_hotels_reason: null,
    });
    const out = finalizeAnalysis(model);
    expect(AnalysisSchema.safeParse(out).success).toBe(true);
    expect(out.hotels.map((h) => [h.booking_target, h.booking_demoted])).toEqual([["unspecified", true], ["direct", false]]);
    expect(out.hotels[0].booking_demoted_from).toBe("ota");
  });

  it("marks hotels of one answer that share a distinctive name part as possible duplicates, without merging", () => {
    expect(distinctiveTokens("Garni Hotel Berc", ["Bled", "bled"])).toEqual(["berc"]);
    expect(distinctiveTokens("Vila Bled", ["Bled"])).toEqual([]);
    const marked = markPossibleDuplicates(
      ["Penzion Berc", "Garni Hotel Berc", "Vila Bled", "Vila Rajska ptica", "Hotel Triglav Bled", "Old Bled House", "Grand Hotel Toplice", "Hotel Toplice"]
        .map((name) => ({ name, possible_duplicate_of: null as string | null })),
      ["Bled"],
    );
    expect(marked).toHaveLength(8);
    const by = Object.fromEntries(marked.map((h) => [h.name, h.possible_duplicate_of]));
    expect(by["Penzion Berc"]).toBe("Garni Hotel Berc");
    expect(by["Garni Hotel Berc"]).toBe("Penzion Berc");
    expect(by["Grand Hotel Toplice"]).toBe("Hotel Toplice");
    expect(by["Hotel Toplice"]).toBe("Grand Hotel Toplice");
    for (const n of ["Vila Bled", "Vila Rajska ptica", "Hotel Triglav Bled", "Old Bled House"]) expect(by[n]).toBeNull(); // only generic words in common
    // a mark set by the model is kept
    expect(markPossibleDuplicates([{ name: "A Berc", possible_duplicate_of: "X" }, { name: "B Berc", possible_duplicate_of: null }], [])[0].possible_duplicate_of).toBe("X");
  });

  it("tells the analyzer: 20-word quotes, explicit pointers for THIS hotel only, with negative and positive examples", () => {
    expect(ANALYZER_SYSTEM_PROMPT).toContain("AT MOST 20 words");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("explicit pointer to book THIS accommodation");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("Vila Bled described with only");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("Vila Alpina");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("Rikli Balance Hotel");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("Old Bled House with \"Its official booking site is Charming Bled\"");
    expect(ANALYZER_SYSTEM_PROMPT).toContain("never merge or drop entries");
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

  it("reads third-version analyses (no demotion fields) as version v3, not current", () => {
    const { analyzer_retries: _ar, ...cur } = hotelsIn(["A"]);
    const v3 = { ...cur, analyzer_version: "v3", hotels: cur.hotels.map(({ booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h }) => h) };
    const r = parseStoredAnalysis(JSON.stringify(v3))!;
    expect(r.analysis.analyzer_version).toBe("v3");
    expect(r.legacy).toBe(true);
    expect(r.analysis.hotels[0].booking_demoted).toBe(false);
  });

  it("reads second-version analyses (no version field) as version v2, not current", () => {
    const { analyzer_version: _v, analyzer_retries: _ar, ...rest } = hotelsIn(["A"]);
    const v2 = { ...rest, hotels: rest.hotels.map(({ quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h }) => h) };
    const r = parseStoredAnalysis(JSON.stringify(v2))!;
    expect(r.analysis.analyzer_version).toBe("v2");
    expect(r.legacy).toBe(true);
    expect(r.analysis.hotels[0].quote_truncated).toBe(false);
  });
});

describe("destination analyzer is separate from the hotel-mode analyzer", () => {
  const tool = { name: "t", description: "d", input_schema: { type: "object" as const } };
  const input = { question: "Q?", answer: "A", destination: BLED };

  it("the destination analyzer is Sonnet 5.5 without a temperature, and its request has no temperature key", () => {
    const c = cfgWith();
    const a = c.destination.destination_analyzer;
    expect(a).toMatchObject({ model: "claude-sonnet-5-5", temperature: null, cost_assumptions: { input_tokens: 3440, output_tokens: 1160 } });
    expect(a.pricing).toEqual({ input_per_million: 2, output_per_million: 10, per_search: 0 });
    const params = buildAnalyzerParams(a, tool, input, c.sourceDomains);
    expect("temperature" in params).toBe(false);
    expect(params.model).toBe("claude-sonnet-5-5");
  });

  it("a configured temperature is still sent", () => {
    const c = cfgWith();
    expect(buildAnalyzerParams({ ...c.destination.destination_analyzer, temperature: 0 }, tool, input, c.sourceDomains)).toMatchObject({ temperature: 0 });
  });

  it("the cost estimate reads the destination analyzer, not engines.json", () => {
    const c = cfgWith();
    const jobs = buildDestinationJobs(c, BLED, 1);
    const before = estimateDestinationCost(c, jobs).lines.find((l) => l.key === "analyzer")!;
    c.engines.analyzer.pricing = { input_per_million: 999, output_per_million: 999, per_search: 0 };
    c.engines.cost_assumptions.analyzer = { input_tokens: 999999, output_tokens: 999999 };
    const after = estimateDestinationCost(c, jobs).lines.find((l) => l.key === "analyzer")!;
    expect(after.totalUsd).toBe(before.totalUsd);
    expect(before.label).toContain("claude-sonnet-5-5");
    expect(before.perCall.totalUsd).toBeCloseTo((3440 * 2 + 1160 * 10) / 1e6);
  });

  it("rejects a destination analyzer with an out-of-range temperature", () => {
    const dir = mkdtempSync(join(tmpdir(), "mhc-dest-"));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    const path = join(dir, "destination.json");
    const j = JSON.parse(readFileSync(path, "utf8"));
    j.destination_analyzer.temperature = 3;
    writeFileSync(path, JSON.stringify(j));
    expect(loadDestinationConfig(dir).errors.join()).toContain("destination_analyzer");
  });
});

describe("tolerant reading of the analyzer's tool output", () => {
  const { quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...full } = hotelsIn(["Hotel A"]).hotels[0];
  const without = (...keys: string[]) => Object.fromEntries(Object.entries(full).filter(([k]) => !keys.includes(k)));
  const out = (...hotels: object[]) => ({ hotels, no_hotels_reason: null });

  it("fills non-critical fields that are missing or wrong with empty values and lists them in missing_fields", () => {
    const r = parseModelOutput(out(without("quote", "sentiment_quote", "booking_evidence", "cited_sources", "linked_urls", { ...full, lodging_type: "castle" }.lodging_type ? "possible_duplicate_of" : "")));
    if ("error" in r) throw new Error(r.error);
    const h = r.hotels[0];
    expect(h.missing_fields).toEqual(["sentiment_quote", "booking_evidence", "cited_sources", "linked_urls", "possible_duplicate_of", "quote"]);
    expect([h.quote, h.sentiment_quote, h.booking_evidence, h.cited_sources, h.linked_urls, h.possible_duplicate_of]).toEqual(["", "", null, [], [], null]);
    const bad = parseModelOutput(out({ ...full, lodging_type: "castle", cited_sources: "Booking.com" }));
    if ("error" in bad) throw new Error(bad.error);
    expect(bad.hotels[0].missing_fields).toEqual(["lodging_type", "cited_sources"]);
    expect(bad.hotels[0].lodging_type).toBe("hotel");
  });

  it("an explicit null is a value, not a missing field", () => {
    const r = parseModelOutput(out({ ...full, booking_evidence: null, possible_duplicate_of: null, location_stated: null }));
    if ("error" in r) throw new Error(r.error);
    expect(r.hotels[0].missing_fields).toEqual([]);
  });

  it("a missing or wrong critical field (name, location_stated, sentiment, booking_target, hotels) is an error", () => {
    for (const bad of [without("name"), without("location_stated"), without("sentiment"), without("booking_target"), { ...full, sentiment: "great" }, { ...full, booking_target: "hotel_site" }, { ...full, name: " " }]) {
      const r = parseModelOutput(out(bad));
      expect("error" in r && r.error).toMatch(/critical field/);
    }
    expect("error" in parseModelOutput({ no_hotels_reason: null })).toBe(true);
    expect("error" in parseModelOutput(null)).toBe(true);
    expect(parseModelOutput({ hotels: [], no_hotels_reason: "refusal" })).toEqual({ hotels: [], no_hotels_reason: "refusal" });
  });

  it("the tool schema the model sees stays strict: every field is required", () => {
    const sch = (z.toJSONSchema(ModelAnalysisSchema) as any).properties.hotels.items;
    expect(sch.required).toEqual(expect.arrayContaining(["name", "location_stated", "sentiment", "booking_target", "quote", "sentiment_quote", "booking_evidence", "cited_sources", "linked_urls"]));
  });

  // a fake model: each call returns the next scripted tool input (or no tool call when null)
  const scripted = (inputs: (object | null)[], usage = { input_tokens: 3000, output_tokens: 1200 }) => {
    let n = 0;
    return {
      calls: () => n,
      send: async () => {
        const i = inputs[Math.min(n, inputs.length - 1)];
        n++;
        return { content: i === null ? [{ type: "text", text: "no tool" }] : [{ type: "tool_use", id: "x", name: "record_destination_analysis", input: i }], usage } as any;
      },
    };
  };
  const cfg = () => cfgWith();
  const an = (send: any) => makeAnalyzer(cfg().destination.destination_analyzer, cfg().sourceDomains, send);
  const input = { question: "Q?", answer: "A", destination: BLED };

  it("a missing non-critical field does not cost a retry and the analysis stays valid", async () => {
    const m = scripted([out(without("quote"))]);
    const r = await an(m.send)(input);
    expect(m.calls()).toBe(1);
    expect(r.retries).toBe(0);
    expect(r.analysis!.hotels[0].missing_fields).toEqual(["quote"]);
    expect(AnalysisSchema.safeParse(r.analysis).success).toBe(true);
  });

  it("a missing critical field gets exactly one more request; tokens and cost are added up", async () => {
    const m = scripted([out(without("sentiment")), out(full)]);
    const r = await an(m.send)(input);
    expect(m.calls()).toBe(2);
    expect(r.retries).toBe(1);
    expect(r.analysis!.analyzer_retries).toBe(1);
    expect(r.input_tokens).toBe(6000);
    expect(r.output_tokens).toBe(2400);
    expect(r.cost_usd).toBeCloseTo(2 * (3000 * 2 + 1200 * 10) / 1e6);
  });

  it("if the retry fails too, the analysis is invalid and says so; a missing tool call is retried as well", async () => {
    const m = scripted([out(without("booking_target")), out(without("name"))]);
    const r = await an(m.send)(input);
    expect(m.calls()).toBe(2);
    expect(r.analysis).toBeNull();
    expect(r.error).toMatch(/critical field.*\(after 1 retry\)$/);
    const none = scripted([null]);
    const r2 = await an(none.send)(input);
    expect(none.calls()).toBe(2);
    expect(r2.error).toBe("analyzer did not call the tool (after 1 retry)");
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
    expect(rep.olderAnalyses).toBe(0);
    expect(rep.demoted).toEqual([]);
    expect(md).toContain("BOOKING POINTERS DEMOTED BY THE CODE");
    expect(rep.analysisStats).toMatchObject({ byVersion: { v4: 24 }, withMissingFields: 0, retriedValid: 0, retriedInvalid: 0, invalid: 0 });
    expect(md).toContain("ANALYSIS QUALITY");
  });

  it("counts missing fields by field, retries and invalid analyses in the report", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    const withGaps: AnalyzeFn = async () => ({
      analysis: { ...hotelsIn(["Hotel A", "Hotel B"]), analyzer_retries: 1, hotels: hotelsIn(["Hotel A", "Hotel B"]).hotels.map((h, i) => (i === 0 ? { ...h, missing_fields: ["quote", "linked_urls"] } : h)) },
      raw_output: "{}", error: null, input_tokens: 1, output_tokens: 1, cost_usd: 0, retries: 1,
    });
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: fake().factory, analyzerFactory: () => withGaps, ...quiet });
    const firstJob = (db.prepare("SELECT job_id FROM dest_jobs ORDER BY job_id LIMIT 1").get() as { job_id: number }).job_id;
    saveDestAnalysis(db, firstJob, { analyzer_model: "m", analysis_json: null, raw_output: "{}", schema_valid: false, error: "critical field missing (after 1 retry)", input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    const st = buildReport(db, c, "r").analysisStats;
    expect(st.withMissingFields).toBe(24);
    expect(st.missingByField).toEqual({ quote: 24, linked_urls: 24 });
    expect(st).toMatchObject({ retriedValid: 24, retriedInvalid: 1, invalid: 1 });
    expect(renderMarkdown(buildReport(db, c, "r"))).toContain("quote ×24, linked_urls ×24");
  });

  it("lists every demoted booking pointer separately in the report", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    const demotingAnalyzer: AnalyzeFn = async () => ({
      analysis: finalizeAnalysis(ModelAnalysisSchema.parse({
        hotels: [(({ quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h }) => ({ ...h, booking_target: "ota", booking_evidence: "On Booking.com it scores 8.8" }))(hotelsIn(["Hotel Rating"]).hotels[0])],
        no_hotels_reason: null,
      })),
      raw_output: "{}", error: null, input_tokens: 1, output_tokens: 1, cost_usd: 0,
    });
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: fake().factory, analyzerFactory: () => demotingAnalyzer, ...quiet });
    const rep = buildReport(db, c, "r");
    expect(rep.demoted).toHaveLength(24);
    expect(rep.demoted[0]).toMatchObject({ hotel: "Hotel Rating", from: "ota" });
    const md = renderMarkdown(rep);
    expect(md).toContain("24 case(s)");
    expect(md).toContain("rating or number");
    expect(rep.agg.hotels[0].booking).toEqual({ direct: 0, ota: 0, portal: 0, unspecified: 24 });
  });

  it("warns in the report when an answer still has an older-version analysis", async () => {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: fake().factory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    const old = JSON.stringify({ hotels: [{ name: "Old", lodging_type: "hotel", recommended: true, location_stated: "Bled", booking_target: "ota", booking_evidence: "x", quote: "Old" }], no_hotels_reason: null });
    const jobId = (db.prepare("SELECT job_id FROM dest_jobs ORDER BY job_id LIMIT 1").get() as { job_id: number }).job_id;
    saveDestAnalysis(db, jobId, { analyzer_model: "old", analysis_json: old, raw_output: old, schema_valid: true, error: null, input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    const rep = buildReport(db, c, "r");
    expect(rep.olderAnalyses).toBe(1);
    expect(renderHeader(rep)).toContain("older analyzer version");
  });
});

describe("re-analysis of stored answers (no engine is asked again)", () => {
  const OLD = JSON.stringify({ hotels: [{ name: "Old", lodging_type: "hotel", recommended: true, location_stated: "Bled", booking_target: "ota", booking_evidence: "Booking.com score", quote: "Old" }], no_hotels_reason: null });
  const count = (db: ReturnType<typeof openDestDb>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  async function runWithOldAnalyses() {
    const c = pricedConfig();
    const { db } = setupRun(c, 1);
    const okFactory: AdapterFactory = (engine) => ({ engine, call: async (req) => okResult(`${engine.engine_id}: ${req.prompt}`) });
    await executeDestinationRun(db, c, "r", BLED, { budgetEur: 20, adapterFactory: okFactory, analyzerFactory: () => fakeAnalyzer().fn, ...quiet });
    // every answer's newest analysis is now a first-version one
    for (const a of selectDestAnswers(db, "r"))
      saveDestAnalysis(db, a.job.job_id, { analyzer_model: "old", analysis_json: OLD, raw_output: OLD, schema_valid: true, error: null, input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    return { c, db };
  }

  it("analyses first-version answers again, adds new rows, keeps old rows and answers, and asks no engine", async () => {
    const { c, db } = await runWithOldAnalyses();
    expect(selectStaleAnalyses(db, "r")).toHaveLength(24);
    const answersBefore = count(db, "dest_responses");
    const analysesBefore = count(db, "dest_analyses");
    const an = fakeAnalyzer(["Hotel New"]);
    const s = await executeReanalysis(db, c, "r", BLED, { budgetEur: 20, analyzerFactory: () => an.fn, ...quiet });
    expect(s).toMatchObject({ candidates: 24, analyzed: 24, analysisFailed: 0, stopReason: "completed" });
    expect(an.calls()).toBe(24);
    expect(count(db, "dest_responses")).toBe(answersBefore);
    expect(count(db, "dest_analyses")).toBe(analysesBefore + 24);
    expect(selectStaleAnalyses(db, "r")).toHaveLength(0);
    const rep = buildReport(db, c, "r");
    expect(rep.olderAnalyses).toBe(0);
    expect(rep.agg.hotels.map((h) => h.name)).toEqual(["Hotel New"]);
    // a second call has nothing to do and costs nothing
    const again = fakeAnalyzer();
    const s2 = await executeReanalysis(db, c, "r", BLED, { budgetEur: 20, analyzerFactory: () => again.fn, ...quiet });
    expect(s2.candidates).toBe(0);
    expect(again.calls()).toBe(0);
  });

  it("selects answers whose newest valid analysis is not the current version, and skips current ones", async () => {
    const { c, db } = await runWithOldAnalyses();
    expect(selectStaleAnalyses(db, "r")).toHaveLength(24);
    const first = selectDestAnswers(db, "r")[0];
    const { analyzer_version: _v, analyzer_retries: _ar, ...rest } = hotelsIn(["A"]);
    const v2 = JSON.stringify({ ...rest, hotels: rest.hotels.map(({ quote_truncated: _t, booking_demoted: _d, booking_demoted_from: _f, booking_demoted_reason: _r, missing_fields: _m, ...h }) => h) });
    saveDestAnalysis(db, first.job.job_id, { analyzer_model: "m", analysis_json: v2, raw_output: v2, schema_valid: true, error: null, input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    expect(selectStaleAnalyses(db, "r")).toHaveLength(24); // v2 is still not current
    const cur = JSON.stringify(hotelsIn(["A"]));
    saveDestAnalysis(db, first.job.job_id, { analyzer_model: "m", analysis_json: cur, raw_output: cur, schema_valid: true, error: null, input_tokens: 1, output_tokens: 1, cost_estimate: 0 });
    expect(selectStaleAnalyses(db, "r")).toHaveLength(23);
    void c;
  });

  it("uses the same budget gate: refuses without a budget or above it, before any call", async () => {
    const { c, db } = await runWithOldAnalyses();
    const an = fakeAnalyzer();
    await expect(executeReanalysis(db, c, "r", BLED, { budgetEur: null, analyzerFactory: () => an.fn, ...quiet })).rejects.toThrow(/BUDGET_EUR/);
    await expect(executeReanalysis(db, c, "r", BLED, { budgetEur: 0.0001, analyzerFactory: () => an.fn, ...quiet })).rejects.toThrow(DestRunRefused);
    expect(an.calls()).toBe(0);
  });

  it("skips a single invalid analysis and carries on; stops only after 3 invalid in a row", async () => {
    const { c, db } = await runWithOldAnalyses();
    c.destination.destination_analyzer.max_concurrency = 1;
    const mk = (invalidAt: (n: number) => boolean) => {
      let n = 0;
      const fn: AnalyzeFn = async () => {
        n++;
        return invalidAt(n)
          ? { analysis: null, raw_output: "{}", error: "critical field missing or wrong: hotels.0.sentiment (after 1 retry)", input_tokens: 10, output_tokens: 10, cost_usd: 0.001, retries: 1 }
          : { analysis: hotelsIn(["Hotel New"]), raw_output: "{}", error: null, input_tokens: 10, output_tokens: 10, cost_usd: 0.001 };
      };
      return { fn, calls: () => n };
    };
    const one = mk((n) => n === 2); // one invalid, then valid again
    const s1 = await executeReanalysis(db, c, "r", BLED, { budgetEur: 20, analyzerFactory: () => one.fn, ...quiet });
    expect(one.calls()).toBe(24);
    expect(s1).toMatchObject({ analyzed: 23, analysisFailed: 1, retried: 1, stopReason: "completed" });

    const { c: c2, db: db2 } = await runWithOldAnalyses();
    c2.destination.destination_analyzer.max_concurrency = 1;
    const three = mk((n) => n >= 3 && n <= 5); // 3 in a row from the third call on
    const lines: string[] = [];
    const s2 = await executeReanalysis(db2, c2, "r", BLED, { budgetEur: 20, analyzerFactory: () => three.fn, log: (l) => lines.push(l) });
    expect(three.calls()).toBe(5);
    expect(s2.stopReason).toBe("invalid_streak");
    expect(lines.join("\n")).toContain("3 invalid analyses in a row");
    expect(selectStaleAnalyses(db2, "r")).toHaveLength(24 - 2);
  });
});

