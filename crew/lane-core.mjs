// Shared lane-core helpers (S1-13).
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

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
