import type {
  Message,
  ContentBlock,
  ToolUseContent,
  GatewayConfig,
} from '../types.js'
import { getTool, getToolDefinitions } from '../tools/registry.js'
import { getStaticSystemPrompt, getDynamicContext } from '../config.js'
import { compressIfNeeded } from './compress.js'

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_done'; id: string; name: string; output: string; is_error: boolean }
  | { type: 'turn_done' }
  | { type: 'error'; message: string }
  | { type: 'permission_request'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'permission_granted'; id: string }
  | { type: 'choice_request'; title: string; options: Array<{ label: string; value: string; hint?: string }>; customInput: boolean }

export type PermissionResult = {
  granted: boolean
  trustAll?: boolean
  editedInput?: Record<string, unknown>
}

export type PermissionCallback = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => Promise<PermissionResult>

const MAX_TURNS = 30

export class QueryEngine {
  private history: Message[] = []
  private config: GatewayConfig
  private projectContext: string

  constructor(config: GatewayConfig, projectContext: string) {
    this.config = config
    this.projectContext = projectContext
  }

  /**
   * Main agentic loop.
   * Yields StreamEvents for the UI to render.
   * Handles tool-use automatically (with permission gating).
   */
  async *run(
    userMessage: string,
    cwd: string,
    onPermission: PermissionCallback,
  ): AsyncGenerator<StreamEvent> {
    this.history.push({ role: 'user', content: userMessage })

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // ── Compress history if too long ──────────────────────────────────────
      const compressResult = await compressIfNeeded(this.history, this.config)
      if (compressResult.compressed) {
        yield {
          type: 'text_delta',
          delta: `\n[Context compressed: ${compressResult.oldTokens} → ${compressResult.newTokens} tokens]\n`,
        }
      }

      // ── Call LLM ──────────────────────────────────────────────────────────
      let assistantText = ''
      const toolCalls: ToolUseContent[] = []

      try {
        for await (const event of this.callLLM()) {
          if (event.type === 'text_delta') {
            assistantText += event.delta
            yield event
          } else if (event.type === 'tool_start') {
            toolCalls.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            })
            yield event
          }
        }
      } catch (e: unknown) {
        yield { type: 'error', message: (e as Error).message }
        return
      }

      // ── Record assistant turn ─────────────────────────────────────────────
      const assistantContent: ContentBlock[] = []
      if (assistantText) {
        assistantContent.push({ type: 'text', text: assistantText })
      }
      assistantContent.push(...toolCalls)
      this.history.push({ role: 'assistant', content: assistantContent })

      // ── No tool calls → we're done ────────────────────────────────────────
      if (toolCalls.length === 0) {
        yield { type: 'turn_done' }
        return
      }

      // ── Execute tools ─────────────────────────────────────────────────────
      const toolResults: ContentBlock[] = []

      for (const tc of toolCalls) {
        const tool = getTool(tc.name)
        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Unknown tool: ${tc.name}`,
            is_error: true,
          })
          continue
        }

        // Permission gate
        let toolInput = tc.input
        if (tool.permission === 'confirm') {
          yield { type: 'permission_request', id: tc.id, name: tc.name, input: tc.input }
          const permResult = await onPermission(tc.id, tc.name, tc.input)

          if (!permResult.granted) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: 'User denied permission for this tool call.',
              is_error: true,
            })
            yield { type: 'tool_done', id: tc.id, name: tc.name, output: '(denied)', is_error: true }
            continue
          }
          yield { type: 'permission_granted', id: tc.id }

          // If input was edited, use the edited version
          if (permResult.editedInput) toolInput = permResult.editedInput
        }

        const result = await tool.execute(toolInput, cwd)
        yield {
          type: 'tool_done',
          id: tc.id,
          name: tc.name,
          output: result.output,
          is_error: result.is_error,
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: result.output,
          is_error: result.is_error,
        })
      }

      this.history.push({ role: 'user', content: toolResults })
      // Continue loop → next LLM call with tool results
    }

    yield { type: 'error', message: `Reached max turns (${MAX_TURNS}). Stopping.` }
  }

  /**
   * Single streaming LLM call.
   * Uses OpenAI-compatible chat completions (what vLLM / LiteLLM expose).
   */
  private async *callLLM(): AsyncGenerator<
    { type: 'text_delta'; delta: string } | Omit<StreamEvent & { type: 'tool_start' }, 'type'> & { type: 'tool_start' }
  > {
    const tools = getToolDefinitions().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

    // Convert history to OpenAI format
    // 拆分 system prompt：静态部分（可缓存）+ 动态部分
    const staticPrompt = getStaticSystemPrompt()
    const dynamicPrompt = getDynamicContext(this.projectContext)

    // Combine system prompt — cache_control only if provider supports it
    const fullSystemPrompt = dynamicPrompt
      ? `${staticPrompt}\n\n${dynamicPrompt}`
      : staticPrompt

    const systemMessages = [
      { role: 'system', content: fullSystemPrompt },
    ]

    const messages = [
      ...systemMessages,
      ...this.history.map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content }
        }

        // Handle content blocks → OpenAI format
        const blocks = m.content as ContentBlock[]

        if (m.role === 'user') {
          // Tool results
          const toolResults = blocks.filter(b => b.type === 'tool_result')
          if (toolResults.length > 0) {
            return toolResults.map(b => {
              if (b.type !== 'tool_result') return null
              return {
                role: 'tool',
                tool_call_id: b.tool_use_id,
                content: b.content,
              }
            }).filter(Boolean)
          }
          const text = blocks.find(b => b.type === 'text')
          return { role: 'user', content: (text as { text: string })?.text ?? '' }
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
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            }
          })

        return {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        }
      }).flat().filter(Boolean),
    ]

    const response = await fetch(
      `${this.config.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: this.config.maxTokens,
          stream: true,
        }),
      },
    )

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 500)}`)
    }

    // ── Parse SSE stream ───────────────────────────────────────────────────
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let inThink = false

    // Accumulate tool call arguments across chunks
    const pendingToolCalls: Record<
      number,
      { id: string; name: string; args: string }
    > = {}

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string | null
          }>
        }

        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue

        // Text delta — filter out <think>...</think> blocks (MiniMax reasoning)
        if (delta.content) {
          let content = delta.content

          if (inThink) {
            const endIdx = content.indexOf('</think>')
            if (endIdx !== -1) {
              inThink = false
              content = content.slice(endIdx + 8)
            } else {
              continue
            }
          }

          const startIdx = content.indexOf('<think>')
          if (startIdx !== -1) {
            const endIdx = content.indexOf('</think>', startIdx)
            if (endIdx !== -1) {
              content = content.slice(0, startIdx) + content.slice(endIdx + 8)
            } else {
              inThink = true
              content = content.slice(0, startIdx)
            }
          }

          if (content) {
            yield { type: 'text_delta', delta: content }
          }
        }

        // Tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!pendingToolCalls[tc.index]) {
              pendingToolCalls[tc.index] = {
                id: tc.id ?? `call_${tc.index}`,
                name: tc.function?.name ?? '',
                args: '',
              }
            }
            if (tc.function?.name) {
              pendingToolCalls[tc.index].name = tc.function.name
            }
            if (tc.id) {
              pendingToolCalls[tc.index].id = tc.id
            }
            pendingToolCalls[tc.index].args += tc.function?.arguments ?? ''
          }
        }

        // When finish_reason = tool_calls, emit all pending tool calls
        if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
          for (const [, pending] of Object.entries(pendingToolCalls)) {
            let parsedInput: Record<string, unknown> = {}
            try {
              parsedInput = JSON.parse(pending.args)
            } catch {
              parsedInput = { _raw: pending.args }
            }
            yield {
              type: 'tool_start',
              id: pending.id,
              name: pending.name,
              input: parsedInput,
            }
          }
        }
      }
    }
  }

  clearHistory(): void {
    this.history = []
  }

  getHistory(): Message[] {
    return [...this.history]
  }
}
