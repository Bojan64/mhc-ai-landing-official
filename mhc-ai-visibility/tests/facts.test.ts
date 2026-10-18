import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDestinationConfig } from "../src/destination/config";
import type { DestAnswerRow } from "../src/destination/db";
import { auditClosedHotels, factApplies, findClosureLine } from "../src/destination/facts";
import type { Analysis, HotelFact } from "../src/destination/schemas";
import { renderClosedHotels, type ReportData } from "../src/destination/report";
import { CONFIG_DIR } from "./helpers";

const FACT: HotelFact = {
  name: "Grand Hotel Toplice", aliases: ["Hotel Toplice", "Toplice"], status: "closed", valid_until: "2027-09-01",
  source: "test", checked_on: "2026-10-18",
};

const answer = (job_id: number, engine_id: string, question_id: string, raw_answer: string, created = "2026-10-18T12:00:00Z"): DestAnswerRow => ({
  job: { job_id, run_id: "r", sequence: job_id, question_id, segment: "s", prompt_text_rendered: "q", engine_id, model: "m", repetition: 1, status: "done", attempts: 1, error: null, updated_at: created },
  response_id: job_id, raw_answer, api_citations_json: "[]", created_at: created,
  input_tokens: 1, output_tokens: 1, search_count: 0, cost_estimate: 0, analysis_json: null, analysis_cost: 0,
});

const analysis = (name: string, sentiment: "recommended" | "neutral" | "not_recommended", sentiment_quote = "q"): Analysis => ({
  analyzer_version: "v4",
  no_hotels_reason: null,
  hotels: [{
    name, lodging_type: "hotel", location_stated: "Bled", sentiment, sentiment_quote, booking_target: "unspecified", booking_evidence: null,
    cited_sources: [], linked_urls: [], possible_duplicate_of: null, quote: name, quote_truncated: false,
    booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null,
  }],
});

describe("destination-facts.json", () => {
  it("ships with Grand Hotel Toplice closed until 2027-09-01 and is loaded with the config", () => {
    const { config, errors } = loadDestinationConfig(CONFIG_DIR);
    expect(errors).toEqual([]);
    const f = config!.facts.find((x) => x.name === "Grand Hotel Toplice")!;
    expect(f).toMatchObject({ status: "closed", valid_until: "2027-09-01", checked_on: "2026-10-18" });
    expect(f.source).toContain("grandhoteltoplice.com");
  });

  it("is optional: without the file there are no facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "mhc-facts-"));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    rmSync(join(dir, "destination-facts.json"));
    const { config, errors } = loadDestinationConfig(dir);
    expect(errors).toEqual([]);
    expect(config!.facts).toEqual([]);
  });

  it("rejects a bad date or status", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "mhc-facts-"));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "destination-facts.json"), JSON.stringify({ facts: [{ ...FACT, valid_until: "1.9.2027", status: "shut" }] }));
    const { config, errors } = loadDestinationConfig(dir);
    expect(config).toBeNull();
    expect(errors.join()).toContain("destination-facts.json");
  });
});

describe("closed-hotel audit", () => {
  it("applies a fact only to answers given before valid_until", () => {
    expect(factApplies(FACT, "2026-10-18")).toBe(true);
    expect(factApplies(FACT, "2027-09-01")).toBe(false);
    expect(factApplies({ ...FACT, valid_until: null }, "2030-01-01")).toBe(true);
    expect(factApplies({ ...FACT, status: "open" }, "2026-10-18")).toBe(false);
  });

  it("finds the engine's own closure remark, but not 'renovated' or other hotels' lines", () => {
    expect(findClosureLine("Intro\n**Grand Hotel Toplice** is undergoing renovation until 2027.\nOther", FACT)).toContain("undergoing renovation");
    expect(findClosureLine("Hotel Toplice reopens in autumn 2027.", FACT)).not.toBeNull();
    expect(findClosureLine("Grand Hotel Toplice was fully renovated in 2016 and has a spa.", FACT)).toBeNull();
    expect(findClosureLine("Villa X is closed for the season.\nGrand Hotel Toplice has a spa.", FACT)).toBeNull();
  });

  it("counts recommended, neutral and own closure remarks per engine, matching aliases", () => {
    const answers = [
      answer(1, "anthropic", "D1", "Best: Grand Hotel Toplice is great."),
      answer(2, "anthropic", "D2", "Try Toplice for a spa."),
      answer(3, "anthropic", "D3", "Grand Hotel Toplice has a pool."),
      answer(4, "anthropic", "D4", "Nothing about it."),
      answer(5, "openai", "D1", "Grand Hotel Toplice is closed for renovation until 2027."),
      answer(6, "openai", "D2", "Grand Hotel Toplice appears on lists."),
      answer(7, "openai", "D3", "Grand Hotel Toplice is closed.", "2027-09-02T10:00:00Z"), // after valid_until: not counted
    ];
    const analyses = new Map<number, Analysis>([
      [1, analysis("Grand Hotel Toplice", "recommended", "Best: Grand Hotel Toplice is great.")],
      [2, analysis("Toplice", "recommended", "Try Toplice for a spa.")],
      [3, analysis("Hotel Toplice", "neutral", "Grand Hotel Toplice has a pool.")],
      [4, analysis("Other Hotel", "recommended")],
      [5, analysis("Grand Hotel Toplice", "not_recommended", "closed for renovation")],
      [6, analysis("Grand Hotel Toplice", "recommended", "appears on lists")],
      [7, analysis("Grand Hotel Toplice", "recommended")],
    ]);
    const [c] = auditClosedHotels(answers, analyses, [FACT, { ...FACT, name: "Open Hotel", aliases: [], status: "open" }]);
    expect(c.fact.name).toBe("Grand Hotel Toplice");
    const by = Object.fromEntries(c.rows.map((r) => [r.engine_id, r]));
    expect(by.anthropic).toMatchObject({ answers: 4, mentioning: 3, recommended: 2, neutral: 1, notRecommended: 0, closureMentioned: 0 });
    expect(by.openai).toMatchObject({ answers: 2, mentioning: 2, recommended: 1, neutral: 0, notRecommended: 1, closureMentioned: 1 });
    expect(c.items).toHaveLength(5);
  });

  it("renders the section with sentiment quotes, and says so when no fact is closed", () => {
    const answers = [answer(1, "anthropic", "D1", "Grand Hotel Toplice is the best.")];
    const audit = auditClosedHotels(answers, new Map([[1, analysis("Grand Hotel Toplice", "recommended", "is the best")]]), [FACT]);
    const text = renderClosedHotels({ closedAudit: audit } as ReportData);
    expect(text).toContain("Priporočila nedosegljivih hotelov");
    expect(text).toContain("CLOSED until 2027-09-01");
    expect(text).toContain('anthropic D1 — recommended: "is the best"');
    expect(renderClosedHotels({ closedAudit: [] } as unknown as ReportData)).toContain("no hotel with status");
  });
});
