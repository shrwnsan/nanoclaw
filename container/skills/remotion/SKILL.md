---
name: remotion
description: Create videos programmatically via the Remotion renderer API. Use when users ask to create MP4 videos, animations, slideshows, or visual content. Submits React-based render jobs to the shared renderer service on the host.
---

# Remotion Video Renderer

Submit render jobs to the shared Remotion renderer (React → MP4 via headless Chrome + ffmpeg). The renderer runs as a warm-standby service — auto-starts on first request, auto-stops after 10 min idle.

## When to use

- User wants to create a video, animation, or slideshow
- Programmatic video generation from data (weather, reports, cards)
- Converting React components to MP4

## Endpoints

Containers access the host directly via HTTP. Remote agents use tailnet TLS.

| Method | Container URL | Purpose |
|--------|--------------|---------|
| GET | `http://host.docker.internal:3456/render` | Healthcheck |
| GET | `http://host.docker.internal:3456/compositions` | List available compositions |
| POST | `http://host.docker.internal:3456/render` | Submit render job |
| GET | `http://host.docker.internal:3456/status/:jobId` | SSE progress stream |
| GET | `http://host.docker.internal:3456/output/:jobId` | Download rendered MP4 |

## Service management

| Method | Container URL | Purpose |
|--------|--------------|---------|
| GET | `http://host.docker.internal:9221/remotion/status` | Check if running |
| POST | `http://host.docker.internal:9221/remotion/start` | Start service |

**Always check status first** — the renderer auto-stops after 10 min idle.

## Available compositions

`hello-world`, `audio-waveform`, `story-cards`, `cjk`, `full-pipeline`

Check `/compositions` for the current list and their required props.

## Workflow: submit → poll → download

```bash
# 1. Check service is up
curl -s http://host.docker.internal:9221/remotion/status
# If stopped: curl -s -X POST http://host.docker.internal:9221/remotion/start

# 2. Submit render
JOB=$(curl -s -X POST http://host.docker.internal:3456/render \
  -H "Content-Type: application/json" \
  -d '{"lang":"en","date":"20260512"}')
JOB_ID=$(echo $JOB | jq -r '.jobId')
echo "Job: $JOB_ID"

# 3. Poll progress (SSE stream)
curl -sN http://host.docker.internal:3456/status/$JOB_ID
# event: status
# data: {"status":"rendering","progress":0.45}
# event: status
# data: {"status":"complete","timeSeconds":170,"sizeMB":2.8}

# 4. Download MP4
curl -s -o /workspace/output.mp4 http://host.docker.internal:3456/output/$JOB_ID
```

## From JavaScript (fetch)

```javascript
// Submit
const resp = await fetch('http://host.docker.internal:3456/render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lang: 'en', date: '20260512' }),
});
const { jobId } = await resp.json();

// Poll (SSE)
const evtSource = new EventSource(
  `http://host.docker.internal:3456/status/${jobId}`
);
evtSource.addEventListener('status', (e) => {
  const data = JSON.parse(e.data);
  if (data.status === 'complete') {
    evtSource.close();
    // Download: fetch(`.../output/${jobId}`)
  }
});
```

## Render parameters

| Field | Required | Description |
|-------|----------|-------------|
| `composition` | No (default: `full-pipeline`) | Composition to render |
| `lang` | No (default: `en`) | Language code (`en`, `zh`, `ja`, etc.) |
| `date` | No | Date string for data-driven renders (YYYYMMDD) |
| `props` | No | Additional component props |
| `outputName` | No | Custom output filename |

## Performance expectations

| Composition | Duration | Size |
|-------------|----------|------|
| `hello-world` | ~30s | ~1 MB |
| `full-pipeline` | ~170s | ~2.8 MB |
| `cjk` | ~60s | ~1.5 MB |

Render times vary based on composition complexity and whether Chromium needs a cold start (~10s overhead).

## Important rules

1. **Check service status first** — the renderer may be stopped. Start via service trigger if needed.
2. **Poll don't block** — renders take 30-180s. Use SSE streaming to track progress.
3. **Download promptly** — rendered files may be cleaned up by the watchdog.
4. **One render at a time** — the renderer processes jobs sequentially. Queue if needed.
5. **No custom compositions** — only pre-registered compositions are available. To add new ones, the renderer source must be updated (host-level, not from container).
