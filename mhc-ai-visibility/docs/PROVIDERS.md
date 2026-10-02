# Provider verification (Checkpoint 1)

Checked on 2026-10-02.

**How this was checked.** This build environment's network blocks the providers' documentation
sites (platform.openai.com, ai.google.dev, docs.perplexity.ai). So I used:
1. **Official SDK packages from npm** (latest versions: `openai` 7.27.0, `@google/genai` 2.26.0,
   `@anthropic-ai/sdk` 0.131.0, `@perplexity-ai/perplexity_ai` 0.38.6). Their type definitions are
   generated from each provider's API spec, so the parameter names and response fields below come
   from there and are reliable.
2. **Anthropic's own current API reference** (bundled with Claude Code, dated 2026-09-25).
3. **Web search** for pricing and "which model is current". These are secondary sources (blogs,
   aggregators), so treat those numbers as **unverified**.

Model IDs are confirmed **live** once API keys exist: Phase 2 adds a `list-models` command
that asks each provider's models endpoint which models the account can use.

## Summary table

| | OpenAI | Anthropic (Claude) | Google Gemini | Perplexity |
|---|---|---|---|---|
| **Proposed tested model** | `gpt-6-astra` ⚠️ | `claude-sonnet-5-5` | `gemini-3.8-flash` ⚠️ | `sonar` |
| Alternatives | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.5` | `claude-sonnet-5` (spec default), `claude-opus-5-5` | `gemini-3.1-pro-preview` (preview only) | `sonar-pro` |
| **API** | Responses API (`client.responses.create`) | Messages API | `ai.models.generateContent` | Chat Completions (`api.perplexity.ai`), official SDK `@perplexity-ai/perplexity_ai` |
| **Enable web search** | `tools: [{type: "web_search"}]` | `tools: [{type: "web_search_20260209", name: "web_search"}]` | `config.tools: [{googleSearch: {}}]` | Always on by default |
| **Citations returned as** | `url_citation` annotations on output text: `url`, `title`, `start_index`, `end_index` | `citations` on text blocks, type `web_search_result_location`: `url`, `title`, `cited_text`; plus `web_search_tool_result` blocks with all results | `candidates[0].groundingMetadata`: `groundingChunks[].web.{uri,title}`, `groundingSupports`, `webSearchQueries` | `search_results[]`: `url`, `title`, `date`, `snippet` (old `citations` field is removed) |
| **Search count for cost** | count of `web_search_call` output items | `usage.server_tool_use.web_search_requests` | number of `webSearchQueries` | 1 request fee per call; response includes `usage.cost` with the real cost |
| **No-search mode possible?** | Yes: no tools | Yes: no tools | Yes: no tools | Technically: SDK has `disable_search: true`. **Proposal: web_search only** (see decision 4) |
| **Temperature** | provider default (not sent) | provider default. Note: Sonnet 5 / 5.5 reject non-default sampling values anyway | provider default | provider default |
| **Default user location** | ⚠️ **United States** if not set | none | none | none (optional `country`) |
| **Search price (unverified)** | ~$10 per 1,000 calls + search content tokens at model rate | $10 per 1,000 searches (+ tokens) | Gemini 3.x: ~$14 per 1,000 search queries after 5,000 free/month | `sonar` ~$5–12 per 1,000 requests depending on `search_context_size`; tokens $1/$1 per million |
| **Token price** | ❓ unknown for gpt-6-astra, Bojan to fill | $2 / $10 per million (Sonnet 5.5) | ❓ Bojan to fill | $1 / $1 per million |
| **Pricing page** | https://openai.com/api/pricing | https://platform.claude.com/docs/en/about-claude/pricing | https://ai.google.dev/gemini-api/docs/pricing | https://docs.perplexity.ai/getting-started/pricing |
| **Rate limits page** | https://platform.openai.com/docs/guides/rate-limits | https://platform.claude.com/docs/en/api/rate-limits | https://ai.google.dev/gemini-api/docs/rate-limits | https://docs.perplexity.ai/guides/usage-tiers |

Rate limits depend on each account's usage tier, so they can't be known in advance. The config starts
conservatively (2 parallel calls, 30 per minute per engine). These can be raised once we see the real limits.

The pricing/rate-limit URLs could not be opened from here; I believe they are correct, but please
check that they open.

### Result Analyzer
- Model: `claude-haiku-4-5-20251001` (Claude Haiku 4.5), $1 / $5 per million tokens. Configured
  separately in `engines.json → analyzer`.
- Forced tool choice (`tool_choice: {type: "tool", name: "record_analysis"}`) **works on Haiku 4.5**.
  Important for later: the newest models (Sonnet 5.5, Opus 5.5) **reject** forced tool choice. If the
  analyzer is ever switched to one of those, the code falls back to `tool_choice: auto` with
  `strict: true` on the tool definition, which still guarantees schema-valid output. I will build
  that fallback in from the start.
- Temperature 0 is allowed on Haiku 4.5.

## Decisions for Bojan

1. **Claude model.** The spec default `claude-sonnet-5` is still valid, but `claude-sonnet-5-5` is now
   the current Sonnet at the same price. Proposal: `claude-sonnet-5-5`, because it is closer to what
   people use today.
2. **OpenAI model.** OpenAI's SDK lists several new models (`gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`,
   `gpt-6-luna`). A secondary source calls `gpt-6-astra` the flagship (released 2026-09-03). **I'm not
   certain which model ChatGPT users actually get by default.** Proposal: `gpt-6-astra` for now, then
   confirm with `list-models` and OpenAI's pricing page before the pilot.
3. **Gemini model.** `gemini-3.8-flash` is the newest stable (GA) model I could find. The newest Pro model I
   found, `gemini-3.1-pro-preview`, is preview only, and preview models can change without notice. Proposal:
   `gemini-3.8-flash`. **You should verify this.**
4. **Perplexity no-search.** The SDK accepts `disable_search: true`, but Perplexity's whole product is
   search, and I could not open the docs to check whether this option is supported for public use.
   Proposal: run Perplexity in `web_search` mode only, as the spec suggests, and document it.
5. **User location.** OpenAI pretends the user is in the **United States** unless told otherwise.
   That could bias results (e.g. US booking sites). Options:
   - (a) neutral: tell OpenAI "approximate, no location", others default *(proposal)*
   - (b) everyone "located in Slovenia" (only OpenAI, Anthropic and Perplexity support it, so not equal)
   - (c) leave OpenAI on US
6. **Currency.** Providers bill in USD; your budget is in EUR. The config has `usd_to_eur: 0.92`
   (an approximate rate I have not checked; please set the current one).

## Rough cost check (to be calculated properly by `plan` in Phase 1)

10 hotels × ~13 applicable prompts × (3 engines × 2 modes + Perplexity × 1) × 3 reps ≈ **2,700
tested calls**, plus the same number of analyzer calls. With searches priced at about $0.01 each and short
answers, I estimate a full run at roughly **$60–150**, but this is only approximate: it depends on the missing token
prices and on how many searches each model makes per answer.
