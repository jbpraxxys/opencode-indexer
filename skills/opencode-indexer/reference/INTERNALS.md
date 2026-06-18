# Internals

## Indexing Pipeline

1. **File Discovery** — glob scan with `.gitignore` + `.opencodeignore` support
2. **Tree-sitter AST Parsing** — extracts functions, classes, methods for TS/JS/Python/PHP; falls back to line-based chunking for other languages
3. **Hash Check** — `sha256(file)` compared to stored hash; skip unchanged files
4. **Embedding** — batches of 20 code blocks → embedding API (20K char truncation per block)
5. **Storage** — LanceDB (default, embedded) or Qdrant with metadata (path, lines, language, hash)

## Search Pipeline

1. **Query Embedding** — natural language → vector
2. **Cosine Similarity Search** — vector store returns closest matches
3. **Result Formatting** — file paths, line numbers, similarity scores, code previews

## Auto-Indexing

| Mechanism | What it does |
|-----------|-------------|
| **First use** | Auto-indexes when any tool is called in an opted-in project (once per session) |
| **File watcher (chokidar)** | Detects saves/edits → re-indexes only that file (600ms debounce) |
| **File deletion** | Removes orphaned blocks when files are deleted |
| **Branch polling** | Opt-in via `branchAware` config — polls `.git/HEAD` every N ms, re-indexes on branch switch |

## Hash Caching

On re-index, only changed files are processed. Unchanged files are free:

```
📖 Scanned 159/159 files — 157 unchanged, 2 updated
✅ All 157 files unchanged — index is up to date
```

Deleted files are detected and purged automatically. No stale blocks.

## Supported Languages

| Tree-sitter AST (semantic blocks) | Line-based (fallback) |
|-----------------------------------|----------------------|
| TypeScript (.ts, .tsx) | Ruby, Go, Rust, Java, Kotlin |
| JavaScript (.js, .jsx, .mjs, .cjs) | C, C++, Swift, Zig |
| Python (.py) | CSS, SCSS, HTML, Vue, Svelte |
| PHP (.php) | Markdown, JSON, YAML, TOML, Bash |

Vue SFC files (`.vue`) have their `<script>` block extracted and parsed with TS/JS tree-sitter.

## Project Structure

```
.codebase-index-store/      # All indexer data (LanceDB, progress, branch tracking)
.codebase-index             # Marker file — presence opts project into indexing
```

LanceDB is embedded — no server, no Docker. The file watcher keeps the index current as you edit.
