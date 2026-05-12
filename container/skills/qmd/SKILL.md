---
name: qmd
description: Search markdown knowledge bases and documentation using QMD. Use when users ask to search notes, find documents, look up past research, or query indexed knowledge. Provides hybrid search (BM25 + vector + rerank) across all configured collections.
compatibility: QMD MCP server running on host at host.docker.internal:8181. Accessible from all NanoClaw containers.
---

# QMD — Quick Markdown Search

Local hybrid search engine (BM25 + vector + deep rerank) for markdown content. Runs on the host as an MCP server, accessible to all containers.

## Status

QMD runs on the same host as NanoClaw (oci-prime). It's always available — no service trigger needed.

```
Host: http://host.docker.internal:8181/mcp
Collections: telegram_main, claw-squad
```

## Searching via HTTP API

```bash
curl -s -X POST http://host.docker.internal:8181/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "structured_search",
      "arguments": {
        "searches": [
          { "type": "lex", "query": "VPS pricing" },
          { "type": "vec", "query": "what are the cheapest cloud providers for always-free instances" }
        ],
        "limit": 5
      }
    },
    "id": 1
  }'
```

## Query Types

| Type | Method | Best for |
|------|--------|----------|
| `lex` | BM25 keyword | Exact terms, names, code identifiers |
| `vec` | Vector semantic | Natural language questions |
| `hyde` | Hypothetical document | Write what the answer looks like (50-100 words) |
| `expand` | Auto-expand | Single-line query, LLM generates variations |

### Writing good queries

**lex:** 2-5 terms, no filler. Quoted phrases: `"connection pool"`. Exclude: `performance -sports`
**vec:** Full question. Be specific: `"how does the rate limiter handle burst traffic"`
**hyde:** 50-100 words of what the answer would look like

First query gets 2x weight in fusion — put your best guess first.

### Combining types

| Goal | Approach |
|------|----------|
| Know exact terms | `lex` only |
| Don't know vocabulary | `vec` or single-line (auto-expand) |
| Best recall | `lex` + `vec` |
| Complex topic | `lex` + `vec` + `hyde` |

### Collection filtering

```json
{ "collections": ["telegram_main"] }        // Single
{ "collections": ["telegram_main", "claw-squad"] }  // Multiple (OR)
```

Omit `collections` to search all.

### Intent (disambiguation)

```json
{
  "searches": [{ "type": "lex", "query": "performance" }],
  "intent": "web page load times and Core Web Vitals"
}
```

## Other tools

| Tool | Purpose |
|------|---------|
| `get` | Retrieve doc by path or `#docid` |
| `multi_get` | Retrieve multiple by glob pattern |
| `status` | Collections and index health |

### get example

```bash
# By docid
curl -s -X POST http://host.docker.internal:8181/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get","arguments":{"path":"#abc123","full":true}},"id":1}'
```

### multi_get example

```bash
# By glob pattern
curl -s -X POST http://host.docker.internal:8181/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"multi_get","arguments":{"pattern":"docs/*.md"}},"id":1}'
```

## Collections

| Collection | Source | Content |
|------------|--------|---------|
| `telegram_main` | `groups/telegram_main/` | Docs, research, notes from the main agent |
| `claw-squad` | `groups/telegram_claw-squad/` | Docs from My Claw Squad agent |

Index is rebuilt daily via cron (`qmd update && qmd embed`). Searches work against the existing index — no manual updates needed.

## How it works

QMD uses three stages:
1. **BM25** (lex) + **vector** (vec/hyde) retrieve candidates
2. **Reciprocal Rank Fusion** merges results (first query weighted 2x)
3. **Qwen3 1.7B reranker** re-scores top candidates for final ranking

All models run on CPU (ARM, no GPU). First search after idle loads models (~3 GB).

## Usage patterns

### "Search my notes about X"

Use a lex+vec combo for best recall. Return top results with snippets.

### "What did I research about Y?"

Use vec with a natural language question. Add intent if the query is ambiguous.

### "Find the document about Z"

Use lex with specific terms. Use get or multi_get to retrieve full content.
