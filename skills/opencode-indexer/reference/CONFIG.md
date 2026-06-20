# Configuration

## Quick Start

Opt in a project:

```bash
touch .codebase-index
```

The marker file at the project root enables indexing. All indexer data lives under `.codebase-index-store/`. Alternatively, set `autoIndex: true` in the plugin config to index every project without a marker file.

### Plugin Loading

OpenCode loads plugins from `~/.config/opencode/plugins/`. Create a shim file that imports the built plugin with your config:

**`~/.config/opencode/plugins/opencode-indexer.js`**

```js
import { server } from "~/opencode-indexer/dist/index.js";
export { server };
```

Config can be passed inline in the shim or set via environment variables (see below).

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `embedder` | `"openai"` | `"openai"` or `"ollama"` |
| `model` | `"text-embedding-3-small"` | Embedding model name |
| `openaiBaseUrl` | `"https://api.openai.com/v1"` | OpenAI-compatible endpoint |
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
| `autoIndex` | `false` | Index every project without `.codebase-index` marker |

## Embedding Providers

**Ollama** (local, free):

```bash
ollama pull nomic-embed-text
```

Then set `"embedder": "ollama"`, `"model": "nomic-embed-text"`.

**OpenAI** (default, recommended for quality):

```json
{ "embedder": "openai", "openaiApiKey": "sk-...", "model": "text-embedding-3-small" }
```

## Vector Stores

**LanceDB** (default) — embedded, file-based, zero setup. Data in `.codebase-index-store/`.

**Qdrant** — external, for team deployments. Run locally or use Qdrant Cloud.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_INDEXER_EMBEDDER` | `"openai"` | `"openai"` or `"ollama"` |
| `OPENCODE_INDEXER_API_KEY` | — | API key (required for openai) |
| `OPENCODE_INDEXER_BASE_URL` | `"https://api.openai.com/v1"` | OpenAI-compatible endpoint |
| `OPENCODE_INDEXER_MODEL` | `"text-embedding-3-small"` | Embedding model |
| `OPENCODE_INDEXER_VECTOR_STORE` | `"lancedb"` | `"qdrant"` or `"lancedb"` |
