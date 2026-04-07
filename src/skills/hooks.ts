/**
 * Hook system — run scripts before/after tool execution.
 *
 * Hooks are defined in .duck/hooks/ (project) or ~/.duck/hooks/ (global).
 * Each hook is a shell script named by pattern:
 *
 *   pre-<toolname>.sh  — runs before the tool, can block execution
 *   post-<toolname>.sh — runs after the tool, receives output
 *
 * Special hooks:
 *   pre-all.sh  — runs before ANY tool
 *   post-all.sh — runs after ANY tool
 *
 * Environment variables passed to hooks:
 *   DUCK_TOOL_NAME  — tool name (e.g., "bash", "file_write")
 *   DUCK_TOOL_INPUT — JSON string of tool input
 *   DUCK_TOOL_OUTPUT — (post only) tool output text
 *   DUCK_TOOL_ERROR  — (post only) "true" if tool errored
 *   DUCK_CWD         — working directory
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const execFileAsync = promisify(execFile)

const HOOK_TIMEOUT = 10_000

export interface HookResult {
  blocked: boolean
  message?: string
}

interface HookFile {
  path: string
  source: 'project' | 'global'
}

let hookDir: { project: string; global: string } = {
  project: '',
  global: join(homedir(), '.duck', 'hooks'),
}

export function initHooks(cwd: string): void {
  hookDir.project = join(cwd, '.duck', 'hooks')
}

function findHook(name: string): HookFile | undefined {
  // Project hooks override global
  const projectPath = join(hookDir.project, name)
  if (existsSync(projectPath)) return { path: projectPath, source: 'project' }

  const globalPath = join(hookDir.global, name)
  if (existsSync(globalPath)) return { path: globalPath, source: 'global' }

  return undefined
}

/**
 * Run pre-tool hooks. Returns { blocked: true } if a hook exits non-zero.
 */
export async function runPreHooks(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookResult> {
  const hooks = [
    findHook('pre-all.sh'),
    findHook(`pre-${toolName}.sh`),
  ].filter(Boolean) as HookFile[]

  for (const hook of hooks) {
    try {
      await execFileAsync('bash', [hook.path], {
        cwd,
        timeout: HOOK_TIMEOUT,
        env: {
          ...process.env,
          DUCK_TOOL_NAME: toolName,
          DUCK_TOOL_INPUT: JSON.stringify(input),
          DUCK_CWD: cwd,
        },
      })
    } catch (e: unknown) {
      const error = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      const msg = error.stderr?.trim() || error.stdout?.trim() || `Hook blocked: ${hook.path}`
      return { blocked: true, message: msg }
    }
  }

  return { blocked: false }
}

/**
 * Run post-tool hooks (fire-and-forget, never blocks).
 */
export async function runPostHooks(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  cwd: string,
): Promise<void> {
  const hooks = [
    findHook('post-all.sh'),
    findHook(`post-${toolName}.sh`),
  ].filter(Boolean) as HookFile[]

  for (const hook of hooks) {
    try {
      await execFileAsync('bash', [hook.path], {
        cwd,
        timeout: HOOK_TIMEOUT,
        env: {
          ...process.env,
          DUCK_TOOL_NAME: toolName,
          DUCK_TOOL_INPUT: JSON.stringify(input),
          DUCK_TOOL_OUTPUT: output.slice(0, 10_000), // cap output size for env var
          DUCK_TOOL_ERROR: isError ? 'true' : 'false',
          DUCK_CWD: cwd,
        },
      })
    } catch {
      // Post hooks never block — silently ignore errors
    }
  }
}

/**
 * List all discovered hooks.
 */
export function listHooks(): Array<{ name: string; source: string }> {
  const hooks: Array<{ name: string; source: string }> = []

  for (const [source, dir] of [['project', hookDir.project], ['global', hookDir.global]] as const) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.sh'))
      for (const f of files) {
        hooks.push({ name: f, source })
      }
    } catch {
      // ignore
    }
  }

  return hooks
}
