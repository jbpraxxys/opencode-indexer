---
name: codebase-search
description: Use when searching for code, understanding logic, locating files, or looking up how something works in the codebase. Also use when the project has a `.codebase-index` marker file, when you see codebase_index/codebase_search/codebase_status tools, or when you need to index, search, or check the status of semantic code search. Trigger for any code search demand — never use grep/glob/find first.
---

# Codebase Search

Semantic code search plugin for OpenCode. Indexes source code into a vector database using tree-sitter AST parsing. Search with natural language instead of regex.

## Search Priority Rule ⚠️

**This is the most important rule. Violating it wastes context and misses results.**

```
Search demand received (find code, locate logic, understand behavior)
    ↓
codebase_search(query)          ← ALWAYS first
    ↓
Results found? → YES → Done.
    ↓ NO
Rephrase query. Try again.
    ↓
Still no results?
    ↓
grep / glob / find              ← ONLY as last resort
```

1. **ALWAYS use `codebase_search` first** for every code search.
2. If no results, **rephrase your query** and try again before falling back.
3. Only after `codebase_search` fails with rephrased queries, use `grep`, `glob`, or `find`.
4. **Do not use both simultaneously** — try search first, fall back only if needed.

### Rationalization Table

| Excuse | Reality |
|--------|---------|
| "I know the exact function name, grep is faster" | `codebase_search` finds it AND shows related code grep misses |
| "This is just a quick lookup" | Quick lookups benefit most from semantic search |
| "I need ALL occurrences" | Valid fallback case — but try `codebase_search` first |
| "The codebase isn't indexed yet" | Auto-indexes on first tool use. Just call `codebase_search`. |
| "I'm not sure what to search for" | Semantic search handles vague queries better than grep |
| "Grep is more reliable" | Hash-cached index with file watching. Always fresh. |
| "Let me just grep first to see what's there" | This is the #1 violation. Use `codebase_search` first. |

### Red Flags — STOP and Use codebase_search

- About to type `grep` for a code question
- About to type `glob` to find files by function/class name
- Thinking "let me just grep first to see what's there"
- Not sure what to search for (semantic search handles vague queries)
- Question is about **behavior** ("how does X work?") not text matching

---

## Tools

Three tools are available when the project is opted in:

| Tool | Purpose | Key Args |
|------|---------|----------|
| `codebase_search` | Semantic search across indexed code | `query` (required), `maxResults` (optional) |
| `codebase_index` | Build/refresh the index | `force` (optional, re-index even if exists) |
| `codebase_status` | Check index state and project opt-in | none |

---

## How It Works

### Indexing Pipeline

1. **File Discovery** — glob scan with `.gitignore` + `.opencodeignore` support
2. **Tree-sitter AST Parsing** — extracts functions, classes, methods for TS/JS/Python/PHP; falls back to line-based chunking for other languages
3. **Hash Check** — `sha256(file)` compared to stored hash; skip unchanged files
4. **Embedding** — batches of 20 code blocks → embedding API (20K char truncation per block)
5. **Storage** — LanceDB (default, embedded) or Qdrant with metadata (path, lines, language, hash)

### Search Pipeline

1. **Query Embedding** — natural language → vector
2. **Cosine Similarity Search** — vector store returns closest matches
3. **Result Formatting** — file paths, line numbers, similarity scores, code previews

### Auto-Indexing

| Mechanism | What it does |
|-----------|-------------|
| **First use** | Auto-indexes when any tool is called in an opted-in project (once per session) |
| **File watcher (chokidar)** | Detects saves/edits → re-indexes only that file (600ms debounce) |
| **File deletion** | Removes orphaned blocks when files are deleted |
| **Branch polling** | Opt-in via `branchAware` config — polls `.git/HEAD` every N ms, re-indexes on branch switch |

### Hash Caching

On re-index, only changed files are processed. Unchanged files are free:

```
📖 Scanned 159/159 files — 157 unchanged, 2 updated
✅ All 157 files unchanged — index is up to date
```

Deleted files are detected and purged automatically. No stale blocks.

---

## Supported Languages

| Tree-sitter AST (semantic blocks) | Line-based (fallback) |
|-----------------------------------|----------------------|
| TypeScript (.ts, .tsx) | Ruby, Go, Rust, Java, Kotlin |
| JavaScript (.js, .jsx, .mjs, .cjs) | C, C++, Swift, Zig |
| Python (.py) | CSS, SCSS, HTML, Vue, Svelte |
| PHP (.php) | Markdown, JSON, YAML, TOML, Bash |

Vue SFC files (`.vue`) have their `<script>` block extracted and parsed with TS/JS tree-sitter.

---

## Setup and Configuration

### Opt In a Project

```bash
touch .codebase-index
```

The marker file at the project root enables indexing. All indexer data lives under `.codebase-index-store/`.

### Plugin Config (in opencode.json)

```json
"plugin": [["opencode-indexer", {
    "embedder": "ollama",
    "vectorStore": "lancedb"
}]]
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `embedder` | `"ollama"` | `"openai"` or `"ollama"` |
| `model` | `"nomic-embed-text"` | Embedding model name |
| `openaiBaseUrl` | `"https://api.openai.com"` | OpenAI-compatible endpoint |
| `openaiApiKey` | — | API key (required for openai) |
| `ollamaUrl` | `"http://localhost:11434"` | Ollama server address |
| `vectorStore` | `"lancedb"` | `"qdrant"` or `"lancedb"` |
| `qdrantUrl` | `"http://localhost:6333"` | Qdrant server |
| `qdrantApiKey` | — | API key for Qdrant Cloud |
| `batchSize` | `20` | Embedding batch size |
| `maxResults` | `20` | Max search results returned |
| `minScore` | `0.4` | Similarity threshold (0-1) |
| `maxFileSize` | `1000000` | Max file size in bytes (1MB) |
| `branchAware` | `false` | Auto re-index on git branch switch |
| `branchPollMs` | `3000` | Poll interval for branch changes (ms) |

### Embedding Providers

**Ollama** (default, local, free):
```bash
ollama pull nomic-embed-text
```

**OpenAI** (recommended for quality):
```json
{ "embedder": "openai", "openaiApiKey": "sk-...", "model": "text-embedding-3-small" }
```

### Vector Stores

**LanceDB** (default) — embedded, file-based, zero setup. Data lives in `.codebase-index-store/`.

**Qdrant** — external, for team deployments. Run locally or use Qdrant Cloud.

---

## Query Tips

**Describe behavior, not syntax:**
- Good: `"function that validates JWT tokens"`
- Good: `"how does the authentication middleware work"`
- Good: `"where is rate limiting configured"`
- Bad: `"validateToken"` (only use grep for exact identifiers, and only after search fails)

**Rephrase strategies when first query fails:**
- Broaden: `"authentication"` → `"user login session"`
- Narrow: `"API"` → `"REST endpoint handler middleware"`
- Change perspective: `"how is X done"` → `"where is X defined"` → `"what calls X"`

---

## Common Workflows

### First time in an opted-in project
Just call `codebase_search("your query")` — auto-indexing handles the rest.

### Re-index after large changes
`codebase_index(force=true)` — hash caching means only changed files are re-processed.

### Check if indexing is ready
`codebase_status` — shows opt-in status, block count, and storage backend.

### Find code
`codebase_search("natural language description")` — always the first step.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Not opted in" error | `touch .codebase-index` in project root |
| LanceDB issues | Delete `.codebase-index-store/` and re-index with `force=true` |
| Qdrant not available | `curl http://localhost:6333/healthz` |
| Embedding API error | Check API key and base URL |
| Plugin tools not showing | Restart OpenCode, check `opencode plugin list` |
| Stale index | `codebase_index(force=true)` |
| "Too many open files" (Qdrant macOS) | `ulimit -n 65536` before launching Qdrant |
| Switch between LanceDB and Qdrant | Change `vectorStore` in config, re-index with `force=true` |

---

## Project Structure

```
.opencode-index-store/      # All indexer data (LanceDB, progress, branch tracking)
.codebase-index             # Marker file — presence opts project into indexing
```

No server. No Docker. LanceDB is embedded. The file watcher keeps the index current as you edit.
