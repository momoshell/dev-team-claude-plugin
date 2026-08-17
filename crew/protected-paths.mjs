// crew/protected-paths.mjs — the authored protected-path floor and its union
// rule. This leaf stays import-free so crew/drive.mjs and
// scripts/factory/probe-repo.mjs share one owner without a dependency cycle.
// The floor may only grow: every supplied list is additions to this floor.
// Capability register, schema, and model-ladder changes alter what a seat may do and carry the roster's review posture (#292/#299/#304).
// crew/roles/ is deliberately absent: charters are pinned by tests already.

export const PROTECTED_PATHS = Object.freeze([
  '.github/workflows/', 'crew/roster.json', 'crew/roster.schema.json',
  'crew/reclaim.mjs', 'crew/escalation-policy.mjs', 'crew/drive.mjs',
  'crew/variants.mjs', 'docs/adr/', 'crew/protected-paths.mjs',
  'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json',
])

function normaliseProtectedPath(value) {
  const normal = String(value).replaceAll('\\', '/')
  return normal === './' ? '.' : normal.startsWith('./') ? normal.slice(2) : normal
}

function displayValue(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function resolveProtectedPaths(extra) {
  if (extra == null) return PROTECTED_PATHS
  if (!Array.isArray(extra)) {
    throw new Error(`protected paths: additions must be an array of non-blank strings, got ${typeof extra}`)
  }
  const additions = extra.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`protected paths: additions[${index}] must be a non-blank string, got ${displayValue(entry)}`)
    }
    return normaliseProtectedPath(entry)
  })
  return Object.freeze([...new Set([...PROTECTED_PATHS, ...additions])].sort())
}

export function protectedHitsIn(entries, paths) {
  const hits = []
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = String(raw ?? '')
    if (!entry) continue
    // Both directions: a scope entry under a protected directory, and a scope
    // directory that contains a protected file.
    if ((Array.isArray(paths) ? paths : []).some((path) => (
      entry === path || (path.endsWith('/') && entry.startsWith(path))
        || (entry.endsWith('/') && path.startsWith(entry))
    ))) {
      if (!hits.includes(entry)) hits.push(entry)
    }
  }
  return hits
}
