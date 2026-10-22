# Lightpanda Daemon: Deployment Reference (portable copy)

Distilled from the host box's deployment evaluation so this skill is
self-contained when copied outside the dotfiles repo (container mounts, other
machines). Deployed 2026-10-04 on oci-prime; verified in-container 2026-10-05.
**IPs drift on recreate** — re-check `docker inspect lightpanda` after any
container recreate.

## Deployment shape

Fleet container, digest-pinned 1.0.0, on two docker networks:

```bash
docker run -d --name lightpanda \
  --restart on-failure --cap-drop ALL --security-opt no-new-privileges \
  --memory=2g --memory-swap=2g --shm-size=256m --pids-limit=256 \
  -e LIGHTPANDA_DISABLE_TELEMETRY=true \
  -p 172.17.0.1:9224:9222 \
  --network cdp-net \
  lightpanda/browser@sha256:5b84708cb3d9bef841aba4a4cd299f4de0609ac1bd7d4c6fbfcbf168d56b685e \
  /bin/lightpanda serve --host 0.0.0.0 --port 9222 --log_level info --block-private-networks
docker network connect hermes_default lightpanda
```

Endpoints (re-check after recreate). The script's baked-in default is the first
row; override per call (`argv[3]`) or via `LIGHTPANDA_ENDPOINT` when running
from a different network path or after a recreate:

| Reachable from | Endpoint |
|---|---|
| host / harness | `ws://172.17.0.1:9224/` |
| hermes_default members | `ws://172.18.0.5:9222/` |
| cdp-net members | `ws://172.20.0.5:9222/` |

Nothing else lives on the host (binary/unit/ufw entry all removed). **Rollback:**
`docker rm -f lightpanda` — the image digest in the run command is the record.

Install channels that work: Docker image (used). GitHub tarball needs glibc ≥2.38
(host OK, Debian 12 image no). npm `@lightpanda/browser` is a JS **client**, not
the browser — never install it. The pip wheel is mislabeled but bundles the same
2.38-requiring binary.

## Connection quirks (verified — save yourself the hour)

- **WS Host allowlist = loopback + IP-form Hosts.** DNS names (`lightpanda:9222`)
  → `403 "Host not allowed"`; `--advertise-host` does not extend the set. HTTP
  `GET /json/version` is more permissive than the WS upgrade — a 200 GET does not
  prove WS health. (Opposite of chromium `:9222`, which requires a DNS Host —
  don't cross the two.)
- **Origin is validated.** python `websocket-client` auto-sends one → `403
  "Origin not allowed"` (fix: `suppress_origin=True`). Puppeteer/Playwright/
  python-`websockets`/Node native WS send none by default.
- **Proxy env must be stripped client-side.** Node's native WebSocket rides
  `EnvHttpProxyAgent`; `NO_PROXY` alone is insufficient. A raw curl handshake to
  the same endpoint returns 101 under the same env, so it's purely client-side.
- **Engine assertion:** verify with `eval navigator.userAgent` (expect
  `Lightpanda/1.0`). `get cdp-url` is NOT a discriminator — it shows a
  daemon-local relay in both healthy and fallen-back sessions.

## Security gates (empirical, 2026-10-04)

- CDP-driven SSRF probes against the live serve — cloud metadata
  (`169.254.169.254`), docker bridges, RFC1918 host → all `Navigation failed:
  CouldntConnect`; a live ufw-allowed caddy on `10.0.0.200:80` also unreachable
  ⇒ `--block-private-networks` genuinely works. Positive control (example.com)
  extracted real text.
- **Lane rules:** bulk text/JS extraction of semi-trusted targets only. No
  DOMSnapshot domain; accessibility via `getPartialAXTree` only; screenshots are
  placeholders. Never for authenticated or sensitive browsing — that's the
  chromium lanes. Lightpanda changes **egress, not fingerprint**: IP-reputation
  challenges (Vercel checkpoint, Cloudflare) still gate it (verified 2026-10-05).

## Why the in-container default path is blocked (agent-browser 0.27.1)

All verified 2026-10-04; drives why this skill uses raw CDP via Node built-ins:

1. **glibc**: agent image is Debian 12 (glibc 2.36); the lightpanda binary needs ≥2.38.
2. **agent-browser 0.27.1 connect-mode silently falls back** to local chromium
   even after a successful WS handshake — proven byte-identical outputs and
   `HeadlessChrome/154` UA on the "lightpanda" session. Hence rule 5 in SKILL.md:
   always assert the engine via `navigator.userAgent`.
3. **0.27.1 spawn-mode is broken** (`AGENT_BROWSER_ENGINE=lightpanda` emits
   chromium's zygote error), and 0.27.1 is the ceiling: newer versions carry an
   ARM64 hang (vercel-labs/agent-browser#1671). **Pin 0.27.1; re-probe before any bump.**

**Revisit triggers:** agent-browser >0.27.1 with #1671 fixed *and* lightpanda
connect/spawn verified against a live engine; or the agent image moves to a
glibc ≥2.38 base. Until then the fallback-wrapper pattern (default engine; on
0-text retry via CDP to lightpanda) stands.

## Troubleshooting index

Same table as SKILL.md's, kept here for the portable copy: non-101/`Received
network error` → proxy env not stripped; 403 Host → connect by IP; 403 Origin →
use a client that sends none; connect timeout → daemon down, check
`docker ps` / `docker inspect lightpanda` (the daemon runs only as this
container — no host binary or unit); checkpoint text → bot-walled target,
this path is a cross-check, not a bypass.
