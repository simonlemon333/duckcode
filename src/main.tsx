import React, { useState, useCallback, useRef, useEffect } from 'react'
import { render } from 'ink'
import { program } from 'commander'
import { cwd as processCwd } from 'process'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

import { loadConfig, getSystemPrompt } from './config.js'
import { QueryEngine } from './query/engine.js'
import { loadProjectContext } from './memory/context.js'
import { ChatUI, streamText, streamFinish, outputToolCall, outputError } from './ui/chat.js'
import type { AppStatus } from './types.js'

// ── Register all tools (side-effect imports) ──────────────────────────────────
import './tools/bash.js'
import './tools/file-read.js'
import './tools/file-write.js'
import './tools/glob-grep.js'
import './tools/web-fetch.js'
import { initializeMcpTools } from './tools/mcp.js'

// ─────────────────────────────────────────────────────────────────────────────

function App({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<AppStatus>('idle')
  const [pendingPermission, setPendingPermission] = useState<
    { id: string; name: string; input: Record<string, unknown> } | undefined
  >(undefined)

  const config = loadConfig()
  const projectContext = loadProjectContext(cwd)
  const systemPrompt = getSystemPrompt(projectContext)
  const engineRef = useRef(new QueryEngine(config, systemPrompt))
  const permissionResolverRef = useRef<((granted: boolean) => void) | null>(null)
  
  // Track current assistant for tool calls
  const currentAssistantRef = useRef<{ id: string; toolCalls: Map<string, { name: string; input: Record<string, unknown> }> } | null>(null)

  // ── Initialize MCP servers ─────────────────────────────────────────────────
  useEffect(() => {
    initializeMcpTools()
      .catch(console.error)
    
    return () => {
      import('./tools/mcp.js').then(m => m.cleanupMcpConnections())
    }
  }, [])

  // ── Permission gate ───────────────────────────────────────────────────────

  const handlePermission = useCallback(
    (id: string, name: string, input: Record<string, unknown>): Promise<boolean> => {
      return new Promise(resolve => {
        setPendingPermission({ id, name, input })
        permissionResolverRef.current = (granted: boolean) => {
          setPendingPermission(undefined)
          permissionResolverRef.current = null
          resolve(granted)
        }
      })
    },
    [],
  )

  const handlePermissionDecide = useCallback((granted: boolean) => {
    permissionResolverRef.current?.(granted)
  }, [])

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (text: string) => {
      // Handle /clear command
      if (text.trim().toLowerCase() === '/clear') {
        engineRef.current.clearHistory()
        console.log('\n✓ Conversation cleared. Ready for a fresh start!\n')
        return
      }

      // Initialize current assistant tracker
      currentAssistantRef.current = {
        id: randomUUID(),
        toolCalls: new Map(),
      }

      setStatus('thinking')

      const engine = engineRef.current
      for await (const event of engine.run(text, cwd, handlePermission)) {
        switch (event.type) {
          case 'text_delta':
            setStatus('thinking')
            streamText(event.delta)
            break

          case 'tool_start': {
            setStatus('tool_running')
            // Track tool call
            currentAssistantRef.current?.toolCalls.set(event.id, {
              name: event.name,
              input: event.input,
            })
            break
          }

          case 'tool_done': {
            // Output tool call result
            const tc = currentAssistantRef.current?.toolCalls.get(event.id)
            if (tc) {
              outputToolCall({
                id: event.id,
                name: tc.name,
                input: tc.input,
                status: event.is_error ? 'error' : 'done',
                output: event.output,
              })
              currentAssistantRef.current?.toolCalls.delete(event.id)
            }
            break
          }

          case 'permission_request':
            setStatus('awaiting_permission')
            break

          case 'permission_granted':
            setStatus('tool_running')
            break

          case 'turn_done':
            streamFinish()
            setStatus('idle')
            currentAssistantRef.current = null
            console.log()
            break

          case 'error':
            streamFinish()
            outputError(event.message)
            setStatus('error')
            currentAssistantRef.current = null
            // Reset to idle after a moment
            setTimeout(() => setStatus('idle'), 2000)
            break
        }
      }
    },
    [handlePermission, cwd],
  )

  return (
    <ChatUI
      messages={[]}  // Not used in hybrid mode
      status={status}
      model={config.model}
      cwd={cwd}
      pendingPermission={pendingPermission}
      onSubmit={handleSubmit}
      onPermissionDecide={handlePermissionDecide}
    />
  )
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

program
  .name('duck')
  .description('Duck — AI coding assistant')
  .version('0.1.0')
  .option('-d, --dir <path>', 'Working directory', '.')
  .parse()

const opts = program.opts()
const workDir = resolve(processCwd(), opts.dir as string)

render(<App cwd={workDir} />)
