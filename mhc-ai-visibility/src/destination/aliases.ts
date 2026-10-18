import { nameKey } from "./aggregate";
import type { AliasesFile, Analysis, AnalyzedHotel } from "./schemas";

export const EMPTY_ALIASES: AliasesFile = { groups: [], exclusions: [], overrides: [], keep_separate: [] };

/** Problems that make the alias file contradict itself (one spelling in two groups, a separate pair merged, ...). */
export function checkAliases(a: AliasesFile): string[] {
  const errors: string[] = [];
  const owner = new Map<string, string>(); // name key -> canonical of its group
  for (const g of a.groups) {
    for (const n of [g.canonical, ...g.aliases]) {
      const k = nameKey(n);
      const prev = owner.get(k);
      if (prev && prev !== g.canonical) errors.push(`destination-aliases.json: "${n}" is in two groups ("${prev}" and "${g.canonical}")`);
      owner.set(k, g.canonical);
    }
  }
  for (const x of a.exclusions) {
    const k = nameKey(x.name);
    if (owner.has(k)) errors.push(`destination-aliases.json: "${x.name}" is both excluded and in the group "${owner.get(k)}"`);
  }
  for (const s of a.keep_separate) {
    const groups = new Set(s.names.map((n) => owner.get(nameKey(n)) ?? `#${nameKey(n)}`));
    if (groups.size < s.names.length) errors.push(`destination-aliases.json: keep_separate [${s.names.join(" / ")}] but they are merged into one group`);
  }
  return errors;
}

export interface AppliedOverride { run: string; engine_id: string; question_id: string; repetition: number; hotel: string; from: string; to: string; reason: string }
export interface AliasSummary {
  /** group canonical -> mentions that were renamed to it */
  renamed: Record<string, number>;
  /** second and later spellings of one hotel inside one answer that were folded into the first */
  mergedInAnswer: number;
  /** excluded name -> mentions left out */
  excluded: Record<string, number>;
  applied: AppliedOverride[];
  /** overrides that did not match (answer or value not found): shown in the report, never silent */
  notApplied: string[];
}

export function newAliasSummary(): AliasSummary {
  return { renamed: {}, mergedInAnswer: 0, excluded: {}, applied: [], notApplied: [] };
}

export interface AnswerRef { run: string; engine_id: string; question_id: string; repetition: number }

/**
 * Applies the confirmed name unification to one analysis (for the report only; the stored analysis stays as it is):
 * excluded names are dropped, spellings are renamed to the group's canonical name, repeated spellings of one hotel in
 * one answer are folded into the first mention, a duplicate mark that now points at the same hotel is cleared, and
 * the owner's manual overrides are applied. Every action is counted in `summary`.
 */
export function resolveAnalysis(a: Analysis, ref: AnswerRef, al: AliasesFile, summary: AliasSummary): Analysis {
  const canon = new Map<string, string>();
  for (const g of al.groups) for (const n of [g.canonical, ...g.aliases]) canon.set(nameKey(n), g.canonical);
  const excluded = new Map(al.exclusions.map((x) => [nameKey(x.name), x.name]));
  const rename = (n: string) => canon.get(nameKey(n)) ?? n;

  const hotels: AnalyzedHotel[] = [];
  const seen = new Set<string>();
  for (const h of a.hotels) {
    const ex = excluded.get(nameKey(h.name));
    if (ex) { summary.excluded[ex] = (summary.excluded[ex] ?? 0) + 1; continue; }
    const name = rename(h.name);
    if (name !== h.name) summary.renamed[name] = (summary.renamed[name] ?? 0) + 1;
    const k = nameKey(name);
    if (seen.has(k)) { summary.mergedInAnswer++; continue; }
    seen.add(k);
    const dup = h.possible_duplicate_of ? rename(h.possible_duplicate_of) : null;
    hotels.push({ ...h, name, possible_duplicate_of: dup && nameKey(dup) !== k ? dup : null });
  }

  for (const o of al.overrides) {
    if (o.run !== ref.run || o.engine_id !== ref.engine_id || o.question_id !== ref.question_id || o.repetition !== ref.repetition) continue;
    const h = hotels.find((x) => nameKey(x.name) === nameKey(rename(o.hotel)));
    const label = `${o.run} ${o.engine_id} ${o.question_id} rep ${o.repetition} · ${o.hotel}`;
    if (!h) { summary.notApplied.push(`${label}: hotel not found in the analysis`); continue; }
    if (h.sentiment !== o.from) { summary.notApplied.push(`${label}: sentiment is "${h.sentiment}", not "${o.from}"`); continue; }
    h.sentiment = o.to;
    summary.applied.push({ run: o.run, engine_id: o.engine_id, question_id: o.question_id, repetition: o.repetition, hotel: o.hotel, from: o.from, to: o.to, reason: o.reason });
  }
  return { ...a, hotels };
}
