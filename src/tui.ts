/**
 * TUI Plugin — Minimal (no SolidJS dependency)
 *
 * External TUI plugins cannot resolve solid-js / @opentui/solid at
 * runtime in OpenCode's plugin sandbox. These packages are available
 * only to internal plugins bundled with OpenCode itself.
 *
 * The full indexing progress is displayed in the server plugin's tool
 * output (textarea). This TUI plugin is a no-op presence marker.
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { existsSync } from "fs"
import { join } from "path"

export const tui: TuiPlugin = async (api, _options, _meta) => {
  const projectDir = api.state.path.directory
  const markerPath = join(projectDir, ".codebase-index")

  // Only activate for opted-in projects
  if (!existsSync(markerPath)) return

  // Mark presence in kv store
  await api.kv.set("opencode-indexer:active", "1")
}
