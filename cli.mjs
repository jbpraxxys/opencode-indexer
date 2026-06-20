#!/usr/bin/env node
/**
 * Codebase Indexer CLI
 *
 * Usage:
 *   node cli.mjs index    /path/to/project               # Index a project
 *   node cli.mjs search   /path/to/project  "query"      # Search an indexed project
 *   node cli.mjs status   /path/to/project               # Check index status
 *   node cli.mjs clear    /path/to/project               # Delete index for a project
 *   node cli.mjs start    /path/to/project               # Start indexing (via command file)
 *   node cli.mjs stop     /path/to/project               # Stop indexing (via command file)
 *   node cli.mjs pause    /path/to/project               # Pause watcher (via command file)
 *   node cli.mjs reindex  /path/to/project               # Force full re-index (via command file)
 *
 * Config reads from ~/.config/opencode/opencode.json (plugin options)
 * or from environment variables:
 *   OPENCODE_INDEXER_API_KEY, OPENCODE_INDEXER_BASE_URL, etc.
 *
 * Default: OpenAI + LanceDB
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { resolve, join, dirname } from "path"
import { CodebaseIndexer } from "./dist/engine.js"

// ─── Load config ────────────────────────────────────────

function loadConfig() {
  const configPath = resolve(homedir(), ".config/opencode/opencode.json")

  // Try opencode global config
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const config = JSON.parse(raw)
      const plugins = config.plugin || []
      for (const p of plugins) {
        if (Array.isArray(p) && p[1]?.embedder) {
          return p[1]
        }
      }
    } catch {}
  }

  // Fallback to env vars
  return {
    embedder: process.env.OPENCODE_INDEXER_EMBEDDER || "openai",
    openaiApiKey: process.env.OPENCODE_INDEXER_API_KEY,
    openaiBaseUrl: process.env.OPENCODE_INDEXER_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENCODE_INDEXER_MODEL || "text-embedding-3-small",
    vectorStore: process.env.OPENCODE_INDEXER_VECTOR_STORE || "lancedb",
  }
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  const command = process.argv[2]
  const target = resolve(process.argv[3] || ".")

  if (!command || command === "--help" || command === "-h") {
    console.log(`
Codebase Indexer CLI

Usage:
  node ${process.argv[1]} index    <directory>             Index a project
  node ${process.argv[1]} search   <directory> <query>    Search indexed code
  node ${process.argv[1]} status   <directory>             Check index status
  node ${process.argv[1]} clear    <directory>             Delete index
  node ${process.argv[1]} start    <directory>             Start indexing (requires running server)
  node ${process.argv[1]} stop     <directory>             Stop indexing (requires running server)
  node ${process.argv[1]} pause    <directory>             Pause watcher (requires running server)
  node ${process.argv[1]} reindex  <directory>             Force full re-index (requires running server)

Examples:
  node ${process.argv[1]} index    ~/Sites/aristocrat-admin
  node ${process.argv[1]} search   ~/Sites/aristocrat-admin "how does auth work"
  node ${process.argv[1]} status   ~/Sites/aristocrat-admin
  node ${process.argv[1]} reindex  ~/Sites/aristocrat-admin
`)
    process.exit(0)
  }

  // Control commands (start/stop/pause/reindex) just write a command file — no API key needed
  const isControlCommand = ["start", "stop", "pause", "reindex"].includes(command)

  const pluginConfig = loadConfig()

  if (!isControlCommand && !pluginConfig.openaiApiKey) {
    console.error("❌ No API key found. Set OPENCODE_INDEXER_API_KEY env var or configure in ~/.config/opencode/opencode.json")
    process.exit(1)
  }

  const indexer = isControlCommand ? null : new CodebaseIndexer(target, pluginConfig)

  switch (command) {
    case "index": {
      console.log(`\n  📦 Indexing: ${target}\n`)
      console.log(`  Embedder: ${pluginConfig.embedder} | Model: ${pluginConfig.model}`)
      console.log(`  Vector Store: ${pluginConfig.vectorStore}${pluginConfig.qdrantUrl ? ` | Qdrant: ${pluginConfig.qdrantUrl}` : ""}\n`)

      // Check if already indexed
      try {
        await indexer.init()
        const existing = await indexer.stats()
        if (existing.blocks > 0) {
          console.log(`  ⚠️  Index already exists with ${existing.blocks} blocks.`)
          console.log(`  Run with --force to re-index, or search with:\n`)
          console.log(`    node ${process.argv[1]} search "${target}" "your query"\n`)
          process.exit(0)
        }
      } catch {
        // No existing index, proceed
      }

      try {
        await indexer.ensureReady()
        await indexer.init()
        const start = Date.now()
        const { files, blocks } = await indexer.index(target)
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)

        const stats = await indexer.stats()

        console.log(`  ✅ Done!`)
        console.log(`  ───────────────────────`)
        console.log(`  Files indexed:  ${files}`)
        console.log(`  Code blocks:    ${blocks}`)
        console.log(`  Time:           ${elapsed}s`)
        console.log(`  Blocks:        ${stats.blocks}`)
        console.log(`  Collection:     ${stats.dbPath}\n`)
        console.log(`  Next: node ${process.argv[1]} search "${target}" "your query"\n`)
      } catch (err) {
        console.error(`\n  ❌ Error: ${err.message}\n`)
        process.exit(1)
      }
      break
    }

    case "search": {
      const query = process.argv[4]
      if (!query) {
        console.error(`\n  ❌ Missing query. Usage: node cli.mjs search <directory> "your query"\n`)
        process.exit(1)
      }

      try {
        await indexer.init()
        const stats = await indexer.stats()

        if (stats.blocks === 0) {
          console.log(`\n  📭 No index found for ${target}. Run index first:\n    node ${process.argv[1]} index "${target}"\n`)
          process.exit(0)
        }

        console.log(`\n  🔍 Searching "${query}" in ${target}\n`)
        console.log(`  Database: ${stats.dbPath} (${stats.blocks} blocks)\n`)

        const results = await indexer.search(query)

        if (results.length === 0) {
          console.log(`  No results found. Try a different query.\n`)
          process.exit(0)
        }

        for (const r of results) {
          console.log(`  [${(r.score * 100).toFixed(0)}%] ${r.relativePath}:${r.startLine}-${r.endLine}`)
          const preview = r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content
          for (const line of preview.split("\n")) {
            console.log(`       ${line}`)
          }
          console.log()
        }
      } catch (err) {
        console.error(`\n  ❌ Error: ${err.message}\n`)
        process.exit(1)
      }
      break
    }

    case "status": {
      try {
        await indexer.init()
        const stats = await indexer.stats()

        if (stats.blocks === 0) {
          console.log(`\n  📭 No index for: ${target}\n`)
        } else {
          console.log(`\n  📊 Codebase Index: ${target}`)
          console.log(`  ───────────────────────`)
          console.log(`  Status:        Active`)
          console.log(`  Blocks:        ${stats.blocks}`)
          console.log(`  Storage:       ${pluginConfig.vectorStore}`)
          console.log(`  Collection:    ${stats.dbPath}`)
          console.log(`  Embedder:      ${pluginConfig.embedder}`)
          console.log(`  Model:         ${pluginConfig.model}\n`)
        }
      } catch {
        console.log(`\n  ❌ No index for: ${target}\n`)
      }
      break
    }

    case "clear": {
      try {
        await indexer.init()
        const stats = await indexer.stats()
        if (stats.blocks > 0) {
          if (pluginConfig.vectorStore === "qdrant") {
            // Delete Qdrant collection via REST API
            const url = (pluginConfig.qdrantUrl || "http://localhost:6333").replace(/\/$/, "")
            const colName = stats.dbPath.split("/").pop()
            await fetch(`${url}/collections/${colName}`, { method: "DELETE" })
          }
          // LanceDB: data is in .codebase-index-store/ — user deletes folder manually
          console.log(`\n  🗑️  Index cleared for: ${target} (was ${stats.blocks} blocks)\n`)
          if (pluginConfig.vectorStore !== "qdrant") {
            console.log(`  💡 LanceDB data is at: .codebase-index-store/ — delete this folder to fully remove.\n`)
          }
        } else {
          console.log(`\n  📭 No index to clear.\n`)
        }
      } catch (err) {
        console.error(`\n  ❌ Error: ${err.message}\n`)
        process.exit(1)
      }
      break
    }

    case "start":
    case "stop":
    case "pause":
    case "reindex": {
      // These write a command file that the running server polls every 1s.
      // The server must be running in this project for the command to take effect.
      const cmdPath = join(target, ".opencode", "state", "opencode-indexer", "command.json")
      const cmdDir = dirname(cmdPath)
      if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true })

      const icons = { start: "▶", stop: "⏹", pause: "⏸", reindex: "⏮" }
      const labels = {
        start: "Indexing started",
        stop: "Abort signal sent",
        pause: "Watcher paused (index preserved)",
        reindex: "Full re-index started",
      }

      writeFileSync(
        cmdPath,
        JSON.stringify({ action: command, timestamp: new Date().toISOString() }, null, 2),
        "utf-8"
      )

      console.log(`\n  ${icons[command]} ${labels[command]}`)
      console.log(`  Target: ${target}`)
      console.log(`  Command file: ${cmdPath}`)
      console.log(`  ⏳ Server will pick this up within 1s (if running).\n`)
      break
    }

    default:
      console.error(`\n  ❌ Unknown command: ${command}. Use: index, search, status, clear, start, stop, pause, reindex\n`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
