import { nameKey } from "./aggregate";
import type { DestAnswerRow } from "./db";
import type { Analysis } from "./schemas";

export interface StabilityRow {
  question_id: string;
  reps: number;
  /** hotels named in every repetition (display names) */
  inAll: string[];
  /** hotels named in exactly two repetitions / exactly one */
  twice: number;
  once: number;
  /** all different hotels named in any repetition */
  union: number;
}

export interface EngineStability { engine_id: string; rows: StabilityRow[]; totalInAll: number; totalTwice: number; totalOnce: number }

/** Per engine and question: which hotels come back in every repetition, in two, or in only one. Needs analyses after name unification. */
export function stability(answers: DestAnswerRow[], analyses: Map<number, Analysis>): EngineStability[] {
  const engines = [...new Set(answers.map((a) => a.job.engine_id))].sort();
  const questions = [...new Set(answers.map((a) => a.job.question_id))].sort();
  return engines.map((engine_id) => {
    const rows: StabilityRow[] = [];
    for (const q of questions) {
      const reps = answers.filter((a) => a.job.engine_id === engine_id && a.job.question_id === q);
      if (!reps.length) continue;
      const sets = reps.map((a) => new Map((analyses.get(a.job.job_id)?.hotels ?? []).map((h) => [nameKey(h.name), h.name] as [string, string])));
      const names = new Map<string, string>();
      for (const s of sets) for (const [k, v] of s) if (!names.has(k)) names.set(k, v);
      const count = (k: string) => sets.filter((s) => s.has(k)).length;
      const keys = [...names.keys()];
      rows.push({
        question_id: q, reps: reps.length, union: keys.length,
        inAll: keys.filter((k) => count(k) === reps.length).map((k) => names.get(k)!),
        twice: keys.filter((k) => count(k) === 2 && reps.length > 2).length,
        once: keys.filter((k) => count(k) === 1 && reps.length > 1).length,
      });
    }
    return { engine_id, rows, totalInAll: rows.reduce((s, r) => s + r.inAll.length, 0), totalTwice: rows.reduce((s, r) => s + r.twice, 0), totalOnce: rows.reduce((s, r) => s + r.once, 0) };
  });
}

export interface TopRow { name: string; recommended: number; mentions: number }
export interface TopList { scope: string; answers: number; rows: TopRow[] }

/** Hotels recommended in the most answers ("all" and per engine). A hotel counts once per answer. */
export function topHotels(answers: DestAnswerRow[], analyses: Map<number, Analysis>, limit = 10): TopList[] {
  const engines = [...new Set(answers.map((a) => a.job.engine_id))].sort();
  return ["all", ...engines].map((scope) => {
    const inScope = answers.filter((a) => scope === "all" || a.job.engine_id === scope);
    const acc = new Map<string, TopRow>();
    for (const a of inScope) {
      const seen = new Set<string>();
      for (const h of analyses.get(a.job.job_id)?.hotels ?? []) {
        const k = nameKey(h.name);
        if (seen.has(k)) continue;
        seen.add(k);
        const row = acc.get(k) ?? { name: h.name, recommended: 0, mentions: 0 };
        row.mentions++;
        if (h.sentiment === "recommended") row.recommended++;
        acc.set(k, row);
      }
    }
    const rows = [...acc.values()].sort((x, y) => y.recommended - x.recommended || y.mentions - x.mentions || x.name.localeCompare(y.name)).slice(0, limit);
    return { scope, answers: inScope.length, rows };
  });
}
