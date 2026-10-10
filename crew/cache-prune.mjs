import { lstatSync as nativeLstatSync, readFileSync as nativeReadFileSync, readdirSync as nativeReaddirSync, rmSync as nativeRmSync } from 'node:fs'
import { join, relative } from 'node:path'

export const CACHE_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55'

export function isCacheDir(path, deps = {}) {
  const lstatSync = deps.lstatSync || nativeLstatSync
  const readFileSync = deps.readFileSync || nativeReadFileSync
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    return readFileSync(join(path, 'CACHEDIR.TAG'), 'utf8').startsWith(CACHE_SIGNATURE)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// lean: synchronous two-pass cache scan; stream measurement if teardown latency becomes material
export function pruneCacheDirs({ taskDir, log }, deps = {}) {
  const lstatSync = deps.lstatSync || nativeLstatSync
  const readFileSync = deps.readFileSync || nativeReadFileSync
  const readdirSync = deps.readdirSync || nativeReaddirSync
  const rmSync = deps.rmSync || nativeRmSync
  const removed = []
  const failed = []
  const rel = (path) => relative(taskDir, path) || '.'
  const diagnostic = (path, error) => failed.push({ path: rel(path), error: String(error?.message || error) })
  const measureBytes = (path) => {
    let total = 0
    const stack = [path]
    try {
      while (stack.length) {
        const current = stack.pop()
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || stat.isFile()) total += stat.size
        else if (stat.isDirectory()) {
          for (const name of readdirSync(current)) stack.push(join(current, name))
        }
      }
      return total
    } catch (error) {
      diagnostic(path, error)
      return null
    }
  }
  const walk = (path) => {
    let stat
    try { stat = lstatSync(path) } catch (error) {
      diagnostic(path, error)
      return
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    let tagged
    try { tagged = isCacheDir(path, { lstatSync, readFileSync }) } catch (error) {
      diagnostic(path, error)
      tagged = false
    }
    if (tagged) {
      const bytes = measureBytes(path)
      try {
        rmSync(path, { recursive: true, force: true })
        removed.push({ path: rel(path), bytes })
      } catch (error) {
        failed.push({ path: relative(taskDir, path), error: String(error?.message || error) })
      }
      return
    }
    let names
    try { names = readdirSync(path) } catch (error) {
      diagnostic(path, error)
      return
    }
    for (const name of names) walk(join(path, name))
  }

  try {
    const stat = lstatSync(taskDir)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names
      try { names = readdirSync(taskDir) } catch (error) { diagnostic(taskDir, error); names = [] }
      for (const name of names) walk(join(taskDir, name))
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') diagnostic(taskDir, error)
  }

  const freedBytes = removed.some((entry) => entry.bytes === null)
    ? null
    : removed.reduce((sum, entry) => sum + entry.bytes, 0)
  const report = { event: 'cache-pruned', removed, failed, freed_bytes: freedBytes }
  try { log?.({ at: new Date().toISOString(), ...report }) } catch {}
  return report
}
