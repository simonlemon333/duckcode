import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { registerTool, ok, err } from './registry.js'

const MAX_BYTES = 200_000

registerTool({
  definition: {
    name: 'file_read',
    description:
      'Read the contents of a file. Returns file content with line numbers. ' +
      'Use start_line / end_line to read a slice of a large file.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to file (absolute or relative to cwd)',
        },
        start_line: {
          type: 'number',
          description: '1-indexed first line to read (optional)',
        },
        end_line: {
          type: 'number',
          description: '1-indexed last line to read (optional)',
        },
      },
      required: ['path'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    const filePath = resolve(cwd, input.path as string)

    try {
      const stat = statSync(filePath)
      if (stat.size > MAX_BYTES) {
        return err(
          `File too large (${stat.size} bytes). Use start_line/end_line to read sections.`,
        )
      }

      const raw = readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n')

      const start = Math.max(1, (input.start_line as number | undefined) ?? 1)
      const end = Math.min(
        lines.length,
        (input.end_line as number | undefined) ?? lines.length,
      )

      const slice = lines.slice(start - 1, end)
      const numbered = slice
        .map((l, i) => `${String(start + i).padStart(5)}\t${l}`)
        .join('\n')

      return ok(
        `File: ${filePath}\nLines: ${start}–${end} of ${lines.length}\n\n${numbered}`,
      )
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  },
})
