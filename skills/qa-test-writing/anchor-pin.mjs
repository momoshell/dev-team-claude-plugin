// Content pins for prose citations; see references/citations.md and vacuity.md's detector-key section.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

export function checkAnchors({ root, docs, manifest }) {
  let anchors
  try {
    anchors = collectAnchors({ docs })
  } catch (error) {
    return { anchors: 0, failures: [`citation docs could not be read (${error?.code || error?.message || String(error)})`] }
  }
  const failures = []
  const declarations = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const cited = new Set(anchors.map(({ key }) => key))

  for (const anchor of anchors) {
    const target = join(root, anchor.rel)
    let lines
    try {
      if (!existsSync(target)) {
        failures.push(`${anchor.key}: target file is missing`)
        continue
      }
      if (statSync(target).isDirectory()) {
        failures.push(`${anchor.key}: target is a directory`)
        continue
      }
      lines = readFileSync(target, 'utf8').split('\n')
    } catch (error) {
      failures.push(`${anchor.key}: target could not be read (${error?.code || error?.message || String(error)})`)
      continue
    }

    if (anchor.line < 1 || anchor.line > lines.length) {
      failures.push(`${anchor.key}: line is out of range (target has ${lines.length} lines)`)
      continue
    }
    if (!Object.hasOwn(declarations, anchor.key)) {
      failures.push(`${anchor.key}: manifest has no entry`)
      continue
    }
    const expected = declarations[anchor.key]
    if (!isDistinctive(lines, expected)) {
      failures.push(`${anchor.key}: expected ${display(expected)} must be at least ${MIN_EXPECTED_LENGTH} non-space characters and occur on exactly one target line`)
      continue
    }
    const current = lines[anchor.line - 1]
    if (!lineCarries(current, expected)) {
      const moved = lines.findIndex((line) => lineCarries(line, expected))
      const movedAt = moved === -1 ? 'unknown' : moved + 1
      failures.push(`expected ${display(expected)} at ${anchor.key}, found ${display(current)}; the text is now at line ${movedAt}`)
    }
  }

  for (const key of Object.keys(declarations)) {
    if (!cited.has(key)) failures.push(`${key}: manifest entry is orphaned (no citation)`)
  }

  return { anchors: anchors.length, failures }
}

export function assertAnchorsPinned({ root, skillDir, manifestPath, minAnchors }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read anchor manifest ${manifestPath}: ${error?.message || String(error)}`)
  }
  const result = checkAnchors({ root, docs: skillDocs(skillDir), manifest })
  const failures = [...result.failures]
  if (result.anchors < minAnchors) failures.push(`expected at least ${minAnchors} anchors, found ${result.anchors}`)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  return result.anchors
}
