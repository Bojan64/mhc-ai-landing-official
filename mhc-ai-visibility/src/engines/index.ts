import type { EnginesConfig, Engine } from "../config/schemas";
import { AnthropicAdapter, normalizeAnthropicCitations } from "./anthropic";
import { GeminiAdapter, normalizeGeminiCitations } from "./gemini";
import { normalizeOpenAICitations, OpenAIAdapter } from "./openai";
import { normalizePerplexityCitations, PerplexityAdapter } from "./perplexity";
import type { CitationNormalizer, EngineAdapter } from "./types";

/**
 * Environment variable holding each provider's API key. The MHC_ prefix avoids clashing with
 * variables the hosting tools use themselves (a Claude Code cloud session does not pass its own
 * ANTHROPIC_API_KEY through). The plain name is accepted as a fallback for local use.
 */
export const API_KEY_VARS: Record<Engine["provider"], string> = {
  openai: "MHC_OPENAI_API_KEY",
  anthropic: "MHC_ANTHROPIC_API_KEY",
  google: "MHC_GEMINI_API_KEY",
  perplexity: "MHC_PERPLEXITY_API_KEY",
};

/** The API key for a provider: MHC_<NAME> first, then <NAME> without the prefix. */
export function apiKeyFor(provider: Engine["provider"], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = API_KEY_VARS[provider];
  return env[name] || env[name.replace(/^MHC_/, "")] || undefined;
}

export const CITATION_NORMALIZERS: Record<Engine["provider"], CitationNormalizer> = {
  openai: normalizeOpenAICitations,
  anthropic: normalizeAnthropicCitations,
  google: normalizeGeminiCitations,
  perplexity: normalizePerplexityCitations,
};

export type AdapterFactory = (engine: Engine, config: EnginesConfig) => EngineAdapter;

/** Build the real adapter for an engine. Throws if its API key is missing. */
export const createAdapter: AdapterFactory = (engine, config) => {
  const keyVar = API_KEY_VARS[engine.provider];
  const key = apiKeyFor(engine.provider);
  if (!key) throw new Error(`${keyVar} is not set (in .env or the environment settings; needed for engine "${engine.engine_id}")`);
  const sys = config.system_instruction;
  switch (engine.provider) {
    case "openai": return new OpenAIAdapter(engine, sys, key);
    case "anthropic": return new AnthropicAdapter(engine, sys, key);
    case "google": return new GeminiAdapter(engine, sys, key);
    case "perplexity": return new PerplexityAdapter(engine, sys, key);
  }
};
