# Codebase Indexer

**Semantic code search for OpenCode** — a plugin that indexes your project's source code into a vector database (Qdrant) and enables the AI agent to search it using natural language queries. Includes automatic file watching so the index stays fresh as you edit.

Instead of grepping for exact keywords, the agent can ask "how does authentication work" and find relevant code across your entire project.

---

## Architecture

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Your Codebase   │───▶│  Embedding API   │───▶│  Qdrant          │
│  (files)         │    │  (OpenAI-compat  │    │  Vector DB       │
│                  │    │   or Ollama)     │    │  (localhost:6333)│
└──────────────────┘    └──────────────────┘    └──────────────────┘
         │                                              ▲
         ▼                                              │
┌──────────────────┐                          ┌──────────────────┐
│  OpenCode Plugin │                          │  File Watcher    │
│  (3 agent tools) │                          │  (auto-updates)  │
└──────────────────┘                          └──────────────────┘
```

**Three components:**

| Component        | What it does                                    | Options                                     |
| ---------------- | ----------------------------------------------- | ------------------------------------------- |
| **Embedder**     | Converts code blocks into vector embeddings     | OpenAI-compatible API or Ollama (local)     |
| **Vector Store** | Stores embeddings for fast similarity search    | Qdrant or LanceDB                           |
| **Plugin**       | 3 tools inside OpenCode + auto file watching    | OpenCode plugin at `~/opencode-indexer`     |

---

## Prerequisites

### 1. Qdrant (Vector Database)

Qdrant stores code embeddings and performs similarity searches. It runs as a server on `localhost:6333`.

**Option A: Docker (Recommended)**

```bash
docker run -d --name qdrant \
  -p 6333:6333 \
  -p 6334:6334 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

**Option B: Homebrew (macOS)**

```bash
brew install qdrant
qdrant
```

**Verify:**

```bash
curl http://localhost:6333/healthz
# → healthz check passed
```

### 2. Embedding API (Choose One)

**Option A: OpenAI-compatible API (Recommended for teams)**
An API endpoint that accepts OpenAI-format embedding requests. Configured via API key + base URL.

**Option B: Ollama (100% local, free)**

```bash
# Install Ollama
brew install ollama

# Start the server
ollama serve

# Pull an embedding model
ollama pull nomic-embed-text    # ~274MB, good balance
ollama pull mxbai-embed-large   # Higher quality, larger
```

---

## Installation

### 1. Install the Indexer

```bash
git clone <your-repo-url> ~/opencode-indexer
cd ~/opencode-indexer
npm install
npm run build
```

### 2. Install the OpenCode Plugin (Global)

Open `~/.config/opencode/opencode.json` and add to the `"plugin"` array:

```json
"plugin": [
    ["/path/to/opencode-indexer", {
        "embedder": "openai",
        "openaiBaseUrl": "https://your-embedding-proxy.example.com/code",
        "openaiApiKey": "sk-...",
        "model": "text-embedding-3-small",
        "vectorStore": "qdrant",
        "qdrantUrl": "http://localhost:6333"
    }]
]
```

### 3. Opt a Project In

```bash
cd ~/Sites/your-project
touch .codebase-index
```

The `.codebase-index` marker file tells the plugin to index this project and enables the file watcher.

---

## Configuration

### Plugin Options

All options go into the plugin config array in `opencode.json`:

| Option          | Default                    | Description                                |
| --------------- | -------------------------- | ------------------------------------------ |
| `embedder`      | `"ollama"`                 | `"openai"` or `"ollama"`                   |
| `model`         | `"nomic-embed-text"`       | Embedding model name                       |
| `openaiBaseUrl` | `"https://api.openai.com"` | OpenAI-compatible endpoint                 |
| `openaiApiKey`  | —                          | API key (required for `"openai"` embedder) |
| `ollamaUrl`     | `"http://localhost:11434"` | Ollama server URL                          |
| `vectorStore`   | `"lancedb"`                | `"qdrant"` or `"lancedb"`                  |
| `qdrantUrl`     | `"http://localhost:6333"`  | Qdrant server URL                          |
| `qdrantApiKey`  | —                          | Qdrant API key (optional)                  |
| `batchSize`     | `20`                       | Embedding batch size                       |
| `maxResults`    | `20`                       | Max search results per query               |
| `minScore`      | `0.4`                      | Minimum similarity threshold               |

---

## Usage

### Inside OpenCode

Once the plugin is installed, the following tools are available to the AI agent:

| Tool              | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `codebase_index`  | Index the workspace (run once per project)      |
| `codebase_search` | Search indexed code using natural language      |
| `codebase_status` | Check if an index exists and its stats          |

**The agent follows a Search Priority Rule:** always tries `codebase_search` first before falling back to grep/glob/find. Only falls back if the index has no results.

Ask the AI naturally:

> _"Search for how authentication works in this project"_
> _"Find where the database migrations are"_
> _"How does the login flow work?"_
> _"Index this project so you can search it"_

### File Watcher (Auto-Indexing)

When OpenCode is running in an opted-in project (has `.codebase-index`), the plugin starts a file watcher:

| You do this           | Watcher does                                  |
| --------------------- | --------------------------------------------- |
| Save a `.ts` file     | Re-indexes that file only (old blocks removed) |
| Create a new `.vue`   | Indexes the new file immediately              |
| Delete a file         | Removes its blocks from Qdrant                |

Changes are debounced (600ms) so rapid saves don't trigger multiple re-indexes. The watcher only covers opted-in projects and respects the same ignore patterns (node_modules, vendor, dist, etc.).

### CLI Tool

The project also includes a standalone CLI for scripting or CI:

```bash
# Index a project
node cli.mjs index ~/Sites/my-project

# Search indexed code
node cli.mjs search ~/Sites/my-project "how does authentication work"

# Check index status
node cli.mjs status ~/Sites/my-project

# Delete an index for a project
node cli.mjs clear ~/Sites/my-project
```

The CLI reads config from `~/.config/opencode/opencode.json` or from environment variables.

---

## How It Works

### Indexing Pipeline

1. **File Discovery** — Scans the project directory using glob, ignoring `node_modules`, `.git`, `dist`, `vendor`, etc.
2. **Code Parsing** — Splits source files into code blocks (min 100 chars, max 1000 chars per block)
3. **Embedding** — Sends code blocks in batches to the embedding API with 20K char truncation to stay within token limits
4. **Storage** — Stores vectors in Qdrant with metadata (file path, line numbers, language)

### Search Pipeline

1. **Query Embedding** — Converts the user's natural language query into a vector
2. **Vector Search** — Finds the most similar code blocks using cosine similarity
3. **Result Formatting** — Returns matching code blocks with file paths, line numbers, and similarity scores

### Incremental Updates

Instead of full re-indexing on every change, the file watcher uses:

- `indexFile(filePath)` — parse single file → embed → delete old blocks → insert new ones
- `deleteFile(filePath)` — remove all blocks for a deleted file from Qdrant

### What Gets Indexed

| Included                          | Excluded                          |
| --------------------------------- | --------------------------------- |
| `.ts`, `.tsx`, `.js`, `.jsx`      | `node_modules/`                   |
| `.mjs`, `.cjs`                    | `.git/`                           |
| `.py`, `.rb`, `.go`, `.rs`        | `dist/`, `build/`                 |
| `.php`, `.java`, `.kt`, `.swift`  | `.next/`, `vendor/`               |
| `.css`, `.scss`, `.html`, `.vue`  | `__pycache__/`, `.venv/`          |
| `.svelte`                         | `target/`                         |
| `.md`, `.json`, `.yaml`, `.toml`  | `*.min.js`, `*.min.css`           |
| `.sh`, `.bash`, `.zig`            | `*.map`                           |
| `.c`, `.cpp`, `.h`, `.hpp`        | `package-lock.json`, `yarn.lock`  |
|                                   | `pnpm-lock.yaml`                  |

---

## Project Isolation

Each project gets its own Qdrant collection named `idx_<hash>` (based on the project path's SHA-256). This ensures:

- Indexes don't mix between projects
- You can delete or re-index one project without affecting others
- Multiple team members can index the same project independently

---

## Search Priority Rule

The plugin injects a system prompt that instructs the AI:

> **Search Priority Rule** — When asked to find code, understand logic, or locate files — always try `codebase_search` first before using grep, glob, find, or reading files directly. `codebase_search` is faster, understands semantics, and finds cross-file patterns.
>
> Only fall back to grep/glob/find if `codebase_search` returns no results or fails.

---

## Troubleshooting

### "Qdrant not available"

```bash
# Check if Qdrant is running
curl http://localhost:6333/healthz

# Start Qdrant
docker start qdrant
# or
brew services start qdrant
```

### "Embedding API error"

- Verify your API key is correct in `~/.config/opencode/opencode.json`
- Check that the base URL is reachable
- The engine truncates code blocks to 20K chars to stay within token limits

### Plugin not showing tools in OpenCode

```bash
# Verify the plugin is installed
opencode plugin list

# Check the global config
cat ~/.config/opencode/opencode.json | grep opencode-indexer
```

### Re-indexing a project

Inside OpenCode, use `codebase_index` with `force=true`:

> _"Run codebase_index with force=true to re-index"_

Or from CLI:

```bash
node ~/opencode-indexer/cli.mjs index ~/Sites/my-project
```

---

## File Structure

```
~/opencode-indexer/
├── cli.mjs           # CLI entry point (node cli.mjs index/search/status/clear)
├── dist/
│   ├── engine.js     # Core indexing engine (compiled)
│   └── index.js      # OpenCode plugin (compiled)
├── src/
│   ├── engine.ts     # Core: parse, embed, vector store, search, indexFile, deleteFile
│   └── index.ts      # Plugin: 3 tools + file watcher + system prompt hook
├── node_modules/
│   └── chokidar      # File watcher (auto-indexing)
├── package.json
└── tsconfig.json
```
