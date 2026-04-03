// ─── Message types ────────────────────────────────────────────────────────────

export type Role = 'user' | 'assistant' | 'tool'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

export interface Message {
  role: Role
  content: string | ContentBlock[]
}

// ─── Tool types ───────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResult {
  output: string
  is_error: boolean
}

export interface Tool {
  definition: ToolDefinition
  /** Permission level: auto | confirm | deny */
  permission: 'auto' | 'confirm'
  execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult>
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  agentName?: string
  mcpServers?: McpServerConfig[]
  models?: Record<string, ModelConfig>
}

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

// ─── UI State ─────────────────────────────────────────────────────────────────

export type AppStatus =
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'awaiting_permission'
  | 'error'

export interface ToolCallDisplay {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_result'
  text: string
  toolCalls?: ToolCallDisplay[]
  isStreaming?: boolean
}
