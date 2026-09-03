// Content pins for prose citations; see references/citations.md and vacuity.md's detector-key section.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

export const MIN_EXPECTED_LENGTH = 12
export const ANCHOR_ROOTS = Object.freeze(['crew', 'scripts', 'test', 'docs', 'skills', 'visualizer', 'tasks', '.github'])
export const ANCHOR_PATTERN = '([A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+\\.(?:mjs|ts|js|json|md|sh|yml)):(\\d+)'

const ANCHOR_RE = new RegExp(ANCHOR_PATTERN, 'g')

export function lineCarries(line, expected) { return line.includes(expected) }

export function occurrencesOf(lines, expected) {
  if (!Array.isArray(lines) || typeof expected !== 'string') return 0
  return lines.filter((line) => line.includes(expected)).length
}

export function isDistinctive(lines, expected) {
  return typeof expected === 'string'
    && expected.trim().length >= MIN_EXPECTED_LENGTH
    && occurrencesOf(lines, expected) === 1
}

export function collectAnchors({ docs }) {
  const anchors = []
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8')
    ANCHOR_RE.lastIndex = 0
    for (const [, rel, number] of text.matchAll(ANCHOR_RE)) {
      if (!ANCHOR_ROOTS.includes(rel.split('/')[0])) continue
      const line = Number(number)
      anchors.push({ doc, rel, line, key: `${rel}:${line}` })
    }
  }
  return anchors
}

function markdownIn(dir) {
  const docs = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (name.endsWith('.md') && !statSync(path).isDirectory()) docs.push(path)
  }
  return docs
}

// A directory carrying an anchors.json is enough (#747). A skill keeps its layout -
// SKILL.md plus references/*.md - and any OTHER pinned directory, crew/roles among
// them, is read as the markdown files it holds. Without the fallback crew/roles
// resolves to no docs at all and a repair silently finds nothing to relocate.
export function skillDocs(skillDir) {
  const docs = []
  const skill = join(skillDir, 'SKILL.md')
  if (existsSync(skill) && !statSync(skill).isDirectory()) docs.push(skill)
  const refs = join(skillDir, 'references')
  if (existsSync(refs) && statSync(refs).isDirectory()) docs.push(...markdownIn(refs))
  if (docs.length > 0) return docs
  return existsSync(skillDir) && statSync(skillDir).isDirectory() ? markdownIn(skillDir) : docs
}

function display(value) {
  return JSON.stringify(value)
}

function readTargetLines(root, anchor) {
  const target = join(root, anchor.rel)
  try {
    if (!existsSync(target)) return { failure: `${anchor.key}: target file is missing` }
    if (statSync(target).isDirectory()) return { failure: `${anchor.key}: target is a directory` }
    return { lines: readFileSync(target, 'utf8').split('\n') }
  } catch (error) {
    return { failure: `${anchor.key}: target could not be read (${error?.code || error?.message || String(error)})` }
  }
}

export function checkAnchors({ root, docs, manifest }) {
  let anchors
  try {
    anchors = collectAnchors({ docs })
  } catch (error) {
    return { anchors: 0, failures: [`citation docs could not be read (${error?.code || error?.message || String(error)})`], shifted: [] }
  }
  const failures = []
  const shifted = []
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const cited = new Set(anchors.map(({ key }) => key))

  for (const anchor of anchors) {
    const { lines, failure } = readTargetLines(root, anchor)
    if (failure) { failures.push(failure); continue }

    if (!Object.hasOwn(declarations, anchor.key)) {
      failures.push(`${anchor.key}: manifest has no entry`)
      continue
    }
    const expected = declarations[anchor.key]
    // Three outcomes, never two (#582's fourth ask). isDistinctive keeps both HARD
    // ones with the message they have always carried: content that appears nowhere
    // is ROT and content on more than one line is AMBIGUOUS. Past that gate exactly
    // one line carries the text, so the cited line either IS that line (pinned) or
    // is not (shifted) - and a shift is repairable, not a failure. The cited line is
    // deliberately no longer range-checked ahead of the content: a citation past EOF
    // whose content is found once is a shift, and one found nowhere is rot.
    if (!isDistinctive(lines, expected)) {
      failures.push(`${anchor.key}: expected ${display(expected)} must be at least ${MIN_EXPECTED_LENGTH} non-space characters and occur on exactly one target line`)
      continue
    }
    const at = lines.findIndex((line) => lineCarries(line, expected)) + 1
    if (at === anchor.line) continue
    shifted.push({ key: anchor.key, rel: anchor.rel, from: anchor.line, to: at, nextKey: `${anchor.rel}:${at}` })
  }

  for (const key of Object.keys(declarations)) {
    if (!cited.has(key)) failures.push(`${key}: manifest entry is orphaned (no citation)`)
  }

  return { anchors: anchors.length, failures, shifted }
}

export function checkSkillAnchors({ root, skillDir, manifestPath }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`)
  }
  return checkAnchors({ root, docs: skillDocs(skillDir), manifest })
}

// ADR-040 moves repair of a pinning manifest outside this fence to the post-merge pass on main.
// A shift is repairable by whoever owns BOTH the file it points at and the manifest that
// pins it. When this lane changed both, it could have run --repair and did not: that is a
// failure. Otherwise it is a warning, because failing on it would demand a repair outside
// the fence. #859, #882
export function partitionShifts({ shifted, fence, manifest }) {
  const fenced = new Set(Array.isArray(fence) ? fence : [])
  const owned = typeof manifest === 'string' ? fenced.has(manifest) : true
  const inFence = []
  const outOfFence = []
  for (const shift of shifted) ((owned && fenced.has(shift.rel)) ? inFence : outOfFence).push(shift)
  return { inFence, outOfFence }
}

function defaultRun(args, root) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function outputPaths(output) {
  if (typeof output !== 'string') return null
  return output.split(/\r?\n/).filter((path) => path !== '')
}

// The lane's own fence, measured: the paths this branch changed against its merge
// base plus anything dirty or untracked. Unmeasurable (no git, no base branch, a
// scratch fixture root) yields an EMPTY fence and a stated reason - a blind spot is
// named, never guessed at.
export function laneFence({ root, base = 'main', run = defaultRun } = {}) {
  const invoke = (args) => {
    try { return run(args, root) } catch { return null }
  }
  if (typeof root !== 'string' || root.length === 0) return { paths: [], measured: false, reason: 'git root could not be measured' }
  const top = invoke(['rev-parse', '--show-toplevel'])
  if (top === null) return { paths: [], measured: false, reason: 'git root could not be measured' }
  const gitRoot = typeof top === 'string' ? top.trim() : ''
  if (gitRoot !== root) return { paths: [], measured: false, reason: `git root is ${gitRoot || 'unknown'}, expected ${root}` }
  const merge = invoke(['merge-base', 'HEAD', base])
  if (typeof merge !== 'string' || merge.trim() === '') return { paths: [], measured: false, reason: `no merge base with ${base}` }
  const mergeBase = merge.trim()
  const changed = outputPaths(invoke(['diff', '--name-only', mergeBase]))
  if (changed === null) return { paths: [], measured: false, reason: 'changed paths could not be measured' }
  const untracked = outputPaths(invoke(['ls-files', '--others', '--exclude-standard']))
  if (untracked === null) return { paths: [], measured: false, reason: 'untracked paths could not be measured' }
  return { paths: [...new Set([...changed, ...untracked])], measured: true, reason: null }
}

function shiftLine(shift, skillDir, fenced) {
  const where = fenced ? ' on a file inside this lane\'s fence' : ''
  const mode = fenced ? '--repair' : '--repair-all'
  const when = fenced ? '' : ' after this lane merges, on main'
  return `shifted ${shift.key} -> line ${shift.to}${where}; repair${when} with: node skills/qa-test-writing/anchor-pin.mjs ${mode} ${skillDir}`
}

// Returns the anchor COUNT as a primitive. Both callers assert it under
// node:assert/strict (skills/backend-node/exhibits.test.mjs:52 and
// skills/devops/exhibits.test.mjs:53) and neither may be edited by the lane that
// made a shift non-fatal, so a boxed or object return would redden two exhibits
// this lane must leave alone. The shifts are reported two other ways instead:
// through `log`, so a shift is never SILENT in a suite run, and through
// checkSkillAnchors for a caller that wants the records themselves.
export function assertAnchorsPinned({ root, skillDir, manifestPath, minAnchors, log = console.warn, fence }) {
  const result = checkSkillAnchors({ root, skillDir, manifestPath })
  const failures = [...result.failures]
  if (result.anchors < minAnchors) failures.push(`expected at least ${minAnchors} anchors, found ${result.anchors}`)
  const measured = fence === undefined ? laneFence({ root }) : { paths: fence, measured: true, reason: null }
  const manifestRel = typeof manifestPath === 'string' && typeof root === 'string' ? relative(root, manifestPath).replaceAll('\\', '/') : null
  const { inFence, outOfFence } = partitionShifts({ shifted: result.shifted, fence: measured.paths, manifest: manifestRel })
  for (const shift of inFence) failures.push(shiftLine(shift, skillDir, true))
  if (failures.length > 0) throw new Error(failures.join('\n'))
  if (!measured.measured) {
    const warning = `anchor fence unmeasured (${measured.reason}); shifts are warn-only`
    if (outOfFence.length > 0) {
      log(`${warning}; ${shiftLine(outOfFence[0], skillDir, false)}`)
      outOfFence.shift()
    } else log(warning)
  }
  for (const shift of outOfFence) log(shiftLine(shift, skillDir, false))
  return result.anchors
}

function escapeLiteral(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function rewriteCitations(text, rewrites) {
  if (!(rewrites instanceof Map) || rewrites.size === 0) return text
  const pattern = new RegExp(`(${[...rewrites.keys()].map(escapeLiteral).join('|')})(?!\\d)`, 'g')
  return text.replace(pattern, (match) => rewrites.get(match))
}

export function repairAnchors({ root, docs, manifest, repairAll = false }) {
  let anchors
  try {
    anchors = collectAnchors({ docs })
  } catch (error) {
    return { anchors: 0, repairs: [], refusals: [`citation docs could not be read (${error?.code || error?.message || String(error)})`], manifest, edits: [] }
  }
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const cited = new Set(anchors.map(({ key }) => key))
  const refusals = []
  const repairs = []
  const rewrites = new Map()
  const candidates = []
  const seen = new Set()
  const repairFence = laneFence({ root })
  const repairPaths = new Set(repairFence.paths)

  for (const anchor of anchors) {
    if (seen.has(anchor.key)) continue
    seen.add(anchor.key)
    const { lines, failure } = readTargetLines(root, anchor)
    if (failure) { refusals.push(failure); continue }
    if (!Object.hasOwn(declarations, anchor.key)) {
      refusals.push(`${anchor.key}: manifest has no entry`)
      continue
    }
    const expected = declarations[anchor.key]
    if (typeof expected !== 'string' || expected.trim().length < MIN_EXPECTED_LENGTH) {
      refusals.push(`${anchor.key}: expected ${display(expected)} must be at least ${MIN_EXPECTED_LENGTH} non-space characters`)
      continue
    }
    const found = []
    for (let i = 0; i < lines.length; i += 1) if (lineCarries(lines[i], expected)) found.push(i + 1)
    if (found.length === 0) {
      refusals.push(`${anchor.key}: content appears nowhere in ${anchor.rel}; this is rot, not a shift`)
      continue
    }
    if (found.length > 1) {
      refusals.push(`${anchor.key}: content occurs ${found.length} times in ${anchor.rel}; a repair refuses to guess`)
      continue
    }
    const nextLine = found[0]
    if (nextLine === anchor.line) continue
    const nextKey = `${anchor.rel}:${nextLine}`
    // A measured fence authorizes rewriting only a target this lane owns unless an
    // operator explicitly requests a repair-all pass for committed external drift.
    if (!repairAll && repairFence.measured && !repairPaths.has(anchor.rel)) continue
    candidates.push({ key: anchor.key, rel: anchor.rel, from: anchor.line, to: nextLine, nextKey, expected })
  }

  // Collision is judged against a LIVE occupancy map, not the manifest as it was at
  // the start of the pass: an anchor that VACATES a line earlier in the same pass no
  // longer occupies it. The settle loop repeats while any candidate lands, so the
  // order citations appear in the docs stops deciding the outcome; only a true cycle
  // is refused. Before this, repairing crew/daemon.test.mjs:253 -> :255 refused
  // because :255's own anchor had not moved yet, and two of four manifests needed a
  // hand repair. #859
  const live = new Map(Object.entries(declarations))
  let pending = candidates
  let progress = true
  while (progress && pending.length > 0) {
    progress = false
    const stuck = []
    for (const candidate of pending) {
      if (live.has(candidate.nextKey) && live.get(candidate.nextKey) !== candidate.expected) { stuck.push(candidate); continue }
      live.delete(candidate.key)
      live.set(candidate.nextKey, candidate.expected)
      rewrites.set(candidate.key, candidate.nextKey)
      repairs.push({ key: candidate.key, rel: candidate.rel, from: candidate.from, to: candidate.to, nextKey: candidate.nextKey })
      progress = true
    }
    pending = stuck
  }
  for (const candidate of pending) refusals.push(`${candidate.key}: line ${candidate.to} is already declared by another anchor`)

  for (const key of Object.keys(declarations)) {
    if (!cited.has(key)) refusals.push(`${key}: manifest entry is orphaned (no citation)`)
  }

  const next = { ...declarations }
  for (const repair of repairs) delete next[repair.key]
  for (const repair of repairs) next[repair.nextKey] = declarations[repair.key]

  const edits = []
  for (const doc of docs) {
    let text
    try {
      text = readFileSync(doc, 'utf8')
    } catch (error) {
      refusals.push(`${doc}: citation doc could not be re-read (${error?.code || error?.message || String(error)})`)
      continue
    }
    const rewritten = rewriteCitations(text, rewrites)
    if (rewritten !== text) edits.push({ doc, text: rewritten })
  }

  return { anchors: anchors.length, repairs, refusals, manifest: next, edits }
}

export function repairAnchorsInPlace({ root, skillDir, manifestPath, repairAll = false }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { anchors: 0, repairs: [], refusals: [`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`], manifest: {}, edits: [] }
  }
  const result = repairAnchors({ root, docs: skillDocs(skillDir), manifest, repairAll })
  if (result.repairs.length > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`)
    for (const edit of result.edits) writeFileSync(edit.doc, edit.text)
  }
  return result
}

export function repairCli(argv, log = console.log) {
  let skillDir = null
  let repairAll = false
  let root = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repair' || argv[i] === '--repair-all') {
      skillDir = argv[i + 1]
      repairAll = argv[i] === '--repair-all'
      i += 1
      continue
    }
    if (argv[i] === '--root') { root = argv[i + 1]; i += 1; continue }
    log(`unknown argument ${argv[i]}`)
    return 2
  }
  if (!skillDir || !root) {
    log('usage: node skills/qa-test-writing/anchor-pin.mjs (--repair | --repair-all) <dir> [--root <root>]')
    return 2
  }
  const result = repairAnchorsInPlace({ root, skillDir, manifestPath: join(skillDir, 'anchors.json'), repairAll })
  for (const repair of result.repairs) log(`repaired ${repair.key} -> ${repair.nextKey}`)
  for (const refusal of result.refusals) log(`refused ${refusal}`)
  return result.refusals.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(repairCli(process.argv.slice(2)))
