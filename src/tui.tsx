/** @jsxImportSource @opentui/solid */
import { createSignal, Show, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const BAR_WIDTH = 24

interface ProgressState {
  phase: string
  message?: string
  percentage?: number
  files?: number
  blocks?: number
  lastIndexed?: string | null
  status?: string
  progress?: number
}

function progressFilePath(projectDir: string): string {
  return join(projectDir, ".codebase-index-store", "progress.json")
}

function stateFilePath(projectDir: string): string {
  return join(projectDir, ".opencode", "state", "opencode-indexer", "state.json")
}

function readState(projectDir: string): ProgressState | null {
  const progressP = progressFilePath(projectDir)
  try {
    if (existsSync(progressP)) return JSON.parse(readFileSync(progressP, "utf-8"))
  } catch { /* ignore */ }
  const stateP = stateFilePath(projectDir)
  try {
    if (existsSync(stateP)) return JSON.parse(readFileSync(stateP, "utf-8"))
  } catch { /* ignore */ }
  return null
}

function buildBar(percent: number): { bar: string; clamped: number } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH)))
  return {
    bar: `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`,
    clamped,
  }
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const [data, setData] = createSignal<ProgressState | null>(null)
  const [breath, setBreath] = createSignal(false)

  const projectDir = props.api.state.path.directory?.trim() || process.cwd()

  const poll = () => {
    try { setData(readState(projectDir)) } catch { /* best-effort */ }
  }
  poll()
  const pollInterval = setInterval(poll, 2000)

  const breathInterval = setInterval(() => {
    const d = data()
    const p = d?.percentage ?? d?.progress ?? 0
    const label = d?.phase || d?.status || "idle"
    if (p > 0 && p < 100 && label !== "done" && label !== "idle") {
      setBreath(b => !b)
    }
  }, 500)

  onCleanup(() => {
    clearInterval(pollInterval)
    clearInterval(breathInterval)
  })

  const theme = () => props.api.theme.current

  const phaseLabel = () => {
    const d = data()
    if (!d) return "idle"
    return d.phase || d.status || "idle"
  }

  const pct = () => {
    const d = data()
    const p = d?.percentage ?? d?.progress ?? 0
    const bar = buildBar(p)
    return { bar: bar.bar, percent: bar.clamped }
  }

  const indicatorColor = () => {
    const label = phaseLabel()
    const p = pct().percent
    if (p === 100 && (label === "done" || label === "idle")) return theme().success
    if (label === "idle") return theme().textMuted
    return breath() ? theme().accent : theme().warning
  }

  const barColor = () => {
    const label = phaseLabel()
    if (label === "done") return theme().success
    if (label === "idle") return theme().textMuted
    return theme().accent
  }

  const indicator = () => {
    const p = pct().percent
    if (p === 100) return "●"
    if (phaseLabel() !== "idle") return "●"
    return "○"
  }

  const formatTime = (iso: string): string => {
    const d = new Date(iso)
    const now = Date.now()
    const diffMs = now - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return "just now"
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }

  const fileCount = () => data()?.files ?? 0
  const blockCount = () => data()?.blocks ?? 0
  const lastIndexed = () => data()?.lastIndexed || ""

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text attributes={TextAttributes.BOLD}>Codebase Indexing</text>
        <text> </text>
        <text fg={indicatorColor()}>{indicator()}</text>
        <text> </text>
        <text>{`${pct().percent}%`}</text>
      </box>
      <text fg={barColor()}>{phaseLabel()}</text>
      <text fg={theme().textMuted}>{`${fileCount()} files · ${blockCount()} blocks`}</text>
      <Show when={lastIndexed()}>
        <text>{`Last: ${formatTime(lastIndexed())}`}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const { slots } = api
  slots.register({
    order: 30,
    slots: {
      sidebar_content(_ctx: any, props: any) {
        return <View api={api} sessionID={props?.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-indexer",
  tui,
}

export default plugin
