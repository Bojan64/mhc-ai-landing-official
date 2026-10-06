import type { Engine, Mode } from "../config/schemas";

export interface EngineRequest {
  prompt: string;
  mode: Mode;
}

/** A cited source reduced to what metrics need. Derived from the stored raw citations. */
export interface SourceRef {
  url: string;
  title: string | null;
  /** Domain to classify. Usually the URL's host; for Gemini redirect links it is the page title. */
  domain: string | null;
  /**
   * "cited" = the provider ties this source to a passage of the answer (OpenAI url_citation,
   * Claude text citations). "retrieved" = the provider's search returned it for this answer
   * (Claude search results, Gemini grounding chunks, Perplexity search_results).
   */
  kind: "cited" | "retrieved";
}

export interface EngineResult {
  answer: string;
  /** Citations exactly as the provider returned them (provider-specific shape). */
  citations: unknown;
  /** Full provider response. */
  raw: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  search_count: number;
  /** Cost the provider reported itself (Perplexity does), in USD. */
  provider_cost_usd: number | null;
}

export interface EngineAdapter {
  readonly engine: Engine;
  call(req: EngineRequest): Promise<EngineResult>;
}

/** Turn stored raw citations into source references (pure; used by metrics). */
export type CitationNormalizer = (citations: unknown) => SourceRef[];

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
