/**
 * OpenAI-compatible message-format helpers.
 *
 * Engine and compression must produce byte-identical request shapes so the
 * provider's prefix cache (server-side, e.g. MiniMax/DeepSeek/vLLM) can hit
 * on shared prefixes. Both call sites go through these helpers.
 */

import type { ContentBlock, GatewayConfig, Message, ToolUseContent } from '../types.js'
import { getStaticSystemPrompt, getDynamicContext } from '../config.js'

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | unknown[] | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export function buildSystemMessage(
  config: GatewayConfig,
  projectContext: string,
): OpenAIMessage {
  const staticPrompt = getStaticSystemPrompt(config)
  const dynamicPrompt = getDynamicContext(projectContext)
  const content = dynamicPrompt ? `${staticPrompt}\n\n${dynamicPrompt}` : staticPrompt
  return { role: 'system', content }
}

/**
 * Convert internal Anthropic-shaped history to OpenAI chat-completions messages.
 *
 * Notable shape rules:
 * - Tool results (user role with tool_result blocks) flatten to N `role: 'tool'` messages.
 * - Assistant turns may carry both `content` text AND `tool_calls`.
 * - Multimodal user turns become `content: [{type:'text'}, {type:'image_url'}]`.
 */
export function historyToOpenAI(history: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  for (const m of history) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role as OpenAIMessage['role'], content: m.content })
      continue
    }

    const blocks = m.content as ContentBlock[]

    if (m.role === 'user') {
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      if (toolResults.length > 0) {
        for (const b of toolResults) {
          if (b.type !== 'tool_result') continue
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
        }
        continue
      }

      // Multimodal: text + image_url blocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imageBlocks = (blocks as any[]).filter(b => b.type === 'image_url')
      const textBlock = blocks.find(b => b.type === 'text')
      if (imageBlocks.length > 0) {
        const parts: unknown[] = []
        if (textBlock && (textBlock as { text: string }).text) {
          parts.push({ type: 'text', text: (textBlock as { text: string }).text })
        }
        for (const img of imageBlocks) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parts.push({ type: 'image_url', image_url: (img as any).image_url })
        }
        out.push({ role: 'user', content: parts })
        continue
      }

      out.push({ role: 'user', content: (textBlock as { text: string })?.text ?? '' })
      continue
    }

    // Assistant: mix of text + tool_use
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')

    const toolCalls = blocks
      .filter(b => b.type === 'tool_use')
      .map(b => {
        const tc = b as ToolUseContent
        return {
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }
      })

    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
  }

  return out
}
