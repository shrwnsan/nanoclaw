# Sumi API — field reference

Exact request/response field shapes. Authoritative source: `docs/spec-001-sumi-service-contract.md`.

## POST /v1/items — enqueue (capture)

Request:

| field | req | notes |
|---|---|---|
| `url` | ✔ | `http`/`https` only; normalized for dedup (§8 of spec) |
| `source` | ✔ | free text, e.g. `agent:claude`, `telegram:topic:42` |
| `captured_at` | ✔ | UTC ISO8601 |
| `context` |  | free text |
| `kind_hint` |  | default `read-later` |
| `raw_html` |  | pre-fetched HTML, ≤2 MB (else 413) |

Response: `201 {"id":…,"status":"queued","lane":…}` — `201` = created. `200 {"status":"duplicate"}` if the normalized URL is already known (no re-ingest); `?force=requeue` / `?force=overwrite` also answer `200` when they reset a row. `?force=requeue` re-enqueues only if `queued`/`unread` (else `409 item_processing` / `409 already_ingested`); `?force=overwrite` only if user-untouched. `?force=overwrite` clears title/summary/tags **and `processed_by`** (a fresh ingest must not report the previous round's worker); `?force=requeue` keeps `processed_by`. A `raw_html` snapshot is persisted to `.raw/<id>.html` on create / force-reset (replacing any existing snapshot); on a plain duplicate the incoming `raw_html` is discarded.

## POST /v1/items/claim — claim next item

Request: `{"worker":"claude-1","lane":"read-later"}` — `worker` required and validated like `/result` (≤64 chars, `[A-Za-z0-9._-]`; missing/invalid → `400 bad_request`); `lane` optional.

Response:
- `200 {"id":…,"url":…,"source":…,"context":…,"lane":…,"raw_html":?,"claim_token":…}` — `raw_html` present only when a snapshot exists (written at ingest or archived by an earlier result; else fetch the page yourself), **or**
- **`204`** empty — queue empty. Stop draining.

Atomic (one item per claim); 15-minute lease. On 204, back off (`sleep min(2^n,60)`).

## POST /v1/items/{id}/result — write extraction

Request:

| field | req | notes |
|---|---|---|
| `worker` | ✔ | your agent id — ≤64 chars, `[A-Za-z0-9._-]` (else `400 bad_request`); recorded as the item's `processed_by` |
| `claim_token` | ✔ | the token from the claim; missing/empty → `403 not_claimed` (checked before `worker`); mismatch → `409 stale_claim` |
| `title` |  | ≤300 chars |
| `markdown` |  | extracted article body |
| `tags` |  | `[]string`, each ≤40 chars, **must be in taxonomy v1** (`400 invalid_tag` — zero side effects; valid tags stored lowercase) |
| `summary` |  | ≤1000 chars |
| `entities` |  | `[{"name":…,"type":…}]` |
| `raw_html` |  | ≤2 MB archived snapshot |
| `failure` |  | `true` → increment `failure_count`, release claim, no file write |

Response: `200` on write. `400 invalid_tag` if any `tags` entry isn't in taxonomy v1 (nothing is written on rejection) — this holds on `failure:true` too: tags are validated before the failure branch, so the claim is NOT released; resubmit without the bad tags. Writes `read-later/<slug>.md` + `.raw/<id>.html`; sets `status:"unread"` and records `processed_by` (failure path never sets it).

## GET /v1/items — query

Params: `lane`, `status`, `since` (UTC ISO8601, exclusive), `tag` (comma list, any-of), `untagged` (`true` literal — items whose `tags` is empty, status `unread`/`read`; intersects with `lane`/`status`), `limit` (≤200), `cursor`.

Response: `{"items":[{"id":…,"slug":…,"title":…,"url":…,"tags":…,"summary":…,"lane":…,"status":…,"captured_at":…,"processed_by":?,"version":…}],"next_cursor":?}` — `processed_by` is the worker that produced the current extraction (`null` until a result sets it); `version` is the counter `/triage`'s `If-Match` gates on.

## POST /v1/items/{id}/triage — set fate

Request (partial): `{"status":?,"quality":?,"tags":?,"wiki_candidate":?,"lane":?}` + optional `If-Match: <version>` header.

- `status:"read"` → move `read-later/<slug>.md` → `reference/`.
- `status:"pruned"` → move to `.pruned/`, delete `.raw`.
- `quality`: `insightful|neutral|useless`.
- `tags` → validated like `/result` (`400 invalid_tag`) and backfilled into the `.md` frontmatter `tags` key (other keys preserved).
- `lane` → whitelist `read-later|reference|cold` (else `400 bad_request`); the file is renamed into the new lane directory.
- Conflicts → `400 bad_request`: `If-Match` not an integer ≥1; `status:"read"` with a `lane` other than `reference`; any `lane` alongside `status:"pruned"`. → `409`: `item_processing` (item being worked), `stale_etag` (version moved), `item_pruned` (lane change on a pruned item).

Response: `200 {"etag":<new version>}`.

## GET /v1/search?q=

FTS5. Response: `{"results":[{"id":…,"slug":…,"title":…,"path":…,"snippet":…,"rank":…}]}`. Excludes pruned unless `?include_pruned=true`.

## GET /v1/stats

`{"queue_depth":{"queued":…,"processing":…},"poisoned_count":…,"p50_ms":…,"p99_ms":…,"last_backup_ok":…,"last_backup_at":?}`.

## Vault model

- **Lanes:** `read-later` (unread queue), `reference` (read), `cold` (backlog reservoir, promotable).
- **Slug:** `<YYYY-MM-DD>-<domain>-<id[:16hex]>`, derived from the URL hash only — never the title.
- **Status lifecycle:** `queued` →(claim)→ `processing` →(result)→ `unread` →(triage:read)→ `read` [→ `reference/`] · `unread`→(triage:prune)→ `pruned` [→ `.pruned/`] · `processing`→(5 failures)→ `poisoned`.

## Limits

`MAX_BODY_BYTES` 2 MB (also bounds `raw_html` — no separate knob) · enqueue rate 60/min/token · `poisoned` at 5 failures.
