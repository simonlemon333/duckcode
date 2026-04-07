import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { GatewayConfig } from './types.js'

const CONFIG_PATH = join(homedir(), '.duck', 'config.json')

export function hasConfig(): boolean {
  if (existsSync(CONFIG_PATH)) return true
  if (process.env.DUCK_GATEWAY_URL || process.env.DUCK_API_KEY) return true
  return false
}

function loadFileConfig(): Partial<GatewayConfig> {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function loadConfig(modelName?: string): GatewayConfig {
  const file = loadFileConfig()
  let config: GatewayConfig = {
    // 优先级：ENV > config.json > defaults
    baseUrl:
      process.env.DUCK_GATEWAY_URL ??
      file.baseUrl ??
      'http://localhost:8080',
    apiKey:
      process.env.DUCK_API_KEY ??
      file.apiKey ??
      'dummy-key',
    model:
      process.env.DUCK_MODEL ??
      file.model ??
      'gpt-4o',
    maxTokens:
      Number(process.env.DUCK_MAX_TOKENS ?? file.maxTokens ?? 8192),
    agentName: file.agentName,
    mcpServers: file.mcpServers,
  }

  // 如果传入 modelName，从 models 字典中覆盖配置
  if (modelName && file.models && file.models[modelName]) {
    const modelConfig = file.models[modelName]
    config = {
      ...config,
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
    }
  }

  return config
}

// 静态部分：角色定义、tool_usage、communication 规则（固定不变）
export function getAgentName(config?: GatewayConfig): string {
  return config?.agentName ?? 'Duck'
}

export function getStaticSystemPrompt(config?: GatewayConfig): string {
  const name = getAgentName(config)
  return `You are ${name}, an expert AI coding assistant.
You help developers write, read, edit, and debug code through a set of tools.

<environment>
- You are operating in a terminal on the developer's machine
- Working directory is provided with each session
- All file paths are relative to the working directory unless absolute
</environment>

<tool_usage>
- Always prefer reading files before editing them
- Use bash for running tests, builds, and short scripts
- Use glob/grep to explore unfamiliar codebases before making changes
- Confirm intent before destructive operations
- When editing files, make minimal, precise changes
- NEVER run duck, npx duck, tsx src/main.tsx, or any command that invokes Duck itself — this will crash the session
- After reading a file, NEVER repeat its contents back to the user — they already see the tool output. Just summarize key findings or answer their question directly.
</tool_usage>

<communication>
- Be concise. Developers are busy.
- Show your work: briefly explain what you're doing and why
- If a task is ambiguous, ask one clarifying question before proceeding
- Respond in the same language the user writes in (Chinese or English)
</communication>`.trim()
}

// 动态部分：project_context（每次可能变化）
export function getDynamicContext(projectContext: string): string | null {
  if (!projectContext) return null
  return `<project_context>
${projectContext}
</project_context>`
}

// 兼容旧接口：将静态和动态部分拼接
export function getSystemPrompt(projectContext: string): string {
  const staticPart = getStaticSystemPrompt()
  const dynamicPart = getDynamicContext(projectContext)
  return dynamicPart ? `${staticPart}\n\n${dynamicPart}`.trim() : staticPart
}
