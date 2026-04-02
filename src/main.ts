import { program } from 'commander'
import { cwd as processCwd } from 'process'
import { resolve, basename } from 'path'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import chalk from 'chalk'

import { loadConfig, getSystemPrompt } from './config.js'
import { QueryEngine } from './query/engine.js'
import { loadProjectContext } from './memory/context.js'
import {
  printWelcome,
  outputUser,
  outputAssistantStart,
  streamText,
  streamFinish,
  outputToolCall,
  outputError,
} from './ui/console.js'
import { startInput, setIdle, showPermission, stopInput, stopSpinner, startSpinner } from './ui/input.js'
import type { PermissionCallback, PermissionResult } from './query/engine.js'

// ── Register all tools (side-effect imports) ──────────────────────────────────
import './tools/bash.js'
import './tools/file-read.js'
import './tools/file-write.js'
import './tools/glob-grep.js'
import './tools/web-fetch.js'
import { initializeMcpTools, cleanupMcpConnections } from './tools/mcp.js'

// ─── CLI entry point ──────────────────────────────────────────────────────────

program
  .name('duck')
  .description('Duck — AI coding assistant')
  .version('0.1.0')
  .option('-d, --dir <path>', 'Working directory', '.')
  .option('--model <name>', 'Model name to use (from models config)')
  .parse()

const opts = program.opts()
const workDir = resolve(processCwd(), opts.dir as string)

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig(opts.model)
const projectContext = loadProjectContext(workDir)
const systemPrompt = getSystemPrompt(projectContext)
const engine = new QueryEngine(config, systemPrompt)

console.log(`🦆 Using model: ${config.model}`)

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

async function handleSubmit(text: string): Promise<void> {
  // /clear
  if (text.toLowerCase() === '/clear') {
    engine.clearHistory()
    console.log('\n✓ Conversation cleared.\n')
    setIdle(true)
    return
  }

  // /init
  if (text.toLowerCase() === '/init') {
    await runInit(workDir)
    setIdle(true)
    return
  }

  outputUser(text)
  outputAssistantStart()
  setIdle(false)
  pendingTools = new Map()

  for await (const event of engine.run(text, workDir, handlePermission)) {
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
  setIdle(true)
}

// ─── Start ───────────────────────────────────────────────────────────────────

printWelcome()
initializeMcpTools().catch(console.error)
startInput(workDir, handleSubmit)

// Cleanup on exit
process.on('SIGINT', () => {
  stopInput()
  cleanupMcpConnections()
  process.exit(0)
})

// ─── /init command ─────────────────────────────────────────────────────────────

async function runInit(cwd: string): Promise<void> {
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
  if (existsSync(duckMdPath)) {
    console.log('⚠️  DUCK.md already exists. Use `/init --force` to overwrite (not yet implemented).')
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
