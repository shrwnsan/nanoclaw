---
name: lightpanda-text
description: Extract page text from JS-rendered sites via the host-side Lightpanda browser. Preferred client is agent-browser in CDP mode (≥0.39.1); zero-dependency fallback is the raw-CDP script (Node built-ins only). Use when a target returns 0 or garbage text under the default browser/fetch path and you need a second, independent egress path, or for bulk text-only sweeps of JS-heavy pages. Not for screenshots, logins, or bot-wall bypass.
compatibility: Requires network reach to a host-side Lightpanda CDP daemon (default ws://172.17.0.1:9224/), Node >=18 with native WebSocket, and agent-browser >=0.39.1 for the preferred client; the outbound proxy env must be strippable.
---

# Lightpanda Text Extraction

Text/JS extraction via the host-side Lightpanda 1.0.0 daemon. Two clients:

- **agent-browser in CDP mode** (preferred; verified 2026-10-22 on 0.39.1): `agent-browser --cdp ws://172.17.0.1:9224/ open <url>`
- **Raw CDP, zero dependencies**: `scripts/cdp-fetch.mjs` (Node built-ins only) — the fallback when agent-browser isn't at hand or its proxy env can't be stripped

**Status: no longer blocked** — the 2026-10-05 blockers (agent-browser 0.27.1 silent fallback, the #1671 bump ceiling, glibc) all cleared with the 2026-10-22 base-image bump (0.39.1 fleet-wide; #1671 does not reproduce). Daemon deployment shape, endpoints, connection quirks, security gates, and revisit triggers live in [references/deployment.md](references/deployment.md).

## When to use

- A page needs JavaScript to render and you only need the text (career boards, SPAs — e.g. temporal.io/careers rendered 11.6k chars here)
- The default path returned 0/garbage text and you need a second opinion from a different egress (host network, not the container's proxy)
- Bulk text sweeps where spawning Chromium per page is waste (lightpanda: ~4MiB idle, fast startup)

## When NOT to use

- Anything visual — screenshots, OG cards, design QA. Lightpanda has no rendering engine; screenshots come back as placeholders. Use agent-browser or tailnet-cdp.
- Logins, saved sessions, cookie/state flows
- Bot-walled targets — Lightpanda changes **egress, not fingerprint**: Vercel Security Checkpoint and Cloudflare still gate it (verified 2026-10-05 on contentful/hyperproof)

## Usage

```bash
# Preferred: agent-browser CDP mode (≥0.39.1, verified 2026-10-22).
# The first command after switching engines may error once — retry it.
agent-browser --cdp ws://172.17.0.1:9224/ open <url>
agent-browser --cdp ws://172.17.0.1:9224/ eval document.body.innerText.slice(0,600)

# Zero-dep fallback (Node built-ins only). Proxy env MUST be stripped — Node's
# global WebSocket rides EnvHttpProxyAgent, and extending NO_PROXY alone is NOT
# sufficient (verified 2026-10-05)
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  node scripts/cdp-fetch.mjs <url> [wsEndpoint]

# Endpoint precedence (script): argv[3] > $LIGHTPANDA_ENDPOINT > default ws://172.17.0.1:9224/
# (this box's host-gateway IP — other machines/paths: see references/deployment.md)
```

Output: JSON `{title, len, text}` (text capped at 600 chars for a quick read). Baked-in: 6s render wait, 30s timeout per CDP call, target closed on exit.

## Rules

1. **Connect by IP**: default `ws://172.17.0.1:9224/` (this box's host-gateway; see `references/deployment.md` for the full endpoint table and drift warning). A DNS-name Host header gets 403 "Host not allowed". This is the **opposite** of chromium `:9222`, which requires the Host header — don't cross the two.
2. **Strip proxy env** before invoking, or the WS upgrade fails with a non-101 error. Purely client-side; the endpoint itself answers 101.
3. **Node's native WebSocket sends no Origin header** — that is why the Node client passes where Origin-sending clients (some Python libs) get 403.
4. **Lane limits**: text/JS extraction only — no DOMSnapshot; screenshots are placeholders.
5. **Assert the engine, always**: in any remote/connect browser flow, verify via `eval navigator.userAgent` (expect `Lightpanda/1.0`). History: agent-browser ≤0.27.1 silently fell back to local chromium even on a successful CDP connect — fixed by 0.39.1 (verified 2026-10-22), but the assertion costs nothing and outlasts version pins.
6. Close your targets when done — the script does this on exit; if you roll your own client, do the same.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Received network error or non-101 status code` | Proxy env not stripped — use the `env -u …` invocation |
| 403 "Host not allowed" | Connect by IP, not a DNS name |
| 403 on connect from a Python client | Client sends an Origin header — use the Node WS client |
| Connect timeout | Daemon down — check `docker inspect lightpanda` / host side ([references/deployment.md](references/deployment.md)) |
| Checkpoint or interstitial text returned | Target is bot-walled; this path is a cross-check, not a bypass |

## Deploy (container + cross-harness skill)

Canonical copy: `.agents/skills/lightpanda-text/` (this repo). Home skill dirs symlink to it (`~/.agents/skills/`, and `~/.claude/skills/` via a manifest mapping line). The one real copy is the container mount, handled by `scripts/sync.sh --go` via the manifest `[skill-fanout]` section:

- `~/nanoclaw/container/skills/lightpanda-text/` — mounted read-only into agent containers at `/app/skills/`

Manual equivalent, if sync.sh is not at hand:

```bash
cp -r .agents/skills/lightpanda-text/ ~/nanoclaw/container/skills/lightpanda-text/
```

Knowledge + Node script — no Dockerfile change; skills mount read-only and sync at next container spawn.

## Notes

- No Lightpanda code is vendored here — the skill speaks standard CDP to the daemon (AGPL applies to the upstream binary, not CDP clients).
- Script origin: host agent (2026-10-04, commits 2bd42bf, 9ade8d3); verified first-hand from an agent container 2026-10-05 including the proxy-env correction. Full evaluation arc (win-bar measurement, bot-wall re-attribution) lives in the host repo's docs — not needed to use this skill.
- `references/deployment.md` is the portable copy of the daemon reference; if you redeploy or recreate the container, update its endpoints table.
