import React, { useState, useCallback, useRef, useEffect } from 'react'
import { render } from 'ink'
import { program } from 'commander'
import { cwd as processCwd } from 'process'
import { resolve, basename } from 'path'
import { randomUUID } from 'crypto'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync } from 'fs'

import { loadConfig, getSystemPrompt } from './config.js'
import { QueryEngine } from './query/engine.js'
import { loadProjectContext } from './memory/context.js'
import { ChatUI, streamText, streamFinish, outputToolCall, outputError } from './ui/chat.js'
import type { AppStatus } from './types.js'

// ── Register all tools (side-effect imports) ──────────────────────────────────
import './tools/bash.js'
import './tools/file-read.js'
import './tools/file-write.js'
import './tools/glob-grep.js'
import './tools/web-fetch.js'
import { initializeMcpTools } from './tools/mcp.js'

// ─────────────────────────────────────────────────────────────────────────────

function App({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<AppStatus>('idle')
  const [pendingPermission, setPendingPermission] = useState<
    { id: string; name: string; input: Record<string, unknown> } | undefined
  >(undefined)

  const config = loadConfig()
  const projectContext = loadProjectContext(cwd)
  const systemPrompt = getSystemPrompt(projectContext)
  const engineRef = useRef(new QueryEngine(config, systemPrompt))
  const permissionResolverRef = useRef<((granted: boolean) => void) | null>(null)
  
  // Track current assistant for tool calls
  const currentAssistantRef = useRef<{ id: string; toolCalls: Map<string, { name: string; input: Record<string, unknown> }> } | null>(null)

  // ── Initialize MCP servers ─────────────────────────────────────────────────
  useEffect(() => {
    initializeMcpTools()
      .catch(console.error)
    
    return () => {
      import('./tools/mcp.js').then(m => m.cleanupMcpConnections())
    }
  }, [])

  // ── Permission gate ───────────────────────────────────────────────────────

  const handlePermission = useCallback(
    (id: string, name: string, input: Record<string, unknown>): Promise<boolean> => {
      return new Promise(resolve => {
        setPendingPermission({ id, name, input })
        permissionResolverRef.current = (granted: boolean) => {
          setPendingPermission(undefined)
          permissionResolverRef.current = null
          resolve(granted)
        }
      })
    },
    [],
  )

  const handlePermissionDecide = useCallback((granted: boolean) => {
    permissionResolverRef.current?.(granted)
  }, [])

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (text: string) => {
      // Handle /clear command
      if (text.trim().toLowerCase() === '/clear') {
        engineRef.current.clearHistory()
        console.log('\n✓ Conversation cleared. Ready for a fresh start!\n')
        return
      }

      // Handle /init command
      if (text.trim().toLowerCase() === '/init') {
        await runInit(cwd)
        return
      }

      // Initialize current assistant tracker
      currentAssistantRef.current = {
        id: randomUUID(),
        toolCalls: new Map(),
      }

      setStatus('thinking')

      const engine = engineRef.current
      for await (const event of engine.run(text, cwd, handlePermission)) {
        switch (event.type) {
          case 'text_delta':
            setStatus('thinking')
            streamText(event.delta)
            break

          case 'tool_start': {
            setStatus('tool_running')
            // Track tool call
            currentAssistantRef.current?.toolCalls.set(event.id, {
              name: event.name,
              input: event.input,
            })
            break
          }

          case 'tool_done': {
            // Output tool call result
            const tc = currentAssistantRef.current?.toolCalls.get(event.id)
            if (tc) {
              outputToolCall({
                id: event.id,
                name: tc.name,
                input: tc.input,
                status: event.is_error ? 'error' : 'done',
                output: event.output,
              })
              currentAssistantRef.current?.toolCalls.delete(event.id)
            }
            break
          }

          case 'permission_request':
            setStatus('awaiting_permission')
            break

          case 'permission_granted':
            setStatus('tool_running')
            break

          case 'turn_done':
            streamFinish()
            setStatus('idle')
            currentAssistantRef.current = null
            console.log()
            break

          case 'error':
            streamFinish()
            outputError(event.message)
            setStatus('error')
            currentAssistantRef.current = null
            // Reset to idle after a moment
            setTimeout(() => setStatus('idle'), 2000)
            break
        }
      }
    },
    [handlePermission, cwd],
  )

  return (
    <ChatUI
      messages={[]}  // Not used in hybrid mode
      status={status}
      model={config.model}
      cwd={cwd}
      pendingPermission={pendingPermission}
      onSubmit={handleSubmit}
      onPermissionDecide={handlePermissionDecide}
    />
  )
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

program
  .name('duck')
  .description('Duck — AI coding assistant')
  .version('0.1.0')
  .option('-d, --dir <path>', 'Working directory', '.')
  .parse()

const opts = program.opts()
const workDir = resolve(processCwd(), opts.dir as string)

render(<App cwd={workDir} />)

// ─── /init command ─────────────────────────────────────────────────────────────

async function runInit(cwd: string): Promise<void> {
  console.log('\n🔍 Scanning project structure...\n')

  const projectName = basename(cwd)
  const ignore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**', '**/coverage/**']

  // Scan key files
  const allFiles = await glob('**/*', { cwd, ignore, nodir: true })
  const tsFiles = await glob('**/*.{ts,tsx}', { cwd, ignore })
  const srcFiles = await glob('src/**/*.{ts,tsx}', { cwd, ignore: ['**/node_modules/**', '**/.git/**'] })

  // Try reading package.json and README
  let packageJson: Record<string, unknown> | null = null
  let readmeContent: string | null = null
  let readmePath: string | null = null

  try {
    const pkgPath = resolve(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    }
  } catch {}

  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const path = resolve(cwd, name)
    if (existsSync(path)) {
      try {
        readmeContent = readFileSync(path, 'utf-8').slice(0, 2000)
        readmePath = name
        break
      } catch {}
    }
  }

  // Detect project type
  const isNode = existsSync(resolve(cwd, 'package.json'))
  const isPython = allFiles.some(f => f.endsWith('.py'))
  const isRust = allFiles.some(f => f.endsWith('.rs'))
  const hasDockerfile = allFiles.some(f => f.includes('Dockerfile'))
  const hasGitignore = existsSync(resolve(cwd, '.gitignore'))

  // Build DUCK.md content
  const lines: string[] = [
    `# ${projectName}`,
    '',
    packageJson?.description
      ? `${packageJson.description}`
      : 'Project initialized with /init command.',
    '',
    '## project layout',
    '',
    '```',
  ]

  // Build a simplified tree structure from src files
  if (srcFiles.length > 0) {
    const tree = buildFileTree(srcFiles.map(f => f.replace('src/', '')))
    lines.push('src/')
    lines.push(...tree)
  } else {
    // Generic structure
    lines.push('./')
    const topDirs = [...new Set(allFiles
      .filter(f => f.includes('/'))
      .map(f => f.split('/')[0])
    )].sort()
    lines.push(...topDirs.slice(0, 10).map(d => `├── ${d}/`))
  }

  lines.push('```')
  lines.push('')

  // Key files section
  const keyFiles = ['package.json', 'tsconfig.json', '.env.example', 'docker-compose.yml']
    .filter(f => allFiles.some(af => af.endsWith(f) || af === f))
  if (keyFiles.length > 0) {
    lines.push('## key files')
    lines.push('')
    for (const f of keyFiles) {
      lines.push(`- \`${f}\``)
    }
    lines.push('')
  }

  // Run / build section
  if (packageJson && typeof packageJson.scripts === 'object') {
    const scripts = packageJson.scripts as Record<string, string>
    const devScripts = Object.entries(scripts)
      .filter(([k]) => ['dev', 'build', 'test', 'start'].includes(k))
    if (devScripts.length > 0) {
      lines.push('## run / build')
      lines.push('')
      lines.push('```bash')
      for (const [name, cmd] of devScripts) {
        lines.push(`npm run ${name}  # ${cmd}`)
      }
      lines.push('```')
      lines.push('')
    }
  }

  // Tech stack
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
    lines.push('## tech stack')
    lines.push('')
    lines.push(stack.join(' · '))
    lines.push('')
  }

  // README excerpt
  if (readmeContent) {
    lines.push('## readme excerpt')
    lines.push('')
    lines.push(readmeContent.split('\n').slice(0, 20).join('\n'))
    lines.push('')
    if (readmeContent.length > 2000) lines.push('*(truncated)*')
    lines.push('')
  }

  // Footer
  lines.push('---')
  lines.push('')
  lines.push('*Generated by `/init` command*')
  lines.push('')

  const duckMdPath = resolve(cwd, 'DUCK.md')

  // Check if already exists
  if (existsSync(duckMdPath)) {
    console.log('⚠️  DUCK.md already exists. Use `/init --force` to overwrite (not yet implemented).')
    return
  }

  writeFileSync(duckMdPath, lines.join('\n'), 'utf-8')
  console.log(`✅ Generated DUCK.md (${lines.length} lines)`)
  console.log(`   ${tsFiles.length} TS/TSX files, ${allFiles.length} total files scanned`)
  console.log()
}

// Build a simplified tree from flat file paths
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
