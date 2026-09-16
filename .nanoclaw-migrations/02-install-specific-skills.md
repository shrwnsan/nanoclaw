# Section 02 — Install-specific container skills

All 8 skills are self-contained directories under `container/skills/`. Upstream has none of them (trunk ships: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `welcome`). Port = copy the final directory state from the fork's `dev` (`ded5eb95`) tree into the upgraded worktree. No registration step: trunk container skills are discovered by directory listing.

## How to apply

```bash
DEV=/home/ubuntu/nanoclaw        # main tree still on dev during replay
WT=/home/ubuntu/nanoclaw/.upgrade-worktree
for s in weather tg-logs meta-search remotion slack-formatting systematic-debugging tailnet-cdp vercel-cli; do
  cp -a "$DEV/container/skills/$s" "$WT/container/skills/$s"
done
```

## Per-skill notes

| Skill | Origin commits | Notes |
|---|---|---|
| `weather` | `01c5c01e`, `60867fc5`, `ca923606`, `0589e466` | Bun-runtime rewrite chain, final v0.3.4 (Open-Meteo, UV index, HH:MM sunrise/sunset local time). 55 files — includes vendored app. Copy final state; don't replay the chain. |
| `tg-logs` | `818bd17f`, `86c86a73`, `33a0cb71`, `52be6b7c` | Reads the tg-topic-ingest SQLite DB (bind-mounted outside the repo). `--rolling-hours` + `--use-content-time` included in final state. |
| `meta-search` | `a36f3c4a` + `a4afe440` | `a4afe440` adds OneCLI proxy credential injection to the scripts — final state already includes it. |
| `remotion` | `a36f3c4a` | 1 file. |
| `slack-formatting` | `a36f3c4a` | 1 file. Coexists with upstream trunk skills. |
| `systematic-debugging` | `a36f3c4a` | 2 files. |
| `tailnet-cdp` | `a36f3c4a` | 1 file. |
| `vercel-cli` | `a36f3c4a` | 1 file. Companion to the `vercel` package the agent may invoke; image-side install stays as upstream ships it (Vercel CLI went opt-in upstream — our Dockerfile does NOT re-add it globally; agents use the skill's documented flow). |

## Verify after copy

- Each dir contains a valid `SKILL.md` per the v2.3 skills contract (see `docs/skills-model.md` in the upgraded tree). These are plain instruction+script skills (SKILL.md + optional scripts); no frontmatter/registration changes were required upstream, but eyeball one SKILL.md against a trunk skill's frontmatter.
- `container/skills/qmd` must NOT exist (QMD retired 2026-09-08, fork commit `5ce50b85`).
- The four untracked proprietary skill dirs (`dataviz`, `dataviz-tufte`, `frontend-design`, `motion-craft`) must NOT be copied into the worktree or committed.
