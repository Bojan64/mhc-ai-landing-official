import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import type { Engine } from "../config/schemas";

/**
 * Ask a provider which models this API key can use.
 * Returns null if the provider has no model-listing endpoint in its SDK (Perplexity).
 */
export async function listModels(provider: Engine["provider"], apiKey: string): Promise<string[] | null> {
  switch (provider) {
    case "openai": {
      const ids: string[] = [];
      for await (const m of new OpenAI({ apiKey }).models.list()) ids.push(m.id);
      return ids.sort();
    }
    case "anthropic": {
      const ids: string[] = [];
      for await (const m of new Anthropic({ apiKey }).models.list()) ids.push(m.id);
      return ids.sort();
    }
    case "google": {
      const ids: string[] = [];
      const pager = await new GoogleGenAI({ apiKey }).models.list();
      for await (const m of pager) if (m.name) ids.push(m.name.replace(/^models\//, ""));
      return ids.sort();
    }
    case "perplexity":
      return null;
  }
}
