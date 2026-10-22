#!/usr/bin/env bun
// sumi-drain.mjs — NanoClaw in-turn drain worker for the Sumi capture queue.
// Canonical copy: sumi repo `skills/sumi/scripts/sumi-drain.mjs` (vendor-and-pin —
// see PROVENANCE.template.md in fan-out copies). Node built-ins only; runs on bun
// (the container agent runtime) or node >= 22 (the lightpanda fallback's global
// WebSocket needs it — on older node that one fallback degrades, via a caught
// ReferenceError, into the failure:true path).
//
// Behavior (spec-003 §2.2): claim loop until 204 / the shared id is seen / the
// claim budget is spent / a claim repeats an id already attempted this run;
// SSRF-guarded fetch mirroring sumi's pkg/egress policy (resolve → reject →
// PIN); crude bounded title+text extraction; lightpanda CDP fallback when <500
// chars are extractable; taxonomy-only tag guess; failure:true on fetch/extract
// error.
//
// Egress policy (spec-001 §7 — the volunteer boundary, not platform enforcement):
//   1. scheme allowlist: http/https only;
//   2. resolve ALL A/AAAA records, reject the host if ANY is private/loopback/
//      link-local/CGNAT/cloud-metadata (ranges mirror pkg/egress/blocklist.go);
//   3. pin the vetted address via a custom `dns.lookup` on the actual request so
//      re-resolution cannot rebind mid-fetch (no TOCTOU window);
//   4. redirects followed manually, policy re-applied every hop (≤5);
//   5. 30 s timeout per hop, 2 MB body cap;
//   6. proxy env stripped at startup — a proxy would bypass the IP vetting.
// The lightpanda fallback (host-side browser) cannot pin, so it only ever sees a
// URL the guard has vetted and accepted; a policy-rejected URL is never retried
// through it.
//
// Availability bounds (worker-side): extraction input capped at 256 KB with a
// hard-bounded wall-clock budget (EXTRACT_* consts below) checked between 64 KB
// chunks — worst case ~12 s per item, still bounded; hostile markup aborts into
// the render path or failure:true instead of wedging the drain.
//
// Secrets: the token is read from a file (container mount, never env-injected)
// and is never printed. 429 + Retry-After is expected behavior, not an error.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import dnsPromises from 'node:dns/promises';

const VERSION = '1.0.0';
const WORKER_ID = 'nanoclaw-1';
const UA = `sumi-drain/${VERSION} (nanoclaw worker; egress-guarded)`;

const DEFAULT_BASE = 'http://host.docker.internal:8765';
const DEFAULT_TOKEN_FILE = '/workspace/extra/nanoclaw-token';
const DEFAULT_CAP = 5; // spec-003 §2.2: the in-turn claim budget

const API_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000; // per hop (spec: 30s timeout)
const MAX_BODY_BYTES = 2 * 1024 * 1024; // contract MAX_BODY_BYTES cap — stricter than pkg/egress's 10 MB default
const MAX_REDIRECTS = 5; // SKILL.md egress policy: ≤5 redirects followed, policy re-applied per hop
const MIN_EXTRACTABLE_CHARS = 500; // below this → lightpanda fallback
const MAX_MARKDOWN_CHARS = 50_000; // bounds the result POST well under 2 MB
// Worker-side availability bounds (review task-2): extraction is regex work on
// attacker-controlled markup and runs AFTER the fetch timeout, so it needs its
// own bounds — input capped, then chunked with a wall-clock budget between
// chunks; overrun aborts extraction (→ render path or failure:true).
const EXTRACT_MAX_HTML_CHARS = 256 * 1024;
const EXTRACT_CHUNK_CHARS = 64 * 1024;
const EXTRACT_BUDGET_MS = 5_000;

const LIGHTPANDA_DEFAULT = 'ws://172.17.0.1:9224/'; // host-gateway IP — never a DNS name (403)
const CDP_CALL_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const CDP_RENDER_WAIT_MS = 6_000;

class PolicyError extends Error {}
class FetchError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`sumi-drain: ${msg}`);

// ---------------------------------------------------------------------------
// Egress blocklist — mirrors pkg/egress/blocklist.go exactly. v4 entries are
// [top-bits-value, prefix-bits], checked as (n >>> (32-bits)) === base.
// ---------------------------------------------------------------------------
const BLOCKED_V4 = [
  [0, 8, '"this network" / wildcard — on Linux 0.0.0.0 reaches 127.0.0.1 (SSRF bypass)'],
  [10, 8, 'RFC1918 private 10.0.0.0/8'],
  [401, 10, 'CGNAT (RFC6598) 100.64.0.0/10 — also where Tailscale peers live'],
  [127, 8, 'loopback 127.0.0.0/8'],
  [43518, 16, 'link-local 169.254.0.0/16 — includes cloud metadata 169.254.169.254'],
  [2753, 12, 'RFC1918 private 172.16.0.0/12'],
  [49320, 16, 'RFC1918 private 192.168.0.0/16'],
];

function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isBlockedV4(n) {
  return BLOCKED_V4.some(([base, bits]) => (n >>> (32 - bits)) === base);
}

// Parses an IPv6 literal (incl. '::' compression and an embedded IPv4 tail)
// to a BigInt; null on malformed input.
function parseIPv6(str) {
  let s = str;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let head = s;
  let tail = null;
  const dc = s.indexOf('::');
  if (dc >= 0) {
    if (s.indexOf('::', dc + 1) >= 0) return null; // more than one '::'
    head = s.slice(0, dc);
    tail = s.slice(dc + 2);
  }
  const group = (part) => {
    if (part.includes('.')) {
      const v = parseIPv4(part);
      return v === null ? null : [BigInt(v >>> 16), BigInt(v & 0xffff)];
    }
    return /^[0-9a-fA-F]{1,4}$/.test(part) ? [BigInt(parseInt(part, 16))] : null;
  };
  const hs = head === '' ? [] : head.split(':').map(group);
  const ts = tail === null ? [] : tail === '' ? [] : tail.split(':').map(group);
  if (hs.some((g) => g === null) || ts.some((g) => g === null)) return null;
  const h = hs.flat();
  const t = ts.flat();
  const n = h.length + t.length;
  if (tail === null && n !== 8) return null;
  if (tail !== null && n > 7) return null;
  let hv = 0n;
  for (const g of h) hv = (hv << 16n) | g;
  if (tail === null) return hv;
  let tv = 0n;
  for (const g of t) tv = (tv << 16n) | g;
  // head groups sit left-aligned; they shift past the zero groups AND the tail groups
  const shift = BigInt(16 * ((8 - n) + t.length));
  return (hv << shift) | tv;
}

function isBlockedV6(v) {
  if ((v >> 32n) === 0xffffn) return isBlockedV4(Number(v & 0xffffffffn)); // ::ffff:0:0/96 — unmap IPv4-mapped, then re-check
  if (v === 0n) return true; // ::/128 unspecified — the v6 analogue of 0.0.0.0
  if (v === 1n) return true; // ::1/128 loopback
  if ((v >> 121n) === 0b1111110n) return true; // fc00::/7 unique local (strict superset of fd00::/8)
  if ((v >> 118n) === 0b1111111010n) return true; // fe80::/10 link-local
  return false;
}

function recordIsBlocked(rec) {
  if (rec.family === 4 || (rec.family !== 6 && parseIPv4(rec.address) !== null)) {
    const n = parseIPv4(rec.address);
    return n === null ? true : isBlockedV4(n);
  }
  const v = parseIPv6(rec.address);
  return v === null ? true : isBlockedV6(v); // unparseable = unvettable = refuse
}

// resolve → reject-if-ANY-private → return the pinned record.
// Literal-IP hosts are checked directly (no resolution), like dialContext.
function lookupWithTimeout(host, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DNS timed out after ${ms}ms`)), ms);
    dnsPromises.lookup(host, { all: true, verbatim: true }).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function resolveAndVet(hostname) {
  const v4 = parseIPv4(hostname);
  if (v4 !== null && /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isBlockedV4(v4)) throw new PolicyError(`blocked literal address in URL host: ${hostname}`);
    return { address: hostname, family: 4 };
  }
  if (hostname.includes(':')) {
    const v = parseIPv6(hostname.replace(/^\[|\]$/g, ''));
    if (v === null) throw new PolicyError(`malformed IPv6 literal: ${hostname}`);
    if (isBlockedV6(v)) throw new PolicyError(`blocked literal address in URL host: ${hostname}`);
    return { address: hostname.replace(/^\[|\]$/g, ''), family: 6 };
  }
  let records;
  try {
    // dnsPromises.lookup has no timeout option — bound it explicitly so a
    // stalling resolver cannot hang the item past the policy's time budget.
    records = await lookupWithTimeout(hostname, DNS_TIMEOUT_MS);
  } catch (e) {
    throw new PolicyError(`resolve ${hostname}: ${e.message}`);
  }
  if (!records.length) throw new PolicyError(`no DNS records for ${hostname}`);
  let pin = null;
  for (const rec of records) {
    if (recordIsBlocked(rec)) {
      throw new PolicyError(`${hostname} resolves to a blocked address (${rec.address}) — one bad record fails the whole host`);
    }
    if (!pin && rec.family === 4) pin = rec; // prefer a v4 pin; container v6 egress is often absent
  }
  if (!pin) pin = records[0];
  return pin;
}

// One HTTP(S) request pinned to `pin`. The custom dns.lookup returns the vetted
// address for ANY hostname — this is the pin that closes the DNS-rebinding
// TOCTOU window (node:http never re-resolves what lookup already answered).
function pinnedRequest(u, pin, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    let timer = null;
    const req = mod.request(u, {
      method: 'GET',
      family: pin.family,
      autoSelectFamily: false, // deterministic: exactly our pinned lookup answer
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.5' },
      lookup: (hostname, options, cb) =>
        options && options.all
          ? cb(null, [{ address: pin.address, family: pin.family }])
          : cb(null, pin.address, pin.family),
    }, (res) => {
      const code = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        const loc = typeof res.headers.location === 'string' ? res.headers.location : '';
        res.destroy(); // we never read redirect bodies — kill the connection
        return settle(null, { statusCode: code, headers: res.headers, redirect: true, location: loc });
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          settle(new PolicyError(`response exceeds ${maxBytes}-byte cap`));
        } else {
          chunks.push(c);
        }
      });
      res.on('end', () => settle(null, { statusCode: code, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', settle);
    });
    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else {
        resolve(val);
      }
    };
    timer = setTimeout(() => settle(new PolicyError(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('error', settle);
    req.end();
  });
}

// guardFetch: scheme allowlist → resolve/vet/pin per hop → manual redirects.
// The timeout is PER HOP (each request gets its own 30s); at most MAX_REDIRECTS
// redirect responses are followed (SKILL.md "≤5"), so requests ≤ 1 + 5.
async function guardFetch(rawUrl, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES } = {}) {
  let current = rawUrl;
  for (let hops = 0; ; hops++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw new PolicyError(`malformed URL: ${current}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new PolicyError(`unsupported scheme: ${u.protocol} (http/https only)`);
    }
    const pin = await resolveAndVet(u.hostname);
    const res = await pinnedRequest(u, pin, timeoutMs, maxBytes);
    if (res.redirect) {
      // A missing or EMPTY Location must error, never resolve to the same URL
      // (an empty Location would otherwise refetch the redirect itself).
      const loc = res.location.trim();
      if (!loc) throw new PolicyError(`redirect ${res.statusCode} with a missing/empty Location header`);
      if (hops >= MAX_REDIRECTS) throw new PolicyError(`too many redirects (> ${MAX_REDIRECTS})`);
      current = new URL(loc, current).toString();
      continue;
    }
    return { statusCode: res.statusCode, headers: res.headers, body: res.body ?? Buffer.alloc(0), finalUrl: current, redirects: hops };
  }
}

// Pre-flight vet for the lightpanda fallback: same checks, no fetch. The host
// browser cannot pin its own connections, so this is best-effort — but a URL
// the guard REJECTS never reaches lightpanda at all.
async function vetOnly(rawUrl) {
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new PolicyError(`unsupported scheme: ${u.protocol} (http/https only)`);
  }
  await resolveAndVet(u.hostname);
}

// ---------------------------------------------------------------------------
// Lightpanda CDP fallback (adapted from the proven lightpanda-text cdp-fetch.mjs):
// Target.createTarget → attachToTarget(flatten) → Runtime.evaluate. Node's native
// WebSocket sends no Origin header; endpoint is an IP (DNS-name Host → 403).
// ---------------------------------------------------------------------------
async function lightpandaFetch(urlStr) {
  const endpoint = process.env.LIGHTPANDA_ENDPOINT || LIGHTPANDA_DEFAULT;
  const ws = new WebSocket(endpoint);
  let mid = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++mid;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`lightpanda: timeout in ${method}`));
        }
      }, CDP_CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  ws.onmessage = (ev) => {
    const d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.reject(new Error(`lightpanda: ${d.error.message}`));
      else p.resolve(d.result);
    }
  };
  await new Promise((res, rej) => {
    const connectTimer = setTimeout(
      () => rej(new Error(`lightpanda: connect timeout (${endpoint})`)),
      CDP_CONNECT_TIMEOUT_MS,
    );
    ws.onopen = () => { clearTimeout(connectTimer); res(); };
    ws.onerror = (e) => {
      clearTimeout(connectTimer);
      rej(new Error(`lightpanda: ws error: ${e.message ?? e}`));
    };
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: urlStr });
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await sleep(CDP_RENDER_WAIT_MS); // let JS render (proven lineage timing)
      const ev = await send('Runtime.evaluate', {
        expression: `JSON.stringify({title: document.title, text: (document.body?.innerText ?? '').slice(0, 20000)})`,
        returnByValue: true,
      }, sessionId);
      return JSON.parse(ev.result.value);
    } finally {
      await send('Target.closeTarget', { targetId }).catch(() => {});
    }
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Crude extraction: title + text. Hostile page content becomes plain text —
// the server YAML-escapes every field it stores, so no injection surface here.
// ---------------------------------------------------------------------------
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? ' ';
  });
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return '';
  return decodeEntities(m[1].replace(/\s+/g, ' ')).trim().slice(0, 300);
}

function extractText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|head|iframe|form|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Bounded extraction wrapper. The lazy regex passes above are O(n) per unclosed
// opener — quadratic on hostile markup — and run after the fetch timeout, so
// nothing else bounds them. Two worker-side availability bounds fix that:
//   1. the HTML is capped at EXTRACT_MAX_HTML_CHARS before any regex pass;
//   2. stripping runs in EXTRACT_CHUNK_CHARS chunks with a wall-clock check
//      between chunks (per-chunk regex cost is bounded by the chunk size), so
//      a pathological page aborts with FetchError instead of wedging the drain
//      past its failure:true path.
// Chunking can leak a partial <script>/<style> body at a chunk boundary into
// the text — cosmetic for a crude extractor, and bounded by the chunk size.
function extractFromHtml(html, { budgetMs = EXTRACT_BUDGET_MS } = {}) {
  const src = html.length > EXTRACT_MAX_HTML_CHARS ? html.slice(0, EXTRACT_MAX_HTML_CHARS) : html;
  const started = Date.now();
  let text = '';
  for (let i = 0; i < src.length; i += EXTRACT_CHUNK_CHARS) {
    if (Date.now() - started > budgetMs) {
      throw new FetchError(`extraction exceeded its ${budgetMs}ms budget`);
    }
    text += `${extractText(src.slice(i, i + EXTRACT_CHUNK_CHARS))}\n`;
  }
  return {
    title: extractTitle(src),
    text: text.replace(/\n{2,}/g, '\n').trim(),
  };
}

// ---------------------------------------------------------------------------
// Taxonomy v1 — extracted verbatim from internal/taxonomy/taxonomy.go
// (`const Version = 1`; 12 domains, 80 tags). The Go file is the source of
// truth: re-extract on any taxonomy version bump. (docs/taxonomy-capture-tags.md
// §2 originally miscounted the total as 78; corrected to 80 on 2026-10-15.)
// Tags only — domains are NOT valid tags (server IsValid checks the tag union).
// ---------------------------------------------------------------------------
const TAXONOMY = {
  'ai-ml': ['machine-learning', 'deep-learning', 'llms', 'prompt-engineering', 'agents', 'ai-safety', 'computer-vision', 'nlp', 'reinforcement-learning'],
  'programming': ['languages', 'algorithms', 'design-patterns', 'testing', 'api-design', 'compilers', 'functional-programming', 'concurrency'],
  'systems': ['operating-systems', 'distributed-systems', 'networking', 'databases', 'containers', 'orchestration', 'observability', 'storage'],
  'security': ['cryptography', 'appsec', 'network-security', 'vulnerabilities', 'privacy', 'authentication', 'reverse-engineering'],
  'data': ['data-engineering', 'analytics', 'visualization', 'data-modeling', 'etl-pipelines', 'streaming'],
  'science': ['physics', 'biology', 'neuroscience', 'climate', 'research-methods', 'epidemiology'],
  'math': ['linear-algebra', 'probability', 'statistics', 'calculus', 'discrete-math', 'topology'],
  'humanities': ['history', 'philosophy', 'linguistics', 'economics', 'sociology', 'literature'],
  'business': ['startups', 'strategy', 'marketing', 'product', 'finance', 'management'],
  'devtools': ['editors', 'version-control', 'ci-cd', 'build-systems', 'cli-tools', 'developer-experience'],
  'media': ['video', 'podcasts', 'music', 'graphics', 'photography', 'gaming'],
  'life-practical': ['productivity', 'health', 'finance-personal', 'cooking', 'travel', 'learning'],
};
const ALL_TAGS = Object.values(TAXONOMY).flat();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countWord = (hay, word) => (hay.match(new RegExp(`\\b${escapeRe(word)}\\b`, 'g')) || []).length;

// Crude keyword guess — deliberately conservative: a tag needs ≥2 word-boundary
// hits in the body, or any hit in the title. Fewer than the threshold → the tag
// is omitted; an empty tags array is always valid (taxonomy rule 4: "unknown
// beats miscellaneous"). Server-side IsValid is the backstop (400 invalid_tag).
function guessTags(title, text) {
  const titleLc = (title || '').toLowerCase();
  const bodyLc = (text || '').toLowerCase().slice(0, 20_000);
  const scored = [];
  for (const tag of ALL_TAGS) {
    const kw = tag.replace(/-/g, ' ');
    const bodyHits = Math.min(5, countWord(bodyLc, tag) + countWord(bodyLc, kw));
    const titleHit = countWord(titleLc, tag) > 0 || countWord(titleLc, kw) > 0;
    const score = bodyHits + (titleHit ? 2 : 0);
    if (score >= 2) scored.push([tag, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return scored.slice(0, 3).map(([t]) => t);
}

// ---------------------------------------------------------------------------
// Sumi API client (trusted endpoint — the operator's base URL, no egress guard
// here; the guard is for untrusted page URLs). 429 + Retry-After is honored and
// retried a bounded number of times; everything else surfaces.
// ---------------------------------------------------------------------------
async function api(base, token, path, { body, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new FetchError(`sumi ${path}: ${e.message}`);
    }
    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      const waitSec = Math.min(Math.max(retryAfter, 1), 60);
      log(`429 rate-limited — honoring Retry-After, waiting ${waitSec}s (attempt ${attempt + 1}/${retries + 1})`);
      await sleep(waitSec * 1000);
      continue;
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Per-item pipeline: fetch (or claim-carried snapshot) → extract → fallback →
// tag guess → result POST. Any fetch/extract error → failure:true (one attempt
// per item per run).
// ---------------------------------------------------------------------------
async function processItem(base, token, item) {
  let title = '';
  let text = '';
  try {
    let html = typeof item.raw_html === 'string' ? item.raw_html : null;
    if (html) {
      log(`item ${item.id}: using claim-carried raw_html snapshot (${html.length} bytes), no fetch`);
    } else {
      log(`item ${item.id}: guardFetch ${item.url}`);
      const page = await guardFetch(item.url);
      if (page.statusCode >= 400) {
        throw new FetchError(`HTTP ${page.statusCode} from ${page.finalUrl}`);
      }
      html = page.body.toString('utf8');
    }
    title = '';
    text = '';
    try {
      ({ title, text } = extractFromHtml(html));
    } catch (e) {
      // Extraction budget blown on pathological markup — bounded, so treat it
      // like any JS-heavy page: fall through to the render path below.
      log(`item ${item.id}: ${e.message} — treating as unextractable, trying render path`);
    }

    if (text.length < MIN_EXTRACTABLE_CHARS) {
      log(`item ${item.id}: ${text.length} chars extractable (<${MIN_EXTRACTABLE_CHARS}) — lightpanda fallback`);
      await vetOnly(item.url); // a guard-rejected URL never reaches the host browser
      const rendered = await lightpandaFetch(item.url);
      if (rendered && typeof rendered.text === 'string' && rendered.text.length > text.length) {
        title = (rendered.title || title).slice(0, 300);
        text = rendered.text;
        log(`item ${item.id}: lightpanda yielded ${text.length} chars`);
      } else {
        log(`item ${item.id}: lightpanda yielded nothing better — submitting what we have`);
      }
    }

    if (!text.trim()) throw new FetchError('no extractable content (empty after extraction)');

    const result = {
      worker: WORKER_ID,
      claim_token: item.claim_token,
      title,
      markdown: text.slice(0, MAX_MARKDOWN_CHARS),
      summary: text.replace(/\s+/g, ' ').slice(0, 280),
      tags: guessTags(title, text),
    };
    await postResult(base, token, item.id, result);
  } catch (e) {
    const kind = e instanceof PolicyError ? 'egress policy' : 'fetch/extract';
    log(`item ${item.id}: ${kind} failure: ${e.message} — posting failure:true`);
    await postResult(base, token, item.id, {
      worker: WORKER_ID,
      claim_token: item.claim_token,
      failure: true,
    }).catch((e2) => log(`item ${item.id}: failure-report itself failed: ${e2.message}`));
  }
}

async function postResult(base, token, id, result) {
  let res = await api(base, token, `/v1/items/${id}/result`, { body: result });
  if (res.status === 400 && result.tags && result.tags.length) {
    const text = await res.text();
    if (text.includes('invalid_tag')) {
      // Server validates tags BEFORE the failure branch and does not release the
      // claim on 400 — resubmitting without tags is the documented recovery.
      log(`item ${id}: server rejected a tag (taxonomy drift?) — resubmitting without tags`);
      res = await api(base, token, `/v1/items/${id}/result`, { body: { ...result, tags: [] } });
    }
  }
  if (res.ok) {
    log(`item ${id}: result written${result.failure ? ' (failure reported honestly)' : ` (title="${(result.title || '').slice(0, 60)}", tags=[${(result.tags || []).join(', ')}])`}`);
  } else {
    // 409 stale_claim = lease expired + reclaimed → abandon (SKILL.md guardrail).
    log(`item ${id}: result POST ${res.status} ${truncate(await res.text(), 200)} — abandoning (lease sweeper owns it now)`);
  }
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function usage() {
  console.log(`sumi-drain.mjs ${VERSION} — NanoClaw in-turn drain worker (spec-003 §2.2)

Usage:
  bun run sumi-drain.mjs [--base <url>] [--token-file <path>] [--cap N]
                         [--shared-id <id>] [--dry-run]

  --base <url>        sumi origin (default: $SUMI_BASE_URL or ${DEFAULT_BASE})
  --token-file <path> bearer token file, value never printed
                      (default: ${DEFAULT_TOKEN_FILE})
  --cap N             max claims this run (default ${DEFAULT_CAP}; spec §2.2 in-turn budget)
  --shared-id <id>    the just-captured item id — drain stops once it is processed
  --dry-run           claim nothing; print the intended steps

Stop conditions: 204 (empty) · shared-id processed · repeated id (one attempt
per item per run) · cap reached. Fetch errors post failure:true and continue.`);
}

function parseArgs(argv) {
  const args = { base: null, tokenFile: null, cap: null, sharedId: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} requires a value`);
      return argv[i];
    };
    switch (a) {
      case '--base': args.base = next(); break;
      case '--token-file': args.tokenFile = next(); break;
      case '--cap': args.cap = next(); break;
      case '--shared-id': args.sharedId = next(); break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function printDryRunPlan(args, base, tokenFile, cap) {
  let tokenState;
  try {
    const content = await readFile(tokenFile, 'utf8'); // awaited — no floating promise; value never printed
    tokenState = content.trim() ? 'present' : 'present (empty)';
  } catch {
    tokenState = 'missing (a live run would fail before claiming)';
  }
  console.log('sumi-drain: DRY RUN — claims nothing, fetches nothing');
  console.log(`  base:        ${base}`);
  console.log(`  token-file:  ${tokenFile} [${tokenState}]`);
  console.log(`  cap:         ${cap}`);
  console.log(`  shared-id:   ${args.sharedId ?? '(none)'}`);
  console.log(`  worker:      ${WORKER_ID}`);
  console.log(`  lightpanda:  ${process.env.LIGHTPANDA_ENDPOINT || LIGHTPANDA_DEFAULT} (fallback when extractable <${MIN_EXTRACTABLE_CHARS} chars)`);
  console.log('intended steps:');
  console.log(`  1. POST /v1/items/claim {"worker":"${WORKER_ID}"} — 204 stops · repeated id stops · shared-id stops after processing · cap ${cap}`);
  console.log('  2. per item: claim-carried raw_html, else guardFetch — http/https only → resolve A/AAAA →');
  console.log('     reject private/loopback/link-local/CGNAT (pkg/egress ranges) → pin via custom dns.lookup');
  console.log(`     → ${FETCH_TIMEOUT_MS / 1000}s timeout → ${(MAX_BODY_BYTES / 1048576) | 0} MB cap → ≤${MAX_REDIRECTS} manual redirects`);
  console.log(`  3. extract title + text; <${MIN_EXTRACTABLE_CHARS} chars → pre-vet URL then lightpanda CDP fallback`);
  console.log(`  4. taxonomy v1 tag guess (${ALL_TAGS.length} tags embedded, client-filtered; omitted when unsure)`);
  console.log(`  5. POST /v1/items/{id}/result {worker, claim_token, title, markdown, tags, summary}`);
  console.log('     fetch/extract error → {failure:true} · 429 → Retry-After backoff (bounded retries)');
  console.log('sumi-drain: dry run complete (exit 0, no requests sent)');
}

async function main() {
  // Strip proxy env BEFORE any network call: the egress guard vets and pins
  // DIRECT connections — an HTTP(S)_PROXY would bypass the IP checks entirely,
  // and host.docker.internal must never route through a proxy anyway.
  for (const k of Object.keys(process.env)) {
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete process.env[k];
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  let base = (args.base ?? process.env.SUMI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new Error(`--base must be an http(s) origin, got: ${base}`);
  }
  const tokenFile = args.tokenFile ?? process.env.SUMI_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  let cap = args.cap ?? String(DEFAULT_CAP);
  if (!/^\d+$/.test(cap) || Number(cap) < 1) throw new Error(`--cap must be a positive integer, got: ${cap}`);
  cap = Number(cap);

  if (args.dryRun) {
    await printDryRunPlan(args, base, tokenFile, cap);
    return 0;
  }

  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error(`token file ${tokenFile} is empty`);
  log(`base=${base} cap=${cap} shared-id=${args.sharedId ?? '(none)'} worker=${WORKER_ID} (token loaded from ${tokenFile}, value not printed)`);

  const attempted = new Set();
  let processed = 0;
  let stop = 'cap reached';
  for (let claims = 0; claims < cap; claims++) {
    const res = await api(base, token, '/v1/items/claim', { body: { worker: WORKER_ID } });
    if (res.status === 204) {
      stop = 'queue empty (204)';
      break;
    }
    if (!res.ok) {
      throw new FetchError(`claim failed: ${res.status} ${truncate(await res.text(), 200)}`);
    }
    const item = await res.json();
    if (!item.id || !item.claim_token) throw new FetchError(`malformed claim response for item: ${JSON.stringify(item).slice(0, 200)}`);

    if (attempted.has(item.id)) {
      // SKILL.md guardrail: one attempt per item per run — a repeat means the
      // queue handed back a failure we just re-queued. Stop, don't hammer it.
      stop = `claim returned already-attempted id ${item.id}`;
      break;
    }
    attempted.add(item.id);

    await processItem(base, token, item);
    processed += 1;

    if (args.sharedId && item.id === args.sharedId) {
      stop = `shared id ${item.id} processed`;
      break;
    }
    log(`item ${item.id} done — continuing (${claims + 1}/${cap} claims used)`);
  }
  log(`drain complete: ${processed} item(s) processed — stop: ${stop}`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(`sumi-drain: fatal: ${e.message}`);
    process.exitCode = 1;
  });
