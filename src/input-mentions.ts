/**
 * Input mention expansion.
 *
 * Preprocess user input to expand `@` references:
 *   @path/to/file.ts         → attach file content inline
 *   @https://example.com/x.png → attach as image_url content block
 *
 * Returns the expanded text and an array of image content blocks (for
 * multimodal messages). Text-only file attachments are inlined into
 * the text with a fenced code block.
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const MAX_FILE_BYTES = 100_000
// Matches @followed by a path or URL; stops at whitespace or end
const MENTION_RE = /@(\S+)/g

export interface ImageBlock {
  type: 'image_url'
  image_url: { url: string }
}

export interface ExpandedInput {
  text: string           // Expanded text with file contents inlined
  images: ImageBlock[]   // Image URLs to attach as content blocks
  warnings: string[]     // Non-fatal issues to show the user
}

function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s)
}

function isImageUrl(s: string): boolean {
  if (!isUrl(s)) return false
  const lower = s.toLowerCase().split('?')[0]
  for (const ext of IMAGE_EXTS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

function inlineFile(mention: string, cwd: string): { replacement: string; warning?: string } {
  const filePath = resolve(cwd, mention)
  if (!existsSync(filePath)) {
    return { replacement: `@${mention}`, warning: `file not found: ${mention}` }
  }

  try {
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { replacement: `@${mention}`, warning: `@${mention} is a directory (not supported)` }
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        replacement: `@${mention}`,
        warning: `@${mention} too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`,
      }
    }
    const content = readFileSync(filePath, 'utf-8')
    // Inline as fenced code block with file path header
    return {
      replacement: `\n\n[attached: ${mention}]\n\`\`\`\n${content}\n\`\`\`\n`,
    }
  } catch (e) {
    return { replacement: `@${mention}`, warning: `cannot read ${mention}: ${(e as Error).message}` }
  }
}

/**
 * Expand @mentions in user input. Returns text with file contents
 * inlined and any image URLs extracted as separate content blocks.
 */
export function expandMentions(input: string, cwd: string): ExpandedInput {
  const images: ImageBlock[] = []
  const warnings: string[] = []

  const expanded = input.replace(MENTION_RE, (match, target: string) => {
    // Image URL → extract as content block, remove from text
    if (isImageUrl(target)) {
      images.push({ type: 'image_url', image_url: { url: target } })
      return `[image: ${target}]`
    }

    // Non-image URL → leave as-is (Duck can fetch it with web_fetch)
    if (isUrl(target)) {
      return match
    }

    // Local file path → inline content
    const { replacement, warning } = inlineFile(target, cwd)
    if (warning) warnings.push(warning)
    return replacement
  })

  return { text: expanded, images, warnings }
}
