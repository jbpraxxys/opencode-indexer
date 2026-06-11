/**
 * OpenCode Plugin — Codebase Indexing
 *
 * Tools:
 *   codebase_index   — Scan & embed workspace into vector store
 *   codebase_search  — Semantic search across indexed code
 *   codebase_status  — Check index stats
 *
 * Auto-indexing: Projects with a `.codebase-index` marker file in their root
 * are opted in. The plugin auto-indexes on first tool use and keeps the index
 * up to date. No marker file = no indexing.
 *
 * To opt in:
 *   touch ~/Sites/my-project/.codebase-index
 *
 * Config in opencode.json:
 *   {
 *     "plugin": [["opencode-indexer", {
 *       "vectorStore": "qdrant",
 *       "qdrantUrl": "http://localhost:6333"
 *     }]]
 *   }
 */

import { tool } from "@opencode-ai/plugin/tool"
import type { PluginOptions, PluginInput } from "@opencode-ai/plugin"
import { existsSync } from "fs"
import { join, relative, extname } from "path"
import { CodebaseIndexer, loadProjectIgnore, type IndexerConfig, getCurrentBranch, getStoredBranch, setStoredBranch } from "./engine.js"
import chokidar from "chokidar"

const z = tool.schema

// Track per-directory auto-index attempts so we only try once per session
const autoIndexed = new Set<string>()

const MARKER_FILE = ".codebase-index"

function hasMarker(directory: string): boolean {
  return existsSync(join(directory, MARKER_FILE))
}

// Module-level cache: workspacePath → CodebaseIndexer instance
const indexers = new Map<string, CodebaseIndexer>()

function getIndexer(directory: string, config: IndexerConfig = {}): CodebaseIndexer {
  if (indexers.has(directory)) return indexers.get(directory)!
  const indexer = new CodebaseIndexer(directory, config)
  indexers.set(directory, indexer)
  return indexer
}

/**
 * If the project has a .codebase-index marker and no index exists yet,
 * automatically build one. Returns true if index was created or already exists.
 */
async function ensureIndexed(
  directory: string,
  indexer: CodebaseIndexer,
  config: IndexerConfig,
): Promise<string | null> {
  if (!hasMarker(directory)) return null

  const autoKey = `${directory}`
  try {
    const embedderOk = config.embedder === "openai"
      || config.embedder === "ollama"
      || true // default is ollama

    if (embedderOk) {
      await indexer.ensureReady()
      await indexer.init()
    }

    // Check if index already exists
    const stats = await indexer.stats()
    if (stats.blocks > 0) {
      return null // Already indexed
    }

    // Auto-index on first use, but only once per session
    if (autoIndexed.has(autoKey)) return null
    autoIndexed.add(autoKey)

    const { files, blocks } = await indexer.index(directory)
    return `✅ Auto-indexed ${files} files → ${blocks} code blocks`
  } catch (err: any) {
    return `⚠ Auto-index failed: ${err.message}`
  }
}

// ─── Tool 1: Index ────────────────────────────────────────

function makeCodebaseIndex(pluginConfig: IndexerConfig) {
  return tool({
    description:
      "Index the workspace codebase for semantic code search. " +
      "Uses tree-sitter AST parsing for Python, TypeScript, JavaScript, and PHP " +
      "to extract functions, classes, and methods as semantic blocks. " +
      "Falls back to line-based chunking for other languages. " +
      "Hash caching skips unchanged files on re-index — fast incremental updates. " +
      "Run this once before searching. Re-run when code changes. " +
      "Requires a .codebase-index marker file in the project root to proceed.",
    args: {
      force: z.boolean().describe("Force re-index even if index exists"),
    },
    async execute(args, ctx) {
      // Require opt-in marker
      if (!hasMarker(ctx.directory)) {
        return {
          output:
            "❌ This project is not opted into codebase indexing.\n\n" +
            "Create a `.codebase-index` file in the project root to opt in:\n" +
            "  touch " + join(ctx.directory, ".codebase-index") + "\n\n" +
            "Then run codebase_index again.",
        }
      }

      const indexer = getIndexer(ctx.directory, pluginConfig)

      try {
        await indexer.ensureReady()
      } catch (err: any) {
        return {
          output: `❌ Embedding service not available: ${err.message}\n` +
            "Make sure Ollama is running or your OpenAI-compatible endpoint is reachable.",
        }
      }

      await indexer.init()

      if (!args.force) {
        const stats = await indexer.stats()
        if (stats.blocks > 0) {
          return {
            output: `✅ Index exists with ${stats.blocks} blocks.\n` +
              `Storage: ${stats.dbPath}\n` +
              "Use force=true to re-index.",
          }
        }
      }

      const { files, blocks } = await indexer.index(ctx.directory, (msg) => {
        // Show only phase-change messages during indexing
        if (msg.startsWith("🔍") || msg.startsWith("⚡") || msg.startsWith("💾") || msg.startsWith("✅ Done")) {
          console.log(msg)
        }
      })

      return {
        output: `✅ Indexed ${files} files → ${blocks} code blocks.\n` +
          'Search with: codebase_search "your query"',
      }
    },
  })
}

// ─── Tool 2: Search ───────────────────────────────────────

function makeCodebaseSearch(pluginConfig: IndexerConfig) {
  return tool({
    description:
      "Search the indexed codebase using natural language. " +
      "Returns the most relevant code blocks with file paths, line numbers, and similarity scores. " +
      "Use this to find code before reading files — it's faster and finds cross-file patterns. " +
      "Requires a .codebase-index marker file in the project root.",
    args: {
      query: z.string().describe("What code you're looking for"),
      maxResults: z.number().optional().describe("Max results (default 20)"),
    },
    async execute(args, ctx) {
      // Require opt-in marker
      if (!hasMarker(ctx.directory)) {
        return {
          output:
            "❌ This project is not opted into codebase indexing.\n\n" +
            "Create a `.codebase-index` file in the project root to opt in:\n" +
            "  touch " + join(ctx.directory, ".codebase-index") + "\n\n" +
            "Then run codebase_index first, then search.",
        }
      }

      const config = { ...pluginConfig, maxResults: args.maxResults }
      const indexer = getIndexer(ctx.directory, config)

      try {
        await indexer.ensureReady()
      } catch (err: any) {
        return { output: `❌ Embedding service not available: ${err.message}` }
      }

      await indexer.init()

      // Auto-index if needed (first tool use in an opted-in project)
      const autoMsg = await ensureIndexed(ctx.directory, indexer, config)
      if (autoMsg) {
        // Index was just built — search immediately
        const results = await indexer.search(args.query)
        if (results.length === 0) {
          return { output: `${autoMsg}\n\nNo results for "${args.query}". Try different wording.` }
        }
        return {
          output: `${autoMsg}\n\n${formatResults(results)}`,
          metadata: { resultCount: results.length, query: args.query },
        }
      }

      const stats = await indexer.stats()
      if (stats.blocks === 0) {
        return {
          output: "📭 No index found. Run codebase_index to create one.\n\n" +
            "(This project has a .codebase-index marker, so auto-indexing was attempted but failed.)",
        }
      }

      const results = await indexer.search(args.query)

      if (results.length === 0) {
        return { output: `No results for "${args.query}". Try different wording.` }
      }

      return {
        output: formatResults(results),
        metadata: { resultCount: results.length, query: args.query, totalIndexed: stats.blocks },
      }
    },
  })
}

// ─── Tool 3: Status ───────────────────────────────────────

function makeCodebaseStatus(pluginConfig: IndexerConfig) {
  return tool({
    description:
      "Check codebase index status — exists, block count, storage backend. " +
      "Also shows whether this project is opted into indexing (via .codebase-index marker).",
    args: {},
    async execute(_args, ctx) {
      const marker = hasMarker(ctx.directory)
      const markerStatus = marker
        ? "✅ Opted in (.codebase-index found)"
        : "❌ Not opted in (no .codebase-index)"

      // Auto-index if marker exists and no index
      if (marker) {
        const indexer = getIndexer(ctx.directory, pluginConfig)
        try {
          const autoMsg = await ensureIndexed(ctx.directory, indexer, pluginConfig)
          if (autoMsg) {
            const stats = await indexer.stats()
            return {
              output: `${markerStatus}\n${autoMsg}\n\n` +
                `Blocks: ${stats.blocks}\nStorage: ${stats.dbPath}`,
            }
          }

          await indexer.init()
          const stats = await indexer.stats()
          if (stats.blocks === 0) {
            return {
              output: `${markerStatus}\n📭 No index yet. Run codebase_index to create one.`,
            }
          }
          return {
            output:
              `${markerStatus}\n\n` +
              `📊 Codebase Index\n` +
              `  Blocks: ${stats.blocks}\n` +
              `  Storage: ${stats.dbPath}`,
          }
        } catch {
          return {
            output: `${markerStatus}\n📭 No index. Run codebase_index to create one.`,
          }
        }
      }

      return {
        output: `${markerStatus}\n\nTo opt in:\n  touch ${join(ctx.directory, ".codebase-index")}`,
      }
    },
  })
}

// ─── Formatting ────────────────────────────────────────────

function formatResults(results: any[]): string {
  return results
    .map((r, i) => {
      const preview = r.content.length > 400 ? r.content.slice(0, 400) + "..." : r.content
      return [
        `### ${i + 1}. ${r.relativePath}:${r.startLine}-${r.endLine}`,
        `Score: ${r.score.toFixed(3)} | Language: ${r.language}`,
        "```" + r.language,
        preview,
        "```",
      ].join("\n")
    })
    .join("\n\n")
}

// ─── Watchable extensions (matches engine.ts EXTENSIONS) ────

const WATCH_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp", ".css", ".scss",
  ".html", ".vue", ".svelte", ".md", ".json",
  ".yaml", ".yml", ".toml", ".sh", ".bash",
  ".php", ".swift", ".zig",
])

// ─── Plugin Server ────────────────────────────────────────

export const server = async (input: PluginInput, options: PluginOptions) => {
  const pluginConfig = (options ?? {}) as IndexerConfig
  let watcher: import("chokidar").FSWatcher | null = null
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const DEBOUNCE_MS = 600

  // Track whether the indexer has been initialized for watching
  let watchInitialized = false
  async function ensureWatchReady(directory: string): Promise<CodebaseIndexer | null> {
    if (!hasMarker(directory)) return null
    try {
      const idx = getIndexer(directory, pluginConfig)
      if (!watchInitialized) {
        await idx.ensureReady()
        await idx.init()
        watchInitialized = true
      }
      return idx
    } catch {
      return null
    }
  }

  // Start file watcher if the project is opted in
  const projectDir = input.directory
  if (projectDir && hasMarker(projectDir)) {
    const projectIgnore = loadProjectIgnore(projectDir)
    watcher = chokidar.watch(projectDir, {
      ignored: (path: string) => {
        if (!WATCH_EXTENSIONS.has(extname(path))) return true
        const rel = relative(projectDir, path)
        return projectIgnore.ignores(rel)
      },
      persistent: true,
      ignoreInitial: true,
      depth: 20,
    })

    watcher.on("all", (event: string, filePath: string) => {
      // Only care about add/change/unlink for files
      if (event === "addDir" || event === "unlinkDir") return

      // Debounce
      const existing = debounceTimers.get(filePath)
      if (existing) clearTimeout(existing)

      debounceTimers.set(filePath, setTimeout(async () => {
        debounceTimers.delete(filePath)
        const relPath = relative(projectDir, filePath)

        if (event === "unlink") {
          const idx = getIndexer(projectDir, pluginConfig)
          try {
            await idx.deleteFile(filePath)
          } catch { /* indexer not ready */ }
          return
        }

        // add / change — re-index the file
        const idx = await ensureWatchReady(projectDir)
        if (!idx) return

        try {
          const result = await idx.indexFile(filePath)
        } catch (err: any) {
        }
      }, DEBOUNCE_MS))
    })

    // Watcher started silently (no console.log — output goes to TUI textarea)
  }

  // ─── Branch polling (opt-in via branchAware config) ──────
  let branchInterval: ReturnType<typeof setInterval> | null = null
  if (projectDir && hasMarker(projectDir) && pluginConfig.branchAware) {
    let lastBranch = getCurrentBranch(projectDir)
    const pollMs = pluginConfig.branchPollMs ?? 3000

    branchInterval = setInterval(async () => {
      try {
        const current = getCurrentBranch(projectDir)
        if (!current || current === lastBranch) return

        // Branch change detected — full re-index with hash caching
        console.log(`🔄 Branch changed: ${String(lastBranch)} → ${current} — re-indexing...`)
        const idx = getIndexer(projectDir, pluginConfig)
        await idx.ensureReady()
        await idx.init()

        // Store the new branch BEFORE indexing so the marker is correct
        // even if indexing fails partway through (next run fixes it)
        lastBranch = current

        const result = await idx.index(projectDir)
        console.log(`✅ Re-indexed for branch ${current} (${result.files} files → ${result.blocks} blocks)`)
      } catch (err: any) {
        console.error(`⚠ Branch poll error:`, err.message ?? err)
      }
    }, pollMs)
  }

  return {
    tool: {
      codebase_index: makeCodebaseIndex(pluginConfig),
      codebase_search: makeCodebaseSearch(pluginConfig),
      codebase_status: makeCodebaseStatus(pluginConfig),
    },
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      const backend = pluginConfig.vectorStore ?? "qdrant"
      output.system.push(
        "## Codebase Indexing\n" +
        "You have access to codebase indexing tools for semantic code search:\n\n" +
        `- **codebase_index** — Build/refresh the codebase index (storage: ${backend}).\n` +
        "  Uses tree-sitter AST parsing (TS, JS, Python, PHP) for semantic blocks. Hash caching skips unchanged files.\n" +
        "  Requires `.codebase-index` marker file in the project root (auto-index on first use).\n" +
        "- **codebase_search** — Natural language search across indexed code.\n" +
        "- **codebase_status** — Check if indexing is set up.\n\n" +
        "### Search Priority Rule\n" +
        "When asked to find code, understand logic, or locate files — **always try `codebase_search` first** " +
        "before using grep, glob, find, or reading files directly. " +
        "`codebase_search` is faster, understands semantics, and finds cross-file patterns.\n\n" +
        "**Only fall back to grep/glob/find if `codebase_search` returns no results or fails.**\n" +
        "Do not use both — try search first, then fall back if needed.\n\n" +
        "For projects with a `.codebase-index` file, indexing happens automatically on first tool use. " +
        "The file watcher keeps the index fresh as you edit code. " +
        "Re-indexing is fast — hash caching only reprocesses changed files. " +
        (pluginConfig.branchAware
          ? "**Branch-aware indexing is enabled** — the index auto-updates when you switch git branches. "
          : "")
      )
    },
    dispose: async () => {
      if (watcher) {
        await watcher.close()
        console.log("File watcher stopped")
      }
      if (branchInterval) {
        clearInterval(branchInterval)
        branchInterval = null
      }
      // Clear all debounce timers
      for (const timer of Array.from(debounceTimers.values())) {
        clearTimeout(timer)
      }
      debounceTimers.clear()
    },
  }
}
