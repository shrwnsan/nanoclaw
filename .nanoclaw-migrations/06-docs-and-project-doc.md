# Section 06 — Docs, project doc, Telegram adapter

## 6.1 Install-specific docs — copy whole

From dev tree, verbatim: `docs/APPLE-CONTAINER-NETWORKING.md`, `docs/docker-sandboxes.md`, `docs/skills-as-branches.md`. Add to the CLAUDE.md docs index if upstream's index format wants them listed.

## 6.2 docs/telegram-topic-routing.md — REWRITE for v2.3

The 192-line fork doc describes the pre-seam family (batch priority, sidecar, `kind`). Update to the v2.3 reality per section 05: what upstream now does natively (batch-first routing, session_state reply route, isolated task sessions), what remains fork-divergent (two-gate telegram thread handling, session_manager preservation, pinned per-topic destinations, telegram-topics tool, `supportsThreads` trap). Keep the upstream-landscape history as background.

## 6.3 Root CLAUDE.md — re-apply fork-specific sections

Delta vs upstream is small (46+/60−). Take upstream's v2.3 CLAUDE.md as base; re-add fork-specific sections that remain true post-upgrade: fork identity/banner if wanted, any ncl/cli_scope notes that differ, supply-chain pnpm rules (keep — still correct and upstream's gate is a no-op), CJK note (upstream-native now — trim), update file-path references that moved (driver seam, project-doc-compose, mailbox seam). Delete fork sections describing dropped mechanisms (current-batch sidecar, bare-text fallback, MCP scheduling tools, docker-prune self-heal description changes to section-01.5 reality).

## 6.4 Project-doc compose rename — no fork code hit, but cleanup

`src/claude-md-compose.ts` → `src/project-doc-compose.ts`, `composeGroupProjectDoc(group, groupDir, spec)`; flat CLAUDE.md mounted at `/workspace/agent/CLAUDE.md`; `/app/CLAUDE.md` + `.claude-fragments` mounts gone. Fork grep (`grep -rn "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/`) must be clean after replay. Post-cutover cleanup: `rm -rf groups/*/.claude-fragments groups/*/.claude-shared.md`.

`groups/global/CLAUDE.md` (fork `53c62d18`) was an instance artifact, never a trunk template — nothing to port. Its 166 lines of persona prose are salvageable into `instructions.prepend.md` during `/migrate-memory` if the operator wants them.

## 6.5 Telegram adapter — reinstall post-merge via /add-telegram (do NOT port fork adapter)

The fork's `src/channels/telegram.ts` (`f79a51f2`) and BOTH host-side MD-escape layers (`ffa6fc67` → `sanitizeTelegramLegacyMarkdown`/`escapeTelegramMd` in `src/modules/permissions/channel-approval.ts:108-115`) are dropped. The channels-branch adapter (`upstream/channels`, `@chat-adapter/telegram` pinned 4.29.0) parses CommonMark and renders MarkdownV2 itself — running the legacy sanitizer would downgrade `**bold**`. Instance model fully supported (adapter is instance-exact, `TELEGRAM_INSTANCES` env loop).

Steps: after merge+build (section 07), run `/add-telegram`; verify the messaging group's `instance` column is populated for the existing group (migration 016+ path); confirm `supportsThreads` stays `false`; then smoke-test MD rendering (bold/italic/link) from a real reply.

## 6.6 meta-search proxy fix (`a4afe440`) — covered by section 02 copy

The skill's scripts carry the OneCLI proxy support in their final state; no host-side code involved.
