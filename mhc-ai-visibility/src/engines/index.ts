import type { EnginesConfig, Engine } from "../config/schemas";
import { AnthropicAdapter, normalizeAnthropicCitations } from "./anthropic";
import { GeminiAdapter, normalizeGeminiCitations } from "./gemini";
import { normalizeOpenAICitations, OpenAIAdapter } from "./openai";
import { normalizePerplexityCitations, PerplexityAdapter } from "./perplexity";
import type { CitationNormalizer, EngineAdapter } from "./types";

export const API_KEY_VARS: Record<Engine["provider"], string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

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
  const key = process.env[keyVar];
  if (!key) throw new Error(`${keyVar} is not set (in .env or the environment settings; needed for engine "${engine.engine_id}")`);
  const sys = config.system_instruction;
  switch (engine.provider) {
    case "openai": return new OpenAIAdapter(engine, sys, key);
    case "anthropic": return new AnthropicAdapter(engine, sys, key);
    case "google": return new GeminiAdapter(engine, sys, key);
    case "perplexity": return new PerplexityAdapter(engine, sys, key);
  }
};
