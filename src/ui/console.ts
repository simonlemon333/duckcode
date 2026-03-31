/**
 * Console output module - handles all stdout output with chalk styling
 *
 * IMPORTANT: Uses console.log() instead of process.stdout.write() because
 * Ink intercepts console.log and renders it above its managed area.
 * Direct stdout writes conflict with Ink's renderer.
 */

import chalk from 'chalk'
import type { ToolCallDisplay } from '../types.js'

// ─── Markdown rendering ───────────────────────────────────────────────────────

function renderInline(text: string): string {
  text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code))
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, bold) => chalk.bold.white(bold))
  return text
}

// ─── Tool call output ─────────────────────────────────────────────────────────

export function outputToolCall(tc: ToolCallDisplay): void {
  const icon = tc.status === 'done'
    ? chalk.green('✓')
    : tc.status === 'error'
      ? chalk.red('✗')
      : chalk.yellow('⟳')

  const toolName = tc.status === 'done'
    ? chalk.green.bold(tc.name)
    : chalk.cyan.bold(tc.name)

  const argsPreview = formatArgsPreview(tc.input)
  console.log(`${icon} ${toolName} ${chalk.dim(argsPreview)}`)

  if (tc.output) {
    const lines = tc.output.split('\n')
    const maxLines = 20
    for (const line of lines.slice(0, maxLines)) {
      console.log(`  ${line}`)
    }
    if (lines.length > maxLines) {
      console.log(chalk.dim(`  ... ${lines.length - maxLines} more lines`))
    }
  }
}

function formatArgsPreview(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return '[]'
  const parts = entries.map(([k, v]) => {
    const value = typeof v === 'string'
      ? `"${v.length > 30 ? v.slice(0, 30) + '…' : v}"`
      : JSON.stringify(v).length > 30
        ? JSON.stringify(v).slice(0, 30) + '…'
        : JSON.stringify(v)
    return `${k}: ${value}`
  })
  return `[${parts.join(', ')}]`
}

// ─── Streaming text output ──────────────────────────────────────────────────

let lineBuffer = ''

export function outputAssistantStart(): void {
  console.log(`\n${chalk.green.bold('●')} ${chalk.green('Duck')}`)
}

/**
 * Buffer streaming text and flush complete lines via console.log.
 * Ink intercepts console.log so it renders above the input area.
 */
export function streamText(delta: string): void {
  for (const char of delta) {
    if (char === '\n') {
      console.log(`  ${renderInline(lineBuffer)}`)
      lineBuffer = ''
    } else {
      lineBuffer += char
    }
  }
}

/**
 * Flush any remaining buffered text.
 */
export function streamFinish(): void {
  if (lineBuffer.trim()) {
    console.log(`  ${renderInline(lineBuffer)}`)
  }
  lineBuffer = ''
}

// ─── Other output ────────────────────────────────────────────────────────────

export function outputUser(text: string): void {
  console.log(`\n${chalk.blue.bold('❯')} ${text}`)
}

export function printWelcome(): void {
  console.log(chalk.cyan.bold('\n  🦆 Duck'))
  console.log(chalk.dim('  AI coding assistant — type /clear to reset'))
  console.log(chalk.dim('  ─────────────────────────────────────────\n'))
}

export function outputError(message: string): void {
  console.log(`${chalk.red.bold('✗ Error:')} ${message}`)
}
