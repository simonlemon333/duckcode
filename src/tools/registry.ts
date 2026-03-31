import type { Tool, ToolDefinition, ToolResult } from '../types.js'

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  registry.set(tool.definition.name, tool)
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

export function getAllTools(): Tool[] {
  return Array.from(registry.values())
}

export function getToolDefinitions(): ToolDefinition[] {
  return getAllTools().map(t => t.definition)
}

// ─── Helper to build a tool result ───────────────────────────────────────────

export function ok(output: string): ToolResult {
  return { output, is_error: false }
}

export function err(output: string): ToolResult {
  return { output, is_error: true }
}
