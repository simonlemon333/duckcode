/**
 * Hybrid Chat UI
 * 
 * - Assistant messages & tool calls: console.log + chalk (Claude Code style)
 * - User input: Ink TextInput at the bottom
 * 
 * Messages are NOT stored in state - directly output to stdout.
 */

import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import TextInput from 'ink-text-input'
import chalk from 'chalk'
import {
  outputUser,
  outputAssistantStart,
  streamText,
  streamFinish,
  outputToolCall,
  outputError,
  printWelcome,
} from './console.js'
import type { AppStatus } from '../types.js'

// ─── Permission prompt ─────────────────────────────────────────────────────────

export function PermissionPrompt({
  toolName,
  input,
  onDecide,
}: {
  toolName: string
  input: Record<string, unknown>
  onDecide: (granted: boolean) => void
}) {
  useInput((key) => {
    if (key === 'y' || key === 'Y') onDecide(true)
    if (key === 'n' || key === 'N' || key === '\x03') onDecide(false)
  })

  const preview = JSON.stringify(input, null, 2)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Box flexDirection="row">
        <Text bold color="yellow">⚠ Permission required</Text>
      </Box>
      <Text color="cyan" bold>
        {'  Tool: '}{toolName}
      </Text>
      <Box marginTop={1} marginLeft={2}>
        <Text dimColor>Parameters:</Text>
        <Text>{preview.split('\n').slice(0, 10).join('\n')}</Text>
        {preview.split('\n').length > 10 && (
          <Text dimColor> …</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text>
          Allow? <Text bold color="green">[y]</Text>
          <Text> / </Text>
          <Text bold color="red">[n]</Text>
        </Text>
      </Box>
    </Box>
  )
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function StatusBar({ status }: { status: AppStatus }) {
  const statusConfig: Record<AppStatus, { color: string; label: string }> = {
    idle: { color: 'gray', label: 'ready' },
    thinking: { color: 'yellow', label: 'thinking…' },
    tool_running: { color: 'cyan', label: 'running…' },
    awaiting_permission: { color: 'yellow', label: 'awaiting permission' },
    error: { color: 'red', label: 'error' },
  }

  const { color, label } = statusConfig[status]

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>─ </Text>
      <Text color={color}>{label}</Text>
      <Text dimColor> ─</Text>
    </Box>
  )
}

// ─── Main Chat UI ──────────────────────────────────────────────────────────────

export interface ChatUIProps {
  // Not used in hybrid mode - messages go directly to stdout
  messages: unknown[]
  status: AppStatus
  model: string
  cwd: string
  pendingPermission?: {
    id: string
    name: string
    input: Record<string, unknown>
  }
  onSubmit: (text: string) => void
  onPermissionDecide: (granted: boolean) => void
}

// Track if we've shown welcome
let welcomeShown = false

export function ChatUI({
  status,
  model,
  cwd,
  pendingPermission,
  onSubmit,
  onPermissionDecide,
}: ChatUIProps) {
  const [input, setInput] = useState('')
  const { exit } = useApp()
  const isIdle = status === 'idle'
  const assistantStarted = useRef(false)

  useInput((key) => {
    if (key === '\x03' || key === '\x04') exit()
  })

  // Show welcome once
  useEffect(() => {
    if (!welcomeShown) {
      printWelcome()
      welcomeShown = true
    }
  }, [])

  // Reset streaming state when status changes to thinking
  useEffect(() => {
    if (status === 'thinking' && !assistantStarted.current) {
      outputAssistantStart()
      assistantStarted.current = true
    }
  }, [status])

  // Reset assistant tracking when done (streamFinish is called by main.tsx)
  useEffect(() => {
    if (status === 'idle') {
      assistantStarted.current = false
    }
  }, [status])

  const shortCwd = cwd.replace(process.env.HOME ?? '', '~')

  return (
    <Box flexDirection="column">
      {/* Only render the bottom input area */}
      <Box flexDirection="column" paddingX={2}>
        {/* Permission prompt */}
        {pendingPermission ? (
          <PermissionPrompt
            toolName={pendingPermission.name}
            input={pendingPermission.input}
            onDecide={onPermissionDecide}
          />
        ) : (
          /* User input */
          <Box
            flexDirection="row"
            alignItems="center"
          >
            <Text bold color={isIdle ? 'cyan' : 'gray'}>
              {isIdle ? '❯' : '│'}
            </Text>
            {isIdle ? (
              <Box marginLeft={1} flexGrow={1}>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={(val) => {
                    if (val.trim()) {
                      outputUser(val.trim())
                      onSubmit(val.trim())
                      setInput('')
                    }
                  }}
                  placeholder={`Ask Duck… (${shortCwd})`}
                />
              </Box>
            ) : (
              <Box marginLeft={1}>
                <Text dimColor>waiting…</Text>
              </Box>
            )}
          </Box>
        )}

        <StatusBar status={status} />
      </Box>
    </Box>
  )
}

// ─── Exported helpers for main.tsx to call ─────────────────────────────────────

export { streamText, streamFinish, outputToolCall, outputError }
