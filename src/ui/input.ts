/**
 * Raw terminal input — no Ink, no React.
 *
 * Sets stdin to raw mode, handles keystroke-by-keystroke input,
 * debounces multi-line paste, and manages permission prompts.
 */

import chalk from 'chalk'

type SubmitHandler = (text: string) => void
type PermissionHandler = (granted: boolean) => void

let inputBuffer = ''
let submitHandler: SubmitHandler | null = null
let permissionHandler: PermissionHandler | null = null
let submitTimer: ReturnType<typeof setTimeout> | null = null
let idle = true
let shortCwd = ''
let spinnerTimer: ReturnType<typeof setInterval> | null = null
let spinnerFrame = 0
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ─── Prompt rendering ───────────────────────────────────────────────────────

function clearPromptLine(): void {
  process.stdout.write('\r\x1b[K')
}

function startSpinner(): void {
  if (spinnerTimer) return
  spinnerFrame = 0
  spinnerTimer = setInterval(() => {
    clearPromptLine()
    const frame = chalk.cyan(spinnerFrames[spinnerFrame % spinnerFrames.length])
    process.stdout.write(`  ${frame} ${chalk.dim('thinking…')}`)
    spinnerFrame++
  }, 80)
}

export function stopSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
    clearPromptLine()
  }
}

function drawPrompt(): void {
  clearPromptLine()
  if (!idle) {
    startSpinner()
    return
  }
  stopSpinner()
  const display = inputBuffer || chalk.dim(`Ask Duck… (${shortCwd})`)
  process.stdout.write(chalk.cyan.bold('  ❯ ') + display)
}

// ─── Permission prompt ──────────────────────────────────────────────────────

export function showPermission(
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  return new Promise((resolve) => {
    stopSpinner()
    const preview = JSON.stringify(input, null, 2).split('\n').slice(0, 8).join('\n')
    console.log()
    console.log(chalk.yellow(`  ⚠ ${chalk.bold(toolName)} — approve?`))
    console.log(chalk.dim('  ' + preview.split('\n').join('\n  ')))
    console.log(chalk.dim('  ') + chalk.green.bold('y') + chalk.dim(' yes · ') + chalk.red.bold('n') + chalk.dim(' no'))

    permissionHandler = (granted: boolean) => {
      permissionHandler = null
      resolve(granted)
    }
  })
}

// ─── State control (called by main loop) ─────────────────────────────────────

export function setIdle(value: boolean): void {
  idle = value
  drawPrompt()
}

// ─── Start listening ─────────────────────────────────────────────────────────

export function startInput(
  cwd: string,
  onSubmit: SubmitHandler,
): void {
  shortCwd = cwd.replace(process.env.HOME ?? '', '~')
  submitHandler = onSubmit

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')

  process.stdin.on('data', (data: string) => {
    for (const ch of data) {
      // ── Permission mode ─────────────────────────────────────────────
      if (permissionHandler) {
        if (ch === 'y' || ch === 'Y') {
          console.log(chalk.green('  ✓ granted'))
          permissionHandler(true)
        } else if (ch === 'n' || ch === 'N' || ch === '\x03') {
          console.log(chalk.red('  ✗ denied'))
          permissionHandler(false)
        }
        continue
      }

      // ── Ctrl+C / Ctrl+D ─────────────────────────────────────────────
      if (ch === '\x03' || ch === '\x04') {
        console.log()
        process.exit(0)
      }

      if (!idle) continue

      // ── Enter ───────────────────────────────────────────────────────
      if (ch === '\r' || ch === '\n') {
        // Debounce: wait 80ms for more paste data before submitting
        if (inputBuffer.length > 0) {
          inputBuffer += '\n'
          if (submitTimer) clearTimeout(submitTimer)
          submitTimer = setTimeout(flushSubmit, 80)
        }
        continue
      }

      // Cancel pending submit if more chars arrive (paste in progress)
      if (submitTimer) {
        clearTimeout(submitTimer)
        submitTimer = null
      }

      // ── Backspace ───────────────────────────────────────────────────
      if (ch === '\x7f' || ch === '\b') {
        inputBuffer = inputBuffer.slice(0, -1)
        drawPrompt()
        continue
      }

      // ── Ignore control/arrow sequences ──────────────────────────────
      if (ch.charCodeAt(0) < 32 && ch !== '\t') continue

      // ── Normal character ────────────────────────────────────────────
      inputBuffer += ch
      drawPrompt()
    }
  })

  drawPrompt()
}

function flushSubmit(): void {
  submitTimer = null
  const text = inputBuffer.trim()
  inputBuffer = ''
  clearPromptLine()
  if (text && submitHandler) {
    submitHandler(text)
  } else {
    drawPrompt()
  }
}

export function stopInput(): void {
  process.stdin.setRawMode(false)
  process.stdin.pause()
}
