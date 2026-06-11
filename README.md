# OpenCode Indexer

<p align="center">
  <img src="banner.png" alt="OpenCode Indexer" width="600">
</p>

**Semantic code search for OpenCode** — a plugin that indexes your project's source code into a vector database and enables the AI agent to search it using natural language. Tree-sitter AST parsing produces clean semantic blocks (functions, classes, methods). Hash caching skips unchanged files on re-index — fast incremental updates.

Instead of grepping for exact keywords, ask "how does authentication work" and find relevant code across your entire project.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        OpenCode Agent                             │
│  "Find the auth logic" ──▶ codebase_search ──▶ Qdrant ──▶ results│
└──────────────────────────────────────────────────────────────────┘
         │                                        ▲
         │  tool calls                            │  vectors
         ▼                                        │
┌──────────────────────────────┐      ┌──────────────────────────────┐
│   Server Plugin               │      │   Vector Store                │
│   (src/index.ts)              │      │   Qdrant / LanceDB            │
│                               │      │                               │
│  ▪ codebase_index             │───embed──▶  │  idx_<sha256>       │
│  ▪ codebase_search            │      │  ▪ filePath                   │
│  ▪ codebase_status            │      │  ▪ content                    │
│  ▪ file watcher (chokidar)    │      │  ▪ startLine/endLine          │
│  ▪ branch polling (3s)        │      │  ▪ language                   │
│  ▪ system prompt              │      │  ▪ hash + fileHash            │
└──────────────────────────────┘      └──────────────────────────────┘
         │  parse + embed
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Indexing Engine (src/engine.ts)                │
│                                                                    │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────────┐   │
│  │ Tree-sitter    │   │ Hash Cache    │   │ Embedding API      │   │
│  │ AST Parser     │   │               │   │                    │   │
│  │                │   │ sha256(file)  │   │ OpenAI-compat      │   │
│  │ TS/JS/Py/PHP   │   │ = stored?     │   │ or Ollama          │   │
│  │ → functions    │   │ → skip!       │   │                    │   │
│  │ → classes      │   │ → changed?    │   │ batch of 20        │   │
│  │ → methods      │   │ → re-parse    │   │ 20K char trunc     │   │
│  └───────────────┘   └───────────────┘   └───────────────────┘   │
│                                                                    │
│  Progress: .codebase-index-progress.json (live during indexing)    │
└──────────────────────────────────────────────────────────────────┘
         │
         │  chokidar (600ms debounce)
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                       Your Project                                │
│                                                                   │
│   src/auth.ts    src/utils.ts    src/payments.ts   ...            │
│   .codebase-index   .codebase-index-branch   .gitignore           │
└──────────────────────────────────────────────────────────────────┘
```

**Flow:**

1. Agent calls `codebase_search("auth flow")`
2. Plugin auto-indexes if no index exists (first use)
3. Tree-sitter parses files into semantic blocks (functions, classes)
4. Hash cache checks each file — skips unchanged, re-parses changed
5. Embedding API converts blocks → vectors
6. Qdrant stores vectors with metadata
7. Query embedding → cosine similarity search → formatted results
8. File watcher detects edits → re-indexes only the changed file
9. **Branch polling detects `git checkout` → full re-index with hash caching (if `branchAware` enabled)**

---

## What's New

| Feature                          | Description                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| **Tree-sitter AST Parsing**      | Extracts functions, classes, and methods as semantic blocks for TS, JS, Python, and PHP |
| **Hash Caching**                 | SHA-256 per-file hashes — re-indexing only processes changed files                      |
| **Branch-Aware Indexing**        | Polls `.git/HEAD` every 3s — auto re-indexes on branch switch (opt-in)                  |
| **.gitignore + .opencodeignore** | Respects project-level ignore rules (layered: defaults → .gitignore → .opencodeignore)  |
| **Progress File**                | Real-time `.codebase-index-progress.json` during indexing (phase, percentage, counts)   |
| **Deleted File Detection**       | Automatically removes orphaned blocks when files are deleted                            |

---

## Prerequisites

### 1. Qdrant (Vector Database)

Download the latest Qdrant binary, extract, and run:

```bash
# Download and extract
curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-apple-darwin.tar.gz -o qdrant.tar.gz
tar xzf qdrant.tar.gz

# Run (starts on localhost:6333)
./qdrant
```

Verify: `curl http://localhost:6333/healthz`

### 2. Embedding API

**Option A: OpenAI-compatible** (recommended) — any endpoint with `/v1/embeddings`

**Option B: Ollama** (local, free) — `ollama pull nomic-embed-text`

---

## Installation

```bash
git clone https://github.com/jbpraxxys/opencode-indexer.git ~/opencode-indexer
cd ~/opencode-indexer
npm install
npm run build
```

Add to `~/.config/opencode/opencode.json`:

```json
"plugin": [
    ["~/opencode-indexer", {
        "embedder": "openai",
        "openaiBaseUrl": "https://your-embedding-proxy.example.com/code",
        "openaiApiKey": "sk-...",
        "model": "text-embedding-3-small",
        "vectorStore": "qdrant",
        "qdrantUrl": "http://localhost:6333",
        "branchAware": true
    }]
]
```

Opt a project in:

```bash
cd ~/Sites/your-project
touch .codebase-index
```

Restart OpenCode.

---

## Usage

### Inside OpenCode

Three tools available to the AI agent:

| Tool              | What it does                                           |
| ----------------- | ------------------------------------------------------ |
| `codebase_index`  | Index the project (tree-sitter parsing + hash caching) |
| `codebase_search` | Semantic search across indexed code                    |
| `codebase_status` | Check index stats                                      |

The agent follows a **Search Priority Rule**: always tries `codebase_search` first, falls back to grep/glob only if no results.

### Auto-Indexing (File Watcher + Branch Detection)

When OpenCode runs in an opted-in project, two mechanisms keep the index fresh:

**File Watcher (chokidar):**

| Action            | Result                                     |
| ----------------- | ------------------------------------------ |
| Save/edit a file  | Re-indexes only that file (600ms debounce) |
| Create a new file | Indexes immediately                        |
| Delete a file     | Removes its blocks from the store          |

**Branch Detection (opt-in via `branchAware`):**

Reads `.git/HEAD` directly (no subprocess) — poll interval configurable via `branchPollMs`.

| Action            | Result                                                       |
| ----------------- | ------------------------------------------------------------ |
| Switch branches   | Full re-index (hash cache — unchanged = free)                |
| Detached HEAD     | Polling suspends until back on a named branch                |
| Change detected   | Logs `🔄 Branch changed: X → Y` to console                   |
| Re-index complete | Logs `✅ Re-indexed for branch X (N files → M blocks)`       |
| Poll failure      | Logs error to console, retries next interval                 |

No full re-index. No API waste. Just the delta.

### CLI Tool

```bash
node cli.mjs index ~/Sites/my-project    # Full index
node cli.mjs search ~/Sites/my-project "auth flow"  # Search
node cli.mjs status ~/Sites/my-project   # Stats
node cli.mjs clear ~/Sites/my-project    # Delete index
```

---

## How It Works

### Indexing Pipeline

1. **File Discovery** — glob scan with `.gitignore` + `.opencodeignore` support
2. **Tree-sitter AST Parsing** — extracts functions, classes, methods for TS/JS/Python/PHP; falls back to line-based chunking for other languages
3. **Hash Check** — if `sha256(file)` matches stored hash, skip (unchanged)
4. **Embedding** — batches of 20 code blocks → embedding API (20K char truncation for token limits)
5. **Storage** — Qdrant with metadata (file path, line numbers, language, file hash)

### Search Pipeline

1. **Query Embedding** — natural language → vector
2. **Cosine Similarity Search** — Qdrant returns closest matches
3. **Result Formatting** — file paths, line numbers, similarity scores, code previews

### Hash Caching

On re-index, only changed files are processed:

```
📖 Scanned 159/159 files — 157 unchanged, 2 updated
✅ All 157 files unchanged — index is up to date
```

Deleted files are detected and purged automatically. No stale blocks.

---

## Configuration

| Option          | Default                    | Description                        |
| --------------- | -------------------------- | ---------------------------------- |
| `embedder`      | `"ollama"`                 | `"openai"` or `"ollama"`           |
| `model`         | `"nomic-embed-text"`       | Embedding model                    |
| `openaiBaseUrl` | `"https://api.openai.com"` | OpenAI-compatible endpoint         |
| `openaiApiKey`  | —                          | API key (required for openai)      |
| `ollamaUrl`     | `"http://localhost:11434"` | Ollama server                      |
| `vectorStore`   | `"lancedb"`                | `"qdrant"` or `"lancedb"`          |
| `qdrantUrl`     | `"http://localhost:6333"`  | Qdrant server                      |
| `qdrantApiKey`  | —                          | API key for Qdrant Cloud           |
| `batchSize`     | `20`                       | Embedding batch size               |
| `maxResults`    | `20`                       | Max search results                 |
| `minScore`      | `0.4`                      | Similarity threshold               |
| `maxFileSize`   | `1000000`                  | Max file size in bytes (1MB)       |
| `branchAware`   | `false`                    | Auto re-index on git branch switch |
| `branchPollMs`  | `3000`                     | Poll interval for branch change detection (ms) |

---

## Supported Languages

| Tree-sitter AST (semantic blocks)  | Line-based (fallback)            |
| ---------------------------------- | -------------------------------- |
| TypeScript (.ts, .tsx)             | Ruby, Go, Rust, Java, Kotlin     |
| JavaScript (.js, .jsx, .mjs, .cjs) | C, C++, Swift, Zig               |
| Python (.py)                       | CSS, SCSS, HTML, Vue, Svelte     |
| PHP (.php)                         | Markdown, JSON, YAML, TOML, Bash |

---

## Project Isolation

Each project gets its own Qdrant collection (`idx_<sha256>`). Indexes never mix between projects.

---

## File Structure

```
~/opencode-indexer/
├── cli.mjs              # CLI (index, search, status, clear)
├── dist/
│   ├── engine.js        # Core: parser, embedder, vector store, hash cache
│   ├── index.js         # Server plugin: 3 tools + watcher + system prompt
│   └── tui.js           # TUI plugin: presence marker
├── src/
│   ├── engine.ts        # Tree-sitter, hash caching, progress, Qdrant/LanceDB
│   ├── index.ts         # Plugin entry: tools, chokidar watcher, priority rule
│   └── tui.ts           # TUI entry (kv presence flag)
├── banner.png           # Project banner
├── package.json
└── tsconfig.json
```

---

## Troubleshooting

**Qdrant not available:** `curl http://localhost:6333/healthz`

**Embedding API error:** Check API key and base URL. Blocks truncated to 20K chars to stay within token limits.

**Plugin not showing tools:** Restart OpenCode. Check `opencode plugin list`.

**Too many blocks (noise):** The glob ignore fix ensures `node_modules`, `vendor`, etc. are excluded. If you have a stale index from before the fix, run `codebase_index(force=true)`.

**Re-index a project:** `codebase_index(force=true)` in OpenCode, or `node cli.mjs index .` from CLI.

### "Too many open files" in Qdrant (macOS binary)

Running Qdrant directly on macOS may hit the file descriptor limit:

```
Os { code: 24, kind: Uncategorized, message: "Too many open files" }
```

**Check current limits:**

```bash
ulimit -n
launchctl limit maxfiles
```

**Permanent fix (requires reboot):**

```bash
sudo launchctl config system maxfiles 65536 200000
sudo launchctl config user   maxfiles 65536 200000
```

**Shell default (zsh):** Add to `~/.zshrc`:

```bash
ulimit -n 65536
```

**Quick test (session only):**

```bash
ulimit -n 65536
./qdrant
```

After reboot, confirm with `ulimit -n` before launching Qdrant.
