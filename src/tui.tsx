/** @jsxImportSource @opentui/solid */
import { createSignal, createEffect, onCleanup, Show, type JSX } from "solid-js"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

// ─── State shape ──────────────────────────────────────────

interface IndexerState {
  status: "idle" | "indexing" | "ready" | "error"
  files: number
  blocks: number
  dbPath: string
  lastIndexed: string | null
  phase: string
  progress: number
}

const DEFAULT_STATE: IndexerState = {
  status: "idle",
  files: 0,
  blocks: 0,
  dbPath: "",
  lastIndexed: null,
  phase: "idle",
  progress: 0,
}

function stateFilePath(directory: string): string {
  return join(directory, ".opencode", "state", "opencode-indexer", "state.json")
}

function readState(directory: string | null): IndexerState {
  if (!directory) return DEFAULT_STATE
  const path = stateFilePath(directory)
  if (!existsSync(path)) return DEFAULT_STATE
  try {
    const raw = readFileSync(path, "utf-8")
    return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_STATE
  }
}

// ─── Color helpers ─────────────────────────────────────────

// These escape codes work in OpenCode's TUI terminal renderer
const COLORS = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
}

function statusIndicator(state: IndexerState): string {
  switch (state.status) {
    case "ready":
      return `${COLORS.green}●${COLORS.reset} Ready`
    case "indexing":
      return `${COLORS.yellow}●${COLORS.reset} Indexing`
    case "error":
      return `${COLORS.red}●${COLORS.reset} Error`
    default:
      return `${COLORS.dim}○${COLORS.reset} Idle`
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString()
}

function progressBar(pct: number, width = 10): string {
  const filled = Math.round((pct / 100) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

// ─── Sidebar component ────────────────────────────────────

interface SidebarProps {
  directory: string | null
}

function Sidebar(props: SidebarProps): JSX.Element {
  const [state, setState] = createSignal<IndexerState>(DEFAULT_STATE)

  // Poll state file every 3 seconds
  createEffect(() => {
    const interval = setInterval(() => {
      setState(readState(props.directory))
    }, 3000)

    // Immediate first read
    setState(readState(props.directory))

    onCleanup(() => clearInterval(interval))
  })

  const s = state()

  return (
    <div>
      {/* Header */}
      <div>
        {COLORS.bold}Codebase Index{COLORS.reset}
      </div>

      {/* Status row */}
      <div>  {statusIndicator(s)}</div>

      {/* Progress bar (only during indexing) */}
      <Show when={s.status === "indexing"}>
        <div>  [{progressBar(s.progress)}] {s.progress}%</div>
      </Show>

      {/* Stats */}
      <div>  {COLORS.dim}Blocks:{COLORS.reset} {s.blocks}</div>
      <div>  {COLORS.dim}Files:{COLORS.reset} {s.files}</div>

      {/* Storage backend */}
      <Show when={s.dbPath}>
        <div>  {COLORS.dim}DB:{COLORS.reset} {s.dbPath}</div>
      </Show>

      {/* Last indexed */}
      <Show when={s.lastIndexed}>
        <div>  {COLORS.dim}Indexed:{COLORS.reset} {formatTime(s.lastIndexed)}</div>
      </Show>

      {/* Spacer */}
      <div> </div>
    </div>
  )
}

// ─── TUI Plugin ────────────────────────────────────────────

const id = "opencode-indexer" as const

const tui: TuiPlugin = async (api) => {
  // Register sidebar_content slot
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content: (_ctx, props) => {
        // Resolve the project directory from the session
        // The TUI plugin has limited directory info — we read from
        // api.state.path.directory which is the current project dir
        const dir = api.state.path.directory ?? null
        return <Sidebar directory={dir} />
      },
    },
  })
}

export default { id, tui }