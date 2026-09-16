# Section 07 — Validation, landing, cutover runbook

## 7.1 Validation (worktree)

```bash
cd /home/ubuntu/nanoclaw/.upgrade-worktree
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run mailbox-model:check          # if model.ts touched (section 03.2)
bun scripts/detect-driver-migration.ts   # expect: nothing detected
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test --isolate && cd -
./container/build.sh                  # re-attached musl one-liner; INSTALL_CJK_FONTS=true from .env
docker run --rm nanoclaw-agent:latest bun -e "console.log('ok')"   # image sanity
```

Also verify: `grep -rn "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/` → no hits. Janitor compatibility: confirm the daily `docker-image-prune` scoping still matches the image naming (labels/`ncl-…` names; our pins `pre-upgrade-20260915*` must not be reclaimed — they're extra tags on referenced IDs, safe, but verify the janitor's filter).

## 7.2 Landing (PR, no force-push)

1. Sanitization scan BEFORE push: `git diff upstream/main..upgrade/v2.3.0` + `git log upstream/main..upgrade/v2.3.0` — grep for real chat IDs (`-100\d+`, numeric IDs), handles, group names, session/agent IDs; confirm no proprietary skill dirs (dataviz*, frontend-design, motion-craft) and no `.env`/secrets.
2. Push `upgrade/v2.3.0` to origin → PR to `dev` → merge. Rollback = branch switch to `backup/pre-migrate-ded5eb95-20260915-134903` / tag `pre-migrate-ded5eb95-20260915-134903`.
3. Main tree: `git checkout dev && git pull`. Main tree `.nanoclaw-migrations/` arrives via the merge.
4. Update guide header hashes (HEAD/upstream post-merge), commit.

## 7.3 Pre-boot steps (BEFORE starting the host)

Order matters — the tripwire refuses boot without the marker, and migrations may need the explicit path:

1. `pnpm install --frozen-lockfile && pnpm run build` in the main tree (fresh dist).
2. **Schema migration path:** check whether boot auto-applies migrations; if `pnpm run migrate` is the explicit path (backend-ready changelog entry), run it — our section 03.1 ALTER must land in the live v2.db. Verify: `pnpm exec tsx scripts/q.ts data/v2.db "PRAGMA table_info(agent_destinations)"` includes `thread_id` (it already does on this install — expect no-op) and schema_version rows are sane.
3. **Upgrade-state marker (mandatory):** `pnpm exec tsx scripts/upgrade-state.ts set "" migrate-nanoclaw` (raw `git pull`-style boots exit(1) at `enforceUpgradeTripwire()`, `src/index.ts:71`; recovery doc: `docs/upgrade-recovery.md`).
4. **Systemd env sync** (memory: `.env` edits don't reach containers through systemd): if any NEW env vars matter (`NANOCLAW_DEFAULT_MODEL`, `NANOCLAW_FAST_MODE`, `TELEGRAM_INSTANCES` post-/add-telegram), sync `~/.config/nanoclaw/environment` + restart host service.
5. Data cleanup: `rm -rf groups/*/.claude-fragments groups/*/.claude-shared.md` (inert leftovers, upstream instruction).
6. Confirm `.env` `INSTALL_CJK_FONTS=true` survives; container image `nanoclaw-agent:latest` present (freshly built in 7.1).

## 7.4 Cutover (at operator's go; first upgraded startup REMOVES the running pre-seam container)

```bash
systemctl --user restart nanoclaw
```

Then, from the merged dev tree, post-boot skills in this order:
1. `/add-telegram` (reinstall adapter, section 06.5; then host restart again if the skill instructs).
2. `/migrate-memory` for EACH existing group (enumerate at cutover via `ncl groups list`; mandatory before use — un-migrated groups boot amnesiac, not erroring). Skill pauses task series + stops the group's container per group.
3. `/migrate-slack-agents` (expect clean no-op record; no Slack channel installed).
4. Group instruction edits: replace `schedule_task`/`update_task` MCP references with `ncl tasks` usage (groups/*/ CLAUDE.md / instructions data-side).
5. Verify `ncl destinations` shows `thread_id` on topic destinations (e.g. `alerts`); re-set via `ncl destinations update --thread-id <id>` if the ported verb needs a nudge after migration.

## 7.5 Phase-9 verification

| Check | How |
|---|---|
| Host boots, schema sane | error log clean; `enforceUpgradeTripwire` passed; `ncl sessions list` |
| Telegram connects | adapter logs; send a DM from the operator account → reply arrives |
| Container starts under driver seam | `docker ps --filter label=nanoclaw-session` (new `ncl-…` names; old name as label) |
| Group reply works | message in the live group → topic-routed reply lands in the SAME topic |
| Scheduled task → topic | trigger/await the recurring weather briefing → lands in pinned `alerts` topic (section 03/04 path) |
| MD rendering | bold/italic/link survive outbound (SDK 4.29 handles escaping) |
| Proxy egress | container API call via gateway 200; local MCP traffic NOT proxied (NO_PROXY) |
| Label-based tooling | any status/audit filters switched from name to label filters |
| Watchdog | `nanoclaw-healthcheck` (4h grace) stays quiet; heartbeat-based fleet untouched |

## 7.6 Rollback paths (staged)

- **Git:** branch switch `git checkout backup/pre-migrate-ded5eb95-20260915-134903` (or reset dev to tag `pre-migrate-ded5eb95-20260915-134903`). PR-revert also possible post-merge.
- **Data:** restore `v2.db` + `v2-sessions/` + `groups/` from `~/backups/nanoclaw/pre-upgrade-v2.3.0-20260915-082033/` (includes `.env`). DB migrations are forward-only — NEVER roll back a migrated DB file; restore the old one.
- **Agent images:** before cutover, tag the pre-upgrade images for rollback (find the repo name + the tag the live container actually runs via `docker inspect <container> --format '{{.Config.Image}}'` and `docker images`; add `:pre-upgrade-<date>` tags). Restore within the same day or before the daily image janitor runs (extra tags on referenced IDs are safe from a scoped janitor, but verify its filter).
- **Gateway:** untouched by this upgrade (1.41.0, verified end-to-end earlier today). If NanoClaw rolls back AND SDK pin changed: re-pin `@onecli-sh/sdk` in package.json + `pnpm install`.
- **Memory migration:** `/migrate-memory` stages legacy files content-blind in `.memory-migration-staging/` with rollback — run per skill instructions if a group regressed.
