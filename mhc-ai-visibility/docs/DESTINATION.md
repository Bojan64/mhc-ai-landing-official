# Destination mode

Question: **what do AI assistants recommend in one destination?** (not: how is one hotel doing).
Separate from the hotel mode: own code (`src/destination/`), own config (`config/destination.json`),
own database (`data/destination.db`). Phases 3 and 4 of the hotel mode are untouched and stay frozen.

## What it does
1. Asks 8 guest-style questions about one destination (`{d}` = destination name) to each engine in
   `web_search` mode only (default engines: OpenAI, Gemini, Claude Sonnet 5.5), `REPETITIONS` times each.
2. Stores every answer and its sources unchanged (append-only).
3. An analyzer (Claude Sonnet 5.5 since analyzer v4, forced tool call; Haiku 4.5 before) extracts per answer, for every named lodging in order of first mention:
   - the location the answer gives;
   - `sentiment` (`recommended` / `neutral` / `not_recommended`) with `sentiment_quote`: an exact quote it is based on. The model is asked
     for at most 20 words; the code cuts anything over 25 words to 25 words + "…" and sets `quote_truncated: true`. A long quote never makes an analysis invalid;
   - `booking_target`, decided ONLY from an explicit pointer in the answer that tells the guest where to book THAT lodging:
     `direct` (own or official booking site, phone/e-mail of the lodging), `ota` (an online travel agency named as the place to book),
     `portal` (a tourism portal such as bled.si), `unspecified` (no such pointer; the normal case), with `booking_evidence` = the exact words.
     Not pointers: a bracketed link that is only the source, a general rule ("book direct if prices are equal"), a list or rating mention
     ("appears among Booking.com's options"). The prompt gives Vila Bled, Vila Alpina and Rikli as negative and Old Bled House as positive example;
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
| `destination-reanalyze --run-name NAME [--engines a,b]` | analyses stored answers again with the current analyzer (only those whose newest analysis is missing or from the first analyzer version). Asks no engine anything, adds new analyses next to the old ones, same hard budget. The first analysis runs alone and stops everything if it is not valid. |
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

## Hand-checked hotel facts
`config/destination-facts.json` holds facts the owner checked by hand: name, aliases, `status` (`closed` / `open`), `valid_until`,
`source`, `checked_on`. The file is optional and used only by the report; it changes nothing about the questions or the analysis.
For every hotel with status `closed` (and for answers given before `valid_until`) the report has a section
"Priporočila nedosegljivih hotelov": per engine how often the hotel is named, how often it is `recommended`, `neutral` or
`not_recommended` (with the `sentiment_quote`), and separately how often the engine itself says the hotel is closed.
That last count is a text heuristic (a line that names the hotel or an alias together with a closure word such as
"closed", "reopening", "renovation"; "renovated" does not count), so the matching lines are printed for a check by eye.

## Analyzer versions
Every stored analysis carries `analyzer_version` (current: `v4`, constant `ANALYZER_VERSION` in `schemas.ts`; raise it whenever the prompt or
the meaning of a field changes). `destination-reanalyze` re-analyses every answer whose newest valid analysis is not the current version.
v2 analyses (no version field, booking rule looser, quotes rejected above 25 words) and v3 analyses (Haiku, booking rule only in the
prompt) are still read and shown as `v2` / `v3`.

v4 adds two safety nets in code, because the model did not follow the booking rule reliably (in v3, 7 of 9 booking pointers were only ratings
or bracketed source links):
- **Booking safety net** (`src/destination/finalize.ts`): a `booking_target` other than `unspecified` is kept only if `booking_evidence`
  contains an explicit pointer (a booking verb or "official site" phrase). Otherwise the code sets `booking_target` to `unspecified`, marks
  `booking_demoted: true` and keeps the model's value (`booking_demoted_from`), the evidence and the reason. The report lists every demoted case.
  Wording that is a pointer but uses none of the cue words would be demoted wrongly; that is why the list is printed.
- **Possible duplicates**: hotels of one answer that share a distinctive part of the name (not generic words such as hotel, vila, villa, garni,
  penzion, grand, and not the destination name) are both marked in `possible_duplicate_of` for manual review. Nothing is merged.
The first analyzer version (v1) stored `recommended` and a booking pointer that also counted cited sources and links
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
