/**
 * TUI Plugin — Sidebar Indexing Progress (Kilo Code pattern)
 *
 * Registers into the sidebar_content slot and renders live indexing
 * progress. Polls .codebase-index-progress.json every second while
 * indexing is active. Uses solid-js for reactivity and @opentui/solid
 * for JSX intrinsic elements (text, box, b).
 *
 * Pattern adapted from Kilo Code's sidebar-indexing.tsx plugin
 * (PR #10866: fix(cli): move indexing status to sidebar).
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

// ─── Types ────────────────────────────────────────────────

interface ProgressState {
  phase: "idle" | "scanning" | "parsing" | "embedding" | "saving" | "done" | "error"
  message: string
  current: number
  total: number
  percentage: number
  updatedAt: string
}

// ─── Progress Reader ──────────────────────────────────────

function readProgress(root: string): ProgressState | null {
  const path = join(root, ".codebase-index-progress.json")
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return null }
}

// ─── Label Formatter ──────────────────────────────────────

function formatLabel(p: ProgressState): string {
  if (p.phase === "scanning") return "Scanning files..."
  if (p.phase === "parsing") return `${p.percentage}% (${p.current}/${p.total} files)`
  if (p.phase === "embedding") return `${p.percentage}% (${p.current}/${p.total} blocks)`
  if (p.phase === "saving") return "Saving vectors..."
  if (p.phase === "done") return "Complete"
  if (p.phase === "error") return p.message || "Failed"
  if (p.phase === "idle") return "Ready"
  return p.phase
}

// ─── Component ────────────────────────────────────────────

function View(props: { projectDir: string; api: any }) {
  const theme = () => props.api.theme.current

  const [progress, setProgress] = createSignal<ProgressState | null>(
    readProgress(props.projectDir),
  )

  const label = createMemo(() => {
    const p = progress()
    if (!p) return "Not indexed"
    return formatLabel(p)
  })

  // Color based on phase
  const fg = createMemo(() => {
    const p = progress()
    if (!p) return theme().textMuted
    if (p.phase === "done") return theme().success
    if (p.phase === "error") return theme().error
    if (p.phase === "scanning" || p.phase === "parsing" || p.phase === "embedding")
      return theme().warning
    return theme().textMuted
  })

  // Poll the progress file every second while indexing is active
  onMount(() => {
    const timer = setInterval(() => {
      const p = readProgress(props.projectDir)
      setProgress(p)

      // Stop polling after done + 30 seconds
      if (p && p.phase === "done") {
        const age = Date.now() - new Date(p.updatedAt).getTime()
        if (age > 30_000) clearInterval(timer)
      }
    }, 1000)

    onCleanup(() => clearInterval(timer))
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Code Indexing</b>
      </text>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} style={{ fg: fg() }}>
          •
        </text>
        <text fg={fg()} wrapMode="word">
          {label()}
        </text>
      </box>
      <Show when={progress()?.message && progress()!.phase !== "idle"}>
        {(msg) => <text fg={theme().textMuted}>{msg()}</text>}
      </Show>
    </box>
  )
}

// ─── Plugin Entry ─────────────────────────────────────────

export const tui: TuiPlugin = async (api) => {
  const projectDir = api.state.path.directory
  const markerPath = join(projectDir, ".codebase-index")

  if (!existsSync(markerPath)) return

  api.slots.register({
    order: 225,
    slots: {
      sidebar_content() {
        return <View projectDir={projectDir} api={api} />
      },
    },
  })
}
