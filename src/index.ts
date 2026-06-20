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
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import {
    CodebaseIndexer,
    loadProjectIgnore,
    writeProgressFile,
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

function isOptedIn(directory: string, config: IndexerConfig): boolean {
    return config.autoIndex === true || hasMarker(directory);
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
    if (!isOptedIn(directory, config)) return null;

    const autoKey = `${directory}`;
    try {
        await indexer.ensureReady();
        await indexer.init();

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
            // Require opt-in marker or autoIndex
            if (!isOptedIn(ctx.directory, pluginConfig)) {
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
            // Require opt-in marker or autoIndex
            if (!isOptedIn(ctx.directory, pluginConfig)) {
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
            const marker = isOptedIn(ctx.directory, pluginConfig);
            const markerStatus = marker
                ? '✅ Opted in (autoIndex or .codebase-index found)'
                : '❌ Not opted in (no .codebase-index, autoIndex disabled)';

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

// ── Control tool: start / pause / stop / reindex ──────────

function makeCodebaseControl(pluginConfig: IndexerConfig) {
    return tool({
        description:
            'Manually control the codebase indexer: start, pause, stop, or force re-index. ' +
            'Useful when you want to explicitly manage indexing without waiting for auto-index.',
        args: {
            action: z.enum(['start', 'pause', 'stop', 'reindex']).describe(
                'start: begin indexing. pause: stop live watcher. stop: abort current indexing. reindex: full re-scan.'
            ),
        },
        async execute(args, ctx) {
            if (!isOptedIn(ctx.directory, pluginConfig)) {
                return {
                    output:
                        '❌ Not opted in. Create .codebase-index or enable autoIndex.',
                };
            }
            const action = args.action as string;
            writeCommand(ctx.directory, action as any);
            const labels: Record<string, string> = {
                start: '▶ Indexing started',
                pause: '⏸ Watcher paused (existing index preserved)',
                stop: '⏹ Abort signal sent',
                reindex: '⟲ Full re-index started',
            };
            return {
                output: `${labels[action] || action} — check codebase_status for progress.`,
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

// ─── Command file for TUI/CLI control ────────────────────

interface IndexerCommand {
    action: 'start' | 'pause' | 'stop' | 'reindex';
    timestamp: string;
}

export function commandFilePath(directory: string): string {
    return join(directory, '.opencode', 'state', 'opencode-indexer', 'command.json');
}

export function writeCommand(directory: string, action: IndexerCommand['action']): void {
    const path = commandFilePath(directory);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ action, timestamp: new Date().toISOString() }, null, 2), 'utf-8');
}

/** Read and consume (delete) the command file. Returns null if no command. */
export function readAndConsumeCommand(directory: string): IndexerCommand | null {
    const path = commandFilePath(directory);
    try {
        if (!existsSync(path)) return null;
        const cmd = JSON.parse(readFileSync(path, 'utf-8')) as IndexerCommand;
        // Delete after reading (one-shot semantics)
        try { unlinkSync(path); } catch { /* best-effort */ }
        return cmd;
    } catch {
        return null;
    }
}

// ─── Plugin Server ────────────────────────────────────────

export const server = async (input: PluginInput, options: PluginOptions) => {
    const pluginConfig = {
        embedder: process.env.OPENCODE_INDEXER_EMBEDDER || 'openai',
        openaiApiKey: process.env.OPENCODE_INDEXER_API_KEY,
        openaiBaseUrl: process.env.OPENCODE_INDEXER_BASE_URL || 'https://prod-ai-proxy-openai-embeddings.praxxys.dev/code',
        model: process.env.OPENCODE_INDEXER_MODEL || 'text-embedding-3-small',
        vectorStore: process.env.OPENCODE_INDEXER_VECTOR_STORE || 'lancedb',
        ...(options ?? {}),
    } as IndexerConfig;
    let watcher: import('chokidar').FSWatcher | null = null;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 600;

    // ─── Manual control state ───────────────────────────
    let isIndexing = false;
    let isPaused = false;
    let watcherActive = false;

    async function ensureWatchReady(directory: string): Promise<CodebaseIndexer | null> {
        if (!isOptedIn(directory, pluginConfig)) return null;
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

    /** Start indexing (play button) */
    async function startIndexing(directory: string): Promise<void> {
        if (isIndexing) return;
        if (!isOptedIn(directory, pluginConfig)) return;
        isIndexing = true;
        isPaused = false;
        const progress = (state: any) => writeProgressFile(directory, state);
        progress({ phase: 'scanning', message: 'Starting...', current: 0, total: 0, percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null });
        writeState(directory, { status: 'indexing', phase: 'scanning', progress: 0 });
        try {
            const idx = getIndexer(directory, pluginConfig);
            await idx.ensureReady();
            await idx.init();
            const { files, blocks } = await idx.index(directory);
            if (idx.isAborted()) return;
            const stats = await idx.stats();
            progress({ phase: 'done', message: `✅ ${files} files → ${blocks} blocks`, current: blocks, total: blocks, percentage: 100, updatedAt: '', files, blocks, dbPath: stats.dbPath, lastIndexed: new Date().toISOString() });
            writeState(directory, {
                status: 'ready', files, blocks: stats.blocks,
                dbPath: stats.dbPath, lastIndexed: new Date().toISOString(),
                phase: 'done', progress: 100,
            });
        } catch (err: any) {
            const msg = `⚠ Error: ${err.message}`;
            progress({ phase: 'error', message: msg, current: 0, total: 0, percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null });
            writeState(directory, { status: 'error', phase: 'error', progress: 0 });
        } finally {
            isIndexing = false;
        }
    }

    /** Pause watcher — stop live updates but keep existing index */
    async function pauseIndexing(directory: string): Promise<void> {
        // Abort current indexing if running, so index() returns quickly
        const idx = getIndexer(directory, pluginConfig);
        idx.abort();
        isIndexing = false;
        isPaused = true;
        if (watcher) {
            await watcher.close();
            watcher = null;
            watcherActive = false;
        }
        writeProgressFile(directory, {
            phase: 'paused', message: '⏸ Paused', current: 0, total: 0,
            percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null,
        } as any);
        writeState(directory, { status: 'idle', phase: 'paused', progress: 0 });
    }

    /** Stop current indexing immediately + stop watcher */
    async function stopIndexing(directory: string): Promise<void> {
        const idx = getIndexer(directory, pluginConfig);
        idx.abort();
        isIndexing = false;
        isPaused = false;
        if (watcher) {
            await watcher.close();
            watcher = null;
            watcherActive = false;
        }
        writeProgressFile(directory, {
            phase: 'idle', message: '⏹ Stopped', current: 0, total: 0,
            percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null,
        } as any);
        writeState(directory, { status: 'idle', phase: 'idle', progress: 0 });
    }

    /** Force full re-index (rewind button) */
    async function reindex(directory: string): Promise<void> {
        // Abort current indexing first
        const idx = getIndexer(directory, pluginConfig);
        idx.abort();
        isIndexing = false;
        await new Promise(r => setTimeout(r, 100));

        // Start fresh full re-index with force=true
        isIndexing = true;
        isPaused = false;
        const progress = (state: any) => writeProgressFile(directory, state);
        progress({ phase: 'scanning', message: 'Re-indexing...', current: 0, total: 0, percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null });
        writeState(directory, { status: 'indexing', phase: 'scanning', progress: 0 });
        try {
            await idx.ensureReady();
            await idx.init();
            const { files, blocks } = await idx.index(directory, undefined, true);
            if (idx.isAborted()) return;
            const stats = await idx.stats();
            progress({ phase: 'done', message: `✅ ${files} files → ${blocks} blocks`, current: blocks, total: blocks, percentage: 100, updatedAt: '', files, blocks, dbPath: stats.dbPath, lastIndexed: new Date().toISOString() });
            writeState(directory, {
                status: 'ready', files, blocks: stats.blocks,
                dbPath: stats.dbPath, lastIndexed: new Date().toISOString(),
                phase: 'done', progress: 100,
            });
        } catch (err: any) {
            const msg = `⚠ Error: ${err.message}`;
            progress({ phase: 'error', message: msg, current: 0, total: 0, percentage: 0, updatedAt: '', files: 0, blocks: 0, dbPath: '', lastIndexed: null });
            writeState(directory, { status: 'error', phase: 'error', progress: 0 });
        } finally {
            isIndexing = false;
        }
    }

    /** Dispatch a command from the TUI/CLI command file */
    async function handleCommand(cmd: IndexerCommand, directory: string): Promise<void> {
        if (!directory) return;
        switch (cmd.action) {
            case 'start':
                await startIndexing(directory);
                break;
            case 'pause':
                await pauseIndexing(directory);
                break;
            case 'stop':
                await stopIndexing(directory);
                break;
            case 'reindex':
                await reindex(directory);
                break;
        }
    }

    // Start file watcher if the project is opted in
    const projectDir = input.directory;
    if (projectDir && isOptedIn(projectDir, pluginConfig)) {
        // Initialize the indexer so the watcher is ready immediately
        try {
            const idx = getIndexer(projectDir, pluginConfig);
            await idx.ensureReady();
            await idx.init();
        } catch { /* will retry on first file change */ }

        const DEBUG_LOG = join(projectDir, ".codebase-index-store", "watcher-debug.log")
        function debug(msg: string) {
            try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`) } catch {}
        }

        debug(`START projectDir=${projectDir}`)
        debug(`READY isReady=${getIndexer(projectDir, pluginConfig).isReady()}`)

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
            // Skip if paused
            if (isPaused) return;

            const relPath = relative(projectDir, filePath);
            debug(`EVENT ${event} ${relPath}`)

            // Debounce
            const existing = debounceTimers.get(filePath);
            if (existing) clearTimeout(existing);

            debounceTimers.set(
                filePath,
                setTimeout(async () => {
                    debounceTimers.delete(filePath);

                    if (event === 'unlink') {
                        const idx = getIndexer(projectDir, pluginConfig);
                        try {
                            await idx.deleteFile(filePath);
                            debug(`UNLINK OK ${relPath}`)
                        } catch {
                            debug(`UNLINK FAIL ${relPath}`)
                        }
                        return;
                    }

                    // add / change — re-index the file
                    const idx = await ensureWatchReady(projectDir);
                    if (!idx) {
                        debug(`ENSURE_WATCH_READY NULL ${relPath}`)
                        return;
                    }

                    try {
                        const result = await idx.indexFile(filePath);
                        debug(`INDEXFILE OK ${relPath} → ${result.blocks} blocks`)
                    } catch (err: any) {
                        debug(`INDEXFILE FAIL ${relPath} ${err.message || err}`)
                    }
                }, DEBOUNCE_MS)
            );
        });

        watcherActive = true;

        // Watcher started silently (no console.log — output goes to TUI textarea)
    }

    // ─── Command poller — checks for TUI/CLI commands every 1s ──
    let commandInterval: ReturnType<typeof setInterval> | null = null;
    if (projectDir && isOptedIn(projectDir, pluginConfig)) {
        commandInterval = setInterval(async () => {
            try {
                const cmd = readAndConsumeCommand(projectDir);
                if (cmd) {
                    debug(`COMMAND ${cmd.action} at ${cmd.timestamp}`);
                    await handleCommand(cmd, projectDir);
                }
            } catch (err: any) {
                // Silent — don't crash the poller
            }
        }, 1000);
    }

    function debug(msg: string) {
        const dbgPath = join(projectDir, '.codebase-index-store', 'watcher-debug.log');
        try { appendFileSync(dbgPath, `${new Date().toISOString()} ${msg}\n`); } catch {}
    }

    // ─── Branch polling (opt-in via branchAware config) ──────
    let branchInterval: ReturnType<typeof setInterval> | null = null;
    if (projectDir && isOptedIn(projectDir, pluginConfig) && pluginConfig.branchAware) {
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
            codebase_control: makeCodebaseControl(pluginConfig),
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
                    '- **codebase_status** — Check if indexing is set up.\n' +
                    '- **codebase_control** — Manually start/pause/stop/reindex (action param). ' +
                    'Can also be controlled via TUI buttons or external CLI (`npx opencode-indexer <action>`).\n\n' +
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
