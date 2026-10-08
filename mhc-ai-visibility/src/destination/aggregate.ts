import type { SourceDomains } from "../config/schemas";
import { hostOf } from "../engines/types";
import type { Analysis, AnalyzedHotel, Destination } from "./schemas";

// ---------------- links and domains ----------------

export type DomainType = "ota" | "metasearch" | "review" | "tourism_board" | "other";

/**
 * Classify a URL with source-domains.json. A pattern ending in "." matches any ending
 * (expedia. = expedia.com, expedia.de ...); a pattern with "/" also checks the path.
 */
export function classifyUrl(url: string, domains: SourceDomains): DomainType {
  let host: string | null;
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "").toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    host = hostOf(url);
  }
  if (!host) return "other";
  for (const type of ["ota", "metasearch", "review", "tourism_board"] as const) {
    for (const raw of domains[type]) {
      const pat = raw.toLowerCase();
      const [patHost, ...pathParts] = pat.split("/");
      const patPath = pathParts.length ? `/${pathParts.join("/")}` : "";
      const hostOk = patHost.endsWith(".")
        ? host.startsWith(patHost) || host.includes(`.${patHost}`)
        : host === patHost || host.endsWith(`.${patHost}`);
      if (hostOk && (!patPath || path.startsWith(patPath))) return type;
    }
  }
  return "other";
}

/** URLs written in the answer text (markdown links and bare URLs), de-duplicated. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s)\]>"'<]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

// ---------------- names ----------------

const STOP = new Set(["hotel", "the", "and", "d", "o", "by", "&"]);
const GENERIC = new Set(["villa", "vila", "lake", "grand", "park", "resort", "garni", "apartments", "apartment", "house", "inn", "pension", "penzion"]);

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

export const nameKey = (name: string) => nameTokens(name).join(" ");

/** True if A's tokens are all inside B's (and A is specific enough to be worth a warning). */
function isSubName(a: string[], b: string[]): boolean {
  if (a.length >= b.length) return false;
  if (!a.every((t) => b.includes(t))) return false;
  return a.length >= 2 || (a.length === 1 && a[0].length >= 5 && !GENERIC.has(a[0]));
}

// ---------------- aggregation ----------------

export interface AnswerForAggregation {
  job_id: number;
  engine_id: string;
  question_id: string;
  repetition: number;
  analysis: Analysis;
  /** Text of the retrieved/cited sources of this answer (titles, URLs, domains), lower-cased. */
  sourceText: string;
  hasSources: boolean;
}

export interface HotelRow {
  key: string;
  name: string;
  variants: string[];
  /** Number of answers that mention the hotel (counted once per answer). */
  mentions: number;
  recommended: number;
  byEngine: Record<string, number>;
  byQuestion: Record<string, number>;
  avgPosition: number;
  /** Booking target per mention: how often the answer pointed to each. */
  booking: Record<AnalyzedHotel["booking_target"], number>;
  locations: string[];
  flags: string[];
}

export interface Aggregation {
  totalAnswers: number;
  answersWithNoHotels: number;
  engines: string[];
  hotels: HotelRow[];
}

export function aggregate(answers: AnswerForAggregation[], dest: Destination): Aggregation {
  const engines = [...new Set(answers.map((a) => a.engine_id))].sort();
  type Acc = {
    names: Map<string, number>; answerIds: Set<number>; recommended: number;
    byEngine: Record<string, number>; byQuestion: Record<string, number>;
    positions: number[]; booking: HotelRow["booking"]; locations: Set<string>; nullLocations: number; badLocations: Set<string>;
    supported: boolean; anySourcesSeen: boolean;
  };
  const accs = new Map<string, Acc>();
  let noHotels = 0;

  for (const a of answers) {
    if (a.analysis.hotels.length === 0) noHotels++;
    const seenInAnswer = new Set<string>();
    a.analysis.hotels.forEach((h, i) => {
      const key = nameKey(h.name);
      if (!key) return;
      let acc = accs.get(key);
      if (!acc) {
        acc = {
          names: new Map(), answerIds: new Set(), recommended: 0, byEngine: {}, byQuestion: {}, positions: [],
          booking: { hotel_site: 0, ota: 0, other_link: 0, none: 0 }, locations: new Set(), nullLocations: 0, badLocations: new Set(),
          supported: false, anySourcesSeen: false,
        };
        accs.set(key, acc);
      }
      acc.names.set(h.name, (acc.names.get(h.name) ?? 0) + 1);
      if (seenInAnswer.has(key)) return; // a hotel counts once per answer (its first mention)
      seenInAnswer.add(key);
      acc.answerIds.add(a.job_id);
      if (h.recommended) acc.recommended++;
      acc.byEngine[a.engine_id] = (acc.byEngine[a.engine_id] ?? 0) + 1;
      acc.byQuestion[a.question_id] = (acc.byQuestion[a.question_id] ?? 0) + 1;
      acc.positions.push(i + 1);
      acc.booking[h.booking_target]++;
      if (h.location_stated) {
        acc.locations.add(h.location_stated);
        const loc = h.location_stated.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        if (!dest.location_match.some((m) => loc.includes(m.toLowerCase()))) acc.badLocations.add(h.location_stated);
      } else acc.nullLocations++;
      if (a.hasSources) {
        acc.anySourcesSeen = true;
        const toks = nameTokens(h.name).filter((t) => t.length >= 3 && !dest.location_match.includes(t));
        if (toks.length && toks.every((t) => a.sourceText.includes(t))) acc.supported = true;
      }
    });
  }

  const keys = [...accs.keys()];
  const hotels: HotelRow[] = keys.map((key) => {
    const acc = accs.get(key)!;
    const names = [...acc.names.entries()].sort((x, y) => y[1] - x[1]);
    const mentions = acc.answerIds.size;
    const flags: string[] = [];
    if (mentions === 1) flags.push("only in 1 answer");
    if (Object.keys(acc.byEngine).length === 1 && engines.length > 1) flags.push("only one engine");
    if (acc.badLocations.size) flags.push(`location differs: ${[...acc.badLocations].join(" / ")}`);
    else if (acc.nullLocations === mentions) flags.push("location never stated");
    if (acc.anySourcesSeen && !acc.supported) flags.push("name not found in any source");
    const toks = key.split(" ");
    for (const other of keys) {
      if (other === key) continue;
      const ot = other.split(" ");
      if (isSubName(toks, ot) || isSubName(ot, toks)) flags.push(`maybe same as "${[...accs.get(other)!.names.entries()].sort((x, y) => y[1] - x[1])[0][0]}"`);
    }
    return {
      key, name: names[0][0], variants: names.map((n) => n[0]), mentions, recommended: acc.recommended,
      byEngine: acc.byEngine, byQuestion: acc.byQuestion,
      avgPosition: acc.positions.reduce((s, p) => s + p, 0) / acc.positions.length,
      booking: acc.booking, locations: [...acc.locations], flags,
    };
  });
  hotels.sort((a, b) => b.mentions - a.mentions || a.avgPosition - b.avgPosition || a.name.localeCompare(b.name));
  return { totalAnswers: answers.length, answersWithNoHotels: noHotels, engines, hotels };
}
