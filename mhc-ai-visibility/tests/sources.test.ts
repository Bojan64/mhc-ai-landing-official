import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDestinationConfig } from "../src/destination/config";
import type { DestAnswerRow } from "../src/destination/db";
import type { Analysis, HotelFact, SourceCategory } from "../src/destination/schemas";
import { categoryOf, linkSources, sourceItems, sourcesOfClosedHotel, sourcesPerHotel, summarizeSources, termsFor, type SourceItem } from "../src/destination/sources";
import { CONFIG_DIR } from "./helpers";

const cfg = loadDestinationConfig(CONFIG_DIR).config!;
const openai = cfg.engines.engines.find((e) => e.engine_id === "openai")!;
const anthropic = cfg.engines.engines.find((e) => e.engine_id === "anthropic")!;
const CATS: SourceCategory[] = [
  { id: "official_hotel", label: "uradna", domains: ["hoteltriglavbled.si", "grandhoteltoplice.com"] },
  { id: "ota", label: "OTA", domains: ["booking.com", "expedia.", "hotels.com"] },
  { id: "reviews", label: "ocene", domains: ["tripadvisor."] },
];

const hotel = (name: string, sentiment: "recommended" | "neutral" | "not_recommended" = "recommended") => ({
  name, lodging_type: "hotel" as const, location_stated: "Bled", sentiment, sentiment_quote: "q", booking_target: "unspecified" as const, booking_evidence: null,
  cited_sources: [] as string[], linked_urls: [] as string[], possible_duplicate_of: null, quote: name, quote_truncated: false,
  booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null, missing_fields: [] as string[],
});
const analysis = (...names: string[]): Analysis => ({ analyzer_version: "v4", analyzer_retries: 0, no_hotels_reason: null, hotels: names.map((n) => hotel(n)) });
const row = (job_id: number, engine_id: string, question_id: string, repetition: number, raw_answer: string, citations: unknown): DestAnswerRow => ({
  job: { job_id, run_id: "r", sequence: job_id, question_id, segment: "s", prompt_text_rendered: "q", engine_id, model: "m", repetition, status: "done", attempts: 1, error: null, updated_at: "2026-10-18T12:00:00Z" },
  response_id: job_id, raw_answer, api_citations_json: JSON.stringify(citations), created_at: "2026-10-18T12:00:00Z",
  input_tokens: 1, output_tokens: 1, search_count: 0, cost_estimate: 0, analysis_json: null, analysis_cost: 0,
});
const cite = (url: string, title: string, start: number, end: number) => ({ type: "url_citation", url, title, start_index: start, end_index: end });
const item = (url: string, title: string | null, start: number | null = null): SourceItem => ({ url, title, domain: new URL(url).hostname.replace(/^www\./, ""), kind: start === null ? "retrieved" : "cited", start, end: start === null ? null : start + 5 });
const named = (name: string) => ({ name, terms: termsFor(name, cfg) });

describe("source groups", () => {
  it("matches exact domains, subdomains and 'any ending' patterns; first group wins; unknown goes to other", () => {
    expect(categoryOf("booking.com", CATS)).toBe("ota");
    expect(categoryOf("uk.hotels.com", CATS)).toBe("ota");
    expect(categoryOf("expedia.co.uk", CATS)).toBe("ota");
    expect(categoryOf("nz.kayak.com", [{ id: "ota", label: "x", domains: ["kayak."] }])).toBe("ota");
    expect(categoryOf("tripadvisor.co.uk", CATS)).toBe("reviews");
    expect(categoryOf("notbooking.com", CATS)).toBe("other");
    expect(categoryOf("random-blog.example", CATS)).toBe("other");
    expect(categoryOf(null, CATS)).toBe("other");
    expect(categoryOf("x.hotels.com", [{ id: "a", label: "a", domains: ["hotels.com"] }, { id: "b", label: "b", domains: ["x.hotels.com"] }])).toBe("a");
  });

  it("ships source-categories.json with the five groups and no domain in two groups", () => {
    const ids = cfg.sourceCategories.map((c) => c.id);
    expect(ids).toEqual(["official_hotel", "tourism_portal", "ota", "reviews", "guides"]);
    expect(categoryOf("grandhoteltoplice.com", cfg.sourceCategories)).toBe("official_hotel");
    expect(categoryOf("bled.si", cfg.sourceCategories)).toBe("tourism_portal");
    expect(categoryOf("tripadvisor.com", cfg.sourceCategories)).toBe("reviews");
    expect(categoryOf("booking.com", cfg.sourceCategories)).toBe("ota");
    expect(categoryOf("inghams.co.uk", cfg.sourceCategories)).toBe("other"); // tour operator: deliberately left to the owner
  });

  it("rejects a domain listed in two groups and the reserved id 'other'", () => {
    const dir = mkdtempSync(join(tmpdir(), "mhc-sc-"));
    cpSync(CONFIG_DIR, dir, { recursive: true });
    const path = join(dir, "source-categories.json");
    const j = JSON.parse(readFileSync(path, "utf8"));
    j.categories[1].domains.push("booking.com");
    writeFileSync(path, JSON.stringify(j));
    expect(loadDestinationConfig(dir).errors.join()).toContain('"booking.com" is in two groups');
    j.categories[1].domains.pop();
    j.categories.push({ id: "other", label: "x", domains: [] });
    writeFileSync(path, JSON.stringify(j));
    expect(loadDestinationConfig(dir).errors.join()).toContain("reserved");
  });
});

describe("per engine summary", () => {
  const answers = [
    row(1, "openai", "D1", 1, "x", [cite("https://www.hoteltriglavbled.si/en/", "Triglav", 1, 2), cite("https://www.hoteltriglavbled.si/en/", "Triglav", 3, 4), cite("https://www.booking.com/h", "b", 5, 6)]),
    row(2, "openai", "D2", 1, "x", [cite("https://unknown.example/a", "u", 1, 2)]),
    row(3, "anthropic", "D1", 1, "x", { text_citations: [], search_results: [{ type: "web_search_result", url: "https://www.tripadvisor.com/a", title: "t" }, { type: "web_search_result", url: "https://www.tripadvisor.co.uk/b", title: "t" }] }),
  ];

  it("counts every source entry, shares, answers per domain, group totals and lists unplaced domains", () => {
    const s = summarizeSources(answers, [anthropic, openai], CATS);
    const o = s.engines.find((e) => e.engine_id === "openai")!;
    expect(o).toMatchObject({ kind: "cited", answers: 2, answersWithSources: 2, total: 4, distinctDomains: 3 });
    expect(o.domains[0]).toMatchObject({ domain: "hoteltriglavbled.si", count: 2, answers: 1, category: "official_hotel" });
    expect(o.domains[0].share).toBeCloseTo(0.5);
    expect(Object.fromEntries(o.categories.map((c) => [c.id, c.count]))).toMatchObject({ official_hotel: 2, ota: 1, other: 1 });
    const a = s.engines.find((e) => e.engine_id === "anthropic")!;
    expect(a).toMatchObject({ kind: "retrieved", total: 2 });
    expect(Object.fromEntries(a.categories.map((c) => [c.id, c.count])).reviews).toBe(2);
    expect(s.unclassified.map((u) => u.domain)).toEqual(["unknown.example"]);
    expect(s.unclassified[0].engines).toEqual(["openai"]);
  });

  it("reads OpenAI passage positions and leaves Claude sources without positions", () => {
    expect(sourceItems(openai, answers[0])[0]).toMatchObject({ kind: "cited", start: 1, end: 2, domain: "hoteltriglavbled.si" });
    expect(sourceItems(anthropic, answers[2])[0]).toMatchObject({ kind: "retrieved", start: null });
  });
});

describe("linking sources to hotels (nothing is guessed)", () => {
  const hotels = [named("Hotel Triglav Bled"), named("Rikli Balance Hotel"), named("Grand Hotel Toplice")];
  const answer = [
    "### 1. Hotel Triglav Bled",                          // 0
    "A quiet boutique stay. (cite-a)",                    // line 1
    "",
    "**Rikli Balance Hotel** and Grand Hotel Toplice are bigger. (cite-b)", // two hotels in one line
    "",
    "### 3. Grand Hotel Toplice — spa",
    "The spa is small. (cite-c)",
    "",
    "Some general advice without a hotel. (cite-d)",
  ].join("\n");
  const at = (s: string) => answer.indexOf(s);

  it("links by title/URL, by the passage line, by the heading above, and refuses ambiguous or hotel-less ones", () => {
    const r = linkSources([
      item("https://www.hoteltriglavbled.si/en/", "Home", at("(cite-a)")),                       // title/URL names one hotel
      item("https://example.org/page", "Something", at("(cite-a)")),                              // passage line is under the Triglav heading? line itself has no name -> heading
      item("https://example.org/two", "Something", at("(cite-b)")),                               // line names two hotels -> ambiguous
      item("https://example.org/spa", "Spa", at("(cite-c)")),                                     // line has no name, heading names Toplice
      item("https://example.org/gen", "General", at("(cite-d)")),                                 // nothing named, heading above names Toplice but the line is after a blank line under it
      item("https://example.org/r", "Hotels", null),                                              // Claude-style: no passage, title names nobody
      item("https://www.tripadvisor.com/Rikli_Balance_Hotel", "Rikli Balance Hotel reviews", null), // Claude-style linked by title
      item("https://example.org/both", "Grand Hotel Toplice vs Rikli Balance Hotel", null),       // title names two -> ambiguous
    ], answer, hotels);
    const by = (u: string) => r.linked.find((l) => l.item.url === u);
    expect(by("https://www.hoteltriglavbled.si/en/")).toMatchObject({ hotel: "Hotel Triglav Bled", basis: "title/URL" });
    expect(by("https://example.org/page")).toMatchObject({ hotel: "Hotel Triglav Bled", basis: "section heading" });
    expect(by("https://example.org/spa")).toMatchObject({ hotel: "Grand Hotel Toplice", basis: "section heading" });
    expect(by("https://www.tripadvisor.com/Rikli_Balance_Hotel")).toMatchObject({ hotel: "Rikli Balance Hotel", basis: "title/URL" });
    expect(r.ambiguous.map((x) => x.url).sort()).toEqual(["https://example.org/both", "https://example.org/two"]);
    expect(r.unlinked.map((x) => x.url)).toContain("https://example.org/r");
  });

  it("a hotel named in the line wins over the heading (basis 'passage')", () => {
    const text = "### Overview\nGrand Hotel Toplice is old. (cite)";
    const r = linkSources([item("https://example.org/x", "x", text.indexOf("(cite)"))], text, hotels);
    expect(r.linked[0]).toMatchObject({ hotel: "Grand Hotel Toplice", basis: "passage" });
  });
});

describe("sources per hotel and for the closed hotel", () => {
  const FACT: HotelFact = { name: "Grand Hotel Toplice", aliases: ["Toplice"], status: "closed", valid_until: "2027-09-01", source: "t", checked_on: "2026-10-18" };
  const closedLine = "**Important:** Grand Hotel Toplice is currently closed for renovation. (c1)";
  const text1 = ["### Where to stay", closedLine, "", "### Hotel Triglav Bled", "Nice. (c2)"].join("\n");
  const text2 = ["### Where to stay", "Grand Hotel Toplice is the classic choice. (c3)"].join("\n");
  const answers = [
    row(1, "openai", "D1", 1, text1, [cite("https://www.grandhoteltoplice.com/en", "Home | Grand Hotel Toplice", text1.indexOf("(c1)"), text1.indexOf("(c1)") + 4), cite("https://www.hoteltriglavbled.si/en/", "Hotel Triglav Bled", text1.indexOf("(c2)"), text1.indexOf("(c2)") + 4)]),
    row(2, "anthropic", "D1", 1, text2, { text_citations: [], search_results: [
      { type: "web_search_result", url: "https://www.tripadvisor.com/Hotel_Review-Grand_Hotel_Toplice-Bled", title: "Grand Hotel Toplice - Tripadvisor" },
      { type: "web_search_result", url: "https://www.booking.com/the-best-hotels", title: "The best hotels in Bled" },
    ] }),
  ];
  const resolved = new Map<number, Analysis>([[1, analysis("Grand Hotel Toplice", "Hotel Triglav Bled")], [2, analysis("Grand Hotel Toplice")]]);

  it("per hotel: counts linked, ambiguous and not-linkable sources separately", () => {
    const [h] = sourcesPerHotel(answers, resolved, [anthropic, openai], ["Grand Hotel Toplice"], { ...cfg, sourceCategories: CATS });
    const a = h.perEngine.find((e) => e.engine_id === "anthropic")!;
    expect(a).toMatchObject({ answers: 1, totalSources: 2, linked: 1, unlinked: 1 });
    expect(a.domains[0]).toMatchObject({ domain: "tripadvisor.com", category: "reviews" });
    const o = h.perEngine.find((e) => e.engine_id === "openai")!;
    expect(o).toMatchObject({ answers: 1, totalSources: 2, linked: 1 });
    expect(o.domains[0]).toMatchObject({ domain: "grandhoteltoplice.com", category: "official_hotel" });
  });

  it("closed hotel: which source stands behind the engine's own closure remark, and whether an official source was linked", () => {
    const [anth, open] = sourcesOfClosedHotel(answers, resolved, [anthropic, openai], FACT, { ...cfg, sourceCategories: CATS });
    expect(open.mentions[0]).toMatchObject({ closureCitedBy: ["grandhoteltoplice.com"], officialSiteCited: true });
    expect(open.withOfficialHotelSource).toBe(1);
    expect(anth.mentions[0]).toMatchObject({ closureLine: null, closureCitedBy: [], officialSiteCited: false });
    expect(anth.withOfficialHotelSource).toBe(0);
    expect(anth.linkedDomains[0]).toMatchObject({ domain: "tripadvisor.com", category: "reviews" });
  });
});
