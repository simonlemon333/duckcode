/**
 * Skill system — markdown prompt templates triggered by slash commands.
 *
 * Skills are .md files in .duck/skills/ (project-local) or ~/.duck/skills/ (global).
 * Each skill has YAML frontmatter (name, description) and a body that becomes
 * the prompt injected before the user's message.
 *
 * Usage: /review, /commit, /test, etc.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface Skill {
  name: string
  description: string
  prompt: string
  source: string // file path
}

// ─── Frontmatter parser (no yaml dep needed) ────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content.trim() }

  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      meta[key] = val
    }
  }
  return { meta, body: match[2].trim() }
}

// ─── Load skills from a directory ───────────────────────────────────────────

function loadSkillsFromDir(dir: string): Skill[] {
  if (!existsSync(dir)) return []

  const skills: Skill[] = []
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md'))
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const { meta, body } = parseFrontmatter(raw)
        if (!body) continue

        skills.push({
          name: meta.name || basename(file, '.md'),
          description: meta.description || '',
          prompt: body,
          source: filePath,
        })
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory not readable
  }
  return skills
}

// ─── Public API ──────────────────────────────────────────────────────────────

let loadedSkills: Skill[] = []

/**
 * Discover and load skills from project (.duck/skills/) and global (~/.duck/skills/).
 * Project skills override global skills with the same name.
 */
export function loadSkills(cwd: string): void {
  const globalDir = join(homedir(), '.duck', 'skills')
  const projectDir = join(cwd, '.duck', 'skills')

  const globalSkills = loadSkillsFromDir(globalDir)
  const projectSkills = loadSkillsFromDir(projectDir)

  // Project skills override global by name
  const byName = new Map<string, Skill>()
  for (const s of globalSkills) byName.set(s.name, s)
  for (const s of projectSkills) byName.set(s.name, s)

  loadedSkills = Array.from(byName.values())
}

/**
 * Get a skill by slash command name (without the /).
 */
export function getSkill(name: string): Skill | undefined {
  return loadedSkills.find(s => s.name === name)
}

/**
 * Get all loaded skills.
 */
export function getAllSkills(): Skill[] {
  return [...loadedSkills]
}

/**
 * Check if input starts with a slash command and resolve the skill.
 * Returns { skill, args } if matched, undefined if not a skill command.
 */
export function resolveSlashCommand(input: string): { skill: Skill; args: string } | undefined {
  if (!input.startsWith('/')) return undefined

  const spaceIdx = input.indexOf(' ')
  const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1)
  const args = spaceIdx > 0 ? input.slice(spaceIdx + 1).trim() : ''

  const skill = getSkill(cmdName)
  if (!skill) return undefined

  return { skill, args }
}
