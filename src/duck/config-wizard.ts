/**
 * Interactive config wizard.
 *
 * Prompts for baseUrl / apiKey / model and writes them to ~/.duck/config.json
 * atomically (tmp + rename, never append — see 踩坑记录 坑 9 where appended
 * JSON corrupted the file).
 *
 * Used in two contexts:
 * - First run (no config yet): called from main.ts bootstrap, before raw-mode
 *   input is started.
 * - Mid-session via /config: caller must pauseInput() first and resumeInput()
 *   after; otherwise the raw-mode listener and readline will both read stdin.
 *
 * No key validation is performed — user wanted save-first, debug-later.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import chalk from 'chalk'
import type { GatewayConfig } from '../types.js'

const CONFIG_PATH = join(homedir(), '.duck', 'config.json')

function readExisting(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function hintCurrent(value: unknown, mask: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  // baseUrl/model show full value — they aren't secrets and seeing them
  // truncated as "https://…  .com" was confusing. Only apiKey gets the
  // first-N / last-N reveal so the rest doesn't leak into scrollback.
  if (!mask || value.length <= 12) return chalk.dim(` (current: ${value})`)
  return chalk.dim(` (current: ${value.slice(0, 6)}…${value.slice(-4)})`)
}

async function askLine(
  rl: ReturnType<typeof createInterface>,
  label: string,
  current: string | undefined,
  opts: { mask?: boolean } = {},
): Promise<string> {
  const answer = (await rl.question(`  ${chalk.cyan(label)}${hintCurrent(current, opts.mask ?? false)}: `)).trim()
  return answer || current || ''
}

function atomicWrite(payload: Record<string, unknown>): void {
  const dir = dirname(CONFIG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  renameSync(tmp, CONFIG_PATH)
}

export interface WizardResult {
  saved: boolean
  baseUrl?: string
  apiKey?: string
  model?: string
}

export async function runConfigWizard(opts?: { firstRun?: boolean }): Promise<WizardResult> {
  const existing = readExisting()

  console.log()
  if (opts?.firstRun) {
    console.log(chalk.cyan.bold('  🦆 Welcome to DuckCode'))
    console.log(chalk.dim('  Configure an OpenAI-compatible API endpoint.'))
    console.log(chalk.dim('  Works with MiniMax, vLLM, LiteLLM, Ollama, DeepSeek, etc.'))
  } else {
    console.log(chalk.cyan.bold('  ⚙  Update config'))
    console.log(chalk.dim('  Press Enter to keep the current value.'))
  }
  console.log(chalk.dim('  Ctrl+C to cancel without saving.'))
  console.log()

  const rl = createInterface({ input: stdin, output: stdout, terminal: true })

  // Convert SIGINT (Ctrl+C) into a clean rl.close() so the pending question
  // rejects with a closed-stream error we can catch below — instead of the
  // default behavior of killing the whole process and losing session state.
  let canceled = false
  rl.on('SIGINT', () => {
    canceled = true
    rl.close()
  })

  try {
    const baseUrl = await askLine(rl, 'baseUrl', existing.baseUrl as string | undefined)
    const apiKey = await askLine(rl, 'apiKey', existing.apiKey as string | undefined, { mask: true })
    const model = await askLine(
      rl,
      'model',
      (existing.model as string | undefined) ?? 'MiniMax-M2.7',
    )

    if (!baseUrl || !apiKey || !model) {
      console.log()
      console.log(chalk.red('  ✗ baseUrl / apiKey / model are all required. Nothing saved.'))
      console.log()
      return { saved: false }
    }

    const merged = { ...existing, baseUrl, apiKey, model }
    atomicWrite(merged)

    console.log()
    console.log(chalk.green(`  ✓ Saved to ${CONFIG_PATH}`))
    console.log()
    return { saved: true, baseUrl, apiKey, model }
  } catch (err) {
    // rl.close() during a pending question() rejects with ERR_USE_AFTER_CLOSE
    // (or AbortError). If we set `canceled` via SIGINT, treat as graceful
    // cancel; otherwise re-throw so unexpected failures still surface.
    if (canceled) {
      console.log()
      console.log(chalk.dim('  Canceled — config unchanged.'))
      console.log()
      return { saved: false }
    }
    throw err
  } finally {
    rl.close()
  }
}

/**
 * Apply newly-saved config values to the live GatewayConfig object.
 * QueryEngine stores a reference, so mutating in place is enough for the next
 * LLM call to use the new credentials — no engine rebuild needed.
 */
export function applyConfigUpdate(target: GatewayConfig, update: WizardResult): void {
  if (!update.saved) return
  if (update.baseUrl) target.baseUrl = update.baseUrl
  if (update.apiKey) target.apiKey = update.apiKey
  if (update.model) target.model = update.model
}
