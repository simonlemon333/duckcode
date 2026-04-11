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
    if (!subagentConfig) {
      return err('Agent tool not initialized. This should not happen.')
    }

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
      // Sub-agent has no project context — it's a focused, isolated worker.
      const subEngine = new QueryEngine(subagentConfig, '')

      // Auto-approve all tool calls within the sub-agent
      const autoApprove: PermissionCallback = async () => ({ granted: true })

      let finalText = ''
      let toolCallCount = 0

      for await (const event of subEngine.run(task, cwd, autoApprove)) {
        if (event.type === 'text_delta') {
          finalText += event.delta
        } else if (event.type === 'tool_start') {
          toolCallCount++
        } else if (event.type === 'error') {
          return err(`Sub-agent error: ${event.message}`)
        }
      }

      const trimmed = finalText.trim()
      if (!trimmed) {
        return ok(`(sub-agent completed ${toolCallCount} tool call(s) but returned no text)`)
      }

      return ok(
        `[sub-agent summary · ${toolCallCount} tool call(s)]\n\n${trimmed}`,
      )
    } catch (e: unknown) {
      return err(`Sub-agent failed: ${(e as Error).message}`)
    } finally {
      currentDepth--
    }
  },
})
