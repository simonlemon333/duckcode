/**
 * Session persistence — save and restore conversation history.
 *
 * Sessions are stored as JSON files in ~/.duck/sessions/.
 * Each file contains the full history plus metadata (cwd, model, timestamp).
 *
 * Auto-save writes to `latest.json` after every turn, so resuming always
 * picks up the most recent state without explicit /save.
 *
 * Named saves (/save <name>) go to `<name>.json` and don't get overwritten
 * by auto-save.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from './types.js'

const SESSIONS_DIR = join(homedir(), '.duck', 'sessions')
const LATEST = 'latest.json'

export interface SessionData {
  version: 1
  savedAt: string
  cwd: string
  model: string
  history: Message[]
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
}

/**
 * Save a session to ~/.duck/sessions/<name>.json.
 * Name defaults to "latest" (auto-save slot).
 */
export function saveSession(
  history: Message[],
  cwd: string,
  model: string,
  name: string = 'latest',
): string {
  ensureDir()
  const safeName = sanitizeName(name) || 'latest'
  const filename = `${safeName}.json`
  const path = join(SESSIONS_DIR, filename)

  const data: SessionData = {
    version: 1,
    savedAt: new Date().toISOString(),
    cwd,
    model,
    history,
  }

  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  return path
}

/**
 * Load a session by name. Returns null if not found or invalid.
 */
export function loadSession(name: string = 'latest'): SessionData | null {
  const safeName = sanitizeName(name) || 'latest'
  const path = join(SESSIONS_DIR, `${safeName}.json`)

  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as SessionData
    if (data.version !== 1 || !Array.isArray(data.history)) return null
    return data
  } catch {
    return null
  }
}

/**
 * List all saved sessions, sorted by most recent first.
 */
export function listSessions(): Array<{ name: string; savedAt: string; messages: number; cwd: string }> {
  if (!existsSync(SESSIONS_DIR)) return []

  const entries: Array<{ name: string; savedAt: string; messages: number; cwd: string; mtime: number }> = []

  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue
      const path = join(SESSIONS_DIR, file)
      try {
        const raw = readFileSync(path, 'utf-8')
        const data = JSON.parse(raw) as SessionData
        if (data.version !== 1) continue
        entries.push({
          name: file.replace(/\.json$/, ''),
          savedAt: data.savedAt,
          messages: data.history.length,
          cwd: data.cwd,
          mtime: statSync(path).mtimeMs,
        })
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    return []
  }

  entries.sort((a, b) => b.mtime - a.mtime)
  return entries.map(({ mtime: _mtime, ...rest }) => rest)
}
