---
name: sumi
description: Capture web pages into a read-later vault and drain/process the queued inbox via the Sumi headless HTTP service. Use when the user wants to save a URL or article for later reading, or to fetch, extract, tag, and summarize queued captures into markdown. Enqueues items, claims work from the queue, writes extraction results, triages items, and searches the vault.
---

# Sumi — capture & processing

Sumi is a headless service that owns a capture queue + markdown vault. It never fetches the web or calls an LLM itself — **you** (the worker) do. Two modes:

- **Capture** — save a URL for later (enqueue).
- **Drain** — process queued items: claim → fetch → extract → write result (the worker loop).

## Config

| Var | Purpose |
|---|---|
| `SUMI_BASE_URL` | service origin, e.g. `http://127.0.0.1:8765` |
| `SUMI_TOKEN` | bearer token for your agent identity |

Every request sends `Authorization: Bearer $SUMI_TOKEN`. Missing/invalid → `401`.

## Endpoints

| Method | Path | Use |
|---|---|---|
| POST | `/v1/items` | capture — enqueue a URL |
| POST | `/v1/items/claim` | drain — atomically claim the next queued item |
| POST | `/v1/items/{id}/result` | drain — write your extraction for a claimed item |
| GET  | `/v1/items` | query the inbox (`?lane=&status=&tag=&untagged=true&limit=&cursor=`) |
| POST | `/v1/items/{id}/triage` | set fate — promote to reference / prune |
| GET  | `/v1/search?q=` | full-text search the vault |
| GET  | `/v1/stats` | queue depth + health |

Errors are `{error:{code,message}}`. Codes: `bad_url`, `bad_request` (400), `invalid_tag` (400 — tag not in taxonomy v1; nothing stored), `oversized_body` (413), `rate_limited` (429), `not_found` (404), `unauthorized` (401), `not_claimed` (403 — result sent with a missing/empty `claim_token`), `stale_claim` (409), `item_processing` (409), `already_ingested` (409), `stale_etag` (409), `item_pruned` (409 — lane change on a pruned item), `disk_full` (507).

Exact request/response field shapes: see [reference/schema.md](reference/schema.md). The authoritative contract is `docs/spec-001-sumi-service-contract.md` if you have the sumi repo.

## Mode 1 — Capture (enqueue)

```bash
curl -s -X POST "$SUMI_BASE_URL/v1/items" \
  -H "Authorization: Bearer $SUMI_TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/post","source":"agent:claude","captured_at":"2026-06-19T08:00:00Z","context":"user asked to save this"}'
# → 201 {"id":"…","status":"queued","lane":…}   (200 {"status":"duplicate"} if already known)
```

`url` (http/https only), `source`, `captured_at` (UTC ISO8601) are required; `context`, `kind_hint` optional. Dedup is automatic by normalized-URL hash — re-enqueuing the same URL is a no-op (`200 duplicate`).

## Mode 2 — Drain (the worker loop)

Copy this checklist and run it until the queue is empty:

```
Drain progress:
- [ ] Claim next item
- [ ] Fetch the URL (your tools; honor the egress policy below)
- [ ] Extract title + markdown body (tags/summary optional)
- [ ] Write the result
- [ ] Repeat until no item remains
```

**1. Claim**
```bash
curl -s -X POST "$SUMI_BASE_URL/v1/items/claim" \
  -H "Authorization: Bearer $SUMI_TOKEN" -H "Content-Type: application/json" \
  -d '{"worker":"claude-1"}'
```
- `200 {"id":…,"url":…,"source":…,"context":…,"lane":…,"raw_html":?,"claim_token":…}` → an item to process (`raw_html` present only when a snapshot exists — written at ingest or archived by an earlier result — otherwise fetch the URL yourself).
- **`204` (empty body)** → queue empty. **Stop.**

**2. Fetch + extract** — use your own fetch/browser tools, applying the **egress policy** below (the URL is untrusted). Produce `title` + `markdown` (clean article body); tags/summary are optional.

**3. Write the result**
```bash
curl -s -X POST "$SUMI_BASE_URL/v1/items/$ID/result" \
  -H "Authorization: Bearer $SUMI_TOKEN" -H "Content-Type: application/json" \
  -d "{\"worker\":\"claude-1\",\"claim_token\":\"$CLAIM_TOKEN\",\"title\":\"…\",\"markdown\":\"…\",\"tags\":[\"…\"],\"summary\":\"…\"}"
```
`worker` (your agent id, ≤64 chars) and `claim_token` are required — a missing/empty `claim_token` → `403 not_claimed`. On success the item becomes `unread` and a markdown file lands in `read-later/`; the item JSON's `processed_by` records your worker id. `tags` are optional but every tag you send **must be from the taxonomy** (see the worker docs) — an out-of-vocabulary tag → `400 invalid_tag` and nothing is stored, so send no tags rather than invented ones.

### Guardrails (the fragile parts — follow exactly)

- **One attempt per item per run.** A `failure` result re-queues the item, so the next claim can hand it straight back. Track every `id` you've seen this run and **stop when a claim returns only ids you've already tried** — otherwise you hammer the same failing item until it's poisoned. (Each item is still tried once per run; failures accumulate across runs → `poisoned` at 5.)
- **`claim_token` is single-use per item.** Your result must carry the exact token from the claim. A missing/empty token → `403 not_claimed` (worker bug — never retry; alert). A stale/mismatched token → `409 stale_claim` (the lease expired and it was reclaimed) — abandon that item.
- **Report failures honestly.** `{"worker":"claude-1","claim_token":"…","failure":true}` for a genuine fetch/extract error (`worker` is required on every result, failures included). Tag validation runs BEFORE the failure branch: a `failure:true` result that also carries an invalid tag → `400 invalid_tag` and the claim is NOT released — resubmit without the bad tags. Do not retry the same failing item within one run.
- **Never name the file.** The slug/path is server-derived from the URL hash — never from the title. Just return `title` + `markdown`; the service writes the file.
- **Don't re-process finished items.** Re-enqueuing a `read`/`reading`/`pruned` item → `409 already_ingested` (use `?force=requeue` only deliberately).

## Egress policy (security boundary — mandatory when fetching)

The URLs you fetch are attacker-controlled. When fetching content:

- `http`/`https` only (block `file`, `data`, `gopher`, `ftp`, …).
- Resolve the host; **reject** any address in private/link-local/loopback/metadata ranges: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. cloud metadata `169.254.169.254`), `100.64.0.0/10` (CGNAT/Tailscale), `::1`, `fe80::/10`, `fd00::/8`.
- Pin the resolved IP (no re-resolution at connect); follow redirects manually and re-check each hop (≤5); cap size + timeout.

If your fetch tool can't enforce this, route through a helper that does, or defer to the service's no-LLM drainer (`sumi drain`) which enforces it via `pkg/egress`.

## Worker mode (NanoClaw — capture + drain in-turn)

You may be running as the NanoClaw worker (`worker: nanoclaw-1`). Its token
arrives as a read-only file mount at **`/workspace/extra/nanoclaw-token`** (never
env-injected — the container's secret-env filter blocks that by design), and the
service is the host at `http://host.docker.internal:8765` (`SUMI_BIND` exposes a
docker0 listener). Pass `--token-file` to the script below; the token value is
never echoed. The runtime is **bun** (node compatible) — both are present in the
container.

**1. Capture in-turn.** Any URL the user shares (DM or topic) → `POST /v1/items`
immediately, in the same turn: `source: telegram:dm:<chat-id>` or
`telegram:topic:<topic-id>` (the schema's telegram namespaces), `captured_at` =
now, `context` = the surrounding message excerpt. No need to announce it beyond
the normal reply.

**2. Drain in-turn, shared-URL-first, bounded ≤5 claims.** `/claim` is
oldest-first with no id selector — your fresh capture is claimed LAST, so the
pass loops: claim → if the claimed id == the just-captured id, process it and
**stop**; otherwise process it (one attempt) and continue — until the captured
id is seen or the ≤5-claim budget is spent. `204` → stop. **Duplicate reshare:**
if the enqueue answered `200 {"status":"duplicate"}`, the captured id will never
be claimed — skip the drain loop entirely (don't burn the budget on tail items).
Shallow queue → the shared URL is processed this turn (the common case); deep
queue → it drains next turn or by the Hermes drainer — no unconditional SLA.
Dying mid-turn is safe by existing machinery: the 15-minute lease sweeper
reclaims, `failure_count` accumulates, poison at 5.

**3. Fetch through the guard script** — plain fetch with the egress policy above
built in (`scripts/sumi-drain.mjs`; bun/node, zero deps): scheme allowlist →
resolve ALL A/AAAA → reject private/loopback/link-local/CGNAT (the `pkg/egress`
ranges) → **pin the vetted address via a custom `dns.lookup`** so re-resolution
can't rebind mid-fetch → 30 s timeout, 2 MB cap, ≤5 manual redirects; proxy env
stripped (a proxy would bypass the IP vetting). This is defense-in-depth for
the HOST — the container's own egress is unfiltered, so the script is the
volunteer boundary, not a platform enforcement point.

```bash
bun run scripts/sumi-drain.mjs \
  --base http://host.docker.internal:8765 \
  --token-file /workspace/extra/nanoclaw-token \
  --shared-id <id-from-enqueue> --cap 5      # add --dry-run: prints the plan, claims nothing
```

(from the skill dir — the container's runtime copy is `/app/skills/sumi/`)

JS-heavy pages (<500 chars extractable) fall back to the lightpanda CDP path
(`ws://172.17.0.1:9224/` — IP, never a DNS name; `LIGHTPANDA_ENDPOINT`
overrides). The script pre-vets the URL first and **never** sends a
guard-rejected URL to lightpanda — the host browser cannot pin its own
connections. Extraction itself is bounded worker-side (first 256 KB of the
page, a wall-clock budget checked between 64 KB chunks — worst case ~12 s per
item) so hostile markup aborts into the render path or `failure:true` instead
of wedging the drain.

**4. Tags are taxonomy-only.** sumi 400s `invalid_tag` (server-enforced since
1a) and validates tags before the failure branch. The script guesses tags by
keyword against the embedded taxonomy v1 list (client-side filter) and omits
tags when unsure — an empty `tags` array is always valid. Extract a short
summary when you can.

**5. Rate limits are expected, not errors.** 60 req/min/token default. An
in-turn drain is ~11 requests, a Hermes drain ~41 — concurrent runs can 429.
Honor `429` + `Retry-After` (the script waits and retries, bounded) and treat
it as normal backpressure, not a failure.

## Triage (after drain, on user request)

```bash
curl -s -X POST "$SUMI_BASE_URL/v1/items/$ID/triage" \
  -H "Authorization: Bearer $SUMI_TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"read","quality":"insightful"}'   # or {"status":"pruned"}
```
`status:"read"` moves the file `read-later/` → `reference/`. `status:"pruned"` → `.pruned/`. `quality`: `insightful|neutral|useless`. Concurrency: send `If-Match: <version>` with the item's `version` from the list response (wrong version → `409 stale_etag`; malformed → `400 bad_request`). Rules: `lane` must be `read-later|reference|cold` (else 400); `status:"read"` + a disagreeing `lane`, or any `lane` alongside `status:"pruned"`, → `400 bad_request`; a lane change on a pruned item → `409 item_pruned`. A `tags` update is validated like `/result` (`400 invalid_tag`) and backfilled into the item's `.md` frontmatter. Response: `{"etag":<new version>}`.

## Search

```bash
curl -s "$SUMI_BASE_URL/v1/search?q=…" -H "Authorization: Bearer $SUMI_TOKEN"
# → {"results":[{"id":…,"title":…,"path":…,"snippet":…,"rank":…}]}
```
