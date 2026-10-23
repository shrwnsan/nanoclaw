---
name: fare-verdict
description: Advisory flight-fare verdict for a route and date from Google Flights' own price-insights surface. Extracts the fare ladder (min of multiple page loads), the typical-price band, and the 61-day price history, then answers "is this price good / should I book now or wait" with band-position zones plus conservative watch-by and hard-bound dates. Use when the user asks whether a flight price is good, when to book flights, whether to wait for a cheaper fare, or for typical price / price history context on a route. Not a booking tool, not a price-prediction tool, one-way searches only.
allowed-tools:
  - Bash(node *)
  - Bash(agent-browser *)
---

# Fare Verdict

Advisory verdict on a flight fare, derived from what Google Flights itself publishes about
a search: the itinerary ladder, its "typical price" band, and its 61-day price history.
The verdict is deterministic arithmetic on those three artifacts — no model in the loop.

## Requirements

- Node 18+ and the `agent-browser` CLI on PATH (the [docker-agent-browser](../docker-agent-browser/) skill sets that up in containers).
- No API keys. Reads the public results page through a real browser.

## Quick start

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fare-verdict.mjs" --from HKG --to CTS --date 2027-03-16

# constrained ("morning nonstop" is parsed from keywords and echoed back):
node "${CLAUDE_SKILL_DIR}/scripts/fare-verdict.mjs" --from HKG --to CTS --date 2027-03-16 \
  --constraints "morning nonstop, 1 adult"

# machine-readable:
node "${CLAUDE_SKILL_DIR}/scripts/fare-verdict.mjs" --from HKG --to CTS --date 2027-03-16 --json-only

# offline parser checks (no network — run after any edit):
node "${CLAUDE_SKILL_DIR}/scripts/fare-verdict.mjs" --selftest
```

Options: `--currency HKD` (display currency; must be one the page renders), `--lang en`,
`--loads 3` (independent page loads, min 2), `--window morning|afternoon|evening|redeye`,
`--nonstop`, `--constraints "…"` (keyword parser: window names, nonstop/direct, pax count).

## What it measures

1. **Ladder** — cheapest itinerary per slice (all / nonstop / departure window), as the
   **minimum across independent page loads**. A single load from an inventory-backed
   surface is a sample: in recorded validation the nonstop slice moved ~60% between two
   loads minutes apart while the floor held. Only min-of-loads, and the floor, are facts.
2. **Band** — Google's own "least expensive flights … usually cost between X–Y" range.
   The band sometimes renders collapsed ("Prices are currently typical" with no range);
   the script makes one bounded expansion attempt (the panel's history control) and
   degrades explicitly to a ladder-only verdict if the range still doesn't surface.
3. **Series** — the 61-day price history from the insights panel, relative labels
   converted to absolute ages at scrape time and schema-validated (≥8 points, no
   duplicate days) or refused.

## Reading the verdict

Band position of the constrained slice drives the call; booking-window priors are
tiebreakers only — they are population studies and mislead seasonally:

| Position vs band | Meaning |
|---|---|
| below-band | Below typical — confirm on a second run before acting |
| low-in-band (≤33%) | Fair; watch for a held downward band-crossing |
| mid-band (34–66%) | Typical; the decision window is where sale waves land |
| high-in-band / above-band | Paying the top of (or above) typical — wait if flexible |

Two conservative dates accompany every verdict: **watch by** (T-120d — start weekly
checks) and a **hard bound** (T-49d — past it, book rather than optimize). Neither is a
"must-book-by": the tool deliberately refuses to fake that precision.

Alert-style guidance follows one rule: only a move below the band low, **held across two
loads**, is a signal. Single-load drops are sampling noise.

## Rules the tool enforces

- Minimum 2 loads; refuses `--loads 1`.
- Fails loud on surface drift: consent/bot walls, zero parsable itineraries, short or
  duplicated history series, insane bands — each aborts with the failed check named,
  never guesses through.
- One-way only in v1 (round-trip parsing is untested and refused).
- Constraint parsing echoes exactly what it resolved (`window=morning, nonstop-only,
  1 pax (informational)`); nothing is interpreted silently.
- Ladder claims are scoped to Google's surface — carrier-direct buckets (an airline's
  own site) may be invisible to it; the output says so on every run.

## Limits

- Per-adult, one-way prices as displayed to the running egress; locale and IP can change
  what Google shows, so numbers aren't reproducible across users.
- The insights surface is JS-rendered tooltip prose, not a published API — see
  [PROVENANCE.md](PROVENANCE.md) for the pinned extraction contract, known fragilities,
  and the refresh runbook. Run `--selftest` after any edit.
- Personal-use cadence only (trip planning, on-demand checks). Do not loop it; Google's
  anti-bot walls are the wrong failure mode to poke, and aggregate use of this pattern is
  bulk scraping. See the distribution note in PROVENANCE.md.
