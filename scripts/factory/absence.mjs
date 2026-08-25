// scripts/factory/absence.mjs — shared git-grep absence checks for task-dir gates.
//
// Exit 1 with empty stdout means PASS (the needle is absent); every other git
// status is rethrown unchanged. Collapsing those two outcomes in the "clean"
// direction is worse than the bug it removes (#581, b183 C7). Callers pair an
// absence check with a positive control because a missing directory also exits 1.
//
// LIBRARY ONLY: importing performs no I/O, and this module has no CLI or exit path.

import { execFileSync } from 'node:child_process'

function validateArgs(needle, paths) {
  if (typeof needle !== 'string' || needle.length === 0) {
    throw new TypeError('gitGrepHits: needle must be a non-empty string')
  }
  if (!Array.isArray(paths) || paths.length === 0
    || paths.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new TypeError('gitGrepHits: paths must be a non-empty array of strings')
  }
}

export function gitGrepHits({ needle, paths = ['.'], cwd = process.cwd(), fixed = true }) {
  validateArgs(needle, paths)
  const args = ['grep', '-c', ...(fixed ? ['-F'] : []), '-e', needle, '--', ...paths]
  let out
  try {
    out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
      if (err?.status !== 1) throw err
    out = String(err.stdout ?? '')
  }
  const lines = String(out).split(/\r?\n/).filter((line) => line.length > 0)
  const count = lines.reduce((total, line) => {
    const match = line.match(/:(\d+)$/)
    return total + (match ? Number(match[1]) : 0)
  }, 0)
  return { count, lines }
}

export function absenceFailure({ needle, paths = ['.'], cwd = process.cwd(), fixed = true }) {
  const { count } = gitGrepHits({ needle, paths, cwd, fixed })
  if (count === 0) return null
  return `expected no reference to ${needle}, found ${count} in ${paths.join(', ')}`
}
