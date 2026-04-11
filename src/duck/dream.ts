/**
 * Dream/Kairos — extract structured facts from conversation history
 * and persist to long-term memory.
 *
 * Design inspired by Claude Code v2.1.88's autoDream (read-only consolidation)
 * and Hermes three-tier memory (session → facts → digest).
 *
 * DuckCode's Dream is human-in-loop: triggered by /dream command, not
 * auto-scheduled. This keeps a quality gate between raw sessions and
 * long-term memory.
 *
 * Scope v1:
 * - Input: current in-memory conversation history
 * - Processing: single LLM call extracts 4 categories of facts
 * - Output: append to ~/.duck/memory/<project>.md
 * - Read-only w.r.t. user's code (only writes to ~/.duck/memory/)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import type { Message, ContentBlock, GatewayConfig } from '../types.js'

const MEMORY_DIR = join(homedir(), '.duck', 'memory')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Digest {
  timestamp: string
  project: string
  files: string[]
  decisions: string[]
  resolved: string[]
  open: string[]
  raw: string  // The LLM's raw response for debugging
}

// ─── Serialize history to a transcript ─────────────────────────────────────

function serializeHistory(history: Message[]): string {
  const lines: string[] = []
  for (const msg of history) {
    if (typeof msg.content === 'string') {
      lines.push(`[${msg.role}]: ${msg.content}`)
      continue
    }
    const blocks = msg.content as ContentBlock[]
    for (const b of blocks) {
      if (b.type === 'text') {
        lines.push(`[${msg.role}]: ${b.text}`)
      } else if (b.type === 'tool_use') {
        lines.push(`[tool_use]: ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`)
      } else if (b.type === 'tool_result') {
        const preview = b.content.slice(0, 400)
        lines.push(`[tool_result]: ${preview}${b.content.length > 400 ? '…' : ''}`)
      }
    }
  }
  return lines.join('\n')
}

// ─── Prompt for digest extraction ──────────────────────────────────────────

const DIGEST_PROMPT = `You are a conversation archivist. Extract durable facts from a coding session for long-term memory. Output ONLY a JSON object with four string arrays — no markdown fences, no commentary.

Rules:
- Be specific, cite file paths with full context
- Each item is one short line (under 100 chars)
- Skip trivia, keep what the developer would want to remember next week
- "decisions": why something was done, not what
- "resolved": problem + how fixed (one line)
- "open": unresolved TODOs, questions, or blockers
- If a category has nothing worth saving, return []

Example output:
{
  "files": ["src/auth.ts", "docs/design.md"],
  "decisions": ["chose JWT over session cookies for stateless API"],
  "resolved": ["fixed race condition in login handler — added mutex around token refresh"],
  "open": ["need to add rate limiting to /login endpoint"]
}`

// ─── Extract digest via LLM ────────────────────────────────────────────────

export async function extractDigest(
  history: Message[],
  project: string,
  config: GatewayConfig,
): Promise<Digest> {
  const transcript = serializeHistory(history)

  // Truncate very long transcripts to avoid blowing the context
  const maxChars = 40_000
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n[…transcript truncated]'
    : transcript

  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: DIGEST_PROMPT },
        { role: 'user', content: `Extract digest from this session:\n\n${truncated}` },
      ],
      max_tokens: 1500,
      stream: false,
    }),
  })

  if (!response.ok) {
    throw new Error(`Digest LLM call failed: ${response.status}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  let raw = data.choices?.[0]?.message?.content ?? ''
  // Strip <think> blocks (MiniMax)
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

  // Extract first JSON object
  const match = raw.match(/\{[\s\S]*\}/)
  let parsed: Record<string, unknown> = {}
  try {
    parsed = match ? JSON.parse(match[0]) : {}
  } catch {
    parsed = {}
  }

  const toStringArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []

  return {
    timestamp: new Date().toISOString(),
    project,
    files: toStringArr(parsed.files),
    decisions: toStringArr(parsed.decisions),
    resolved: toStringArr(parsed.resolved),
    open: toStringArr(parsed.open),
    raw,
  }
}

// ─── Persist digest to memory file ─────────────────────────────────────────

export function appendDigestToMemory(digest: Digest): string {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true })
  }

  const safeProject = digest.project.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'project'
  const memoryPath = join(MEMORY_DIR, `${safeProject}.md`)

  const when = new Date(digest.timestamp).toLocaleString()
  const sections: string[] = []

  sections.push(`## Session ${when}`)
  sections.push('')

  if (digest.files.length > 0) {
    sections.push('### Files')
    for (const f of digest.files) sections.push(`- \`${f}\``)
    sections.push('')
  }

  if (digest.decisions.length > 0) {
    sections.push('### Decisions')
    for (const d of digest.decisions) sections.push(`- ${d}`)
    sections.push('')
  }

  if (digest.resolved.length > 0) {
    sections.push('### Resolved')
    for (const r of digest.resolved) sections.push(`- ${r}`)
    sections.push('')
  }

  if (digest.open.length > 0) {
    sections.push('### Open')
    for (const o of digest.open) sections.push(`- ${o}`)
    sections.push('')
  }

  sections.push('---', '')

  const newContent = sections.join('\n')

  if (existsSync(memoryPath)) {
    // Prepend new digest to the top so most recent is first
    const existing = readFileSync(memoryPath, 'utf-8')
    writeFileSync(memoryPath, newContent + existing, 'utf-8')
  } else {
    const header = `# Memory · ${digest.project}\n\nAuto-generated by DuckCode /dream. Most recent sessions on top.\n\n---\n\n`
    writeFileSync(memoryPath, header + newContent, 'utf-8')
  }

  return memoryPath
}

// ─── Read existing memory for a project ───────────────────────────────────

export function loadMemory(project: string): string | null {
  const safeProject = project.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'project'
  const memoryPath = join(MEMORY_DIR, `${safeProject}.md`)
  if (!existsSync(memoryPath)) return null
  try {
    return readFileSync(memoryPath, 'utf-8')
  } catch {
    return null
  }
}

export function getProjectName(cwd: string): string {
  return basename(cwd)
}
