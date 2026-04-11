/**
 * Memory inspector — collects stats on all six memory tiers and
 * renders them via `/memory` command.
 *
 * L0 System        — getStaticSystemPrompt()
 * L1 Project       — loadProjectContext() files
 * L1.5 Rules       — ~/.duck/rules.md (user preferences)
 * L2 Episodic      — current session history
 * L3 Semantic      — ~/.duck/memory/<project>.md (Dream digests)
 * L4 File cache    — file_read hash cache
 * L5 Tools         — tool registry
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import type { Message, GatewayConfig } from '../types.js'
import { getStaticSystemPrompt, getDynamicContext } from '../config.js'
import { getAllSkills } from '../skills/loader.js'
import { listHooks } from '../skills/hooks.js'
import { listRules } from './rules.js'
import { loadMemory } from './dream.js'
import { getAllTools } from '../tools/registry.js'

export interface MemoryStats {
  layers: Array<{
    level: string
    name: string
    status: string
    detail: string
  }>
  totalChars: number
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

function fmtChars(chars: number): string {
  const tokens = estimateTokens(chars)
  if (chars < 1024) return `${chars} chars · ~${tokens} tokens`
  return `${(chars / 1024).toFixed(1)}k chars · ~${tokens} tokens`
}

export function collectMemoryStats(
  cwd: string,
  history: Message[],
  config: GatewayConfig,
  projectContext: string,
): MemoryStats {
  const layers: MemoryStats['layers'] = []
  let totalChars = 0

  // ─── L0: Static system prompt ─────────────────────────────────────────
  const systemPrompt = getStaticSystemPrompt(config)
  const l0Chars = systemPrompt.length
  totalChars += l0Chars
  layers.push({
    level: 'L0',
    name: 'System',
    status: 'active',
    detail: `role + tool_usage + communication rules · ${fmtChars(l0Chars)}`,
  })

  // ─── L1: Project context ──────────────────────────────────────────────
  const l1Chars = projectContext.length
  totalChars += l1Chars
  const projectFiles: string[] = []
  for (const name of ['DUCK.md', 'CLAUDE.md', '.duck/context.md']) {
    if (existsSync(join(cwd, name))) {
      projectFiles.push(name)
      break
    }
  }
  layers.push({
    level: 'L1',
    name: 'Project',
    status: projectFiles.length > 0 ? 'loaded' : 'none',
    detail: projectFiles.length > 0
      ? `${projectFiles.join(', ')} · ${fmtChars(l1Chars)}`
      : 'no DUCK.md or CLAUDE.md',
  })

  // ─── L1.5: User rules ─────────────────────────────────────────────────
  const rules = listRules()
  layers.push({
    level: 'L1.5',
    name: 'Rules',
    status: rules.length > 0 ? `${rules.length} active` : 'none',
    detail: rules.length > 0
      ? `${rules.length} rule(s) · use /rule list`
      : '~/.duck/rules.md empty — use /rule add <text>',
  })

  // ─── L2: Episodic (session history) ───────────────────────────────────
  const historyChars = JSON.stringify(history).length
  totalChars += historyChars
  layers.push({
    level: 'L2',
    name: 'Episodic',
    status: history.length > 0 ? `${history.length} msgs` : 'empty',
    detail: history.length > 0
      ? `${history.length} message(s) · ${fmtChars(historyChars)}`
      : 'no conversation yet',
  })

  // ─── L3: Semantic (Dream memory) ──────────────────────────────────────
  const project = basename(cwd)
  const memoryContent = loadMemory(project)
  const l3Chars = memoryContent?.length ?? 0
  const digestCount = memoryContent
    ? (memoryContent.match(/^## Session /gm)?.length ?? 0)
    : 0
  layers.push({
    level: 'L3',
    name: 'Semantic',
    status: digestCount > 0 ? `${digestCount} digests` : 'empty',
    detail: digestCount > 0
      ? `${digestCount} dream digest(s) · ${fmtChars(l3Chars)}`
      : 'run /dream to consolidate session',
  })

  // ─── L4: File cache ───────────────────────────────────────────────────
  // We don't have direct access to the internal cache size, but we can
  // check if the duckcode process has the file-read module loaded.
  // For now just show it's active.
  layers.push({
    level: 'L4',
    name: 'FileCache',
    status: 'active',
    detail: 'hash+mtime dedupe — re-reads return "unchanged"',
  })

  // ─── L5: Tools + Skills + Hooks ───────────────────────────────────────
  const tools = getAllTools()
  const skills = getAllSkills()
  const hooks = listHooks()
  layers.push({
    level: 'L5',
    name: 'Tools',
    status: `${tools.length} tools`,
    detail: `${tools.length} tool(s) · ${skills.length} skill(s) · ${hooks.length} hook(s)`,
  })

  return { layers, totalChars }
}

// ─── Render ──────────────────────────────────────────────────────────────

export function renderMemoryStats(stats: MemoryStats): void {
  console.log()
  console.log(chalk.cyan.bold('  🧠 Memory Inspector'))
  console.log(chalk.dim('  6-tier memory architecture'))
  console.log()

  const levelColors: Record<string, (s: string) => string> = {
    L0: chalk.magenta,
    L1: chalk.blue,
    'L1.5': chalk.blueBright,
    L2: chalk.cyan,
    L3: chalk.green,
    L4: chalk.yellow,
    L5: chalk.white,
  }

  for (const layer of stats.layers) {
    const levelFn = levelColors[layer.level] ?? chalk.white
    const lvl = levelFn(layer.level.padEnd(5))
    const name = chalk.bold(layer.name.padEnd(10))
    const status = layer.status.includes('none') || layer.status.includes('empty')
      ? chalk.dim(layer.status)
      : chalk.green(layer.status)
    console.log(`  ${lvl} ${name} ${status}`)
    console.log(`        ${chalk.dim(layer.detail)}`)
  }

  console.log()
  console.log(chalk.dim(`  Total system context: ${fmtChars(stats.totalChars)}`))
  console.log()
}

// Keep reference to avoid unused import
void getDynamicContext
