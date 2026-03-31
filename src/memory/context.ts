import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const CONTEXT_FILES = ['DUCK.md', 'CLAUDE.md', '.duck/context.md']

export function loadProjectContext(cwd: string): string {
  for (const name of CONTEXT_FILES) {
    const p = join(cwd, name)
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').trim()
        if (content) return `[${name}]\n${content}`
      } catch {
        // ignore
      }
    }
  }
  return ''
}
