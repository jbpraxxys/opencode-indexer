/** @jsxImportSource @opentui/solid */
import { createSignal, Show, onCleanup, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

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

function commandFilePath(projectDir: string): string {
  return join(projectDir, ".opencode", "state", "opencode-indexer", "command.json")
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

/** Write a command file that the server poller will pick up within 1s */
function sendCommand(projectDir: string, action: string): void {
  const path = commandFilePath(projectDir)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify({ action, timestamp: new Date().toISOString() }, null, 2), "utf-8")
}

function buildBar(percent: number): { bar: string; clamped: number } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((clamped / 100) * BAR_WIDTH)))
  return {
    bar: `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`,
    clamped,
  }
}

interface ControlButton {
  icon: string
  label: string
  action: string
  color: string
}

const BUTTONS: ControlButton[] = [
  { icon: "▶", label: "Start",  action: "start",   color: "green" },
  { icon: "⏸", label: "Pause",  action: "pause",   color: "yellow" },
  { icon: "⏹", label: "Stop",   action: "stop",    color: "red" },
  { icon: "⟲", label: "Reindex", action: "reindex", color: "cyan" },
]

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const [data, setData] = createSignal<ProgressState | null>(null)
  const [breath, setBreath] = createSignal(false)
  const [lastAction, setLastAction] = createSignal<string | null>(null)

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

  // Clear "last action" feedback after 3s
  let actionTimeout: ReturnType<typeof setTimeout> | null = null
  const triggerAction = (action: string) => {
    sendCommand(projectDir, action)
    setLastAction(action)
    if (actionTimeout) clearTimeout(actionTimeout)
    actionTimeout = setTimeout(() => setLastAction(null), 3000)
  }

  onCleanup(() => {
    clearInterval(pollInterval)
    clearInterval(breathInterval)
    if (actionTimeout) clearTimeout(actionTimeout)
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

  const isBusy = () => {
    const label = phaseLabel()
    return label !== "idle" && label !== "done" && pct().percent < 100
  }

  return (
    <box flexDirection="column">
      {/* Header */}
      <box flexDirection="row">
        <text fg={indicatorColor()}>{indicator()}</text>
        <text> </text>
        <text attributes={TextAttributes.BOLD}>⚡ Codebase Indexing</text>
        <text> </text>
        <text fg={barColor()}>{phaseLabel()}</text>
      </box>

      {/* Progress bar */}
      <text fg={barColor()}>{`${pct().bar} ${pct().percent}%`}</text>

      {/* Stats */}
      <text fg={theme().textMuted}>{`${fileCount()} files · ${blockCount()} blocks`}</text>
      <Show when={lastIndexed()}>
        <text>{`Last: ${formatTime(lastIndexed())}`}</text>
      </Show>

      {/* Control buttons — clickable + keyboard navigable */}
      <box flexDirection="row" marginTop={1}>
        <For each={BUTTONS}>
          {(btn) => (
            <box
              focusable
              focusedBorderColor={btn.color}
              onMouseDown={() => triggerAction(btn.action)}
              marginRight={1}
              border
              borderColor={theme().border}
            >
              <text fg={btn.color}>{`${btn.icon} ${btn.label}`}</text>
            </box>
          )}
        </For>
      </box>

      {/* Action feedback toast */}
      <Show when={lastAction()}>
        <text fg={theme().accent}>  ↳ Sent: {lastAction()}</text>
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
