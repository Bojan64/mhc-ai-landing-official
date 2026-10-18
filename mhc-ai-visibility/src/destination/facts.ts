import { nameKey } from "./aggregate";
import type { DestAnswerRow } from "./db";
import type { Analysis, HotelFact } from "./schemas";

/**
 * Words that show an answer itself says a hotel is not available. Heuristic: only closure wording counts ("closed", "reopening",
 * "undergoing renovation"); a planned or past renovation or refurbishment alone ("a refurbishment was planned", "renovated in 2016") does not. The matching line is printed in the report to be checked by eye.
 */
const CLOSURE_RE = /\b(closed|closure|closes|closing|reopen\w*|re-open\w*|under (?:construction|renovation|refurbishment)|undergoing (?:renovation|refurbishment|works)|not (?:currently )?(?:open|operating))\b/i;

const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export interface ClosedItem {
  engine_id: string;
  question_id: string;
  repetition: number;
  sentiment: "recommended" | "neutral" | "not_recommended";
  /** Exact quote the sentiment rests on; empty for analyses from the first analyzer version. */
  quote: string;
  /** The line of the answer where the engine itself says the hotel is closed (heuristic), or null. */
  closureLine: string | null;
}

export interface ClosedEngineRow {
  engine_id: string;
  answers: number;
  mentioning: number;
  recommended: number;
  neutral: number;
  notRecommended: number;
  closureMentioned: number;
  /** Mentions of the hotel in answers that contain no closure warning at all. */
  namedWithoutWarning: number;
}

export interface ClosedAudit {
  fact: HotelFact;
  rows: ClosedEngineRow[];
  items: ClosedItem[];
}

/** Does this fact apply to an answer given on this date (YYYY-MM-DD)? */
export function factApplies(fact: HotelFact, answerDate: string): boolean {
  return fact.status === "closed" && (fact.valid_until === null || answerDate < fact.valid_until);
}

/** First line of the answer that names the hotel (or an alias) and says it is closed or being renovated. */
export function findClosureLine(answer: string, fact: HotelFact): string | null {
  const names = [fact.name, ...fact.aliases].map(plain);
  for (const line of answer.split("\n")) {
    const p = plain(line);
    if (names.some((n) => p.includes(n)) && CLOSURE_RE.test(line)) return line.trim();
  }
  return null;
}

/**
 * For every hand-checked fact with status "closed": how often each engine recommends (or neutrally mentions)
 * the hotel although it is closed, and how often the engine itself says it is closed.
 */
export function auditClosedHotels(answers: DestAnswerRow[], analyses: Map<number, Analysis>, facts: HotelFact[]): ClosedAudit[] {
  const engines = [...new Set(answers.map((a) => a.job.engine_id))].sort();
  return facts.filter((f) => f.status === "closed").map((fact) => {
    const keys = new Set([fact.name, ...fact.aliases].map(nameKey));
    const rows = new Map<string, ClosedEngineRow>(engines.map((e) => [e, {
      engine_id: e, answers: 0, mentioning: 0, recommended: 0, neutral: 0, notRecommended: 0, closureMentioned: 0, namedWithoutWarning: 0,
    }]));
    const items: ClosedItem[] = [];
    for (const a of answers) {
      if (!factApplies(fact, a.created_at.slice(0, 10))) continue;
      const row = rows.get(a.job.engine_id)!;
      row.answers++;
      const hotel = analyses.get(a.job.job_id)?.hotels.find((h) => keys.has(nameKey(h.name)));
      if (!hotel) continue;
      row.mentioning++;
      if (hotel.sentiment === "recommended") row.recommended++;
      else if (hotel.sentiment === "neutral") row.neutral++;
      else row.notRecommended++;
      const closureLine = findClosureLine(a.raw_answer, fact);
      if (closureLine) row.closureMentioned++;
      else row.namedWithoutWarning++;
      items.push({
        engine_id: a.job.engine_id, question_id: a.job.question_id, repetition: a.job.repetition,
        sentiment: hotel.sentiment, quote: hotel.sentiment_quote, closureLine,
      });
    }
    return { fact, rows: [...rows.values()], items };
  });
}
