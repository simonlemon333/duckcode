/**
 * Persistent user rules (L1.5 memory tier).
 *
 * Rules are one-line user preferences that get injected into every
 * session's system prompt. Unlike Dream memory (per-project, auto-extracted),
 * rules are global and hand-curated.
 *
 * Storage: ~/.duck/rules.md (plain markdown list, human-editable)
 *
 * Examples:
 *   - Prefer TypeScript over JavaScript for new files
 *   - Always run typecheck after edits
 *   - Never use console.log in production code, use the logger instead
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const RULES_PATH = join(homedir(), '.duck', 'rules.md')

function ensureDir(): void {
  if (!existsSync(dirname(RULES_PATH))) {
    mkdirSync(dirname(RULES_PATH), { recursive: true })
  }
}

/**
 * Load all rules as a single markdown string.
 * Returns null if no rules file exists.
 */
export function loadRules(): string | null {
  if (!existsSync(RULES_PATH)) return null
  try {
    const content = readFileSync(RULES_PATH, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

/**
 * List all rules as an array of strings (one per line).
 */
export function listRules(): string[] {
  const raw = loadRules()
  if (!raw) return []
  const rules: string[] = []
  for (const line of raw.split('\n')) {
    // Only list-item lines are rules. Headers + paragraphs are ignored.
    const match = line.match(/^[-*]\s+(.+)$/)
    if (match) {
      const text = match[1].trim()
      if (text.length > 0) rules.push(text)
    }
  }
  return rules
}

/**
 * Append a new rule. Returns the updated count.
 */
export function addRule(rule: string): number {
  ensureDir()
  const trimmed = rule.trim()
  if (!trimmed) return listRules().length

  const existing = loadRules()
  const header = existing ? '' : '# DuckCode Rules\n\nPersistent user preferences injected into every session.\n\n'
  const newLine = `- ${trimmed}\n`

  if (existing) {
    writeFileSync(RULES_PATH, existing + '\n' + newLine, 'utf-8')
  } else {
    writeFileSync(RULES_PATH, header + newLine, 'utf-8')
  }

  return listRules().length
}

/**
 * Clear all rules.
 */
export function clearRules(): void {
  if (existsSync(RULES_PATH)) {
    writeFileSync(RULES_PATH, '', 'utf-8')
  }
}

/**
 * Remove a rule by its 1-indexed position.
 * Returns true if removed, false if out of range.
 */
export function removeRule(index: number): boolean {
  const rules = listRules()
  if (index < 1 || index > rules.length) return false

  rules.splice(index - 1, 1)

  ensureDir()
  const header = '# DuckCode Rules\n\nPersistent user preferences injected into every session.\n\n'
  const body = rules.map((r) => `- ${r}`).join('\n')
  writeFileSync(RULES_PATH, header + body + (body ? '\n' : ''), 'utf-8')
  return true
}

/**
 * Format rules for system prompt injection.
 */
export function buildRulesSection(): string {
  const rules = listRules()
  if (rules.length === 0) return ''

  const lines: string[] = []
  lines.push('<user_rules>')
  lines.push('Persistent rules set by the user. Follow these in every response:')
  for (const r of rules) {
    lines.push(`- ${r}`)
  }
  lines.push('</user_rules>')
  return lines.join('\n')
}

export { RULES_PATH }
