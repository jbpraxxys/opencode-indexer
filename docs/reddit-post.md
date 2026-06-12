# Reddit Post Draft — r/opencodeCLI

---

**Title:** A codebase indexing plugin for OpenCode — bringing back the semantic search workflow we had with KiloCode/Roo

---

**Body:**

I want to share a new OpenCode plugin I've been working on:

🚀 **opencode-indexer**
https://github.com/jbpraxxys/opencode-indexer

## Context

Many of us were using KiloCode, and one of the features that really helped a lot — especially on large projects — was the **codebase indexing/search capability**. Being able to ask *"how does authentication work?"* and have the AI instantly find the relevant functions, classes, and middleware across 200+ files was a game changer.

Since the changes in Kilo, a lot of us transitioned to OpenCode. But one thing that's been missing for months is a codebase indexing experience similar to what we had in Roo/Kilo.

There are already some available tools and MCPs for OpenCode, but based on testing and actual usage, they're still not as reliable or impactful compared to the original workflow we were used to. Most of them index code as raw text chunks or rely too heavily on line-based chunking — the semantic understanding just isn't there.

One thing I personally liked with Kilo/Roo is:

- It **understands the project structure first**
- It does **not aggressively grep/glob** unless needed
- It relies heavily on **semantic codebase understanding/search**

That workflow produces much better AI context and significantly improves output quality when working on large repositories.

## What this plugin does

I tried to reverse-engineer that behavior and create a similar experience for OpenCode.

Instead of indexing code by raw lines or chunks, this plugin indexes using **Tree-sitter AST parsing**, meaning it understands:

- ✅ Functions
- ✅ Methods
- ✅ Classes
- ✅ Interfaces
- ✅ Components (Vue SFC `<script>` blocks are extracted and parsed)

This creates more meaningful embeddings and better semantic retrieval when the AI is analyzing the codebase. Supported languages: TypeScript, JavaScript, Python, and PHP (with line-based fallback for everything else — Ruby, Go, Rust, Java, etc.)

## Features

- 🌳 **Tree-sitter AST parsing** — semantic blocks, not raw text chunks
- ⚡ **Hash caching** — re-indexing only processes changed files
- 📦 **Zero-dependency LanceDB** — embedded vector store, no server, no Docker, no API key needed
- 👀 **File watcher** — re-indexes a file in ~600ms when you save
- 🔄 **Branch-aware** — auto re-indexes when you `git checkout` (opt-in)
- 🤖 **Agent skill** — enforces a Search Priority Rule so the agent checks `codebase_status` first, then uses `codebase_search`, falling back to grep/glob only as a last resort

## Quick Start

```bash
# 1. Clone and build
git clone https://github.com/jbpraxxys/opencode-indexer.git ~/opencode-indexer
cd ~/opencode-indexer && npm install && npm run build

# 2. Add to ~/.config/opencode/opencode.json:
#    "plugin": [["~/opencode-indexer", {
#        "embedder": "openai",
#        "openaiApiKey": "sk-...",
#        "model": "text-embedding-3-small"
#    }]]

# 3. Opt in your project
cd ~/Sites/my-project && touch .codebase-index

# 4. Restart OpenCode — that's it.
```

Auto-indexing kicks in on the first search. Three tools become available: `codebase_index`, `codebase_search`, `codebase_status`. Works with Ollama too (local, free) if you'd rather not use OpenAI embeddings.

## Links

- 🔗 **GitHub:** https://github.com/jbpraxxys/opencode-indexer
- 🌐 **Landing page:** https://jbpraxxys.github.io/opencode-indexer/
- 📦 **Release:** v0.1.0

Would love feedback, bug reports, or feature requests. Hope this helps anyone who's been missing that KiloCode/Roo search workflow.

---

**Notes for posting:**
- Use markdown mode in Reddit's editor
- Add the `flair: "Plugin"` or `"Showcase"` tag if the sub supports it
- Consider cross-posting to r/ChatGPTCoding and r/aipromptprogramming
