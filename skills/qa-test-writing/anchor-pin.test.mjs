import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { ROOT, git, scratchDir } from '../../test/helpers.mjs'
import { anchorManifestDirs, assertAnchorsPinned, checkAnchors, checkSkillAnchors, citationCarrierTests, laneFence, MIN_EXPECTED_LENGTH, partitionShifts, pinnedKey, pinnedLiteralsInTests, repairAnchorsInPlace, repairCli, skillDocs, PINNED_LITERAL_BLIND_SPOT } from './anchor-pin.mjs'

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

function plainFixture(options = {}) {
  const fx = fixture(options)
  const { root } = fx
  const { line = 2, cite = `crew/sample.mjs:${line}`, manifest = { 'crew/sample.mjs:2': EXPECTED } } = options
  const plainDir = join(root, 'plain')
  mkdirSync(plainDir, { recursive: true })
  const doc = join(plainDir, 'notes.md')
  writeFileSync(doc, `# sample\n\nExhibit: \`${cite}\`.\n`)
  const manifestPath = join(plainDir, 'anchors.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return { root, plainDir, doc, manifestPath, manifest }
}

function dispose(fx) {
  rmSync(fx.root, { recursive: true, force: true })
}

function bytes(fx) {
  return `${readFileSync(fx.manifestPath, 'utf8')}\0${readFileSync(fx.doc, 'utf8')}`
}

test('skillDocs finds the markdown of a directory that is not a skill', () => {
  // Mutation killed: removing the plain-directory fallback would silently return no docs.
  const plain = plainFixture()
  const skill = fixture()
  try {
    assert.deepEqual(skillDocs(plain.plainDir), [plain.doc])
    assert.deepEqual(skillDocs(skill.skillDir), [skill.doc])
  } finally {
    dispose(plain)
    dispose(skill)
  }
})

test('the CLI repairs a plain directory whose pin moved by one line', () => {
  // Mutation killed: keeping skill-only discovery leaves a moved plain-directory pin unrepaired.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = plainFixture({ source })
  const output = []
  try {
    assert.equal(repairCli(['--repair', fx.plainDir, '--root', fx.root], output.push.bind(output)), 0)
    assert.ok(output.includes('repaired crew/sample.mjs:2 -> crew/sample.mjs:3'))
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    const doc = readFileSync(fx.doc, 'utf8')
    assert.equal(manifest['crew/sample.mjs:3'], EXPECTED)
    assert.equal(Object.hasOwn(manifest, 'crew/sample.mjs:2'), false)
    assert.equal(doc.includes('crew/sample.mjs:3'), true)
    assert.equal(doc.includes('crew/sample.mjs:2'), false)
  } finally {
    dispose(fx)
  }
})

test('a plain directory refuses rot exactly as a skill does', () => {
  // Mutation killed: dropping the rot refusal would make a plain directory look repaired.
  const fx = plainFixture({ manifest: { 'crew/sample.mjs:2': 'a-sentinel-that-is-absent-entirely' } })
  const output = []
  const before = bytes(fx)
  try {
    assert.equal(repairCli(['--repair', fx.plainDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.match(output.join('\n'), /rot, not a shift/)
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('a plain directory refuses ambiguity exactly as a skill does', () => {
  // Mutation killed: dropping the ambiguity refusal would let repair guess between two lines.
  const source = ['const duplicated-sentinel = 1', 'const duplicated-sentinel = 1', '// tail', '']
  const fx = plainFixture({ source, line: 3, manifest: { 'crew/sample.mjs:3': 'const duplicated-sentinel = 1' } })
  const output = []
  const before = bytes(fx)
  try {
    assert.equal(repairCli(['--repair', fx.plainDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.match(output.join('\n'), /refuses to guess/)
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('a correct fixture anchor passes and counts one citation', () => {
  // Mutation killed: changing the fixture line or its declared substring must redden this content pin.
  const fx = fixture()
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result, { anchors: 1, failures: [], shifted: [] })
  } finally {
    dispose(fx)
  }
})

test('inserting a line above an anchor reports a shift without a failure', () => {
  // Mutation killed: making lineCarries unconditional recreates the old range-only pin and makes this pass.
  const fx = fixture()
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''].join('\n'))
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.shifted, [{ key: 'crew/sample.mjs:2', rel: 'crew/sample.mjs', from: 2, to: 3, nextKey: 'crew/sample.mjs:3' }])
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
    assert.deepEqual(result.shifted, [])
  } finally {
    dispose(fx)
  }
})

test('a citation shifted five lines down is reported with both line numbers', () => {
  // Mutation killed: reporting only the destination would leave repair without the stale citation key.
  const source = ['// header', '// one', '// two', '// three', '// four', '// five', `const ${EXPECTED}`, 'export default KEY', '']
  const fx = fixture({ source })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.shifted, [{ key: 'crew/sample.mjs:2', rel: 'crew/sample.mjs', from: 2, to: 7, nextKey: 'crew/sample.mjs:7' }])
  } finally {
    dispose(fx)
  }
})

test('content that appears nowhere is rot and stays a hard failure', () => {
  // Mutation killed: swallowing the distinctiveness failure would misclassify rot as a repairable shift.
  const fx = fixture({ manifest: { 'crew/sample.mjs:2': 'a-sentinel-that-is-absent-entirely' } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /occur on exactly one target line/)
    assert.deepEqual(result.shifted, [])
  } finally {
    dispose(fx)
  }
})

test('content on two target lines is ambiguous and stays a hard failure', () => {
  // Mutation killed: accepting duplicate content would make a repair guess between two possible destinations.
  const source = ['// header', `const ${EXPECTED}`, '// three', '// four', `const ${EXPECTED}`, '']
  const fx = fixture({ source })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /occur on exactly one target line/)
    assert.deepEqual(result.shifted, [])
  } finally {
    dispose(fx)
  }
})

test('a missing target fails but an out-of-range citation shifts when content is found', () => {
  // Mutation killed: deleting target validation or treating a past-EOF citation as fatal loses one of the two outcomes.
  const missing = fixture({ line: 2, manifest: { 'crew/missing.mjs:2': EXPECTED } })
  const outOfRange = fixture({ line: 99, manifest: { 'crew/sample.mjs:99': EXPECTED } })
  try {
    writeFileSync(missing.doc, '# sample\n\nExhibit: `crew/missing.mjs:2`.\n')
    writeFileSync(outOfRange.doc, '# sample\n\nExhibit: `crew/sample.mjs:99`.\n')
    const missingResult = checkAnchors({ root: missing.root, docs: [missing.doc], manifest: missing.manifest })
    const rangeResult = checkAnchors({ root: outOfRange.root, docs: [outOfRange.doc], manifest: outOfRange.manifest })
    assert.match(missingResult.failures.join('\n'), /target file is missing/)
    assert.deepEqual(rangeResult.failures, [])
    assert.equal(rangeResult.shifted.length, 1)
    assert.equal(rangeResult.shifted[0].from, 99)
    assert.equal(rangeResult.shifted[0].to, 2)
  } finally {
    dispose(missing)
    dispose(outOfRange)
  }
})

test('a past-EOF citation with rotted content remains a hard failure', () => {
  // Mutation killed: removing the content gate lets an out-of-range citation hide rot.
  const fx = fixture({ line: 99, manifest: { 'crew/sample.mjs:99': 'a-sentinel-that-is-absent-entirely' } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.match(result.failures.join('\n'), /occur on exactly one target line/)
    assert.deepEqual(result.shifted, [])
  } finally {
    dispose(fx)
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

test('assertAnchorsPinned reports a shift, returns the primitive count, and does not throw', () => {
  // Mutation killed: dropping the injected log call makes a tolerated shift silent to the caller.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const captured = []
  try {
    const count = assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, log: (line) => captured.push(line) })
    assert.equal(count, 1)
    assert.equal(captured.length, 1)
    assert.match(captured[0], /crew\/sample\.mjs:2/)
    assert.match(captured[0], /line 3/)
  } finally {
    dispose(fx)
  }
})

test('assertAnchorsPinned still throws when content is rotted', () => {
  // Mutation killed: replacing the distinctiveness guard with a shift branch would make rot pass.
  const fx = fixture({ manifest: { 'crew/sample.mjs:2': 'a-sentinel-that-is-absent-entirely' } })
  try {
    assert.throws(
      () => assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, log: () => {} }),
      /occur on exactly one target line/,
    )
  } finally {
    dispose(fx)
  }
})

test('checkSkillAnchors returns shift records and preserves unreadable-manifest errors', () => {
  // Mutation killed: bypassing checkSkillAnchors or changing its parse error hides the full check record and its edge failure.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  try {
    assert.deepEqual(
      checkSkillAnchors({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath }),
      { anchors: 1, failures: [], shifted: [{ key: 'crew/sample.mjs:2', rel: 'crew/sample.mjs', from: 2, to: 3, nextKey: 'crew/sample.mjs:3' }] },
    )
    writeFileSync(fx.manifestPath, '{not-json')
    assert.throws(
      () => checkSkillAnchors({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath }),
      /could not read anchor manifest/,
    )
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
    assert.deepEqual(checkAnchors({ root: fx.root, docs: [fx.doc], manifest }), { anchors: 1, failures: [], shifted: [] })
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

test('checking reports a shift but never rewrites the manifest or the doc', () => {
  // Mutation killed: delegating checking to repair would erase the drift CI must report.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const before = bytes(fx)
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.shifted, [{ key: 'crew/sample.mjs:2', rel: 'crew/sample.mjs', from: 2, to: 3, nextKey: 'crew/sample.mjs:3' }])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair vacates a line before another anchor claims it', () => {
  // Mutation killed: checking collisions only against the original manifest refuses a destination another repair vacates.
  const root = scratchDir('b383-anchor-repair-')
  mkdirSync(join(root, 'crew'), { recursive: true })
  writeFileSync(join(root, 'crew/sample.mjs'), [
    '// header',
    '// pad a',
    '// pad b',
    '// pad c',
    "const ALPHA = 'anchor-alpha-value'",
    'const other = 1',
    "const BETA = 'anchor-beta-value'",
    '',
  ].join('\n'))
  const skillDir = join(root, 'skills/sample')
  mkdirSync(skillDir, { recursive: true })
  const doc = join(skillDir, 'SKILL.md')
  writeFileSync(doc, '# sample\n\nAlpha: `crew/sample.mjs:3`. Beta: `crew/sample.mjs:5`.\n')
  const manifestPath = join(skillDir, 'anchors.json')
  writeFileSync(manifestPath, JSON.stringify({
    'crew/sample.mjs:3': "const ALPHA = 'anchor-alpha-value'",
    'crew/sample.mjs:5': "const BETA = 'anchor-beta-value'",
  }, null, 2))
  try {
    const result = repairAnchorsInPlace({ root, skillDir, manifestPath })
    assert.deepEqual(result.refusals, [])
    assert.equal(result.repairs.length, 2)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest['crew/sample.mjs:5'], "const ALPHA = 'anchor-alpha-value'")
    assert.equal(manifest['crew/sample.mjs:7'], "const BETA = 'anchor-beta-value'")
    const repaired = readFileSync(doc, 'utf8')
    assert.ok(repaired.includes('crew/sample.mjs:5'))
    assert.ok(repaired.includes('crew/sample.mjs:7'))
    assert.deepEqual(checkAnchors({ root, docs: [doc], manifest }), { anchors: 2, failures: [], shifted: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('b384: an in-fence shift is a hard failure', () => {
  // b384 preserves the fail-closed result when the lane owns the manifest; treating every shift as an out-of-fence warning lets changed files drift silently.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  try {
    assert.throws(
      () => assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, fence: ['crew/sample.mjs', 'skills/sample/anchors.json'], log: () => {} }),
      /crew\/sample\.mjs:2.*inside this lane's fence/,
    )
  } finally {
    dispose(fx)
  }
})

test('a shift whose pinning manifest is outside the fence warns instead of failing (#882)', () => {
  // Mutation killed: refusing an external-manifest shift would make drift outside this lane's ownership block the suite.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const captured = []
  try {
    assert.equal(assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, fence: ['crew/sample.mjs'], log: (line) => captured.push(line) }), 1)
    assert.equal(captured.length, 1)
    assert.match(captured[0], /crew\/sample\.mjs:2/)
    assert.match(captured[0], /--repair-all/)
    assert.match(captured[0], /after this lane merges, on main/)
  } finally {
    dispose(fx)
  }
})

test('rot and ambiguity stay fatal when the manifest is outside the fence', () => {
  const rot = fixture({ manifest: { 'crew/sample.mjs:2': 'missing-anchor-value' } })
  const ambiguous = fixture({
    source: ['// header', `const ${EXPECTED}`, `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''],
  })
  try {
    assert.throws(
      () => assertAnchorsPinned({ root: rot.root, skillDir: rot.skillDir, manifestPath: rot.manifestPath, minAnchors: 1, fence: ['crew/sample.mjs'], log: () => {} }),
      /occur on exactly one target line/,
    )
    assert.throws(
      () => assertAnchorsPinned({ root: ambiguous.root, skillDir: ambiguous.skillDir, manifestPath: ambiguous.manifestPath, minAnchors: 1, fence: ['crew/sample.mjs'], log: () => {} }),
      /occur on exactly one target line/,
    )
  } finally {
    dispose(rot)
    dispose(ambiguous)
  }
})

test('partitionShifts preserves the omitted-manifest split and routes external manifests out of fence', () => {
  const shifted = [{ rel: 'crew/sample.mjs' }, { rel: 'crew/other.mjs' }]
  assert.deepEqual(partitionShifts({ shifted, fence: ['crew/sample.mjs'] }), {
    inFence: [shifted[0]],
    outOfFence: [shifted[1]],
  })
  assert.deepEqual(partitionShifts({ shifted, fence: ['crew/sample.mjs', 'skills/sample/anchors.json'], manifest: 'skills/other/anchors.json' }), {
    inFence: [],
    outOfFence: shifted,
  })
})

test('an unmeasurable lane fence is empty and warns rather than throwing', () => {
  // Mutation killed: guessing a scratch directory's fence would turn an unmeasured blind spot into a false hard failure.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const captured = []
  try {
    const measured = laneFence({ root: fx.root })
    assert.deepEqual(measured.paths, [])
    assert.equal(measured.measured, false)
    assert.ok(measured.reason)
    assert.equal(assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, log: (line) => captured.push(line) }), 1)
    assert.ok(captured.some((line) => line.includes('anchor fence unmeasured')))
    assert.ok(captured.some((line) => line.includes('crew/sample.mjs:2')))
  } finally {
    dispose(fx)
  }
})

test('laneFence excludes main-only paths after a lane forks', () => {
  // Mutation killed: diffing against the main tip reports an upstream-only path as lane-owned.
  const root = scratchDir('b383-lane-fence-')
  mkdirSync(join(root, 'crew'), { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'crew/sample.mjs'), "const MAIN_ONLY = 'base'\n")
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'base')
  git(root, 'checkout', '--quiet', '-b', 'lane')
  git(root, 'checkout', '--quiet', 'main')
  writeFileSync(join(root, 'crew/sample.mjs'), "// main advanced\nconst MAIN_ONLY = 'base'\n")
  git(root, 'add', 'crew/sample.mjs')
  git(root, 'commit', '--quiet', '-m', 'main only')
  git(root, 'checkout', '--quiet', 'lane')
  writeFileSync(join(root, 'skills/lane-note.md'), 'this lane owns this file\n')
  const repoRoot = realpathSync(root)
  const result = laneFence({ root: repoRoot })
  assert.deepEqual(result, { paths: ['skills/lane-note.md'], measured: true, reason: null })
  assert.equal(result.paths.includes('crew/sample.mjs'), false)
})

test('repair CLI leaves a committed out-of-fence shift untouched', () => {
  // Mutation killed: ignoring the measured repair fence rewrites a pin whose target is outside the lane.
  const root = scratchDir('b383-anchor-repair-fence-')
  const skillDir = join(root, 'skills/sample')
  const doc = join(skillDir, 'SKILL.md')
  const manifestPath = join(skillDir, 'anchors.json')
  mkdirSync(join(root, 'crew'), { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'crew/sample.mjs'), ['// header', `const ${EXPECTED}`, 'export default KEY', ''].join('\n'))
  writeFileSync(doc, '# sample\n\nExhibit: `crew/sample.mjs:1`.\n')
  writeFileSync(manifestPath, JSON.stringify({ 'crew/sample.mjs:1': EXPECTED }, null, 2))
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'stale external pin')
  git(root, 'checkout', '--quiet', '-b', 'lane')
  writeFileSync(join(root, 'skills/lane-note.md'), 'this lane owns this file\n')
  const repoRoot = realpathSync(root)
  const fence = laneFence({ root: repoRoot })
  assert.equal(fence.measured, true)
  assert.ok(fence.paths.includes('skills/lane-note.md'))
  assert.equal(fence.paths.includes('crew/sample.mjs'), false)
  const beforeManifest = readFileSync(manifestPath, 'utf8')
  const beforeDoc = readFileSync(doc, 'utf8')
  const output = []
  assert.equal(repairCli(['--repair', skillDir, '--root', repoRoot], output.push.bind(output)), 0)
  assert.deepEqual(output, [])
  assert.equal(readFileSync(manifestPath, 'utf8'), beforeManifest)
  assert.equal(readFileSync(doc, 'utf8'), beforeDoc)
  assert.deepEqual(
    checkAnchors({ root: repoRoot, docs: [doc], manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }),
    { anchors: 1, failures: [], shifted: [{ key: 'crew/sample.mjs:1', rel: 'crew/sample.mjs', from: 1, to: 2, nextKey: 'crew/sample.mjs:2' }] },
  )
})

test('repair-all CLI repairs a committed shift on clean main', () => {
  // Mutation killed: dropping repair-all's fence override leaves a committed main shift unrepaired.
  const root = scratchDir('b383-anchor-repair-all-')
  const skillDir = join(root, 'skills/sample')
  const doc = join(skillDir, 'SKILL.md')
  const manifestPath = join(skillDir, 'anchors.json')
  mkdirSync(join(root, 'crew'), { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'crew/sample.mjs'), ['// header', `const ${EXPECTED}`, 'export default KEY', ''].join('\n'))
  writeFileSync(doc, '# sample\n\nExhibit: `crew/sample.mjs:1`.\n')
  writeFileSync(manifestPath, JSON.stringify({ 'crew/sample.mjs:1': EXPECTED }, null, 2))
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'committed shift')
  const repoRoot = realpathSync(root)
  assert.deepEqual(laneFence({ root: repoRoot }), { paths: [], measured: true, reason: null })
  const warnings = []
  assert.equal(assertAnchorsPinned({ root: repoRoot, skillDir, manifestPath, minAnchors: 1, log: warnings.push.bind(warnings) }), 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /--repair-all/)
  const output = []
  assert.equal(repairCli(['--repair-all', skillDir, '--root', repoRoot], output.push.bind(output)), 0)
  assert.deepEqual(output, ['repaired crew/sample.mjs:1 -> crew/sample.mjs:2'])
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest['crew/sample.mjs:2'], EXPECTED)
  assert.equal(Object.hasOwn(manifest, 'crew/sample.mjs:1'), false)
  assert.match(readFileSync(doc, 'utf8'), /crew\/sample\.mjs:2/)
  assert.deepEqual(checkAnchors({ root: repoRoot, docs: [doc], manifest }), { anchors: 1, failures: [], shifted: [] })
})

test('the discovered anchor-manifest corpus checks clean', () => {
  // Mutation killed: omitting a discovered manifest, especially skills/pr-review, leaves a new pin corpus unverified.
  const dirs = anchorManifestDirs(ROOT)
  const relativeDirs = dirs.map((dir) => relative(ROOT, dir))
  assert.ok(relativeDirs.includes('skills/pr-review'))
  for (const dir of dirs) {
    const docs = skillDocs(dir).filter((doc) => {
      // tier.md is exempt for the duplicated quoted-runtime anchor, as documented at skills/crew-dispatch/exhibits.test.mjs:56-62.
      return doc !== join(dir, 'references/tier.md')
    })
    const manifest = JSON.parse(readFileSync(join(dir, 'anchors.json'), 'utf8'))
    const result = checkAnchors({ root: ROOT, docs, manifest })
    assert.deepEqual(result.failures, [], `${relative(ROOT, dir)} manifest failures`)
  }
})

test('no citation carrier test restates a currently pinned anchor key', () => {
  assert.deepEqual(pinnedLiteralsInTests({ root: ROOT }).rows, [])
})

test('the pinned-literal tripwire names the file that restates a key', () => {
  const root = scratchDir('b434-pinned-literals-')
  const skillDir = join(root, 'skills/sample')
  const SAMPLE = `${'crew/sample.mjs'}:2`
  const UNPINNED = `${'crew/sample.mjs'}:9999`
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'anchors.json'), `${JSON.stringify({ [SAMPLE]: 'sample pinned content' }, null, 2)}\n`)
  writeFileSync(join(skillDir, 'offender.test.mjs'), `const cited = '${SAMPLE}'\n`)
  writeFileSync(join(skillDir, 'clean.test.mjs'), `const cited = '${UNPINNED}'\n`)
  const result = pinnedLiteralsInTests({ root })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].file, 'skills/sample/offender.test.mjs')
  assert.equal(result.rows[0].line, 1)
  assert.equal(result.rows[0].key, SAMPLE)
  assert.equal(result.rows[0].manifest, 'skills/sample/anchors.json')
  assert.equal(result.rows.some(({ file }) => file === 'skills/sample/clean.test.mjs'), false)
})

test('the tripwire ignores the quoted runtime refusal no manifest pins', () => {
  const cliContract = join(ROOT, 'skills/crew-dispatch/cli-contract.test.mjs')
  const result = pinnedLiteralsInTests({ root: ROOT, files: ['skills/crew-dispatch/cli-contract.test.mjs'] })
  assert.deepEqual(result.rows, [])
  assert.ok(readFileSync(cliContract, 'utf8').includes('crew/crew.mjs' + ':265'))
})

test('pinnedKey resolves the live key from the pinned content and refuses anything else', () => {
  const root = scratchDir('b434-pinned-key-')
  const manifestPath = join(root, 'anchors.json')
  const SAMPLE = `${'crew/sample.mjs'}:2`
  const expected = 'sample pinned content'
  writeFileSync(manifestPath, JSON.stringify({ [SAMPLE]: expected }, null, 2))
  assert.equal(pinnedKey({ manifestPath, expected }), SAMPLE)

  writeFileSync(manifestPath, '{}\n')
  assert.throws(
    () => pinnedKey({ manifestPath, expected }),
    (error) => error.message.includes(manifestPath) && error.message.includes('found 0'),
  )

  writeFileSync(manifestPath, JSON.stringify({ [SAMPLE]: expected, [`${'crew/sample.mjs'}:3`]: expected }, null, 2))
  assert.throws(
    () => pinnedKey({ manifestPath, expected }),
    (error) => error.message.includes(manifestPath) && error.message.includes('found 2'),
  )
})

test('citationCarrierTests covers every skills test plus the named extras', () => {
  const files = citationCarrierTests(ROOT)
  for (const file of [
    'skills/crew-dispatch/exhibits.test.mjs',
    'skills/crew-recovery/exhibits.test.mjs',
    'skills/crew-dispatch/cli-contract.test.mjs',
    'test/review-procedure-loader.test.mjs',
  ]) assert.ok(files.includes(file), `carrier set must include ${file}`)
  const result = pinnedLiteralsInTests({ root: ROOT })
  assert.ok(PINNED_LITERAL_BLIND_SPOT.length > 0)
  assert.equal(result.blindSpot, PINNED_LITERAL_BLIND_SPOT)
})
