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

// Menu mode state
let menuMode = false
let menuSelectedIndex = 0
let menuCustomInput = ''
let menuOptions: Array<{ label: string; value: string; hint?: string }> = []
let menuHasCustomInput = false
let menuResolve: ((result: { value: string; customInput?: string }) => void) | null = null

// ─── Prompt rendering ───────────────────────────────────────────────────────

function clearPromptLine(): void {
  process.stdout.write('\r\x1b[K')
}

export function startSpinner(): void {
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
): Promise<{ value: string; customInput?: string }> {
  const preview = JSON.stringify(input, null, 2).split('\n').slice(0, 8).join('\n')
  console.log()
  console.log(chalk.dim('  ' + preview.split('\n').join('\n  ')))

  const options = [
    { label: '允许执行', value: 'allow', hint: '执行工具' },
    { label: '信任该工具（本次会话不再询问）', value: 'trust', hint: '加入信任列表' },
    { label: '拒绝', value: 'deny', hint: '取消操作' },
    { label: '编辑参数', value: 'edit', hint: '修改参数 JSON' },
  ]
  return showMenu(`⚠ ${toolName}`, options, true)
}

// ─── General Menu Component ──────────────────────────────────────────────────

export interface MenuOption {
  label: string
  value: string
  hint?: string
}

export function showMenu(
  title: string,
  options: MenuOption[],
  hasCustomInput: boolean = false,
): Promise<{ value: string; customInput?: string }> {
  return new Promise((resolve) => {
    stopSpinner()
    
    menuOptions = options
    menuHasCustomInput = hasCustomInput
    menuSelectedIndex = 0
    menuCustomInput = ''
    menuResolve = resolve
    menuMode = true

    console.log()
    console.log(chalk.cyan.bold(`  ${title}`))
    console.log(chalk.dim('  ' + '─'.repeat(50)))

    renderMenu()

    const savedPermissionHandler = permissionHandler
    permissionHandler = null // Disable regular permission handler
  })
}

function renderMenu(): void {
  console.log()
  for (let i = 0; i < menuOptions.length; i++) {
    const opt = menuOptions[i]
    const isSelected = i === menuSelectedIndex
    const prefix = isSelected ? chalk.cyan.bold('  ❯ ') : '    '
    const numLabel = chalk.dim(`[${i + 1}]`)
    
    let line = `${prefix}${numLabel} ${chalk.bold(opt.label)}`
    if (opt.hint) {
      line += chalk.dim(` · ${opt.hint}`)
    }
    console.log(line)
  }

  if (menuHasCustomInput) {
    const isCustomSelected = menuSelectedIndex === menuOptions.length
    const prefix = isCustomSelected ? chalk.cyan.bold('  ❯ ') : '    '
    const customLabel = chalk.bold('选择以自定义输入')
    let line = `${prefix}选择以自定义输入`
    if (menuCustomInput) {
      line += chalk.dim(` · 当前：${menuCustomInput}`)
    }
    console.log(line)
  }

  console.log()
  console.log(chalk.dim('  ↑↓ 移动 · 1-9 选择 · Enter 确认'))
  console.log(chalk.dim('  按 Esc 取消'))
}

function submitMenu(): void {
  menuMode = false
  
  if (menuHasCustomInput && menuSelectedIndex === menuOptions.length) {
    if (menuCustomInput.trim()) {
      console.log(chalk.green('  ✓ 已提交自定义输入'))
    } else {
      console.log(chalk.yellow('  ⚠ 自定义输入为空，使用空字符串'))
    }
    menuResolve!({ value: '', customInput: menuCustomInput })
    menuResolve = null
    return
  }

  const selected = menuOptions[menuSelectedIndex]
  console.log(chalk.green('  ✓ 已选择:') + chalk.dim(` ${selected.label}`))
  menuResolve!({ value: selected.value })
  menuResolve = null
}

function cancelMenu(): void {
  menuMode = false
  customInputMode = false
  console.log(chalk.red('  ✗ 已取消'))
  if (menuResolve) {
    menuResolve({ value: '' })
    menuResolve = null
  }
}

// ─── Text Input Mode for Custom Input ───────────────────────────────────────

let customInputMode = false
let customInputBuffer = ''
let resolveCustomInput: ((input: string) => void) | null = null

function startCustomInput(): void {
  customInputMode = true
  customInputBuffer = menuCustomInput
  console.log()
  console.log(chalk.cyan('  编辑参数 (JSON 格式):'))
  console.log(chalk.dim('  ' + '='.repeat(50)))
  
  const savedInputHandler = submitHandler
  let savedIdle = idle
  
  // Temporarily change submit handler for custom input
  submitHandler = (text: string) => {
    if (text === '/cancel' || text === '/done') {
      cancelCustomInput()
      return
    }
    customInputBuffer = text
    console.log(chalk.dim('  ' + '='.repeat(50)))
    console.log(chalk.dim(`  已输入：${text}`))
    console.log(chalk.dim('  按 /done 确认，/cancel 取消'))
  }
  idle = false
  drawPrompt()

  function cancelCustomInput() {
    customInputMode = false
    submitHandler = savedInputHandler
    idle = savedIdle
    menuCustomInput = customInputBuffer
    renderMenu()
    menuMode = false
  }
}

function submitCustomInput(): void {
  customInputMode = false
  menuCustomInput = customInputBuffer
  console.log(chalk.green('  ✓ 已保存自定义输入'))
  renderMenu()
  menuMode = false
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
      // ── Menu mode ────────────────────────────────────────────────────
      if (menuMode) {
        if (ch === '\x1b') { // ESC
          cancelMenu()
          continue
        }
        if (ch === '\r' || ch === '\n') { // Enter
          if (menuHasCustomInput && menuSelectedIndex === menuOptions.length) {
            // Switch to custom input mode
            menuCustomInput = customInputBuffer
            startCustomInput()
            continue
          } else {
            submitMenu()
            continue
          }
        }
        if (ch === 'k' || ch === '\x1b[A') { // Up arrow (k or CSI A)
          menuSelectedIndex = Math.max(0, menuSelectedIndex - 1)
          renderMenu()
          continue
        }
        if (ch === 'j' || ch === '\x1b[B') { // Down arrow (j or CSI B)
          const maxIndex = menuHasCustomInput ? menuOptions.length : menuOptions.length - 1
          menuSelectedIndex = Math.min(maxIndex, menuSelectedIndex + 1)
          renderMenu()
          continue
        }
        // Numeric shortcuts 1-9
        const num = parseInt(ch)
        if (!isNaN(num) && num >= 1 && num <= 9) {
          const maxIndex = menuHasCustomInput ? menuOptions.length : menuOptions.length - 1
          const target = num - 1
          if (target >= 0 && target <= maxIndex) {
            menuSelectedIndex = target
            if (menuHasCustomInput && menuSelectedIndex === menuOptions.length) {
              startCustomInput()
            } else {
              submitMenu()
            }
          }
          continue
        }
        continue
      }

      // ── Custom input mode ───────────────────────────────────────────
      if (customInputMode) {
        // For custom input during menu
        if (ch === '\r' || ch === '\n') {
          submitCustomInput()
          continue
        }
        if (ch === '\x1b') { // ESC
          customInputBuffer = ''
          cancelMenu()
          continue
        }
        if (ch === '\x7f' || ch === '\b') {
          customInputBuffer = customInputBuffer.slice(0, -1)
          renderMenu()
          continue
        }
        if (ch.charCodeAt(0) < 32 && ch !== '\t') continue
        customInputBuffer += ch
        continue
      }

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
