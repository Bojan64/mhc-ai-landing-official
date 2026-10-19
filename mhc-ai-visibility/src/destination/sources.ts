import { CITATION_NORMALIZERS } from "../engines";
import { hostOf, type SourceRef } from "../engines/types";
import type { Engine } from "../config/schemas";
import type { DestinationConfig } from "./config";
import type { DestAnswerRow } from "./db";
import { findClosureLine } from "./facts";
import type { Analysis, HotelFact, SourceCategory } from "./schemas";

// ---------------- domain groups ----------------

export const OTHER = "other";

/** Group of a domain: first config group with a matching entry, else "other". */
export function categoryOf(domain: string | null, cats: SourceCategory[]): string {
  if (!domain) return OTHER;
  const host = domain.toLowerCase().replace(/^www\./, "");
  for (const c of cats) {
    for (const raw of c.domains) {
      const ok = raw.endsWith(".") ? host.startsWith(raw) || host.includes(`.${raw}`) : host === raw || host.endsWith(`.${raw}`);
      if (ok) return c.id;
    }
  }
  return OTHER;
}

// ---------------- reading the stored citations ----------------

/** One cited or retrieved source of one answer. `start`/`end` (OpenAI only): where the cited passage lies in the answer text. */
export interface SourceItem extends SourceRef { start: number | null; end: number | null }

export function sourceItems(engine: Engine, answer: DestAnswerRow): SourceItem[] {
  let raw: unknown;
  try { raw = JSON.parse(answer.api_citations_json); } catch { return []; }
  if (engine.provider === "openai") {
    return ((raw as { type?: string; url?: string; title?: string; start_index?: number; end_index?: number }[]) ?? [])
      .filter((c) => c.url)
      .map((c) => ({ url: c.url!, title: c.title ?? null, domain: hostOf(c.url!), kind: "cited" as const, start: c.start_index ?? null, end: c.end_index ?? null }));
  }
  return CITATION_NORMALIZERS[engine.provider](raw).map((r) => ({ ...r, start: null, end: null }));
}

// ---------------- per engine: domains and groups ----------------

export interface DomainRow { domain: string; count: number; answers: number; share: number; category: string }
export interface CategoryRow { id: string; label: string; count: number; share: number; domains: number }
export interface EngineSources {
  engine_id: string;
  /** "cited" = tied to a passage of the answer; "retrieved" = returned by the engine's search for this answer. */
  kind: "cited" | "retrieved" | "mixed";
  answers: number;
  answersWithSources: number;
  total: number;
  distinctDomains: number;
  domains: DomainRow[];
  categories: CategoryRow[];
}
export interface Unclassified { domain: string; count: number; engines: string[]; sampleTitle: string | null }

const plainText = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function summarizeSources(
  answers: DestAnswerRow[], engines: Engine[], cats: SourceCategory[],
): { engines: EngineSources[]; unclassified: Unclassified[] } {
  const labels = new Map<string, string>([...cats.map((c) => [c.id, c.label] as [string, string]), [OTHER, "drugo"]]);
  const out: EngineSources[] = [];
  const un = new Map<string, Unclassified>();
  for (const e of engines) {
    const mine = answers.filter((a) => a.job.engine_id === e.engine_id);
    const dom = new Map<string, { count: number; answers: Set<number> }>();
    const kinds = new Set<string>();
    let total = 0;
    let withAny = 0;
    for (const a of mine) {
      const items = sourceItems(e, a);
      if (items.length) withAny++;
      for (const it of items) {
        total++;
        kinds.add(it.kind);
        const d = it.domain ?? "(unknown)";
        const x = dom.get(d) ?? { count: 0, answers: new Set() };
        x.count++;
        x.answers.add(a.job.job_id);
        dom.set(d, x);
        if (categoryOf(it.domain, cats) === OTHER) {
          const u = un.get(d) ?? { domain: d, count: 0, engines: [], sampleTitle: it.title };
          u.count++;
          if (!u.engines.includes(e.engine_id)) u.engines.push(e.engine_id);
          un.set(d, u);
        }
      }
    }
    const domains: DomainRow[] = [...dom.entries()]
      .map(([domain, x]) => ({ domain, count: x.count, answers: x.answers.size, share: total ? x.count / total : 0, category: categoryOf(domain, cats) }))
      .sort((p, q) => q.count - p.count || p.domain.localeCompare(q.domain));
    const byCat = new Map<string, { count: number; domains: number }>();
    for (const d of domains) {
      const c = byCat.get(d.category) ?? { count: 0, domains: 0 };
      c.count += d.count;
      c.domains++;
      byCat.set(d.category, c);
    }
    const categories: CategoryRow[] = [...labels.keys()].map((id) => ({
      id, label: labels.get(id)!, count: byCat.get(id)?.count ?? 0, share: total ? (byCat.get(id)?.count ?? 0) / total : 0, domains: byCat.get(id)?.domains ?? 0,
    }));
    out.push({
      engine_id: e.engine_id, answers: mine.length, answersWithSources: withAny, total, distinctDomains: domains.length, domains, categories,
      kind: kinds.size > 1 ? "mixed" : (([...kinds][0] as "cited" | "retrieved") ?? "cited"),
    });
  }
  return { engines: out, unclassified: [...un.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain)) };
}

// ---------------- linking sources to hotels ----------------

/** Spellings of one hotel for text matching: its canonical name, confirmed aliases and (for closed hotels) the facts names. */
export function termsFor(hotel: string, cfg: DestinationConfig): string[] {
  const names = new Set<string>([hotel]);
  const key = plainText(hotel);
  for (const g of cfg.aliases.groups) if ([g.canonical, ...g.aliases].some((n) => plainText(n) === key)) [g.canonical, ...g.aliases].forEach((n) => names.add(n));
  for (const f of cfg.facts) if ([f.name, ...f.aliases].some((n) => plainText(n) === key) || [...names].some((n) => plainText(n) === plainText(f.name))) [f.name, ...f.aliases].forEach((n) => names.add(n));
  return [...names].map(plainText).filter((t) => t.length >= 4);
}

const hasTerm = (text: string, terms: string[]) => terms.some((t) => ` ${text} `.includes(` ${t} `));

export type LinkBasis = "title/URL" | "passage" | "section heading";
export interface Linked { item: SourceItem; hotel: string; basis: LinkBasis }
export interface LinkResult {
  linked: Linked[];
  /** matches several hotels (title, passage or heading names more than one): NOT attributed */
  ambiguous: SourceItem[];
  /** no hotel found in title, URL, passage or heading: NOT attributed */
  unlinked: SourceItem[];
}

/**
 * Which hotel does each source of this answer belong to? Only three reliable signals are used, nothing is guessed:
 * 1. the source's title or URL names exactly one hotel of the answer;
 * 2. (OpenAI only, where a citation points at a passage) the line of the answer that holds the cited passage names exactly one hotel;
 * 3. (same) that line names none, but the nearest markdown heading above it names exactly one.
 * Claude's search results are not tied to a passage, so they can only be linked by signal 1.
 */
export function linkSources(items: SourceItem[], answer: string, hotels: { name: string; terms: string[] }[]): LinkResult {
  const res: LinkResult = { linked: [], ambiguous: [], unlinked: [] };
  const lines = answer.split("\n");
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
  const lineAt = (idx: number) => { let k = 0; for (let i = 0; i < offsets.length; i++) if (offsets[i] <= idx) k = i; return k; };
  const named = (text: string) => hotels.filter((h) => hasTerm(plainText(text), h.terms));
  // A web address often runs the words together (hoteltriglavbled.si, grandhoteltoplice.com): compare without spaces as well.
  const compact = (s: string) => plainText(s).replace(/ /g, "");
  const namedInUrl = (url: string) => {
    const u = url.replace(/^https?:\/\//, "").replace(/\?.*$/, "");
    return hotels.filter((h) => hasTerm(plainText(u), h.terms) || h.terms.some((t) => compact(t).length >= 9 && compact(u).includes(compact(t))));
  };

  for (const it of items) {
    const byTitle = [...new Map([...named(it.title ?? ""), ...namedInUrl(it.url)].map((h) => [h.name, h])).values()];
    if (byTitle.length === 1) { res.linked.push({ item: it, hotel: byTitle[0].name, basis: "title/URL" }); continue; }
    if (byTitle.length > 1) { res.ambiguous.push(it); continue; }
    if (it.start === null) { res.unlinked.push(it); continue; }
    const li = lineAt(Math.max(0, it.start));
    const inLine = named(lines[li] ?? "");
    if (inLine.length === 1) { res.linked.push({ item: it, hotel: inLine[0].name, basis: "passage" }); continue; }
    if (inLine.length > 1) { res.ambiguous.push(it); continue; }
    let h = li;
    while (h >= 0 && !/^\s{0,3}#{1,6}\s/.test(lines[h] ?? "")) h--;
    const inHead = h >= 0 ? named(lines[h]) : [];
    if (inHead.length === 1) res.linked.push({ item: it, hotel: inHead[0].name, basis: "section heading" });
    else if (inHead.length > 1) res.ambiguous.push(it);
    else res.unlinked.push(it);
  }
  return res;
}

// ---------------- per hotel (for the top list) ----------------

export interface HotelEngineSources {
  engine_id: string;
  /** answers that name the hotel */
  answers: number;
  /** sources of those answers, all */
  totalSources: number;
  linked: number;
  byBasis: Record<LinkBasis, number>;
  ambiguous: number;
  unlinked: number;
  domains: { domain: string; count: number; category: string }[];
  categories: Record<string, number>;
}
export interface HotelSources { hotel: string; perEngine: HotelEngineSources[] }

function hotelsOf(a: Analysis | undefined, cfg: DestinationConfig) {
  return (a?.hotels ?? []).map((h) => ({ name: h.name, terms: termsFor(h.name, cfg) }));
}

export function sourcesPerHotel(
  answers: DestAnswerRow[], resolved: Map<number, Analysis>, engines: Engine[], hotelNames: string[], cfg: DestinationConfig,
): HotelSources[] {
  const key = (s: string) => plainText(s);
  return hotelNames.map((hotel) => ({
    hotel,
    perEngine: engines.map((e) => {
      const row: HotelEngineSources = { engine_id: e.engine_id, answers: 0, totalSources: 0, linked: 0, byBasis: { "title/URL": 0, passage: 0, "section heading": 0 }, ambiguous: 0, unlinked: 0, domains: [], categories: {} };
      const dom = new Map<string, number>();
      for (const a of answers.filter((x) => x.job.engine_id === e.engine_id)) {
        const an = resolved.get(a.job.job_id);
        if (!an?.hotels.some((h) => key(h.name) === key(hotel))) continue;
        row.answers++;
        const items = sourceItems(e, a);
        row.totalSources += items.length;
        const r = linkSources(items, a.raw_answer, hotelsOf(an, cfg));
        row.ambiguous += r.ambiguous.length;
        row.unlinked += r.unlinked.length;
        for (const l of r.linked) {
          if (key(l.hotel) !== key(hotel)) continue;
          row.linked++;
          row.byBasis[l.basis]++;
          dom.set(l.item.domain ?? "(unknown)", (dom.get(l.item.domain ?? "(unknown)") ?? 0) + 1);
        }
      }
      row.domains = [...dom.entries()].map(([domain, count]) => ({ domain, count, category: categoryOf(domain, cfg.sourceCategories) })).sort((p, q) => q.count - p.count || p.domain.localeCompare(q.domain));
      for (const d of row.domains) row.categories[d.category] = (row.categories[d.category] ?? 0) + d.count;
      return row;
    }),
  }));
}

// ---------------- Grand Hotel Toplice (closed) ----------------

export interface TopliceMention {
  question_id: string; repetition: number; sentiment: string;
  /** the answer's line that says the hotel is closed (heuristic), or null */
  closureLine: string | null;
  /** domains of the sources whose cited passage IS the closure line (OpenAI only) */
  closureCitedBy: string[];
  linked: { domain: string; category: string; basis: LinkBasis }[];
  /** all sources of the answer, grouped by domain */
  allSources: number;
  officialSiteCited: boolean;
}
export interface TopliceEngine {
  engine_id: string;
  mentions: TopliceMention[];
  /** mentions in whose answer a source of the hotel's own domain (official_hotel group, naming the hotel) is present */
  withOfficialHotelSource: number;
  /** domains linked to the hotel over all mentions */
  linkedDomains: { domain: string; count: number; mentions: number; category: string }[];
  /** domains of all sources in the mention answers, top */
  allDomains: { domain: string; count: number; category: string }[];
}

export function sourcesOfClosedHotel(
  answers: DestAnswerRow[], resolved: Map<number, Analysis>, engines: Engine[], fact: HotelFact, cfg: DestinationConfig,
): TopliceEngine[] {
  const names = [fact.name, ...fact.aliases].map(plainText);
  return engines.map((e) => {
    const mentions: TopliceMention[] = [];
    const linkedDom = new Map<string, { count: number; mentions: Set<number> }>();
    const allDom = new Map<string, number>();
    for (const a of answers.filter((x) => x.job.engine_id === e.engine_id).sort((p, q) => p.job.question_id.localeCompare(q.job.question_id) || p.job.repetition - q.job.repetition)) {
      const an = resolved.get(a.job.job_id);
      const h = an?.hotels.find((x) => names.includes(plainText(x.name)));
      if (!h) continue;
      const items = sourceItems(e, a);
      const r = linkSources(items, a.raw_answer, hotelsOf(an, cfg));
      const mine = r.linked.filter((l) => plainText(l.hotel) === plainText(h.name));
      const closureLine = findClosureLine(a.raw_answer, fact);
      const closureCitedBy: string[] = [];
      if (closureLine && e.provider === "openai") {
        for (const it of items) {
          if (it.start === null) continue;
          const lineStart = a.raw_answer.lastIndexOf("\n", it.start) + 1;
          const lineEnd = a.raw_answer.indexOf("\n", it.start);
          const line = a.raw_answer.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
          if (line === closureLine && it.domain && !closureCitedBy.includes(it.domain)) closureCitedBy.push(it.domain);
        }
      }
      for (const l of mine) {
        const d = l.item.domain ?? "(unknown)";
        const x = linkedDom.get(d) ?? { count: 0, mentions: new Set<number>() };
        x.count++;
        x.mentions.add(a.job.job_id);
        linkedDom.set(d, x);
      }
      for (const it of items) allDom.set(it.domain ?? "(unknown)", (allDom.get(it.domain ?? "(unknown)") ?? 0) + 1);
      mentions.push({
        question_id: a.job.question_id, repetition: a.job.repetition, sentiment: h.sentiment, closureLine, closureCitedBy,
        linked: mine.map((l) => ({ domain: l.item.domain ?? "(unknown)", category: categoryOf(l.item.domain, cfg.sourceCategories), basis: l.basis })),
        allSources: items.length,
        officialSiteCited: mine.some((l) => categoryOf(l.item.domain, cfg.sourceCategories) === "official_hotel"),
      });
    }
    return {
      engine_id: e.engine_id, mentions,
      withOfficialHotelSource: mentions.filter((m) => m.officialSiteCited).length,
      linkedDomains: [...linkedDom.entries()].map(([domain, x]) => ({ domain, count: x.count, mentions: x.mentions.size, category: categoryOf(domain, cfg.sourceCategories) })).sort((p, q) => q.mentions - p.mentions || q.count - p.count || p.domain.localeCompare(q.domain)),
      allDomains: [...allDom.entries()].map(([domain, count]) => ({ domain, count, category: categoryOf(domain, cfg.sourceCategories) })).sort((p, q) => q.count - p.count || p.domain.localeCompare(q.domain)).slice(0, 12),
    };
  });
}
