import { registerTool, ok, err } from './registry.js'

const MAX_BYTES = 100_000
const TIMEOUT_MS = 15_000

registerTool({
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its text content (HTML stripped to readable text). ' +
      'Useful for reading documentation, API specs, or error pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        raw: {
          type: 'boolean',
          description: 'Return raw HTML instead of extracted text (default: false)',
        },
      },
      required: ['url'],
    },
  },
  permission: 'auto',

  async execute(input) {
    const url = input.url as string
    const raw = (input.raw as boolean | undefined) ?? false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'duckcode/0.1' },
      })
      clearTimeout(timer)

      const contentType = res.headers.get('content-type') ?? ''
      const bytes = await res.arrayBuffer()
      const text = new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.slice(0, MAX_BYTES),
      )

      if (!res.ok) {
        return err(`HTTP ${res.status}: ${text.slice(0, 500)}`)
      }

      if (raw || !contentType.includes('html')) {
        return ok(text)
      }

      // Strip HTML tags for readability
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      return ok(stripped.slice(0, MAX_BYTES))
    } catch (e: unknown) {
      clearTimeout(timer)
      const msg = (e as Error).message
      if (msg.includes('abort')) return err(`Request timed out after ${TIMEOUT_MS}ms`)
      return err(msg)
    }
  },
})
