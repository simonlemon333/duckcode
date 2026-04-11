import { program } from 'commander'
import { cwd as processCwd } from 'process'
import { resolve, basename } from 'path'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import chalk from 'chalk'

import { loadConfig, hasConfig } from './config.js'
import { setupProxy } from './proxy.js'
import { loadSkills, resolveSlashCommand, getAllSkills } from './skills/loader.js'
import { initHooks, listHooks } from './skills/hooks.js'
import { QueryEngine } from './query/engine.js'
import { loadProjectContext } from './memory/context.js'
import {
  printWelcome,
  setAgentName,
  outputUser,
  outputAssistantStart,
  streamText,
  streamFinish,
  outputToolCall,
  outputError,
} from './ui/console.js'
import { startInput, setIdle, showPermission, stopInput, stopSpinner, startSpinner, setCommandList } from './ui/input.js'
import type { PermissionCallback, PermissionResult } from './query/engine.js'

// ── Register all tools (side-effect imports) ──────────────────────────────────
import './tools/bash.js'
import './tools/file-read.js'
import { clearFileCache } from './tools/file-read.js'
import { saveSession, loadSession, listSessions } from './session.js'
import { expandMentions } from './input-mentions.js'
import { getBuddy } from './duck/buddy.js'
import { renderBuddy } from './duck/buddy-render.js'
import { extractDigest, appendDigestToMemory, getProjectName } from './duck/dream.js'
import { listRules, addRule, removeRule, clearRules, RULES_PATH } from './duck/rules.js'
import { collectMemoryStats, renderMemoryStats } from './duck/memory-inspector.js'
import './tools/file-write.js'
import './tools/glob-grep.js'
import './tools/web-fetch.js'
import './tools/agent.js'
import { initAgentTool } from './tools/agent.js'
import { initializeMcpTools, cleanupMcpConnections, listMcpServers } from './tools/mcp.js'

// ─── CLI entry point ──────────────────────────────────────────────────────────

// Read version from package.json at build time (tsup inlines it)
const VERSION = '0.1.4'

program
  .name('duckcode')
  .description('DuckCode — AI coding agent for your terminal')
  .version(VERSION)
  .option('-d, --dir <path>', 'Working directory', '.')
  .option('--model <name>', 'Model name to use (from models config)')
  .option('--proxy <url>', 'HTTP/HTTPS proxy URL')
  .option('--resume [name]', 'Resume a saved session (defaults to latest)')
  .parse()

const opts = program.opts()
const workDir = resolve(processCwd(), opts.dir as string)

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (!hasConfig()) {
  console.log(chalk.cyan.bold('\n  🦆 Welcome to DuckCode!\n'))
  console.log(chalk.white('  No config found. Create ~/.duck/config.json:\n'))
  console.log(chalk.dim('  {'))
  console.log(chalk.dim('    "baseUrl": "') + chalk.white('https://your-api-endpoint.com') + chalk.dim('",'))
  console.log(chalk.dim('    "apiKey": "') + chalk.white('your-key') + chalk.dim('",'))
  console.log(chalk.dim('    "model": "') + chalk.white('your-model') + chalk.dim('"'))
  console.log(chalk.dim('  }\n'))
  console.log(chalk.white('  Or set env vars: ') + chalk.cyan('DUCK_GATEWAY_URL') + chalk.dim(', ') + chalk.cyan('DUCK_API_KEY') + chalk.dim(', ') + chalk.cyan('DUCK_MODEL'))
  console.log(chalk.dim('\n  Works with any OpenAI-compatible API (LiteLLM, vLLM, Ollama, etc.)\n'))
  process.exit(0)
}

// Proxy setup (must be before any fetch calls)
const proxyUrl = await setupProxy(opts.proxy as string | undefined)
if (proxyUrl) console.log(chalk.dim(`  Proxy: ${proxyUrl}`))

const config = loadConfig(opts.model)
if (config.agentName) setAgentName(config.agentName)

// Load skills and hooks BEFORE project context — the skills section
// is injected into the system prompt via loadProjectContext().
loadSkills(workDir)
initHooks(workDir)

// Register all slash commands for Tab completion
const BUILTIN_COMMANDS = [
  'help', 'version', 'clear', 'init', 'skills', 'mcp',
  'save', 'sessions', 'buddy', 'dream', 'memory', 'rule',
]
const skillCommands: string[] = []
for (const s of getAllSkills()) {
  skillCommands.push(s.name)
  for (const alias of s.aliases) skillCommands.push(alias)
}
setCommandList([...BUILTIN_COMMANDS, ...skillCommands])

const projectContext = loadProjectContext(workDir)
const engine = new QueryEngine(config, projectContext)

// Initialize sub-agent tool with config (needs access to LLM settings)
initAgentTool(config)

// ── Resume session if requested ─────────────────────────────────────────────
if (opts.resume !== undefined) {
  const sessionName = typeof opts.resume === 'string' ? opts.resume : 'latest'
  const session = loadSession(sessionName)
  if (session) {
    engine.setHistory(session.history)
    console.log(chalk.dim(`  ↻ Resumed "${sessionName}" (${session.history.length} messages from ${new Date(session.savedAt).toLocaleString()})`))
  } else {
    console.log(chalk.yellow(`  ⚠ No session "${sessionName}" found — starting fresh`))
  }
}

// Track tool calls per assistant turn
let pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>()

// Trust list: tools that don't require confirmation in current session
const trustedTools = new Set<string>()

// ── Permission callback ─────────────────────────────────────────────────────

const handlePermission: PermissionCallback = async (id, name, input) => {
  // Check trusted tools first - skip prompt if trusted
  if (trustedTools.has(name)) {
    console.log(chalk.dim(`  ✓ 工具 "${name}" 已信任，跳过确认`))
    return { granted: true }
  }

  const menuResult = await showPermission(name, input)

  // Map menu selection to PermissionResult
  if (menuResult.value === 'trust') {
    trustedTools.add(name)
    console.log(chalk.green(`  ✓ 已将 "${name}" 加入本次会话的信任列表`))
    return { granted: true, trustAll: true }
  }

  if (menuResult.value === 'edit' && menuResult.customInput) {
    try {
      const editedInput = JSON.parse(menuResult.customInput)
      return { granted: true, editedInput }
    } catch {
      console.log(chalk.red('  ✗ JSON 解析失败，使用原始参数'))
      return { granted: true }
    }
  }

  if (menuResult.value === 'allow') {
    return { granted: true }
  }

  return { granted: false }
}

// ── Submit handler ──────────────────────────────────────────────────────────

async function handleSubmit(rawText: string): Promise<void> {
  let text = rawText
  // /version
  if (text.toLowerCase() === '/version') {
    console.log(chalk.dim(`\n  duckcode v${VERSION} · ${config.model}\n`))
    setIdle(true)
    return
  }

  // /help
  if (text.toLowerCase() === '/help') {
    console.log(chalk.cyan.bold('\n  🦆 DuckCode Commands\n'))
    console.log(`  ${chalk.cyan('/help')}      ${chalk.dim('— Show this help')}`)
    console.log(`  ${chalk.cyan('/version')}   ${chalk.dim('— Show version and model')}`)
    console.log(`  ${chalk.cyan('/clear')}     ${chalk.dim('— Reset conversation history')}`)
    console.log(`  ${chalk.cyan('/init')}      ${chalk.dim('— Generate DUCK.md from project')}`)
    console.log(`  ${chalk.cyan('/skills')}    ${chalk.dim('— List available skills')}`)
    console.log(`  ${chalk.cyan('/save')} [n]  ${chalk.dim('— Save conversation (name optional)')}`)
    console.log(`  ${chalk.cyan('/sessions')} ${chalk.dim('— List saved sessions')}`)
    console.log(`  ${chalk.cyan('/buddy')}    ${chalk.dim('— Summon your terminal duck companion')}`)
    console.log(`  ${chalk.cyan('/dream')}    ${chalk.dim('— Consolidate current session into long-term memory')}`)
    console.log(`  ${chalk.cyan('/memory')}   ${chalk.dim('— Inspect all 6 memory tiers')}`)
    console.log(`  ${chalk.cyan('/rule')}     ${chalk.dim('— Manage persistent rules (list/add/remove/clear)')}`)

    const skills = getAllSkills()
    if (skills.length > 0) {
      console.log(chalk.cyan.bold('\n  Skills:\n'))
      for (const s of skills) {
        console.log(`  ${chalk.cyan('/' + s.name)}${s.description ? chalk.dim(' — ' + s.description) : ''}`)
      }
    }

    const hooks = listHooks()
    if (hooks.length > 0) {
      console.log(chalk.cyan.bold('\n  Hooks:\n'))
      for (const h of hooks) {
        console.log(`  ${chalk.dim(h.source + '/')}${chalk.white(h.name)}`)
      }
    }

    console.log()
    setIdle(true)
    return
  }

  // /clear
  if (text.toLowerCase() === '/clear') {
    engine.clearHistory()
    clearFileCache()
    console.log('\n✓ Conversation and file cache cleared.\n')
    setIdle(true)
    return
  }

  // /save [name]
  if (text.toLowerCase().startsWith('/save')) {
    const parts = text.split(/\s+/)
    const name = parts[1] || `session-${Date.now()}`
    const history = engine.getHistory()
    if (history.length === 0) {
      console.log(chalk.yellow('\n  ⚠ Nothing to save — conversation is empty.\n'))
    } else {
      const path = saveSession(history, workDir, config.model, name)
      console.log(chalk.green(`\n  ✓ Saved session "${name}" (${history.length} messages)`))
      console.log(chalk.dim(`    ${path}\n`))
    }
    setIdle(true)
    return
  }

  // /mcp — list connected MCP servers and their tools
  if (text.toLowerCase() === '/mcp') {
    const servers = listMcpServers()
    if (servers.length === 0) {
      console.log(chalk.dim('\n  No MCP servers configured. Add mcpServers to ~/.duck/config.json.\n'))
    } else {
      console.log(chalk.cyan.bold('\n  🔌 MCP Servers\n'))
      for (const srv of servers) {
        const status = srv.connected ? chalk.green('● connected') : chalk.red('○ disconnected')
        console.log(`  ${chalk.bold(srv.name)}  ${status}  ${chalk.dim(`${srv.tools.length} tools`)}`)
        if (srv.tools.length > 0) {
          const preview = srv.tools.slice(0, 8).map((t) => `${srv.name}_${t}`).join(', ')
          console.log(chalk.dim(`     ${preview}${srv.tools.length > 8 ? ` … (+${srv.tools.length - 8} more)` : ''}`))
        }
      }
      console.log()
    }
    setIdle(true)
    return
  }

  // /memory — show all 6 memory tiers and their current state
  if (text.toLowerCase() === '/memory') {
    const stats = collectMemoryStats(workDir, engine.getHistory(), config, projectContext)
    renderMemoryStats(stats)
    setIdle(true)
    return
  }

  // /rule — manage persistent user rules (L1.5 memory tier)
  if (text.toLowerCase().startsWith('/rule')) {
    const parts = text.split(/\s+/)
    const sub = parts[1]?.toLowerCase()

    if (!sub || sub === 'list') {
      const rules = listRules()
      if (rules.length === 0) {
        console.log(chalk.dim('\n  No rules set. Use: /rule add <text>\n'))
        console.log(chalk.dim(`  Rules file: ${RULES_PATH}\n`))
      } else {
        console.log(chalk.cyan.bold('\n  📋 Active rules:\n'))
        rules.forEach((r, i) => {
          console.log(`  ${chalk.dim(String(i + 1) + '.')} ${r}`)
        })
        console.log()
      }
    } else if (sub === 'add') {
      const body = text.slice(text.indexOf('add') + 3).trim()
      if (!body) {
        console.log(chalk.yellow('\n  ⚠ Usage: /rule add <rule text>\n'))
      } else {
        const count = addRule(body)
        console.log(chalk.green(`\n  ✓ Rule added (${count} total). Effective next session.\n`))
      }
    } else if (sub === 'remove' || sub === 'rm') {
      const idx = Number(parts[2])
      if (Number.isNaN(idx)) {
        console.log(chalk.yellow('\n  ⚠ Usage: /rule remove <number>\n'))
      } else if (removeRule(idx)) {
        console.log(chalk.green(`\n  ✓ Rule ${idx} removed. Effective next session.\n`))
      } else {
        console.log(chalk.red(`\n  ✗ No rule at position ${idx}\n`))
      }
    } else if (sub === 'clear') {
      clearRules()
      console.log(chalk.green('\n  ✓ All rules cleared.\n'))
    } else {
      console.log(chalk.yellow('\n  Usage: /rule [list | add <text> | remove <n> | clear]\n'))
    }
    setIdle(true)
    return
  }

  // /dream — extract durable facts from current session to long-term memory
  if (text.toLowerCase() === '/dream') {
    const history = engine.getHistory()
    if (history.length === 0) {
      console.log(chalk.yellow('\n  ⚠ Nothing to consolidate — conversation is empty.\n'))
      setIdle(true)
      return
    }
    console.log(chalk.dim('\n  💭 Extracting session digest...'))
    try {
      const project = getProjectName(workDir)
      const digest = await extractDigest(history, project, config)
      const memoryPath = appendDigestToMemory(digest)
      const totalItems = digest.files.length + digest.decisions.length + digest.resolved.length + digest.open.length

      console.log(chalk.green(`\n  ✓ Dream consolidated (${totalItems} items)`))
      if (digest.files.length > 0) console.log(chalk.dim(`    Files:     ${digest.files.length}`))
      if (digest.decisions.length > 0) console.log(chalk.dim(`    Decisions: ${digest.decisions.length}`))
      if (digest.resolved.length > 0) console.log(chalk.dim(`    Resolved:  ${digest.resolved.length}`))
      if (digest.open.length > 0) console.log(chalk.dim(`    Open:      ${digest.open.length}`))
      console.log(chalk.dim(`    → ${memoryPath}\n`))
    } catch (e) {
      console.log(chalk.red(`\n  ✗ Dream failed: ${(e as Error).message}\n`))
    }
    setIdle(true)
    return
  }

  // /buddy [--regen] — show the terminal pet
  if (text.toLowerCase().startsWith('/buddy')) {
    const forceRegen = text.includes('--regen')
    try {
      const buddy = await getBuddy(config, forceRegen)
      renderBuddy(buddy)
      if (forceRegen) {
        console.log(chalk.dim('  (soul regenerated)\n'))
      }
    } catch (e) {
      console.log(chalk.red(`\n  ✗ Buddy summon failed: ${(e as Error).message}\n`))
    }
    setIdle(true)
    return
  }

  // /sessions — list all saved sessions
  if (text.toLowerCase() === '/sessions') {
    const sessions = listSessions()
    if (sessions.length === 0) {
      console.log(chalk.dim('\n  No saved sessions yet. Use /save <name> to create one.\n'))
    } else {
      console.log(chalk.cyan.bold('\n  Saved sessions:\n'))
      for (const s of sessions) {
        const when = new Date(s.savedAt).toLocaleString()
        console.log(`  ${chalk.cyan(s.name)} ${chalk.dim(`· ${s.messages} msgs · ${when}`)}`)
        console.log(chalk.dim(`    ${s.cwd}`))
      }
      console.log(chalk.dim('\n  Resume with: duckcode --resume <name>\n'))
    }
    setIdle(true)
    return
  }

  // /init [--force]
  if (text.toLowerCase().startsWith('/init')) {
    const force = text.includes('--force')
    await runInit(workDir, force)
    setIdle(true)
    return
  }

  // /skills — list available skills
  if (text.toLowerCase() === '/skills') {
    const skills = getAllSkills()
    if (skills.length === 0) {
      console.log(chalk.dim('\n  No skills found. Add .md files to .duck/skills/ or ~/.duck/skills/\n'))
    } else {
      console.log(chalk.cyan.bold('\n  Available skills:\n'))
      for (const s of skills) {
        console.log(`  ${chalk.cyan('/' + s.name)}${s.description ? chalk.dim(' — ' + s.description) : ''}`)
        if (s.aliases.length > 0) {
          console.log(chalk.dim(`     aliases: ${s.aliases.map((a) => '/' + a).join(', ')}`))
        }
        if (s.triggers.length > 0) {
          console.log(chalk.dim(`     triggers: ${s.triggers.join(', ')}`))
        }
      }
      console.log()
    }
    setIdle(true)
    return
  }

  // Slash command → skill
  const skillMatch = resolveSlashCommand(text)
  if (skillMatch) {
    const { skill, args } = skillMatch
    // Inject skill prompt + user args as the message
    const prompt = args
      ? `${skill.prompt}\n\n---\nUser input: ${args}`
      : skill.prompt
    text = prompt
    console.log(chalk.dim(`  ⚡ Running skill: ${skill.name}`))
  }

  // Expand @mentions (file attachments + image URLs)
  const expanded = expandMentions(text, workDir)
  for (const warning of expanded.warnings) {
    console.log(chalk.yellow(`  ⚠ ${warning}`))
  }
  const finalText = expanded.text
  const imageAttachments = expanded.images

  outputUser(text)  // Show original input with @mentions, not expanded
  outputAssistantStart()
  setIdle(false)
  pendingTools = new Map()

  for await (const event of engine.run(finalText, workDir, handlePermission, { images: imageAttachments })) {
    switch (event.type) {
      case 'text_delta':
        stopSpinner()
        streamText(event.delta)
        break

      case 'tool_start':
        stopSpinner()
        pendingTools.set(event.id, { name: event.name, input: event.input })
        outputToolCall({
          id: event.id,
          name: event.name,
          input: event.input,
          status: 'running',
          output: '',
        })
        startSpinner()
        break

      case 'tool_done': {
        const tc = pendingTools.get(event.id)
        if (tc) {
          outputToolCall({
            id: event.id,
            name: tc.name,
            input: tc.input,
            status: event.is_error ? 'error' : 'done',
            output: event.output,
          })
          pendingTools.delete(event.id)
        }
        break
      }

      case 'turn_done':
        streamFinish()
        console.log()
        break

      case 'error':
        streamFinish()
        outputError(event.message)
        break
    }
  }

  pendingTools = new Map()

  // Auto-save session after each turn so --resume picks up the latest state
  try {
    saveSession(engine.getHistory(), workDir, config.model, 'latest')
  } catch {
    // Non-fatal; session persistence is best-effort
  }

  setIdle(true)
}

// ─── Start ───────────────────────────────────────────────────────────────────

printWelcome()

const skills = getAllSkills()
const hooks = listHooks()
const startupInfo = [
  `v${VERSION}`,
  config.model,
  skills.length > 0 ? `${skills.length} skills` : null,
  hooks.length > 0 ? `${hooks.length} hooks` : null,
].filter(Boolean).join(' · ')
console.log(chalk.dim(`  ${startupInfo}\n`))

initializeMcpTools().catch(console.error)
startInput(workDir, handleSubmit)

// Cleanup on exit
process.on('SIGINT', () => {
  stopInput()
  cleanupMcpConnections()
  process.exit(0)
})

// ─── /init command ─────────────────────────────────────────────────────────────

async function runInit(cwd: string, force = false): Promise<void> {
  console.log('\n🔍 Scanning project structure...\n')

  const projectName = basename(cwd)
  const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**', '**/coverage/**']

  const allFiles = await glob('**/*', { cwd, ignore, nodir: true })
  const tsFiles = await glob('**/*.{ts,tsx}', { cwd, ignore })
  const srcFiles = await glob('src/**/*.{ts,tsx}', { cwd, ignore: ['**/node_modules/**', '**/.git/**'] })

  let packageJson: Record<string, unknown> | null = null
  try {
    const pkgPath = resolve(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    }
  } catch {}

  let readmeContent: string | null = null
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const path = resolve(cwd, name)
    if (existsSync(path)) {
      try {
        readmeContent = readFileSync(path, 'utf-8').slice(0, 2000)
        break
      } catch {}
    }
  }

  const isNode = existsSync(resolve(cwd, 'package.json'))
  const isPython = allFiles.some(f => f.endsWith('.py'))
  const isRust = allFiles.some(f => f.endsWith('.rs'))
  const hasDockerfile = allFiles.some(f => f.includes('Dockerfile'))
  const hasGitignore = existsSync(resolve(cwd, '.gitignore'))

  const lines: string[] = [
    `# ${projectName}`,
    '',
    packageJson?.description ? `${packageJson.description}` : 'Project initialized with /init command.',
    '',
    '## project layout',
    '',
    '```',
  ]

  if (srcFiles.length > 0) {
    const tree = buildFileTree(srcFiles.map(f => f.replace('src/', '')))
    lines.push('src/')
    lines.push(...tree)
  } else {
    lines.push('./')
    const topDirs = [...new Set(allFiles
      .filter(f => f.includes('/'))
      .map(f => f.split('/')[0])
    )].sort()
    lines.push(...topDirs.slice(0, 10).map(d => `├── ${d}/`))
  }

  lines.push('```', '')

  const keyFiles = ['package.json', 'tsconfig.json', '.env.example', 'docker-compose.yml']
    .filter(f => allFiles.some(af => af.endsWith(f) || af === f))
  if (keyFiles.length > 0) {
    lines.push('## key files', '')
    for (const f of keyFiles) lines.push(`- \`${f}\``)
    lines.push('')
  }

  if (packageJson && typeof packageJson.scripts === 'object') {
    const scripts = packageJson.scripts as Record<string, string>
    const devScripts = Object.entries(scripts)
      .filter(([k]) => ['dev', 'build', 'test', 'start'].includes(k))
    if (devScripts.length > 0) {
      lines.push('## run / build', '', '```bash')
      for (const [name, cmd] of devScripts) lines.push(`npm run ${name}  # ${cmd}`)
      lines.push('```', '')
    }
  }

  const stack: string[] = []
  if (isNode) stack.push('Node.js')
  if (isPython) stack.push('Python')
  if (isRust) stack.push('Rust')
  if (hasDockerfile) stack.push('Docker')
  if (hasGitignore) stack.push('Git')
  if (tsFiles.length > 0) stack.push('TypeScript')
  if (allFiles.some(f => f.endsWith('.js'))) stack.push('JavaScript')
  if (allFiles.some(f => f.endsWith('.css') || f.endsWith('.scss'))) stack.push('CSS')
  if (allFiles.some(f => f.endsWith('.html'))) stack.push('HTML')
  if (stack.length > 0) {
    lines.push('## tech stack', '', stack.join(' · '), '')
  }

  if (readmeContent) {
    lines.push('## readme excerpt', '', readmeContent.split('\n').slice(0, 20).join('\n'), '')
    if (readmeContent.length > 2000) lines.push('*(truncated)*', '')
  }

  lines.push('---', '', '*Generated by `/init` command*', '')

  const duckMdPath = resolve(cwd, 'DUCK.md')
  if (existsSync(duckMdPath) && !force) {
    console.log('⚠️  DUCK.md already exists. Use `/init --force` to overwrite.')
    return
  }

  writeFileSync(duckMdPath, lines.join('\n'), 'utf-8')
  console.log(`✅ Generated DUCK.md (${lines.length} lines)`)
  console.log(`   ${tsFiles.length} TS/TSX files, ${allFiles.length} total files scanned\n`)
}

function buildFileTree(files: string[]): string[] {
  const tree: Map<string, Set<string>> = new Map()
  for (const file of files) {
    const parts = file.split('/')
    if (parts.length < 2) continue
    const dir = parts[0]
    const rest = parts.slice(1).join('/')
    if (!tree.has(dir)) tree.set(dir, new Set())
    tree.get(dir)!.add(rest)
  }

  const lines: string[] = []
  const sortedDirs = [...tree.keys()].sort()
  for (let i = 0; i < sortedDirs.length; i++) {
    const dir = sortedDirs[i]
    const isLast = i === sortedDirs.length - 1
    lines.push(`${isLast ? '└── ' : '├── '}${dir}/`)
    const subFiles = [...tree.get(dir)!].sort()
    const connector = isLast ? '    ' : '│   '
    for (let j = 0; j < subFiles.length; j++) {
      const isLastFile = j === subFiles.length - 1
      lines.push(`${connector}${isLastFile ? '└── ' : '├── '}${subFiles[j]}`)
    }
  }
  return lines
}
