# MASTERPROMPT — MHC AI Visibility Engine 0.1

You are building "MHC AI Visibility Engine 0.1" for MHC d.o.o. (Slovenia), a hospitality AI company. Owner: Bojan Horvat, 40 years in hospitality, not a developer. Explain decisions in plain language, keep the setup simple, and stop at every CHECKPOINT for his confirmation.

FIRST ACTION: save this entire prompt as `docs/SPEC.md` and create a short `CLAUDE.md` pointing to it. Re-read SPEC.md whenever you are unsure.

---

## 1. GOAL

Measure whether AI assistants recommend specific hotels, how accurately they describe them, which sources they cite, and whether they send guests to the hotel's own website or to OTAs.

Version 0.1 is a MEASUREMENT RESEARCH TOOL for one experiment: 10 Slovenian hotels × ~20 questions × 4 AI engines, with repetitions. Its output feeds the public "MHC Slovenian Hotel AI Visibility Index 2026" and the product spec for the later SaaS.

Principle: MEASURE → EXPLAIN → RECOMMEND → OPTIMIZE. Version 0.1 only does MEASURE, plus a basic EXPLAIN in the report.

## 2. SCOPE

IN SCOPE:
- Hotel config with manually entered, hotel-confirmed Ground Truth
- Prompt templates with applicability rules per hotel type
- Engine adapters: OpenAI, Anthropic (Claude), Google Gemini, Perplexity
- Two modes per engine where supported: `no_search` and `web_search`
- Repetitions (default 3) per hotel × prompt × engine × mode
- Raw answer storage (never discard raw data)
- Result Analyzer (Claude, structured extraction via tool use)
- Deterministic metrics and a provisional score in code
- Exports: CSV + JSON + a Slovenian HTML report
- Validation workflow: stratified sample for manual annotation and an accuracy comparison
- Dry run, cost estimate, budget cap, resumable runs

OUT OF SCOPE (do NOT build):
- Automatic website scraping / Hotel Intelligence Engine
- Action plans or optimization advice
- User accounts, auth, payments, multi-tenant SaaS
- Agent booking tests (browser agents) — leave a documented stub only
- Google AI Overviews scraping

## 3. STACK

- Node.js (LTS) + TypeScript, run as a CLI
- SQLite via better-sqlite3 (single local file `data/mhc.db`)
- Official SDKs where they exist: `@anthropic-ai/sdk`, `openai`, `@google/genai`; Perplexity via its OpenAI-compatible API or official SDK (check current docs)
- zod for config validation
- vitest for tests
- The HTML report is a single self-contained static file (no framework, inline CSS)
- `.env` for API keys; commit `.env.example` only; add `.env` and `data/` to `.gitignore`

Keep dependencies minimal. No Next.js, no database server, no Docker in 0.1.

## 4. VERIFY BEFORE CODING (mandatory)

Before writing any engine adapter, check the CURRENT official documentation of each provider and report back in a short table:
- current recommended model IDs
- how to enable web search / grounding, and how citations are returned
- whether a no-search mode is possible (Perplexity Sonar models may always search; if so, run Perplexity in `web_search` mode only and document it)
- rate limits and pricing page URLs

Do NOT rely on memory for model names or parameter names. All model IDs go in `config/engines.json`, never hard-coded.

Default Anthropic models (verify first): `claude-sonnet-5` as the tested engine, `claude-haiku-4-5-20251001` for the Result Analyzer. The analyzer model must be configurable separately.

→ CHECKPOINT 1: show the verification table and the proposed `config/engines.json`. Wait for approval.

## 5. PROJECT STRUCTURE

```
mhc-ai-visibility/
  CLAUDE.md
  docs/SPEC.md
  .env.example
  config/
    hotels.json          # 10 hotels + ground truth + competitors
    prompts.json         # prompt templates + applicability rules
    engines.json         # engines, models, modes, pricing, limits
    scoring.json         # score weights (provisional)
    source-domains.json  # OTA / meta / review / tourism domain lists
  src/
    cli.ts
    config/              # zod schemas + loaders
    db/                  # schema.sql, migrations, repository
    engines/             # one adapter per provider + common interface
    runner/              # job planning, execution, retries, resume
    analyzer/            # Claude extraction (tool use)
    metrics/             # deterministic per-test metrics
    scoring/             # aggregation + provisional score
    validation/          # sample export + accuracy comparison
    report/              # CSV/JSON export + Slovenian HTML report
  tests/
  data/                  # gitignored: mhc.db, exports, reports
```

## 6. CONFIG FORMATS

### hotels.json (one entry per hotel)
```json
{
  "hotel_id": "HX",
  "name": "Hotel X",
  "aliases": ["Hotel X Portorož"],
  "website_domain": "hotel-x.si",
  "city": "Portorož",
  "region": "Slovenian coast",
  "stars": 4,
  "tags": ["spa", "couples", "business"],
  "competitor_ids": ["HA", "HB"],
  "extra_competitors": [{"name": "Hotel Z", "aliases": []}],
  "ground_truth": {
    "pool_indoor": true,
    "pool_outdoor": false,
    "spa_wellness": true,
    "beach_access": false,
    "parking": true,
    "pets_allowed": false,
    "restaurant": true,
    "family_friendly": false,
    "adults_only": false,
    "star_rating": 4,
    "distance_to_sea": 0.3,
    "price_level": "upper-mid",
    "business_facilities": true,
    "event_facilities": true
  },
  "ground_truth_confirmed_by_hotel": false
}
```
Allowed tags: `spa`, `family`, `couples`, `adults_only`, `business`, `events`, `pets`, `beach`, `luxury`, `budget`.
Missing ground-truth keys are allowed (fact checks then return `needs_review`).
The report must clearly mark hotels whose ground truth is NOT confirmed.

### prompts.json
Each template has: `id`, `language`, `category`, `text` with placeholders `{hotel_name}`, `{city}`, `{region}`, `{stars}`, `applies_if` (tag list, OR logic; empty = all hotels), optional `min_stars`, and `type`: `discovery` or `brand`.

`discovery` prompts measure presence and position (the hotel is not named).
`brand` prompts name the hotel; they are EXCLUDED from presence/position metrics and used ONLY for factual accuracy and booking-channel metrics.

Seed it with exactly these 20 templates (Bojan will refine them later):

| id | lang | type | applies_if | text |
|---|---|---|---|---|
| LOC-01 | en | discovery | – | Best hotels in {city} |
| LOC-02 | en | discovery | – | Where to stay in {city}? |
| LOC-03 | en | discovery | – | Best {stars}-star hotel in {city} |
| VAL-01 | en | discovery | – | Best value hotel in {city} |
| LUX-01 | en | discovery | luxury OR min_stars 4 | Luxury hotel in {city} |
| WELL-01 | en | discovery | spa | Best wellness hotel in {city} |
| WELL-02 | en | discovery | spa | Best spa hotel in {region} |
| WELL-03 | en | discovery | spa | Hotel for a wellness weekend in Slovenia |
| FAM-01 | en | discovery | family | Best family hotel in {city} |
| FAM-02 | en | discovery | family | Hotels in {city} for families with small children |
| ROM-01 | en | discovery | couples, adults_only | Best romantic hotel in {city} for couples |
| ROM-02 | en | discovery | adults_only | Adults-only hotel in {region} |
| BUS-01 | en | discovery | business | Best business hotel in {city} |
| EVT-01 | en | discovery | events | Hotel with conference rooms in {city} |
| DE-01 | de | discovery | – | Bestes Hotel in {city} |
| DE-02 | de | discovery | spa | Wellnesshotel in {region} empfehlen |
| IT-01 | it | discovery | – | Miglior hotel a {city} |
| SL-01 | sl | discovery | – | Najboljši hotel v kraju {city} |
| BRAND-01 | en | brand | – | Tell me about {hotel_name} in {city}. What facilities does it have? |
| BRAND-02 | en | brand | – | Where should I book {hotel_name} in {city}? |

### engines.json
Per engine: `engine_id`, `provider`, `model`, `modes` (subset of `no_search`, `web_search`), `enabled`, `max_concurrency`, `requests_per_minute`, `pricing` (per-million input/output tokens + per-search fee if any; Bojan fills in real numbers), `temperature` (use the provider default for tested engines — we want to measure what real users get, so do NOT force temperature 0 on tested engines; document this).

Every tested-engine call gets the SAME minimal system instruction (or none, if the provider allows): "You are a helpful assistant." Do not add hotel-specific or MHC-specific instructions to tested engines.

### scoring.json (provisional v0.1, all weights configurable)
```json
{
  "version": "0.1-provisional",
  "weights": {
    "presence": 25,
    "position": 20,
    "factual_accuracy": 20,
    "source_authority": 15,
    "competitive_position": 10,
    "direct_booking": 10
  },
  "engine_weights": { "openai": 1, "anthropic": 1, "gemini": 1, "perplexity": 1 },
  "max_position_counted": 5
}
```

## 7. DATABASE (SQLite)

Tables (add indexes where sensible):
- `runs` (run_id, started_at, finished_at, config_hash, notes, status)
- `jobs` (job_id, run_id, hotel_id, prompt_id, prompt_text_rendered, engine_id, model, mode, repetition, status: pending|done|failed|skipped, attempts, error)
- `responses` (job_id, raw_answer, api_citations_json, raw_api_response_json, input_tokens, output_tokens, search_count, latency_ms, cost_estimate, created_at)
- `analyses` (job_id, analyzer_model, analysis_json, schema_valid, created_at)
- `test_metrics` (job_id, mentioned, recommended, position, position_confidence, sentiment, booking_channel, needs_review, sources_json, fact_checks_json)
- `validation_labels` (job_id, field, human_value, annotator, created_at)

Raw API responses are stored in full. Nothing is ever overwritten; re-analysis creates new rows tagged with the analyzer model.

## 8. CLI COMMANDS

```
npm run cli -- validate-config
npm run cli -- plan --run-name "pilot-01"          # builds jobs, prints counts + cost estimate, does NOT call APIs
npm run cli -- run --run-name "pilot-01" [--limit N] [--engine openai] [--hotel HX]
npm run cli -- resume --run-name "pilot-01"
npm run cli -- analyze --run-name "pilot-01"
npm run cli -- metrics --run-name "pilot-01"
npm run cli -- report --run-name "pilot-01"
npm run cli -- validation-export --run-name "pilot-01" --size 50
npm run cli -- validation-compare --run-name "pilot-01"
```

`plan` output must show: calls per engine, per mode, per hotel, total tested-engine calls, total analyzer calls, estimated cost per engine and total, and a warning if the estimate exceeds `BUDGET_EUR` from `.env`.
`run` must refuse to start if the estimate exceeds `BUDGET_EUR`, and must stop cleanly mid-run once actual tracked cost reaches it.

## 9. RUNNER RULES

- Jobs = applicable hotel×prompt pairs × enabled engine×mode pairs × repetitions (default 3, configurable via `REPETITIONS`).
- Randomize job order within a run (so time-of-day effects don't cluster on one engine).
- Respect per-engine concurrency and rate limits; exponential backoff with jitter on 429/5xx; max 4 attempts; then mark failed and continue.
- Fully resumable: a crash never loses completed jobs.
- Log each call on one line: engine, hotel, prompt id, mode, rep, status, tokens, latency.
- Store citations exactly as returned by each provider (URLs + titles when available).

## 10. RESULT ANALYZER

Uses Claude via TOOL USE with forced tool choice, so the output is guaranteed to follow the schema. Temperature 0. Validate the returned object with zod; if invalid, retry once, then mark `schema_valid = false`.

The analyzer receives: test_id, engine, mode, prompt text + language, raw answer, API citations, target hotel (id, name, aliases, website_domain) and known competitors (ids, names, aliases). It must NOT receive ground truth.

### Tool definition
```json
{
  "name": "record_analysis",
  "description": "Record structured extraction of one AI answer about hotels.",
  "input_schema": {
    "type": "object",
    "required": ["answer_type", "hotels_mentioned", "target", "claims_about_target", "urls_in_text", "booking_guidance", "flags"],
    "properties": {
      "answer_type": {"type": "string", "enum": ["ranked_list", "unranked_list", "single_recommendation", "prose", "no_answer"]},
      "hotels_mentioned": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name_as_written", "matched_hotel_id", "order_of_appearance", "explicit_rank", "is_recommended", "sentiment"],
          "properties": {
            "name_as_written": {"type": "string"},
            "matched_hotel_id": {"type": ["string", "null"]},
            "order_of_appearance": {"type": "integer"},
            "explicit_rank": {"type": ["integer", "null"]},
            "is_recommended": {"type": "boolean"},
            "sentiment": {"type": "string", "enum": ["positive", "neutral", "negative"]}
          }
        }
      },
      "target": {
        "type": "object",
        "required": ["mentioned", "name_variant_used"],
        "properties": {
          "mentioned": {"type": "boolean"},
          "name_variant_used": {"type": ["string", "null"]}
        }
      },
      "claims_about_target": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["topic", "normalized_value", "evidence"],
          "properties": {
            "topic": {"type": "string", "enum": ["pool_indoor", "pool_outdoor", "spa_wellness", "beach_access", "parking", "pets_allowed", "restaurant", "family_friendly", "adults_only", "star_rating", "distance_to_sea", "price_level", "business_facilities", "event_facilities", "languages_spoken", "other"]},
            "normalized_value": {"type": ["boolean", "number", "string"]},
            "evidence": {"type": "string", "maxLength": 200}
          }
        }
      },
      "urls_in_text": {"type": "array", "items": {"type": "string"}},
      "booking_guidance": {
        "type": "object",
        "required": ["mentions_where_to_book", "channels_named"],
        "properties": {
          "mentions_where_to_book": {"type": "boolean"},
          "channels_named": {"type": "array", "items": {"type": "string"}}
        }
      },
      "flags": {
        "type": "array",
        "items": {"type": "string", "enum": ["ambiguous_hotel_name", "unmatched_hotel_names", "answer_truncated", "answer_off_topic", "possible_nonexistent_hotel"]}
      }
    }
  }
}
```

### Analyzer system prompt (use verbatim)
```text
You are a data extraction component in a hotel AI-visibility measurement system.

You receive one answer that an AI assistant gave to a travel question, plus the target hotel and a list of known competitors. Your only job is to extract what the answer SAYS, accurately and literally, by calling the record_analysis tool.

STRICT RULES

1. Extract, never evaluate. Do not judge whether the answer is correct, good, or fair. Do not add anything you know about any hotel. If the answer does not state something, it does not exist for you.

2. Hotel matching.
   - List every hotel or accommodation named in the answer, in order of first appearance (order_of_appearance starts at 1).
   - Set matched_hotel_id only when the name clearly matches the target or a known competitor (including listed aliases and obvious variants).
   - If a name could refer to more than one place (e.g. a hotel name that is also a town, or a chain with several properties), set matched_hotel_id to null and add the flag "ambiguous_hotel_name".
   - If any named hotel is not in the provided lists, keep it with matched_hotel_id null and add the flag "unmatched_hotel_names".
   - Ignore destinations, restaurants, and attractions unless they are presented as places to stay.

3. Ranking.
   - explicit_rank: only if the answer uses an explicit number or ordinal ("1.", "#2", "third", "top pick"). Otherwise null.
   - is_recommended: true only if the answer presents the hotel as a suggestion for the user's question. A hotel mentioned only as a comparison, a warning, or a negative example is false.

4. Claims about the target hotel.
   - Record only factual claims about the TARGET hotel (facilities, category, location, price level, policies).
   - Use the closest topic from the list; use "other" only when nothing fits.
   - normalized_value: boolean for yes/no facilities (true = has it / allows it), number for stars or distances in km, short string otherwise ("budget", "mid-range", "upper-mid", "luxury").
   - evidence: the shortest phrase from the answer that supports the claim, max 200 characters.
   - Do not infer. "A relaxing seaside hotel" is NOT a claim about beach access.

5. URLs and booking.
   - urls_in_text: every URL or domain written in the answer text.
   - booking_guidance: whether the answer tells the user where or how to book, and which channels it names (e.g. "Booking.com", "hotel website", "Expedia").

6. Flags.
   - "answer_truncated" if the answer visibly ends mid-sentence.
   - "answer_off_topic" if it does not address the question.
   - "possible_nonexistent_hotel" only if the answer itself signals uncertainty about a hotel's existence, or gives internally contradictory details about it.

7. If the answer contains no hotels, set answer_type to "no_answer" or "prose" as appropriate and return empty arrays. Never invent content to fill fields.

Call record_analysis exactly once. Output nothing else.
```

## 11. DETERMINISTIC METRICS (code only, no LLM)

Per test:
- `mentioned`: target hotel found with matching `matched_hotel_id`
- `position`: `explicit_rank` if present, else `order_of_appearance`
- `position_confidence`: 1.0 explicit rank; 0.7 unranked_list; 0.5 prose/other
- `sources`: union of API citations + urls_in_text, each classified via `config/source-domains.json` as `direct` (hotel's own domain), `ota`, `metasearch`, `review`, `tourism_board`, `other`
- `booking_channel`: `none` | `direct` | `ota` | `mixed` (from booking_guidance channel names + classified booking URLs)
- `fact_checks`: compare each claim with ground truth → `correct` | `incorrect` | `needs_review` (numbers: correct if |diff| ≤ 0.5; missing ground truth or topic "other" → needs_review)
- `needs_review`: true if any analyzer flag is set or schema_valid is false

Seed `source-domains.json` with: OTA: booking.com, expedia., hotels.com, agoda.com, trip.com, airbnb. — metasearch: trivago., kayak., google.com/travel, skyscanner. — review: tripadvisor., holidaycheck., zoover. — tourism_board: slovenia.info (Bojan adds local tourism domains). Unclassified domains must be listed in the report so Bojan can extend the lists.

## 12. PROVISIONAL SCORE v0.1 (0–100 per hotel, per engine, and overall)

All components are 0–1 before weighting. Repetitions are averaged first.
- presence = share of applicable DISCOVERY tests where the target is mentioned
- position = average over discovery tests of `confidence × max(0, (max_position_counted + 1 − position) / max_position_counted)`; not mentioned = 0
- factual_accuracy = correct / (correct + incorrect) over all tests; if no checkable claims → null
- source_authority = share of web_search tests where at least one cited source is the hotel's own domain
- competitive_position = 1 − (rank of target's presence among itself + its competitors − 1) / (group size − 1)
- direct_booking = over tests with booking guidance: direct = 1, mixed = 0.5, ota = 0

If a component is null, redistribute its weight proportionally over the remaining components and SHOW this in the report. The overall score uses `engine_weights`. Label every score in the report as "Provisional score v0.1 — methodology under validation".

Also compute, per engine and per hotel, the variability across repetitions (mention rate spread) and show it, so readers can see how stable the results are.

## 13. VALIDATION WORKFLOW

`validation-export`: a stratified random sample (default 50) — balanced across engines and modes — exported as CSV with the raw answer, prompt, target hotel, and EMPTY columns for a human to fill: mentioned, position, recommended, claims (free text), booking_channel. The analyzer output must NOT be in this file (blind annotation).

`validation-compare`: import the filled CSV and report agreement per field. Targets (provisional, set by MHC): mentioned ≥ 97%, position ≥ 90%, booking_channel ≥ 90%, claim detection recall ≥ 85%. List every disagreement with both values side by side.

## 14. REPORT (Slovenian HTML, single file)

Sections:
1. Povzetek: number of hotels, prompts, engines, repetitions, tests, run dates, total cost
2. Metodologija: modes, repetitions, score formula, validation result, limitations (see below)
3. Lestvica hotelov: overall provisional score + component breakdown
4. Po AI sistemih: score and mention rate per engine
5. Za vsak hotel: mention rate by category and language, avg position, factual errors (with evidence quotes), top cited sources, booking channel split, no_search vs web_search comparison
6. Viri: most cited domains overall, by type, plus unclassified domains
7. Rezervacije: share of direct vs OTA guidance, per engine
8. Za ročni pregled: all tests with needs_review

Mandatory limitations text in section 2 (Slovenian): API answers are not identical to what users see in consumer apps (different system settings, memory, location, personalization); results fluctuate between repetitions; the score is provisional; hotels whose ground truth is not confirmed are marked.

Design: clean, readable, printable, works on mobile, no external requests. Use MHC colors if Bojan provides them; otherwise neutral navy/white with one accent.

## 15. AGENT BOOKING TEST (stub only)

Create `src/engines/agent-stub.ts` and a section in `docs/SPEC.md` describing the planned future test ("Book 2 nights at {hotel_name}" via agentic assistants: where does the agent go — direct site or OTA?). No implementation in 0.1.

## 16. QUALITY RULES

- Unit tests for: config validation, prompt applicability, URL classification, fact checks, position logic, score calculation (incl. null redistribution), budget cap
- One mocked end-to-end test with fake engine adapters (no real API calls in tests)
- No secrets in logs or reports
- README in Slovenian: setup, `.env`, how to add a hotel, how to run a pilot, how to read the report
- Keep functions small and readable; comments in English

## 17. WORK PLAN WITH CHECKPOINTS

- Phase 0: save SPEC.md + CLAUDE.md, verify provider docs (section 4) → CHECKPOINT 1
- Phase 1: project setup, config schemas, DB, `validate-config`, `plan` with cost estimate, example hotels.json with 2 fictional hotels → CHECKPOINT 2
- Phase 2: engine adapters + runner; smoke test with `--limit 4` per engine (real APIs, minimal cost), show raw answers and citations → CHECKPOINT 3
- Phase 3: Result Analyzer on the smoke-test answers; show the JSON outputs next to the raw answers → CHECKPOINT 4
- Phase 4: metrics, scoring, validation export/compare, HTML report on smoke-test data → CHECKPOINT 5
- Phase 5: README, tests passing, final review of what is NOT done yet

At each checkpoint: summarize what was built, what was decided and why, what is uncertain, and what Bojan must do next (e.g. enter API keys, pricing, hotel data). Never proceed past a checkpoint without his confirmation. Never run the full experiment yourself — Bojan starts it.

---

## Appendix A — Agent booking test (planned, not built in 0.1)

Stub: `src/engines/agent-stub.ts`.

**Question:** when a guest asks an agentic assistant (one that can browse and act) to "Book 2 nights at {hotel_name}", where does it go to book — the hotel's own website or an OTA / metasearch site?

**Planned method:**
- Same hotels as the main experiment; one task per hotel per agent, with repetitions.
- Record every domain the agent visits, the first booking-capable domain, and the final booking domain; classify each with `config/source-domains.json` (direct / ota / metasearch / other).
- The agent must stop before entering payment or personal data; no real bookings.
- Store screenshots and the step log as raw data, like API responses in 0.1.

**Output:** share of agent bookings that end on the hotel's own site vs. an OTA, per agent and per hotel.
