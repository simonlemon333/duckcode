/**
 * Buddy system — deterministic + LLM-generated terminal pet.
 *
 * Two-layer architecture (Bones + Soul):
 *
 * Bones (deterministic, recomputed every session):
 *   - seed = hash(userId + 'duck-buddy-2026')
 *   - Mulberry32 PRNG gives species, rarity, 5 stats
 *   - Same userId always yields same Bones — no local cheating
 *
 * Soul (LLM-generated once, persisted to ~/.duck/buddy.json):
 *   - First /buddy call: LLM generates name + personality from Bones
 *   - Subsequent /buddy calls: load from JSON, no LLM call
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import type { GatewayConfig } from '../types.js'

const BUDDY_PATH = join(homedir(), '.duck', 'buddy.json')
const CONFIG_PATH = join(homedir(), '.duck', 'config.json')

// ─── Types ──────────────────────────────────────────────────────────────────

export type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Legendary'

export interface Stats {
  DEBUGGING: number
  PATIENCE: number
  CHAOS: number
  WISDOM: number
  SNARK: number
}

export interface Bones {
  species: string      // e.g. "Rubber", "Mallard", "UniDuck"
  rarity: Rarity
  stats: Stats
}

export interface Soul {
  name: string
  personality: string
  createdAt: string
}

export interface Buddy extends Bones, Soul {}

// ─── Mulberry32 PRNG ────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFromUserId(userId: string): number {
  const hash = createHash('sha256').update(userId + 'duck-buddy-2026').digest()
  // Take first 4 bytes as uint32
  return hash.readUInt32BE(0)
}

// ─── Species + Rarity ───────────────────────────────────────────────────────

const SPECIES_BY_RARITY: Record<Rarity, string[]> = {
  Common: ['Puddle', 'Rubber'],
  Uncommon: ['Mallard', 'Steel'],
  Rare: ['Flame', 'Ghost', 'Ice'],
  Legendary: ['UniDuck', 'Inferno'],
}

function rollRarity(rand: () => number): Rarity {
  const r = rand() * 100
  if (r < 50) return 'Common'      // 50%
  if (r < 80) return 'Uncommon'    // 30%
  if (r < 98) return 'Rare'        // 18%
  return 'Legendary'               // 2%
}

function rollSpecies(rand: () => number, rarity: Rarity): string {
  const pool = SPECIES_BY_RARITY[rarity]
  return pool[Math.floor(rand() * pool.length)]
}

function rollStats(rand: () => number): Stats {
  return {
    DEBUGGING: Math.floor(rand() * 101),
    PATIENCE: Math.floor(rand() * 101),
    CHAOS: Math.floor(rand() * 101),
    WISDOM: Math.floor(rand() * 101),
    SNARK: Math.floor(rand() * 101),
  }
}

// ─── Bones computation ──────────────────────────────────────────────────────

export function computeBones(userId: string): Bones {
  const rand = mulberry32(seedFromUserId(userId))
  const rarity = rollRarity(rand)
  const species = rollSpecies(rand, rarity)
  const stats = rollStats(rand)
  return { species, rarity, stats }
}

// ─── ASCII art ──────────────────────────────────────────────────────────────

export const ASCII: Record<string, string[]> = {
  Puddle: [
    '   _      ',
    ' <(o )_   ',
    '  (    )  ',
    '   `--\'   ',
  ],
  Rubber: [
    '   _      ',
    ' <(o )__  ',
    '  ( ._> / ',
    '   `___\'  ',
  ],
  Mallard: [
    '   _      ',
    ' <(o )__  ',
    '  (=._> / ',
    ' ~~`___\'  ',
  ],
  Steel: [
    '   _      ',
    ' <[o]==]  ',
    '  [._]==/ ',
    '   `===\'  ',
  ],
  Flame: [
    '  )~(     ',
    ' <(o )__  ',
    '  ( ._> / ',
    '   `___\'  ',
  ],
  Ghost: [
    '   _      ',
    ' <(. )__  ',
    '  ( \' > / ',
    '   ~ ~ ~  ',
  ],
  Ice: [
    '   *      ',
    ' <(o )__  ',
    '  ( ._>*| ',
    '   `___\'  ',
  ],
  UniDuck: [
    ' /\\  _    ',
    '<(o )__   ',
    ' ( ._> /  ',
    '  `___\'   ',
  ],
  Inferno: [
    ' *))~((*  ',
    ' <(o )__  ',
    '  ( ._> / ',
    '   `___\'  ',
  ],
}

// ─── userId management ─────────────────────────────────────────────────────

export function getOrCreateUserId(): string {
  let config: Record<string, unknown> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    } catch {
      // Ignore — we'll just generate a new userId below
    }
  }

  if (typeof config.userId === 'string' && config.userId.length > 0) {
    return config.userId
  }

  // Generate a new userId (UUID v4-ish)
  const userId = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest('hex')
    .slice(0, 32)

  config.userId = userId

  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  } catch {
    // Non-fatal; buddy still works with ephemeral userId
  }

  return userId
}

// ─── Soul persistence ──────────────────────────────────────────────────────

export function loadSoul(): Soul | null {
  if (!existsSync(BUDDY_PATH)) return null
  try {
    const data = JSON.parse(readFileSync(BUDDY_PATH, 'utf-8'))
    if (typeof data.name !== 'string' || typeof data.personality !== 'string') {
      return null
    }
    return data as Soul
  } catch {
    return null
  }
}

function saveSoul(soul: Soul): void {
  try {
    mkdirSync(dirname(BUDDY_PATH), { recursive: true })
    writeFileSync(BUDDY_PATH, JSON.stringify(soul, null, 2), 'utf-8')
  } catch {
    // Non-fatal
  }
}

// ─── Soul generation (LLM call) ────────────────────────────────────────────

async function generateSoul(bones: Bones, config: GatewayConfig): Promise<Soul> {
  const prompt = `You are naming a DuckCode buddy pet. Output ONLY a JSON object with keys "name" and "personality" — no markdown fences, no commentary.

Pet details:
- Species: ${bones.species} duck
- Rarity: ${bones.rarity}
- Stats: DEBUGGING=${bones.stats.DEBUGGING}, PATIENCE=${bones.stats.PATIENCE}, CHAOS=${bones.stats.CHAOS}, WISDOM=${bones.stats.WISDOM}, SNARK=${bones.stats.SNARK}

Generate:
- "name": a short creative duck name (1-2 words, under 20 chars)
- "personality": one sentence describing personality, drawing from the highest stats

Example output:
{"name": "Lord Quackington", "personality": "A patient debugging savant with a razor-sharp wit."}`

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        stream: false,
      }),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    let raw = data.choices?.[0]?.message?.content ?? ''
    // Strip any <think> blocks (MiniMax)
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    // Strip markdown code fences if LLM wrapped JSON in ```json ... ```
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()

    // Extract outermost JSON object: first { to last } (greedy, not first-pair)
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`no JSON braces in response: ${raw.slice(0, 120)}`)
    }
    const jsonStr = raw.slice(start, end + 1)
    const parsed = JSON.parse(jsonStr)
    if (typeof parsed.name !== 'string' || typeof parsed.personality !== 'string') {
      throw new Error(`invalid shape: ${jsonStr.slice(0, 120)}`)
    }

    return {
      name: parsed.name.slice(0, 40),
      personality: parsed.personality.slice(0, 200),
      createdAt: new Date().toISOString(),
    }
  } catch (e) {
    if (process.env.DUCK_DEBUG_BUDDY) {
      console.error(`[buddy] Soul generation fell back: ${(e as Error).message}`)
    }
    // Fallback: deterministic name from species
    return {
      name: `${bones.species}-${bones.stats.WISDOM}`,
      personality: `A ${bones.rarity.toLowerCase()} ${bones.species.toLowerCase()} duck.`,
      createdAt: new Date().toISOString(),
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getBuddy(config: GatewayConfig, forceRegenSoul = false): Promise<Buddy> {
  const userId = getOrCreateUserId()
  const bones = computeBones(userId)

  let soul = forceRegenSoul ? null : loadSoul()
  if (!soul) {
    soul = await generateSoul(bones, config)
    saveSoul(soul)
  }

  return { ...bones, ...soul }
}
