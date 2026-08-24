import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertAnchorsPinned, checkAnchors, MIN_EXPECTED_LENGTH, repairAnchorsInPlace, repairCli } from './anchor-pin.mjs'

const EXPECTED = "KEY = 'anchored-sentinel-value'"

function fixture({ source = ['// header', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''], line = 2, cite = `crew/sample.mjs:${line}`, manifest = { 'crew/sample.mjs:2': EXPECTED } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'b177-anchor-pin-'))
  mkdirSync(join(root, 'crew'), { recursive: true })
  writeFileSync(join(root, 'crew/sample.mjs'), source.join('\n'))
  const skillDir = join(root, 'skills/sample')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  const doc = join(skillDir, 'SKILL.md')
  writeFileSync(doc, `# sample\n\nExhibit: \`${cite}\`.\n`)
  const manifestPath = join(skillDir, 'anchors.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { root, skillDir, doc, manifestPath, manifest }
}

function dispose(fx) {
  rmSync(fx.root, { recursive: true, force: true })
}

function bytes(fx) {
  return `${readFileSync(fx.manifestPath, 'utf8')}\0${readFileSync(fx.doc, 'utf8')}`
}

test('a correct fixture anchor passes and counts one citation', () => {
  // Mutation killed: changing the fixture line or its declared substring must redden this content pin.
  const fx = fixture()
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result, { anchors: 1, failures: [] })
  } finally {
    dispose(fx)
  }
})

test('inserting a line above an anchor reports the new location', () => {
  // Mutation killed: making lineCarries unconditional recreates the old range-only pin and makes this pass.
  const fx = fixture()
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''].join('\n'))
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /crew\/sample\.mjs:2/)
    assert.match(result.failures[0], /the text is now at line 3/)
  } finally {
    dispose(fx)
  }
})

test('an anchor without a manifest entry fails', () => {
  // Mutation killed: skipping an undeclared citation would let prose drift without an authoring decision.
  const fx = fixture({ manifest: {} })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /manifest has no entry/)
  } finally {
    dispose(fx)
  }
})

test('a manifest key with no citation fails as an orphan', () => {
  // Mutation killed: accepting dead declarations would let an unused expectation hide stale documentation.
  const fx = fixture({ manifest: { 'crew/sample.mjs:2': EXPECTED, 'crew/sample.mjs:4': 'export default KEY' } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /crew\/sample\.mjs:4.*orphaned/)
  } finally {
    dispose(fx)
  }
})

test('a short expected substring is refused', () => {
  // Mutation killed: removing the minimum length leaves a generic one-word expectation accepted.
  const fx = fixture({ line: 3, manifest: { 'crew/sample.mjs:3': 'other' } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.ok(MIN_EXPECTED_LENGTH > 'other'.length)
    assert.match(result.failures.join('\n'), /at least 12/)
  } finally {
    dispose(fx)
  }
})

test('a repeated expected substring is refused', () => {
  // Mutation killed: dropping the occurrence check makes one substring claim two different source lines.
  const source = ['const duplicated = 1', 'const duplicated = 1', '']
  const fx = fixture({ source, line: 1, manifest: { 'crew/sample.mjs:1': 'const duplicated = 1' } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /exactly one target line/)
  } finally {
    dispose(fx)
  }
})

test('a missing target and an out-of-range line both fail', () => {
  // Mutation killed: deleting either existence or range validation restores the old pin's missing edge.
  const missing = fixture({ line: 2, manifest: { 'crew/missing.mjs:2': EXPECTED } })
  const outOfRange = fixture({ line: 99, manifest: { 'crew/sample.mjs:99': EXPECTED } })
  try {
    writeFileSync(missing.doc, '# sample\n\nExhibit: `crew/missing.mjs:2`.\n')
    writeFileSync(outOfRange.doc, '# sample\n\nExhibit: `crew/sample.mjs:99`.\n')
    const missingResult = checkAnchors({ root: missing.root, docs: [missing.doc], manifest: missing.manifest })
    const rangeResult = checkAnchors({ root: outOfRange.root, docs: [outOfRange.doc], manifest: outOfRange.manifest })
    assert.match(missingResult.failures.join('\n'), /target file is missing/)
    assert.match(rangeResult.failures.join('\n'), /line is out of range/)
  } finally {
    dispose(missing)
    dispose(outOfRange)
  }
})

test('assertAnchorsPinned enforces the no-deletion floor', () => {
  // Mutation killed: removing the minAnchors check lets a manifest with no counted citations pass.
  const fx = fixture()
  try {
    assert.throws(
      () => assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 2 }),
      /expected at least 2 anchors, found 1/,
    )
    assert.equal(readFileSync(fx.manifestPath, 'utf8').includes(EXPECTED), true)
  } finally {
    dispose(fx)
  }
})

test('repair moves a drifted anchor to the line the content now occupies', () => {
  // Mutation killed: deriving the repaired key from the stale line leaves the manifest and prose drifting.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  try {
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    const doc = readFileSync(fx.doc, 'utf8')
    assert.equal(result.repairs.length, 1)
    assert.deepEqual(result.refusals, [])
    assert.equal(manifest['crew/sample.mjs:3'], EXPECTED)
    assert.equal(Object.hasOwn(manifest, 'crew/sample.mjs:2'), false)
    assert.equal(doc.includes('crew/sample.mjs:3'), true)
    assert.equal(doc.includes('crew/sample.mjs:2'), false)
    assert.deepEqual(checkAnchors({ root: fx.root, docs: [fx.doc], manifest }), { anchors: 1, failures: [] })
  } finally {
    dispose(fx)
  }
})

test('repair refuses content that occurs more than once', () => {
  // Mutation killed: raising the ambiguity guard lets repair guess the first matching line.
  const source = ['const duplicated-sentinel = 1', 'const duplicated-sentinel = 1', '// tail', '']
  const fx = fixture({ source, cite: 'crew/sample.mjs:3', manifest: { 'crew/sample.mjs:3': 'const duplicated-sentinel = 1' } })
  const before = bytes(fx)
  try {
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.match(result.refusals.join('\n'), /refuses to guess/)
    assert.deepEqual(result.repairs, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair refuses content that appears nowhere', () => {
  // Mutation killed: moving the rot guard out of reach silently assigns an invented line.
  const fx = fixture({ manifest: { 'crew/sample.mjs:2': 'a-sentinel-that-is-absent-entirely' } })
  const before = bytes(fx)
  try {
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.match(result.refusals.join('\n'), /rot, not a shift/)
    assert.deepEqual(result.repairs, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair refuses a target it cannot read', () => {
  // Mutation killed: dropping the unreadable-target refusal reports a missing target as clean.
  const fx = fixture({ cite: 'crew/missing.mjs:2', manifest: { 'crew/missing.mjs:2': EXPECTED } })
  try {
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.match(result.refusals.join('\n'), /target file is missing/)
    assert.deepEqual(result.repairs, [])
  } finally {
    dispose(fx)
  }
})

test('repair is a no-op when nothing moved', () => {
  // Mutation killed: recording an already-correct anchor as repaired causes an unnecessary write.
  const fx = fixture()
  const before = bytes(fx)
  try {
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.deepEqual(result.repairs, [])
    assert.deepEqual(result.refusals, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair is idempotent when it runs twice', () => {
  // Mutation killed: retaining the stale manifest key creates an orphan on the second run.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  try {
    const first = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.equal(first.repairs.length, 1)
    const afterFirst = bytes(fx)
    const second = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath })
    assert.deepEqual(second.repairs, [])
    assert.deepEqual(second.refusals, [])
    assert.equal(bytes(fx), afterFirst)
  } finally {
    dispose(fx)
  }
})

test('the CLI repairs a skill directory and exits non-zero on refusal', () => {
  // Mutation killed: changing repairCli's clean, refusal, or usage status breaks this in-process contract.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const output = []
  try {
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['const duplicated-sentinel = 1', 'const duplicated-sentinel = 1', '// tail', ''].join('\n'))
    writeFileSync(fx.doc, '# sample\n\nExhibit: `crew/sample.mjs:3`.\n')
    writeFileSync(fx.manifestPath, JSON.stringify({ 'crew/sample.mjs:3': 'const duplicated-sentinel = 1' }, null, 2))
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.equal(repairCli([], output.push.bind(output)), 2)
    assert.equal(repairCli(['--repair', fx.skillDir, '--root'], output.push.bind(output)), 2)
  } finally {
    dispose(fx)
  }
})

test('checking never rewrites the manifest or the doc', () => {
  // Mutation killed: delegating checking to repair would erase the drift CI must report.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const before = bytes(fx)
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /the text is now at line 3/)
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})
