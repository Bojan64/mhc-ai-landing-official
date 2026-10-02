import OpenAI from "openai";
import type { Engine } from "../config/schemas";
import { hostOf, type CitationNormalizer, type EngineAdapter, type EngineRequest, type EngineResult } from "./types";

/** OpenAI Responses API. Web search via the `web_search` tool; citations are `url_citation` annotations. */
export class OpenAIAdapter implements EngineAdapter {
  private client: OpenAI;

  constructor(readonly engine: Engine, private systemInstruction: string, apiKey: string) {
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 300_000 }); // our runner retries
  }

  async call(req: EngineRequest): Promise<EngineResult> {
    const res = await this.client.responses.create({
      model: this.engine.model,
      instructions: this.systemInstruction,
      input: req.prompt,
      // "approximate" with no fields = neutral location (otherwise OpenAI assumes the US).
      ...(req.mode === "web_search" && { tools: [{ type: "web_search", user_location: { type: "approximate" } }] }),
      ...(this.engine.temperature !== null && { temperature: this.engine.temperature }),
    });

    const citations: unknown[] = [];
    let searches = 0;
    for (const item of res.output) {
      if (item.type === "web_search_call") searches++;
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type !== "output_text") continue;
        for (const a of part.annotations) if (a.type === "url_citation") citations.push(a);
      }
    }
    return {
      answer: res.output_text,
      citations,
      raw: res,
      input_tokens: res.usage?.input_tokens ?? null,
      output_tokens: res.usage?.output_tokens ?? null,
      search_count: searches,
      provider_cost_usd: null,
    };
  }
}

export const normalizeOpenAICitations: CitationNormalizer = (citations) =>
  ((citations as { url: string; title?: string }[]) ?? []).map((c) => ({
    url: c.url,
    title: c.title ?? null,
    domain: hostOf(c.url),
  }));
