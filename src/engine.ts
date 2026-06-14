/**
 * Core indexing engine — supports OpenAI-compatible and Ollama embeddings,
 * with Qdrant and LanceDB vector stores. LanceDB is the default (zero
 * dependencies — embedded, file-based, no server required). Qdrant is
 * available for team/external deployments.
 *
 * Config via opencode.json plugin options:
 *   {
 *     "plugin": [["opencode-indexer", {
 *       "embedder": "openai",
 *       "openaiApiKey": "sk-...",
 *       "model": "text-embedding-3-small",
 *       "vectorStore": "lancedb"
 *     }]]
 *   }
 */

import { createHash } from "crypto"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs"
import { extname, relative, join, dirname } from "path"
import { fileURLToPath } from "url"
import { v5 as uuidv5 } from "uuid"
import { glob } from "glob"
import { Ollama } from "ollama"
import ignore from "ignore"
import type { Parser as TreeSitterParserType, Language as TreeSitterLangType } from "web-tree-sitter"

// Lazy-loaded tree-sitter — only imported when a supported language is encountered
let TreeSitterParserCtor: typeof TreeSitterParserType | null = null
let TreeSitterLangCtor: typeof TreeSitterLangType | null = null
let tsInitDone = false
async function ensureTreeSitter(): Promise<boolean> {
  if (tsInitDone) return TreeSitterParserCtor !== null
  tsInitDone = true
  try {
    const wts = await import("web-tree-sitter")
    TreeSitterParserCtor = wts.Parser
    TreeSitterLangCtor = wts.Language
    await TreeSitterParserCtor.init()
    return true
  } catch { return false }
}

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
  /** Enable branch-aware indexing — polls .git/HEAD and re-indexes on branch change */
  branchAware?: boolean
  /** Polling interval in ms for branch change detection (default 3000) */
  branchPollMs?: number
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

/** Bump this when the indexing logic changes (forces re-index of all files) */
const INDEXER_VERSION = 2

const IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
  "**/.next/**", "**/vendor/**", "**/__pycache__/**", "**/.venv/**",
  "**/target/**", "**/*.min.js", "**/*.min.css", "**/*.map",
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/.codebase-index-store/**",
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

// ─── Tree-sitter Grammar Registry ────────────────────────

/** Extensions that have tree-sitter grammars available */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".php"])

/** Per-extension WASM file path (relative to plugin's node_modules) */
const TS_WASM: Record<string, string> = {
  ".ts":  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-typescript/tree-sitter-tsx.wasm",
  ".js":  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript/tree-sitter-javascript.wasm",
  ".py":  "tree-sitter-python/tree-sitter-python.wasm",
  ".php": "tree-sitter-php/tree-sitter-php.wasm",
}

/**
 * AST node types that represent semantic code blocks (functions, classes, etc.).
 * When we encounter one, we extract it as a standalone block for embedding.
 * If a block exceeds MAX_BLOCK_CHARS, we recurse into its children.
 */
const TS_BLOCK_TYPES = new Set([
  // TS/JS
  "function_declaration", "generator_function_declaration",
  "method_definition", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "lexical_declaration", "export_statement",
  // Python
  "function_definition", "class_definition", "decorated_definition",
  // PHP
  "class_declaration", "interface_declaration", "trait_declaration",
  "enum_declaration", "function_definition", "method_declaration",
])

// Cache: extension → loaded Language object
const tsLangCache = new Map<string, any>()

/** Resolve a WASM path from the plugin's own node_modules */
function resolveWasm(relativePath: string): string {
  // engine.ts → dist/engine.js → ../node_modules/<pkg>/<file>.wasm
  const __filename = fileURLToPath(import.meta.url)
  const __dir = dirname(__filename)
  return join(__dir, "..", "node_modules", relativePath)
}

/** Load a grammar for the given extension (cached) */
async function loadTsGrammar(ext: string): Promise<any | null> {
  if (tsLangCache.has(ext)) return tsLangCache.get(ext)
  const ok = await ensureTreeSitter()
  if (!ok || !TreeSitterLangCtor) {
    tsLangCache.set(ext, null)
    return null
  }
  const wasmRel = TS_WASM[ext]
  if (!wasmRel) { tsLangCache.set(ext, null); return null }
  try {
    const wasmPath = resolveWasm(wasmRel)
    const wasmBytes = readFileSync(wasmPath)
    const lang = await TreeSitterLangCtor.load(wasmBytes)
    tsLangCache.set(ext, lang)
    return lang
  } catch {
    tsLangCache.set(ext, null)
    return null
  }
}

/**
 * Parse a single file using tree-sitter AST to extract semantic code blocks.
 * Returns blocks with startLine/endLine based on AST node positions.
 * Falls back gracefully: if grammar unavailable or no blocks found, returns null.
 */
async function parseFileWithTreeSitter(
  filePath: string, content: string, ext: string, root: string,
): Promise<any[] | null> {
  if (!TS_EXTENSIONS.has(ext)) return null

  const grammar = await loadTsGrammar(ext)
  if (!grammar || !TreeSitterParserCtor) return null

  const parser = new TreeSitterParserCtor()
  parser.setLanguage(grammar)
  const tree = parser.parse(content)
  const relPath = relative(root, filePath)
  const language = EXT_LANG[ext] ?? "unknown"

  const blocks: any[] = []

  function extractBlock(node: any): string {
    return content.slice(node.startIndex, node.endIndex)
  }

  function walk(node: any) {
    const nodeType: string = node.type

    if (TS_BLOCK_TYPES.has(nodeType)) {
      const text = extractBlock(node)
      if (text.trim().length >= MIN_BLOCK_CHARS) {
        if (text.length <= MAX_BLOCK_CHARS) {
          // Perfect — fits in one block
          const hash = sha256(text)
          blocks.push({
            id: uuidv5(`${relPath}:${node.startPosition.row + 1}:${hash}`, BLOCK_NAMESPACE),
            filePath, relativePath: relPath, content: text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            language, hash,
          })
          return // Don't recurse — this node is already a block
        } else {
          // Block too large — recurse into children for sub-blocks
          for (const child of node.children) {
            walk(child)
          }
          return
        }
      }
      // Too small — skip but still recurse (children might be meaningful)
    }

    // Not a block type — recurse into children
    for (const child of node.children) {
      walk(child)
    }
  }

  walk(tree.rootNode)

  // If tree-sitter found meaningful blocks, return them
  if (blocks.length > 0) return blocks

  // If no AST blocks found (unusual grammar, empty file), fall back to line-based
  return null
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

const PROGRESS_FILE = ".codebase-index-store/progress.json"
const BRANCH_FILE = ".codebase-index-store/branch"

/**
 * Read the current git branch from .git/HEAD.
 * Returns null if not in a git repo or HEAD is detached.
 */
export function getCurrentBranch(root: string): string | null {
  try {
    const headPath = join(root, ".git", "HEAD")
    if (!existsSync(headPath)) return null
    const head = readFileSync(headPath, "utf-8").trim()
    // Detached HEAD: file contains a raw commit SHA
    if (head.match(/^[0-9a-f]{40}$/)) return null
    // Normal branch: "ref: refs/heads/branch-name"
    const match = head.match(/^ref: refs\/heads\/(.+)$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/** Read the branch name stored from the last index */
export function getStoredBranch(root: string): string | null {
  try {
    const path = join(root, BRANCH_FILE)
    if (!existsSync(path)) return null
    return readFileSync(path, "utf-8").trim()
  } catch {
    return null
  }
}

/** Store the current branch name after indexing */
export function setStoredBranch(root: string, branch: string): void {
  try {
    writeFileSync(join(root, BRANCH_FILE), branch + "\n", "utf-8")
  } catch { /* best-effort */ }
}

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

const OLLAMA_MAX_CHARS = 7000 // nomic-embed-text has 8192 token context; be conservative

function ollamaTruncate(text: string): string {
  if (text.length <= OLLAMA_MAX_CHARS) return text
  return text.slice(0, OLLAMA_MAX_CHARS) + "\n// [truncated]"
}

function createOllamaEmbedder(ollamaUrl: string, model: string): Embedder {
  const ollama = new Ollama({ host: ollamaUrl })
  let cachedDim: number | null = null

  return {
    async embed(texts: string[]) {
      const truncated = texts.map(ollamaTruncate)
      const res = await ollama.embed({ model, input: truncated })
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

const MAX_INPUT_CHARS = 8000 // safe under 8192 tokens even for dense code (~1 char/token worst case)

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
  getFileHash(filePath: string): Promise<string | null>
  listStoredFiles(): Promise<string[]>
  search(vector: number[], maxResults: number): Promise<any[]>
  count(): Promise<number>
  getDbPath(): string
}

// ─── LanceDB Store ────────────────────────────────────────

async function createLanceStore(workspaceRoot: string, colName: string): Promise<VectorStore> {
  const lancedb = await import("@lancedb/lancedb")
  const dbPath = join(workspaceRoot, ".codebase-index-store")
  let db: any = null
  let table: any = null
  let initialized = false

  return {
    async init(dimension: number) {
      if (!existsSync(dbPath)) mkdirSync(dbPath, { recursive: true })
      db = await lancedb.connect(dbPath)
      const tables: string[] = await db.tableNames()
      if (tables.includes(colName)) {
        table = await db.openTable(colName)
      }
      initialized = true
    },
    async upsertBatch(rows: any[]) {
      // Full re-index: overwrite entire table
      if (!initialized) return
      if (table) {
        try { await db.dropTable(colName) } catch {}
      }
      table = await db.createTable(colName, rows, { existOk: true })
    },
    async upsertPoints(rows: any[]) {
      if (!initialized) return
      if (!table) {
        // First index — create the table with this batch
        table = await db.createTable(colName, rows, { existOk: true })
        return
      }
      // Append mode — adds to existing table without dropping unchanged blocks
      await table.add(rows, { mode: "append" })
    },
    async deleteByFile(filePath: string) {
      if (!table) return
      const escaped = filePath.replace(/'/g, "''")
      await table.delete(`filePath = '${escaped}'`)
    },
    async getFileHash(filePath: string): Promise<string | null> {
      if (!table) return null
      try {
        const escaped = filePath.replace(/'/g, "''")
        const results = await table
          .query()
          .filter(`filePath = '${escaped}'`)
          .limit(1)
          .toArray()
        return results?.[0]?.fileHash ?? null
      } catch { return null }
    },
    async listStoredFiles(): Promise<string[]> {
      if (!table) return []
      try {
        const all = await table.query().toArray()
        const files: string[] = all.map((r: any) => r.filePath as string).filter(Boolean) as string[]
        return [...new Set(files)]
      } catch { return [] }
    },
    async search(vector: number[], maxResults: number) {
      if (!table) return []
      try {
        return await table
          .query()
          .nearestTo(vector)
          .distanceType("cosine")
          .limit(maxResults)
          .toArray()
      } catch { return [] }
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
            fileHash: r.fileHash ?? "",
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
          fileHash: r.fileHash ?? "",
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
    async getFileHash(filePath: string): Promise<string | null> {
      try {
        const res = await fetch(`${url}/collections/${colName}/points/scroll`, {
          method: "POST", headers,
          body: JSON.stringify({
            filter: { must: [{ key: "filePath", match: { value: filePath } }] },
            limit: 1, with_payload: true, with_vector: false,
          }),
        })
        const data = await res.json() as any
        const points = data.result?.points ?? []
        if (points.length === 0) return null
        return points[0].payload?.fileHash ?? null
      } catch { return null }
    },
    async listStoredFiles(): Promise<string[]> {
      try {
        const files = new Set<string>()
        let offset: string | null = null
        // Scroll through all points in batches
        for (let i = 0; i < 50; i++) { // safety limit: 50 scroll pages max
          const body: any = { limit: 100, with_payload: ["filePath"], with_vector: false }
          if (offset) body.offset = offset
          const res = await fetch(`${url}/collections/${colName}/points/scroll`, {
            method: "POST", headers, body: JSON.stringify(body),
          })
          const data = await res.json() as any
          const points = data.result?.points ?? []
          for (const p of points) {
            if (p.payload?.filePath) files.add(p.payload.filePath)
          }
          if (!data.result?.next_page_offset) break
          offset = data.result.next_page_offset
        }
        return Array.from(files)
      } catch { return [] }
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

// ─── Vue SFC Script Extraction ──────────────────────────────

/**
 * Extract the <script> block from a Vue SFC file for tree-sitter parsing.
 * Supports: <script>, <script setup>, <script lang="ts">, <script setup lang="ts">
 * Returns the script content, line offset (mapping back to original .vue), and language.
 */
function extractVueScript(content: string): { scriptContent: string; scriptStartLine: number; lang: string } | null {
  const openMatch = content.match(/<script\b([^>]*)>/i)
  if (!openMatch) return null

  const tagBody = openMatch[1] ?? ""
  const openIndex = openMatch.index!
  const openTag = openMatch[0]
  const openEnd = openIndex + openTag.length

  const closeMatch = content.indexOf("</script>", openEnd)
  if (closeMatch === -1) return null

  const scriptContent = content.slice(openEnd, closeMatch)
  if (scriptContent.trim().length < MIN_BLOCK_CHARS) return null

  const langMatch = tagBody.match(/\blang\s*=\s*["']([^"']+)["']/i)
  const lang = langMatch && (langMatch[1] === "ts" || langMatch[1] === "typescript") ? ".ts" : ".js"

  const before = content.slice(0, openIndex)
  const scriptStartLine = before.split("\n").length

  return { scriptContent, scriptStartLine, lang }
}

/**
 * Parse a file into code blocks. Tries tree-sitter AST parsing first
 * for supported languages (TS, JS, Python, PHP); falls back to
 * line-based chunking for unsupported languages or when tree-sitter is unavailable.
 */
async function parseFile(filePath: string, root: string, maxSize: number): Promise<any[]> {
  try {
    const buf = readFileSync(filePath)
    if (buf.length > maxSize) return []

    const content = buf.toString("utf-8")
    const ext = extname(filePath)

    // Vue SFC: extract <script> block and parse with JS/TS tree-sitter
    if (ext === ".vue") {
      const extracted = extractVueScript(content)
      if (extracted) {
        const { scriptContent, scriptStartLine, lang } = extracted
        const tsBlocks = await parseFileWithTreeSitter(filePath, scriptContent, lang, root)
        if (tsBlocks && tsBlocks.length > 0) {
          // Offset line numbers to be relative to the original .vue file
          const lineOffset = scriptStartLine - 1
          for (const b of tsBlocks) {
            b.startLine += lineOffset
            b.endLine += lineOffset
            b.language = "vue" // preserve Vue language marker
          }
          return tsBlocks
        }
      }
      // No script block or tree-sitter produced nothing — fall through to line-based
    }

    // Try tree-sitter first for supported extensions
    if (TS_EXTENSIONS.has(ext)) {
      const tsBlocks = await parseFileWithTreeSitter(filePath, content, ext, root)
      if (tsBlocks && tsBlocks.length > 0) return tsBlocks
      // Fall through to line-based if tree-sitter returned null or empty
    }

    // Line-based chunking (fallback)
    return parseFileLineBased(filePath, content, root, maxSize)
  } catch {
    return []
  }
}

/**
 * Line-based chunking — original behavior. Splits file content at ~1000 char
 * boundaries. Used as fallback when tree-sitter is unavailable or for
 * unsupported languages.
 */
function parseFileLineBased(
  filePath: string, content: string, root: string, _maxSize: number,
): any[] {
  const lines = content.split("\n")
  const relPath = relative(root, filePath)
  const ext = extname(filePath)
  const language = EXT_LANG[ext] ?? "unknown"

  const blocks: any[] = []
  let current: string[] = []
  let startLine = 1

  function emitBlock(text: string, endLine: number) {
    // Guard: ensure text never exceeds MAX_BLOCK_CHARS * 2 (safety cap)
    // to prevent giant blocks from exceeding embedding token limits
    if (text.length > MAX_BLOCK_CHARS) {
      // Split overly large text (e.g. very long single lines) into chunks
      for (let pos = 0; pos < text.length; pos += MAX_BLOCK_CHARS) {
        const chunk = text.slice(pos, pos + MAX_BLOCK_CHARS)
        if (chunk.trim().length < MIN_BLOCK_CHARS) continue
        const hash = sha256(chunk)
        blocks.push({
          id: uuidv5(`${relPath}:${startLine}:${hash}`, BLOCK_NAMESPACE),
          filePath, relativePath: relPath, content: chunk,
          startLine, endLine, language, hash,
        })
      }
      return
    }

    if (text.trim().length < MIN_BLOCK_CHARS) return
    const hash = sha256(text)
    blocks.push({
      id: uuidv5(`${relPath}:${startLine}:${hash}`, BLOCK_NAMESPACE),
      filePath, relativePath: relPath, content: text,
      startLine, endLine, language, hash,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    current.push(lines[i])
    const text = current.join("\n")
    if (text.length >= MAX_BLOCK_CHARS) {
      emitBlock(text, i + 1)
      current = []
      startLine = i + 2
    }
  }

  if (current.length > 0) {
    emitBlock(current.join("\n"), lines.length)
  }

  return blocks
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
  branchAware: boolean
  branchPollMs: number

  constructor(workspaceRoot: string, config: IndexerConfig = {}) {
    this.workspaceRoot = workspaceRoot
    this.colName = collectionName(workspaceRoot)
    this.storeType = config.vectorStore ?? "lancedb"
    this.qdrantUrl = config.qdrantUrl ?? "http://localhost:6333"
    this.qdrantApiKey = config.qdrantApiKey
    this.branchAware = config.branchAware ?? false
    this.branchPollMs = config.branchPollMs ?? 3000

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

  async index(workspaceRoot: string, onProgress?: (msg: string) => void): Promise<{ files: number; blocks: number; skipped: number }> {
    if (!this.store) throw new Error("Call init() first")

    const log = onProgress || ((msg: string) => console.log(msg))
    const progress = (state: ProgressState) => {
      writeProgressFile(workspaceRoot, state)
    }

    // Phase: scanning
    progress({ phase: "scanning", message: "Scanning files...", current: 0, total: 0, percentage: 0, updatedAt: "" })
    log("🔍 Scanning files...")
    const projectIgnore = loadProjectIgnore(workspaceRoot)

    // glob v11 IGNORES function-based ignore callbacks (the { ignored: fn } form is
    // silently discarded). Pass string patterns for fast native filtering, then
    // post-filter with the full ignore rules for .gitignore/.opencodeignore support.
    const files = await glob("**/*", {
      cwd: workspaceRoot, absolute: true, nodir: true,
      ignore: IGNORE, // string patterns — glob handles these natively
    })
    // Post-filter: apply full ignore rules (includes .gitignore + .opencodeignore)
    const filtered = files.filter((f) => !projectIgnore.ignores(relative(workspaceRoot, f)))
    const indexable = filtered.filter((f) => EXTENSIONS.has(extname(f)))
    log(`📄 Found ${indexable.length} indexable files (${filtered.length} source, ${files.length} total)`)

    if (indexable.length === 0) {
      log("⚠ No indexable files found — nothing to do")
      progress({ phase: "done", message: "No indexable files found", current: 0, total: 0, percentage: 100, updatedAt: "" })
      return { files: 0, blocks: 0, skipped: 0 }
    }

    // Gather stored file paths for deletion detection
    const storedFiles = new Set(await this.store.listStoredFiles())

    // Phase: parsing (with hash caching)
    progress({ phase: "parsing", message: "Parsing files...", current: 0, total: indexable.length, percentage: 0, updatedAt: "" })
    const allBlocks: any[] = []
    let skippedCount = 0
    let parsedCount = 0
    const totalFiles = indexable.length

    for (let fi = 0; fi < totalFiles; fi++) {
      const file = indexable[fi]
      const relPath = relative(workspaceRoot, file)

      // Compute file hash
      let fileHash = ""
      try {
        const buf = readFileSync(file)
        if (buf.length <= this.maxFileSize) {
          fileHash = sha256(INDEXER_VERSION + ":" + buf.toString("utf-8"))
        }
      } catch { /* unreadable — skip */ }

      // Hash cache check: skip if file hasn't changed
      if (fileHash) {
        const storedHash = await this.store.getFileHash(file)
        if (storedHash && storedHash === fileHash) {
          skippedCount++
          storedFiles.delete(file)
          // Still report progress every 50 files
          if ((fi + 1) % 50 === 0 || fi === totalFiles - 1) {
            const msg = `📖 Scanned ${fi + 1}/${totalFiles} files — ${skippedCount} unchanged, ${parsedCount} updated`
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
          continue
        }
      }

      // File is new or changed — delete old blocks, parse fresh
      await this.store.deleteByFile(file)
      const blocks = await parseFile(file, workspaceRoot, this.maxFileSize)

      // Stamp each block with the file hash
      for (const b of blocks) {
        b.fileHash = fileHash
      }
      allBlocks.push(...blocks)
      parsedCount++
      storedFiles.delete(file)

      if ((fi + 1) % 50 === 0 || fi === totalFiles - 1) {
        const msg = `📖 Scanned ${fi + 1}/${totalFiles} files → ${allBlocks.length} blocks (${skippedCount} unchanged, ${parsedCount} updated)`
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

    // Remove deleted files from the store
    if (storedFiles.size > 0) {
      log(`🗑 Removing ${storedFiles.size} deleted files from index...`)
      for (const deletedFile of storedFiles) {
        await this.store.deleteByFile(deletedFile)
      }
    }

    if (allBlocks.length === 0 && parsedCount === 0 && skippedCount > 0) {
      log(`✅ All ${skippedCount} files unchanged — index is up to date`)
      progress({ phase: "done", message: "Index up to date", current: totalFiles, total: totalFiles, percentage: 100, updatedAt: "" })
      return { files: indexable.length, blocks: await this.store.count(), skipped: skippedCount }
    }

    if (allBlocks.length === 0) {
      log("⚠ No code blocks generated from changed files")
      progress({ phase: "done", message: "No code blocks generated", current: totalFiles, total: totalFiles, percentage: 100, updatedAt: "" })
      return { files: indexable.length, blocks: await this.store.count(), skipped: skippedCount }
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

    // Phase: saving (upsertPoints — append, don't wipe existing unchanged blocks)
    const storeLabel = this.storeType === "lancedb" ? "LanceDB" : "Qdrant"
    log(`💾 Saving ${allRows.length} vectors to ${storeLabel}...`)
    progress({ phase: "saving", message: "Saving vectors...", current: allRows.length, total: allRows.length, percentage: 95, updatedAt: "" })

    // Use upsertPoints (append) instead of upsertBatch (wipe-and-replace)
    // because unchanged files' blocks are still in the store
    if (allRows.length > 0) {
      await this.store.upsertPoints(allRows)
    }

    // Done
    const totalBlocks = await this.store.count()
    const doneMsg = `✅ Done — ${indexable.length} files scanned: ${skippedCount} unchanged, ${parsedCount} updated → ${totalBlocks} blocks total`
    log(doneMsg)
    progress({ phase: "done", message: doneMsg, current: totalBlocks, total: totalBlocks, percentage: 100, updatedAt: "" })

    // Track branch if branchAware is enabled
    if (this.branchAware) {
      const branch = getCurrentBranch(this.workspaceRoot)
      if (branch) setStoredBranch(this.workspaceRoot, branch)
    }

    return { files: indexable.length, blocks: totalBlocks, skipped: skippedCount }
  }

  async indexFile(filePath: string, onProgress?: (msg: string) => void): Promise<{ blocks: number }> {
    if (!this.store) throw new Error("Call init() first")
    const log = onProgress || ((msg: string) => console.log(msg))

    const ext = extname(filePath)
    if (!EXTENSIONS.has(ext)) return { blocks: 0 }

    // Compute file hash
    let fileHash = ""
    try {
      const buf = readFileSync(filePath)
      if (buf.length <= this.maxFileSize) {
        fileHash = sha256(INDEXER_VERSION + ":" + buf.toString("utf-8"))
      }
    } catch { return { blocks: 0 } }

    // Hash cache check
    if (fileHash) {
      const storedHash = await this.store.getFileHash(filePath)
      if (storedHash && storedHash === fileHash) {
        return { blocks: 0 } // unchanged
      }
    }

    const blocks = await parseFile(filePath, this.workspaceRoot, this.maxFileSize)
    if (blocks.length === 0) return { blocks: 0 }

    // Stamp with file hash
    for (const b of blocks) b.fileHash = fileHash

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
