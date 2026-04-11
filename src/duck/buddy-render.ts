/**
 * Render a Buddy to the terminal with color + stats bar.
 */

import chalk from 'chalk'
import type { Buddy, Rarity } from './buddy.js'
import { ASCII } from './buddy.js'

const RARITY_COLORS: Record<Rarity, (s: string) => string> = {
  Common: chalk.white,
  Uncommon: chalk.green,
  Rare: chalk.cyan,
  Legendary: chalk.magenta.bold,
}

function statBar(value: number, width: number = 10): string {
  const filled = Math.round((value / 100) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const color = value >= 80 ? chalk.magenta : value >= 60 ? chalk.cyan : value >= 40 ? chalk.green : chalk.yellow
  return color(bar)
}

export function renderBuddy(buddy: Buddy): void {
  const art = ASCII[buddy.species] ?? ASCII.Rubber
  const rarityColor = RARITY_COLORS[buddy.rarity]

  console.log()
  for (const line of art) {
    console.log('  ' + rarityColor(line))
  }
  console.log()
  console.log(`  ${chalk.bold(buddy.name)}  ${chalk.dim('·')}  ${rarityColor(buddy.rarity)} ${chalk.dim(buddy.species)}`)
  console.log(chalk.dim('  ' + buddy.personality))
  console.log()
  console.log(`  ${chalk.dim('DEBUGGING')} ${statBar(buddy.stats.DEBUGGING)} ${chalk.dim(String(buddy.stats.DEBUGGING).padStart(3))}`)
  console.log(`  ${chalk.dim('PATIENCE ')} ${statBar(buddy.stats.PATIENCE)} ${chalk.dim(String(buddy.stats.PATIENCE).padStart(3))}`)
  console.log(`  ${chalk.dim('CHAOS    ')} ${statBar(buddy.stats.CHAOS)} ${chalk.dim(String(buddy.stats.CHAOS).padStart(3))}`)
  console.log(`  ${chalk.dim('WISDOM   ')} ${statBar(buddy.stats.WISDOM)} ${chalk.dim(String(buddy.stats.WISDOM).padStart(3))}`)
  console.log(`  ${chalk.dim('SNARK    ')} ${statBar(buddy.stats.SNARK)} ${chalk.dim(String(buddy.stats.SNARK).padStart(3))}`)
  console.log()
}
