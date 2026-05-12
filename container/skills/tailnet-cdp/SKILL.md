---
name: tailnet-cdp
description: Remote CDP browser control via headless Chromium on the host. Use when agent-browser isn't available or you need direct Puppeteer/Playwright access to a shared browser — visual QA, complex web automation, multi-tab workflows, screenshots. Connects to Chromium container over tailnet TLS.
---

# Tailnet CDP Browser Control

Connect to the shared headless Chromium instance running on the host via CDP (Chrome DevTools Protocol) over TLS.

## When to use

- Need to take screenshots or interact with web pages
- `agent-browser` tool isn't available (non-Claude providers)
- Complex multi-tab or cross-origin workflows
- Visual QA of rendered pages

## Endpoints

Containers access the host directly via HTTP. Remote agents use tailnet TLS.

| Purpose | Container URL | Tailnet URL |
|---------|--------------|-------------|
| CDP info (WebSocket URL) | `http://host.docker.internal:9222/json/version` | `https://oci-prime.tailea9a52.ts.net:8443/json/version` |
| List targets | `http://host.docker.internal:9222/json/list` | `https://oci-prime.tailea9a52.ts.net:8443/json/list` |
| New tab | `http://host.docker.internal:9222/json/new?<url>` | `https://oci-prime.tailea9a52.ts.net:8443/json/new?<url>` |
| Service status | `http://host.docker.internal:9221/chromium/status` | `https://oci-prime.tailea9a52.ts.net:9220/chromium/status` |
| Start service | `POST http://host.docker.internal:9221/chromium/start` | `POST https://oci-prime.tailea9a52.ts.net:9220/chromium/start` |

**Container access requires the Host header:** HAProxy filters by `Host: oci-prime.tailea9a52.ts.net` on all CDP requests.

## Connecting with Puppeteer

```javascript
const puppeteer = require('puppeteer-core');

// 1. Get WebSocket URL from CDP info (container path with Host header)
const info = await (await fetch('http://host.docker.internal:9222/json/version', {
  headers: { Host: 'oci-prime.tailea9a52.ts.net' }
})).json();
// info.webSocketDebuggerUrl = "ws://localhost/devtools/browser/<guid>"

// 2. Rewrite to container-accessible address
const wsUrl = info.webSocketDebuggerUrl.replace(
  'ws://localhost',
  'ws://host.docker.internal:9222'
);

// 3. Connect
const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
const page = await browser.newPage();
await page.goto('https://example.com');
await page.screenshot({ path: '/workspace/screenshot.png' });
```

## Connecting with Playwright

```javascript
const { chromium } = require('playwright-core');

const browser = await chromium.connectOverCDP(
  'ws://host.docker.internal:9222/devtools/browser/<guid>'
);
const context = browser.contexts()[0] || await browser.newContext();
const page = await context.newPage();
```

## Connecting with curl (quick test)

```bash
# Check if Chromium is running
curl -s http://host.docker.internal:9221/chromium/status

# If stopped, start it
curl -s -X POST http://host.docker.internal:9221/chromium/start

# Get CDP info (Host header required)
curl -s -H "Host: oci-prime.tailea9a52.ts.net" http://host.docker.internal:9222/json/version

# List open tabs
curl -s -H "Host: oci-prime.tailea9a52.ts.net" http://host.docker.internal:9222/json/list

# Open a new tab
curl -s -H "Host: oci-prime.tailea9a52.ts.net" "http://host.docker.internal:9222/json/new?https://example.com"
```

## WebSocket URL rewrite

`/json/version` returns `ws://localhost/devtools/browser/<guid>`. **Always rewrite** to `ws://host.docker.internal:9222/devtools/browser/<guid>` before connecting from a container.

## Important rules

1. **Always check service status first** — Chromium auto-stops after 20 min idle. Start it via the service trigger if you get connection refused.
2. **Don't close tabs you didn't open.** This is a shared browser — other agents may have active sessions.
3. **Close your own pages when done** — use `page.close()`, not `browser.close()` or `browser.disconnect()`.
4. **Session staleness:** If you get "session not found" or "target closed", close the page and reconnect. The watchdog may have restarted Chrome.
5. **Host header required** for CDP requests: always pass `Host: oci-prime.tailea9a52.ts.net` in HTTP headers. HAProxy filters by Host header.
6. **No GPU** — avoid WebGL-heavy pages.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Connection refused | Service is down: `POST http://host.docker.internal:9221/chromium/start` |
| 403 Forbidden | Missing Host header — add `Host: oci-prime.tailea9a52.ts.net` |
| "session not found" | Chrome restarted — close page, reconnect |
| WebSocket fails | Rewrite `ws://localhost` → `ws://host.docker.internal:9222` |
| Slow rendering | Shared resource with no GPU — expect delays on heavy pages |
