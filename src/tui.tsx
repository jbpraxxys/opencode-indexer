/**
 * TUI Plugin — Sidebar Progress Indicator
 *
 * Renders indexing progress in the OpenCode sidebar during codebase_index.
 * Reads progress state from .codebase-index-progress.json at the project root.
 *
 * Uses @opentui/solid JSX — required by OpenCode's slot rendering system.
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

// ─── Helpers ──────────────────────────────────────────────

const PHASE_ICONS: Record<string, string> = {
  idle: "○",
  scanning: "🔍",
  parsing: "📖",
  embedding: "⚡",
  saving: "💾",
  done: "✅",
  error: "❌",
}

function readProgress(root: string): ProgressState | null {
  const path = join(root, ".codebase-index-progress.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

// ─── TUI Plugin ───────────────────────────────────────────

export const tui: TuiPlugin = async (api, _options, _meta) => {
  const projectDir = api.state.path.directory
  const markerPath = join(projectDir, ".codebase-index")

  if (!existsSync(markerPath)) return

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content: (_ctx, _props) => {
        const progress = readProgress(projectDir)
        if (!progress) return null

        // Hide "done" or "idle" after 30 seconds
        if (progress.phase === "done" || progress.phase === "idle") {
          const age = Date.now() - new Date(progress.updatedAt).getTime()
          if (age > 30_000) return null
        }

        // Don't show for idle with no timestamp (never indexed)
        if (progress.phase === "idle" && !progress.updatedAt) return null

        const icon = PHASE_ICONS[progress.phase] ?? "○"
        const pct = progress.percentage > 0 ? ` ${progress.percentage}%` : ""
        const text = `${icon}${pct} ${progress.message}`

        return <text content={text} />
      },
    },
  })
}
