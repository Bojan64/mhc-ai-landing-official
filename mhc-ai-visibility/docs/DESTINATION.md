# Destination mode

Question: **what do AI assistants recommend in one destination?** (not: how is one hotel doing).
Separate from the hotel mode: own code (`src/destination/`), own config (`config/destination.json`),
own database (`data/destination.db`). Phases 3 and 4 of the hotel mode are untouched and stay frozen.

## What it does
1. Asks 8 guest-style questions about one destination (`{d}` = destination name) to each engine in
   `web_search` mode only (default engines: OpenAI, Gemini, Claude Sonnet 5.5), `REPETITIONS` times each.
2. Stores every answer and its sources unchanged (append-only).
3. An analyzer (Claude Haiku, forced tool call) extracts per answer: every named lodging in order of
   first mention, the location the answer gives, whether it is recommended, and where the answer sends
   the guest to book (own site / OTA / other link / none). It never judges whether a hotel exists.
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
- Token counts per call are assumptions (`cost_assumptions` in `engines.json`), measured only for Claude.

## Limits to remember
- The tool cannot check that a hotel exists or is in the destination: assistants can invent hotels. The report
  lists hotels to verify (only one answer or engine, location differs or never stated, name not in any source,
  possible duplicate), but every hotel you rely on needs a manual existence check.
- "Hotel site" booking pointers are judged from the link and the answer text; without a hotel list the tool does
  not know a hotel's own domain, so treat that column as an estimate.
- Gemini source links are Google redirect links; the domain comes from the source title.
