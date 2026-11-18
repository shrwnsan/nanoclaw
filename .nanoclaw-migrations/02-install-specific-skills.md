# Section 02 — Install-specific container skills

All 11 skills are self-contained directories under `container/skills/`. Upstream has none of them (trunk ships: `agent-browser`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `welcome`). Port = copy the final directory state from the fork's `dev` (`ded5eb95`) tree into the upgraded worktree. No registration step: trunk container skills are discovered by directory listing.

## How to apply

```bash
DEV=/home/ubuntu/nanoclaw        # main tree still on dev during replay
WT=/home/ubuntu/nanoclaw/.upgrade-worktree
for s in weather tg-logs meta-search remotion slack-formatting systematic-debugging tailnet-cdp vercel-cli lightpanda-text sumi fare-verdict; do
  cp -a "$DEV/container/skills/$s" "$WT/container/skills/$s"
done
```

## Per-skill notes

| Skill | Origin commits | Notes |
|---|---|---|
| `weather` | `01c5c01e`, `60867fc5`, `ca923606`, `0589e466` | Bun-runtime rewrite chain, final v0.3.4 (Open-Meteo, UV index, HH:MM sunrise/sunset local time). 55 files — includes vendored app. Copy final state; don't replay the chain. |
| `tg-logs` | `818bd17f`, `86c86a73`, `33a0cb71`, `52be6b7c` | Reads the tg-topic-ingest SQLite DB (bind-mounted outside the repo). `--rolling-hours` + `--use-content-time` included in final state. |
| `meta-search` | `a36f3c4a` + `a4afe440`; re-vendored from shrwnsan/agents `5c0d6db` (2026-10-22), re-merged from `2849eae` (2026-11-16) | Fork mod: OneCLI proxy credential injection, flag-gated as `METASEARCH_PROXY_AUTH=1` (set in `~/.config/nanoclaw/environment`; unset keeps upstream gate semantics byte-for-byte and the vendored test suite green). 2026-11-16 sync took upstream TinyFish provider (search + fetch chains) via 3-way merge off `5c0d6db` (base = `git -C ~/code/agents show 5c0d6db:skills/meta-search/<file>`; `git merge-file` ours=container, theirs=hub HEAD; two expected conflicts: TinyFish phase before Tavily in `handle-web-search.mjs`, PROVIDER_ENV pin list in `search-providers.test.mjs`). Mod now also covers TinyFish sites: phase gate `\|\| PROXY_AUTH`, `tryTinyfishSearch`/`extractWithTinyfish` headers conditional on key, extractor chain gate `(TINYFISH_API_KEY \|\| PROXY_AUTH)`. Upstream test-isolation bugs pinned by fork (both fixes are upstream-worthy): bare legacy `'TINYFISH_API_KEY'` missing from env cleanup in `search-providers.test.mjs` PROVIDER_ENV AND the `content-quality.test.mjs` key-clearing regex — hub suite is red on any host with that ambient key; tinyfish-skip assert in `content-quality.test.mjs` made flag-aware (under `METASEARCH_PROXY_AUTH=1` keyless TinyFish attempt is correct behavior). Rig docs stub must name the full SEARCH_PLUS_* var set (`SEARCH_PLUS_404_MODE SEARCH_PLUS_GITHUB_CACHE_TTL SEARCH_PLUS_GITHUB_ENABLED` minimum). Verify: `node --test scripts/tests/*.test.mjs` in the rig → expect 126/126 with the flag both set and unset. |
| `remotion` | `a36f3c4a` | 1 file. |
| `slack-formatting` | `a36f3c4a` | 1 file. Coexists with upstream trunk skills. |
| `systematic-debugging` | `a36f3c4a`; metadata.version stamp synced from hub `2849eae` (2026-11-16) | 2 files. |
| `tailnet-cdp` | `a36f3c4a` | 1 file. |
| `vercel-cli` | `a36f3c4a` | 1 file. Companion to the `vercel` package the agent may invoke; image-side install stays as upstream ships it (Vercel CLI went opt-in upstream — our Dockerfile does NOT re-add it globally; agents use the skill's documented flow). |
| `lightpanda-text` | vendored 2026-10-22 (host skill → container copy, this install) | Text extraction via the host-side Lightpanda CDP endpoint (`LIGHTPANDA_ENDPOINT`, default `ws://172.17.0.1:9224/`). Requires the host `lightpanda` container to be up (see `~/dotfiles-vps/docs/guides/guide-057-lightpanda-text-extraction-engine.md`); inside agent containers the default host-gateway IP applies. `references/deployment.md` carries fleet docker-net IPs that drift — informational, not config. |
| `fare-verdict` | vendored from shrwnsan/agents 2026-10-23 (native, no keys); metadata.version stamp synced from hub `2849eae` (2026-11-16) | Advisory flight-fare verdict via Google Flights' price-insights surface. Sole dependency: `agent-browser` CLI (image pin 0.39.1 — required). Offline verification: `node scripts/fare-verdict.mjs --selftest`. Surface contract + refresh runbook live in its `PROVENANCE.md`; personal-use posture — on-demand runs only, no schedulers. |
| `sumi` | vendored from the private source repo @`178b515` 2026-10-22 | Deployment copy per its `PROVENANCE.md` (vendor-and-pin; canonical source is the private sumi repo, not this tree — repo name withheld from the public fork). Requires the host `sumi` service (`SUMI_BASE_URL`, default `host.docker.internal:8765`). Re-vendor by copying the three files + re-filling PROVENANCE commit/date. |

## Verify after copy

- Each dir contains a valid `SKILL.md` per the v2.3 skills contract (see `docs/skills-model.md` in the upgraded tree). These are plain instruction+script skills (SKILL.md + optional scripts); no frontmatter/registration changes were required upstream, but eyeball one SKILL.md against a trunk skill's frontmatter.
- `container/skills/qmd` must NOT exist (QMD retired 2026-09-08, fork commit `5ce50b85`).
- The four untracked proprietary skill dirs (`dataviz`, `dataviz-tufte`, `frontend-design`, `motion-craft`) must NOT be copied into the worktree or committed.
