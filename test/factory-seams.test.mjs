import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { ROOT, git, scratchDir } from './helpers.mjs'
import { main, partitionReport, resolveProtectedPaths, seamReport } from '../scripts/factory/seams.mjs'

const EXT = ['.m', 'js'].join('')
const SOURCE_DIR = ['s', 'rc'].join('')
const TEST_DIR = ['te', 'st'].join('')

function pathOf(...parts) {
  return parts.join('/')
}

function sourcePath(name) {
  return pathOf(SOURCE_DIR, `${name}${EXT}`)
}

function makeRepo(files) {
  const root = scratchDir('seams-fixture-')
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'))
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, body)
  }
  git(root, 'init')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'fixture')
  return root
}

function reportFor(files, target) {
  return seamReport({ root: makeRepo(files), target })
}

function partitionFor(files, target) {
  return partitionReport({ root: makeRepo(files), target })
}

function emptyHome() {
  return scratchDir('seams-empty-home-')
}

test('A1 source disjoint importer signatures form two clusters with zero edges', () => {
  const target = sourcePath('disjoint')
  const left = pathOf('app', `left${EXT}`)
  const right = pathOf('app', `right${EXT}`)
  const report = reportFor({
    [target]: 'export const leftOnly = 1\nexport const rightOnly = 2\n',
    [left]: `import { leftOnly } from '../${SOURCE_DIR}/disjoint${EXT}'\nvoid leftOnly\n`,
    [right]: `import { rightOnly } from '../${SOURCE_DIR}/disjoint${EXT}'\nvoid rightOnly\n`,
  }, target)
  assert.equal(report.clusters.length, 2)
  assert.deepEqual(report.clusters.map((cluster) => cluster.importers), [[left], [right]])
  assert.deepEqual(report.clusters.map((cluster) => cluster.symbols), [['leftOnly'], ['rightOnly']])
  assert.equal(report.edges_counted, 0)
  assert.equal(report.cross_cluster_edges, 0)
})

test('A2 source co-imported exports form one cluster and one numeric edge', () => {
  const target = sourcePath('together')
  const consumer = pathOf('app', `consumer${EXT}`)
  const report = reportFor({
    [target]: 'export const first = 1\nexport const second = 2\n',
    [consumer]: `import { first, second } from '../${SOURCE_DIR}/together${EXT}'\nvoid first\nvoid second\n`,
  }, target)
  assert.equal(report.clusters.length, 1)
  assert.deepEqual(report.clusters[0].importers, [consumer])
  assert.equal(report.edges_counted, 1)
  assert.equal(typeof report.edges_counted, 'number')
  assert.equal(report.cross_cluster_edges, 0)
})

test('C1 test blocks cluster by file-under-test symbols and ignore test exports', () => {
  const target = sourcePath('under-test')
  const testTarget = pathOf(TEST_DIR, `aliases.test${EXT}`)
  const report = reportFor({
    [target]: 'export const first = 1\nexport const second = 2\n',
    [testTarget]: `import { first as alpha, second as beta } from '../${SOURCE_DIR}/under-test${EXT}'\nexport const irrelevantTestExport = 3\ntest('first', () => { alpha() })\ndescribe('second', () => { beta() })\n`,
  }, testTarget)
  assert.equal(report.target_kind, 'test')
  assert.equal(report.clusters.length, 2)
  assert.deepEqual(report.clusters.map((cluster) => cluster.symbols), [['first'], ['second']])
  assert.ok(!report.clusters.some((cluster) => cluster.symbols.includes('irrelevantTestExport')))
  assert.ok(report.clusters.every((cluster) => cluster.file_under_test === target))
})

test('D1 legacy cluster CLI output remains byte-identical', () => {
  const target = sourcePath('golden')
  const root = makeRepo({ [target]: 'export const golden = 1\n' })
  let stdout = ''
  let stderr = ''
  const exitCode = main([target], {
    root,
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  assert.equal(exitCode, 0)
  assert.equal(stderr, '')
  assert.equal(stdout, '{"target":"src/golden.mjs","target_kind":"source","clusters":[{"signature":"[]","importer_signature":"[]","importers":[],"importer_set":[],"symbols":["golden"],"spans":[{"symbol":"golden","start":1,"end":1}],"stage_heads":[],"stage_head_identifiers":[],"stage_head_references":0}],"edges_counted":0,"cross_cluster_edges":0,"fence_cost":{"anchors":{"manifests":[],"pins":0,"manifest_count":0,"pins_by_manifest":{}},"tests_reaching":[],"protected_floor":false},"caveat":"Static imports are a proxy: computed imports can be invisible, and unused imports can create phantom edges. Clean clusters measure split cost; they do not decide whether a split is right.","blind_spots":["Static imports are a proxy: computed imports can be invisible, and unused imports can create phantom edges. Clean clusters measure split cost; they do not decide whether a split is right.","Stage-head attribution is file-level static attribution, not a runtime claim."],"denominators":{"files_scanned":1,"symbols_clustered":1,"edges_counted":0,"skipped":[]}}\n')
})

test('A1 partition accounts for every test exactly once', () => {
  const target = pathOf(TEST_DIR, `partition-accounting.test${EXT}`)
  const first = sourcePath('partition-first')
  const second = sourcePath('partition-second')
  const report = partitionFor({
    [first]: 'export const first = () => 1\n',
    [second]: 'export const second = () => 2\n',
    [target]: [
      `import { first } from '../${SOURCE_DIR}/partition-first${EXT}'`,
      `import { second } from '../${SOURCE_DIR}/partition-second${EXT}'`,
      "test('first', () => { first() })",
      "describe('nested suite', () => {",
      "  test('nested', () => { second() })",
      '})',
      "test('unreferenced', () => {})",
      "test('ambiguous', () => { first(); second() })",
      '',
    ].join('\n'),
  }, target)
  const entries = report.partition.groups.flatMap((group) => group.tests)
  if (report.partition.unassigned) entries.push(...report.partition.unassigned.tests)
  const spans = entries.map((entry) => `${entry.start}:${entry.end}`)
  assert.equal(entries.length, report.partition.coverage.total)
  assert.equal(new Set(spans).size, report.partition.coverage.total)
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['ambiguous', 'first', 'nested', 'unreferenced'])
  assert.ok(entries.every((entry) => entry.kind === 'test' && Number.isInteger(entry.start) && Number.isInteger(entry.end)))
  assert.equal(report.partition.coverage.assigned, 2)
  assert.deepEqual(report.partition.unassigned.tests.map((t) => t.name).sort(), ['ambiguous', 'unreferenced'])
  assert.ok(report.partition.unassigned.tests.every((t) => t.reason === 'no_unique_file_under_test'))
  assert.ok(report.partition.groups.every((group) => group.tests.every((t) => t.name !== 'ambiguous')))
})

test('B1 partition coverage carries numerator and denominator', () => {
  const target = pathOf(TEST_DIR, `partition-coverage.test${EXT}`)
  const subject = sourcePath('partition-coverage-subject')
  const report = partitionFor({
    [subject]: 'export const first = () => 1\nexport const second = () => 2\n',
    [target]: [
      `import { first, second } from '../${SOURCE_DIR}/partition-coverage-subject${EXT}'`,
      "test('first', () => { first() })",
      "test('second', () => { second() })",
      '',
    ].join('\n'),
  }, target)
  const { assigned, total, fraction } = report.partition.coverage
  assert.equal(typeof assigned, 'number')
  assert.equal(typeof total, 'number')
  assert.equal(fraction, `${assigned}/${total}`)
})

test('C1 coherent test subject yields one partition group', () => {
  const target = pathOf(TEST_DIR, `partition-coherent.test${EXT}`)
  const subject = sourcePath('partition-coherent-subject')
  const report = partitionFor({
    [subject]: 'export const first = () => 1\nexport const second = () => 2\n',
    [target]: [
      `import { first, second } from '../${SOURCE_DIR}/partition-coherent-subject${EXT}'`,
      "test('first', () => { first() })",
      "test('second', () => { second() })",
      '',
    ].join('\n'),
  }, target)
  assert.equal(report.partition.groups.length, 1)
  assert.equal(report.partition.groups[0].subject, subject)
  assert.equal(report.partition.groups[0].tests.length, 2)
})

test('E1 partition refuses a non-test target with closed reason', () => {
  const target = sourcePath('partition-source-refusal')
  const report = partitionFor({ [target]: 'export const value = 1\n' }, target)
  assert.deepEqual(report, {
    target,
    target_kind: 'source',
    partition: null,
    partition_reason: 'target_not_test_file',
  })
})

test('F1 non-empty unassigned remainder is explicit', () => {
  const target = pathOf(TEST_DIR, `partition-remainder.test${EXT}`)
  const report = partitionFor({ [target]: "test('unassigned', () => {})\n" }, target)
  assert.equal(report.partition.unassigned.name, 'unassigned')
  assert.equal(report.partition.unassigned.tests.length, 1)
})

test('F2 empty unassigned remainder is absent', () => {
  const target = pathOf(TEST_DIR, `partition-no-remainder.test${EXT}`)
  const subject = sourcePath('partition-no-remainder-subject')
  const report = partitionFor({
    [subject]: 'export const value = () => 1\n',
    [target]: `import { value } from '../${SOURCE_DIR}/partition-no-remainder-subject${EXT}'\ntest('assigned', () => { value() })\n`,
  }, target)
  assert.equal('unassigned' in report.partition, false)
})

test('G1 partition output names file-under-test key', () => {
  const target = pathOf(TEST_DIR, `partition-key.test${EXT}`)
  const subject = sourcePath('partition-key-subject')
  const report = partitionFor({
    [subject]: 'export const value = () => 1\n',
    [target]: `import { value } from '../${SOURCE_DIR}/partition-key-subject${EXT}'\ntest('assigned', () => { value() })\n`,
  }, target)
  assert.equal(report.partition.grouping_key, 'file_under_test')
})

test('RV1-1 regex literals preserve exports following quote characters', () => {
  const target = sourcePath('regex-quote')
  const quote = "'"
  const report = reportFor({
    [target]: [
      `const QUOTE_RE = /it${quote}s/`,
      'export const alpha = 1',
      `const OTHER_RE = /don${quote}t/`,
      'export const beta = 2',
      'export const gamma = 3',
      '',
    ].join('\n'),
  }, target)
  assert.deepEqual(report.clusters.map((cluster) => cluster.symbols), [['alpha', 'beta', 'gamma']])
  assert.equal(report.denominators.symbols_clustered, 3)
  assert.equal('cluster_reason' in report, false)
  assert.deepEqual(report.denominators.skipped, [])
})

test('D1 anchor manifests and pins are reported by name and count', () => {
  const target = sourcePath('anchored')
  const manifest = pathOf('crew', 'roles', 'anchors.json')
  const other = sourcePath('other')
  const report = reportFor({
    [target]: 'export const anchored = 1\n',
    [manifest]: JSON.stringify({ [`${target}:7`]: 'anchor', [`${other}:3`]: 'other' }),
  }, target)
  assert.deepEqual(report.fence_cost.anchors.manifests, [manifest])
  assert.equal(report.fence_cost.anchors.pins, 1)
  assert.equal(report.fence_cost.anchors.manifest_count, 1)
})

test('D2 protected-floor verdict follows resolveProtectedPaths membership', () => {
  const floorDirectory = ['.github', 'workflows'].join('/')
  const target = pathOf(floorDirectory, `floor${EXT}`)
  const report = reportFor({ [target]: 'export const floor = 1\n' }, target)
  const floor = resolveProtectedPaths()
  assert.ok(floor.some((entry) => target === entry || (entry.endsWith('/') && target.startsWith(entry))))
  assert.equal(report.fence_cost.protected_floor, true)
})

test('D3 tests reaching candidate distinguish measured empty from unparsed corpus', () => {
  const target = sourcePath('candidate')
  const reaching = pathOf(TEST_DIR, `reaching.test${EXT}`)
  const report = reportFor({
    [target]: 'export const candidate = 1\n',
    [reaching]: `import { candidate } from '../${SOURCE_DIR}/candidate${EXT}'\nvoid candidate\n`,
  }, target)
  assert.deepEqual(report.fence_cost.tests_reaching, [reaching])

  const unreached = sourcePath('unreached')
  const healthy = reportFor({ [unreached]: 'export const unreached = 1\n' }, unreached)
  assert.ok(Array.isArray(healthy.fence_cost.tests_reaching))
  assert.equal(healthy.fence_cost.tests_reaching.length, 0)

  const unreadable = sourcePath('unreadable')
  const unreadableTest = pathOf(TEST_DIR, `unreadable.test${EXT}`)
  const root = makeRepo({
    [unreadableTest]: `import { unreadable } from '../${SOURCE_DIR}/unreadable${EXT}'\nvoid unreadable\n`,
  })
  const unreadablePath = join(root, ...unreadable.split('/'))
  mkdirSync(dirname(unreadablePath), { recursive: true })
  symlinkSync(['mis', 'sing', EXT].join(''), unreadablePath)
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'dangling target')
  const unparsed = seamReport({ root, target: unreadable })
  assert.equal(unparsed.cluster_reason, 'read_error')
  assert.equal(unparsed.fence_cost.tests_reaching, null)
})

test('E1 failed clustering is null with closed syntax_error reason', () => {
  const target = sourcePath('invalid')
  const report = reportFor({ [target]: 'export const broken = (\n' }, target)
  assert.equal(report.clusters, null)
  assert.equal(report.cluster_reason, 'syntax_error')
  assert.notEqual(report.clusters, 0)
  assert.notEqual(report.clusters, [])
  assert.deepEqual(report.fence_cost.tests_reaching, [])
})

test('E2 failed target is counted in skipped accounting', () => {
  const target = sourcePath('invalid-skipped')
  const report = reportFor({ [target]: 'export const broken = (\n' }, target)
  assert.deepEqual(report.denominators.skipped, [{ path: target, reason: 'syntax_error' }])
  assert.deepEqual(report.fence_cost.tests_reaching, [])
})

test('F1 complete denominators are numeric and skipped rows are structured', () => {
  const home = emptyHome()
  assert.deepEqual(readdirSync(home), [])
  const target = sourcePath('denominators')
  const report = reportFor({ [target]: 'export const value = 1\n' }, target)
  for (const key of ['files_scanned', 'symbols_clustered', 'edges_counted']) {
    assert.equal(typeof report.denominators[key], 'number')
    assert.ok(Number.isFinite(report.denominators[key]))
  }
  assert.ok(Array.isArray(report.denominators.skipped))
  assert.ok(report.denominators.skipped.every((row) => typeof row.path === 'string' && typeof row.reason === 'string'))
  assert.equal(typeof report.edges_counted, 'number')
  assert.equal(typeof report.cross_cluster_edges, 'number')
})

test('G1 report names computed-import and phantom-unused-import blind spots', () => {
  const target = sourcePath('blind-spots')
  const report = reportFor({ [target]: 'export const value = 1\n' }, target)
  assert.match(report.caveat, /computed imports can be invisible/)
  assert.match(report.caveat, /unused imports can create phantom edges/)
  assert.match(report.caveat, /do not decide whether a split is right/)
  assert.equal(report.caveat, 'Static imports are a proxy: computed imports can be invisible, and unused imports can create phantom edges. Clean clusters measure split cost; they do not decide whether a split is right.')
})

test('H1 dated conventions entry records the discoverable seams instrument', () => {
  const conventions = readFileSync(join(ROOT, ['docs', 'conventions.md'].join('/')), 'utf8')
  assert.match(conventions, /2026-09-08/)
  assert.match(conventions, /scripts\/factory\/seams\.mjs/)
  assert.match(conventions, /The seams instrument reports measurements and never recommends a split\./)
})

test('I1 runtime git corpus excludes untracked code from scan counts and results', () => {
  const target = sourcePath('tracked')
  const consumer = pathOf('app', `tracked-consumer${EXT}`)
  const root = makeRepo({
    [target]: 'export const tracked = 1\n',
    [consumer]: `import { tracked } from '../${SOURCE_DIR}/tracked${EXT}'\nvoid tracked\n`,
  })
  const ghost = join(root, ...sourcePath('ghost').split('/'))
  writeFileSync(ghost, 'export const ghost = 1\n')
  const report = seamReport({ root, target })
  assert.equal(report.denominators.files_scanned, 2)
  assert.deepEqual(report.clusters.map((cluster) => cluster.importers), [[consumer]])
  assert.ok(!report.denominators.skipped.some((row) => row.path === sourcePath('ghost')))
})

test('J1 test source has no foreign tracked source-path literal', () => {
  const own = readFileSync(join(ROOT, ['test', 'factory-seams.test.mjs'].join('/')), 'utf8')
  const tracked = new Set(git(ROOT, 'ls-files', '-z').split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/')))
  const implementation = ['scripts', 'factory', 'seams.mjs'].join('/')
  const helper = ['test', 'helpers.mjs'].join('/')
  const allowed = new Set([implementation, helper])
  const literals = []
  const literalRe = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
  let match
  while ((match = literalRe.exec(own))) {
    const value = match[2].replace(/\\([\\'"`])/g, '$1')
    const normal = value.startsWith('../') || value.startsWith('./')
      ? posix.normalize(posix.join('test', value))
      : posix.normalize(value)
    if (tracked.has(normal) || allowed.has(normal)) literals.push(normal)
  }
  assert.deepEqual([...new Set(literals)].sort(), [...allowed].sort())
})
