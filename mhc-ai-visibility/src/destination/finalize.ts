import { nameTokens } from "./aggregate";
import { ANALYZER_VERSION, truncateQuote, type Analysis, type AnalyzedHotel, type ModelAnalysis } from "./schemas";

// ---------------- booking safety net ----------------

/**
 * Words that make booking_evidence an explicit pointer to book THIS accommodation (a verb or "official site" phrase).
 * "Booking.com" alone is not a cue, nor are a score, a number or a link in brackets.
 */
const POINTER_RE = /\b(book|reserve|reservations?|booking (?:site|page|link|engine)|start with|go to|head to|visit|contact|call|phone|e-?mail|enquir\w*|inquir\w*|official (?:\w+ ){0,3}(?:site|website|page)|on its (?:own |official )?(?:site|website|page)|through|via)\b/i;
const URL_RE = /https?:\/\/\S+/g;

/** Why booking_evidence is no explicit pointer (null = it is one). */
export function bookingEvidenceProblem(evidence: string | null): string | null {
  if (!evidence || !evidence.trim()) return "no booking_evidence was given";
  // strip markdown links, bare URLs and the brackets around them
  const words = evidence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, " ")
    .replace(URL_RE, " ")
    .replace(/[()[\]]/g, " ")
    .replace(/[^\p{L}\p{N}.%/ -]+/gu, " ")
    .trim();
  if (!/\p{L}/u.test(words)) return "the evidence is only a link in brackets (a source), not a pointer to book";
  if (POINTER_RE.test(evidence)) return null;
  if (/\d/.test(evidence)) return "the evidence is a rating or number, not a pointer to book";
  return "the evidence has no booking verb or pointer to book this accommodation";
}

/** Booking safety net: a target without an explicit pointer becomes "unspecified"; the model's value and the reason are kept. */
export function checkBooking(h: Pick<AnalyzedHotel, "booking_target" | "booking_evidence">): Pick<AnalyzedHotel, "booking_target" | "booking_evidence" | "booking_demoted" | "booking_demoted_from" | "booking_demoted_reason"> {
  if (h.booking_target === "unspecified") return { booking_target: "unspecified", booking_evidence: null, booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null };
  const problem = bookingEvidenceProblem(h.booking_evidence);
  if (!problem) return { booking_target: h.booking_target, booking_evidence: h.booking_evidence, booking_demoted: false, booking_demoted_from: null, booking_demoted_reason: null };
  return { booking_target: "unspecified", booking_evidence: h.booking_evidence, booking_demoted: true, booking_demoted_from: h.booking_target, booking_demoted_reason: problem };
}

// ---------------- possible duplicates ----------------

// Words that many names share and that say nothing about which place it is.
const GENERIC = new Set([
  "hotel", "hotels", "vila", "villa", "garni", "penzion", "pension", "pensione", "grand", "resort", "resorts", "apartment", "apartments",
  "house", "inn", "hostel", "lodge", "residence", "boutique", "spa", "wellness", "rooms", "room", "guesthouse", "camp", "camping",
  "glamping", "village", "lake", "park", "sava", "bed", "breakfast", "city", "old", "new", "alpine", "royal", "central", "best",
]);

/** Distinctive words of a name: not generic, not the destination, at least 3 letters. */
export function distinctiveTokens(name: string, destinationWords: string[]): string[] {
  const drop = new Set(destinationWords.flatMap((w) => nameTokens(w)));
  return nameTokens(name).filter((t) => t.length >= 3 && !GENERIC.has(t) && !drop.has(t));
}

/**
 * Hotels of one answer that share a distinctive part of the name are marked (both) for manual review.
 * Nothing is merged or removed. A mark the model already set is kept.
 */
export function markPossibleDuplicates<T extends { name: string; possible_duplicate_of: string | null }>(hotels: T[], destinationWords: string[]): T[] {
  const toks = hotels.map((h) => new Set(distinctiveTokens(h.name, destinationWords)));
  return hotels.map((h, i) => {
    if (h.possible_duplicate_of) return h;
    const j = hotels.findIndex((o, k) => k !== i && o.name !== h.name && [...toks[i]].some((t) => toks[k].has(t)));
    return j === -1 ? h : { ...h, possible_duplicate_of: hotels[j].name };
  });
}

// ---------------- model output → stored analysis ----------------

/**
 * Model output → stored analysis. The code (not the model) cuts over-long sentiment quotes, demotes booking pointers
 * that are no explicit instruction, marks possible duplicates, and stamps the analyzer version. None of this rejects the analysis.
 */
export function finalizeAnalysis(model: ModelAnalysis, destinationWords: string[] = []): Analysis {
  const hotels = model.hotels.map((h) => {
    const q = truncateQuote(h.sentiment_quote);
    return { ...h, ...checkBooking(h), sentiment_quote: q.quote, quote_truncated: q.truncated };
  });
  return { analyzer_version: ANALYZER_VERSION, no_hotels_reason: model.no_hotels_reason, hotels: markPossibleDuplicates(hotels, destinationWords) };
}
