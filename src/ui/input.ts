/**
 * Raw terminal input — no Ink, no React.
 *
 * Sets stdin to raw mode, handles keystroke-by-keystroke input,
 * debounces multi-line paste, and manages permission prompts.
 */

import chalk from 'chalk'
import { readdirSync, statSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'

type SubmitHandler = (text: string) => void
type PermissionHandler = (granted: boolean) => void

let inputBuffer = ''
let submitHandler: SubmitHandler | null = null
let permissionHandler: PermissionHandler | null = null
let submitTimer: ReturnType<typeof setTimeout> | null = null
let idle = true
let shortCwd = ''

// Command completion: main.ts registers the full list of commands
// (built-ins + skill names + aliases) via setCommandList().
let commandList: string[] = []
let inputCwd: string = process.cwd()

export function setCommandList(commands: string[]): void {
  commandList = [...commands].sort()
}

// ─── Hint lines (real-time dropdown below prompt) ────────────────────────

let hintLineCount = 0
const MAX_HINT_LINES = 8

// Current list of matches in the hint (used by nav + accept)
let currentHintMatches: string[] = []
// Index of highlighted row in the hint dropdown. -1 = no selection.
let hintSelectedIndex = -1
// What kind of hint is currently shown (affects how acceptHintSelection
// rewrites the input buffer)
type HintKind = 'none' | 'slash' | 'file'
let hintKind: HintKind = 'none'

function clearHint(): void {
  if (hintLineCount === 0) return
  // Move down, clear each line, move back up. Using \x1b[E (cursor next
  // line) avoids scrolling that \n would cause near terminal bottom.
  for (let i = 0; i < hintLineCount; i++) {
    process.stdout.write('\x1b[E\x1b[2K')
  }
  process.stdout.write(`\x1b[${hintLineCount}F`)  // N previous lines, col 0
  hintLineCount = 0
}

function drawHint(lines: string[]): void {
  // First erase any existing hint lines below us
  clearHint()
  if (lines.length === 0) return
  const shown = lines.slice(0, MAX_HINT_LINES)
  // Remember prompt line column 0 — we need to return there after drawing.
  // We save cursor AT PROMPT LINE (after the prompt content), draw hint below,
  // then restore.
  process.stdout.write('\x1b[s')
  for (const line of shown) {
    process.stdout.write('\x1b[E\x1b[2K' + line)
  }
  process.stdout.write('\x1b[u')
  hintLineCount = shown.length
}

/**
 * Given the current input buffer, compute what hint (if any) to show.
 * Updates module state: currentHintMatches, hintKind.
 * Returns rendered lines for drawHint().
 */
function computeHint(buffer: string): string[] {
  // Case 1: slash command — buffer starts with /
  if (buffer.startsWith('/')) {
    const query = buffer.slice(1).toLowerCase()
    const matches = commandList.filter((c) => c.startsWith(query))
    currentHintMatches = matches
    hintKind = matches.length > 0 ? 'slash' : 'none'
    return matches.slice(0, MAX_HINT_LINES).map((c, idx) => {
      const label = '/' + c
      if (idx === hintSelectedIndex) {
        return chalk.dim('    ') + chalk.bgCyan.black(' ' + label + ' ')
      }
      return chalk.dim('    ') + chalk.cyan(label)
    })
  }

  // Case 2: @mention — last @ followed by path/url fragment
  const atMatch = buffer.match(/@([^\s]*)$/)
  if (atMatch) {
    const fragment = atMatch[1]
    if (fragment.startsWith('http')) {
      currentHintMatches = []
      hintKind = 'none'
      return []
    }
    const matches = computeFileMatches(fragment)
    currentHintMatches = matches
    hintKind = matches.length > 0 ? 'file' : 'none'
    return matches.slice(0, MAX_HINT_LINES).map((name, idx) => {
      const label = '@' + name
      if (idx === hintSelectedIndex) {
        return chalk.dim('    ') + chalk.bgCyan.black(' ' + label + ' ')
      }
      return chalk.dim('    ') + chalk.cyan(label)
    })
  }

  currentHintMatches = []
  hintKind = 'none'
  return []
}

function computeFileMatches(fragment: string): string[] {
  let dir = inputCwd
  let prefix = fragment
  let relDirPrefix = ''
  if (fragment.includes('/')) {
    const lastSlash = fragment.lastIndexOf('/')
    relDirPrefix = fragment.slice(0, lastSlash + 1)
    prefix = fragment.slice(lastSlash + 1)
    dir = join(inputCwd, fragment.slice(0, lastSlash))
  }

  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter((name) => {
        if (name.startsWith('.')) return false
        if (name === 'node_modules') return false
        return name.toLowerCase().startsWith(prefix.toLowerCase())
      })
      .slice(0, MAX_HINT_LINES)
      .map((name) => {
        let full = relDirPrefix + name
        try {
          const st = statSync(join(dir, name))
          if (st.isDirectory()) full += '/'
        } catch {}
        return full
      })
  } catch {
    return []
  }
}

// ─── Hint navigation ────────────────────────────────────────────────────

function handleHintNav(delta: number): void {
  if (currentHintMatches.length === 0) return
  const max = Math.min(currentHintMatches.length, MAX_HINT_LINES) - 1
  if (hintSelectedIndex < 0) {
    hintSelectedIndex = delta > 0 ? 0 : max
  } else {
    hintSelectedIndex = Math.max(0, Math.min(max, hintSelectedIndex + delta))
  }
  drawPrompt()
}

function acceptHintSelection(): void {
  if (hintSelectedIndex < 0 || hintSelectedIndex >= currentHintMatches.length) return
  const selected = currentHintMatches[hintSelectedIndex]

  if (hintKind === 'slash') {
    inputBuffer = '/' + selected + ' '
  } else if (hintKind === 'file') {
    // Replace the last @fragment with @<selected>
    inputBuffer = inputBuffer.replace(/@([^\s]*)$/, '@' + selected)
  }

  hintSelectedIndex = -1
  drawPrompt()
}

/**
 * Compute the longest common prefix of an array of strings.
 */
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return ''
  let prefix = strs[0]
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ''
    }
  }
  return prefix
}

/**
 * Handle Tab key when input starts with `/`. Returns true if handled.
 */
function handleTabCompletion(): boolean {
  if (!inputBuffer.startsWith('/')) return false

  const query = inputBuffer.slice(1).toLowerCase()
  const matches = commandList.filter((c) => c.startsWith(query))

  if (matches.length === 0) return false

  if (matches.length === 1) {
    // Single match — complete it fully and add a space for args
    inputBuffer = '/' + matches[0] + ' '
    drawPrompt()
    return true
  }

  // Multiple matches — complete to longest common prefix
  const prefix = longestCommonPrefix(matches)
  if (prefix.length > query.length) {
    inputBuffer = '/' + prefix
    drawPrompt()
    return true
  }

  // Already at common prefix — print matches above the prompt
  clearPromptLine()
  console.log()
  console.log(chalk.dim('  Matches:'))
  const cols = Math.min(4, matches.length)
  const colWidth = Math.max(...matches.map((m) => m.length)) + 3
  for (let i = 0; i < matches.length; i += cols) {
    const row = matches.slice(i, i + cols)
      .map((m) => chalk.cyan('/' + m).padEnd(colWidth + 10))
      .join('')
    console.log('  ' + row)
  }
  console.log()
  drawPrompt()
  return true
}
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
    clearHint()
    startSpinner()
    return
  }
  stopSpinner()
  const display = inputBuffer || chalk.dim(`Ask Duck… (${shortCwd})`)
  process.stdout.write(chalk.cyan.bold('  ❯ ') + display)
  // Update the real-time hint dropdown below the prompt
  drawHint(computeHint(inputBuffer))
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
    clearHint()

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
  inputCwd = cwd
  submitHandler = onSubmit

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')

  process.stdin.on('data', (data: string) => {
    // ── Menu mode: handle full data chunk for arrow key sequences ────
    if (menuMode) {
      if (data === '\x1b' || data === 'q') { // ESC or q to cancel
        cancelMenu()
        return
      }
      if (data === '\r' || data === '\n') { // Enter
        if (menuHasCustomInput && menuSelectedIndex === menuOptions.length) {
          menuCustomInput = customInputBuffer
          startCustomInput()
        } else {
          submitMenu()
        }
        return
      }
      if (data === '\x1b[A' || data === 'k') { // Up arrow or k
        menuSelectedIndex = Math.max(0, menuSelectedIndex - 1)
        renderMenu()
        return
      }
      if (data === '\x1b[B' || data === 'j') { // Down arrow or j
        const maxIndex = menuHasCustomInput ? menuOptions.length : menuOptions.length - 1
        menuSelectedIndex = Math.min(maxIndex, menuSelectedIndex + 1)
        renderMenu()
        return
      }
      // Numeric shortcuts 1-9
      const num = parseInt(data)
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
        return
      }
      return
    }

    let i = 0
    while (i < data.length) {
      const ch = data[i]

      // ── Escape sequence (arrow keys, etc) ──────────────────────────
      // \x1b[A = Up, \x1b[B = Down, \x1b[C = Right, \x1b[D = Left
      if (ch === '\x1b' && !customInputMode) {
        // Bare Escape (no following [) — dismiss hint nav
        if (data[i + 1] !== '[') {
          if (hintSelectedIndex >= 0) {
            hintSelectedIndex = -1
            drawPrompt()
          }
          i++
          continue
        }
        // \x1b[X — 3-byte CSI sequence
        const code = data[i + 2]
        if (code === 'A') {
          // Up — navigate hint UP (or ignore if no hint)
          handleHintNav(-1)
          i += 3
          continue
        }
        if (code === 'B') {
          // Down — navigate hint DOWN
          handleHintNav(+1)
          i += 3
          continue
        }
        // Ignore left/right/other CSI for now
        i += 3
        continue
      }

      // ── Custom input mode ───────────────────────────────────────────
      if (customInputMode) {
        if (ch === '\r' || ch === '\n') { submitCustomInput(); i++; continue }
        if (ch === '\x1b') { customInputBuffer = ''; cancelMenu(); i++; continue }
        if (ch === '\x7f' || ch === '\b') {
          customInputBuffer = customInputBuffer.slice(0, -1)
          renderMenu()
          i++; continue
        }
        if (ch.charCodeAt(0) < 32 && ch !== '\t') { i++; continue }
        customInputBuffer += ch
        i++; continue
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
        i++; continue
      }

      // ── Ctrl+C / Ctrl+D ─────────────────────────────────────────────
      if (ch === '\x03' || ch === '\x04') {
        console.log()
        process.exit(0)
      }

      // ── Ctrl+L — clear screen ──────────────────────────────────────
      if (ch === '\x0c') {
        process.stdout.write('\x1b[2J\x1b[H')
        drawPrompt()
        i++; continue
      }

      if (!idle) { i++; continue }

      // ── Enter ───────────────────────────────────────────────────────
      if (ch === '\r' || ch === '\n') {
        // If navigating hints with arrow keys, accept selected instead of submitting
        if (hintSelectedIndex >= 0 && currentHintMatches.length > hintSelectedIndex) {
          acceptHintSelection()
          i++; continue
        }
        if (inputBuffer.length > 0) {
          inputBuffer += '\n'
          if (submitTimer) clearTimeout(submitTimer)
          submitTimer = setTimeout(flushSubmit, 80)
        }
        i++; continue
      }

      // Cancel pending submit if more chars arrive (paste in progress)
      if (submitTimer) {
        clearTimeout(submitTimer)
        submitTimer = null
      }

      // ── Backspace ───────────────────────────────────────────────────
      if (ch === '\x7f' || ch === '\b') {
        inputBuffer = inputBuffer.slice(0, -1)
        hintSelectedIndex = -1
        drawPrompt()
        i++; continue
      }

      // ── Tab — slash command completion ──────────────────────────────
      if (ch === '\t') {
        handleTabCompletion()
        i++; continue
      }

      // ── Ignore other control bytes ──────────────────────────────────
      if (ch.charCodeAt(0) < 32) { i++; continue }

      // ── Normal character ────────────────────────────────────────────
      inputBuffer += ch
      hintSelectedIndex = -1
      drawPrompt()
      i++
    }
  })

  drawPrompt()
}

function flushSubmit(): void {
  submitTimer = null
  const text = inputBuffer.trim()
  inputBuffer = ''
  clearHint()
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
