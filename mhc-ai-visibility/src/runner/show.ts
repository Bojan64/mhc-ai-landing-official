import type { AppConfig } from "../config/load";
import type { DB } from "../db/db";
import { selectResponses } from "../db/repository";
import { CITATION_NORMALIZERS } from "../engines";

/** Print stored answers with their sources (for checking smoke tests by eye). */
export function showResponses(
  db: DB,
  config: AppConfig,
  runId: string,
  f: { engine?: string; hotel?: string; limit?: number; maxChars?: number },
  log: (s: string) => void = console.log,
): number {
  const providers = new Map(config.engines.engines.map((e) => [e.engine_id, e.provider]));
  const rows = selectResponses(db, runId, f);
  const perEngine = new Map<string, number>();
  let shown = 0;
  for (const r of rows) {
    const n = perEngine.get(r.job.engine_id) ?? 0;
    if (f.limit && n >= f.limit) continue;
    perEngine.set(r.job.engine_id, n + 1);
    shown++;
    const j = r.job;
    const sources = CITATION_NORMALIZERS[providers.get(j.engine_id)!](JSON.parse(r.api_citations_json));
    const answer = f.maxChars && r.raw_answer.length > f.maxChars ? `${r.raw_answer.slice(0, f.maxChars)} …[cut]` : r.raw_answer;
    log("═".repeat(80));
    log(`#${j.job_id}  ${j.engine_id} (${j.model}) · ${j.mode} · ${j.hotel_id} · ${j.prompt_id} · rep ${j.repetition}`);
    log(`Q: ${j.prompt_text_rendered}`);
    log(`tokens ${r.input_tokens ?? "?"}/${r.output_tokens ?? "?"} · searches ${r.search_count ?? 0} · ${r.latency_ms ?? "?"} ms · $${(r.cost_estimate ?? 0).toFixed(4)}`);
    log("─".repeat(80));
    log(answer || "(empty answer)");
    log("─".repeat(80));
    log(`Sources (${sources.length}):`);
    for (const s of sources) log(`  - ${s.kind === "cited" ? "cited    " : "retrieved"} [${s.domain ?? "?"}] ${s.title ?? ""} ${s.url}`);
  }
  if (shown === 0) log(`No stored answers found for run "${runId}".`);
  return shown;
}
