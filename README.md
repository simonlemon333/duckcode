# 🦆 DuckCode

AI coding agent for your terminal. Self-hosted, works with **any OpenAI-compatible backend**.

```
npx duckcode
```

> Inspired by Claude Code. Built from scratch in TypeScript. Zero vendor lock-in.

## What it does

DuckCode is an agentic coding assistant that runs in your terminal. You talk to it in natural language, and it reads, writes, edits, and runs code on your behalf — asking permission before anything destructive.

```
  🦆 Duck
  AI coding assistant · /clear to reset · Ctrl+C to exit

  ❯ fix the failing tests in src/utils

  ● Duck

  ✓ glob {pattern: "src/utils/**/*.test.ts"}
  ✓ file_read {path: "src/utils/parse.test.ts"}
  ✓ file_edit {path: "src/utils/parse.ts", old_str: "..."}
  ✓ bash {command: "npm test"}

  Fixed the off-by-one error in parseLine(). All 12 tests passing now.
```

## Quick Start

```bash
# Try it (no install needed)
npx duckcode

# Or install globally
npm install -g duckcode
duckcode
```

First run shows a config guide. Create `~/.duck/config.json`:

```json
{
  "baseUrl": "https://your-api-endpoint.com",
  "apiKey": "your-key",
  "model": "your-model"
}
```

Or use env vars: `DUCK_GATEWAY_URL`, `DUCK_API_KEY`, `DUCK_MODEL`

## Works with

Any backend that exposes `/v1/chat/completions` with streaming + tool_calls:

- **LiteLLM** — proxy 100+ models through one endpoint
- **vLLM** — self-hosted open models (Qwen, Llama, etc.)
- **Ollama** — local models on your machine
- **OpenAI** — GPT-4o, etc.
- **MiniMax** — via TokenPlan or direct API
- Any OpenAI-compatible gateway

## Tools

| Tool | Permission | What it does |
|------|-----------|--------------|
| `bash` | ✋ confirm | Run shell commands |
| `file_read` | ✅ auto | Read files with line numbers |
| `file_write` | ✋ confirm | Create or overwrite files |
| `file_edit` | ✋ confirm | Exact string-replace in files |
| `glob` | ✅ auto | Find files by pattern |
| `grep` | ✅ auto | Regex search across files |
| `web_fetch` | ✅ auto | Fetch URLs, strip HTML |

**auto** = runs immediately. **confirm** = asks y/n before executing.

## MCP Support

DuckCode supports [Model Context Protocol](https://modelcontextprotocol.io/) servers. Add to config:

```json
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  ]
}
```

Tools from MCP servers are auto-discovered and registered.

## Commands

| Command | What it does |
|---------|--------------|
| `/clear` | Reset conversation history |
| `/init` | Generate DUCK.md from project structure |

## Project Context

Create a `DUCK.md` (or `CLAUDE.md`) in your project root. DuckCode injects it into every conversation so the AI understands your project.

See `DUCK.md.example` for a template.

## Features

- **Agentic loop** — LLM calls tools, sees results, decides next step (up to 30 turns)
- **Streaming** — responses stream token-by-token as they arrive
- **Context compression** — auto-summarizes old messages when history gets long
- **MCP client** — connect any MCP server via stdio
- **Multi-model** — switch models with `--model` flag
- **Markdown rendering** — code blocks, headings, lists in terminal
- **Spinner** — animated indicator while thinking

## Architecture

```
src/
├── main.ts           # CLI entry, event loop
├── config.ts         # Config loader + system prompt
├── types.ts          # Shared types
├── query/
│   ├── engine.ts     # Agentic loop: LLM → tools → LLM
│   └── compress.ts   # Context compression (LLM summarization)
├── tools/
│   ├── registry.ts   # Tool registry + helpers
│   ├── bash.ts       # Shell execution
│   ├── file-read.ts  # Read with line numbers
│   ├── file-write.ts # Write + string-replace edit
│   ├── glob-grep.ts  # File search + regex grep
│   ├── web-fetch.ts  # HTTP fetch
│   └── mcp.ts        # MCP client (stdio JSON-RPC)
├── ui/
│   ├── input.ts      # Raw stdin handler (no TUI framework)
│   └── console.ts    # Chalk output + markdown rendering
└── memory/
    └── context.ts    # DUCK.md / CLAUDE.md loader
```

## Development

```bash
git clone https://github.com/simonlemon333/duckcode.git
cd duckcode
npm install
npm run dev          # run from source
npm run build        # build to dist/
npm run typecheck    # tsc --noEmit
```

## License

MIT
