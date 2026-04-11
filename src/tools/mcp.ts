/**
 * MCP Client Tool
 * 
 * A generic MCP tool that can connect to any MCP server via stdio protocol.
 * Reads server configs from ~/.duck/config.json and dynamically registers tools.
 */

import { spawn } from 'child_process'
import { loadConfig } from '../config.js'
import { registerTool, ok, err } from './registry.js'
import type { McpServerConfig } from '../types.js'

// ─── MCP Client Session ─────────────────────────────────────────────────────

interface McpTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface McpClient {
  serverName: string
  process: ReturnType<typeof spawn>
  requestId: number
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  onError?: (msg: string) => void
}

/**
 * Send a JSON-RPC request to the MCP server and wait for response
 */
async function mcpRequest(client: McpClient, method: string, params?: unknown): Promise<unknown> {
  const id = ++client.requestId
  
  return new Promise((resolve, reject) => {
    client.pendingRequests.set(id, { resolve, reject })
    
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    if (!client.process.stdin) {
      client.pendingRequests.delete(id)
      reject(new Error('MCP process stdin not available'))
      return
    }
    client.process.stdin.write(message + '\n')
    
    // Timeout after 60 seconds
    setTimeout(() => {
      if (client.pendingRequests.has(id)) {
        client.pendingRequests.delete(id)
        reject(new Error(`MCP request ${method} timed out`))
      }
    }, 60_000)
  })
}

/**
 * Start an MCP server and initialize the session
 */
async function startMcpServer(serverConfig: McpServerConfig): Promise<{ client: McpClient; tools: McpTool[] }> {
  return new Promise((resolve, reject) => {
    const { name, command, args = [], env = {} } = serverConfig
    
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })

    const client: McpClient = {
      serverName: name,
      process: proc,
      requestId: 0,
      pendingRequests: new Map(),
    }

    let stdoutBuffer = ''
    let stderrBuffer = ''

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString()
      
      // Process complete JSON lines
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      
      for (const line of lines) {
        if (!line.trim()) continue
        
        try {
          const msg = JSON.parse(line)
          
          // Handle response to our requests
          if ('id' in msg && client.pendingRequests.has(msg.id)) {
            const pending = client.pendingRequests.get(msg.id)!
            client.pendingRequests.delete(msg.id)
            
            if (msg.error) {
              pending.reject(new Error(msg.error.message || 'MCP error'))
            } else {
              pending.resolve(msg.result)
            }
          }
          
          // Handle notifications (e.g., logs from server)
          if (!('id' in msg) && msg.method?.startsWith('notifications/')) {
            // Silently ignore notifications
          }
        } catch {
          // Ignore parse errors for now
        }
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderrBuffer += data.toString()
    })

    proc.on('error', (e) => {
      client.onError?.(`Failed to start MCP server "${name}": ${e.message}`)
      reject(e)
    })

    proc.on('exit', (code) => {
      client.pendingRequests.forEach(p => p.reject(new Error(`MCP server "${name}" exited`)))
      if (code !== 0) {
        reject(new Error(`MCP server "${name}" exited with code ${code}: ${stderrBuffer}`))
      }
    })

    // Initialize the MCP session
    ;(async () => {
      try {
        const result = await mcpRequest(client, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'duckcode', version: '0.1.0' },
        })
        
        // Send initialized notification
        if (client.process.stdin) {
          client.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
        }
        
        // List tools
        const toolsResult = await mcpRequest(client, 'tools/list') as { tools: McpTool[] }
        resolve({ client, tools: toolsResult.tools || [] })
      } catch (e) {
        reject(e)
      }
    })()
  })
}

// ─── Tool Registry ───────────────────────────────────────────────────────────

const mcpClients = new Map<string, McpClient>()
const mcpServerTools = new Map<string, string[]>()  // serverName → tool names

/**
 * Initialize MCP servers from config and register their tools
 */
export async function initializeMcpTools(): Promise<void> {
  const config = loadConfig()
  const servers = config.mcpServers || []
  
  if (servers.length === 0) return

  for (const serverConfig of servers) {
    try {
      const { client, tools } = await startMcpServer(serverConfig)
      mcpClients.set(serverConfig.name, client)
      mcpServerTools.set(serverConfig.name, tools.map((t) => t.name))

      for (const tool of tools) {
        const toolName = `${serverConfig.name}_${tool.name}`
        
        registerTool({
          definition: {
            name: toolName,
            description: tool.description || `MCP tool: ${tool.name} (from ${serverConfig.name})`,
            input_schema: {
              type: 'object',
              properties: tool.inputSchema.properties || {},
              required: tool.inputSchema.required || [],
            },
          },
          permission: 'confirm', // MCP tools need confirmation like bash

          async execute(input, cwd) {
            try {
              const result = await mcpRequest(client, 'tools/call', {
                name: tool.name,
                arguments: input,
              }) as { content?: Array<{ type: string; text?: string }> }
              
              const output = result.content?.map(c => c.text || '').join('\n') || '(no output)'
              return ok(output)
            } catch (e) {
              return err((e as Error).message)
            }
          },
        })
      }
      
      console.log(`[MCP] Loaded ${tools.length} tools from ${serverConfig.name}`)
    } catch (e) {
      console.error(`[MCP] Failed to load server ${serverConfig.name}: ${(e as Error).message}`)
    }
  }
}

/**
 * List all MCP servers and their tools for /mcp slash command.
 */
export function listMcpServers(): Array<{
  name: string
  connected: boolean
  tools: string[]
}> {
  const configured = loadConfig().mcpServers || []
  return configured.map((srv) => ({
    name: srv.name,
    connected: mcpClients.has(srv.name),
    tools: mcpServerTools.get(srv.name) ?? [],
  }))
}

/**
 * Cleanup all MCP server connections
 */
export function cleanupMcpConnections(): void {
  for (const [name, client] of mcpClients) {
    client.process.kill()
    console.log(`[MCP] Disconnected from ${name}`)
  }
  mcpClients.clear()
}

// Register a stub tool that explains MCP loading status
registerTool({
  definition: {
    name: 'mcp',
    description: 'MCP client tools - dynamically loaded from configured MCP servers',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Check MCP status (unused, kept for compatibility)',
        },
      },
    },
  },
  permission: 'auto',

  async execute(input) {
    const servers = loadConfig().mcpServers || []
    if (servers.length === 0) {
      return ok('No MCP servers configured. Add mcpServers to ~/.duck/config.json to enable MCP tools.')
    }
    return ok(`MCP: ${mcpClients.size}/${servers.length} servers connected. Tools available: ${Array.from(mcpClients.keys()).join(', ') || 'none'}`)
  },
})
