// Content pins for prose citations; see references/citations.md and vacuity.md's detector-key section.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

export const MIN_EXPECTED_LENGTH = 12
export const ANCHOR_ROOTS = Object.freeze(['crew', 'scripts', 'test', 'docs', 'skills', 'visualizer', 'tasks', '.github'])
export const ANCHOR_PATTERN = '([A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+\\.(?:mjs|ts|js|json|md|sh|yml)):(\\d+)'
export const RANGE_PATTERN = `${ANCHOR_PATTERN}-(\\d+)(?!\\d)`

// A NAMED citation carries no line number, so nothing about it can shift and nothing about it
// can be repaired: the manifest maps `path@name` to the content that identifies the line, and
// the line is resolved at check time. An `// ANCHOR X` comment in the target needs no extra
// machinery — declare `ANCHOR X` as that name's content and the strong form is cited. #971
export const NAMED_PATTERN = '([A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+\\.(?:mjs|ts|js|json|md|sh|yml))@([a-z0-9][a-z0-9-]*)'

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

export function collectNamed({ docs }) {
  const named = []
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8')
    for (const [, rel, name] of text.matchAll(new RegExp(NAMED_PATTERN, 'g'))) {
      if (!ANCHOR_ROOTS.includes(rel.split('/')[0])) continue
      named.push({ doc, rel, name, key: `${rel}@${name}` })
    }
  }
  return named
}

// A range citation has TWO endpoints and only the START is ever a manifest key: the end
// is unpinned text no manifest, no --repair-all and no exhibits test can see. Moving the
// start alone mints a pair that READS maintained - at 724bec1 a repair moved the start of
// a crew/crew.mjs range to 801 and left the end at 667, inverting it. #937
export function collectRanges({ docs }) {
  const ranges = []
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8')
    for (const [, rel, start, end] of text.matchAll(new RegExp(RANGE_PATTERN, 'g'))) {
      if (!ANCHOR_ROOTS.includes(rel.split('/')[0])) continue
      ranges.push({ doc, rel, start: Number(start), end: Number(end), text: `${rel}:${start}-${end}`, startKey: `${rel}:${start}`, endKey: `${rel}:${end}` })
    }
  }
  return ranges
}

export const INVERTED_MARK = 'inverted range'

// Mechanically detectable with no manifest at all, which is the point: start > end is
// proof of a previous half-repair or a typo, and it is the one check that would have
// caught both instances #937 measured.
export function invertedRangeFailure(range) {
  return `${range.text}: ${INVERTED_MARK} - start ${range.start} is after end ${range.end} in ${range.doc}; no manifest pins a range end, so this is a half-repair or a typo`
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

export function resolveNamed({ root, manifest, citation }) {
  const { key, rel } = citation
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const { lines, failure } = readTargetLines(root, { rel, key })
  if (failure) return { key, failure }
  if (!Object.hasOwn(declarations, key)) return { key, failure: `${key}: manifest has no entry` }
  const expected = declarations[key]
  if (typeof expected !== 'string' || expected.trim().length < MIN_EXPECTED_LENGTH) {
    return { key, failure: `${key}: expected ${display(expected)} must be at least ${MIN_EXPECTED_LENGTH} non-space characters` }
  }
  const found = []
  for (let i = 0; i < lines.length; i += 1) if (lineCarries(lines[i], expected)) found.push(i + 1)
  if (found.length === 0) return { key, failure: `${key}: content appears nowhere in ${rel}; this is rot, not a shift` }
  if (found.length > 1) return { key, failure: `${key}: content occurs ${found.length} times in ${rel}; a named anchor must resolve to exactly one line` }
  const at = found[0]
  return { key, line: at }
}

export function checkAnchors({ root, docs, manifest }) {
  let anchors
  let ranges
  let named
  try {
    anchors = collectAnchors({ docs })
    ranges = collectRanges({ docs })
    named = collectNamed({ docs })
  } catch (error) {
    return { anchors: 0, failures: [`citation docs could not be read (${error?.code || error?.message || String(error)})`], shifted: [] }
  }
  const failures = []
  const shifted = []
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  // A manifest-backed range END is a CITATION, and it must be VALIDATED, not merely excused.
  // Adding it to `cited` alone would stop the orphan report without ever checking the end for
  // shift, rot, ambiguity or an unreadable target - hiding the blind spot instead of closing it.
  // The count stays anchors.length: two exhibits assert it exactly (80 and 135). #937
  const pinnedRangeEnds = ranges.filter((range) => Object.hasOwn(declarations, range.endKey))
  const checkEndpoints = [...anchors]
  const seenEndpoint = new Set(anchors.map(({ key }) => key))
  for (const range of pinnedRangeEnds) {
    if (seenEndpoint.has(range.endKey)) continue
    seenEndpoint.add(range.endKey)
    checkEndpoints.push({ doc: range.doc, rel: range.rel, line: range.end, key: range.endKey })
  }
  const cited = new Set(checkEndpoints.map(({ key }) => key))

  for (const anchor of checkEndpoints) {
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

  const invertedSeen = new Set()
  for (const range of ranges) {
    if (range.start <= range.end) continue
    const failure = invertedRangeFailure(range)
    if (invertedSeen.has(failure)) continue
    invertedSeen.add(failure)
    failures.push(failure)
  }

  const namedCitations = named
  const namedSeen = new Set()
  for (const citation of namedCitations) {
    cited.add(citation.key)
    if (namedSeen.has(citation.key)) continue
    namedSeen.add(citation.key)
    const resolved = resolveNamed({ root, manifest: declarations, citation })
    if (resolved.failure) failures.push(resolved.failure)
  }

  for (const key of Object.keys(declarations)) {
    if (!cited.has(key)) failures.push(`${key}: manifest entry is orphaned (no citation)`)
  }

  const result = { anchors: anchors.length, failures, shifted }
  if (namedCitations.length > 0) result.named = namedCitations.length
  return result
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

function rootRelativePath(root, target) {
  let canonicalRoot = root
  let canonicalTarget = target
  try { canonicalRoot = realpathSync(root) } catch {}
  try { canonicalTarget = realpathSync(target) } catch {}
  return relative(canonicalRoot, canonicalTarget).replaceAll('\\', '/')
}

// The lane's own fence, measured: the paths this branch changed against its merge
// base plus anything dirty or untracked. Unmeasurable (no git, no base branch, a
// scratch fixture root) yields an EMPTY fence and a stated reason - a blind spot is
// named, never guessed at.
//
// BLIND SPOT, stated rather than implied: NO LOCAL CHECK CAN PROVE A BASE IS FRESH OR
// THAT IT IS THIS LANE'S ACTUAL BRANCH POINT. A remote-tracking ref is only as current as
// the last fetch, and a lane branched from something other than `base` gets a merge base
// that is an ancestor of both - so the diff, and therefore the fence, is WIDER than the
// lane's own work. This function cannot detect either case without the network, and it
// does not pretend to: it reports the RESOLVED COMMIT it used, so a caller who knows the
// lane's true branch point can pass it explicitly and an auditor can check afterwards
// which commit a repair was measured against. `measured: true` means "this diff was taken
// against the commit named in `baseCommit`", never "that commit is the right one".
export function laneFence({ root, base = 'origin/main', run = defaultRun } = {}) {
  const invoke = (args) => {
    try { return run(args, root) } catch { return null }
  }
  if (typeof root !== 'string' || root.length === 0) return { paths: [], measured: false, reason: 'git root could not be measured', base, baseCommit: null }
  const top = invoke(['rev-parse', '--show-toplevel'])
  if (top === null) return { paths: [], measured: false, reason: 'git root could not be measured', base, baseCommit: null }
  const gitRoot = typeof top === 'string' ? top.trim() : ''
  // `/var` and `/private/var` name the same directory on macOS, and comparing raw strings
  // refused a legitimate repository by spelling alone. Resolve both through the filesystem
  // rather than rewriting the string: blindly stripping a leading `/private/` would make two
  // genuinely DIFFERENT roots compare equal on a host where `/private` is not that alias,
  // admitting a repair in the wrong repository — far worse than the refusal it fixes.
  const sameDirectory = (a, b) => {
    if (a === b) return true
    try { return realpathSync(a) === realpathSync(b) } catch { return false }
  }
  if (!sameDirectory(gitRoot, root)) return { paths: [], measured: false, reason: `git root is ${gitRoot || 'unknown'}, expected ${root}`, base, baseCommit: null }
  const merge = invoke(['merge-base', 'HEAD', base])
  if (typeof merge !== 'string' || merge.trim() === '') return { paths: [], measured: false, reason: `no merge base with ${base}`, base, baseCommit: null }
  const mergeBase = merge.trim()
  const changed = outputPaths(invoke(['diff', '--name-only', mergeBase]))
  if (changed === null) return { paths: [], measured: false, reason: 'changed paths could not be measured', base, baseCommit: mergeBase }
  const untracked = outputPaths(invoke(['ls-files', '--others', '--exclude-standard']))
  if (untracked === null) return { paths: [], measured: false, reason: 'untracked paths could not be measured', base, baseCommit: mergeBase }
  return { paths: [...new Set([...changed, ...untracked])], measured: true, reason: null, base, baseCommit: mergeBase }
}

function shiftLine(shift, skillDir, fenced) {
  const where = fenced ? ' on a file inside this lane\'s fence' : ''
  const mode = fenced ? '--repair' : '--repair-all'
  const when = fenced ? '' : ' after this lane merges, on main'
  return `shifted ${shift.key} -> line ${shift.to}${where}; repair${when} with: node skills/qa-test-writing/anchor-pin.mjs ${mode} ${skillDir}`
}

// Returns the anchor COUNT as a primitive. Both callers assert it under
// node:assert/strict (skills/backend-node/exhibits.test.mjs and
// skills/devops/exhibits.test.mjs) and neither may be edited by the lane that
// made a shift non-fatal, so a boxed or object return would redden two exhibits
// this lane must leave alone. The shifts are reported two other ways instead:
// through `log`, so a shift is never SILENT in a suite run, and through
// checkSkillAnchors for a caller that wants the records themselves.
export function assertAnchorsPinned({ root, skillDir, manifestPath, minAnchors, log = console.warn, fence }) {
  const result = checkSkillAnchors({ root, skillDir, manifestPath })
  const failures = [...result.failures]
  const total = result.anchors + (result.named ?? 0)
  if (total < minAnchors) failures.push(`expected at least ${minAnchors} anchors, found ${total}`)
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
  return total
}

function escapeLiteral(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// A rewrite key is EITHER a single `rel:line` or a whole range literal `rel:start-end`.
// Range alternatives come first so a range binds as one unit, and the single-key
// alternative refuses to bind in front of `-<digits>`: without that guard a single-key
// rewrite reaches into a range and moves the start alone. #937
function isRangeKey(key) { return /:\d+-\d+$/.test(key) }

const NOT_A_LONGER_NUMBER = '(?!\\d)'
const NOT_A_RANGE_START = '(?!-\\d)'

export function rewriteCitations(text, rewrites) {
  if (!(rewrites instanceof Map) || rewrites.size === 0) return text
  const keys = [...rewrites.keys()]
  const rangeKeys = keys.filter((key) => isRangeKey(key))
  const singles = keys.filter((key) => !isRangeKey(key))
  const parts = []
  if (rangeKeys.length > 0) parts.push(`(?:${rangeKeys.map(escapeLiteral).join('|')})${NOT_A_LONGER_NUMBER}`)
  if (singles.length > 0) parts.push(`(?:${singles.map(escapeLiteral).join('|')})${NOT_A_LONGER_NUMBER}${NOT_A_RANGE_START}`)
  const pattern = new RegExp(`(${parts.join('|')})`, 'g')
  return text.replace(pattern, (match) => rewrites.get(match))
}

// The settle loop, unchanged in substance and extracted so an atomic component can be
// withdrawn and the survivors re-settled from a clean occupancy map. Collision is judged
// against LIVE occupancy, so an anchor that vacates a line no longer occupies it. #859, #937
function settleRepairs({ declarations, candidates }) {
  const live = new Map(Object.entries(declarations))
  const repairs = []
  let pending = candidates
  let progress = true
  while (progress && pending.length > 0) {
    progress = false
    const stuck = []
    for (const candidate of pending) {
      if (live.has(candidate.nextKey) && live.get(candidate.nextKey) !== candidate.expected) { stuck.push(candidate); continue }
      live.delete(candidate.key)
      live.set(candidate.nextKey, candidate.expected)
      repairs.push({ key: candidate.key, rel: candidate.rel, from: candidate.from, to: candidate.to, nextKey: candidate.nextKey })
      progress = true
    }
    pending = stuck
  }
  return { repairs, pending }
}

const REPAIR_REASONS = Object.freeze({ rot: 'rot', ambiguous: 'ambiguous', excludedByScope: 'excluded-by-scope' })

function classifiedRepairRefusal(key, reason, detail) {
  return `${key}: ${reason}: ${detail}`
}

export function repairAnchors({ root, docs, manifest, repairAll = false, base }) {
  const repairFence = repairAll
    ? { paths: [], measured: true, reason: null, base: null, baseCommit: null }
    : laneFence({ root, ...(base === undefined ? {} : { base }) })
  const repairPaths = new Set(repairFence.paths)
  let anchors
  let ranges
  let named
  try {
    anchors = collectAnchors({ docs })
    ranges = collectRanges({ docs })
    named = collectNamed({ docs })
  } catch (error) {
    return { anchors: 0, repairs: [], refusals: [`citation docs could not be read (${error?.code || error?.message || String(error)})`], manifest, edits: [], fence: repairFence }
  }
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const cited = new Set(anchors.map(({ key }) => key))
  const refusals = []
  const repairs = []
  const rewrites = new Map()
  const seen = new Set()

  const invertedRefused = new Set()
  const invertedRefusals = []
  for (const range of ranges) {
    if (range.start <= range.end) continue
    const refusal = invertedRangeFailure(range)
    if (invertedRefused.has(refusal)) continue
    invertedRefused.add(refusal)
    invertedRefusals.push(refusal)
  }

  // A range whose END is in no manifest can never be repaired, so its START may not move
  // EITHER: a manifest key is global, and moving it for a standalone citation elsewhere
  // leaves the untouched range start undeclared - the manifest/prose split. The unpinned
  // end is not a manifest key and nothing else is frozen; unrelated keys stay repairable.
  const frozenKeys = new Map()
  const pairs = []
  for (const range of ranges) {
    if (!Object.hasOwn(declarations, range.startKey)) continue
    if (Object.hasOwn(declarations, range.endKey)) { pairs.push(range); continue }
    if (frozenKeys.has(range.startKey)) continue
    frozenKeys.set(range.startKey, `${range.text}: range end ${range.endKey} is in no manifest, so the start cannot move alone; the prose is left untouched`)
  }

  const repairEndpoints = [...anchors]
  const seenEndpoint = new Set(anchors.map(({ key }) => key))
  for (const range of pairs) {
    if (seenEndpoint.has(range.endKey)) continue
    seenEndpoint.add(range.endKey)
    repairEndpoints.push({ doc: range.doc, rel: range.rel, line: range.end, key: range.endKey })
  }
  for (const endpoint of repairEndpoints) cited.add(endpoint.key)

  // PHASE 1 - classify every endpoint BEFORE anything is committed. `moving` is the only
  // state that can become a repair; `refused`, `frozen` and `gated` block a whole component.
  const state = new Map()
  for (const anchor of repairEndpoints) {
    if (seen.has(anchor.key)) continue
    seen.add(anchor.key)
    const { lines, failure } = readTargetLines(root, anchor)
    if (failure) { state.set(anchor.key, { kind: 'refused', why: failure }); continue }
    if (!Object.hasOwn(declarations, anchor.key)) { state.set(anchor.key, { kind: 'refused', why: `${anchor.key}: manifest has no entry` }); continue }
    const expected = declarations[anchor.key]
    if (typeof expected !== 'string' || expected.trim().length < MIN_EXPECTED_LENGTH) {
      state.set(anchor.key, { kind: 'refused', why: `${anchor.key}: expected ${display(expected)} must be at least ${MIN_EXPECTED_LENGTH} non-space characters` })
      continue
    }
    const found = []
    for (let i = 0; i < lines.length; i += 1) if (lineCarries(lines[i], expected)) found.push(i + 1)
    if (found.length === 0) { state.set(anchor.key, { kind: 'refused', why: classifiedRepairRefusal(anchor.key, REPAIR_REASONS.rot, `content appears nowhere in ${anchor.rel}; this is rot, not a shift`) }); continue }
    if (found.length > 1) { state.set(anchor.key, { kind: 'refused', why: classifiedRepairRefusal(anchor.key, REPAIR_REASONS.ambiguous, `content occurs ${found.length} times in ${anchor.rel}; a repair refuses to guess`) }); continue }
    const nextLine = found[0]
    if (nextLine === anchor.line) { state.set(anchor.key, { kind: 'stable' }); continue }
    if (!repairAll && (!repairFence.measured || !repairPaths.has(anchor.rel))) {
      const detail = repairFence.measured
        ? `target path ${anchor.rel} is omitted from the measured repair fence`
        : `repair fence is unmeasured (${repairFence.reason})`
      state.set(anchor.key, { kind: 'gated', why: classifiedRepairRefusal(anchor.key, REPAIR_REASONS.excludedByScope, detail) })
      continue
    }
    if (frozenKeys.has(anchor.key)) { state.set(anchor.key, { kind: 'frozen', why: frozenKeys.get(anchor.key) }); continue }
    state.set(anchor.key, { kind: 'moving', rel: anchor.rel, from: anchor.line, to: nextLine, nextKey: `${anchor.rel}:${nextLine}`, expected })
  }

  if (!repairAll && !repairFence.measured) refusals.push(`anchor repair fence unmeasured (${repairFence.reason})`)

  // Refusals are emitted in ENDPOINT order, which is the order this loop used before, so an
  // existing fixture's refusal list keeps the position it has always had.
  const frozenSeen = new Set()
  for (const [, entry] of state) {
    if (entry.kind === 'refused') refusals.push(entry.why)
    else if (entry.kind === 'frozen' && !frozenSeen.has(entry.why)) { frozenSeen.add(entry.why); refusals.push(entry.why) }
    else if (entry.kind === 'gated') refusals.push(entry.why)
  }

  // PHASE 2 - connected components over both-pinned ranges. An edge joins a range's two
  // endpoint keys; a key in no range has no component and no peer to wait for.
  const component = new Map()
  const members = new Map()
  let componentCount = 0
  const ensureComponent = (key) => {
    if (component.has(key)) return
    componentCount += 1
    component.set(key, componentCount)
    members.set(componentCount, [key])
  }
  const joinComponents = (a, b) => {
    const target = component.get(a)
    const source = component.get(b)
    if (target === source) return
    for (const key of members.get(source)) { component.set(key, target); members.get(target).push(key) }
    members.delete(source)
  }
  for (const range of pairs) {
    ensureComponent(range.startKey)
    ensureComponent(range.endKey)
    joinComponents(range.startKey, range.endKey)
  }

  // PHASE 3 - a component with ANY endpoint that cannot move is committed in full or not at
  // all. Half a component is exactly the manifest/prose split #937 measured.
  const blockedComponents = new Set()
  for (const [key, id] of component) {
    const kind = state.get(key)?.kind
    if (kind === 'refused' || kind === 'frozen' || kind === 'gated') blockedComponents.add(id)
  }

  // PHASE 4 - settle, withdraw any component a collision left half-landed, and settle again
  // from a clean occupancy map. Each pass strictly shrinks the candidate set, so it ends.
  const candidateOf = (key) => {
    const entry = state.get(key)
    return { key, rel: entry.rel, from: entry.from, to: entry.to, nextKey: entry.nextKey, expected: entry.expected }
  }
  const movingKeys = [...state.entries()].filter(([, entry]) => entry.kind === 'moving').map(([key]) => key)
  const collisionRefusals = new Map()
  let admitted = movingKeys.filter((key) => !blockedComponents.has(component.get(key)))
  let settled = { repairs: [], pending: [] }
  for (;;) {
    settled = settleRepairs({ declarations, candidates: admitted.map(candidateOf) })
    const withdrawing = new Set()
    for (const candidate of settled.pending) {
      const id = component.get(candidate.key)
      if (id === undefined || blockedComponents.has(id)) continue
      withdrawing.add(id)
      collisionRefusals.set(candidate.key, `${candidate.key}: line ${candidate.to} is already declared by another anchor`)
    }
    if (withdrawing.size === 0) break
    for (const id of withdrawing) blockedComponents.add(id)
    admitted = admitted.filter((key) => !blockedComponents.has(component.get(key)))
  }
  repairs.push(...settled.repairs)
  for (const candidate of settled.pending) refusals.push(`${candidate.key}: line ${candidate.to} is already declared by another anchor`)
  for (const [, refusal] of collisionRefusals) refusals.push(refusal)

  // A key that could have moved but did not, because a peer could not, must say so: silence
  // is what this whole issue is about.
  const withheldSeen = new Set()
  for (const key of movingKeys) {
    const id = component.get(key)
    if (id === undefined || !blockedComponents.has(id)) continue
    const refusal = `${key}: withheld because a peer endpoint of the same range citation cannot move; a range is repaired whole or not at all`
    if (withheldSeen.has(refusal)) continue
    withheldSeen.add(refusal)
    refusals.push(refusal)
  }
  for (const refusal of invertedRefusals) refusals.push(refusal)

  for (const repair of repairs) rewrites.set(repair.key, repair.nextKey)

  // The range literal is rewritten from the SETTLED key map, so a pair whose endpoints moved
  // by different amounts still lands on two lines that each carry their pinned content. A
  // repaired pair that inverts is written truthfully and reported, never silently
  // straightened: both numbers are facts about the code.
  const moved = new Map(repairs.map((repair) => [repair.key, repair.nextKey]))
  const lineOf = (key) => Number(key.slice(key.lastIndexOf(':') + 1))
  for (const range of pairs) {
    if (blockedComponents.has(component.get(range.startKey))) continue
    const nextStart = lineOf(moved.get(range.startKey) || range.startKey)
    const nextEnd = lineOf(moved.get(range.endKey) || range.endKey)
    const nextText = `${range.rel}:${nextStart}-${nextEnd}`
    if (nextText === range.text) continue
    rewrites.set(range.text, nextText)
    if (nextStart > nextEnd) refusals.push(invertedRangeFailure({ text: nextText, start: nextStart, end: nextEnd, doc: range.doc }))
  }

  // A named pin can never be repaired, but it can still ROT or become AMBIGUOUS, and repair has
  // always refused both (:376-377). Marking it cited without resolving it would make
  // --repair-all accept a name the exhibits test rejects. #971
  const namedSeen = new Set()
  for (const citation of named) {
    cited.add(citation.key)
    if (namedSeen.has(citation.key)) continue
    namedSeen.add(citation.key)
    const resolved = resolveNamed({ root, manifest: declarations, citation })
    if (resolved.failure) refusals.push(resolved.failure)
  }

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

  return { anchors: anchors.length, repairs, refusals, manifest: next, edits, fence: repairFence }
}

export function repairAnchorsInPlace({ root, skillDir, manifestPath, repairAll = false, base }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { anchors: 0, repairs: [], refusals: [`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`], manifest: {}, edits: [] }
  }
  const result = repairAnchors({ root, docs: skillDocs(skillDir), manifest, repairAll, base })
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
  // The caller may KNOW this lane's branch point — the driver records a resolved HEAD at
  // run-start and arm worktrees are cut from a resolved pin — and a known commit beats any
  // ref this tool could guess at. Absent, it falls back to the default remote-tracking ref
  // with the honesty limits stated on `laneFence`.
  let base
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') { base = argv[i + 1]; i += 1; continue }
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
  const manifestPath = join(skillDir, 'anchors.json')
  const result = repairAnchorsInPlace({ root, skillDir, manifestPath, repairAll, base })
  for (const repair of result.repairs) {
    const row = {
      manifest: rootRelativePath(root, manifestPath),
      pin: repair.key,
      old_line: repair.from,
      new_line: repair.to,
      base: result.fence.base,
      base_commit: result.fence.baseCommit ?? null,
    }
    log(`ANCHOR_REPAIR_ROW ${JSON.stringify(row)}`)
  }
  for (const refusal of result.refusals) log(`refused ${refusal}`)
  return result.refusals.length > 0 ? 1 : 0
}

// The third carrier (#918). A pinned KEY is a line number and a line number moves; the
// manifest's VALUE is the content, and a repair preserves it verbatim. A carrier that
// resolves the key from the content is therefore immune to every shift --repair-all makes.
export function pinnedKey({ manifestPath, expected }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`)
  }
  const keys = Object.entries(manifest).filter(([, value]) => value === expected).map(([key]) => key)
  if (keys.length !== 1) throw new Error(`${manifestPath}: expected exactly one entry carrying ${JSON.stringify(expected)}, found ${keys.length}`)
  return keys[0]
}

export function anchorManifestDirs(root) {
  const found = []
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && entry.name === 'anchors.json')) found.push(dir)
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') visit(join(dir, entry.name))
    }
  }
  visit(root)
  return found.sort()
}

export const EXTRA_CITATION_CARRIERS = Object.freeze(['test/review-procedure-loader.test.mjs'])

// Stated blind spot: the scan covers the carrier SET only, and reports a literal that is
// a CURRENTLY pinned key. A hardcoded literal in a test outside the set is invisible, and
// so is one whose key a merge has already invalidated - by then the test is simply red.
export const PINNED_LITERAL_BLIND_SPOT = 'scanned carriers only, and only a literal equal to a currently pinned key'

export function citationCarrierTests(root) {
  const found = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') visit(path)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  const skills = join(root, 'skills')
  if (existsSync(skills) && statSync(skills).isDirectory()) visit(skills)
  for (const extra of EXTRA_CITATION_CARRIERS) if (existsSync(join(root, extra))) found.push(extra)
  return [...new Set(found)].sort()
}

export function pinnedLiteralsInTests({ root, files = citationCarrierTests(root), manifestDirs = anchorManifestDirs(root) }) {
  const pinned = new Map()
  for (const dir of manifestDirs) {
    const manifestPath = join(dir, 'anchors.json')
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue
    for (const key of Object.keys(manifest)) if (!pinned.has(key)) pinned.set(key, relative(root, manifestPath).replaceAll('\\', '/'))
  }
  const rows = []
  for (const file of files) {
    let lines
    try { lines = readFileSync(join(root, file), 'utf8').split('\n') } catch { continue }
    for (const [index, text] of lines.entries()) {
      for (const [, rel, number] of text.matchAll(new RegExp(ANCHOR_PATTERN, 'g'))) {
        if (!ANCHOR_ROOTS.includes(rel.split('/')[0])) continue
        const key = `${rel}:${number}`
        if (pinned.has(key)) rows.push({ file, line: index + 1, key, manifest: pinned.get(key) })
      }
    }
  }
  return { rows, keys: pinned.size, files, blindSpot: PINNED_LITERAL_BLIND_SPOT }
}

if (import.meta.main) process.exit(repairCli(process.argv.slice(2)))
