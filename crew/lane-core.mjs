// Shared lane-core helpers (S1-13).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

export const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function within(root, path) {
  try {
    const base = realpathSync(root), real = realpathSync(path)
    return real === base || real.startsWith(`${base}${sep}`)
  } catch { return false }
}

export const HEX_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const describeError = (error) => ({ code: error?.code ?? null, message: String(error?.message ?? error) })
export const GIT_STATUS_ARGS = Object.freeze(['status', '--porcelain=v1', '-z', '--untracked-files=all'])

// Limits: ignored files, outside writes (including the main repo's .git), restored edits,
// index-only changes and writes after unproven teardown escape detection; directories are status-only.
export function gitRepoState(cwd) {
  try {
    const result = spawnSync('git', [...GIT_STATUS_ARGS], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 })
    if (result.status !== 0 || typeof result.stdout !== 'string') return null
    if (result.stdout === '') return ''
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 * 1024 })
    if (root.status !== 0 || typeof root.stdout !== 'string' || !root.stdout.endsWith('\n')) return null
    const fields = result.stdout.split('\0')
    const entries = []
    for (let i = 0; i < fields.length; i++) {
      let entry = fields[i]
      if (!entry) continue
      const path = join(root.stdout.slice(0, -1), entry.slice(3))
      if (entry[0] === 'R' || entry[0] === 'C') entry += ` <- ${fields[++i]}`
      let digest
      try {
        const stat = lstatSync(path)
        if (stat.isFile()) digest = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
        else if (stat.isSymbolicLink()) digest = `link:${readlinkSync(path)}`
        else if (stat.isDirectory()) digest = 'dir'
        else return null
      } catch (error) {
        if (error?.code !== 'ENOENT') return null
        digest = 'missing'
      }
      entries.push(`${entry} ${digest}\0`)
    }
    return entries.join('')
  } catch { return null }
}
