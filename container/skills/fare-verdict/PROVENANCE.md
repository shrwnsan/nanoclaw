# PROVENANCE — fare-verdict

Status: **native** (built in this repo). No third-party code, no API keys, no vendored deps.
Build validated live: 2026-10-09 (initial probe) and 2026-10-10 (build validation),
route HKG→CTS one-way 2027-03-16, currency HKD.

## Pinned surface contract

Everything the skill assumes about Google Flights lives in the `SURFACE` block at the top
of `scripts/fare-verdict.mjs`. As built and validated:

- **Deep link** — `https://www.google.com/travel/flights?q=flights%20from%20{FROM}%20to%20{TO}%20on%20{DATE}%20one%20way&curr={CUR}&hl={LANG}` lands results with no UI driving.
- **Ladder** — itinerary cards are `li` elements whose `innerText` is line-structured:
  dep time, `–`, arr time (+1), airline, total duration, route `FROM–TO`, stops line,
  layover line (`7 hr 35 min NRT`), CO2 lines, `CUR$1,435`.
- **Band** — insights panel sentence `usually cost between CUR$1,300–2,150` (en dash;
  comma grouping). High side may lack the currency prefix (bare `2,150`).
- **Series** — 61 `aria-label`s of the form `61 days ago - CUR$1,469` in the expanded
  history panel; relative labels converted to day-ages at scrape time.
- **Collapsed Layer 2** — the panel sometimes renders as `Prices are currently typical`
  with no band sentence and no history labels. The `View price history` control is
  role-less DIVs (no BUTTON / aria-expanded); a plain `.click()` is a no-op. The full
  pointer/mouse event sequence (`pointerdown → … → click`) on the visible text leaf
  expands it. One bounded attempt per load; results are never driven.

## Known fragilities (recorded, not fixed — the skill fails loud instead)

- Listing reshuffles between loads minutes apart (nonstop slice moved 2,019 → 3,444 in
  validation while the floor held) → min-of-N loads is mandatory, never optional.
- The band/series layer is conditional and collapse-prone → explicit ladder-only
  degradation; monitoring guidance disabled without a band.
- Aggregators don't see carrier-direct fare buckets (validated: the flag carrier's
  cheapest nonstop was absent from the surface entirely) → ladder claims are scoped
  "on Google's surface" in every output.
- Date-grid tab content never surfaced in probes (click registered, content didn't) →
  not parsed, not claimed.
- Locale/currency/egress variance: en-dash and comma grouping are assumed in parsers;
  prices differ per IP, so outputs are not reproducible across users.

## Design decisions (adversarial review, 2026-10-09 — 3 rounds)

- **No model in the verdict path.** An LLM inside a deterministic path converts loud
  failure into confident wrong numbers. Verdict text is a template; dates are computed.
- **Stagehand / lightpanda / obscura: cut.** Zero-interaction job (self-healing has
  nothing to heal); latency irrelevant at trip-planning cadence; a 6-month-old
  hype-curve browser repo is a supply-chain profile you don't point at a page-executing
  scraper. One substrate: `agent-browser`.
- **Jev (TypeSafe AI) upgrade path:** the one legitimate role is input-side fuzzy
  constraint parsing ("morning nonstop for 2 adults") with a schema gate + echo-back.
  NOT wired in v1 — the keyword parser is deterministic and its echo shows exactly what
  it resolved. If wired later: Jev proposes the constraint object, the same echo-back
  and validation run unchanged, and the verdict path stays arithmetic.
- **Band-first verdict, priors as tiebreaker.** "61-day low" is vacuous when the whole
  series sits inside the band (validated). Band position is the observed signal.
- **Conservative calendar bounds, not "must-book-by".** Priors used: Google's own
  guidance that international fares are typically lowest at 49+ days ahead; Expedia/ARC
  ~54-day finding; general 2–4 month sweet spot. watch-by = T-120d, hard bound = T-49d.

## Refresh runbook (when the surface moves)

1. `node scripts/fare-verdict.mjs --selftest` — parser fixtures recorded 2026-10-09
   must pass; if they pass but a live run fails, the surface moved, not the parsers.
2. Re-run one live route with known numbers; diff the ladder/band/series shapes.
3. Update the affected regex in `SURFACE` (and only there), refresh fixtures, bump the
   recorded date above, re-run both steps.

## Distribution note

Built and validated for personal, on-demand use (trip planning). The maintainer has not
decided whether this skill is listed on skills.sh: the personal-use posture for reading
Google Flights does not automatically extend to N users' aggregate traffic, and that
decision belongs to the repo owner. Until then: on-demand runs, no schedulers, no loops.
