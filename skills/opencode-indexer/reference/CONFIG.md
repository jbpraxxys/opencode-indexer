# Configuration

## Quick Start

Opt in a project:

```bash
touch .codebase-index
```

The marker file at the project root enables indexing. All indexer data lives under `.codebase-index-store/`.

Plugin config in `opencode.json`:

```json
"plugin": [["opencode-indexer", {
    "embedder": "ollama",
    "vectorStore": "lancedb"
}]]
```

## Configuration Options

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

## Embedding Providers

**Ollama** (default, local, free):

```bash
ollama pull nomic-embed-text
```

**OpenAI** (recommended for quality):

```json
{ "embedder": "openai", "openaiApiKey": "sk-...", "model": "text-embedding-3-small" }
```

## Vector Stores

**LanceDB** (default) — embedded, file-based, zero setup. Data in `.codebase-index-store/`.

**Qdrant** — external, for team deployments. Run locally or use Qdrant Cloud.
