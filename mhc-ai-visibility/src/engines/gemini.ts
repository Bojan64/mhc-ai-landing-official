import { GoogleGenAI, type GroundingMetadata } from "@google/genai";
import type { Engine } from "../config/schemas";
import { hostOf, type CitationNormalizer, type EngineAdapter, type EngineRequest, type EngineResult } from "./types";

/** Gemini API. Web search via Grounding with Google Search; sources are in `groundingMetadata`. */
export class GeminiAdapter implements EngineAdapter {
  private client: GoogleGenAI;

  constructor(readonly engine: Engine, private systemInstruction: string, apiKey: string) {
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 300_000, retryOptions: { attempts: 1 } }, // our runner retries
    });
  }

  async call(req: EngineRequest): Promise<EngineResult> {
    const res = await this.client.models.generateContent({
      model: this.engine.model,
      contents: req.prompt,
      config: {
        systemInstruction: this.systemInstruction,
        ...(req.mode === "web_search" && { tools: [{ googleSearch: {} }] }),
        ...(this.engine.temperature !== null && { temperature: this.engine.temperature }),
      },
    });
    const grounding = res.candidates?.[0]?.groundingMetadata ?? null;
    const usage = res.usageMetadata;
    // Thinking tokens are billed as output tokens.
    const output = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    return {
      answer: res.text ?? "",
      citations: grounding,
      raw: res,
      input_tokens: usage?.promptTokenCount ?? null,
      output_tokens: usage ? output : null,
      search_count: grounding?.webSearchQueries?.filter((q) => q.trim()).length ?? 0,
      provider_cost_usd: null,
    };
  }
}

/**
 * Gemini source links are usually Google redirect URLs (vertexaisearch.cloud.google.com/...),
 * and the chunk title holds the site's domain. Use the title as the domain in that case.
 */
export const normalizeGeminiCitations: CitationNormalizer = (citations) => {
  const g = citations as GroundingMetadata | null;
  return (g?.groundingChunks ?? [])
    .filter((c) => c.web?.uri)
    .map((c) => {
      const url = c.web!.uri!;
      const title = c.web!.title ?? null;
      const host = hostOf(url);
      const isRedirect = host !== null && host.endsWith("vertexaisearch.cloud.google.com");
      const titleDomain = title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title) ? title.toLowerCase().replace(/^www\./, "") : null;
      return { url, title, domain: isRedirect ? (c.web!.domain ?? titleDomain) : host };
    });
};
