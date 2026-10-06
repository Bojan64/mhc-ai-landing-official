import Perplexity from "@perplexity-ai/perplexity_ai";
import type { Engine } from "../config/schemas";
import { hostOf, type CitationNormalizer, type EngineAdapter, type EngineRequest, type EngineResult } from "./types";

/**
 * Perplexity Sonar (Chat Completions). Sonar always searches; we run it in web_search mode only.
 * Sources are in `search_results`. Perplexity reports the real cost of each call in `usage.cost`.
 */
export class PerplexityAdapter implements EngineAdapter {
  private client: Perplexity;

  constructor(readonly engine: Engine, private systemInstruction: string, apiKey: string) {
    this.client = new Perplexity({ apiKey, maxRetries: 0, timeout: 300_000 });
  }

  async call(req: EngineRequest): Promise<EngineResult> {
    const res = await this.client.chat.completions.create({
      model: this.engine.model,
      messages: [
        { role: "system", content: this.systemInstruction },
        { role: "user", content: req.prompt },
      ],
      ...(req.mode === "no_search" && { disable_search: true }),
      ...(this.engine.temperature !== null && { temperature: this.engine.temperature }),
    });
    const content = res.choices?.[0]?.message?.content;
    const answer =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("")
          : "";
    const usage = res.usage;
    return {
      answer,
      citations: res.search_results ?? [],
      raw: res,
      input_tokens: usage?.prompt_tokens ?? null,
      output_tokens: usage?.completion_tokens ?? null,
      search_count: usage?.num_search_queries ?? (req.mode === "web_search" ? 1 : 0),
      provider_cost_usd: usage?.cost?.total_cost ?? null,
    };
  }
}

export const normalizePerplexityCitations: CitationNormalizer = (citations) =>
  ((citations as { url: string; title?: string | null }[]) ?? []).map((c) => ({
    url: c.url,
    title: c.title ?? null,
    domain: hostOf(c.url),
    kind: "retrieved" as const,
  }));
