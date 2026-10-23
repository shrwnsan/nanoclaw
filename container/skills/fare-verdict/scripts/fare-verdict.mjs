#!/usr/bin/env node
/* fare-verdict — advisory flight-fare verdict from Google Flights' own price-insights surface.
 *
 * Design constraints (post-review, 2026-10-09 — see PROVENANCE.md):
 *   - One substrate: agent-browser CLI. Deep-link the results page; the only bounded
 *     interaction is one expansion of a collapsed insights panel. Results are never driven.
 *   - Min-of-N loads (default 3): a single load from an inventory-backed surface is a
 *     sample, not a measurement. Only min-of-loads per slice, plus the floor, are facts.
 *   - The verdict is deterministic arithmetic on the extracted band/series. No LLM anywhere
 *     in this path — an LLM inside a deterministic path converts loud failure into
 *     confident wrong numbers.
 *   - Band position is the signal; superlatives ("61-day low") are not. Calendar bounds
 *     are conservative, never "must-book-by".
 *   - Every extraction contract lives in SURFACE below. --selftest validates the parsers
 *     against recorded fixtures offline; a live run validates the surface itself and
 *     fails loud (never guesses) when Google's markup moves.
 *
 * Personal-use tooling: on-demand or low-cadence checks for a human planning a trip.
 * Not for bulk crawling — see the distribution note in PROVENANCE.md.
 *
 * Requires: Node 18+, agent-browser CLI on PATH (docker-agent-browser skill sets that up).
 */

import { execFileSync } from 'node:child_process';

/* ── SURFACE: every Google-Flights extraction contract in one place ─────────── */

const SURFACE = {
  deepLink(from, to, date, trip, curr, lang) {
    const q = encodeURIComponent(`flights from ${from} to ${to} on ${date}${trip === 'one-way' ? ' one way' : ''}`);
    return `https://www.google.com/travel/flights?q=${q}&curr=${curr}&hl=${lang}`;
  },
  // Currency symbol as it prefixes amounts in listings ("HK$1,435"). Extend as needed.
  symbols: {
    HKD: 'HK\\$', USD: '\\$', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN?¥', TWD: 'NT\\$',
    KRW: '₩', SGD: 'S\\$', AUD: 'A\\$', CAD: 'C\\$', INR: '₹', THB: '฿', PHP: '₱', MYR: 'RM\\s?',
  },
  consentMarkers: /unusual traffic|not a robot|enable JavaScript|\/sorry\/|consent\.google\.com/i,
  insightAnchor: 'Price insights',
  bandRe: /usually cost between\s+(.+?)\s*[–—-]\s*([^\n.]+)/i,
  seriesRe: /(?:(\d+)\s+days?\s+ago|today)\s*-\s*(.+)$/i,
  stopsRe: /Nonstop|(\d+)\s+stop/i,
  durationRe: /(\d+)\s*hr(?:\s*(\d+)\s*min)?/i,
};

/* ── extraction snippet (dumb collector — all parsing happens locally) ──────── */

const SNIPPET = `(() => {
  const t = document.body.innerText;
  const lis = [...document.querySelectorAll("li")]
    .filter(li => li.innerText && /\\d{1,2}:\\d{2}/.test(li.innerText))
    .map(li => li.innerText.replace(/\\u00a0/g, " "));
  const aria = [...document.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label"));
  const i = t.indexOf(${JSON.stringify(SURFACE.insightAnchor)});
  return JSON.stringify({
    title: document.title,
    body: t.slice(0, 4000),
    lis,
    aria,
    insight: i === -1 ? "" : t.slice(i, i + 600),
  });
})()`;

/* ── arg parsing ────────────────────────────────────────────────────────────── */

function usage(code = 2) {
  const m = `fare-verdict — advisory fare verdict from Google Flights price insights

Usage:
  node fare-verdict.mjs --from HKG --to CTS --date 2027-03-16 [options]

Required:
  --from IATA        Origin airport code (3 letters)
  --to IATA          Destination airport code (3 letters)
  --date YYYY-MM-DD  Departure date

Options:
  --currency CODE    Display currency (default HKD; must be one the page renders)
  --lang CODE        Page locale (default en)
  --trip KIND        one-way (default) | round-trip — round-trip is UNTESTED, v1 refuses it
  --loads N          Independent page loads per slice minimum (default 3, min 2)
  --window NAME      morning | afternoon | evening | redeye  (dep-time filter)
  --nonstop          Nonstop-only slice
  --constraints "…"  Fuzzy input, v1 keyword parser (echoed in output; never silent)
  --json-only        Machine output only
  --selftest         Offline parser checks against recorded fixtures; no network

  v1 is advisory and one-way. It never books, and it says so.`;
  console.error(m);
  process.exit(code);
}

function parseArgs(argv) {
  const a = { from: null, to: null, date: null, currency: 'HKD', lang: 'en', trip: 'one-way', loads: 3, window: null, nonstop: false, constraints: null, jsonOnly: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--selftest') a.selftest = true;
    else if (k === '--json-only') a.jsonOnly = true;
    else if (k === '--nonstop') a.nonstop = true;
    else if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--date') a.date = argv[++i];
    else if (k === '--currency') a.currency = (argv[++i] || '').toUpperCase();
    else if (k === '--lang') a.lang = argv[++i];
    else if (k === '--trip') a.trip = argv[++i];
    else if (k === '--loads') a.loads = parseInt(argv[++i], 10);
    else if (k === '--window') a.window = (argv[++i] || '').toLowerCase();
    else if (k === '--constraints') a.constraints = argv[++i];
    else if (k === '-h' || k === '--help') usage(0);
    else usage();
  }
  return a;
}

/* v1 keyword constraint parser — deterministic, echoed back. Documented Jev upgrade
 * path (schema-gated structured parsing) lives in PROVENANCE.md; never wire an LLM in
 * here silently. */
const WINDOWS = { morning: [300, 719], afternoon: [720, 1079], evening: [1080, 1439], redeye: [0, 299] };

function parseConstraints(text, acc = {}) {
  const out = { ...acc };
  const t = (text || '').toLowerCase();
  for (const w of Object.keys(WINDOWS)) if (t.includes(w)) out.window = w;
  if (/\bnon-?stop\b|\bdirect\b/.test(t)) out.nonstop = true;
  const pax = t.match(/(\d+)\s*(?:adults?|pax|people|persons?|passe?ngers?)/);
  if (pax) out.pax = parseInt(pax[1], 10); // informational only — v1 prices are per-adult
  return out;
}

/* ── parsing (pure functions — covered by --selftest fixtures) ──────────────── */

const moneyOf = (sym, s) => {
  const m = s.match(new RegExp(`(?:${sym})\\s?([\\d,]+)`));
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
};

function parseItinerary(text, sym) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const price = moneyOf(sym, text);
  const stopsM = text.match(SURFACE.stopsRe);
  const durM = text.match(SURFACE.durationRe);
  // keep the meridiem on the token — window math needs it (1:10 AM ≠ 1:10 PM)
  const times = lines.filter(l => /^\d{1,2}:\d{2}\s*(AM|PM)?/i.test(l)).map(l => l.match(/^\d{1,2}:\d{2}\s*(?:AM|PM)?/i)[0]);
  // layover code rides its own line ("7 hr 35 min NRT"); matching the whole text would
  // bind the route line ("HKG–CTS") that follows the total-duration line
  const via = (lines.map(l => l.match(/\d+\s*hr\s*\d*\s*min\s+([A-Z]{3})\b/)).find(Boolean) || [])[1] || null;
  const airline = lines.find(l =>
    /[A-Za-z]{3}/.test(l) && !/^\d{1,2}:\d{2}/.test(l) && !/hr|min|kg|CO2|emission|stop|Avg|Avoids|trees|[\$€£¥₩₹฿₱]/i.test(l)
  ) || null;
  if (price == null || !stopsM || times.length < 1) return null;
  return {
    dep: times[0] || null,
    arr: times[1] || null,
    airline,
    nonstop: /Nonstop/i.test(text),
    stops: /Nonstop/i.test(text) ? 0 : stopsM[1] ? parseInt(stopsM[1], 10) : (stopsM[0].match(/\d+/) ? parseInt(stopsM[0], 10) : null),
    via,
    durationMin: durM ? parseInt(durM[1], 10) * 60 + (durM[2] ? parseInt(durM[2], 10) : 0) : null,
    price,
  };
}

function toMinutes(t) {
  const m = (t || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  let mins = (h % 24) * 60 + parseInt(m[2], 10);
  const mer = (m[3] || '').toUpperCase();
  if (mer === 'PM' && h < 12) mins += 720;
  if (mer === 'AM' && h === 12) mins -= 720; // 12:xx AM is 00:xx
  return mins;
}

function inWindow(depStr, win) {
  if (!win || !depStr) return true;
  const mm = toMinutes(depStr);
  if (mm == null) return true;
  const [lo, hi] = WINDOWS[win] || [0, 1439];
  return mm >= lo && mm <= hi;
}

function parseLoad(raw, sym) {
  const consent = SURFACE.consentMarkers.test(raw.title || '') || SURFACE.consentMarkers.test((raw.body || '').slice(0, 800));
  const itineraries = raw.lis.map(l => parseItinerary(l, sym)).filter(Boolean);
  const bandM = (raw.insight || '').match(SURFACE.bandRe);
  const band = bandM ? { low: moneyOf(sym, bandM[1]) ?? parseInt((bandM[1] || '').replace(/[^\d]/g, ''), 10), high: moneyOf(sym, bandM[2]) ?? parseInt((bandM[2] || '').replace(/[^\d]/g, ''), 10) } : null;
  const series = [];
  for (const label of raw.aria || []) {
    const m = label.match(SURFACE.seriesRe);
    if (!m) continue;
    const day = /today/i.test(m[0]) ? 0 : parseInt(m[1], 10);
    const price = moneyOf(sym, m[2]) ?? parseInt((m[2] || '').replace(/[^\d]/g, ''), 10);
    if (Number.isInteger(day) && price > 0) series.push({ daysAgo: day, price });
  }
  return { consent, itineraries, band, series, insightPresent: /usually cost between/i.test(raw.insight || '') };
}

function validateLoad(load) {
  const errs = [];
  if (load.consent) errs.push('consent/bot wall detected — abort rather than parse a wall');
  if (!load.itineraries.length) errs.push('no parsable itineraries — surface markup may have moved');
  if (load.band && !(load.band.low > 0 && load.band.high > load.band.low)) errs.push(`band failed sanity: ${JSON.stringify(load.band)}`);
  if (load.series.length && load.series.length < 8) errs.push(`series too short (${load.series.length}) — partial render, refuse it`);
  const days = new Set(load.series.map(p => p.daysAgo));
  if (days.size !== load.series.length) errs.push('series has duplicate day labels — dedupe failed');
  return errs;
}

/* min-of-loads aggregation: per-slice minimum across independent loads */
function aggregate(loads, sym, filters) {
  const slice = (pred) => loads.flatMap(L => L.itineraries.filter(pred))
    .reduce((best, it) => (best == null || it.price < best.price ? it : best), null);
  const all = slice(() => true);
  const nonstop = slice(it => it.nonstop);
  const windowed = slice(it => inWindow(it.dep, filters.window));
  const bands = loads.map(L => L.band).filter(Boolean);
  const band = bands.length ? bands.sort((a, b) => (a.low - b.low) || (a.high - b.high))[0] : null;
  const bandDisagreed = bands.length > 1 && bands.some(b => b.low !== band.low || b.high !== band.high);
  const series = loads.map(L => L.series).sort((a, b) => b.length - a.length)[0] || [];
  return { all, nonstop, windowed, band, bandDisagreed, series };
}

/* ── verdict (deterministic; band position over superlatives) ───────────────── */

function bandPosition(price, band) {
  if (!band) return null;
  return (price - band.low) / (band.high - band.low);
}

function zone(pos) {
  if (pos == null) return 'no-band';
  if (pos < 0) return 'below-band';
  if (pos <= 0.33) return 'low-in-band';
  if (pos <= 0.66) return 'mid-band';
  if (pos <= 1) return 'high-in-band';
  return 'above-band';
}

function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function verdict(agg, args, today) {
  const primary = agg.nonstop && args.nonstop ? agg.nonstop : agg.windowed || agg.all;
  const pos = bandPosition(primary?.price, agg.band);
  const z = zone(pos);
  const floorPos = bandPosition(agg.all?.price, agg.band);
  const daysOut = Math.round((new Date(args.date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  const watchBy = addDays(args.date, -120);
  const hardBound = addDays(args.date, -49); // Google intl booking-window prior (see PROVENANCE)
  const seriesLow = agg.series.length ? Math.min(...agg.series.map(p => p.price)) : null;

  let call, why;
  if (!agg.band) {
    call = 'LADDER-ONLY';
    why = 'No typical-price band surfaced for this search — no verdict against "typical" is possible, and monitoring guidance is disabled. Treat the ladder as raw data only.';
  } else if (daysOut <= 0) {
    call = 'DEPARTURE PASSED';
    why = 'The date is today or past — nothing to advise.';
  } else if (z === 'below-band') {
    call = 'BELOW TYPICAL';
    why = `Primary slice sits under the usual band. Confirm it holds on a second run before acting — single loads are samples.`;
  } else if (z === 'high-in-band' || z === 'above-band') {
    call = 'ABOVE TYPICAL';
    why = `The constrained slice sits at the top of (or above) the usual range${daysOut > 120 ? `, with ${daysOut} days of runway` : ''}. Wait for a held band-crossing if flexible; check the carrier's own site, which aggregators may not see.`;
  } else if (daysOut > 120) {
    call = 'FAIR — TOO EARLY TO OPTIMIZE';
    why = `Price sits ${z.split('-').join(' ')} and the trip is ${daysOut}d out. History suggests no action needed yet; begin weekly checks near the watch date.`;
  } else if (daysOut > 49) {
    call = z === 'low-in-band' ? 'FAIR — WATCH FOR BETTER' : 'FAIR — DECISION WINDOW';
    why = z === 'low-in-band'
      ? `Low in the band inside the historical decision window — a reasonable hold point. Act on any held band-crossing downward.`
      : `Mid/high in the band inside the historical decision window. The window is where sale waves typically land; check weekly and act on held improvements.`;
  } else {
    call = 'PAST CONSERVATIVE BOUND — BOOK RATHER THAN OPTIMIZE';
    why = `Within 49 days of departure; population priors say waiting now buys risk, not savings.`;
  }

  const alertFloor = agg.band ? Math.round(agg.band.low) : null;
  return {
    call, why,
    primary: { price: primary?.price, zone: z, positionPct: pos == null ? null : Math.round(pos * 100) },
    floor: { price: agg.all?.price, zone: zone(floorPos) },
    calendar: { daysOut, watchBy, hardBound, pastHardBound: daysOut <= 49 },
    alertRule: agg.band
      ? `Only a move below ${args.currency} ${alertFloor?.toLocaleString()} (band low), held across 2 loads, is a signal. Single-load drops are sampling noise.`
      : 'Disabled — no band to alert against.',
    series: { points: agg.series.length, low: seriesLow, note: agg.series.length ? `Series spans ${Math.max(...agg.series.map(p => p.daysAgo))} days; its low sits ${zone(bandPosition(seriesLow, agg.band))}.` : 'No history surfaced.' },
  };
}

/* ── agent-browser plumbing ─────────────────────────────────────────────────── */

/* Layer 2 (band + history) sometimes renders collapsed: the insights chip shows
 * "Prices are currently typical" with no band sentence and no history labels. The
 * "View price history" control is role-less DIVs (no BUTTON, no aria-expanded), and a
 * plain .click() does nothing — the full pointer/mouse event sequence does. One bounded
 * expansion attempt per load; the results themselves are never driven. */
const EXPAND_SNIPPET = `(() => {
  const vis = e => !!(e.offsetParent || e.getClientRects().length);
  const leaves = [...document.querySelectorAll("*")]
    .filter(e => e.children.length === 0 && vis(e) && /view price history/i.test(e.textContent || ""));
  if (!leaves.length) return JSON.stringify({ clicked: false });
  const el = leaves[0];
  const opt = { bubbles: true, cancelable: true, view: window };
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(t => {
    try { el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, opt)); } catch (err) {}
  });
  return JSON.stringify({ clicked: true });
})()`;

const wait = ms => execFileSync('node', ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore', timeout: ms + 5000 });

function collect() {
  const out = execFileSync('agent-browser', ['eval', SNIPPET], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  const line = out.split('\n').find(l => l.trim().startsWith('"') || l.trim().startsWith('{') || l.trim().startsWith('['));
  if (!line) throw new Error('agent-browser eval returned no JSON line');
  const parsed = JSON.parse(line.trim());
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

function browserLoad(url) {
  execFileSync('agent-browser', ['open', url], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
  wait(3200);
  let raw = collect();
  let expanded = false;
  try {
    const line = execFileSync('agent-browser', ['eval', EXPAND_SNIPPET], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
      .split('\n').find(l => l.trim().startsWith('{') || l.trim().startsWith('"'));
    const res = line ? JSON.parse(line.trim()) : {};
    const r = typeof res === 'string' ? JSON.parse(res) : res;
    if (r.clicked) {
      wait(2500);
      const raw2 = collect();
      if ((raw2.insight || '').length >= (raw.insight || '').length) { raw = raw2; expanded = true; }
    }
  } catch { /* expansion is best-effort; the passive extract already validated below */ }
  return { raw, expanded };
}

/* ── selftest (offline fixtures recorded 2026-10-09, HKG→CTS one-way) ───────── */

function selftest() {
  const SYM = SURFACE.symbols.HKD;
  const li1 = '1:10 AM\n–\n3:45 PM\nJetstar\n13 hr 35 min\nHKG–CTS\n1 stop\n7 hr 35 min NRT\n255 kg CO2e\n-19% emissions\nHK$1,435';
  const li2 = '9:15 AM\n–\n3:00 PM\nGreater Bay Airlines\n4 hr 45 min\nHKG–CTS\nNonstop\n240 kg CO2e\n-24% emissions\nHK$3,444';
  const li3 = '9:10 AM\n–\n2:50 PM\nCathay PacificJAL\n4 hr 40 min\nHKG–CTS\nNonstop\n266 kg CO2e\n-16% emissions\nHK$10,446';
  const insight = 'Price insights\nPrices are currently typical for your search\nThe least expensive flights for similar trips to Sapporo usually cost between HK$1,300–2,150.\nHK$1,435 is typical';
  const aria = [];
  for (let d = 61; d >= 2; d--) {
    const price = d > 42 ? 1469 : d >= 42 && d >= 40 ? 1900 : d >= 37 ? 1864 : d >= 5 ? (d >= 15 ? 1627 : 1535) : 1435;
    aria.push(`${d} days ago - HK$${price.toLocaleString('en-US')}`);
  }
  const raw = { title: 'Hong Kong to Sapporo | Google Flights', body: 'x', lis: [li1, li2, li3], aria, insight };
  const load = parseLoad(raw, SYM);
  const errs = validateLoad(load);
  assert(!load.consent, 'selftest: false consent positive');
  assert(!errs.length, 'selftest: validateLoad — ' + errs.join('; '));
  assert(load.itineraries.length === 3, `selftest: expected 3 itineraries, got ${load.itineraries.length}`);
  const [j, g, c] = load.itineraries;
  assert(j.price === 1435 && j.nonstop === false && j.via === 'NRT' && j.stops === 1, 'selftest: Jetstar row misparsed: ' + JSON.stringify(j));
  assert(g.airline === 'Greater Bay Airlines' && g.nonstop && g.price === 3444, 'selftest: GBA row misparsed: ' + JSON.stringify(g));
  assert(c.price === 10446, 'selftest: CX+JAL row misparsed');
  assert(j.dep === '1:10 AM' && j.arr === '3:45 PM', 'selftest: times misparsed');
  assert(toMinutes('1:10 AM') === 70 && toMinutes('1:10 PM') === 790 && toMinutes('12:30 AM') === 30 && toMinutes('12:30 PM') === 750, 'selftest: meridiem math');
  assert(load.band && load.band.low === 1300 && load.band.high === 2150, 'selftest: band misparsed: ' + JSON.stringify(load.band));
  assert(load.series.length === 60, `selftest: series length ${load.series.length}`);
  assert(load.series[0].price === 1469 && load.series.some(p => p.price === 1435), 'selftest: series prices wrong');

  const agg = aggregate([load, load], SYM, { window: 'morning' });
  assert(agg.all.price === 1435 && agg.nonstop.price === 3444 && agg.windowed.price === 3444, 'selftest: slices wrong');
  assert(agg.band.low === 1300 && !agg.bandDisagreed, 'selftest: band aggregation wrong');

  const args = { nonstop: false, date: '2027-03-16', currency: 'HKD' };
  // unconstrained: primary = route floor 1,435 → (1435-1300)/850 = 15.9% → low-in-band,
  // 158 days out → "too early" — the recorded 2026-10-09 answer to the owner's question
  const v = verdict(aggregate([load, load], SYM, {}), args, '2026-10-09');
  assert(v.call.startsWith('FAIR — TOO EARLY'), 'selftest: verdict call — ' + v.call);
  assert(v.calendar.watchBy === '2026-11-16' && v.calendar.hardBound === '2027-01-26', 'selftest: calendar — ' + JSON.stringify(v.calendar));
  assert(v.primary.positionPct === 16 && v.primary.zone === 'low-in-band' && v.floor.zone === 'low-in-band', 'selftest: band position — ' + JSON.stringify(v.primary));
  assert(/below HKD 1,300/.test(v.alertRule), 'selftest: alert rule — ' + v.alertRule);
  // morning-window slice: primary = GBA nonstop 3,444 → above the 2,150 band top (252%)
  const vM = verdict(aggregate([load, load], SYM, { window: 'morning' }), args, '2026-10-09');
  assert(vM.call === 'ABOVE TYPICAL' && vM.primary.zone === 'above-band' && vM.primary.positionPct === 252, 'selftest: morning slice verdict — ' + JSON.stringify(vM.primary) + ' / ' + vM.call);

  // degradation path
  const bare = parseLoad({ title: 'ok', body: 'x', lis: [li1], aria: [], insight: '' }, SYM);
  const v2 = verdict(aggregate([bare], SYM, {}), args, '2026-10-09');
  assert(v2.call === 'LADDER-ONLY' && v2.alertRule.includes('Disabled'), 'selftest: degradation — ' + v2.call);

  // constraint parser echo
  const kw = parseConstraints('morning nonstop for 2 adults');
  assert(kw.window === 'morning' && kw.nonstop === true && kw.pax === 2, 'selftest: constraint parse');

  console.log('selftest: all parser + verdict checks passed');
}

function assert(cond, msg) { if (!cond) { console.error(msg); process.exit(1); } }

/* ── main ───────────────────────────────────────────────────────────────────── */

const args = parseArgs(process.argv.slice(2));
if (args.selftest) { selftest(); process.exit(0); }
if (!args.from || !args.to || !args.date) usage();
if (!/^[A-Z]{3}$/i.test(args.from || '') || !/^[A-Z]{3}$/i.test(args.to || '')) { console.error('--from/--to must be 3-letter IATA codes'); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) { console.error('--date must be YYYY-MM-DD'); process.exit(2); }
if (args.trip !== 'one-way') { console.error('v1 refuses non-one-way searches — round-trip parsing is untested (PROVENANCE.md)'); process.exit(2); }
if (!(args.loads >= 2)) { console.error('--loads must be >= 2: a single load is a sample, not a measurement'); process.exit(2); }
if (args.window && !WINDOWS[args.window]) { console.error(`--window must be one of ${Object.keys(WINDOWS).join(' | ')}`); process.exit(2); }

const filters = args.constraints ? parseConstraints(args.constraints, { window: args.window, nonstop: args.nonstop }) : { window: args.window, nonstop: args.nonstop };
const sym = SURFACE.symbols[args.currency];
if (!sym) { console.error(`no currency symbol mapping for ${args.currency} — add it to SURFACE.symbols`); process.exit(2); }
const today = new Date().toISOString().slice(0, 10);
const url = SURFACE.deepLink(args.from.toUpperCase(), args.to.toUpperCase(), args.date, args.trip, args.currency, args.lang);

const loads = [];
let anyExpanded = false;
for (let i = 1; i <= args.loads; i++) {
  if (!args.jsonOnly) console.error(`load ${i}/${args.loads} …`);
  let res;
  try { res = browserLoad(url); } catch (e) { console.error(`load ${i} failed: ${e.message}`); continue; }
  const load = parseLoad(res.raw, sym);
  load.expanded = res.expanded;
  if (res.expanded) anyExpanded = true;
  const errs = validateLoad(load);
  if (errs.length) { console.error(`surface check failed on load ${i}: ${errs.join('; ')}`); process.exit(3); }
  loads.push(load);
}
if (!loads.length) { console.error('all loads failed — see messages above; do not retry blind (consent walls punish retries)'); process.exit(3); }

const agg = aggregate(loads, sym, filters);
const v = verdict(agg, args, today);

const fmt = n => `${args.currency} ${n?.toLocaleString('en-US')}`;
const row = it => it ? `${fmt(it.price)}  ${it.airline || '?'} · dep ${it.dep || '?'}${it.nonstop ? ' · nonstop' : ` · ${it.stops ?? '?'} stop${it.stops === 1 ? '' : 's'}${it.via ? ' via ' + it.via : ''}`}` : 'no flight matched this slice';
const resolved = [`window=${filters.window || 'any'}`, filters.nonstop ? 'nonstop-only' : 'any-stops', filters.pax ? `${filters.pax} pax (informational)` : null].filter(Boolean).join(', ');

const out = {
  route: `${args.from.toUpperCase()}→${args.to.toUpperCase()} ${args.date}`,
  searchUrl: url,
  loads: loads.length,
  insightsLayer: agg.band ? (anyExpanded ? 'band+history after one panel expansion' : 'band+history native') : (anyExpanded ? 'absent even after panel expansion' : 'absent — expansion control not found'),
  constraintsResolved: resolved,
  ladder: {
    scopeNote: 'Minimum across loads, on Google\'s surface only — carrier-direct buckets (e.g. an airline\'s own site) may not appear here.',
    all: agg.all, nonstop: agg.nonstop, window: agg.windowed,
  },
  band: agg.band ? { low: agg.band.low, high: agg.band.high, disagreedAcrossLoads: agg.bandDisagreed } : null,
  verdict: v,
  caveats: [
    'Prices are per adult, one-way, as displayed to this egress; locale/IP can change what Google shows.',
    'Booking-window bounds are population-level priors, not route guarantees — band position is the observed signal.',
    'Aggregators may not see carrier-direct fares; check the airline\'s own site before concluding a price is the best nonstop.',
  ],
};

if (args.jsonOnly) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`── ${out.route} · ${loads.length} loads · constraints: ${resolved}`);
  console.log(`All         ${row(agg.all)}`);
  console.log(`Nonstop     ${row(agg.nonstop)}`);
  console.log(`Window      ${row(agg.windowed)}`);
  if (agg.band) console.log(`Band        ${fmt(agg.band.low)}–${agg.band.high.toLocaleString('en-US')}${agg.bandDisagreed ? ' (varied across loads — treated as noise)' : ''}${anyExpanded ? ' (after panel expansion)' : ''}`);
  else console.log(`Band        not surfaced${anyExpanded ? ' even after panel expansion' : ''} — ladder-only verdict, monitoring disabled`);
  console.log(`Series      ${v.series.note}`);
  console.log(``);
  console.log(`Verdict: ${v.call}`);
  console.log(v.why);
  console.log(`Watch by ${v.calendar.watchBy} · conservative hard bound ${v.calendar.hardBound}${v.calendar.pastHardBound ? ' (PASSED)' : ''}`);
  console.log(v.alertRule);
  console.log(``);
  out.caveats.forEach(c => console.log(`· ${c}`));
}
