# Destination mode

Question: **what do AI assistants recommend in one destination?** (not: how is one hotel doing).
Separate from the hotel mode: own code (`src/destination/`), own config (`config/destination.json`),
own database (`data/destination.db`). Phases 3 and 4 of the hotel mode are untouched and stay frozen.

## What it does
1. Asks 8 guest-style questions about one destination (`{d}` = destination name) to each engine in
   `web_search` mode only (default engines: OpenAI, Gemini, Claude Sonnet 5.5), `REPETITIONS` times each.
2. Stores every answer and its sources unchanged (append-only).
3. An analyzer (Claude Haiku, forced tool call) extracts per answer, for every named lodging in order of first mention:
   - the location the answer gives;
   - `sentiment` (`recommended` / `neutral` / `not_recommended`) with `sentiment_quote`, an exact quote of at most 25 words it is based on;
   - `booking_target`, decided ONLY from an explicit instruction in the answer about where to book that lodging:
     `direct` (own site or phone/e-mail of the lodging), `ota` (an online travel agency named as the place to book),
     `portal` (a tourism portal such as bled.si), `unspecified` (no such instruction), with `booking_evidence` = the exact words;
   - `cited_sources`: sources the answer cites for it (Booking.com or Tripadvisor as the source of a score). These are NOT booking instructions;
   - `linked_urls`: every URL the answer attaches to it. A link to the lodging's own site without a booking instruction is `unspecified`, not `direct`;
   - `possible_duplicate_of`: the name of another lodging in the same answer that it resembles. Names are never merged automatically; the
     report lists the resemblance under "Manual check".
   It never judges whether a hotel exists.
4. The report counts, per hotel, in how many answers it appears, and marks hotels to check by hand.

## Commands (`npm run cli -- ...`)
| command | what it does |
|---|---|
| `destination-validate` | checks the config, API keys and that prices are filled in |
| `destination-plan --run-name NAME [--destination bled] [--repetitions N] [--engines a,b]` | builds the jobs and prints the cost estimate (verified vs unverified prices). No API call. |
| `destination-run --run-name NAME [--engines a,b] [--retry-failed] [--limit N]` | asks the questions, then analyses the answers. Continues a stopped run. |
| `destination-report --run-name NAME [--out data/NAME.md] [--examples N] [--max-chars N]` | hotel table, manual-check list, estimate vs actual cost, extraction examples, verbatim answers |

## Safety rules
- **Hard budget** `BUDGET_EUR`: the run is refused if it is not set, if a price is missing, or if the estimate is above
  it. During the run, no call is started if spend so far + calls in flight + the next call would pass the budget
  (the reserve for a call grows if real calls turn out dearer than estimated). Cost figures are tokens × the prices
  in `engines.json`, not the provider's invoice.
- An engine that fails 3 jobs in a row is marked UNAVAILABLE; its remaining jobs stay pending and the report says
  clearly which engines are missing. Use `--engines openai,anthropic` to run without one.
- Prices: `price_status` in `destination.json` says which prices are verified. Update it yourself after checking
  the official page. The OpenAI price in `engines.json` is entered by the owner, not by the tool.
- Token counts per call are assumptions (`cost_assumptions` in `engines.json`). OpenAI and Anthropic have their own measured values
  (run `bled-trial-01`, 2026-10-18, 8 calls each); Gemini still uses the global guess. The analyzer value dates from the first
  analyzer version and the new fields make its output longer, so measure it again after the next analysis.

## Analyzer versions
The first analyzer version stored `recommended` and a booking pointer that also counted cited sources and links
(`hotel_site` / `ota` / `other_link` / `none`). Those analyses stay in the database (append-only) and the report still reads them,
but shows their booking column as `unspecified` and warns that they are not comparable. Analyses in the current format replace them
in the report (the newest valid analysis of an answer is used).

## Limits to remember
- The tool cannot check that a hotel exists or is in the destination: assistants can invent hotels. The report
  lists hotels to verify (only one answer or engine, location differs or never stated, name not in any source,
  possible duplicate), but every hotel you rely on needs a manual existence check.
- The booking column shows only what the answer explicitly tells the guest to do for that lodging. Many answers give no such
  instruction per lodging, so `unspecified` is common and normal. Judgement of "own site" versus another link is no longer needed.
- Gemini source links are Google redirect links; the domain comes from the source title.
