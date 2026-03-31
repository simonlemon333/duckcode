import { glob } from 'glob'
import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { registerTool, ok, err } from './registry.js'

// ─── glob ─────────────────────────────────────────────────────────────────────

registerTool({
  definition: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Returns a sorted list of matching paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.{js,ts}"',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patterns to ignore (default: node_modules, .git, dist)',
        },
      },
      required: ['pattern'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    const pattern = input.pattern as string
    const ignore = (input.ignore as string[] | undefined) ?? [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/.next/**',
    ]

    try {
      const matches = await glob(pattern, { cwd, ignore, absolute: false })
      matches.sort()

      if (matches.length === 0) {
        return ok(`No files matched pattern: ${pattern}`)
      }

      return ok(matches.join('\n'))
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  },
})

// ─── grep ─────────────────────────────────────────────────────────────────────

const MAX_RESULTS = 200

registerTool({
  definition: {
    name: 'grep',
    description:
      'Search for a regex pattern in files. Returns matching lines with file:line context.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description:
            'File or directory to search in (default: cwd). ' +
            'Can be a glob pattern like "src/**/*.ts".',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive match (default: false)',
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context around each match (default: 0)',
        },
      },
      required: ['pattern'],
    },
  },
  permission: 'auto',

  async execute(input, cwd) {
    const pattern = input.pattern as string
    const searchPath = (input.path as string | undefined) ?? '.'
    const caseInsensitive = (input.case_insensitive as boolean | undefined) ?? false
    const contextLines = (input.context_lines as number | undefined) ?? 0

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : undefined)
    } catch {
      return err(`Invalid regex: ${pattern}`)
    }

    // Resolve to files list
    let files: string[]
    try {
      const absPath = resolve(cwd, searchPath)
      const stat = statSync(absPath)
      if (stat.isFile()) {
        files = [absPath]
      } else {
        files = await glob('**/*', {
          cwd: absPath,
          nodir: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
          absolute: true,
        })
      }
    } catch {
      // Treat as glob pattern
      files = await glob(searchPath, {
        cwd,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
        absolute: true,
      })
    }

    const results: string[] = []
    let totalMatches = 0

    for (const file of files) {
      if (totalMatches >= MAX_RESULTS) break
      let content: string
      try {
        content = readFileSync(file, 'utf-8')
      } catch {
        continue // Skip binary / unreadable
      }

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue
        totalMatches++

        const start = Math.max(0, i - contextLines)
        const end = Math.min(lines.length - 1, i + contextLines)
        const rel = file.replace(cwd + '/', '')

        for (let j = start; j <= end; j++) {
          const prefix = j === i ? `${rel}:${j + 1}:` : `${rel}:${j + 1}-`
          results.push(`${prefix} ${lines[j]}`)
        }
        if (contextLines > 0) results.push('---')

        if (totalMatches >= MAX_RESULTS) {
          results.push(`... (truncated at ${MAX_RESULTS} matches)`)
          break
        }
      }
    }

    if (results.length === 0) {
      return ok(`No matches for pattern: ${pattern}`)
    }
    return ok(results.join('\n'))
  },
})
