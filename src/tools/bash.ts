import { execFile } from 'child_process'
import { promisify } from 'util'
import { registerTool, ok, err } from './registry.js'

const execFileAsync = promisify(execFile)

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 50_000

registerTool({
  definition: {
    name: 'bash',
    description:
      'Execute a shell command in the current working directory. ' +
      'Returns stdout + stderr. Timeout: 30s. ' +
      'Do NOT use for long-running background processes.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run',
        },
        timeout_ms: {
          type: 'number',
          description: 'Override timeout in ms (max 120000)',
        },
      },
      required: ['command'],
    },
  },
  permission: 'confirm',

  async execute(input, cwd) {
    const command = input.command as string
    const timeout = Math.min(
      (input.timeout_ms as number | undefined) ?? TIMEOUT_MS,
      120_000,
    )

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
        cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env },
      })

      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      return ok(output || '(no output)')
    } catch (e: unknown) {
      const error = e as NodeJS.ErrnoException & {
        stdout?: string
        stderr?: string
        killed?: boolean
      }
      if (error.killed) {
        return err(`Command timed out after ${timeout}ms`)
      }
      const out = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
      return err(out || error.message)
    }
  },
})
