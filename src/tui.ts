/**
 * TUI Plugin — Sidebar Progress Indicator
 *
 * Renders indexing progress in the OpenCode sidebar when the server
 * plugin is running codebase_index. Reads progress state from the
 * project's .codebase-index/.progress.json file.
 *
 * Entry point: imported from @opencode-ai/plugin/tui
 * Separate from the server plugin (index.ts) per OpenCode's dual-module pattern.
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
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
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

// ─── Phase Icons ──────────────────────────────────────────

const PHASE_ICONS: Record<string, string> = {
  idle: "○",
  scanning: "🔍",
  parsing: "📖",
  embedding: "⚡",
  saving: "💾",
  done: "✅",
  error: "❌",
}

// ─── Progress Bar Renderer ────────────────────────────────

function renderProgressBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width)
  const empty = width - filled
  return "█".repeat(filled) + "░".repeat(empty)
}

function formatProgress(state: ProgressState): string {
  const icon = PHASE_ICONS[state.phase] ?? "○"
  const bar = renderProgressBar(state.percentage)
  const pct = `${state.percentage}%`.padStart(4)

  if (state.phase === "done") {
    return `${icon} Indexed`
  }
  if (state.phase === "error") {
    return `${icon} ${state.message}`
  }
  if (state.phase === "idle") {
    return `${icon} Ready`
  }

  return `${icon} ${bar} ${pct}\n   ${state.message}`
}

// ─── TUI Plugin ───────────────────────────────────────────

export const tui: TuiPlugin = async (api, _options, _meta) => {
  // Only activate for projects with the .codebase-index marker
  const projectDir = api.state.path.directory
  const markerPath = join(projectDir, ".codebase-index")

  if (!existsSync(markerPath)) return

  // Register sidebar content slot
  api.slots.register({
    name: "opencode-indexer-progress",
    slots: ["sidebar_content"],
    render(slot, _ctx) {
      if (slot.name !== "sidebar_content") return null

      const progress = readProgress(projectDir)

      // Render nothing if no progress file exists (not yet indexed)
      if (!progress) return null

      // After 30 seconds of being "done", don't show anything
      if (progress.phase === "done") {
        const age = Date.now() - new Date(progress.updatedAt).getTime()
        if (age > 30_000) return null
      }

      const text = formatProgress(progress)

      // Return a simple text renderable
      return {
        type: "text",
        value: text,
      }
    },
  })
}
