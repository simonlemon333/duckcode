/**
 * agent tool — spawn a sub-agent to handle an independent task.
 *
 * The sub-agent runs its own LLM conversation with access to all tools
 * (same tool registry as the parent), but:
 * - Starts with fresh history (just the task prompt)
 * - Auto-approves all tool calls (parent already authorized the agent tool)
 * - Is depth-limited to prevent infinite recursion
 * - Returns only the final assistant text back to the parent
 *
 * The parent sees this as a single long-running tool call.
 */

import { QueryEngine, type PermissionCallback } from '../query/engine.js'
import type { GatewayConfig } from '../types.js'
import { registerTool, ok, err } from './registry.js'

const MAX_DEPTH = 3
let currentDepth = 0

let subagentConfig: GatewayConfig | null = null

export function initAgentTool(config: GatewayConfig): void {
  subagentConfig = config
}

/**
 * Run a single sub-agent task to completion. Used by both the `agent` tool
 * and the `parallel_agents` tool.
 *
 * Returns the final assistant text and the number of tool calls the
 * sub-agent made.
 */
async function runSubagent(task: string, cwd: string): Promise<{ text: string; toolCalls: number }> {
  if (!subagentConfig) throw new Error('Agent tool not initialized')

  const subEngine = new QueryEngine(subagentConfig, '')
  const autoApprove: PermissionCallback = async () => ({ granted: true })

  let text = ''
  let toolCalls = 0

  for await (const event of subEngine.run(task, cwd, autoApprove)) {
    if (event.type === 'text_delta') text += event.delta
    else if (event.type === 'tool_start') toolCalls++
    else if (event.type === 'error') throw new Error(event.message)
  }

  return { text: text.trim(), toolCalls }
}

registerTool({
  definition: {
    name: 'agent',
    description:
      'Spawn a sub-agent to handle an independent sub-task. ' +
      'The sub-agent runs its own LLM conversation with access to all tools ' +
      '(file_read, bash, glob, grep, etc.) and returns the final response text. ' +
      'Use for: isolated research tasks, parallel exploration, or when you want ' +
      'a fresh context window for a complex sub-problem. ' +
      'The sub-agent does NOT see the parent conversation — include all needed ' +
      'context in the task description.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The task for the sub-agent. Be specific and include all context ' +
            'the sub-agent needs (file paths, background, what to return).',
        },
      },
      required: ['task'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    if (!subagentConfig) return err('Agent tool not initialized. This should not happen.')

    if (currentDepth >= MAX_DEPTH) {
      return err(
        `Maximum sub-agent depth (${MAX_DEPTH}) reached. ` +
        `Sub-agents cannot recursively spawn more sub-agents beyond this limit.`,
      )
    }

    const task = input.task as string
    if (!task || task.trim().length === 0) {
      return err('Empty task — sub-agent needs a description of what to do.')
    }

    currentDepth++
    try {
      const result = await runSubagent(task, cwd)
      if (!result.text) {
        return ok(`(sub-agent completed ${result.toolCalls} tool call(s) but returned no text)`)
      }
      return ok(`[sub-agent summary · ${result.toolCalls} tool call(s)]\n\n${result.text}`)
    } catch (e: unknown) {
      return err(`Sub-agent failed: ${(e as Error).message}`)
    } finally {
      currentDepth--
    }
  },
})

// ─── parallel_agents: fan-out multiple sub-agents concurrently ─────────────

registerTool({
  definition: {
    name: 'parallel_agents',
    description:
      'Spawn multiple sub-agents concurrently, one per task. Returns an ordered array ' +
      'of results. Use when you have independent sub-problems that can run in parallel — ' +
      'e.g., research 3 different files at once, check 4 separate hypotheses, or fan out ' +
      'independent explorations. Each sub-agent has a fresh context and access to all tools. ' +
      'Uses Promise.allSettled so one failure does not kill the others.',
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of independent task descriptions. Each runs in its own sub-agent. ' +
            'Include all context in each task — sub-agents do not see the parent or each other.',
        },
      },
      required: ['tasks'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    if (!subagentConfig) return err('Agent tool not initialized. This should not happen.')

    if (currentDepth >= MAX_DEPTH) {
      return err(
        `Maximum sub-agent depth (${MAX_DEPTH}) reached. ` +
        `Parallel agents count as one depth level, but cannot exceed the limit.`,
      )
    }

    const tasks = input.tasks as string[] | undefined
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return err('Empty tasks array — parallel_agents needs at least one task.')
    }
    if (tasks.length > 8) {
      return err(`Too many parallel tasks (${tasks.length}). Max 8 at a time.`)
    }

    // All parallel agents count as ONE depth level — not N
    currentDepth++
    try {
      const results = await Promise.allSettled(
        tasks.map((task) => runSubagent(task, cwd)),
      )

      const lines: string[] = []
      lines.push(`[parallel_agents · ${tasks.length} tasks]`)
      lines.push('')

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        lines.push(`── Task ${i + 1} ──`)
        if (r.status === 'fulfilled') {
          const { text, toolCalls } = r.value
          lines.push(`[${toolCalls} tool call(s)]`)
          lines.push(text || '(empty result)')
        } else {
          lines.push(`[FAILED] ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
        lines.push('')
      }

      const successCount = results.filter((r) => r.status === 'fulfilled').length
      lines.push(`── Summary: ${successCount}/${tasks.length} tasks succeeded ──`)

      return ok(lines.join('\n'))
    } catch (e: unknown) {
      return err(`Parallel agents failed: ${(e as Error).message}`)
    } finally {
      currentDepth--
    }
  },
})
