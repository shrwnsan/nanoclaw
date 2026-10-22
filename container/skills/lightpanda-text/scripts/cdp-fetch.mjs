// cdp-fetch.mjs — lightpanda text extraction via raw CDP, Node built-ins only
// From the host agent (2026-10-04, verified in-container 2026-10-05). Escape hatch, not replacement:
// agent-browser stays the default; reach for this when a target 0-texts under the default engine.
// Rules: connect by IP (ws://172.17.0.1:9224/ — host-gateway; DNS-name Host → 403); Node's native
// WS sends no Origin header so the python-client trap doesn't apply; text/JS extraction only
// (no DOMSnapshot, placeholder screenshots).
const url = process.argv[2];
// Endpoint precedence: argv[3] > LIGHTPANDA_ENDPOINT > default (this box's host-gateway IP).
// Empty-string values fall through (|| not ??) — IPs drift on container recreate,
// see references/deployment.md for the endpoint table.
const endpoint = process.argv[3] || process.env.LIGHTPANDA_ENDPOINT || 'ws://172.17.0.1:9224/';
if (!url) { console.error('usage: node cdp-fetch.mjs <url> [wsEndpoint]'); process.exit(1); }
const ws = new WebSocket(endpoint);
let mid = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++mid;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
  });
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
};
ws.onerror = (e) => { console.error('WS error:', e.message ?? e); process.exit(2); };
await new Promise((res, rej) => { ws.onopen = res; setTimeout(() => rej(new Error('connect timeout')), 10000); });
const { targetId } = await send('Target.createTarget', { url });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await new Promise(r => setTimeout(r, 6000)); // let JS render
const ev = await send('Runtime.evaluate', {
  expression: `JSON.stringify({title: document.title, len: (document.body?.innerText ?? '').length, text: (document.body?.innerText ?? '').slice(0, 600)})`,
  returnByValue: true,
}, sessionId);
console.log(JSON.parse(ev.result.value).text ? JSON.stringify(JSON.parse(ev.result.value), null, 1) : ev.result.value);
await send('Target.closeTarget', { targetId });
ws.close();
