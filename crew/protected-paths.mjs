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

export const PROMPT_SURFACE = Object.freeze({ paths: Object.freeze(['crew/roles/', 'crew/guidelines/']), templateBlocks: Object.freeze(['ACCEPTANCE_GATE_BLOCK', 'HOSTILE_ENV_BLOCK', 'CONVENTIONS_BLOCK', 'MUTATION_CONTRACT_BLOCK']) })
export const PROMPT_SURFACE_BLIND_SPOT = 'BLIND SPOT: path matching cannot see a prompt embedded as a template string in a compiler; the named templateBlocks require human recognition.'

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

export function grantedSkillPaths(register) {
  const grants = []
  for (const role of Object.values(register?.roles || {})) {
    if (Array.isArray(role?.skills)) grants.push(...role.skills.filter((entry) => typeof entry === 'string'))
    for (const overlay of Object.values(role?.by_agent || {})) {
      if (Array.isArray(overlay?.skills)) grants.push(...overlay.skills.filter((entry) => typeof entry === 'string'))
    }
  }
  return Object.freeze([...new Set(grants)].sort())
}

export function promptSurfacePaths(register) {
  return Object.freeze([...new Set([...PROMPT_SURFACE.paths, ...grantedSkillPaths(register)])].sort())
}

// The builder-brief wrapper sees the PLAN's scope, which may name a directory
// ('crew/roles/'). A directory that intersects the surface is a hit — the
// builder may write a charter under it — while a concrete non-Markdown file
// (crew/roles/anchors.json) is not. promptDocumentHits stays for the publish
// and closeout consumers, whose inputs are always concrete committed files.
export function promptScopeHits(entries, paths) {
  return protectedHitsIn(entries, paths).filter((entry) => entry.endsWith('/') || entry.endsWith('.md'))
}

export function promptDocumentHits(entries, paths) {
  return protectedHitsIn(entries, paths).filter((entry) => entry.endsWith('.md'))
}
