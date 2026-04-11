import { readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { loadMemory } from '../duck/dream.js'

const CONTEXT_FILES = ['DUCK.md', 'CLAUDE.md', '.duck/context.md']
const MAX_MEMORY_CHARS = 4_000  // Cap memory size to avoid bloating every prompt

export function loadProjectContext(cwd: string): string {
  const parts: string[] = []

  // Project-local context file
  for (const name of CONTEXT_FILES) {
    const p = join(cwd, name)
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').trim()
        if (content) {
          parts.push(`[${name}]\n${content}`)
          break
        }
      } catch {
        // ignore
      }
    }
  }

  // Dream memory — accumulated digests from /dream command
  const project = basename(cwd)
  const memory = loadMemory(project)
  if (memory) {
    // Cap to recent content to avoid prompt bloat
    const trimmed = memory.length > MAX_MEMORY_CHARS
      ? memory.slice(0, MAX_MEMORY_CHARS) + '\n[…older memory truncated]'
      : memory
    parts.push(`[dream memory · ${project}]\n${trimmed}`)
  }

  return parts.join('\n\n')
}
