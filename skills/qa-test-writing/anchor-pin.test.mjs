import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ROOT, git, scratchDir } from '../../test/helpers.mjs'
import { anchorManifestDirs, assertAnchorsPinned, checkAnchors, checkSkillAnchors, citationCarrierTests, collectAnchors, collectNamed, collectRanges, INVERTED_MARK, laneFence, MIN_EXPECTED_LENGTH, partitionShifts, pinnedKey, pinnedLiteralsInTests, repairAnchors, repairAnchorsInPlace, repairCli, resolveNamed, rewriteCitations, skillDocs, PINNED_LITERAL_BLIND_SPOT } from './anchor-pin.mjs'

const EXPECTED = "KEY = 'anchored-sentinel-value'"
const RANGE_EXPECTED = "RANGE = 'range-first-sentinel-value'"
const RANGE_NEXT = "NEXT = 'range-second-sentinel-value'"
const RANGE_THIRD = "THIRD = 'range-third-sentinel-value'"
const EXPECTED_A = "const A = 'anchor-a-distinctive-value'"
const EXPECTED_B = "const B = 'anchor-b-distinctive-value'"

function fixture({ source = ['// header', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''], line = 2, cite, named, manifest } = {}) {
  const root = scratchDir('b177-anchor-pin-')
  mkdirSync(join(root, 'crew'), { recursive: true })
  writeFileSync(join(root, 'crew/sample.mjs'), source.join('\n'))
  const skillDir = join(root, 'skills/sample')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  const doc = join(skillDir, 'SKILL.md')
  const namedKey = typeof named === 'string' ? named : named?.key ?? (named ? `crew/sample.mjs@${named.name || 'sentinel'}` : null)
  const citation = cite ?? namedKey ?? `crew/sample.mjs:${line}`
  const expected = typeof named === 'object' && named !== null ? named.expected ?? EXPECTED : EXPECTED
  const declarations = manifest ?? (namedKey ? { [namedKey]: expected } : { 'crew/sample.mjs:2': EXPECTED })
  writeFileSync(doc, `# sample\n\nExhibit: \`${citation}\`.\n`)
  const manifestPath = join(skillDir, 'anchors.json')
  writeFileSync(manifestPath, JSON.stringify(declarations, null, 2))
  return { root, skillDir, doc, manifestPath, manifest: declarations, namedKey }
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

function contractSkill(root, entries, citations = Object.keys(entries)) {
  const skillDir = join(root, 'skills/sample')
  mkdirSync(skillDir, { recursive: true })
  const doc = join(skillDir, 'SKILL.md')
  const manifestPath = join(skillDir, 'anchors.json')
  writeFileSync(doc, `# sample\n\n${citations.map((key) => `Exhibit: \`${key}\`.`).join('\n')}\n`)
  writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`)
  return { root, skillDir, doc, manifestPath }
}

function authoritativeFixture(prefix) {
  const root = scratchDir(prefix)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'scripts/a.mjs'), `${EXPECTED_A}\n`)
  writeFileSync(join(root, 'scripts/b.mjs'), `${EXPECTED_B}\n`)
  const fx = contractSkill(root, { 'scripts/a.mjs:1': EXPECTED_A, 'scripts/b.mjs:1': EXPECTED_B })
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'base')
  git(root, 'checkout', '--quiet', '-b', 'upstream')
  writeFileSync(join(root, 'scripts/b.mjs'), `// upstream shift\n${EXPECTED_B}\n`)
  git(root, 'add', 'scripts/b.mjs')
  git(root, 'commit', '--quiet', '-m', 'upstream moves b')
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'checkout', '--quiet', '-b', 'lane')
  writeFileSync(join(root, 'scripts/a.mjs'), `// lane shift\n${EXPECTED_A}\n`)
  git(root, 'add', 'scripts/a.mjs')
  git(root, 'commit', '--quiet', '-m', 'lane moves a')
  return { ...fx, root: realpathSync(root) }
}

function shiftedContractFixture(prefix) {
  const root = scratchDir(prefix)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/a.mjs'), `// shifted\n${EXPECTED_A}\n`)
  return contractSkill(root, { 'scripts/a.mjs:1': EXPECTED_A })
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
    assert.equal(repairCli(['--repair-all', fx.plainDir, '--root', fx.root], output.push.bind(output)), 0)
    assert.deepEqual(output, ['ANCHOR_REPAIR_ROW {"manifest":"plain/anchors.json","pin":"crew/sample.mjs:2","old_line":2,"new_line":3,"base":null,"base_commit":null}'])
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
    assert.equal(repairCli(['--repair-all', fx.plainDir, '--root', fx.root], output.push.bind(output)), 1)
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
    assert.equal(repairCli(['--repair-all', fx.plainDir, '--root', fx.root], output.push.bind(output)), 1)
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
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
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
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
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
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
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
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
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
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
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
    const first = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.equal(first.repairs.length, 1)
    const afterFirst = bytes(fx)
    const second = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.deepEqual(second.repairs, [])
    assert.deepEqual(second.refusals, [])
    assert.equal(bytes(fx), afterFirst)
  } finally {
    dispose(fx)
  }
})

test('the CLI repairs a skill directory and exits non-zero on refusal', () => {
  // Mutation killed: changing repairClis clean, refusal, or usage status breaks this in-process contract.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['const duplicated-sentinel = 1', 'const duplicated-sentinel = 1', '// tail', ''].join('\n'))
    writeFileSync(fx.doc, '# sample\n\nExhibit: `crew/sample.mjs:3`.\n')
    writeFileSync(fx.manifestPath, JSON.stringify({ 'crew/sample.mjs:3': 'const duplicated-sentinel = 1' }, null, 2))
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
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
    const result = repairAnchorsInPlace({ root, skillDir, manifestPath, repairAll: true })
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
  // Mutation killed: refusing an external-manifest shift would make drift outside this lanes ownership block the suite.
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
  // Mutation killed: guessing a scratch directorys fence would turn an unmeasured blind spot into a false hard failure.
  const source = ['// header', '// inserted before the declaration', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', '']
  const fx = fixture({ source })
  const captured = []
  try {
    const measured = laneFence({ root: fx.root })
    assert.deepEqual(measured.paths, [])
    assert.equal(measured.measured, false)
    assert.equal(measured.base, 'origin/main')
    assert.ok(measured.reason)
    assert.equal(assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, log: (line) => captured.push(line) }), 1)
    assert.ok(captured.some((line) => line.includes('anchor fence unmeasured')))
    assert.ok(captured.some((line) => line.includes('crew/sample.mjs:2')))
  } finally {
    dispose(fx)
  }
})

// The review proved a lane branched from something OTHER than the base ref gets a merge base
// that is an ancestor of both, so its fence is WIDER than its own work — and that a stale
// remote-tracking ref reproduces the same thing. Neither is detectable locally. What the fence
// CAN do is name the commit it actually measured against, so a caller who knows the true
// branch point can pass it and an auditor can check afterwards.
// MF1: reporting a bad base afterwards does not PREVENT an over-wide repair. The caller often
// knows the true branch point — the driver records a resolved HEAD at run-start and arm
// worktrees are cut from a resolved pin — so `--base` threads that known commit all the way to
// the fence. A lane branched from `release` while `origin/main` lagged is the shape that
// repaired an untouched upstream file.
// G2 exercises laneFence directly; this covers the PLUMBING, which is the actual MF1 fix.
// `--base` must reach the fence through repairCli -> repairAnchorsInPlace -> repairAnchors.
test('G3 --base reaches the fence through the whole CLI chain', () => {
  const root = scratchDir('base-threading-')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'scripts/a.mjs'), 'const A = 1\n')
  writeFileSync(join(root, 'scripts/b.mjs'), 'const B = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'base')
  // an origin/main that LAGS — ignoring the callers base falls back to this and widens
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'checkout', '--quiet', '-b', 'release')
  writeFileSync(join(root, 'scripts/b.mjs'), '// moved\nconst B = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'release moves B')
  const releaseSha = git(root, 'rev-parse', 'HEAD').trim()
  git(root, 'checkout', '--quiet', '-b', 'lane')
  writeFileSync(join(root, 'scripts/a.mjs'), '// moved\nconst A = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'lane moves A')
  const fx = contractSkill(root, { 'scripts/a.mjs:1': EXPECTED_A, 'scripts/b.mjs:1': EXPECTED_B })
  try {
    // Told the TRUE branch point, b is OUT of fence: its stale pin is refused, not rewritten.
    // That refusal is the safety property, and it exits 1.
    const output = []
    const code = repairCli(['--repair', fx.skillDir, '--root', fx.root, '--base', releaseSha], output.push.bind(output))
    const rows = output.filter((line) => line.startsWith('ANCHOR_REPAIR_ROW ')).map((line) => JSON.parse(line.slice('ANCHOR_REPAIR_ROW '.length)))
    assert.equal(code, 1, output.join('\n'))
    assert.equal(rows.some((row) => row.pin === 'scripts/b.mjs:1'), false, 'an upstream file must not be rewritten')
    assert.ok(output.some((line) => line.startsWith('refused') && line.includes('scripts/b.mjs')), output.join('\n'))
    for (const row of rows) assert.equal(row.base_commit, releaseSha, 'the row names the supplied commit')

    // and assert the THREADING directly: the fence repairAnchors used must be the one the
    // caller asked for. Inferring it from exit codes did not discriminate — ignoring `base`
    // still produced a refusal, for a different reason — so the plumbing is checked at the
    // seam. A lagging origin/main sits in this fixture precisely so the two differ.
    const threaded = repairAnchors({
      root: fx.root, docs: skillDocs(fx.skillDir),
      manifest: JSON.parse(readFileSync(fx.manifestPath, 'utf8')), base: releaseSha,
    })
    assert.equal(threaded.fence.baseCommit, releaseSha, 'repairAnchors measured against the supplied base')
    assert.equal(threaded.fence.paths.includes('scripts/b.mjs'), false, 'the upstream file is outside the supplied fence')

    // The contrast — that GUESSING a base widens the fence — is pinned by G2 against
    // `laneFence` directly. Re-running the CLI here would measure a fixture this call has
    // already mutated, so it is not repeated.
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// MF2: the contract is baseCommit on EVERY return, including the two early ones.
test('G4 every unmeasured return carries a null base commit', () => {
  for (const [label, fence] of [
    ['invalid root', laneFence({ root: '' })],
    ['unreadable root', laneFence({ root: '/nonexistent-root-for-anchor-pin' })],
  ]) {
    assert.equal(fence.measured, false, label)
    assert.equal('baseCommit' in fence, true, `${label} omits baseCommit entirely`)
    assert.equal(fence.baseCommit, null, label)
  }
})

test('G2 a caller-supplied base confines the repair to the lane own work', () => {
  const root = scratchDir('supplied-base-')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'scripts/a.mjs'), 'const A = 1\n')
  writeFileSync(join(root, 'scripts/b.mjs'), 'const B = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'base')
  // release advances B; the lane is cut from release and touches only A
  git(root, 'checkout', '--quiet', '-b', 'release')
  writeFileSync(join(root, 'scripts/b.mjs'), '// moved\nconst B = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'release moves B')
  const releaseSha = git(root, 'rev-parse', 'HEAD').trim()
  git(root, 'checkout', '--quiet', '-b', 'lane')
  writeFileSync(join(root, 'scripts/a.mjs'), '// moved\nconst A = 1\n')
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'lane moves A')

  // told the TRUE branch point, the fence names only the lane own file
  const supplied = laneFence({ root, base: releaseSha })
  assert.equal(supplied.measured, true)
  assert.equal(supplied.baseCommit, releaseSha)
  assert.deepEqual(supplied.paths, ['scripts/a.mjs'])

  // left to guess at `main`, it is WIDER — this is the defect a known base avoids, and it is
  // pinned here so the difference cannot silently disappear
  const guessed = laneFence({ root, base: 'main' })
  assert.equal(guessed.paths.includes('scripts/b.mjs'), true, 'guessing a base over-widens the fence')
})

test('G1 the fence names the commit it measured against, not just the symbolic ref', () => {
  const root = scratchDir('base-commit-')
  mkdirSync(join(root, 'skills'), { recursive: true })
  git(root, 'init', '--quiet')
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(root, 'skills/base.md'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'base')
  const baseSha = git(root, 'rev-parse', 'HEAD').trim()
  git(root, 'checkout', '--quiet', '-b', 'lane')
  writeFileSync(join(root, 'skills/lane.md'), 'lane\n')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'lane')

  // an explicit base is honoured, and the RESOLVED COMMIT is reported
  const fence = laneFence({ root, base: 'main' })
  assert.equal(fence.measured, true)
  assert.equal(fence.baseCommit, baseSha, 'the resolved commit is reported, not only the ref name')
  assert.deepEqual(fence.paths, ['skills/lane.md'])

  // an unresolvable base still refuses by name AND reports no commit
  const missing = laneFence({ root, base: 'origin/does-not-exist' })
  assert.equal(missing.measured, false)
  assert.equal(missing.baseCommit, null)
  assert.match(missing.reason, /no merge base with origin\/does-not-exist/)
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
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(root, 'checkout', '--quiet', 'lane')
  writeFileSync(join(root, 'skills/lane-note.md'), 'this lane owns this file\n')
  const repoRoot = realpathSync(root)
  const result = laneFence({ root: repoRoot })
  assert.match(String(result.baseCommit), /^[0-9a-f]{40}$/, 'the fence reports the commit it measured against')
  assert.deepEqual({ ...result, baseCommit: undefined }, { paths: ['skills/lane-note.md'], measured: true, reason: null, base: 'origin/main', baseCommit: undefined })
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
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
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
  // Mutation killed: dropping repair-alls fence override leaves a committed main shift unrepaired.
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
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const repoRoot = realpathSync(root)
  const cleanFence = laneFence({ root: repoRoot })
  assert.match(String(cleanFence.baseCommit), /^[0-9a-f]{40}$/, 'the fence reports the commit it measured against')
  assert.deepEqual({ ...cleanFence, baseCommit: undefined }, { paths: [], measured: true, reason: null, base: 'origin/main', baseCommit: undefined })
  const warnings = []
  assert.equal(assertAnchorsPinned({ root: repoRoot, skillDir, manifestPath, minAnchors: 1, log: warnings.push.bind(warnings) }), 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /--repair-all/)
  const output = []
  assert.equal(repairCli(['--repair-all', skillDir, '--root', repoRoot], output.push.bind(output)), 0)
  assert.deepEqual(output, ['ANCHOR_REPAIR_ROW {"manifest":"skills/sample/anchors.json","pin":"crew/sample.mjs:1","old_line":1,"new_line":2,"base":null,"base_commit":null}'])
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

test('the tripwire ignores a quoted file-and-line literal no manifest pins', () => {
  // This used to witness the rule against a REAL stale citation that happened to live
  // in skills/crew-dispatch/cli-contract.test.mjs. That citation has been removed (it
  // had drifted by ~1,400 lines inside an operator-facing refusal), which would have
  // made the guard vacuous while still passing its first assertion. The witness is now
  // synthetic, so the tripwire is tested on its own terms and does not depend on the
  // corpus continuing to carry a defect.
  const root = scratchDir('b517-unpinned-literal-')
  const rel = 'skills/example/unpinned.test.mjs'
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, "const quoted = 'a refusal naming " + "crew/example.mjs" + ":42 inside a string'\n")
  writeFileSync(join(root, 'anchors.json'), '{}\n')
  const result = pinnedLiteralsInTests({ root, files: [rel] })
  assert.deepEqual(result.rows, [], 'a file-and-line literal in no manifest key is not the tripwire\'s business')
  assert.ok(readFileSync(file, 'utf8').includes('crew/example.mjs' + ':42'), 'the fixture must still carry the literal it is not flagged for')
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

function anchorKey(line) { return `${'crew/sample.mjs'}:${line}` }
function rangeCitation(start, end) { return `${'crew/sample.mjs'}:${start}-${end}` }

test('a range whose endpoints are both manifest keys has both repaired', () => {
  // Mutation killed: omitting the range rewrite leaves the citations end stale after both pins move.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, 'export default KEY', ''],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT },
  })
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted above', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, 'export default KEY', ''].join('\n'))
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    const doc = readFileSync(fx.doc, 'utf8')
    assert.deepEqual(result.refusals, [])
    assert.equal(result.repairs.length, 2)
    assert.equal(manifest[anchorKey(3)], RANGE_EXPECTED)
    assert.equal(manifest[anchorKey(4)], RANGE_NEXT)
    assert.equal(Object.hasOwn(manifest, anchorKey(2)), false)
    assert.equal(doc.includes(rangeCitation(3, 4)), true)
    assert.equal(doc.includes(rangeCitation(2, 3)), false)
  } finally {
    dispose(fx)
  }
})

test('a manifest-pinned range end with an unpinned start is red in BOTH passes', () => {
  // Mutation killed: excusing a manifest-pinned end in repairAnchors lets it move alone and leaves the range literal stale.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, ''],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(3)]: RANGE_NEXT },
  })
  try {
    const checked = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    const repaired = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.ok(checked.failures.includes(`${anchorKey(2)}: manifest has no entry`))
    assert.ok(repaired.refusals.includes(`${anchorKey(2)}: manifest has no entry`))
    assert.ok(repaired.refusals.includes(`${anchorKey(3)}: manifest entry is orphaned (no citation)`))
    assert.deepEqual(repaired.repairs, [])
    assert.equal(readFileSync(fx.doc, 'utf8').includes(rangeCitation(2, 3)), true)
  } finally {
    dispose(fx)
  }
})

test('a range-only end is checked, not excused', () => {
  // Mutation killed: omitting manifest-backed range ends hides their shift and changes the anchor count.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, ''],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT },
  })
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', `const ${RANGE_EXPECTED}`, 'const spacer = 1', `const ${RANGE_NEXT}`, ''].join('\n'))
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.equal(result.anchors, collectAnchors({ docs: [fx.doc] }).length)
    assert.equal(result.failures.some((failure) => failure.includes('orphan')), false)
    assert.deepEqual(result.shifted, [{ key: anchorKey(3), rel: 'crew/sample.mjs', from: 3, to: 4, nextKey: anchorKey(4) }])
  } finally {
    dispose(fx)
  }
})

test('a range-only end whose content rotted is reported as rot, not as an orphan', () => {
  // Mutation killed: leaving a rotted range end out of endpoint validation mislabels it as an orphan.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, ''],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT },
  })
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', `const ${RANGE_EXPECTED}`, 'const spacer = 1', ''].join('\n'))
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.ok(result.failures.some((failure) => failure.startsWith(`${anchorKey(3)}:`) && failure.includes('occur on exactly one target line')))
    assert.equal(result.failures.some((failure) => failure.includes('orphan')), false)
  } finally {
    dispose(fx)
  }
})

test('a rotted endpoint withholds its whole range', () => {
  // Mutation killed: allowing a valid peer to settle after its range partner rots commits a half-repair.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT },
  })
  const before = bytes(fx)
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted above', '// second inserted', `const ${RANGE_EXPECTED}`].join('\n'))
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.deepEqual(result.repairs, [])
    assert.equal(bytes(fx), before)
    assert.ok(result.refusals.some((refusal) => refusal.includes(anchorKey(3)) && refusal.includes('rot, not a shift')))
    assert.ok(result.refusals.some((refusal) => refusal.includes(anchorKey(2)) && refusal.includes('withheld')))
  } finally {
    dispose(fx)
  }
})

test('a collision-pending endpoint withholds its whole range', () => {
  // Mutation killed: committing a peer while its collision-pending range endpoint is withdrawn splits the citation.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, 'const spacer = 1', `const ${RANGE_THIRD}`, ''],
    cite: `${rangeCitation(2, 3)} and ${anchorKey(5)}`,
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT, [anchorKey(5)]: RANGE_THIRD },
  })
  const before = bytes(fx)
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', 'const spacer = 1', `const ${RANGE_THIRD}`, `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, ''].join('\n'))
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.deepEqual(result.repairs, [])
    assert.equal(bytes(fx), before)
    assert.ok(result.refusals.some((refusal) => refusal.includes('already declared by another anchor')))
  } finally {
    dispose(fx)
  }
})

test('a single-key rewrite does not bind inside a range', () => {
  // Mutation killed: removing the range-start guard lets a single-key rewrite move only the start endpoint.
  const text = `Exhibit: \`${rangeCitation(2, 9)}\`.`
  const rewritten = rewriteCitations(text, new Map([[anchorKey(2), anchorKey(3)]]))
  assert.equal(rewritten, text)
})

test('a range whose end is in no manifest refuses by name and freezes the start key', () => {
  // Mutation killed: allowing a frozen start to move leaves standalone prose and an unpinned range split.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, 'export default KEY'],
    cite: anchorKey(2),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED },
  })
  const notes = join(fx.skillDir, 'references/notes.md')
  writeFileSync(notes, `# notes\n\nExhibit: \`${rangeCitation(2, 9)}\`.\n`)
  const before = {
    manifest: readFileSync(fx.manifestPath, 'utf8'),
    skill: readFileSync(fx.doc, 'utf8'),
    notes: readFileSync(notes, 'utf8'),
  }
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted above', `const ${RANGE_EXPECTED}`, 'export default KEY'].join('\n'))
    const output = []
    const code = repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output))
    assert.equal(code, 1)
    assert.equal(readFileSync(fx.manifestPath, 'utf8'), before.manifest)
    assert.equal(readFileSync(fx.doc, 'utf8'), before.skill)
    assert.equal(readFileSync(notes, 'utf8'), before.notes)
    assert.ok(output.some((line) => line.includes(rangeCitation(2, 9)) && line.includes(anchorKey(9))))
  } finally {
    dispose(fx)
  }
})

function invertedCitation() { return rangeCitation(9, 2) }

test('an inverted range is reported with no manifest at all', () => {
  // Mutation killed: skipping inversion reporting in checkAnchors lets an unpinned damaged pair pass.
  const fx = fixture({ source: ['// header', `const ${RANGE_EXPECTED}`, 'export default KEY'], cite: invertedCitation(), manifest: {} })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: {} })
    assert.ok(result.failures.some((failure) => failure.includes(invertedCitation()) && failure.includes(INVERTED_MARK)))
  } finally {
    dispose(fx)
  }
})

test('the repair pass refuses an inverted range', () => {
  // Mutation killed: skipping inversion reporting in repairAnchors lets the sanctioned repair pass walk past damage.
  const fx = fixture({ source: ['// header', `const ${RANGE_EXPECTED}`, 'export default KEY'], cite: invertedCitation(), manifest: {} })
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.ok(output.some((line) => line.includes(invertedCitation()) && line.includes(INVERTED_MARK)))
  } finally {
    dispose(fx)
  }
})

test('a blocked range stays silent while nothing has drifted', () => {
  // Mutation killed: refusing a stable start-only range would break clean post-merge repair-all runs.
  const fx = fixture({ cite: rangeCitation(2, 9), manifest: { [anchorKey(2)]: EXPECTED } })
  const before = bytes(fx)
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    assert.deepEqual(output, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('a repaired pair that inverts is written truthfully and reported', () => {
  // Mutation killed: straightening a repaired inverted pair would hide the sources true endpoint order.
  const fx = fixture({
    source: ['// header', `const ${RANGE_EXPECTED}`, `const ${RANGE_NEXT}`, 'const spacer = 1', 'export default KEY', ''],
    cite: rangeCitation(2, 3),
    manifest: { [anchorKey(2)]: RANGE_EXPECTED, [anchorKey(3)]: RANGE_NEXT },
  })
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', `const ${RANGE_NEXT}`, 'const spacer = 1', `const ${RANGE_EXPECTED}`, 'export default KEY', ''].join('\n'))
    const output = []
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.ok(output.some((line) => line.includes(rangeCitation(4, 2)) && line.includes(INVERTED_MARK)))
    assert.equal(readFileSync(fx.doc, 'utf8').includes(rangeCitation(4, 2)), true)
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest[anchorKey(4)], RANGE_EXPECTED)
    assert.equal(manifest[anchorKey(2)], RANGE_NEXT)
  } finally {
    dispose(fx)
  }
})

test('collectRanges ignores a path outside ANCHOR_ROOTS', () => {
  // Mutation killed: accepting an outside-root range would make unrelated prose participate in pin repair.
  const fx = fixture({ cite: 'foo/bar.mjs:1-2', manifest: {} })
  try {
    assert.deepEqual(collectRanges({ docs: [fx.doc] }), [])
  } finally {
    dispose(fx)
  }
})

test('processes.md cites the manifest-resolved key', () => {
  // Mutation killed: replacing one exhibit with an unpinned line breaks proof against the live manifest key.
  const manifestPath = join(ROOT, 'skills/devops/anchors.json')
  const key = pinnedKey({ manifestPath, expected: 'unknown boot descendant refusal' })
  const text = readFileSync(join(ROOT, 'skills/devops/references/processes.md'), 'utf8')
  assert.equal(text.split(key).length - 1, 3)
  assert.deepEqual(text.match(/crew\/crew\.mjs:\d+-\d+/g) || [], [])
})

test('a named citation resolves to the live line after lines are inserted above it', () => {
  // Mutation killed: resolving a named pin from its old line would leave the citation stale after insertion.
  const key = 'crew/sample.mjs@named-sentinel'
  const fx = fixture({ named: { key, expected: EXPECTED } })
  try {
    const [citation] = collectNamed({ docs: [fx.doc] })
    assert.deepEqual(resolveNamed({ root: fx.root, manifest: fx.manifest, citation }), { key, line: 2 })
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// inserted one', '// inserted two', '// inserted three', '// header', `const ${EXPECTED}`, 'const other = 1', 'export default KEY', ''].join('\n'))
    assert.deepEqual(resolveNamed({ root: fx.root, manifest: fx.manifest, citation }), { key, line: 5 })
  } finally {
    dispose(fx)
  }
})

test('a named citation whose content is gone is rot, not a shift', () => {
  // Mutation killed: treating a rotted named pin as a shift would silently accept missing evidence.
  const key = 'crew/sample.mjs@named-rot'
  const fx = fixture({ source: ['// header', 'const OTHER = 1', 'export default OTHER', ''], named: { key, expected: EXPECTED } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.equal(result.named, 1)
    assert.equal(result.shifted.length, 0)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], new RegExp(`${key}: .*rot`))
  } finally {
    dispose(fx)
  }
})

test('a named citation whose content is on two lines is ambiguous', () => {
  // Mutation killed: resolving the first duplicate would make a named pin guess between two target lines.
  const key = 'crew/sample.mjs@named-ambiguous'
  const fx = fixture({ source: ['// header', `const ${EXPECTED}`, `const twin = "${EXPECTED}"`, 'export default KEY', ''], named: { key, expected: EXPECTED } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], new RegExp(`${key}: .*occurs 2 times`))
    assert.deepEqual(result.shifted, [])
  } finally {
    dispose(fx)
  }
})

test('a named citation with no manifest entry fails explicitly', () => {
  // Mutation killed: skipping undeclared named citations would let prose claim an unreviewed pin.
  const key = 'crew/sample.mjs@named-missing'
  const fx = fixture({ named: { key, expected: EXPECTED }, manifest: {} })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: {} })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], new RegExp(`${key}: manifest has no entry`))
  } finally {
    dispose(fx)
  }
})

test('a named citation is never reported as shifted', () => {
  // Mutation killed: adding named resolutions to shifted would turn a line-number-free pin into stale-line noise.
  const key = 'crew/sample.mjs@named-stable'
  const fx = fixture({ source: ['// inserted one', '// inserted two', '// header', `const ${EXPECTED}`, 'export default KEY', ''], named: { key, expected: EXPECTED } })
  try {
    const result = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest })
    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.shifted, [])
    assert.equal(result.named, 1)
  } finally {
    dispose(fx)
  }
})

test('a manifest key cited only by name is not orphaned in either pass', () => {
  // Mutation killed: omitting named keys from the cited set would report a valid name as a dead declaration.
  const key = 'crew/sample.mjs@named-only'
  const fx = fixture({ named: { key, expected: EXPECTED } })
  try {
    assert.deepEqual(checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest }), { anchors: 0, failures: [], shifted: [], named: 1 })
    const repaired = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.deepEqual(repaired.repairs, [])
    assert.deepEqual(repaired.refusals, [])
  } finally {
    dispose(fx)
  }
})

test('repair-all makes no changes for a valid named-only manifest', () => {
  // Mutation killed: treating a stable named pin as a repair candidate would emit a repair or rewrite bytes.
  const key = 'crew/sample.mjs@named-repair-noop'
  const fx = fixture({ named: { key, expected: EXPECTED } })
  const before = bytes(fx)
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    assert.deepEqual(output, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('assertAnchorsPinned counts named citations in its floor and return value', () => {
  // Mutation killed: counting only line citations would reject a fully named manifest at its minimum floor.
  const key = 'crew/sample.mjs@named-counted'
  const fx = fixture({ named: { key, expected: EXPECTED } })
  try {
    assert.equal(assertAnchorsPinned({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, minAnchors: 1, fence: [], log: () => {} }), 1)
  } finally {
    dispose(fx)
  }
})

test('collectNamed ignores a path outside ANCHOR_ROOTS', () => {
  // Mutation killed: accepting an outside-root named path would make unrelated prose participate in pin checks.
  const fx = fixture({ named: { key: 'foo/bar.mjs@outside', expected: EXPECTED }, manifest: {} })
  try {
    assert.deepEqual(collectNamed({ docs: [fx.doc] }), [])
  } finally {
    dispose(fx)
  }
})

test('a mixed manifest checks clean and repairs only its line key', () => {
  // Mutation killed: repairing named keys or rewriting their citations would alter a pin with no stale line number.
  const namedKey = 'crew/sample.mjs@named-mixed'
  const namedExpected = 'named-mixed-anchor-value'
  const fx = fixture({
    source: ['// header', `const ${EXPECTED}`, `const NAMED = '${namedExpected}'`, 'export default KEY', ''],
    cite: `crew/sample.mjs:2 and ${namedKey}`,
    named: { key: namedKey, expected: namedExpected },
    manifest: { 'crew/sample.mjs:2': EXPECTED, [namedKey]: namedExpected },
  })
  try {
    writeFileSync(join(fx.root, 'crew/sample.mjs'), ['// header', '// inserted above', `const ${EXPECTED}`, `const NAMED = '${namedExpected}'`, 'export default KEY', ''].join('\n'))
    const result = repairAnchorsInPlace({ root: fx.root, skillDir: fx.skillDir, manifestPath: fx.manifestPath, repairAll: true })
    assert.equal(result.repairs.length, 1)
    assert.deepEqual(result.refusals, [])
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(manifest['crew/sample.mjs:3'], EXPECTED)
    assert.equal(manifest[namedKey], namedExpected)
    const doc = readFileSync(fx.doc, 'utf8')
    assert.equal(doc.includes('crew/sample.mjs:3'), true)
    assert.equal(doc.includes(namedKey), true)
    assert.deepEqual(checkAnchors({ root: fx.root, docs: [fx.doc], manifest }), { anchors: 1, failures: [], shifted: [], named: 1 })
  } finally {
    dispose(fx)
  }
})

test('checkAnchors preserves its legacy result shape when no named citation exists', () => {
  // Mutation killed: adding named: 0 would break callers that pin the complete zero-name result shape.
  const fx = fixture()
  try {
    assert.deepEqual(checkAnchors({ root: fx.root, docs: [fx.doc], manifest: fx.manifest }), { anchors: 1, failures: [], shifted: [] })
    const key = 'crew/sample.mjs@named-shape'
    writeFileSync(fx.doc, `# sample\n\nExhibit: \`${key}\`.\n`)
    const namedResult = checkAnchors({ root: fx.root, docs: [fx.doc], manifest: { [key]: EXPECTED } })
    assert.deepEqual(namedResult, { anchors: 0, failures: [], shifted: [], named: 1 })
  } finally {
    dispose(fx)
  }
})

test('repair-all valid named pins log nothing and preserve manifest and doc bytes', () => {
  // Mutation killed: writing a named-only result even without repairs would violate the CLI no-op contract.
  const key = 'crew/sample.mjs@named-valid-cli'
  const fx = fixture({ named: { key, expected: EXPECTED } })
  const before = bytes(fx)
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    assert.deepEqual(output, [])
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair-all refuses a rotted named pin without writing', () => {
  // Mutation killed: accepting named rot in repair would return success while leaving a broken manifest in place.
  const key = 'crew/sample.mjs@named-rotted-cli'
  const fx = fixture({ source: ['// header', 'const OTHER = 1', 'export default OTHER', ''], named: { key, expected: EXPECTED } })
  const before = bytes(fx)
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.equal(output.length, 1)
    assert.match(output[0], new RegExp(`^refused ${key}: .*content appears nowhere .*rot, not a shift`))
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('repair-all refuses an ambiguous named pin without writing', () => {
  // Mutation killed: accepting named ambiguity in repair would guess which live line a name identifies.
  const key = 'crew/sample.mjs@named-ambiguous-cli'
  const fx = fixture({ source: ['// header', `const ${EXPECTED}`, `const twin = "${EXPECTED}"`, 'export default KEY', ''], named: { key, expected: EXPECTED } })
  const before = bytes(fx)
  const output = []
  try {
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.equal(output.length, 1)
    assert.match(output[0], new RegExp(`^refused ${key}: .*content occurs 2 times`))
    assert.equal(bytes(fx), before)
  } finally {
    dispose(fx)
  }
})

test('A1', () => {
  const fx = authoritativeFixture('b619-anchor-test-a1-')
  try {
    const output = []
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    const next = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(next['scripts/a.mjs:2'], EXPECTED_A)
    assert.equal(next['scripts/b.mjs:1'], EXPECTED_B)
    assert.equal(Object.hasOwn(next, 'scripts/b.mjs:2'), false)
    assert.match(readFileSync(fx.doc, 'utf8'), /scripts\/b\.mjs:1/)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('B1', () => {
  const fx = shiftedContractFixture('b619-anchor-test-b1-')
  try {
    const repoRoot = realpathSync(fx.root)
    git(repoRoot, 'init', '--quiet')
    git(repoRoot, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(repoRoot, 'add', '.')
    git(repoRoot, 'commit', '--quiet', '-m', 'stale pin without remote base')
    const before = bytes(fx)
    const output = []
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', repoRoot], output.push.bind(output)), 1)
    assert.deepEqual(output, ['refused anchor repair fence unmeasured (no merge base with origin/main)'])
    assert.equal(bytes(fx), before)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('C1', () => {
  const fx = authoritativeFixture('b619-anchor-test-c1-')
  try {
    const output = []
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    const row = output.find((line) => line.startsWith('ANCHOR_REPAIR_ROW '))
    assert.ok(row, output.join('\n'))
    assert.equal(JSON.parse(row.slice('ANCHOR_REPAIR_ROW '.length)).base, 'origin/main')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('D1', () => {
  const fx = shiftedContractFixture('b619-anchor-test-d1-')
  try {
    const output = []
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    const next = JSON.parse(readFileSync(fx.manifestPath, 'utf8'))
    assert.equal(next['scripts/a.mjs:2'], EXPECTED_A)
    assert.equal(output[0].endsWith('"base":null,"base_commit":null}'), true)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('E1', () => {
  const fx = authoritativeFixture('b619-anchor-test-e1-')
  try {
    const output = []
    assert.equal(repairCli(['--repair', fx.skillDir, '--root', fx.root], output.push.bind(output)), 0)
    const row = output.find((line) => line.startsWith('ANCHOR_REPAIR_ROW '))
    assert.ok(row, output.join('\n'))
    const parsed = JSON.parse(row.slice('ANCHOR_REPAIR_ROW '.length))
    // the row names the COMMIT the repair was measured against, not only the symbolic ref,
    // so an over-wide repair can be audited after the fact. It is a per-run sha.
    assert.match(String(parsed.base_commit), /^[0-9a-f]{40}$/, 'the audit row names its base commit')
    assert.deepEqual({ ...parsed, base_commit: undefined }, {
      manifest: 'skills/sample/anchors.json',
      pin: 'scripts/a.mjs:1',
      old_line: 1,
      new_line: 2,
      base: 'origin/main',
      base_commit: undefined,
    })
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('F1.rot', () => {
  const root = scratchDir('b619-anchor-test-f1-rot-')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/a.mjs'), "const OTHER = 'not-the-anchor'\n")
  const fx = contractSkill(root, { 'scripts/a.mjs:1': EXPECTED_A })
  const before = bytes(fx)
  try {
    const output = []
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.equal(output.length, 1)
    assert.match(output[0], /rot, not a shift/)
    assert.equal(bytes(fx), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('F1.ambiguity', () => {
  const root = scratchDir('b619-anchor-test-f1-ambiguity-')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts/a.mjs'), `${EXPECTED_A}\n${EXPECTED_A}\n`)
  const fx = contractSkill(root, { 'scripts/a.mjs:3': EXPECTED_A }, ['scripts/a.mjs:3'])
  const before = bytes(fx)
  try {
    const output = []
    assert.equal(repairCli(['--repair-all', fx.skillDir, '--root', fx.root], output.push.bind(output)), 1)
    assert.equal(output.length, 1)
    assert.match(output[0], /refuses to guess/)
    assert.equal(bytes(fx), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
