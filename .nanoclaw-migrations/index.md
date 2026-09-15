# NanoClaw Migration Guide — fork dev → upstream v2.3.0+

Generated: 2026-09-15
Base (merge-base): `61d7ca6bbafc0137f305cce364447f7603ab7549` (v2.0.58)
HEAD at generation: `ded5eb95` (dev, 46 commits over base)
Upstream: `a26c7ffb` (upstream/main, 1190 commits over base; v2.3.0 tagged at `dce271c6`)
Source analysis: the operator's private upgrade recon guide (§2026-09-15 refresh; fate table + seam analysis).

## Decisions (binding for this replay)

- **Upgrade path:** clean-base replay via `/migrate-nanoclaw` (this guide), NOT merge/rebase, NOT `/update-nanoclaw`.
- **Bare-text output = Option B.** Skip `2892a1c4` (bare-text fallback) and `25faccc3` (duplicate-send guard) entirely; rely on upstream's nudge mechanism (`taskBlockNudge`). This also means the bare-text-stripping half of `18c00d3d` (#40) is dropped — only its cross-process batch-routing sidecar and `<internal>` handling relevant to the MCP path are ported. Consequence: non-Claude models pay two API calls when output is unwrapped; accepted.
- **Landing:** `upgrade/v2.3.0` branch → PR → merge to `dev` (rollback = branch switch). No force-push of dev.
- **Sanitization:** no real chat IDs, handles, group names, session/agent IDs anywhere pushed to the public fork. Scan before push (memory: pre-push, not post).
- **Untracked proprietary skills** (`container/skills/dataviz`, `dataviz-tufte`, `frontend-design`, `motion-craft`) are NOT committed, NOT ported — they stay untracked in the main working tree and survive the swap untouched. Never push these.

## Migration Plan

Replay order (dependency-driven; topics family last because everything it touches moves under it):

1. Security trio + hardening (Dockerfile chmod/env, webhook bind, unknown-sender default, pnpm supply-chain keep) — section 01
2. Container image bits (musl one-liner re-attach, CJK build-arg, NO_PROXY at driver seam, image self-heal concept) — section 01
3. Install-specific skills (isolated, independent) — section 02
4. Destinations (`thread_id` + orphan sweep + projection) — section 03
5. Task-surface reworks (`ncl tasks` world) — section 04
6. Telegram topic-routing family (LAST — mailbox seam, taskRun rename, sidecar redesign) — section 05
7. Docs + CLAUDE.md/project-doc items — section 06
8. Validate, land PR, cutover runbook — section 07

Staging: sections 1–3 validate independently (build after each). Sections 4–6 are one coherent code pass followed by full validation (build + tests + typecheck + `detect-driver-migration.ts`).

## Applied Skills (custom, copy whole from dev tree)

Upstream trunk ships: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `welcome` (all arrive with the upgrade). Ours, none upstream, port verbatim:

| Skill | Files | Source commits |
|---|---|---|
| `container/skills/weather` | 55 | `01c5c01e`, `60867fc5`, `ca923606`, `0589e466` (final state v0.3.4) |
| `container/skills/tg-logs` | 2 | `818bd17f`, `86c86a73`, `33a0cb71`, `52be6b7c` |
| `container/skills/meta-search` | 12 | `a36f3c4a` + OneCLI proxy fix `a4afe440` |
| `container/skills/remotion` | 1 | `a36f3c4a` |
| `container/skills/slack-formatting` | 1 | `a36f3c4a` |
| `container/skills/systematic-debugging` | 2 | `a36f3c4a` |
| `container/skills/tailnet-cdp` | 1 | `a36f3c4a` |
| `container/skills/vercel-cli` | 1 | `a36f3c4a` |

Not ported: `container/skills/qmd` — removed from dev 2026-09-08 (#43), QMD retired. Do not resurrect.

## Skill Interactions

- `meta-search`'s OneCLI proxy support (`a4afe440`) assumes the OneCLI gateway env shape (`ONECLI_*` / proxy at 10255). No interaction with other skills.
- `tg-logs` reads the tg-topic-ingest SQLite DB via a bind mount declared outside the repo (container config in central DB). Repo-side it is inert files.
- Upstream's new `frontend-engineer` trunk skill coexists; no file collisions (checked).

## Supply-chain keep (not in fate table — found during extraction)

Upstream nests `minimumReleaseAge` under a `pnpm:` key in `pnpm-workspace.yaml`, which pnpm silently ignores (gate = no-op). Our fork moved it to the top level with an explanatory comment, and added `better-sqlite3` to `onlyBuiltDependencies`. **Keep the fork's version** of `pnpm-workspace.yaml` (top-level `minimumReleaseAge: 4320` + comment + `better-sqlite3` entry); merge upstream's `onlyBuiltDependencies` entries if any new ones appear. Do not run bare `pnpm install` in automation contexts; use `--frozen-lockfile` (no host deps are added by this replay — verified).

## Post-upgrade runbook

See section 07: upgrade-state marker stamping, `/migrate-memory` for each existing group (enumerate live groups at cutover: `ncl groups list`), `/migrate-slack-agents` (expected clean no-op — no Slack channel installed), `/add-telegram` reinstall + MD-escape check, `.claude-fragments`/`.claude-shared.md` cleanup per upstream breaking note, container rebuild, cutover verification, rollback paths.
