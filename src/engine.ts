/**
 * Core indexing engine — supports OpenAI-compatible and Ollama embeddings,
 * with Qdrant and LanceDB vector stores. Each project gets its own
 * Qdrant collection (prefixed by project path hash) so indexes stay isolated.
 *
 * Config via opencode.json plugin options:
 *   {
 *     "plugin": [["opencode-indexer", {
 *       "embedder": "openai",
 *       "openaiBaseUrl": "...",
 *       "openaiApiKey": "sk-...",
 *       "model": "text-embedding-3-small",
 *       "vectorStore": "qdrant",
 *       "qdrantUrl": "http://localhost:6333"
 *     }]]
 *   }
 */

import { createHash } from "crypto"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { extname, relative, join, dirname } from "path"
import { v5 as uuidv5 } from "uuid"
import { glob } from "glob"
import { Ollama } from "ollama"
import ignore from "ignore"

// ─── Types ────────────────────────────────────────────────

export interface IndexerConfig {
  embedder?: "ollama" | "openai"
  model?: string
  ollamaUrl?: string
  openaiBaseUrl?: string
  openaiApiKey?: string
  vectorStore?: "lancedb" | "qdrant"
  qdrantUrl?: string
  qdrantApiKey?: string
  maxResults?: number
  minScore?: number
  batchSize?: number
  maxFileSize?: number
}

export interface SearchResult {
  filePath: string
  relativePath: string
  content: string
  startLine: number
  endLine: number
  language: string
  score: number
}

export interface ProgressState {
  phase: "idle" | "scanning" | "parsing" | "embedding" | "saving" | "done" | "error"
  message: string
  current: number
  total: number
  percentage: number
  updatedAt: string
}

// ─── Constants ────────────────────────────────────────────

const BLOCK_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
const MAX_BLOCK_CHARS = 1000
const MIN_BLOCK_CHARS = 100
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_FILE_SIZE = 1_000_000

const IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
  "**/.next/**", "**/vendor/**", "**/__pycache__/**", "**/.venv/**",
  "**/target/**", "**/*.min.js", "**/*.min.css", "**/*.map",
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/.codebase-index/**", ".codebase-index-progress.json",
]

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp", ".css", ".scss",
  ".html", ".vue", ".svelte", ".md", ".json",
  ".yaml", ".yml", ".toml", ".sh", ".bash",
  ".php", ".swift", ".zig",
])

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".c": "c", ".cpp": "cpp",
  ".css": "css", ".html": "html", ".vue": "vue", ".svelte": "svelte",
  ".md": "markdown", ".json": "json", ".yaml": "yaml", ".toml": "toml",
  ".sh": "bash", ".php": "php", ".swift": "swift", ".zig": "zig",
}

// ─── Helpers ──────────────────────────────────────────────

function projectId(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)
}

function collectionName(workspaceRoot: string): string {
  return `idx_${projectId(workspaceRoot)}`
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// ─── Project Ignore Rules ───────────────────────────────

/**
 * Load .gitignore + .opencodeignore from the project root and merge with
 * the hardcoded ignore list. Returns an `ignore` instance that can test
 * relative paths against all rules.
 *
 * Priority: hardcoded defaults → .gitignore → .opencodeignore (last wins)
 */
export function loadProjectIgnore(root: string): ReturnType<typeof ignore> {
  const ig = ignore()

  // Layer 1: hardcoded defaults
  ig.add(IGNORE)

  // Layer 2: .gitignore
  const gitignorePath = join(root, ".gitignore")
  if (existsSync(gitignorePath)) {
    try {
      ig.add(readFileSync(gitignorePath, "utf-8"))
    } catch { /* unreadable — skip */ }
  }

  // Layer 3: .opencodeignore (same format as .gitignore, takes precedence)
  const opencodeignorePath = join(root, ".opencodeignore")
  if (existsSync(opencodeignorePath)) {
    try {
      ig.add(readFileSync(opencodeignorePath, "utf-8"))
    } catch { /* unreadable — skip */ }
  }

  return ig
}

// ─── Progress File ──────────────────────────────────────

const PROGRESS_FILE = ".codebase-index-progress.json"

/**
 * Write indexing progress state to a JSON file at the project root.
 * The TUI sidebar plugin reads this file to render a live progress bar.
 * Uses a separate filename from the .codebase-index marker to avoid
 * conflicts (the marker may be a file or directory).
 */
export function writeProgressFile(
  root: string,
  state: ProgressState,
): void {
  try {
    writeFileSync(
      join(root, PROGRESS_FILE),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    )
  } catch { /* best-effort — never crash on progress writes */ }
}

// ─── Embedder Interface ──────────────────────────────────

interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  dimension(): Promise<number>
}

// ─── Ollama Embedder ─────────────────────────────────────

function createOllamaEmbedder(ollamaUrl: string, model: string): Embedder {
  const ollama = new Ollama({ host: ollamaUrl })
  let cachedDim: number | null = null

  return {
    async embed(texts: string[]) {
      const res = await ollama.embed({ model, input: texts })
      return res.embeddings
    },
    async dimension() {
      if (cachedDim) return cachedDim
      const res = await ollama.embed({ model, input: "test" })
      cachedDim = res.embeddings[0].length
      return cachedDim
    },
  }
}

// ─── OpenAI-Compatible Embedder ──────────────────────────

const MAX_INPUT_CHARS = 20000 // well under 8192 tokens (~4 chars/token for code)

function truncateText(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return text.slice(0, MAX_INPUT_CHARS) + "\n// [truncated]"
}

function createOpenAIEmbedder(baseUrl: string, apiKey: string, model: string): Embedder {
  const url = baseUrl.replace(/\/$/, "")
  let cachedDim: number | null = null

  async function callAPI(texts: string[]): Promise<number[][]> {
    // Truncate each text to stay within token limits
    const truncated = texts.map(truncateText)

    const res = await fetch(`${url}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: truncated, encoding_format: "float" }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI embeddings API error ${res.status}: ${body}`)
    }

    const data = await res.json() as any
    const sorted = data.data.sort((a: any, b: any) => a.index - b.index)
    return sorted.map((d: any) => d.embedding)
  }

  return {
    async embed(texts: string[]) {
      const all: number[][] = []
      for (let i = 0; i < texts.length; i += 2048) {
        const batch = texts.slice(i, i + 2048)
        all.push(...await callAPI(batch))
      }
      return all
    },
    async dimension() {
      if (cachedDim) return cachedDim
      cachedDim = (await callAPI(["test"]))[0].length
      return cachedDim
    },
  }
}

// ─── Vector Store Interface ───────────────────────────────

interface VectorStore {
  init(dimension: number): Promise<void>
  upsertBatch(rows: any[]): Promise<void>
  upsertPoints(rows: any[]): Promise<void>
  deleteByFile(filePath: string): Promise<void>
  search(vector: number[], maxResults: number): Promise<any[]>
  count(): Promise<number>
  getDbPath(): string
}

// ─── LanceDB Store ────────────────────────────────────────

async function createLanceStore(workspaceRoot: string, colName: string): Promise<VectorStore> {
  const lancedb = await import("@lancedb/lancedb")
  const dbPath = join(workspaceRoot, ".codebase-index", "lancedb")
  let db: any = null
  let table: any = null

  return {
    async init() {
      if (!existsSync(dbPath)) mkdirSync(dbPath, { recursive: true })
      db = await lancedb.connect(dbPath)
      const tables = await db.tableNames()
      if (tables.includes(colName)) {
        table = await db.openTable(colName)
      }
    },
    async upsertBatch(rows: any[]) {
      try { await db.dropTable(colName) } catch {}
      table = await db.createTable(colName, rows)
    },
    async upsertPoints(rows: any[]) {
      if (!table) return
      await table.add(rows)
    },
    async deleteByFile(filePath: string) {
      if (!table) return
      await table.delete(`filePath = '${filePath.replace(/'/g, "''")}'`)
    },
    async search(vector: number[], maxResults: number) {
      if (!table) return []
      const q = table.search(vector).limit(maxResults)
      if ("metric" in q && typeof q.metric === "function") q.metric("cosine")
      return q.toArray()
    },
    async count() {
      return table ? await table.countRows() : 0
    },
    getDbPath() { return dbPath },
  }
}

// ─── Qdrant Store ─────────────────────────────────────────

function createQdrantStore(qdrantUrl: string, colName: string, apiKey?: string): VectorStore {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["api-key"] = apiKey
  const url = qdrantUrl.replace(/\/$/, "")

  return {
    async init(dimension: number) {
      const res = await fetch(`${url}/collections/${colName}`, { headers })
      const data = await res.json() as any
      if (!data.result || data.result.status !== "green") {
        await fetch(`${url}/collections/${colName}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ vectors: { size: dimension, distance: "Cosine" } }),
        })
      }
    },
    async upsertBatch(rows: any[]) {
      await fetch(`${url}/collections/${colName}`, { method: "DELETE", headers })
      await this.init(rows[0]?.vector?.length ?? 768)
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        const points = batch.map((r: any) => ({
          id: r.id, vector: r.vector,
          payload: {
            filePath: r.filePath, relativePath: r.relativePath, content: r.content,
            startLine: r.startLine, endLine: r.endLine, language: r.language, hash: r.hash,
          },
        }))
        await fetch(`${url}/collections/${colName}/points`, {
          method: "PUT", headers,
          body: JSON.stringify({ points }),
        })
      }
    },
    async upsertPoints(rows: any[]) {
      const points = rows.map((r: any) => ({
        id: r.id, vector: r.vector,
        payload: {
          filePath: r.filePath, relativePath: r.relativePath, content: r.content,
          startLine: r.startLine, endLine: r.endLine, language: r.language, hash: r.hash,
        },
      }))
      for (let i = 0; i < points.length; i += 100) {
        await fetch(`${url}/collections/${colName}/points`, {
          method: "PUT", headers,
          body: JSON.stringify({ points: points.slice(i, i + 100) }),
        })
      }
    },
    async deleteByFile(filePath: string) {
      await fetch(`${url}/collections/${colName}/points/delete`, {
        method: "POST", headers,
        body: JSON.stringify({
          filter: { must: [{ key: "filePath", match: { value: filePath } }] },
        }),
      })
    },
    async search(vector: number[], maxResults: number) {
      const res = await fetch(`${url}/collections/${colName}/points/search`, {
        method: "POST", headers,
        body: JSON.stringify({ vector, limit: maxResults, with_payload: true }),
      })
      const data = await res.json() as any
      return (data.result ?? []).map((r: any) => ({
        _distance: 1 - r.score,
        ...r.payload,
        id: r.id,
      }))
    },
    async count() {
      try {
        const res = await fetch(`${url}/collections/${colName}`, { headers })
        const data = await res.json() as any
        return data.result?.points_count ?? 0
      } catch { return 0 }
    },
    getDbPath() { return `${url}/collections/${colName}` },
  }
}

// ─── Parser ───────────────────────────────────────────────

function parseFile(filePath: string, root: string, maxSize: number): any[] {
  try {
    const buf = readFileSync(filePath)
    if (buf.length > maxSize) return []

    const content = buf.toString("utf-8")
    const lines = content.split("\n")
    const relPath = relative(root, filePath)
    const ext = extname(filePath)
    const language = EXT_LANG[ext] ?? "unknown"

    const blocks: any[] = []
    let current: string[] = []
    let startLine = 1

    for (let i = 0; i < lines.length; i++) {
      current.push(lines[i])
      const text = current.join("\n")
      if (text.length >= MAX_BLOCK_CHARS) {
        const hash = sha256(text)
        blocks.push({
          id: uuidv5(`${relPath}:${startLine}:${hash}`, BLOCK_NAMESPACE),
          filePath, relativePath: relPath, content: text,
          startLine, endLine: i + 1, language, hash,
        })
        current = []
        startLine = i + 2
      }
    }

    if (current.length > 0) {
      const text = current.join("\n")
      if (text.trim().length >= MIN_BLOCK_CHARS) {
        const hash = sha256(text)
        blocks.push({
          id: uuidv5(`${relPath}:${startLine}:${hash}`, BLOCK_NAMESPACE),
          filePath, relativePath: relPath, content: text,
          startLine, endLine: lines.length, language, hash,
        })
      }
    }

    return blocks
  } catch {
    return []
  }
}

// ─── Indexer Engine ───────────────────────────────────────

export class CodebaseIndexer {
  private embedder: Embedder
  private batchSize: number
  private maxFileSize: number
  private maxResults: number
  private minScore: number
  private storeType: "lancedb" | "qdrant"
  private colName: string
  private workspaceRoot: string
  private store: VectorStore | null = null
  private qdrantUrl: string
  private qdrantApiKey?: string

  constructor(workspaceRoot: string, config: IndexerConfig = {}) {
    this.workspaceRoot = workspaceRoot
    this.colName = collectionName(workspaceRoot)
    this.storeType = config.vectorStore ?? "lancedb"
    this.qdrantUrl = config.qdrantUrl ?? "http://localhost:6333"
    this.qdrantApiKey = config.qdrantApiKey

    const embedderType = config.embedder ?? "ollama"
    const model = config.model ?? "nomic-embed-text"

    if (embedderType === "openai") {
      if (!config.openaiApiKey) {
        throw new Error("openaiApiKey is required when embedder is 'openai'")
      }
      this.embedder = createOpenAIEmbedder(
        config.openaiBaseUrl ?? "https://api.openai.com",
        config.openaiApiKey,
        model,
      )
    } else {
      this.embedder = createOllamaEmbedder(
        config.ollamaUrl ?? "http://localhost:11434",
        model,
      )
    }

    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
    this.maxFileSize = config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
    this.maxResults = config.maxResults ?? 20
    this.minScore = config.minScore ?? 0.4
  }

  async ensureReady(): Promise<void> {
    await this.embedder.dimension()
  }

  async init(): Promise<void> {
    if (this.storeType === "qdrant") {
      this.store = createQdrantStore(this.qdrantUrl, this.colName, this.qdrantApiKey)
    } else {
      this.store = await createLanceStore(this.workspaceRoot, this.colName)
    }

    const dimension = await this.embedder.dimension()
    await this.store.init(dimension)
  }

  async index(workspaceRoot: string, onProgress?: (msg: string) => void): Promise<{ files: number; blocks: number }> {
    if (!this.store) throw new Error("Call init() first")

    const log = onProgress || ((msg: string) => console.log(msg))
    const progress = (state: ProgressState) => {
      writeProgressFile(workspaceRoot, state)
    }

    // Phase: scanning
    progress({ phase: "scanning", message: "Scanning files...", current: 0, total: 0, percentage: 0, updatedAt: "" })
    log("🔍 Scanning files...")
    const projectIgnore = loadProjectIgnore(workspaceRoot)
    const files = await glob("**/*", {
      cwd: workspaceRoot, absolute: true, nodir: true,
      ignore: { ignored: (p) => projectIgnore.ignores(String(p)) },
    })
    const indexable = files.filter((f) => EXTENSIONS.has(extname(f)))
    log(`📄 Found ${indexable.length} indexable files (${files.length} total)`)

    if (indexable.length === 0) {
      log("⚠ No indexable files found — nothing to do")
      progress({ phase: "done", message: "No indexable files found", current: 0, total: 0, percentage: 100, updatedAt: "" })
      return { files: 0, blocks: 0 }
    }

    // Phase: parsing
    progress({ phase: "parsing", message: "Parsing files...", current: 0, total: indexable.length, percentage: 0, updatedAt: "" })
    const allBlocks: any[] = []
    const totalFiles = indexable.length

    for (let fi = 0; fi < totalFiles; fi++) {
      const file = indexable[fi]
      const blocks = parseFile(file, workspaceRoot, this.maxFileSize)
      allBlocks.push(...blocks)
      if ((fi + 1) % 50 === 0 || fi === totalFiles - 1) {
        const msg = `📖 Parsed ${fi + 1}/${totalFiles} files → ${allBlocks.length} code blocks so far`
        log(msg)
        progress({
          phase: "parsing",
          message: msg,
          current: fi + 1,
          total: totalFiles,
          percentage: Math.round(((fi + 1) / totalFiles) * 100),
          updatedAt: "",
        })
      }
    }

    if (allBlocks.length === 0) {
      log("⚠ No code blocks generated from files")
      progress({ phase: "done", message: "No code blocks generated", current: totalFiles, total: totalFiles, percentage: 100, updatedAt: "" })
      return { files: indexable.length, blocks: 0 }
    }

    // Phase: embedding
    log(`⚡ Embedding ${allBlocks.length} blocks in batches of ${this.batchSize}...`)
    progress({ phase: "embedding", message: "Embedding code blocks...", current: 0, total: allBlocks.length, percentage: 0, updatedAt: "" })
    const totalBatches = Math.ceil(allBlocks.length / this.batchSize)
    const allRows: any[] = []

    for (let i = 0; i < allBlocks.length; i += this.batchSize) {
      const batchNum = Math.floor(i / this.batchSize) + 1
      const batch = allBlocks.slice(i, i + this.batchSize)
      const texts = batch.map((b) => `${b.relativePath}\n${b.content}`)
      const embeddings = await this.embedder.embed(texts)
      for (let j = 0; j < batch.length; j++) {
        allRows.push({ ...batch[j], vector: embeddings[j] })
      }
      const msg = `📡 Embedding batch ${batchNum}/${totalBatches} (${allRows.length}/${allBlocks.length} blocks)`
      log(msg)
      progress({
        phase: "embedding",
        message: msg,
        current: allRows.length,
        total: allBlocks.length,
        percentage: Math.round((allRows.length / allBlocks.length) * 100),
        updatedAt: "",
      })
    }

    // Phase: saving
    log(`💾 Saving ${allRows.length} vectors to Qdrant...`)
    progress({ phase: "saving", message: "Saving vectors...", current: allRows.length, total: allRows.length, percentage: 95, updatedAt: "" })
    await this.store.upsertBatch(allRows)

    // Done
    const doneMsg = `✅ Done — ${indexable.length} files → ${allRows.length} blocks indexed`
    log(doneMsg)
    progress({ phase: "done", message: doneMsg, current: allRows.length, total: allRows.length, percentage: 100, updatedAt: "" })
    return { files: indexable.length, blocks: allRows.length }
  }

  async indexFile(filePath: string, onProgress?: (msg: string) => void): Promise<{ blocks: number }> {
    if (!this.store) throw new Error("Call init() first")
    const log = onProgress || ((msg: string) => console.log(msg))

    const ext = extname(filePath)
    if (!EXTENSIONS.has(ext)) return { blocks: 0 }

    const blocks = parseFile(filePath, this.workspaceRoot, this.maxFileSize)
    if (blocks.length === 0) return { blocks: 0 }

    const relPath = relative(this.workspaceRoot, filePath)
    log(`📝 ${relPath} — ${blocks.length} blocks`)
    const texts = blocks.map((b) => `${b.relativePath}\n${b.content}`)
    const embeddings = await this.embedder.embed(texts)
    const rows = blocks.map((b, i) => ({ ...b, vector: embeddings[i] }))

    await this.store.deleteByFile(filePath)
    await this.store.upsertPoints(rows)
    return { blocks: rows.length }
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!this.store) return
    await this.store.deleteByFile(filePath)
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.store) throw new Error("No index. Run index() first.")

    const embeddings = await this.embedder.embed([query])
    const queryVector = embeddings[0]
    const rows = await this.store.search(queryVector, this.maxResults)

    return rows
      .map((r: any) => ({
        filePath: r.filePath ?? "",
        relativePath: r.relativePath ?? "",
        content: r.content ?? "",
        startLine: r.startLine ?? 0,
        endLine: r.endLine ?? 0,
        language: r.language ?? "unknown",
        score: 1 - (r._distance ?? 1),
      }))
      .filter((r) => r.score >= this.minScore && r.content.length > 0)
  }

  async stats(): Promise<{ blocks: number; dbPath: string }> {
    return {
      blocks: this.store ? await this.store.count() : 0,
      dbPath: this.store ? this.store.getDbPath() : "not initialized",
    }
  }
}
