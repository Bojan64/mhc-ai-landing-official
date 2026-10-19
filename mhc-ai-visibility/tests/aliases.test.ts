import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nameKey } from "../src/destination/aggregate";
import { checkAliases, newAliasSummary, resolveAnalysis } from "../src/destination/aliases";
import { loadDestinationConfig } from "../src/destination/config";
import type { DestAnswerRow } from "../src/destination/db";
import { auditClosedHotels, findClosureLine } from "../src/destination/facts";
import { stability, topHotels } from "../src/destination/stability";
import type { AliasesFile, Analysis, HotelFact } from "../src/destination/schemas";
import { CONFIG_DIR } from "./helpers";

const C = { confirmed_by: "owner", confirmed_on: "2026-10-18" };
const hotel = (name: string, sentiment: "recommended" | "neutral" | "not_recommended" = "recommended", extra: object = {}) => ({
  name, lodging_type: "hotel" as const, location_stated: "Bled", sentiment, sentiment_quote: "q", booking_target: "unspecified" as const,
  booking_evidence: null, cited_sources: [] as string[], linked_urls: [] as string[], possible_duplicate_of: null as string | null, quote: name,
  quote_truncated: false, booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null, missing_fields: [] as string[], ...extra,
});
const analysis = (...hotels: ReturnType<typeof hotel>[]): Analysis => ({ analyzer_version: "v4", analyzer_retries: 0, no_hotels_reason: null, hotels });
const answer = (job_id: number, engine_id: string, question_id: string, repetition: number, raw_answer = "x", created = "2026-10-18T12:00:00Z"): DestAnswerRow => ({
  job: { job_id, run_id: "r", sequence: job_id, question_id, segment: "s", prompt_text_rendered: "q", engine_id, model: "m", repetition, status: "done", attempts: 1, error: null, updated_at: created },
  response_id: job_id, raw_answer, api_citations_json: "[]", created_at: created, input_tokens: 1, output_tokens: 1, search_count: 0, cost_estimate: 0, analysis_json: null, analysis_cost: 0,
});
const AL: AliasesFile = {
  groups: [
    { canonical: "Hotel Park", aliases: ["Hotel Park (Sava Hotels & Resorts)", "Hotel Park – Sava"], ...C },
    { canonical: "Penzion Berc", aliases: ["Berc pension"], ...C },
  ],
  exclusions: [{ name: "Wellness Essense", kind: "not_lodging", reason: "spa", ...C }, { name: "Sava Hotels Bled", kind: "group", reason: "group", ...C }],
  overrides: [{ run: "r", engine_id: "anthropic", question_id: "D6", repetition: 1, hotel: "Grand Hotel Toplice", field: "sentiment", from: "recommended", to: "neutral", reason: "named only in a group list", ...C }],
  keep_separate: [{ names: ["Garni Hotel Berc", "Penzion Berc"], reason: "separate", ...C }],
};
const ref = { run: "r", engine_id: "anthropic", question_id: "D6", repetition: 1 };

describe("destination-aliases.json", () => {
  it("ships the owner's decisions: 18 groups, two exclusions, four manual corrections (Sava Hotels Bled list), Berc kept apart", () => {
    const { config, errors } = loadDestinationConfig(CONFIG_DIR);
    expect(errors).toEqual([]);
    const a = config!.aliases;
    expect(a.groups).toHaveLength(18);
    expect(a.groups.every((g) => g.confirmed_by === "owner" && g.confirmed_on === "2026-10-18")).toBe(true);
    expect(a.exclusions.map((x) => x.name).sort()).toEqual(["Sava Hotels Bled", "Wellness Essense"]);
    expect(a.overrides.map((o) => o.hotel)).toEqual(["Grand Hotel Toplice", "Rikli Balance Hotel", "Hotel Park", "Hotel Savica Garni"]);
    for (const o of a.overrides) expect(o).toMatchObject({ run: "bled-full-01", engine_id: "anthropic", question_id: "D6", repetition: 1, field: "sentiment", from: "recommended", to: "neutral", confirmed_by: "owner" });
    const ribno = a.groups.find((g) => g.canonical === "Ribno Alpine Resort")!;
    expect(ribno.aliases).toEqual(expect.arrayContaining(["Hotel Ribno", "Ribno Alpine Hotel", "Ribno Alpine Glamping"]));
    const all = new Map(a.groups.flatMap((g) => [g.canonical, ...g.aliases].map((n) => [nameKey(n), g.canonical] as const)));
    expect(all.get(nameKey("Berc pension"))).toBe("Penzion Berc");
    expect(all.has(nameKey("Garni Hotel Berc"))).toBe(false); // Garni Hotel Berc is its own hotel, never mapped
    expect(all.has(nameKey("Penzion Berc / Garni Hotel Berc"))).toBe(false); // the combined entry is not mapped
    for (const n of ["Penzion Kaps", "Apartments Kaps", "Vila Alpina", "Alp Penzion", "Lake Bled House", "Lake House Sebanc"]) expect(all.has(nameKey(n))).toBe(false);
  });

  it("is optional, and a contradictory file is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "mhc-al-"));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    const path = join(dir, "destination-aliases.json");
    const j = JSON.parse(readFileSync(path, "utf8"));
    j.groups[0].aliases.push("Hotel Triglav"); // already in another group
    writeFileSync(path, JSON.stringify(j));
    expect(loadDestinationConfig(dir).errors.join()).toContain("is in two groups");
    expect(checkAliases({ ...AL, keep_separate: [{ names: ["Penzion Berc", "Berc pension"], reason: "x", ...C }] }).join()).toContain("merged into one group");
    expect(checkAliases({ ...AL, exclusions: [{ name: "Berc pension", kind: "group", reason: "x", ...C }] }).join()).toContain("both excluded and in the group");
    expect(checkAliases(AL)).toEqual([]);
  });
});

describe("resolveAnalysis", () => {
  it("renames spellings, folds repeats in one answer into the first mention, and leaves look-alikes alone", () => {
    const s = newAliasSummary();
    const out = resolveAnalysis(analysis(hotel("Hotel Park (Sava Hotels & Resorts)"), hotel("Garni Hotel Berc"), hotel("Hotel Park"), hotel("Berc pension"), hotel("Penzion Berc / Garni Hotel Berc")), ref, AL, s);
    expect(out.hotels.map((h) => h.name)).toEqual(["Hotel Park", "Garni Hotel Berc", "Penzion Berc", "Penzion Berc / Garni Hotel Berc"]);
    expect(s.renamed).toEqual({ "Hotel Park": 1, "Penzion Berc": 1 });
    expect(s.mergedInAnswer).toBe(1);
  });

  it("leaves out excluded names and clears a duplicate mark that now points at the same hotel", () => {
    const s = newAliasSummary();
    const out = resolveAnalysis(analysis(hotel("Wellness Essense"), hotel("Sava Hotels Bled"), hotel("Hotel Park", "recommended", { possible_duplicate_of: "Hotel Park – Sava" }), hotel("Garni Hotel Berc", "recommended", { possible_duplicate_of: "Berc pension" })), ref, AL, s);
    expect(out.hotels.map((h) => h.name)).toEqual(["Hotel Park", "Garni Hotel Berc"]);
    expect(s.excluded).toEqual({ "Wellness Essense": 1, "Sava Hotels Bled": 1 });
    expect(out.hotels[0].possible_duplicate_of).toBeNull(); // same hotel after unification: no longer a duplicate
    expect(out.hotels[1].possible_duplicate_of).toBe("Penzion Berc"); // a different hotel stays marked, under the canonical name
  });

  it("applies a manual correction only to the named answer, and says so when it does not match", () => {
    const s = newAliasSummary();
    const a = analysis(hotel("Grand Hotel Toplice", "recommended"));
    expect(resolveAnalysis(a, ref, AL, s).hotels[0].sentiment).toBe("neutral");
    expect(s.applied).toHaveLength(1);
    expect(a.hotels[0].sentiment).toBe("recommended"); // the input is not modified
    const s2 = newAliasSummary();
    expect(resolveAnalysis(a, { ...ref, repetition: 2 }, AL, s2).hotels[0].sentiment).toBe("recommended");
    expect(s2.applied).toHaveLength(0);
    const s3 = newAliasSummary();
    resolveAnalysis(analysis(hotel("Grand Hotel Toplice", "not_recommended")), ref, AL, s3);
    expect(s3.notApplied.join()).toContain('sentiment is "not_recommended", not "recommended"');
    const s4 = newAliasSummary();
    resolveAnalysis(analysis(hotel("Vila Bled")), ref, AL, s4);
    expect(s4.notApplied.join()).toContain("hotel not found");
  });
});

describe("stability and top lists", () => {
  const answers = [1, 2, 3].map((rep) => answer(rep, "openai", "D1", rep)).concat([4, 5, 6].map((rep) => answer(rep, "anthropic", "D1", rep - 3)));
  const an = new Map<number, Analysis>([
    [1, analysis(hotel("A"), hotel("B"))], [2, analysis(hotel("A"), hotel("B"), hotel("C", "neutral"))], [3, analysis(hotel("A"))],
    [4, analysis(hotel("A"), hotel("X"))], [5, analysis(hotel("Y"))], [6, analysis(hotel("Z"))],
  ]);

  it("counts hotels in every repetition, in two and in one", () => {
    const [anth, open] = stability(answers, an);
    expect(open).toMatchObject({ engine_id: "openai", totalInAll: 1, totalTwice: 1, totalOnce: 1 });
    expect(open.rows[0]).toMatchObject({ union: 3, inAll: ["A"], twice: 1, once: 1 });
    expect(anth).toMatchObject({ engine_id: "anthropic", totalInAll: 0, totalTwice: 0, totalOnce: 4 });
  });

  it("ranks by recommended answers, overall and per engine, counting a hotel once per answer", () => {
    const [all, anth, open] = topHotels(answers, an, 3);
    expect(all.scope).toBe("all");
    expect(all.rows[0]).toEqual({ name: "A", recommended: 4, mentions: 4 });
    expect(open.rows.map((r) => [r.name, r.recommended, r.mentions])).toEqual([["A", 3, 3], ["B", 2, 2], ["C", 0, 1]]);
    expect(anth.answers).toBe(3);
  });
});

describe("closed hotels: named without a closure warning", () => {
  const FACT: HotelFact = { name: "Grand Hotel Toplice", aliases: ["Toplice"], status: "closed", valid_until: "2027-09-01", source: "t", checked_on: "2026-10-18" };

  it("a planned refurbishment is not a closure warning, but closed / reopening / undergoing renovation are", () => {
    expect(findClosureLine('Grand Hotel Toplice is the best-located choice. One guest said it is "very tired" but noted a refurbishment was planned.', FACT)).toBeNull();
    expect(findClosureLine("Grand Hotel Toplice was renovated in 2016.", FACT)).toBeNull();
    expect(findClosureLine("Grand Hotel Toplice is undergoing renovation.", FACT)).not.toBeNull();
    expect(findClosureLine("Grand Hotel Toplice currently advertises reopening in 2027.", FACT)).not.toBeNull();
    expect(findClosureLine("Grand Hotel Toplice is currently closed for renovation.", FACT)).not.toBeNull();
  });

  it("counts mentions without any warning per engine", () => {
    const answers = [
      answer(1, "anthropic", "D1", 1, "Grand Hotel Toplice is the classic splurge."),
      answer(2, "anthropic", "D1", 2, "Grand Hotel Toplice was planned for a refurbishment."),
      answer(3, "openai", "D1", 1, "Grand Hotel Toplice is closed for renovation until 2027."),
      answer(4, "openai", "D2", 1, "Grand Hotel Toplice is nice."),
    ];
    const an = new Map<number, Analysis>(answers.map((a) => [a.job.job_id, analysis(hotel("Grand Hotel Toplice"))]));
    const [c] = auditClosedHotels(answers, an, [FACT]);
    const by = Object.fromEntries(c.rows.map((r) => [r.engine_id, r]));
    expect(by.anthropic).toMatchObject({ mentioning: 2, closureMentioned: 0, namedWithoutWarning: 2 });
    expect(by.openai).toMatchObject({ mentioning: 2, closureMentioned: 1, namedWithoutWarning: 1 });
  });
});
