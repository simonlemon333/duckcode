# 🦆 DuckCode

AI coding agent for your terminal — self-hosted, works with **any OpenAI-compatible backend**.

Built from scratch. Inspired by Claude Code architecture. MIT licensed.

## Quick Start

```bash
npm install
npm run dev          # run from source
# or
npm run build && node dist/main.js
```

## Configuration

Duck reads config from env vars **or** `~/.duck/config.json`:

```json
{
  "baseUrl": "https://your-gateway.example.com",
  "apiKey": "your-token",
  "model": "your-model-name",
  "maxTokens": 8192
}
```

Or set env vars:

```bash
export DUCK_GATEWAY_URL=https://your-gateway.example.com
export DUCK_API_KEY=your-token
export DUCK_MODEL=your-model-name
```

Your gateway must expose **OpenAI-compatible** `/v1/chat/completions` with streaming + tool_calls.
Works with LiteLLM, vLLM, Ollama, or any OpenAI-compat proxy.

## Tools

| Tool | Permission | Description |
|------|-----------|-------------|
| `bash` | confirm | Run shell commands |
| `file_read` | auto | Read file with line numbers |
| `file_write` | confirm | Write/overwrite a file |
| `file_edit` | confirm | Exact string-replace in file |
| `glob` | auto | Find files by pattern |
| `grep` | auto | Search by regex across files |
| `web_fetch` | auto | Fetch URL, strip HTML |

## MCP Support

DuckCode supports [Model Context Protocol](https://modelcontextprotocol.io/) servers via stdio:

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

Tools from MCP servers are auto-registered as `serverName_toolName`.

## Project Context

Create a `DUCK.md` (or `CLAUDE.md`) in your project root.
Duck injects it into every conversation as project context.

## Architecture

```
src/
├── main.tsx          # CLI entry + Ink render
├── config.ts         # Config loader + system prompt
├── types.ts          # Shared types
├── query/
│   └── engine.ts     # Agentic loop: LLM → tools → LLM (max 30 turns)
├── tools/
│   ├── registry.ts   # Tool registry + ok()/err() helpers
│   ├── bash.ts       # Shell execution
│   ├── file-read.ts  # Read file with line numbers
│   ├── file-write.ts # Write + str-replace edit
│   ├── glob-grep.ts  # Glob + regex search
│   ├── web-fetch.ts  # HTTP fetch
│   └── mcp.ts        # MCP client (stdio JSON-RPC)
├── ui/
│   ├── chat.tsx      # Ink TUI (input + permission prompt)
│   └── console.ts    # Streaming output (chalk)
└── memory/
    └── context.ts    # DUCK.md / CLAUDE.md loader
```

## License

MIT
