/**
 * Console output — all rendering via console.log, zero TUI framework.
 */

import chalk from 'chalk'
import type { ToolCallDisplay } from '../types.js'

// ─── Inline markdown ─────────────────────────────────────────────────────────

function renderInline(text: string): string {
  // ```code blocks``` — handled at block level, not here
  // `inline code` — cyan
  text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code))
  // **bold**
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, b) => chalk.bold(b))
  // *italic*
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, i) => chalk.italic(i))
  return text
}

// ─── Block-level markdown streaming ──────────────────────────────────────────

let lineBuffer = ''
let inCodeBlock = false
let codeBlockLang = ''

function outputLine(line: string): void {
  // Code block fence
  if (line.startsWith('```')) {
    if (!inCodeBlock) {
      inCodeBlock = true
      codeBlockLang = line.slice(3).trim()
      console.log(chalk.dim(`  ┌─ ${codeBlockLang || 'code'} ${'─'.repeat(Math.max(0, 40 - (codeBlockLang || 'code').length))}`))
    } else {
      inCodeBlock = false
      codeBlockLang = ''
      console.log(chalk.dim('  └' + '─'.repeat(44)))
    }
    return
  }

  if (inCodeBlock) {
    console.log(chalk.dim('  │ ') + chalk.white(line))
    return
  }

  // Headings
  const h3 = line.match(/^### (.+)/)
  if (h3) { console.log(`  ${chalk.bold(h3[1])}`); return }
  const h2 = line.match(/^## (.+)/)
  if (h2) { console.log(`  ${chalk.cyan.bold(h2[1])}`); return }
  const h1 = line.match(/^# (.+)/)
  if (h1) { console.log(`  ${chalk.cyan.bold.underline(h1[1])}`); return }

  // Unordered list
  if (line.match(/^[-*] /)) {
    console.log(`  ${chalk.dim('•')} ${renderInline(line.slice(2))}`)
    return
  }

  // Numbered list
  const num = line.match(/^(\d+)\.\s(.+)/)
  if (num) {
    console.log(`  ${chalk.dim(num[1] + '.')} ${renderInline(num[2])}`)
    return
  }

  // Blockquote
  if (line.startsWith('> ')) {
    console.log(chalk.dim('  ▏ ') + chalk.italic(renderInline(line.slice(2))))
    return
  }

  // Horizontal rule
  if (line.match(/^---+$/)) {
    console.log(chalk.dim('  ' + '─'.repeat(44)))
    return
  }

  // Normal text
  console.log(`  ${renderInline(line)}`)
}

// ─── Tool call output ─────────────────────────────────────────────────────────

export function outputToolCall(tc: ToolCallDisplay): void {
  const icon = tc.status === 'done'
    ? chalk.green('✓')
    : tc.status === 'running'
      ? chalk.yellow('⟳')
      : chalk.red('✗')

  const name = tc.status === 'done'
    ? chalk.green(tc.name)
    : tc.status === 'running'
      ? chalk.cyan(tc.name)
      : chalk.red(tc.name)

  // Compact args: show key values inline
  const args = formatArgs(tc.input)

  console.log(`  ${icon} ${name} ${chalk.dim(args)}`)

  // Show output (truncated)
  if (tc.output && tc.status === 'error') {
    const lines = tc.output.split('\n').slice(0, 5)
    for (const line of lines) {
      console.log(chalk.dim(`    ${line}`))
    }
  } else if (tc.output) {
    const lines = tc.output.split('\n')
    const preview = lines.slice(0, 6)
    for (const line of preview) {
      console.log(chalk.dim(`    ${line.slice(0, 100)}`))
    }
    if (lines.length > 6) {
      console.log(chalk.dim(`    … ${lines.length - 6} more lines`))
    }
  }
}

function formatArgs(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([k, v]) => {
    const val = typeof v === 'string'
      ? v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`
      : JSON.stringify(v)
    return `${k}: ${val}`
  })
  return parts.length > 0 ? `{${parts.join(', ')}}` : ''
}

// ─── Streaming text ──────────────────────────────────────────────────────────

export function outputAssistantStart(): void {
  console.log()
  console.log(chalk.green.bold('  ● Duck'))
  console.log()
}

export function streamText(delta: string): void {
  for (const char of delta) {
    if (char === '\n') {
      outputLine(lineBuffer)
      lineBuffer = ''
    } else {
      lineBuffer += char
    }
  }
}

export function streamFinish(): void {
  if (lineBuffer.trim()) {
    outputLine(lineBuffer)
  }
  lineBuffer = ''
  inCodeBlock = false
  codeBlockLang = ''
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function outputUser(text: string): void {
  console.log()
  const lines = text.split('\n')
  console.log(chalk.blue.bold('  ❯ ') + chalk.white.bold(lines[0]))
  for (const line of lines.slice(1)) {
    console.log(chalk.blue('    ') + chalk.white.bold(line))
  }
}

export function printWelcome(): void {
  console.log()
  console.log(chalk.cyan.bold('  🦆 Duck'))
  console.log(chalk.dim('  AI coding assistant · /clear to reset · Ctrl+C to exit'))
  console.log()
}

export function outputError(message: string): void {
  console.log(chalk.red(`  ✗ Error: ${message}`))
}
