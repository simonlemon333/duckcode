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

// When true, the raw-mode data handler ignores all input. Used while
// readline-based flows (config wizard) own stdin. The handler stays
// attached — the flag is just a "hardware mute" so readline's listener
// can process keystrokes cleanly without our raw-mode logic also firing.
let wizardActive = false

// Bracketed paste mode: when the terminal supports it (\x1b[?2004h), pasted
// text arrives wrapped between \x1b[200~ and \x1b[201~. Detecting these
// markers lets us treat a paste as one input event instead of N keystrokes
// — which fixes multi-line paste truncation seen with naive raw input.
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
let pasteMode = false           // True between START and END markers
let pasteBuffer = ''            // Accumulated paste content (may span chunks)

// Command completion: main.ts registers the full list of commands
// (built-ins + skill names + aliases) via setCommandList().
let commandList: string[] = []
let inputCwd: string = process.cwd()

export function setCommandList(commands: string[]): void {
  commandList = [...commands].sort()
}

// ─── Hint lines (real-time dropdown below prompt) ────────────────────────

// Total rows in the current prompt block (top border + input + hints + bottom
// border + footer). 0 means nothing currently drawn — clearPromptBlock is a
// no-op then. The block is fully redrawn on each keystroke; we accept the
// scroll cost when hint count changes (rare) for a much simpler state machine.
let promptBlockTotalRows = 0
const MAX_HINT_LINES = 8

// Current list of matches in the hint (used by nav + accept)
let currentHintMatches: string[] = []
// Index of highlighted row in the hint dropdown. -1 = no selection.
let hintSelectedIndex = -1
// What kind of hint is currently shown (affects how acceptHintSelection
// rewrites the input buffer)
type HintKind = 'none' | 'slash' | 'file'
let hintKind: HintKind = 'none'

/**
 * Clear the entire prompt block: top border + input row + hint rows + bottom
 * border + footer. After this, cursor is positioned at column 0 of the row
 * where the top border was — ready for the next drawPrompt() to start writing
 * a fresh block at the same screen position (no scrolling unless the new
 * block has different height).
 *
 * Uses non-scrolling cursor moves (\x1b[A/B) so a block at the terminal
 * bottom doesn't push history up on every keystroke.
 */
/**
 * Visible (terminal column) width of a string. CJK ideographs, fullwidth
 * forms, and most emoji occupy 2 columns; ASCII and most Latin-extended
 * occupy 1. We use this for cursor placement after the input row —
 * inputBuffer.length (UTF-16 code units) misplaces the cursor every time
 * a wide character is typed (you'd see the cursor "in the middle" of
 * what looks like the trailing portion of the text).
 *
 * Ranges follow the Unicode East Asian Width property's W and F values
 * approximately; this is a pragmatic subset, not a full wcwidth.
 */
function visibleWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x80) {
      w += 1
    } else if (
      (cp >= 0x1100 && cp <= 0x115F) || // Hangul Jamo (initial)
      (cp >= 0x2E80 && cp <= 0x303E) || // CJK radicals / punctuation
      (cp >= 0x3041 && cp <= 0x33FF) || // Hiragana, Katakana, CJK symbols
      (cp >= 0x3400 && cp <= 0x4DBF) || // CJK Unified Ideographs Ext A
      (cp >= 0x4E00 && cp <= 0x9FFF) || // CJK Unified Ideographs
      (cp >= 0xA000 && cp <= 0xA4CF) || // Yi syllables
      (cp >= 0xAC00 && cp <= 0xD7A3) || // Hangul syllables
      (cp >= 0xF900 && cp <= 0xFAFF) || // CJK compatibility ideographs
      (cp >= 0xFE30 && cp <= 0xFE4F) || // CJK compatibility forms
      (cp >= 0xFF00 && cp <= 0xFF60) || // Fullwidth forms
      (cp >= 0xFFE0 && cp <= 0xFFE6) || // Fullwidth signs
      (cp >= 0x1F300 && cp <= 0x1FAFF) || // Emoji / pictographs
      (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Ext B–F
      (cp >= 0x30000 && cp <= 0x3FFFD)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

function clearPromptBlock(): void {
  if (promptBlockTotalRows === 0) return
  // Cursor is at end-of-input on row 1 of the block (0 = top border).
  process.stdout.write('\r')          // col 0 of input row
  process.stdout.write('\x1b[A')      // up to top border row
  for (let i = 0; i < promptBlockTotalRows; i++) {
    process.stdout.write('\x1b[2K')
    if (i < promptBlockTotalRows - 1) {
      process.stdout.write('\x1b[B\r')
    }
  }
  // Return cursor to col 0 of the (now-blank) top border row.
  if (promptBlockTotalRows > 1) {
    process.stdout.write(`\x1b[${promptBlockTotalRows - 1}A\r`)
  }
  promptBlockTotalRows = 0
}

/**
 * Given the current input buffer, compute what hint (if any) to show.
 * Updates module state: currentHintMatches, hintKind.
 * Returns rendered lines for drawPrompt() to embed in the block.
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

/**
 * Render the full sandwich block:
 *
 *   ─────────────────────  (top border)        row 0
 *   ❯ user input here       (input row)         row 1
 *     /dream — …             (hint dropdown)    rows 2..(H+1)
 *     /diff — …
 *   ─────────────────────  (bottom border)     row H+2
 *     ⏵⏵ ready · /help …    (footer)            row H+3
 *
 * Each call clears the previous block fully and rewrites from scratch.
 * Uses explicit \r\n at line breaks (raw mode disables OPOST so a bare \n
 * is LF-only and doesn't reset column reliably across terminals), and
 * computes the final cursor position arithmetically rather than relying on
 * \x1b[s/\x1b[u (some terminals — Windows Terminal among them — have only
 * one save slot or treat the first restore as a no-op).
 */
function drawPrompt(): void {
  clearPromptBlock()
  if (!idle) {
    startSpinner()
    return
  }
  stopSpinner()

  // Border kept 2 chars shy of terminal edge so it never sits in the
  // pending-wrap state at the last column.
  const width = Math.max((process.stdout.columns || 80) - 2, 10)
  const border = chalk.dim('─'.repeat(width))
  const hintLines = computeHint(inputBuffer)
  const footer =
    chalk.dim('  ⏵⏵ ') +
    chalk.dim(`${shortCwd} · /help to see commands · Ctrl+C to exit`)

  // Top border, input row, hint rows, bottom border, footer.
  // \r\n on each line break to keep column at 0 regardless of OPOST state.
  process.stdout.write(border + '\r\n')
  process.stdout.write(chalk.cyan.bold('  ❯ ') + inputBuffer + '\r\n')
  for (const h of hintLines) {
    process.stdout.write(h + '\r\n')
  }
  process.stdout.write(border + '\r\n')
  process.stdout.write(footer)

  promptBlockTotalRows = hintLines.length + 4 // top + input + hints + bottom + footer

  // Move cursor back to end of input row (row 1 of block).
  // From footer row (row H+3), up by (H + 2) rows reaches input row.
  const upRows = hintLines.length + 2
  // 1-indexed column: "  ❯ " is 4 visible columns, cursor lands just after
  // the typed text. Use visible width (not code-unit length) so CJK / emoji
  // input doesn't leave the cursor stranded inside the string.
  const inputCol = 5 + visibleWidth(inputBuffer)
  if (upRows > 0) {
    process.stdout.write(`\x1b[${upRows}A`)
  }
  process.stdout.write(`\x1b[${inputCol}G`)
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
    clearPromptBlock()

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

// Patch console.log once on first startInput so async writes during the
// idle state (when the prompt block is drawn) clear the block, write to
// scrollback, then redraw. Solves the MCP-load-overlapping-footer race
// and similar interleavings without each call site having to know about
// the renderer. During !idle (block already cleared, streaming/handler
// running), the wrapper passes through unchanged.
let logPatched = false
function patchConsoleLog(): void {
  if (logPatched) return
  logPatched = true
  const original = console.log.bind(console)
  console.log = (...args: unknown[]): void => {
    if (promptBlockTotalRows === 0) {
      original(...args)
      return
    }
    clearPromptBlock()
    original(...args)
    if (idle) drawPrompt()
  }
}

export function startInput(
  cwd: string,
  onSubmit: SubmitHandler,
): void {
  shortCwd = cwd.replace(process.env.HOME ?? '', '~')
  inputCwd = cwd
  submitHandler = onSubmit
  patchConsoleLog()

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf-8')

  // Enable bracketed paste — terminal will wrap pasted text in markers.
  process.stdout.write('\x1b[?2004h')

  // Restore terminal modes on hard process exit (Ctrl+C handled by the data
  // handler calls process.exit(0), which bypasses stopInput). Without this,
  // the user's next shell sees raw \x1b[200~ around pastes and a stuck
  // taskbar progress indicator.
  process.on('exit', () => {
    process.stdout.write('\x1b[?2004l')  // disable bracketed paste
    process.stdout.write('\x1b]9;4;0;\x07')  // clear OSC 9;4 taskbar progress
  })

  // Redraw prompt after terminal resize. Skip while a modal (wizard/menu/
  // permission) owns the screen — those flows manage their own layout and
  // an unexpected redraw would clobber them.
  process.on('SIGWINCH', () => {
    if (wizardActive || menuMode || permissionHandler || !idle) return
    // drawPrompt clears the old block internally; one call is enough.
    drawPrompt()
  })

  process.stdin.on('data', (data: string) => {
    // ── Wizard mode: yield stdin to readline ─────────────────────────
    if (wizardActive) return

    // ── Bracketed paste: handle a paste block as one input event ─────
    // Pastes may span multiple data chunks, so we maintain pasteMode +
    // pasteBuffer across calls until the closing PASTE_END marker arrives.
    if (pasteMode) {
      const endIdx = data.indexOf(PASTE_END)
      if (endIdx === -1) {
        pasteBuffer += data
        return
      }
      pasteBuffer += data.slice(0, endIdx)
      commitPaste()
      // Continue processing whatever followed the paste end marker
      const rest = data.slice(endIdx + PASTE_END.length)
      if (rest.length === 0) return
      data = rest
    }
    const pasteStartIdx = data.indexOf(PASTE_START)
    if (pasteStartIdx !== -1) {
      // Anything before the paste start: process as normal keystrokes (rare
      // but possible). We don't currently chunk it — assume terminal sends
      // paste as a whole data event in most cases.
      pasteMode = true
      const afterStart = data.slice(pasteStartIdx + PASTE_START.length)
      const endIdx = afterStart.indexOf(PASTE_END)
      if (endIdx === -1) {
        pasteBuffer = afterStart
        return
      }
      pasteBuffer = afterStart.slice(0, endIdx)
      commitPaste()
      const rest = afterStart.slice(endIdx + PASTE_END.length)
      if (rest.length === 0) return
      data = rest
    }

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
  clearPromptBlock()
  if (text && submitHandler) {
    submitHandler(text)
  } else {
    drawPrompt()
  }
}

/**
 * Apply a completed bracketed-paste block. Newlines are normalized so
 * CRLF (Windows clipboards) and bare CR don't introduce blank lines or
 * lose breaks. The whole thing lands in inputBuffer as one event — no
 * per-keystroke processing, no submit debounce confusion.
 */
function commitPaste(): void {
  const text = pasteBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  pasteMode = false
  pasteBuffer = ''
  if (submitTimer) {
    clearTimeout(submitTimer)
    submitTimer = null
  }
  inputBuffer += text
  hintSelectedIndex = -1
  drawPrompt()
}

/**
 * Hand stdin over to a readline-based flow (e.g. config wizard). Disables
 * raw mode so readline can use line-mode input; sets the `wizardActive`
 * flag so our data handler ignores any events that still leak through.
 */
export function pauseInput(): void {
  wizardActive = true
  // Disable bracketed paste during readline flows — otherwise pasted text
  // arrives wrapped in \x1b[200~ ... \x1b[201~ markers that readline can't
  // interpret as line editing.
  process.stdout.write('\x1b[?2004l')
  process.stdin.setRawMode(false)
}

/**
 * Reclaim stdin after a readline-based flow finishes. Re-enables raw mode,
 * clears the mute flag, and redraws the prompt so the user sees a fresh
 * input line.
 */
export function resumeInput(): void {
  wizardActive = false
  process.stdin.setRawMode(true)
  process.stdin.resume()
  // Re-enable bracketed paste for the main raw-mode loop.
  process.stdout.write('\x1b[?2004h')
  idle = true
  drawPrompt()
}

export function stopInput(): void {
  // Disable bracketed paste so the terminal returns to normal paste behavior
  // after DuckCode exits. Without this, the user's next shell would see
  // raw \x1b[200~/\x1b[201~ markers around pasted text.
  process.stdout.write('\x1b[?2004l')
  process.stdin.setRawMode(false)
  process.stdin.pause()
}
