# Section 01 — Security, hardening, image

Fork commits covered: `ec598b3b` (chmod+env), `881e1293` (webhook bind), `629e5ece` (unknown-sender), `23e3380e` (NO_PROXY), `1647e368`/`#34` (image self-heal), `11bca042` (musl), CJK + Vercel (dropped — upstream).

## 1.1 chmod 1777 /home/node — PORT (one token)

`container/Dockerfile` ~:134 still has upstream's `chmod 777 /home/node`. Change to `1777` (sticky bit). Upstream's own comment (`src/container-runner.ts:1094-1097`, runAs/HOME wiring) relies only on "writable by any uid" — sticky does not break it.

## 1.2 Webhook bind 127.0.0.1 — PORT (one token)

`src/webhook-server.ts:172`: `candidate.listen(port, '0.0.0.0', ...)` → `'127.0.0.1'`. This install is polling-only (Telegram); any future webhook-delivery channel would need the bind revisited.

## 1.3 Unknown-sender default strict — PORT (two tokens)

`src/channels/channel-registry.ts:171-186` — `fallbackChannelDefaults` (applies to adapters without declared defaults): change both `unknownSenderPolicy` values (`'request_approval'` at ~:177 dm, ~:182 group) to `'strict'`. Do NOT touch `resolveUnknownSenderPolicy`/declared-channel defaults. Host-initiated DMs are already hard-strict (`src/modules/permissions/user-dm.ts:108-112`); channel-registration approval keys on `agentCount === 0` (`src/router.ts:297-300`), unaffected.

## 1.4 NO_PROXY for OneCLI gateway — PORT (same semantics, new location)

Upstream's OneCLI gateway contribution still injects `HTTPS_PROXY` without `NO_PROXY` (`src/gateway-providers/onecli.ts:25` spreads the container-config API result). Insert in `composeSessionSpec()` env assembly (`src/container-runner.ts:1067-1112`), AFTER the `contributedEnv` spread, merging rather than clobbering:

```ts
// NO_PROXY — bypass gateway for local services. OneCLI injects HTTPS_PROXY
// but NOT NO_PROXY, so all container HTTP routes through the gateway —
// including local MCP traffic to host.docker.internal, which hangs.
// Merge with provider-contributed NO_PROXY to avoid clobbering bypass entries.
const LOCAL_NO_PROXY = 'host.docker.internal,localhost,127.0.0.1,::1';
const existingNoProxy = contributedEnv.NO_PROXY ?? env.NO_PROXY;
env.NO_PROXY = existingNoProxy ? `${existingNoProxy},${LOCAL_NO_PROXY}` : LOCAL_NO_PROXY;
env.no_proxy = env.NO_PROXY;
```

(Exact variable names per the actual code at replay time: `env` is the base record, `contributedEnv` the merged provider+gateway contribution.) Admission checks refuse secret-shaped env (`src/drivers/types.ts:478-492`) — NO_PROXY passes.

## 1.5 Image self-heal (#34) — PORT (highest-value item; docker-prune outage mode)

Upstream has NO spawn-time image check: a pruned image surfaces as `{ kind: 'image-unavailable', retryable: true }` (`src/drivers/docker-driver.ts:676-677`) — a wake that retries forever and never succeeds. Port fork `1647e368`:

- **Hook point:** early in `spawnContainer`, before `driver.prepare(spec)` (`src/container-runner.ts:~382`), before the claim fence work at ~:369 gets long-running.
- **Resolve the tag** the same way spawn does: `containerConfig.imageTag || CONTAINER_IMAGE` (~:1104).
- **Gate** on `getSessionDriver().capabilities().imageBuild` (`src/drivers/types.ts:281`; Docker sets true) — drivers that can't build deny instead.
- **Mechanics (from `1647e368`):** `docker image inspect` presence probe (milliseconds); on miss, rebuild async with verify that the *requested tag* exists after build (`exitCode 0` is not sufficient when `imageTag !== CONTAINER_IMAGE`); `IMAGE_REBUILD_MAX_ATTEMPTS` attempts with backoff; single-flight so concurrent spawns don't stampede the builder; log clearly on exhausted attempts.
- **Reuse upstream's builder** where possible: `buildAgentGroupImage` (`src/container-runner.ts:1246-1323`) for derived/`imageTag` images; base `CONTAINER_IMAGE` rebuild can shell out to `./container/build.sh` as the fork version did. Prefer the in-process builder if it handles the base tag by replay time.

## 1.6 musl SDK cleanup — PORT (re-attach to v2.3 Dockerfile)

Upstream `container/Dockerfile:85-86` is plain `bun install --frozen-lockfile`; `bun.lock` still carries `@anthropic-ai/claude-agent-sdk-linux-{arm64,x64}-musl@…` (~213MB). Append after the install step:

```dockerfile
    && rm -rf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*musl* \
    && test -x /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')-glibc/claude
```

(Re-derive the `test -x` guard exactly from fork `11bca042` at replay time.) The BuildKit cache mount retains the musl tarball in the cache volume — harmless, not in image layers.

## 1.7 DROPPED — upstream already ships these

- **CJK fonts**: upstream `container/Dockerfile:23` `ARG INSTALL_CJK_FONTS=false` + `:59-61` conditional + `container/build.sh:129-143` plumbing. Identical contract; drop our copy. `.env` `INSTALL_CJK_FONTS=true` keeps working as-is.
- **`ANTHROPIC_BASE_URL` passthrough**: first-class via the `claude` provider container-config (`src/providers/claude.ts:20-28`, `contributedEnv`, `ANTHROPIC_AUTH_TOKEN=placeholder` pattern).
- **Vercel CLI**: opt-in upstream (`container/cli-tools.json` + `install-cli-tools.sh`); our image intentionally does NOT bake it globally — the `vercel-cli` container skill (section 02) is the surface.

## 1.8 Anthropic model-override env passthrough — PORT (small)

Upstream model selection is DB-driven (`container_configs.model` + `NANOCLAW_DEFAULT_MODEL`/`NANOCLAW_FAST_MODE`). If `.env` still carries `ANTHROPIC_MODEL`/`ANTHROPIC_SMALL_FAST_MODEL`/`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, extend the `registerProviderContainerConfig('claude', ...)` callback in `src/providers/claude.ts` (receives `hostEnv`; must ride `contributedEnv` — the lane exempt from the secret-name check, `src/drivers/types.ts:478-492`). Presence-only passthrough, harmless when unset. Do NOT put them in `composeSessionSpec`.

## 1.9 pnpm supply-chain keep

Keep the fork's `pnpm-workspace.yaml`: top-level `minimumReleaseAge: 4320` + comment (upstream's `pnpm:`-nested form is silently ignored — a no-op gate), plus `better-sqlite3` in `onlyBuiltDependencies`. Merge in any NEW upstream `onlyBuiltDependencies` entries only after human review (CLAUDE.md supply-chain rule).
