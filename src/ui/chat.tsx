/**
 * Hybrid Chat UI
 *
 * - Assistant output: console.log + chalk (pushed above Ink's managed area)
 * - User input: custom useInput handler with paste detection
 * - Ink only manages the bottom prompt + status bar
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
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
  useInput((_ch, key) => {
    if (key.return) return
    if (_ch === 'y' || _ch === 'Y') onDecide(true)
    if (_ch === 'n' || _ch === 'N' || _ch === '\x03') onDecide(false)
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

// ─── Main Chat UI ──────────────────────────────────────────────────────────────

export interface ChatUIProps {
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

let welcomeShown = false

export function ChatUI({
  status,
  model,
  cwd,
  pendingPermission,
  onSubmit,
  onPermissionDecide,
}: ChatUIProps) {
  const [displayText, setDisplayText] = useState('')
  const { exit } = useApp()
  const isIdle = status === 'idle'
  const assistantStarted = useRef(false)

  // ── Input handling ────────────────────────────────────────────────────────
  // Buffer in ref to avoid Ink re-renders on every keystroke.
  // Only update displayText after input settles (debounced).
  const inputRef = useRef('')
  const submitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateDisplay = useCallback(() => {
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    displayTimerRef.current = setTimeout(() => {
      setDisplayText(inputRef.current)
      displayTimerRef.current = null
    }, 30)
  }, [])

  const doSubmit = useCallback(() => {
    const text = inputRef.current.trim()
    inputRef.current = ''
    setDisplayText('')
    if (submitTimerRef.current) clearTimeout(submitTimerRef.current)
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    submitTimerRef.current = null
    displayTimerRef.current = null
    if (text) {
      outputUser(text)
      // Small delay so Ink processes the console.log before re-rendering
      setTimeout(() => onSubmit(text), 16)
    }
  }, [onSubmit])

  const scheduleSubmit = useCallback(() => {
    if (submitTimerRef.current) clearTimeout(submitTimerRef.current)
    submitTimerRef.current = setTimeout(doSubmit, 100)
  }, [doSubmit])

  useInput((ch, key) => {
    if (key.ctrl && (ch === 'c' || ch === 'd')) {
      exit()
      return
    }

    if (!isIdle || pendingPermission) return

    if (key.return) {
      if (inputRef.current.length > 0) {
        inputRef.current += '\n'
        scheduleSubmit()
      }
      return
    }

    // More input arriving — cancel any pending submit (paste in progress)
    if (submitTimerRef.current) {
      clearTimeout(submitTimerRef.current)
      submitTimerRef.current = null
    }

    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1)
      updateDisplay()
      return
    }

    if (key.escape || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      return
    }

    if (ch) {
      inputRef.current += ch
      updateDisplay()
    }
  })

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!welcomeShown) {
      printWelcome()
      welcomeShown = true
    }
  }, [])

  useEffect(() => {
    if (status === 'thinking' && !assistantStarted.current) {
      outputAssistantStart()
      assistantStarted.current = true
    }
  }, [status])

  useEffect(() => {
    if (status === 'idle') {
      assistantStarted.current = false
    }
  }, [status])

  // ── Render ────────────────────────────────────────────────────────────────

  const shortCwd = cwd.replace(process.env.HOME ?? '', '~')

  const statusLabel: Record<AppStatus, { color: string; text: string }> = {
    idle: { color: 'gray', text: 'ready' },
    thinking: { color: 'yellow', text: 'thinking…' },
    tool_running: { color: 'cyan', text: 'running…' },
    awaiting_permission: { color: 'yellow', text: 'awaiting permission' },
    error: { color: 'red', text: 'error' },
  }

  const { color: statusColor, text: statusText } = statusLabel[status]
  // For display, show only the current line being typed
  const currentLine = displayText.split('\n').pop() ?? ''

  return (
    <Box flexDirection="column" paddingX={1}>
      {pendingPermission ? (
        <PermissionPrompt
          toolName={pendingPermission.name}
          input={pendingPermission.input}
          onDecide={onPermissionDecide}
        />
      ) : (
        <>
          <Text dimColor>{'─'.repeat(60)}</Text>
          <Box flexDirection="row">
            <Text bold color={isIdle ? 'cyan' : 'gray'}>
              {isIdle ? ' ❯ ' : ' │ '}
            </Text>
            {isIdle ? (
              <Text>{currentLine || <Text dimColor>Ask Duck… ({shortCwd})</Text>}</Text>
            ) : (
              <Text dimColor>waiting…</Text>
            )}
          </Box>
          <Box flexDirection="row">
            <Text dimColor>{'─ '}</Text>
            <Text color={statusColor}>{statusText}</Text>
            <Text dimColor>{' ─'}</Text>
          </Box>
        </>
      )}
    </Box>
  )
}

// ─── Exported helpers for main.tsx to call ─────────────────────────────────────

export { streamText, streamFinish, outputToolCall, outputError }
