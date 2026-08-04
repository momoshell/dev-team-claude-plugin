import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const DEFAULT_GLOBS = [
  'package-lock.json',
  '*.lock',
  'yarn.lock',
  'pnpm-lock.yaml',
  'vendor/**',
  'node_modules/**',
  '*.min.*',
  '*.generated.*',
  'dist/**',
  'build/**',
]

const noiseGlobsRaw = readFileSync(join(ROOT, 'scripts', 'noise-globs.json'), 'utf8')
const noiseGlobs = JSON.parse(noiseGlobsRaw)

const qaGateMd = readFileSync(join(ROOT, 'references', 'qa-gate.md'), 'utf8')
const handoverSpecMd = readFileSync(join(ROOT, 'handover-spec.md'), 'utf8')

// Extracts the text of a markdown section from an exact `## <heading>` line
// to the next line starting with `##` (or EOF). Throws when the heading is
// not found so a missing/renamed section fails loudly instead of every
// downstream negative assertion passing vacuously against empty text.
function extractSection(markdown, headingLine) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l === headingLine)
  if (start === -1) {
    throw new Error(`heading not found: ${JSON.stringify(headingLine)}`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// --- 1. shape ---
test('noise-globs.json: top level is a plain object with exactly the key "globs"', () => {
  assert.equal(typeof noiseGlobs, 'object')
  assert.ok(noiseGlobs !== null)
  assert.deepEqual(Object.keys(noiseGlobs), ['globs'])
})

// --- 2. contents well-formed ---
test('noise-globs.json: globs is a non-empty array of unique non-empty strings', () => {
  assert.ok(Array.isArray(noiseGlobs.globs))
  assert.ok(noiseGlobs.globs.length > 0)
  for (const g of noiseGlobs.globs) {
    assert.equal(typeof g, 'string')
    assert.ok(g.length > 0)
  }
  assert.equal(new Set(noiseGlobs.globs).size, noiseGlobs.globs.length)
})

// --- 3. pins the shipped list ---
test('noise-globs.json: pins the ten shipped defaults', () => {
  assert.deepEqual([...noiseGlobs.globs].sort(), [...DEFAULT_GLOBS].sort())
})

const SCOPE_HEADING = "## Scope compliance is verified by git, not the coder's self-report"
const NOISE_HEADING = '## Noise filtering — what the reviewer bundle and cmux diff leave out'

// --- 4. section extractor control ---
test('section extractor: finds the scope-compliance section and contains its positive marker', () => {
  const section = extractSection(qaGateMd, SCOPE_HEADING)
  assert.ok(section.length > 0)
  assert.match(section, /git status --porcelain/)
})

test('section extractor: throws on a bogus heading', () => {
  assert.throws(() => extractSection(qaGateMd, '## this heading does not exist anywhere'))
})

// --- 5-10. noise section content ---
test('qa-gate.md: noise section exists and names the shared definition file', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/noise-globs\.json/)
})

test('qa-gate.md: noise section shows :! pathspec composition', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /:!/)
})

test('qa-gate.md: noise section mentions noise_globs: and states it extends the defaults', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /noise_globs:/)
  assert.match(section, /extends?/i)
})

test('qa-gate.md: noise section names both read points (reviewer bundle, cmux diff)', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /reviewer bundle/i)
  assert.match(section, /cmux diff/i)
})

test('qa-gate.md: noise section states the suppression rule and mentions files_in_scope', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /[Ss]uppression/)
  assert.match(section, /files_in_scope/)
})

test('qa-gate.md: noise section states the header requirement (excluded paths + count)', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  assert.match(section, /excluded/i)
  assert.match(section, /count/i)
})

// --- 11. negative, load-bearing ---
test('qa-gate.md: scope-compliance section stays unfiltered (no :! and no noise-globs)', () => {
  const section = extractSection(qaGateMd, SCOPE_HEADING)
  // Positive control re-asserted here so this negative can never run against
  // an empty/misnamed section.
  assert.match(section, /git status --porcelain/)
  assert.doesNotMatch(section, /:!/)
  assert.doesNotMatch(section, /noise-globs/)
})

// --- 12. single-source guard ---
// Counts ':!' occurrences across the whole noise section (not just fenced
// blocks) so the node-fallback example — which composes ':!' the same way
// but may not sit inside its own fence — is guarded too. The composition
// itself may appear more than once *inside* the noise section (jq form +
// node fallback); what must never happen is it reappearing anywhere else
// in the file (e.g. restated in "The human patch view (cmux diff)").
test('qa-gate.md: the :! pathspec composition lives only in the noise section, nowhere else in the file', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  const sectionStart = qaGateMd.indexOf(section)
  assert.ok(sectionStart !== -1)
  const before = qaGateMd.slice(0, sectionStart)
  const after = qaGateMd.slice(sectionStart + section.length)
  assert.ok(section.includes(':!'), 'sanity: the noise section itself must show the composition')
  assert.ok(!before.includes(':!'), 'the :! composition must not appear before the noise section')
  assert.ok(!after.includes(':!'), 'the :! composition must not appear after the noise section (e.g. restated in the cmux diff section)')
})

// --- 13. doc<->data drift guard ---
// Matches glob-shaped tokens as prose examples (extension globs like *.min.*
// or *.lock, directory globs like node_modules/**) without tripping on
// markdown bold-lead-in asterisks.
const GLOB_LOOKING = /\*\.[\w]+\.\*|[\w.-]+\/\*\*|\*\.[\w]+\b/g

test('qa-gate.md: every glob-looking example quoted in the noise section is a real shipped glob', () => {
  const section = extractSection(qaGateMd, NOISE_HEADING)
  const globSet = new Set(noiseGlobs.globs)
  const examples = [...section.matchAll(GLOB_LOOKING)].map((m) => m[0])
  assert.ok(examples.length > 0, 'expected the section to quote at least one shipped glob as an example')
  for (const example of examples) {
    assert.ok(globSet.has(example), `quoted glob ${JSON.stringify(example)} is not in scripts/noise-globs.json`)
  }
})

// --- 14. handover-spec.md self-check bullet ---
test('handover-spec.md: Self-check section has a bullet covering discovery_context + files_in_scope + noise', () => {
  const section = extractSection(handoverSpecMd, '## Self-check (before emitting)')
  assert.ok(section.length > 0)
  const bulletLine = section
    .split('\n')
    .find((l) => l.includes('discovery_context') && l.includes('files_in_scope') && /noise/i.test(l))
  assert.ok(bulletLine, 'expected a self-check bullet mentioning discovery_context, files_in_scope, and noise together')
})
