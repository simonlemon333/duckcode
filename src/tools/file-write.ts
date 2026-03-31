import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { registerTool, ok, err } from './registry.js'

// ─── file_write ───────────────────────────────────────────────────────────────

registerTool({
  definition: {
    name: 'file_write',
    description:
      'Write content to a file, creating it (and parent dirs) if needed. ' +
      'WARNING: overwrites existing content. Prefer file_edit for partial changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  permission: 'confirm',

  async execute(input, cwd) {
    const filePath = resolve(cwd, input.path as string)
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, input.content as string, 'utf-8')
      const lines = (input.content as string).split('\n').length
      return ok(`Written ${lines} lines to ${filePath}`)
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  },
})

// ─── file_edit ────────────────────────────────────────────────────────────────
// Exact string-replace approach — same as Claude Code's str_replace

registerTool({
  definition: {
    name: 'file_edit',
    description:
      'Replace an exact string in a file with new content. ' +
      'old_str must match EXACTLY (including whitespace) and appear exactly once. ' +
      'Use file_read first to get the precise text to replace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_str: {
          type: 'string',
          description: 'The exact string to find and replace',
        },
        new_str: {
          type: 'string',
          description: 'The replacement string (can be empty to delete)',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  permission: 'confirm',

  async execute(input, cwd) {
    const filePath = resolve(cwd, input.path as string)
    const oldStr = input.old_str as string
    const newStr = input.new_str as string

    if (!existsSync(filePath)) {
      return err(`File not found: ${filePath}`)
    }

    try {
      const content = readFileSync(filePath, 'utf-8')
      const count = content.split(oldStr).length - 1

      if (count === 0) {
        return err(
          `old_str not found in file. Use file_read to get the exact current content.`,
        )
      }
      if (count > 1) {
        return err(
          `old_str appears ${count} times — must be unique. Add more context to make it unambiguous.`,
        )
      }

      const updated = content.replace(oldStr, newStr)
      writeFileSync(filePath, updated, 'utf-8')

      const diffLines =
        newStr.split('\n').length - oldStr.split('\n').length
      const sign = diffLines >= 0 ? '+' : ''
      return ok(
        `Edited ${filePath} (${sign}${diffLines} lines)`,
      )
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  },
})
