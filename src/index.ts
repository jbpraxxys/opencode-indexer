/**
 * OpenCode Plugin — Codebase Indexing
 *
 * Tools:
 *   codebase_index   — Scan & embed workspace into vector store
 *   codebase_search  — Semantic search across indexed code
 *   codebase_status  — Check index stats
 *
 * Auto-indexing: Projects with a `.codebase-index` marker file in their root
 * are opted in. The plugin auto-indexes on first tool use and keeps the index
 * up to date. No marker file = no indexing.
 *
 * To opt in:
 *   touch ~/Sites/my-project/.codebase-index
 *
 * Config in opencode.json (LanceDB is the default — zero setup needed):
 *   {
 *     "plugin": [["opencode-indexer", {
 *       "embedder": "ollama",
 *       "vectorStore": "lancedb"
 *     }]]
 *   }
 */

import { tool } from '@opencode-ai/plugin/tool';
import type { PluginOptions, PluginInput } from '@opencode-ai/plugin';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import {
    CodebaseIndexer,
    loadProjectIgnore,
    type IndexerConfig,
    getCurrentBranch,
    getStoredBranch,
    setStoredBranch,
} from './engine.js';
import chokidar from 'chokidar';

const z = tool.schema;

// Track per-directory auto-index attempts so we only try once per session
const autoIndexed = new Set<string>();

const MARKER_FILE = '.codebase-index';

function hasMarker(directory: string): boolean {
    return existsSync(join(directory, MARKER_FILE));
}

// Module-level cache: workspacePath → CodebaseIndexer instance
const indexers = new Map<string, CodebaseIndexer>();

function getIndexer(directory: string, config: IndexerConfig = {}): CodebaseIndexer {
    if (indexers.has(directory)) return indexers.get(directory)!;
    const indexer = new CodebaseIndexer(directory, config);
    indexers.set(directory, indexer);
    return indexer;
}

/**
 * If the project has a .codebase-index marker and no index exists yet,
 * automatically build one. Returns true if index was created or already exists.
 */
async function ensureIndexed(
    directory: string,
    indexer: CodebaseIndexer,
    config: IndexerConfig
): Promise<string | null> {
    if (!hasMarker(directory)) return null;

    const autoKey = `${directory}`;
    try {
        const embedderOk = config.embedder === 'openai' || config.embedder === 'ollama' || true; // default is ollama

        if (embedderOk) {
            await indexer.ensureReady();
            await indexer.init();
        }

        // Check if index already exists
        const stats = await indexer.stats();
        if (stats.blocks > 0) {
            return null; // Already indexed
        }

        // Auto-index on first use, but only once per session
        if (autoIndexed.has(autoKey)) return null;
        autoIndexed.add(autoKey);

        const { files, blocks } = await indexer.index(directory);
        return `✅ Auto-indexed ${files} files → ${blocks} code blocks`;
    } catch (err: any) {
        return `⚠ Auto-index failed: ${err.message}`;
    }
}

// ─── Tool 1: Index ────────────────────────────────────────

function makeCodebaseIndex(pluginConfig: IndexerConfig) {
    return tool({
        description:
            'Index the workspace codebase for semantic code search. ' +
            'Uses tree-sitter AST parsing for Python, TypeScript, JavaScript, and PHP ' +
            'to extract functions, classes, and methods as semantic blocks. ' +
            'Falls back to line-based chunking for other languages. ' +
            'Hash caching skips unchanged files on re-index — fast incremental updates. ' +
            'Run this once before searching. Re-run when code changes. ' +
            'Requires a .codebase-index marker file in the project root to proceed.',
        args: {
            force: z.boolean().describe('Force re-index even if index exists'),
        },
        async execute(args, ctx) {
            // Require opt-in marker
            if (!hasMarker(ctx.directory)) {
                return {
                    output:
                        '❌ This project is not opted into codebase indexing.\n\n' +
                        'Create a `.codebase-index` file in the project root to opt in:\n' +
                        '  touch ' +
                        join(ctx.directory, '.codebase-index') +
                        '\n\n' +
                        'Then run codebase_index again.',
                };
            }

            const indexer = getIndexer(ctx.directory, pluginConfig);

            try {
                await indexer.ensureReady();
            } catch (err: any) {
                return {
                    output:
                        `❌ Embedding service not available: ${err.message}\n` +
                        'Make sure Ollama is running or your OpenAI-compatible endpoint is reachable.',
                };
            }

            await indexer.init();

            if (!args.force) {
                const stats = await indexer.stats();
                if (stats.blocks > 0) {
                    return {
                        output:
                            `✅ Index exists with ${stats.blocks} blocks.\n` +
                            `Storage: ${stats.dbPath}\n` +
                            'Use force=true to re-index.',
                    };
                }
            }

            const { files, blocks } = await indexer.index(ctx.directory, () => {
                // TUI sidebar reads live progress from progress file — textarea output is suppressed
            });

            // Write state for TUI sidebar
            const stats = await indexer.stats();
            writeState(ctx.directory, {
                status: 'ready',
                files,
                blocks: stats.blocks,
                dbPath: stats.dbPath,
                lastIndexed: new Date().toISOString(),
                phase: 'done',
                progress: 100,
            });

            return {
                output:
                    `✅ Indexed ${files} files → ${blocks} code blocks.\n` +
                    'Search with: codebase_search "your query"',
            };
        },
    });
}

// ─── Tool 2: Search ───────────────────────────────────────

function makeCodebaseSearch(pluginConfig: IndexerConfig) {
    return tool({
        description:
            'Search the indexed codebase using natural language. ' +
            'Returns the most relevant code blocks with file paths, line numbers, and similarity scores. ' +
            "Use this to find code before reading files — it's faster and finds cross-file patterns. " +
            'Requires a .codebase-index marker file in the project root.',
        args: {
            query: z.string().describe("What code you're looking for"),
            maxResults: z.number().optional().describe('Max results (default 20)'),
        },
        async execute(args, ctx) {
            // Require opt-in marker
            if (!hasMarker(ctx.directory)) {
                return {
                    output:
                        '❌ This project is not opted into codebase indexing.\n\n' +
                        'Create a `.codebase-index` file in the project root to opt in:\n' +
                        '  touch ' +
                        join(ctx.directory, '.codebase-index') +
                        '\n\n' +
                        'Then run codebase_index first, then search.',
                };
            }

            const config = { ...pluginConfig, maxResults: args.maxResults };
            const indexer = getIndexer(ctx.directory, config);

            try {
                await indexer.ensureReady();
            } catch (err: any) {
                return { output: `❌ Embedding service not available: ${err.message}` };
            }

            await indexer.init();

            // Auto-index if needed (first tool use in an opted-in project)
            const autoMsg = await ensureIndexed(ctx.directory, indexer, config);
            if (autoMsg) {
                // Index was just built — write state for TUI sidebar
                const s = await indexer.stats();
                writeState(ctx.directory, {
                    status: 'ready',
                    files: s.blocks > 0 ? s.blocks : 0,
                    blocks: s.blocks,
                    dbPath: s.dbPath,
                    lastIndexed: new Date().toISOString(),
                    phase: 'done',
                    progress: 100,
                });

                // Search immediately
                const results = await indexer.search(args.query);
                if (results.length === 0) {
                    return { output: `${autoMsg}\n\nNo results for "${args.query}". Try different wording.` };
                }
                return {
                    output: `${autoMsg}\n\n${formatResults(results)}`,
                    metadata: { resultCount: results.length, query: args.query },
                };
            }

            const stats = await indexer.stats();
            if (stats.blocks === 0) {
                writeState(ctx.directory, { status: 'idle', phase: 'idle', progress: 0 });
                return {
                    output:
                        '📭 No index found. Run codebase_index to create one.\n\n' +
                        '(This project has a .codebase-index marker, so auto-indexing was attempted but failed.)',
                };
            }

            // Write state for TUI sidebar (don't update lastIndexed — no indexing happened)
            writeState(ctx.directory, {
                status: 'ready',
                blocks: stats.blocks,
                dbPath: stats.dbPath,
                phase: 'done',
                progress: 100,
            });

            const results = await indexer.search(args.query);

            if (results.length === 0) {
                return { output: `No results for "${args.query}". Try different wording.` };
            }

            return {
                output: formatResults(results),
                metadata: { resultCount: results.length, query: args.query, totalIndexed: stats.blocks },
            };
        },
    });
}

// ─── Tool 3: Status ───────────────────────────────────────

function makeCodebaseStatus(pluginConfig: IndexerConfig) {
    return tool({
        description:
            'Check codebase index status — exists, block count, storage backend. ' +
            'Also shows whether this project is opted into indexing (via .codebase-index marker).',
        args: {},
        async execute(_args, ctx) {
            const marker = hasMarker(ctx.directory);
            const markerStatus = marker
                ? '✅ Opted in (.codebase-index found)'
                : '❌ Not opted in (no .codebase-index)';

            // Auto-index if marker exists and no index
            if (marker) {
                const indexer = getIndexer(ctx.directory, pluginConfig);
                try {
                    const autoMsg = await ensureIndexed(ctx.directory, indexer, pluginConfig);
                    if (autoMsg) {
                        const stats = await indexer.stats();
                        writeState(ctx.directory, {
                            status: 'ready',
                            blocks: stats.blocks,
                            dbPath: stats.dbPath,
                            lastIndexed: new Date().toISOString(),
                            phase: 'done',
                            progress: 100,
                        });
                        return {
                            output:
                                `${markerStatus}\n${autoMsg}\n\n` + `Blocks: ${stats.blocks}\nStorage: ${stats.dbPath}`,
                        };
                    }

                    await indexer.init();
                    const stats = await indexer.stats();
                    if (stats.blocks === 0) {
                        writeState(ctx.directory, { status: 'idle', phase: 'idle', progress: 0 });
                        return {
                            output: `${markerStatus}\n📭 No index yet. Run codebase_index to create one.`,
                        };
                    }

                    writeState(ctx.directory, {
                        status: 'ready',
                        blocks: stats.blocks,
                        dbPath: stats.dbPath,
                        phase: 'done',
                        progress: 100,
                    });
                    return {
                        output:
                            `${markerStatus}\n\n` +
                            `📊 Codebase Index\n` +
                            `  Blocks: ${stats.blocks}\n` +
                            `  Storage: ${stats.dbPath}`,
                    };
                } catch {
                    return {
                        output: `${markerStatus}\n📭 No index. Run codebase_index to create one.`,
                    };
                }
            }

            return {
                output: `${markerStatus}\n\nTo opt in:\n  touch ${join(ctx.directory, '.codebase-index')}`,
            };
        },
    });
}

// ─── Formatting ────────────────────────────────────────────

function formatResults(results: any[]): string {
    return results
        .map((r, i) => {
            const preview = r.content.length > 400 ? r.content.slice(0, 400) + '...' : r.content;
            return [
                `### ${i + 1}. ${r.relativePath}:${r.startLine}-${r.endLine}`,
                `Score: ${r.score.toFixed(3)} | Language: ${r.language}`,
                '```' + r.language,
                preview,
                '```',
            ].join('\n');
        })
        .join('\n\n');
}

// ─── Watchable extensions (matches engine.ts EXTENSIONS) ────

const WATCH_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.css',
    '.scss',
    '.html',
    '.vue',
    '.svelte',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.sh',
    '.bash',
    '.php',
    '.swift',
    '.zig',
]);

// ─── State writer for TUI sidebar ────────────────────────

interface IndexerState {
    status: 'idle' | 'indexing' | 'ready' | 'error';
    files: number;
    blocks: number;
    dbPath: string;
    lastIndexed: string | null;
    phase: string;
    progress: number;
}

function stateFilePath(directory: string): string {
    return join(directory, '.opencode', 'state', 'opencode-indexer', 'state.json');
}

function writeState(directory: string, partial: Partial<IndexerState>): void {
    const path = stateFilePath(directory);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Read existing state to merge
    let existing: Partial<IndexerState> = {};
    try {
        if (existsSync(path)) existing = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        /* ignore */
    }

    const state: IndexerState = {
        status: 'idle',
        files: 0,
        blocks: 0,
        dbPath: '',
        lastIndexed: null,
        phase: 'idle',
        progress: 0,
        ...existing,
        ...partial,
    };

    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Plugin Server ────────────────────────────────────────

export const server = async (input: PluginInput, options: PluginOptions) => {
    const pluginConfig = (options ?? {}) as IndexerConfig;
    let watcher: import('chokidar').FSWatcher | null = null;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 600;

    async function ensureWatchReady(directory: string): Promise<CodebaseIndexer | null> {
        if (!hasMarker(directory)) return null;
        try {
            const idx = getIndexer(directory, pluginConfig);
            if (!idx.isReady()) {
                await idx.ensureReady();
                await idx.init();
            }
            return idx;
        } catch {
            return null;
        }
    }

    // Start file watcher if the project is opted in
    const projectDir = input.directory;
    if (projectDir && hasMarker(projectDir)) {
        // Eagerly initialize the indexer so the watcher is ready immediately
        (async () => {
            try {
                const idx = getIndexer(projectDir, pluginConfig);
                await idx.ensureReady();
                await idx.init();
            } catch { /* will retry on first file change via ensureWatchReady */ }
        })();

        const projectIgnore = loadProjectIgnore(projectDir);
        watcher = chokidar.watch(projectDir, {
            ignored: (path: string, stats?: any) => {
                const ext = extname(path);
                const rel = relative(projectDir, path);
                if (!rel) return false;
                // Directories: only check ignore rules (never filter by extension)
                if (!ext) return projectIgnore.ignores(rel);
                // Files: check extension then ignore rules
                if (!WATCH_EXTENSIONS.has(ext)) return true;
                return projectIgnore.ignores(rel);
            },
            persistent: true,
            ignoreInitial: true,
            depth: 20,
        });

        watcher.on('all', (event: string, filePath: string) => {
            // Only care about add/change/unlink for files
            if (event === 'addDir' || event === 'unlinkDir') return;

            // Debounce
            const existing = debounceTimers.get(filePath);
            if (existing) clearTimeout(existing);

            debounceTimers.set(
                filePath,
                setTimeout(async () => {
                    debounceTimers.delete(filePath);
                    const relPath = relative(projectDir, filePath);

                    if (event === 'unlink') {
                        const idx = getIndexer(projectDir, pluginConfig);
                        try {
                            await idx.deleteFile(filePath);
                        } catch {
                            /* indexer not ready */
                        }
                        return;
                    }

                    // add / change — re-index the file
                    const idx = await ensureWatchReady(projectDir);
                    if (!idx) return;

                    try {
                        await idx.indexFile(filePath);
                    } catch (err: any) {}
                }, DEBOUNCE_MS)
            );
        });

        // Watcher started silently (no console.log — output goes to TUI textarea)
    }

    // ─── Branch polling (opt-in via branchAware config) ──────
    let branchInterval: ReturnType<typeof setInterval> | null = null;
    if (projectDir && hasMarker(projectDir) && pluginConfig.branchAware) {
        let lastBranch = getCurrentBranch(projectDir);
        const pollMs = pluginConfig.branchPollMs ?? 3000;

        branchInterval = setInterval(async () => {
            try {
                const current = getCurrentBranch(projectDir);
                if (!current || current === lastBranch) return;

                // Branch change detected — full re-index with hash caching
                // TUI sidebar reads live progress from progress file — no console.log needed
                const idx = getIndexer(projectDir, pluginConfig);
                await idx.ensureReady();
                await idx.init();

                // Store the new branch BEFORE indexing so the marker is correct
                // even if indexing fails partway through (next run fixes it)
                lastBranch = current;

                await idx.index(projectDir);
            } catch (err: any) {
                console.error(`⚠ Branch poll error:`, err.message ?? err);
            }
        }, pollMs);
    }

    return {
        tool: {
            codebase_index: makeCodebaseIndex(pluginConfig),
            codebase_search: makeCodebaseSearch(pluginConfig),
            codebase_status: makeCodebaseStatus(pluginConfig),
        },
        'experimental.chat.system.transform': async (_input: any, output: any) => {
            const backend = pluginConfig.vectorStore ?? 'lancedb';
            output.system.push(
                '## Codebase Indexing\n' +
                    'You have access to codebase indexing tools for semantic code search:\n\n' +
                    `- **codebase_index** — Build/refresh the codebase index (storage: ${backend}).\n` +
                    '  Uses tree-sitter AST parsing (TS, JS, Python, PHP) for semantic blocks. Hash caching skips unchanged files.\n' +
                    '  Requires `.codebase-index` marker file in the project root (auto-index on first use).\n' +
                    '- **codebase_search** — Natural language search across indexed code.\n' +
                    '- **codebase_status** — Check if indexing is set up.\n\n' +
                    '### Search Priority Rule ⚠️\n' +
                    '**This is the most important rule. Violating it wastes context and misses results.**\n\n' +
                    "**Precondition:** Before any code search, if you're unsure whether the project is opted in, " +
                    "call `codebase_status()` first. It's free (no embedding call) and tells you instantly. " +
                    'The rules below apply once the project IS opted in and indexed.\n\n' +
                    '```\n' +
                    'Search demand received (find code, locate logic, understand behavior)\n' +
                    '    ↓\n' +
                    'codebase_status()               ← First: is project opted in?\n' +
                    '    ↓\n' +
                    'Not opted in? → Tell user: touch .codebase-index\n' +
                    '    ↓ YES\n' +
                    'codebase_search(query)          ← Always use semantic search first\n' +
                    '    ↓\n' +
                    'Results found? → YES → Done.\n' +
                    '    ↓ NO\n' +
                    'Rephrase query. Try again.\n' +
                    '    ↓\n' +
                    'Still no results?\n' +
                    '    ↓\n' +
                    'grep / glob / find              ← ONLY as last resort\n' +
                    '```\n\n' +
                    '1. **Call `codebase_status()` first** if unsure about opt-in (instant, no API call).\n' +
                    '2. **ALWAYS use `codebase_search` first** for every code search (once opted in).\n' +
                    '3. If no results, **rephrase your query** and try again before falling back.\n' +
                    '4. Only after `codebase_search` fails with rephrased queries, use `grep`, `glob`, or `find`.\n' +
                    '5. **Do not use both simultaneously** — try search first, fall back only if needed.\n\n' +
                    '### Rationalization Table — DO NOT Make These Excuses\n\n' +
                    '| Excuse | Reality |\n' +
                    '|--------|---------|\n' +
                    '| "I know the exact function name, grep is faster" | `codebase_search` finds it AND shows related code grep misses |\n' +
                    '| "This is just a quick lookup" | Quick lookups benefit most from semantic search |\n' +
                    '| "I need ALL occurrences" | Valid fallback case — but try `codebase_search` first |\n' +
                    '| "The codebase isn\'t indexed yet" | Call `codebase_status()` first — auto-index on first use handles it |\n' +
                    '| "I\'m not sure what to search for" | Semantic search handles vague queries better than grep |\n' +
                    '| "Grep is more reliable" | Hash-cached index with file watching. Always fresh. |\n' +
                    '| "Let me just grep first to see what\'s there" | This is the #1 violation. Use `codebase_search` first. |\n\n' +
                    '### Red Flags — STOP and Use codebase_search\n\n' +
                    '- About to type `grep` for a code question\n' +
                    '- About to type `glob` to find files by function/class name\n' +
                    '- Thinking "let me just grep first to see what\'s there"\n' +
                    '- Not sure what to search for (semantic search handles vague queries)\n' +
                    '- Question is about **behavior** ("how does X work?") not text matching\n\n' +
                    '### New Project Flow — Check Status FIRST\n\n' +
                    "When entering a project where you don't know if indexing is set up:\n\n" +
                    '```\n' +
                    'codebase_status()               ← ALWAYS first — instant, free, no API call\n' +
                    '    ↓\n' +
                    'Not opted in? → Tell user: touch .codebase-index to enable\n' +
                    '    ↓\n' +
                    'Opted in, no index? → codebase_index() (auto-index on first use handles this)\n' +
                    '    ↓\n' +
                    'Opted in, index ready? → codebase_search("your query")\n' +
                    '```\n\n' +
                    '**Why `codebase_status` first?** `codebase_search` on a non-opted-in project fails immediately. ' +
                    '`codebase_status` is a single call that tells you everything: opt-in status, block count, storage backend. ' +
                    'No embedding API waste. One call instead of N parallel failures.\n\n' +
                    'Auto-indexing happens on first tool use in opted-in projects. The file watcher keeps the index ' +
                    'current as you edit code. Hash caching skips unchanged files — re-indexing is fast. ' +
                    (pluginConfig.branchAware
                        ? '**Branch-aware indexing is enabled** — the index auto-updates when you switch git branches. '
                        : '')
            );

            // Also remind the agent to load the codebase-search skill for full guidance
            output.system.push(
                '💡 **Load the `codebase-search` skill** for full search priority rules, ' +
                    'query tips, troubleshooting, and configuration details. The skill contains ' +
                    "additional guidance beyond what's summarized here."
            );
        },
        dispose: async () => {
            if (watcher) {
                await watcher.close();
                // File watcher stopped silently — TUI sidebar reflects state
            }
            if (branchInterval) {
                clearInterval(branchInterval);
                branchInterval = null;
            }
            // Clear all debounce timers
            for (const timer of Array.from(debounceTimers.values())) {
                clearTimeout(timer);
            }
            debounceTimers.clear();
        },
    };
};
