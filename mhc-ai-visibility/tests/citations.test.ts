import { describe, expect, it } from "vitest";
import { normalizeAnthropicCitations } from "../src/engines/anthropic";
import { normalizeGeminiCitations } from "../src/engines/gemini";
import { normalizeOpenAICitations } from "../src/engines/openai";
import { normalizePerplexityCitations } from "../src/engines/perplexity";

// Shapes follow each provider's SDK type definitions. To be re-checked against real smoke-test answers.
describe("citation normalizers", () => {
  it("OpenAI url_citation annotations", () => {
    const out = normalizeOpenAICitations([
      { type: "url_citation", url: "https://www.booking.com/hotel/si/x.html", title: "Hotel X", start_index: 0, end_index: 5 },
    ]);
    expect(out).toEqual([{ url: "https://www.booking.com/hotel/si/x.html", title: "Hotel X", domain: "booking.com" }]);
  });

  it("Anthropic web_search_result_location citations", () => {
    const out = normalizeAnthropicCitations([
      { type: "web_search_result_location", url: "https://hotel-x.si/en", title: "Hotel X", cited_text: "…", encrypted_index: "e" },
      { type: "char_location", cited_text: "x" },
    ]);
    expect(out).toEqual([{ url: "https://hotel-x.si/en", title: "Hotel X", domain: "hotel-x.si" }]);
  });

  it("Gemini redirect links take the domain from the title", () => {
    const out = normalizeGeminiCitations({
      webSearchQueries: ["best hotels portoroz"],
      groundingChunks: [
        { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "tripadvisor.com" } },
        { web: { uri: "https://www.slovenia.info/en/places", title: "Slovenia" } },
      ],
    });
    expect(out.map((s) => s.domain)).toEqual(["tripadvisor.com", "slovenia.info"]);
  });

  it("Gemini without grounding gives no sources", () => {
    expect(normalizeGeminiCitations(null)).toEqual([]);
  });

  it("Perplexity search_results", () => {
    const out = normalizePerplexityCitations([{ url: "https://www.tripadvisor.de/Hotel", title: "TA", date: null }]);
    expect(out).toEqual([{ url: "https://www.tripadvisor.de/Hotel", title: "TA", domain: "tripadvisor.de" }]);
  });
});
