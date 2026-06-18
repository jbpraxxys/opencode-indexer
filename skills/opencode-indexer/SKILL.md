---
name: codebase-search
description: MANDATORY — Load this skill BEFORE any code search (grep, glob, find included). Also use for indexing and checking index status. The codebase_search-first rule applies to every code lookup.
---

# Codebase Search

Semantic code search for OpenCode. Indexes source code with tree-sitter AST parsing. Search with natural language.

## Rule: `codebase_search`-first

Every code lookup follows this sequence — no exceptions:

1. **`codebase_status()`** — check opt-in (instant, free)
2. **`codebase_search("query")`** — semantic search
3. **Rephrase and retry** if no results
4. **grep / glob / find** — only as last resort

Never run grep before exhausting `codebase_search`. Never run both simultaneously.

This applies to every code lookup — finding a function, understanding logic, locating a file, checking behavior. Even when you know the exact name, `codebase_search` finds it plus related code grep would miss.

## New Project

```
codebase_status()           ← first
  → Not opted in? Tell user: touch .codebase-index
  → No index? Auto-index triggers on first search
  → Index ready? codebase_search("query")
```

Auto-indexing fires on first tool call in an opted-in project. Hash caching makes re-indexing incremental — only changed files re-process. The file watcher keeps the index current on save.

## Tools

| Tool | Purpose |
|------|---------|
| `codebase_search(query, maxResults?)` | Semantic search |
| `codebase_status()` | Check opt-in, block count, backend |
| `codebase_index(force?)` | Build/refresh index |

## Query Tips

Describe behavior, not syntax:
- Good: `"function that validates JWT tokens"`
- Good: `"how does authentication middleware work"`
- Bad: `"validateToken"` (grep for exact identifiers, only after search fails)

Rephrase strategies when first query fails:
- Broaden: `"authentication"` → `"user login session"`
- Narrow: `"API"` → `"REST endpoint handler middleware"`
- Change perspective: `"how is X done"` → `"where is X defined"` → `"what calls X"`

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Not opted in" error | `touch .codebase-index` in project root |
| Stale or corrupt index | Delete `.codebase-index-store/`, run `codebase_index(force=true)` |
| Embedding API error | Check API key and base URL |
| Qdrant not available | `curl http://localhost:6333/healthz` |
| Plugin tools not showing | Restart OpenCode, check `opencode plugin list` |
| Qdrant "too many open files" (macOS) | `ulimit -n 65536` before launching Qdrant |
| Switch vector stores | Change `vectorStore` in config, re-index with `force=true` |

## Reference

- **Configuration** — embedder, model, vector store, all options: see [reference/CONFIG.md](reference/CONFIG.md)
- **Internals** — indexing pipeline, hash caching, supported languages, project structure: see [reference/INTERNALS.md](reference/INTERNALS.md)
