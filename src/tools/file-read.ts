import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { registerTool, ok, err } from './registry.js'

const MAX_BYTES = 200_000

// ─── File content cache ─────────────────────────────────────────────────────
// Tracks file hash + mtime. If the file hasn't changed since last read,
// returns a short "unchanged" message instead of the full content.
// This saves significant tokens in long conversations where the LLM
// re-reads the same file multiple times.

interface FileCache {
  hash: string
  mtimeMs: number
  lineCount: number
}

const cache = new Map<string, FileCache>()

export function clearFileCache(): void {
  cache.clear()
}

function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

registerTool({
  definition: {
    name: 'file_read',
    description:
      'Read the contents of a file. Returns file content with line numbers. ' +
      'Use start_line / end_line to read a slice of a large file. ' +
      'If the file has not changed since last read, returns a short notice instead of full content.',
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
        force: {
          type: 'boolean',
          description: 'Force re-read even if file unchanged (default: false)',
        },
      },
      required: ['path'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    const filePath = resolve(cwd, input.path as string)
    const force = (input.force as boolean | undefined) ?? false
    const wantSlice = input.start_line !== undefined || input.end_line !== undefined

    try {
      const stat = statSync(filePath)
      if (stat.size > MAX_BYTES) {
        return err(
          `File too large (${stat.size} bytes). Use start_line/end_line to read sections.`,
        )
      }

      const raw = readFileSync(filePath, 'utf-8')
      const hash = hashContent(raw)
      const lines = raw.split('\n')

      // Check cache — only for full-file reads (not slices)
      if (!force && !wantSlice) {
        const cached = cache.get(filePath)
        if (cached && cached.hash === hash && cached.mtimeMs === stat.mtimeMs) {
          return ok(
            `File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.`,
          )
        }
      }

      // Update cache
      cache.set(filePath, { hash, mtimeMs: stat.mtimeMs, lineCount: lines.length })

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
