/**
 * TUI Plugin — Presence Indicator (minimal)
 *
 * The full progress display lives in the server plugin's tool output
 * (visible in the chat textarea during indexing). This TUI plugin is
 * a lightweight presence marker — it tells OpenCode that codebase
 * indexing tools are available, nothing more.
 *
 * SolidJS sidebar widgets require @opentui/solid + solid-js runtime
 * which adds fragile dependency chains. The textarea output is more
 * reliable and already shows full progress with phase icons, counts,
 * and percentages.
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { existsSync } from "fs"
import { join } from "path"

export const tui: TuiPlugin = async (api, _options, _meta) => {
  const projectDir = api.state.path.directory
  const markerPath = join(projectDir, ".codebase-index")

  // Only activate for opted-in projects
  if (!existsSync(markerPath)) return

  // Mark presence in kv store (server plugin can check this)
  await api.kv.set("opencode-indexer:active", "1")
}
