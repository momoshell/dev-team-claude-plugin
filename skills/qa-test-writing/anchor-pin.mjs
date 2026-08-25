// Content pins for prose citations; see references/citations.md and vacuity.md's detector-key section.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export function skillDocs(skillDir) {
  const docs = []
  const skill = join(skillDir, 'SKILL.md')
  if (existsSync(skill) && !statSync(skill).isDirectory()) docs.push(skill)
  const refs = join(skillDir, 'references')
  if (existsSync(refs) && !statSync(refs).isDirectory()) return docs
  if (existsSync(refs)) {
    for (const name of readdirSync(refs).sort()) {
      const path = join(refs, name)
      if (name.endsWith('.md') && !statSync(path).isDirectory()) docs.push(path)
    }
  }
  return docs
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

// Returns the anchor COUNT as a primitive. Both callers assert it under
// node:assert/strict (skills/backend-node/exhibits.test.mjs:52 and
// skills/devops/exhibits.test.mjs:53) and neither may be edited by the lane that
// made a shift non-fatal, so a boxed or object return would redden two exhibits
// this lane must leave alone. The shifts are reported two other ways instead:
// through `log`, so a shift is never SILENT in a suite run, and through
// checkSkillAnchors for a caller that wants the records themselves.
export function assertAnchorsPinned({ root, skillDir, manifestPath, minAnchors, log = console.warn }) {
  const result = checkSkillAnchors({ root, skillDir, manifestPath })
  const failures = [...result.failures]
  if (result.anchors < minAnchors) failures.push(`expected at least ${minAnchors} anchors, found ${result.anchors}`)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  for (const shift of result.shifted) log(`shifted ${shift.key} -> line ${shift.to}; repair with: node skills/qa-test-writing/anchor-pin.mjs --repair ${skillDir}`)
  return result.anchors
}

function escapeLiteral(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function rewriteCitations(text, rewrites) {
  if (!(rewrites instanceof Map) || rewrites.size === 0) return text
  const pattern = new RegExp(`(${[...rewrites.keys()].map(escapeLiteral).join('|')})(?!\\d)`, 'g')
  return text.replace(pattern, (match) => rewrites.get(match))
}

export function repairAnchors({ root, docs, manifest }) {
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

  for (const anchor of anchors) {
    if (rewrites.has(anchor.key)) continue
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
    if (Object.hasOwn(declarations, nextKey) && declarations[nextKey] !== expected) {
      refusals.push(`${anchor.key}: line ${nextLine} is already declared by another anchor`)
      continue
    }
    rewrites.set(anchor.key, nextKey)
    repairs.push({ key: anchor.key, rel: anchor.rel, from: anchor.line, to: nextLine, nextKey })
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

  return { anchors: anchors.length, repairs, refusals, manifest: next, edits }
}

export function repairAnchorsInPlace({ root, skillDir, manifestPath }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { anchors: 0, repairs: [], refusals: [`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`], manifest: {}, edits: [] }
  }
  const result = repairAnchors({ root, docs: skillDocs(skillDir), manifest })
  if (result.repairs.length > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`)
    for (const edit of result.edits) writeFileSync(edit.doc, edit.text)
  }
  return result
}

export function repairCli(argv, log = console.log) {
  let skillDir = null
  let root = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repair') { skillDir = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--root') { root = argv[i + 1]; i += 1; continue }
    log(`unknown argument ${argv[i]}`)
    return 2
  }
  if (!skillDir || !root) {
    log('usage: node skills/qa-test-writing/anchor-pin.mjs --repair <skillDir> [--root <root>]')
    return 2
  }
  const result = repairAnchorsInPlace({ root, skillDir, manifestPath: join(skillDir, 'anchors.json') })
  for (const repair of result.repairs) log(`repaired ${repair.key} -> ${repair.nextKey}`)
  for (const refusal of result.refusals) log(`refused ${refusal}`)
  return result.refusals.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(repairCli(process.argv.slice(2)))
