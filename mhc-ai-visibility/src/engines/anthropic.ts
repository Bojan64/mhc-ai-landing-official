import Anthropic from "@anthropic-ai/sdk";
import type { Engine } from "../config/schemas";
import { hostOf, type CitationNormalizer, type EngineAdapter, type EngineRequest, type EngineResult } from "./types";

const MAX_TOKENS = 8000;
const MAX_CONTINUATIONS = 5; // server-side web search may pause a long turn ("pause_turn")

/**
 * Anthropic Messages API. Web search via the server tool `web_search_20260209`.
 * That version filters results in a code-execution step, and the final text often carries
 * no citations. So we store both: text citations (if any) and every search result returned
 * in `web_search_tool_result` blocks.
 * No refusal fallbacks: a refusal is part of what we measure.
 */
export class AnthropicAdapter implements EngineAdapter {
  private client: Anthropic;

  constructor(readonly engine: Engine, private systemInstruction: string, apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: 300_000 });
  }

  async call(req: EngineRequest): Promise<EngineResult> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
    const tools: Anthropic.ToolUnion[] | undefined =
      req.mode === "web_search" ? [{ type: "web_search_20260209", name: "web_search" }] : undefined;

    const responses: Anthropic.Message[] = [];
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const res = await this.client.messages.create({
        model: this.engine.model,
        max_tokens: MAX_TOKENS,
        system: this.systemInstruction,
        messages,
        ...(tools && { tools }),
        ...(this.engine.temperature !== null && { temperature: this.engine.temperature }),
      });
      responses.push(res);
      if (res.stop_reason !== "pause_turn") break;
      // Continue the paused turn: send the partial assistant turn back unchanged.
      messages.push({ role: "assistant", content: res.content });
    }

    const blocks = responses.flatMap((r) => r.content);
    const textBlocks = blocks.filter((b): b is Anthropic.TextBlock => b.type === "text");
    return {
      answer: textBlocks.map((b) => b.text).join(""),
      citations: {
        text_citations: textBlocks.flatMap((b) => b.citations ?? []),
        search_results: blocks
          .filter((b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result")
          .flatMap((b) => (Array.isArray(b.content) ? b.content : [])),
      } satisfies AnthropicCitations,
      raw: responses.length === 1 ? responses[0] : responses,
      input_tokens: sum(responses.map((r) => r.usage.input_tokens)),
      output_tokens: sum(responses.map((r) => r.usage.output_tokens)),
      search_count: sum(responses.map((r) => r.usage.server_tool_use?.web_search_requests ?? 0)),
      provider_cost_usd: null,
    };
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

interface AnthropicCitations {
  text_citations: unknown[];
  search_results: unknown[];
}

type UrlItem = { type?: string; url?: string; title?: string | null };

export const normalizeAnthropicCitations: CitationNormalizer = (citations) => {
  // Older smoke-test rows stored only the text-citation array.
  const c: AnthropicCitations = Array.isArray(citations)
    ? { text_citations: citations, search_results: [] }
    : ((citations as AnthropicCitations | null) ?? { text_citations: [], search_results: [] });
  const cited = (c.text_citations as UrlItem[])
    .filter((x) => x.type === "web_search_result_location" && x.url)
    .map((x) => ({ url: x.url!, title: x.title ?? null, domain: hostOf(x.url!), kind: "cited" as const }));
  const citedUrls = new Set(cited.map((x) => x.url));
  const retrieved = (c.search_results as UrlItem[])
    .filter((x) => x.type === "web_search_result" && x.url && !citedUrls.has(x.url))
    .map((x) => ({ url: x.url!, title: x.title ?? null, domain: hostOf(x.url!), kind: "retrieved" as const }));
  return [...cited, ...retrieved];
};
