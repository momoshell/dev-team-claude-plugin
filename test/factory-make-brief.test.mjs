// test/factory-make-brief.test.mjs — the unskippable, filesystem-only lane for
// the brief compiler. Every fixture is a staged git checkout in one temporary
// module root; no live crew tree is read or written.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { git, ROOT } from './helpers.mjs'
import {
  ACCEPTANCE_GATE_BLOCK, BROAD_KEY_HIT_LIMIT, CONVENTIONS_BLOCK, DEFAULT_PROTECTED_PATHS,
  DIRECTED_BLOCK, DIRECTED_GATE_NOTE, DIRECTED_KEYS, HOSTILE_ENV_BLOCK, LADDER_BANDS, OPTIONAL_REQUEST_KEYS,
  REFUSAL_REASONS, SLOT_MARKER, TIER_NAMES, crossCheckCoupling, readsToAcknowledge,
  discoverTripwires, exportEntries, extractKeys, extractSymbols, gatherFences, gatherProtectedPaths, isTripwireFile, main,
  MUTATION_CONTRACT_BLOCK, PACK_ABSENT_REASONS, PROPOSAL_BLOCK, PROPOSAL_KEYS, profileField, proposeTier,
  readLadderBands, renderBrief, renderProposalBlock, resolveIntent, resolveWriteSurface, SYMBOL_INDEX_ENTRY_LIMIT,
  SYMBOL_INDEX_ABSENT_REASONS, testTitleEntries, validateAsk, writePack,
  validateRequest, validateScopeEntries, verifyCreates, verifyWhere,
} from '../scripts/factory/make-brief.mjs'
import { PROPOSAL_BLOCK as EMIT_PROPOSAL_BLOCK, PROPOSAL_KEYS as EMIT_PROPOSAL_KEYS } from '../scripts/factory/emit.mjs'
import { defaultProfilePath, probeRepo } from '../scripts/factory/probe-repo.mjs'
import { CHECK_FAIL_PREFIX, DIRECTED_BLOCK as DRIVE_DIRECTED_BLOCK, DIRECTED_KEYS as DRIVE_DIRECTED_KEYS, MUTATIONS_MAX, parseDirectedBrief } from '../crew/drive.mjs'
import { PROTECTED_PATHS } from '../crew/protected-paths.mjs'

const SCRIPT = join(ROOT, 'scripts', 'factory', 'make-brief.mjs')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-make-brief-'))
const EMPTY_FACTORY = join(fixtureRoot, 'empty-factory')
mkdirSync(EMPTY_FACTORY)
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

let fixtureNumber = 0
function nextRoot(label) {
  fixtureNumber += 1
  const root = join(fixtureRoot, `${String(fixtureNumber).padStart(2, '0')}-${label}`)
  mkdirSync(root, { recursive: true })
  return root
}

function put(root, relative, body) {
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  return target
}

function fixture(label, {
  scripts = 'node --test', broad = false, coupledCaller = false, broadSources = false,
  citingComment = false,
} = {}) {
  const root = nextRoot(label)
  const packageData = { name: `brief-${label}`, private: true, type: 'module' }
  if (scripts !== null) packageData.scripts = { test: scripts }
  put(root, 'package.json', `${JSON.stringify(packageData, null, 2)}\n`)
  put(root, 'lib/widget.mjs', [
    "export const WIDGET_CACHE_FILE = 'out/widget.json'",
    "export function computeWidget(n) { return n + 1 }",
    "export { computeWidget as computeWidgetAlias }",
    "const error = 'cache:miss'",
    'void error',
    '',
  ].join('\n'))
  put(root, 'config/thing.yml', 'ttl_seconds: 30\n')
  if (coupledCaller) {
    put(root, 'lib/caller.mjs', [
      "import { computeWidget } from './widget.mjs'",
      'export function callWidget(n) { return computeWidget(n) }',
      '',
    ].join('\n'))
  }
  put(root, 'test/widget.test.mjs', [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { computeWidget } from '../lib/widget.mjs'",
    "test('computeWidget adds one', () => { assert.equal(computeWidget(1), 2) })",
    '',
  ].join('\n'))
  put(root, 'test/reads-config.test.mjs', [
    "import { test } from 'node:test'",
    "import { readFileSync } from 'node:fs'",
    "test('config path is pinned', () => { readFileSync('config/thing.yml', 'utf8') })",
    '',
  ].join('\n'))
  if (citingComment) {
    put(root, 'lib/cites.js', [
      '// The cache shape is owned by lib/widget.mjs; keep this reader in step.',
      'export const READER_VERSION = 2',
      '',
    ].join('\n'))
  }
  if (broad || broadSources) {
    put(root, 'lib/broad.mjs', "export const BROAD_PIN = 'out/broad.json'\n")
  }
  if (broad) {
    for (let index = 0; index < BROAD_KEY_HIT_LIMIT + 2; index += 1) {
      put(root, `test/broad-${String(index).padStart(2, '0')}.test.mjs`, [
        "import { test } from 'node:test'",
        "import { BROAD_PIN } from '../lib/broad.mjs'",
        `test('broad pin ${index}', () => { void BROAD_PIN })`,
        '',
      ].join('\n'))
    }
  }
  if (broadSources) {
    for (let index = 0; index < BROAD_KEY_HIT_LIMIT + 2; index += 1) {
      put(root, `lib/broad-${String(index).padStart(2, '0')}.mjs`, [
        "import { BROAD_PIN } from './broad.mjs'",
        `export const BROAD_SOURCE_${index} = BROAD_PIN`,
        '',
      ].join('\n'))
    }
  }
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  return root
}

const ASK = 'Make the widget cache honour a 30s TTL — never round it, never "fix" the units.'
const DONE = 'A widget older than 30s is refetched, and the refetch reason is recorded verbatim.\nThe reason keeps punctuation.'
const OUT = 'The retry backoff (owned by another lane) and the schema of config/thing.yml.'

function request(root, overrides = {}, name = 'request.json') {
  const body = { ask: ASK, where: ['lib/widget.mjs', 'config/thing.yml'], done_means: DONE, out_of_scope: OUT, ...overrides }
  return put(root, name, `${JSON.stringify(body, null, 2)}\n`)
}

function run(root, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_FACTORY_DIR: EMPTY_FACTORY, ...env },
  })
}

function compile(root, overrides = {}, extra = [], outName = 'brief.md', env = {}) {
  const requestPath = request(root, overrides)
  const outPath = join(root, outName)
  const result = run(root, ['--request', requestPath, '--checkout', root, '--out', outPath, ...extra], env)
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  return { result, outPath, brief: readFileSync(outPath, 'utf8') }
}

let committedFixtureNumber = 0
function committedFixture(label) {
  committedFixtureNumber += 1
  const root = nextRoot(`committed-${label}`)
  const marker = join(fixtureRoot, `${String(committedFixtureNumber).padStart(2, '0')}-${label}.marker`)
  rmSync(marker, { force: true })
  const command = `printf ran >> "${marker}"; printf "pass 7\\nfail 0\\n"`
  put(root, 'package.json', `${JSON.stringify({
    name: `committed-${label}`, private: true, type: 'module', scripts: { test: command },
  }, null, 2)}\n`)
  put(root, 'lib/widget.mjs', "export const WIDGET_CACHE_FILE = 'out/widget.json'\n")
  put(root, 'test/widget.test.mjs', "test('fixture test', () => {})\n")
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'factory@test.invalid')
  git(root, 'config', 'user.name', 'factory test')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'fixture')
  const sha = git(root, 'rev-parse', 'HEAD').trim()
  return { root, marker, command, sha }
}

let committedCompileNumber = 0
function compileCommitted(fx, extra = []) {
  committedCompileNumber += 1
  const requestPath = join(fixtureRoot, `${String(committedCompileNumber).padStart(2, '0')}-${committedCompileNumber}.request.json`)
  const outPath = join(fixtureRoot, `${String(committedCompileNumber).padStart(2, '0')}-${committedCompileNumber}.brief.md`)
  writeFileSync(requestPath, `${JSON.stringify({
    ask: ASK, where: ['lib/widget.mjs'], done_means: DONE, out_of_scope: OUT,
  }, null, 2)}\n`)
  const result = run(fx.root, [
    '--request', requestPath, '--checkout', fx.root, '--out', outPath,
    '--profile', join(fixtureRoot, 'missing-profile.json'), ...extra,
  ])
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  return { result, outPath, brief: readFileSync(outPath, 'utf8') }
}

function suppliedBaseline(label, value) {
  const path = join(fixtureRoot, `${label}.baseline.json`)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

function section(brief, heading) {
  const lines = brief.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  assert.notEqual(start, -1, `missing ${heading}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

function proposalFor(sourceCount, protectedPaths = []) {
  return proposeTier({
    where: Array.from({ length: sourceCount }, (_, index) => ({ path: `lib/source-${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: sourceCount }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths,
  })
}

function compiledProposal(proposal) {
  return renderBrief({
    request: { ask: 'ask', done_means: 'done', out_of_scope: 'out' },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
    proposal,
  })
}

function ratified(value) {
  return {
    status: 'ratified',
    value,
    source: 'test fixture',
    ratified_by: 'factory test',
    ratified_at: '2026-08-17T00:00:00.000Z',
  }
}

function proposed(value) {
  return { status: 'proposed', value, source: 'test fixture' }
}

function unknown(reason = 'no_test_command') {
  return { status: 'unknown', value: null, reason }
}

function profile(label, fields) {
  const path = join(fixtureRoot, 'profiles', `${label}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: `fixture__${label}`,
    repo_slug: label,
    fields,
    meta: { probed_at: '2026-08-17T00:00:00.000Z', probed_from: fixtureRoot },
  }, null, 2)}\n`)
  return path
}

test('the four authored lines are carried verbatim and compilation is idempotent', () => {
  const root = fixture('verbatim')
  const first = compile(root, {}, [], 'first.md').brief
  const second = compile(root, {}, [], 'second.md').brief
  for (const line of [ASK, DONE, OUT]) assert.ok(first.includes(line))
  assert.ok(first.includes('lib/widget.mjs'))
  assert.match(first, /## Proposed tier/)
  assert.equal((first.match(/^```proposal$/gm) || []).length, 1)
  assert.equal(first, second)
})

test('pack mode moves boilerplate to sidecars and preserves the inline verdict', () => {
  const root = fixture('pack-basic', { coupledCaller: true })
  const issueBody = 'Issue body line one.\nIssue body line two.'
  const issue = put(root, 'issue-body.md', `${issueBody}\n`)
  const journal = put(root, 'journal.jsonl', '{"event":"plan"}\n{"event":"build"}\n')
  const ask = `#123 Move the widget cache contract into a smaller brief and point at sidecars. Journal: ${journal}`
  const bareBefore = compile(root, { ask: ASK }, [], 'bare-before.md').brief
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const packed = compile(root, { ask }, ['--pack', pack, '--issue-body', issue], 'packed.brief.md').brief
  const unpacked = compile(root, { ask }, [], 'unpacked.md').brief
  const bareAfter = compile(root, { ask: ASK }, [], 'bare-after.md').brief
  const vocabulary = join(pack, 'packed.tripwires.txt')
  const rows = join(pack, 'packed.tripwires.md')
  const conventions = join(pack, 'packed.conventions.md')
  const fixturePath = join(pack, 'fixtures', 'packed.jsonl')
  const context = section(packed, '## Context pack')
  for (const path of [vocabulary, rows, conventions, fixturePath]) assert.equal(existsSync(path), true, path)
  assert.equal(readFileSync(rows, 'utf8'), `${section(unpacked, '## Tripwires')}\n`)
  assert.equal(readFileSync(fixturePath, 'utf8'), '{"event":"plan"}\n{"event":"build"}\n')
  assert.doesNotMatch(packed, /declare every hit:/)
  assert.doesNotMatch(packed, new RegExp(CONVENTIONS_BLOCK.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  assert.match(unpacked, /declare every hit:/)
  assert.ok(unpacked.includes(CONVENTIONS_BLOCK))
  assert.equal(bareAfter, bareBefore)
  const vocabularyLines = readFileSync(vocabulary, 'utf8').trim().split('\n')
  assert.ok(vocabularyLines.length > 0)
  assert.equal(vocabularyLines.some((line) => line.includes('\\|')), false)
  assert.ok(packed.includes(vocabulary))
  assert.ok(packed.includes(`grep -rn -f ${vocabulary}`))
  assert.ok(packed.includes(rows))
  assert.ok(packed.includes(`cat ${rows}`))
  assert.ok(packed.includes(conventions))
  assert.ok(packed.includes(`cat ${conventions}`))
  assert.equal(packed.split(issueBody).length - 1, 1)
  assert.ok(context.includes(`--- ISSUE 123 BODY ---\n${issueBody}\n--- END ISSUE 123 BODY ---`))
  for (const [file, label] of [
    ['lib/widget.mjs', 'in fence'],
    ['config/thing.yml', 'in fence'],
    ['lib/caller.mjs', 'coupled'],
  ]) {
    const count = readFileSync(join(root, file), 'utf8').split('\n').length
    assert.ok(context.includes(`- ${file} · ${count} lines · ${label}`), file)
  }
  for (const dir of ['config', 'lib']) {
    const entries = readdirSync(join(root, dir), { withFileTypes: true })
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort()
    assert.ok(context.includes(`- ${dir}/ · ${entries.join(', ')}`), dir)
  }
})

test('packed context indexes exported declarations and fenced test titles with lines', () => {
  const root = fixture('symbol-index-kinds')
  put(root, 'lib/kinds.mjs', [
    'export const KINDS_CONST = 1',
    'export function kindsFunction() {}',
    'export let kindsLet = 2',
    'export class KindsClass {}',
    'const kindsInner = 3',
    'export { kindsInner as kindsAlias }',
    '',
  ].join('\n'))
  put(root, 'test/kinds.test.mjs', [
    "import { test, describe } from 'node:test'",
    "describe('kinds group', () => {",
    "  test(\"kinds function\", () => {})",
    '})',
    '',
  ].join('\n'))
  git(root, 'add', '-A')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({ lanes: [
    { lane: 'own', files: ['lib/kinds.mjs', 'test/kinds.test.mjs'] },
  ] }, null, 2)}\n`)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const { brief } = compile(root, { where: ['lib/kinds.mjs'] }, [
    '--fences', fencesPath, '--lane', 'own', '--pack', pack,
  ], 'kinds.brief.md')
  const context = section(brief, '## Context pack')
  assert.ok(context.includes('- lib/kinds.mjs · exports · KINDS_CONST:1, kindsFunction:2, kindsLet:3, KindsClass:4, kindsAlias:6'))
  assert.ok(context.includes('- test/kinds.test.mjs · test titles · kinds group:2, kinds function:3'))
  const symbols = join(pack, 'kinds.symbols.md')
  assert.equal(existsSync(symbols), true)
  assert.ok(readFileSync(symbols, 'utf8').includes('KINDS_CONST:1'))
})

test('the symbol index records closed absences and does not invent export rows', () => {
  const root = fixture('symbol-index-absences')
  put(root, 'lib/not-utf8.mjs', `export const brokenSymbol = 1\n${String.fromCharCode(0)}\n`)
  put(root, 'lib/missing.mjs', 'export const missingSymbol = 1\n')
  git(root, 'add', '-A')
  rmSync(join(root, 'lib/missing.mjs'))
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({ lanes: [
    { lane: 'own', files: ['lib/missing.mjs', 'lib/not-utf8.mjs'] },
  ] }, null, 2)}\n`)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const { brief } = compile(root, { where: ['lib/not-utf8.mjs'] }, [
    '--fences', fencesPath, '--lane', 'own', '--pack', pack,
  ], 'absences.brief.md')
  const context = section(brief, '## Context pack')
  assert.deepEqual(new Set(SYMBOL_INDEX_ABSENT_REASONS), new Set(['unreadable', 'not-text']))
  assert.ok(context.includes('- lib/missing.mjs · unindexed · unreadable'))
  assert.ok(context.includes('- lib/not-utf8.mjs · unindexed · not-text'))
  assert.equal(context.includes('lib/missing.mjs · exports ·'), false)
  assert.equal(context.includes('lib/not-utf8.mjs · exports ·'), false)
})

test('the inline symbol index is bounded while its sidecar retains the cut entries', () => {
  const root = fixture('symbol-index-bound')
  const count = SYMBOL_INDEX_ENTRY_LIMIT + 3
  put(root, 'lib/big.mjs', `${Array.from({ length: count }, (_, index) => `export const boundSymbol${String(index).padStart(3, '0')} = ${index}`).join('\n')}\n`)
  git(root, 'add', '-A')
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const { brief } = compile(root, { where: ['lib/big.mjs'] }, ['--pack', pack], 'bound.brief.md')
  const context = section(brief, '## Context pack')
  const row = context.split('\n').find((line) => line.startsWith('- lib/big.mjs · exports · '))
  assert.ok(row)
  assert.equal(row.slice('- lib/big.mjs · exports · '.length).split(', ').length, SYMBOL_INDEX_ENTRY_LIMIT)
  const sidecar = join(pack, 'bound.symbols.md')
  assert.ok(context.includes(`… and 3 more — full index: ${sidecar}`))
  assert.ok(readFileSync(sidecar, 'utf8').includes('boundSymbol202:203'))
})

test('the inline symbol index shares one per-file budget between exports and test titles', () => {
  const root = fixture('symbol-index-mixed-budget')
  const file = 'test/mixed.test.mjs'
  const exportCount = SYMBOL_INDEX_ENTRY_LIMIT + 1
  const titleCount = SYMBOL_INDEX_ENTRY_LIMIT
  put(root, file, [
    ...Array.from({ length: exportCount }, (_, index) => `export const mixedHelper${String(index).padStart(3, '0')} = ${index}`),
    ...Array.from({ length: titleCount }, (_, index) => `test('mixed title ${String(index).padStart(3, '0')}', () => {})`),
    '',
  ].join('\n'))
  git(root, 'add', '-A')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({ lanes: [
    { lane: 'own', files: [file] },
  ] }, null, 2)}\n`)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const { brief } = compile(root, { where: [file] }, [
    '--fences', fencesPath, '--lane', 'own', '--pack', pack,
  ], 'mixed.brief.md')
  const context = section(brief, '## Context pack')
  const rows = context.split('\n').filter((line) =>
    line.startsWith(`- ${file} · exports · `) || line.startsWith(`- ${file} · test titles · `))
  const listed = rows.flatMap((line) => {
    const entries = line.slice(line.lastIndexOf(' · ') + 3)
    return entries.startsWith('not listed —') ? [] : entries.split(', ')
  })
  const sidecar = join(pack, 'mixed.symbols.md')
  assert.ok(listed.length <= SYMBOL_INDEX_ENTRY_LIMIT)
  assert.equal(listed.length, SYMBOL_INDEX_ENTRY_LIMIT)
  assert.ok(context.includes(`… and 1 more — full index: ${sidecar}`))
  assert.ok(context.includes(`- ${file} · test titles · not listed — the per-file budget of ${SYMBOL_INDEX_ENTRY_LIMIT} entries was spent`))
  assert.ok(context.includes(`… and ${titleCount} more — full index: ${sidecar}`))
  assert.ok(readFileSync(sidecar, 'utf8').includes(`mixed title ${String(titleCount - 1).padStart(3, '0')}:${exportCount + titleCount}`))
})

test('a packed no-code fence emits no symbol index', () => {
  const root = fixture('symbol-index-no-code')
  const file = 'config/thing.yml'
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({ lanes: [
    { lane: 'own', files: [file] },
  ] }, null, 2)}\n`)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const { brief } = compile(root, { where: [file] }, [
    '--fences', fencesPath, '--lane', 'own', '--pack', pack,
  ], 'nocode.brief.md')
  const context = section(brief, '## Context pack')
  assert.equal(context.includes('symbol index'), false)
  assert.equal(existsSync(join(pack, 'nocode.symbols.md')), false)
})

test('pack and issue-body flags refuse their missing prerequisites', () => {
  const root = fixture('pack-flag-refusals')
  const requestPath = request(root)
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const noOut = run(root, ['--request', requestPath, '--checkout', root, '--pack', pack])
  assert.equal(noOut.status, 2)
  assert.match(noOut.stderr, /missing-line/)
  const noPack = run(root, ['--request', requestPath, '--checkout', root, '--issue-body', join(root, 'body.md')])
  assert.equal(noPack.status, 2)
  assert.match(noPack.stderr, /missing-line/)
})

test('every packed absence uses one closed reason and never invents a value', () => {
  const root = fixture('pack-absence-reasons')
  const issuePath = join(root, 'missing-issue.md')
  const journalPath = join(root, 'missing-journal.jsonl')
  const cases = [
    { ask: ASK, reason: 'no-issue-cited' },
    { ask: '#321 Move the widget cache contract into a smaller brief.', reason: 'no-issue-body-supplied' },
    { ask: '#321 Move the widget cache contract into a smaller brief.', extra: ['--issue-body', issuePath], reason: 'issue-body-unreadable' },
    { ask: ASK, reason: 'no-journal-named' },
    { ask: `${ASK} Journal: ${journalPath}`, reason: 'journal-unreadable' },
  ]
  assert.equal(new Set(PACK_ABSENT_REASONS).size, 5)
  for (const [index, item] of cases.entries()) {
    const pack = join(root, `pack-${index}`)
    mkdirSync(pack)
    const brief = compile(root, { ask: item.ask }, ['--pack', pack, ...(item.extra || [])], `absence-${index}.brief.md`).brief
    assert.match(brief, new RegExp(item.reason))
    if (item.reason === 'no-journal-named' || item.reason === 'journal-unreadable') {
      assert.match(brief, /fixture rows: \(none\) — basis:/)
      assert.equal(existsSync(join(pack, 'fixtures', `absence-${index}.jsonl`)), false)
    }
  }
})

test('intent resolves one collapsed sentence, accepts authored text, and validates its shape', () => {
  assert.equal(resolveIntent({ ask: 'First sentence. Second sentence.' }), 'First sentence.')
  assert.equal(resolveIntent({ intent: ' Authored   lane intent. ', ask: 'Derived sentence. Ignore this.' }), 'Authored lane intent.')
  assert.equal(resolveIntent({ ask: 'A\nmultiline\trequest with no terminator' }), 'A multiline request with no terminator')

  const base = { ask: ASK, where: ['lib/widget.mjs'], done_means: DONE, out_of_scope: OUT }
  assert.deepEqual(validateRequest({ ...base, intent: 'specific intent' }, { taskName: 'intent-shape' }).intent, 'specific intent')
  assert.throws(() => validateRequest({ ...base, intent: 42 }, { taskName: 'intent-shape' }), (error) => error.reason === 'wrong-type')
  assert.throws(() => validateRequest({ ...base, intent: '   ' }, { taskName: 'intent-shape' }), (error) => error.reason === 'missing-line')

  const brief = renderBrief({ request: { ...base, intent: 'specific intent' }, where: [], discovery: { candidates: [], tripwires: [], broadKeys: [] } })
  assert.equal((brief.match(/^## Intent$/gm) || []).length, 1)
  assert.ok(brief.indexOf('## The ask') < brief.indexOf('## Intent'))
  assert.ok(brief.indexOf('## Intent') < brief.indexOf('## Proposed tier'))
})

test('a missing where path refuses by name and a blank ask refuses', () => {
  const root = fixture('refusals')
  const missing = run(root, ['--request', request(root, { where: ['lib/nope.mjs'] }), '--checkout', root])
  assert.equal(missing.status, 2)
  assert.match(`${missing.stderr}${missing.stdout}`, /lib\/nope\.mjs/)
  const blank = run(root, ['--request', request(root, { ask: '   ' }), '--checkout', root])
  assert.equal(blank.status, 2)
  assert.match(blank.stderr, /blank-ask/)
})

test('an optional creates declaration compiles, renders after verified paths, and joins authored scope', () => {
  const root = fixture('creates-happy')
  const { brief } = compile(root, { creates: ['lib/new-widget.mjs'] })
  const where = section(brief, '## Where').trim().split('\n')
  assert.deepEqual(where, [
    'verified · file · lib/widget.mjs',
    'verified · file · config/thing.yml',
    'declared · created · lib/new-widget.mjs',
  ])
  const writeLine = section(brief, '## Conventions').split('\n').find((line) => line.startsWith('files_in_scope'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): config/thing.yml, lib/new-widget.mjs, lib/widget.mjs')
  assert.deepEqual(OPTIONAL_REQUEST_KEYS, ['creates', 'directed', 'intent'])
})

test('creates verifies the opposite existence pair and reuses scope shape checks', () => {
  const root = fixture('creates-validation')
  assert.deepEqual(verifyCreates({ checkout: root, creates: ['lib/new-widget.mjs'] }), [
    { path: 'lib/new-widget.mjs', kind: 'created' },
  ])
  assert.throws(() => verifyCreates({ checkout: root, creates: ['lib/widget.mjs'] }), (error) => error.reason === 'creates-exists')
  assert.throws(() => verifyCreates({ checkout: root, creates: ['nope/new-widget.mjs'] }), (error) => error.reason === 'creates-parent-missing')
  assert.throws(() => verifyCreates({ checkout: root, creates: ['lib/new-widget.mjs', 'lib/new-widget.mjs'] }), (error) => error.reason === 'wrong-type')
  for (const entry of [
    join(root, 'lib', 'absolute.mjs'), 'lib/*.mjs', 'lib/../new-widget.mjs', 'lib/new-dir/', 'Lib/new-widget.mjs',
  ]) {
    assert.throws(() => verifyCreates({ checkout: root, creates: [entry] }), (error) => (
      error.reason === 'scope-entry-shape' || error.reason === 'scope-entry-case'
    ), entry)
  }
  assert.ok(REFUSAL_REASONS.includes('creates-exists'))
  assert.ok(REFUSAL_REASONS.includes('creates-parent-missing'))
})

test('creates refuses symlinked parent segments and classifies a present leaf as existing', () => {
  const root = fixture('creates-symlink')
  const outside = nextRoot('creates-outside')
  mkdirSync(join(outside, 'nested'))
  symlinkSync(outside, join(root, 'link'))
  symlinkSync('lib/widget.mjs', join(root, 'present-link.mjs'))
  git(root, 'add', 'link', 'present-link.mjs')

  for (const entry of ['link/new-widget.mjs', 'link/nested/new-widget.mjs']) {
    assert.throws(() => verifyCreates({ checkout: root, creates: [entry] }), (error) => error.reason === 'creates-parent-missing', entry)
  }
  assert.throws(() => verifyCreates({ checkout: root, creates: ['present-link.mjs'] }), (error) => error.reason === 'creates-exists')
  const result = run(root, [
    '--request', request(root, { creates: ['link/new-widget.mjs'] }), '--checkout', root,
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /creates-parent-missing/)
  const presentInBoth = run(root, [
    '--request', request(root, { where: ['present-link.mjs'], creates: ['present-link.mjs'] }), '--checkout', root,
  ])
  assert.equal(presentInBoth.status, 2)
  assert.match(presentInBoth.stderr, /creates-exists/)
  assert.equal(existsSync(join(outside, 'new-widget.mjs')), false)
})

test('creates keeps missing-path strict in both where/creates directions and accepts an empty list', () => {
  const root = fixture('creates-controls')
  const absentInBoth = run(root, [
    '--request', request(root, { where: ['lib/new-widget.mjs'], creates: ['lib/new-widget.mjs'] }), '--checkout', root,
  ])
  assert.equal(absentInBoth.status, 2)
  assert.match(absentInBoth.stderr, /missing-path/)

  const existsInBoth = run(root, [
    '--request', request(root, { where: ['lib/widget.mjs'], creates: ['lib/widget.mjs'] }), '--checkout', root,
  ])
  assert.equal(existsInBoth.status, 2)
  assert.match(existsInBoth.stderr, /creates-exists/)

  const whereAbsent = run(root, [
    '--request', request(root, { where: ['lib/new-widget.mjs'], creates: ['config/new-widget.yml'] }), '--checkout', root,
  ])
  assert.equal(whereAbsent.status, 2)
  assert.match(whereAbsent.stderr, /missing-path/)

  const without = compile(root, {}, [], 'without-creates.md').brief
  const empty = compile(root, { creates: [] }, [], 'empty-creates.md').brief
  assert.equal(without, empty)
})

test('a directed request renders one block the real parser accepts', () => {
  const root = fixture('directed-happy')
  const { brief } = compile(root, {
    ask: 'Carry the gate in a ` ```directed ` block for widget delivery',
    directed: { gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'] },
  })
  assert.equal(brief.split('\n').filter((line) => line.trim() === '```directed').length, 1)
  const parsed = parseDirectedBrief(brief)
  assert.equal(parsed.defect, null)
  assert.ok(brief.includes(HOSTILE_ENV_BLOCK))
  assert.equal(parsed.gate_cmd, '/abs/path/gate.mjs')
  assert.deepEqual(parsed.files_in_scope, ['lib/widget.mjs'])
})

test('omitting the plan renders the brief byte-identically', () => {
  const gathered = {
    request: { ask: 'Carry a declared gate plan for widget delivery', done_means: 'The gate accepts the delivered widget.', out_of_scope: 'The driver owns dispatch.' },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
  }
  const without = renderBrief(gathered)
  const withPlan = renderBrief({
    ...gathered,
    request: {
      ...gathered.request,
      directed: { gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'] },
    },
  })
  assert.equal(without.includes('## Directed plan'), false)
  assert.equal(without.split('\n').filter((line) => line.trim() === '```directed').length, 0)
  const lines = withPlan.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## Directed plan')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  assert.notEqual(start, -1)
  lines.splice(start, 1 + (end === -1 ? rest.length : end))
  assert.equal(lines.join('\n'), without)
})

test('the compiler refuses a directed block the driver would refuse', () => {
  const base = { ask: ASK, where: ['lib/widget.mjs'], done_means: DONE, out_of_scope: OUT }
  const plan = { gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'] }
  const unknown = { ...plan, gate_source: 'orchestrator' }
  assert.throws(() => validateRequest({ ...base, directed: unknown }, { taskName: 'directed-refusals' }), (error) => {
    assert.equal(error.reason, 'directed-unknown-key')
    assert.match(error.message, /gate_source/)
    return true
  })
  for (const directed of [
    null,
    'not-an-object',
    [],
    { ...plan, gate_cmd: '  ' },
    { ...plan, files_in_scope: [] },
    { ...plan, files_in_scope: [42] },
  ]) {
    assert.throws(() => validateRequest({ ...base, directed }, { taskName: 'directed-refusals' }), (error) => error.reason === 'directed-shape')
  }
  const root = fixture('directed-refusal')
  const result = run(root, ['--request', request(root, { directed: unknown }), '--checkout', root])
  assert.equal(result.status, 2)
  assert.match(`${result.stderr}${result.stdout}`, /directed-unknown-key/)
})

test('a directed plan is accepted whatever variant will read it', () => {
  const plan = { gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'] }
  const requestBody = { ask: ASK, where: ['lib/widget.mjs'], done_means: DONE, out_of_scope: OUT, directed: plan }
  const accepted = validateRequest(requestBody, { taskName: 'variant-sensitive' })
  assert.deepEqual(accepted.directed, plan)
  const brief = renderBrief({
    request: accepted,
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
  })
  assert.equal(brief.split('\n').filter((line) => line.trim() === '```directed').length, 1)
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /variant-blind/)
  assert.match(source, /DISPATCH_ONLY_REQUEST_KEYS/)
})

test('the compiler and the driver declare one directed contract', () => {
  assert.equal(DIRECTED_BLOCK, DRIVE_DIRECTED_BLOCK)
  assert.deepEqual(DIRECTED_KEYS, DRIVE_DIRECTED_KEYS)
})

test('the directed section records where a directed gate lives', () => {
  const body = section(renderBrief({
    request: { ask: ASK, where: ['lib/widget.mjs'], done_means: DONE, out_of_scope: OUT, directed: {
      gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'],
    } },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
  }), '## Directed plan')
  assert.equal(body.includes(DIRECTED_GATE_NOTE), true)
  for (const clause of ['outside the repo', 'absolute path', 'gate_cmd', 'write fence']) {
    assert.equal(body.includes(clause), true, `missing ${clause}`)
  }
})

test('a bare directed fence in the prose is refused, not shipped', () => {
  assert.throws(() => renderBrief({
    request: {
      ask: ASK,
      where: ['lib/widget.mjs'],
      done_means: DONE,
      out_of_scope: ['a quoted plan:', '```directed', '{}', '```'].join('\n'),
      directed: { gate_cmd: '/abs/path/gate.mjs', files_in_scope: ['lib/widget.mjs'] },
    },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
  }), (error) => error.reason === 'directed-fence-collision')
})

test('a fenced lane keeps a created path on the fence write-surface basis', () => {
  const root = fixture('creates-fenced')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs', 'lib/new-widget.mjs'] }],
  }, null, 2)}\n`)
  const { brief } = compile(root, { creates: ['lib/new-widget.mjs'] }, [
    '--fences', fencesPath, '--lane', 'own',
  ])
  const writeLine = section(brief, '## Conventions').split('\n').find((line) => line.startsWith('files_in_scope'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: fence register, lane "own"): lib/new-widget.mjs, lib/widget.mjs')
})

test('validateAsk rejects short and heading-restating asks, while genuine asks pass', () => {
  assert.throws(() => validateAsk('one two', 'widget-cache-ttl'), (error) => error.reason === 'missing-line')
  assert.throws(() => validateAsk('widget cache ttl', 'widget-cache-ttl'), (error) => error.reason === 'restating-ask')
  assert.doesNotThrow(() => validateAsk('Make the cache observable', 'widget-cache-ttl'))
})

test('an unknown top-level request key is a tagged refusal', () => {
  const root = fixture('unknown-key')
  const result = run(root, ['--request', request(root, { surprise: true }), '--checkout', root])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown-key/)
})

test('the path key finds a test pinning a non-code file', () => {
  const root = fixture('non-code')
  const { brief } = compile(root)
  assert.match(brief, /test\/reads-config\.test\.mjs/)
  assert.match(brief, /config\/thing\.yml/)
})

test('extractKeys independently finds exports, codes, written paths, and basenames', () => {
  const keys = extractKeys([
    'export const PublicValue = 1',
    'export async function runThing() {}',
    'export { hidden as PublicAlias, plain }',
    "const code = 'cache:miss'",
    "const output = 'var/cache/result.json'",
    'void [code, output]',
  ].join('\n'), 'lib/example.mjs')
  for (const key of [
    'PublicValue', 'runThing', 'PublicAlias', 'plain', 'cache:miss',
    'var/cache/result.json', 'result.json', 'lib/example.mjs',
  ]) assert.ok(keys.includes(key), `${key} missing from ${keys}`)
  assert.ok(!keys.includes('foo'))
  assert.deepEqual(keys, [...keys].sort())
})

test('exported symbols, error codes, and written filenames each find their test', () => {
  const root = fixture('key-kinds')
  put(root, 'test/keys.test.mjs', [
    "import { test } from 'node:test'",
    "import { computeWidget, computeWidgetAlias } from '../lib/widget.mjs'",
    "test('computeWidgetAlias cache:miss out/widget.json', () => { void computeWidget })",
    '',
  ].join('\n'))
  put(root, 'test/symbol-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('symbol pin computeWidget', () => {})",
    '',
  ].join('\n'))
  put(root, 'test/error-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('error pin cache:miss', () => {})",
    '',
  ].join('\n'))
  put(root, 'test/written-pin.test.mjs', [
    "import { test } from 'node:test'",
    "test('written filename pin out/widget.json', () => {})",
    '',
  ].join('\n'))
  git(root, 'add', '-A')
  const { brief } = compile(root)
  const tripwireBody = section(brief, '## Tripwires')
  assert.match(tripwireBody, /- test\/symbol-pin\.test\.mjs · .*computeWidget/)
  assert.match(tripwireBody, /- test\/error-pin\.test\.mjs · .*cache:miss/)
  assert.match(tripwireBody, /- test\/written-pin\.test\.mjs · .*out\/widget\.json/)
  assert.match(brief, /grep -rn/)
})

test('tracked key discovery retains a tripwire beyond argv limits', () => {
  const root = fixture('chunked-key-discovery')
  const symbolAt = (index) => `ARG_MAX_GUARD_${String(index).padStart(5, '0')}`
  const symbolCount = 70_000
  const pinned = symbolAt(symbolCount - 1)
  put(root, 'lib/generated.mjs', `${Array.from({ length: symbolCount }, (_, index) => (
    `export const ${symbolAt(index)} = ${index}`
  )).join('\n')}\n`)
  put(root, 'test/argv-ceiling.test.mjs', [
    "import { test } from 'node:test'",
    `import { ${pinned} } from '../lib/generated.mjs'`,
    `test('argv ceiling pin', () => { void ${pinned} })`,
    '',
  ].join('\n'))
  git(root, 'add', '-A')
  const where = verifyWhere({ checkout: root, where: ['lib/generated.mjs'] })
  const tripwire = discoverTripwires({ checkout: root, files: where }).tripwires
    .find((entry) => entry.file === 'test/argv-ceiling.test.mjs')
  assert.equal(tripwire?.keys.includes(pinned), true)
})

test('context pack records complete source data beyond argv limits', () => {
  const root = fixture('context-at-argv-scale')
  const symbolAt = (index) => `CONTEXT_ARG_MAX_${String(index).padStart(5, '0')}`
  const symbolCount = 70_000
  const pinned = symbolAt(symbolCount - 1)
  put(root, 'lib/generated.mjs', `${Array.from({ length: symbolCount }, (_, index) => (
    `export const ${symbolAt(index)} = ${index}`
  )).join('\n')}\n`)
  put(root, 'lib/generated-caller.mjs', [
    `import { ${pinned} } from './generated.mjs'`,
    `export function callGenerated() { return ${pinned} }`,
    '',
  ].join('\n'))
  put(root, 'test/generated-context.test.mjs', [
    "import { test } from 'node:test'",
    `import { ${pinned} } from '../lib/generated.mjs'`,
    `test('generated context pin', () => { void ${pinned} })`,
    '',
  ].join('\n'))
  const issueBody = 'Context issue body first line.\nContext issue body second line.'
  const issue = put(root, 'context-issue.md', `${issueBody}\n`)
  const journal = put(root, 'context-journal.jsonl', '{"event":"context"}\n')
  git(root, 'add', '-A')
  const pack = join(root, 'pack')
  mkdirSync(pack)
  const ask = `#456 Keep generated context data complete. Journal: ${journal}`
  const packed = compile(root, { ask, where: ['lib/generated.mjs'] }, [
    '--pack', pack, '--issue-body', issue,
  ], 'context-at-scale.brief.md').brief
  const context = section(packed, '## Context pack')
  assert.ok(context.includes(`--- ISSUE 456 BODY ---\n${issueBody}\n--- END ISSUE 456 BODY ---`))
  for (const [file, label] of [
    ['lib/generated.mjs', 'in fence'],
    ['lib/generated-caller.mjs', 'coupled'],
  ]) {
    const count = readFileSync(join(root, file), 'utf8').split('\n').length
    assert.ok(context.includes(`- ${file} · ${count} lines · ${label}`), file)
  }
  const entries = readdirSync(join(root, 'lib'), { withFileTypes: true })
    .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
    .sort()
  assert.ok(context.includes(`- lib/ · ${entries.join(', ')}`))
  const rows = join(pack, 'context-at-scale.tripwires.md')
  assert.ok(packed.includes(`cat ${rows}`))
})

test('tracked symlinks and deleted entries do not block brief discovery', () => {
  const root = fixture('tracked-non-files')
  const deleted = put(root, 'lib/deleted.mjs', 'export const DELETED_TRACKED_FILE = 1\n')
  symlinkSync('missing-target', join(root, 'broken-link'))
  git(root, 'add', 'broken-link', 'lib/deleted.mjs')
  rmSync(deleted)
  const where = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  const discovery = discoverTripwires({ checkout: root, files: where })
  const tripwire = discovery.tripwires.find((entry) => entry.file === 'test/widget.test.mjs')
  assert.equal(tripwire?.keys.includes('computeWidget'), true)
  const { brief } = compile(root, { where: ['lib/widget.mjs'] }, [], 'tracked-non-files.brief.md')
  assert.match(section(brief, '## Tripwires'), /test\/widget\.test\.mjs · .*computeWidget/)
})

test('broad keys are reported with counts and are not tripwires', () => {
  const root = fixture('broad', { broad: true })
  const { brief } = compile(root, { where: ['lib/broad.mjs'] })
  assert.match(brief, /broad keys \(not used as tripwires\)/)
  const broadLine = brief.split('\n').find((line) => line.includes('BROAD_PIN') && line.includes('hits'))
  assert.ok(broadLine)
  const hitCount = Number(broadLine.match(/(\d+) hits/)[1])
  assert.ok(hitCount > BROAD_KEY_HIT_LIMIT)
  const broadPathLine = brief.split('\n').find((line) => line === '- broad.mjs · 32 hits')
  assert.ok(broadPathLine)
  const tripwireSection = section(brief, '## Tripwires')
  assert.doesNotMatch(tripwireSection, /test\/broad-.*BROAD_PIN/)
  assert.doesNotMatch(section(brief, '## Coupled sources'), /lib\/broad-\d+\.mjs/)
})

test('citation-only code comments couple to a where owner', () => {
  const root = fixture('citation-coupling', { citingComment: true })
  const where = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  const discovery = discoverTripwires({ checkout: root, files: where })
  const citation = discovery.coupled.find((entry) => entry.file === 'lib/cites.js')
  assert.ok(citation)
  assert.ok(citation.keys.includes('lib/widget.mjs') || citation.keys.includes('widget.mjs'))
})

test('citation-only coupling is enforced by fences and can be acknowledged as read-only', () => {
  const root = fixture('citation-fence', { citingComment: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }, null, 2)}\n`)
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const refused = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'refused.md'),
  ])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /coupled-source-unfenced/)
  assert.match(refused.stderr, /lib\/cites\.js/)

  const acknowledgedPath = put(root, 'ack-fences.json', `${JSON.stringify({
    lanes: [{
      lane: 'own',
      files: ['lib/widget.mjs'],
      reads: [{ file: 'lib/cites.js', why: 'citation-only reader is adjacent-owned' }],
    }],
  }, null, 2)}\n`)
  const { brief } = compile(root, { where: ['lib/widget.mjs'] }, [
    '--fences', acknowledgedPath, '--lane', 'own',
  ], 'acknowledged.md')
  assert.match(brief, /lib\/cites\.js · .*acknowledged read-only/)
})

test('--discover-reads names exactly the records the coupled refusal names', () => {
  const root = fixture('discover-reads-names', { citingComment: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }, null, 2)}\n`)
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const refused = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'refused.md'),
  ])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /coupled-source-unfenced/)
  const discovered = run(root, [
    '--discover-reads', 'own', '--request', requestPath, '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(discovered.status, 0, `${discovered.stderr}\n${discovered.stdout}`)
  const records = JSON.parse(discovered.stdout)
  assert.deepEqual(records, [{
    file: 'lib/cites.js',
    why: 'compiler reported a coupled source while compiling lane own',
  }])
  const prefix = 'coupled source(s) outside lane fence: '
  const details = refused.stderr.slice(refused.stderr.indexOf(prefix) + prefix.length).split(' [reason:')[0]
  const refusalFiles = details.split(';').map((part) => part.split('·')[0].trim()).filter(Boolean)
  assert.deepEqual(records.map(({ file }) => file), refusalFiles)
  assert.equal(records[0].why, 'compiler reported a coupled source while compiling lane own')
})

test('--discover-reads uses the lane brief task name for generated requests', () => {
  const root = fixture('discover-reads-task-name')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'lane-a', files: ['lib/widget.mjs'] }],
  }, null, 2)}\n`)
  const requestPath = request(root, {
    ask: 'lane a compile request',
    where: ['lib/widget.mjs'],
  }, 'lane-a.compile-request.json')
  const discovered = run(root, [
    '--discover-reads', 'lane-a', '--request', requestPath, '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(discovered.status, 0, `${discovered.stderr}\n${discovered.stdout}`)
  assert.equal(discovered.stdout.trim(), '[]')
  const compiled = run(root, [
    '--request', requestPath, '--checkout', root, '--fences', fencesPath,
    '--lane', 'lane-a', '--out', join(root, 'lane-a.brief.md'), '--force',
  ])
  assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`)
})

test('--discover-reads and compile accept an external true marker and drop it', () => {
  const root = fixture('discover-reads-external-marker')
  const fencesPath = put(root, 'external-fences.json', `${JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs'], reads: [] },
      { lane: 'carried', files: ['lib/caller.mjs'], reads: [], external: true },
    ],
  }, null, 2)}\n`)
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const gathered = gatherFences({ fencesPath, checkout: root })
  assert.deepEqual(gathered, [
    { lane: 'carried', files: ['lib/caller.mjs'], reads: [] },
    { lane: 'own', files: ['lib/widget.mjs'], reads: [] },
  ])
  const discovered = run(root, [
    '--discover-reads', 'own', '--request', requestPath, '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(discovered.status, 0, `${discovered.stderr}\n${discovered.stdout}`)
  const compiled = run(root, [
    '--request', requestPath, '--checkout', root, '--fences', fencesPath,
    '--lane', 'own', '--out', join(root, 'external-marker.md'), '--force',
  ])
  assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`)
})

test('gatherFences refuses an external marker whose value is not true', () => {
  const root = fixture('invalid-external-marker')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'], external: 'yes' }],
  }, null, 2)}\n`)
  assert.throws(() => gatherFences({ fencesPath, checkout: root }), (error) => error.reason === 'bad-fences')
})

test('--discover-reads prints an empty register when every coupled source is fenced', () => {
  const root = fixture('discover-reads-empty', { citingComment: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs', 'lib/cites.js'] }],
  }, null, 2)}\n`)
  const result = run(root, [
    '--discover-reads', 'own', '--request', request(root, { where: ['lib/widget.mjs'] }),
    '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(result.stdout.trim(), '[]')
})

test('--discover-reads refuses what the compile path refuses', () => {
  const root = fixture('discover-reads-refusals')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }, null, 2)}\n`)
  const reason = (result) => result.stderr.match(/\[reason: ([a-z-]+)\]/)?.[1]
  const missingRequest = request(root, { where: ['lib/nope.mjs'] }, 'missing.request.json')
  const missingCompile = run(root, [
    '--request', missingRequest, '--checkout', root, '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'missing.md'),
  ])
  const missingDiscover = run(root, [
    '--discover-reads', 'own', '--request', missingRequest, '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(missingCompile.status, 2)
  assert.equal(missingDiscover.status, 2)
  assert.equal(reason(missingCompile), 'missing-path')
  assert.equal(reason(missingDiscover), reason(missingCompile))

  const validRequest = request(root, { where: ['lib/widget.mjs'] })
  const unknownCompile = run(root, [
    '--request', validRequest, '--checkout', root, '--fences', fencesPath, '--lane', 'nope', '--out', join(root, 'unknown.md'),
  ])
  const unknownDiscover = run(root, [
    '--discover-reads', 'nope', '--request', validRequest, '--checkout', root, '--fences', fencesPath,
  ])
  assert.equal(unknownCompile.status, 2)
  assert.equal(unknownDiscover.status, 2)
  assert.equal(reason(unknownCompile), 'unknown-lane')
  assert.equal(reason(unknownDiscover), reason(unknownCompile))
})

test('the refusal and the discover mode share one derivation', () => {
  const root = fixture('discover-reads-partition', { coupledCaller: true, citingComment: true })
  const where = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  const discovery = discoverTripwires({ checkout: root, files: where })
  const writeSurface = resolveWriteSurface({
    fences: [{ lane: 'own', files: ['lib/widget.mjs', 'lib/caller.mjs'], reads: [] }],
    lane: 'own', where,
  })
  const acknowledged = readsToAcknowledge({ discovery, writeSurface })
  const refusal = crossCheckCoupling({ discovery, writeSurface, enforce: false })
  assert.ok(refusal.in_fence.includes('lib/caller.mjs'))
  assert.deepEqual(acknowledged.map(({ file }) => file), refusal.unfenced)
})

test('baseline is measured, colour-neutral, and absent test scripts are unknown', () => {
  const root = fixture('baseline')
  const { brief } = compile(root, {}, [], 'brief.md', { FORCE_COLOR: '3' })
  const body = section(brief, '## Baseline')
  assert.match(body, /pass 2/)
  assert.match(body, /fail 0/)
  assert.doesNotMatch(body, /unknown/)

  const dead = fixture('no-suite', { scripts: null })
  const deadBrief = compile(dead).brief
  const deadBody = section(deadBrief, '## Baseline')
  assert.match(deadBody, /unknown/)
  assert.doesNotMatch(deadBody, /\b0\b/)
})

test('a verified supplied baseline is reused without running the suite', () => {
  const fx = committedFixture('reuse')
  const path = suppliedBaseline('reuse', { sha: fx.sha, command: fx.command, pass: 4242, fail: 0 })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  assert.equal(existsSync(fx.marker), false)
  assert.match(section(brief, '## Baseline'), /pass 4242/)
  assert.match(brief, /count basis: reused a supplied baseline/)
  assert.match(section(brief, '## Validation lane'), /reused baseline/)
})

test('a supplied baseline from another commit is refused and measured', () => {
  const fx = committedFixture('sha-mismatch')
  const path = suppliedBaseline('sha-mismatch', { sha: '0'.repeat(40), command: fx.command, pass: 4242, fail: 0 })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.doesNotMatch(body, /pass 4242/)
  assert.match(body, /sha-mismatch/)
})

test('a supplied baseline from another command is refused and measured', () => {
  const fx = committedFixture('command-mismatch')
  const path = suppliedBaseline('command-mismatch', { sha: fx.sha, command: `${fx.command} `, pass: 4242, fail: 0 })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.doesNotMatch(body, /pass 4242/)
  assert.match(body, /command-mismatch/)
})

test('a supplied baseline over a dirty checkout is refused and measured', () => {
  const fx = committedFixture('dirty-tree')
  put(fx.root, 'uncommitted.txt', 'edit\n')
  const path = suppliedBaseline('dirty-tree', { sha: fx.sha, command: fx.command, pass: 4242, fail: 0 })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.doesNotMatch(body, /pass 4242/)
  assert.match(body, /dirty-tree/)
})

test('an unreadable supplied baseline is refused and measured', () => {
  const fx = committedFixture('unreadable-baseline')
  const path = join(fixtureRoot, 'no-such-supplied-baseline.json')
  rmSync(path, { force: true })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.doesNotMatch(body, /pass 4242/)
  assert.match(body, /unreadable-baseline/)
})

test('a malformed supplied baseline is refused and measured', () => {
  const fx = committedFixture('malformed-baseline')
  const path = suppliedBaseline('malformed-baseline', { sha: 123, command: null, pass: 4242, fail: 0 })
  const { brief } = compileCommitted(fx, ['--baseline', path])
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.doesNotMatch(body, /pass 4242/)
  assert.match(body, /malformed-baseline/)
})

test('a compile without a supplied baseline keeps the measured count basis', () => {
  const fx = committedFixture('no-supply')
  const { brief } = compileCommitted(fx)
  const body = section(brief, '## Baseline')
  assert.equal(existsSync(fx.marker), true)
  assert.match(body, /pass 7/)
  assert.match(body, /count basis: measured this compile — a recorded baseline is a fact about a commit and is never consumed/)
})

test('--measure-baseline writes commit-scoped counts and clears sha for a dirty tree', () => {
  const fx = committedFixture('measure-only')
  const cleanPath = join(fixtureRoot, 'measure-only-clean.baseline.json')
  const clean = run(fx.root, [
    '--measure-baseline', cleanPath, '--checkout', fx.root,
    '--profile', join(fixtureRoot, 'missing-profile.json'),
  ])
  assert.equal(clean.status, 0, `${clean.stderr}\n${clean.stdout}`)
  assert.deepEqual(JSON.parse(readFileSync(cleanPath, 'utf8')), {
    sha: fx.sha, command: fx.command, pass: 7, fail: 0, status: 'green',
  })
  assert.equal(existsSync(fx.marker), true)

  put(fx.root, 'uncommitted.txt', 'edit\n')
  const dirtyPath = join(fixtureRoot, 'measure-only-dirty.baseline.json')
  const dirty = run(fx.root, [
    '--measure-baseline', dirtyPath, '--checkout', fx.root,
    '--profile', join(fixtureRoot, 'missing-profile.json'),
  ])
  assert.equal(dirty.status, 0, `${dirty.stderr}\n${dirty.stdout}`)
  const dirtyValue = JSON.parse(readFileSync(dirtyPath, 'utf8'))
  assert.equal(dirtyValue.sha, null)
  assert.equal(dirtyValue.command, fx.command)
  assert.equal(dirtyValue.pass, 7)
  assert.equal(dirtyValue.fail, 0)
})

test('a ratified profile test_command becomes the measured lane and states its basis', () => {
  const root = fixture('profile-ratified-lane')
  const lane = 'node --test test/widget.test.mjs'
  const profilePath = profile('ratified-lane', { test_command: ratified(lane) })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test test\/widget\.test\.mjs · pass 1/)
  assert.match(body, /lane basis: ratified profile field test_command/)
})

test('a proposed profile test_command is not consumed and names the package fallback', () => {
  const root = fixture('profile-proposed-lane')
  const proposedLane = 'node --test test/widget.test.mjs --proposed-lane'
  const profilePath = profile('proposed-lane', { test_command: proposed(proposedLane) })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test · pass 2/)
  assert.doesNotMatch(body, /--proposed-lane/)
  assert.match(body, /lane basis: package\.json scripts\.test — profile field test_command is proposed, not ratified/)
})

test('an unknown profile test_command is not consumed because only ratified cells count', () => {
  const root = fixture('profile-unknown-lane')
  const profilePath = profile('unknown-lane', { test_command: unknown() })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test · pass 2/)
  assert.match(body, /profile field test_command is unknown, not ratified/)
})

test('an absent profile compiles with its path and unreadable reason stated', () => {
  const root = fixture('profile-absent')
  const profilePath = join(fixtureRoot, 'profiles', 'missing-profile.json')
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const body = section(brief, '## Baseline')
  assert.match(body, /no profile at .*missing-profile\.json \(profile-unreadable\)/)
  assert.match(body, /lane basis: package\.json scripts\.test — no profile at/)
})

test('--require-profile refuses unreadable and unratified profiles by distinct reasons', () => {
  const root = fixture('profile-required')
  const missingPath = join(fixtureRoot, 'profiles', 'required-missing.json')
  const missing = run(root, [
    '--request', request(root), '--checkout', root,
    '--require-profile', '--profile', missingPath,
  ])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /profile-unreadable/)

  const proposedPath = profile('required-proposed', { test_command: proposed('node --test --proposed') })
  const proposedResult = run(root, [
    '--request', request(root), '--checkout', root,
    '--require-profile', '--profile', proposedPath,
  ])
  assert.equal(proposedResult.status, 2)
  assert.match(proposedResult.stderr, /profile-unratified/)
})

test('a recorded baseline count is named unused while the compile measures fresh counts', () => {
  const root = fixture('profile-stale-baseline')
  const lane = 'node --test test/widget.test.mjs'
  const profilePath = profile('stale-baseline', {
    test_command: ratified(lane),
    baseline: ratified({ tests: 4242, passed: 4242, failed: 0 }),
  })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const baseline = section(brief, '## Baseline')
  const validation = section(brief, '## Validation lane')
  assert.match(baseline, /pass 1/)
  assert.match(baseline, /4242/)
  assert.match(baseline, /not used/)
  assert.doesNotMatch(`${baseline}\n${validation}`, /pass 4242/)

  const malformedPath = profile('malformed-stable', { test_command: { status: 'ratified', value: lane, source: 'human' } })
  const malformed = profileField({ path: malformedPath, profile: JSON.parse(readFileSync(malformedPath, 'utf8')) }, 'test_command')
  assert.equal(malformed.used, false)
  assert.equal(malformed.recorded, undefined)
  assert.equal(malformed.reason, 'profile-ratification-invalid')
  assert.equal(malformed.basis, `profile field test_command is ratified but invalid · ${malformedPath}`)
})

test('the default profile path is used when no --profile flag is supplied', () => {
  const root = fixture('profile-default-path')
  const factoryRoot = join(fixtureRoot, 'default-profile-factory')
  mkdirSync(join(factoryRoot, 'profiles'), { recursive: true })
  const repoKey = probeRepo({ checkout: root }).repo_key
  const target = defaultProfilePath({ repoKey, factoryRoot })
  writeFileSync(target, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: repoKey,
    repo_slug: 'default-path',
    fields: { test_command: ratified('node --test test/widget.test.mjs') },
    meta: { probed_at: '2026-08-17T00:00:00.000Z' },
  }, null, 2)}\n`)
  const { brief } = compile(root, {}, [], 'default-path.md', { DEVTEAM_FACTORY_DIR: factoryRoot })
  const body = section(brief, '## Baseline')
  assert.match(body, /lane basis: ratified profile field test_command/)
  assert.match(body, new RegExp(target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
})

test('--profile overrides the default profile path and names the override', () => {
  const root = fixture('profile-override')
  const factoryRoot = join(fixtureRoot, 'override-profile-factory')
  mkdirSync(join(factoryRoot, 'profiles'), { recursive: true })
  const repoKey = probeRepo({ checkout: root }).repo_key
  const defaultPath = defaultProfilePath({ repoKey, factoryRoot })
  writeFileSync(defaultPath, `${JSON.stringify({
    schema: 1,
    profile_version: 1,
    repo_key: repoKey,
    repo_slug: 'override-default',
    fields: { test_command: ratified('node --test') },
    meta: { probed_at: '2026-08-17T00:00:00.000Z' },
  }, null, 2)}\n`)
  const explicitPath = profile('override-explicit', {
    test_command: ratified('node --test test/widget.test.mjs'),
  })
  const { brief } = compile(root, {}, ['--profile', explicitPath], 'override.md', {
    DEVTEAM_FACTORY_DIR: factoryRoot,
  })
  const body = section(brief, '## Baseline')
  assert.match(body, /lane: node --test test\/widget\.test\.mjs · pass 1/)
  assert.doesNotMatch(body, /lane: node --test · pass 2/)
  assert.match(body, new RegExp(explicitPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
})

test('ratified convention files render with their basis and malformed files are unavailable', () => {
  const root = fixture('profile-conventions')
  const conventionPath = profile('conventions', {
    test_command: ratified('node --test'),
    conventions: ratified({ files: ['.claude/', 'README.md', 'docs/adr/', 'docs/conventions.md'] }),
  })
  const { brief } = compile(root, {}, ['--profile', conventionPath], 'conventions.md')
  const conventions = section(brief, '## Conventions')
  assert.match(conventions, /conventions of record \(basis: ratified profile field conventions/)
  assert.match(conventions, /\.claude\/, README\.md, docs\/adr\/, docs\/conventions\.md/)

  const malformedPath = profile('conventions-malformed', {
    test_command: ratified('node --test'),
    conventions: ratified({ files: 'README.md' }),
  })
  const malformed = compile(root, {}, ['--profile', malformedPath], 'conventions-malformed.md').brief
  const malformedConventions = section(malformed, '## Conventions')
  assert.match(malformedConventions, /conventions of record: \(not available\)/)
  assert.match(malformedConventions, /value\.files must be an array of strings/)
})

test('fences are sorted and no fence register is explicit when omitted', () => {
  const root = fixture('fences')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: '99-retry-backoff', files: ['lib/retry.mjs', 'test/retry.test.mjs'] },
      { lane: '12-other', files: ['docs/other.md'] },
    ],
  }, null, 2) + '\n')
  const withFences = compile(root, {}, ['--fences', fencesPath]).brief
  assert.match(withFences, /12-other owns docs\/other\.md/)
  assert.match(withFences, /99-retry-backoff owns lib\/retry\.mjs/)
  const fenceBody = section(withFences, '## Fences')
  assert.ok(fenceBody.indexOf('12-other') < fenceBody.indexOf('99-retry-backoff'))
  const without = compile(fixture('no-fences')).brief
  assert.match(section(without, '## Fences'), /no fence register supplied \(`--fences` not given\)/)
})

test('a named lane declares its fence as the write surface and keeps discovery distinct', () => {
  const root = fixture('named-lane')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'test/widget-new.test.mjs'] },
      { lane: 'other', files: ['test/reads-config.test.mjs'] },
    ],
  }, null, 2) + '\n')
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'])
  const conventions = section(brief, '## Conventions')
  const writeLine = conventions.split('\n').find((line) => line.startsWith('files_in_scope'))
  const readLine = conventions.split('\n').find((line) => line.startsWith('read-and-keep-green'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: fence register, lane "own"): lib/widget.mjs, test/widget-new.test.mjs')
  assert.ok(readLine)
  assert.match(readLine, /test\/widget\.test\.mjs/)
  assert.doesNotMatch(writeLine, /test\/(?:reads-config\.test|widget\.test)\.mjs/)
  const writeFiles = writeLine.slice(writeLine.indexOf('): ') + 3).split(', ')
  const readFiles = readLine.slice(readLine.indexOf(': ') + 2).split(', ')
  assert.ok(writeFiles.every((file) => !readFiles.includes(file)))
})

test('an unknown lane and a lane without fences both refuse with unknown-lane', () => {
  const root = fixture('unknown-lane')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }) + '\n')
  const unknown = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', fencesPath, '--lane', 'nope',
  ])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown-lane/)
  const withoutFences = run(root, [
    '--request', request(root), '--checkout', root, '--lane', 'own',
  ])
  assert.equal(withoutFences.status, 2)
  assert.match(withoutFences.stderr, /unknown-lane/)
  assert.ok(REFUSAL_REASONS.includes('unknown-lane'))
})

test('without fences the write surface is the authored where paths and names its basis', () => {
  const root = fixture('authored-where')
  const { brief } = compile(root)
  const conventions = section(brief, '## Conventions')
  const writeLine = conventions.split('\n').find((line) => line.startsWith('files_in_scope'))
  const readLine = conventions.split('\n').find((line) => line.startsWith('read-and-keep-green'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: authored where paths, no lane fence applied): config/thing.yml, lib/widget.mjs')
  assert.doesNotMatch(writeLine, /test\/widget\.test\.mjs/)
  assert.match(readLine, /test\/widget\.test\.mjs/)
})

test('an unslashed directory fence entry refuses at compile time', () => {
  const root = fixture('scope-unslashed')
  assert.throws(() => validateScopeEntries({ checkout: root, files: ['config'] }), (error) => (
    error.name === 'BriefUsageError' && error.reason === 'scope-directory-unslashed'
  ))
})

test('scope validation allows slashed directories, files and absent paths', () => {
  const root = fixture('scope-validation')
  assert.doesNotThrow(() => validateScopeEntries({
    checkout: root,
    files: ['config/', 'lib/widget.mjs', 'lib/absent.mjs'],
  }))
  assert.throws(() => validateScopeEntries({ checkout: root, files: 'config' }), (error) => error.reason === 'wrong-type')
  assert.throws(() => validateScopeEntries({ checkout: root, files: ['   '] }), (error) => error.reason === 'wrong-type')
  for (const entry of ['lib/widget.mjs ', 'lib/*.mjs', '/abs/path.mjs', './', '.', 'lib/../lib/widget.mjs']) {
    assert.throws(() => validateScopeEntries({ checkout: root, files: [entry] }), (error) => error.reason === 'scope-entry-shape', entry)
  }
  assert.throws(() => validateScopeEntries({ checkout: root, files: ['Lib/widget.mjs'] }), (error) => error.reason === 'scope-entry-case')
  assert.ok(REFUSAL_REASONS.includes('scope-entry-shape'))
  assert.ok(REFUSAL_REASONS.includes('scope-entry-case'))
})

test('the lane is never inferred from the output filename', () => {
  const root = fixture('lane-output-name')
  const fencesPath = put(root, 'fences.json', JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'test/widget-new.test.mjs'] },
      { lane: 'other', files: ['test/reads-config.test.mjs'] },
    ],
  }, null, 2) + '\n')
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'], 'other.md')
  const writeLine = section(brief, '## Conventions')
    .split('\n').find((line) => line.startsWith('files_in_scope'))
  assert.equal(writeLine, 'files_in_scope (expected write surface; basis: fence register, lane "own"): lib/widget.mjs, test/widget-new.test.mjs')
})

test('scope validation refuses unslashed directories without changing the rendered surface', () => {
  const root = fixture('scope-surface')
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'config'] },
      { lane: 'control', files: ['lib/widget.mjs'] },
    ],
  }, null, 2)}\n`)
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const refused = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'refused.md'),
  ])
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /scope-directory-unslashed/)

  // A sibling surface is validated too; this is the register repro from
  // docs/audits/2026-08-23/hunt/h2/repro/C-a3-fence-register.mjs.
  writeFileSync(fencesPath, `${JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'config/'] },
      { lane: 'control', files: ['lib/widget.mjs', 'config'] }
    ],
  }, null, 2)}\n`)
  const siblingRefused = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'sibling-refused.md'),
  ])
  assert.equal(siblingRefused.status, 2)
  assert.match(siblingRefused.stderr, /scope-directory-unslashed/)

  writeFileSync(fencesPath, `${JSON.stringify({
    lanes: [
      { lane: 'own', files: ['lib/widget.mjs', 'config/'] },
      { lane: 'control', files: ['lib/widget.mjs', 'config/'] }
    ],
  }, null, 2)}\n`)
  const slashed = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'slashed.md'),
  ])
  assert.equal(slashed.status, 0, slashed.stderr)
  const control = run(root, [
    '--request', requestPath, '--checkout', root,
    '--fences', fencesPath, '--lane', 'control', '--out', join(root, 'control.md'),
  ])
  assert.equal(control.status, 0, control.stderr)
  const withoutSurface = (brief) => brief.split('\n')
    .filter((line) => !line.startsWith('files_in_scope ('))
    .join('\n')
  assert.equal(
    withoutSurface(readFileSync(join(root, 'slashed.md'), 'utf8')),
    withoutSurface(readFileSync(join(root, 'control.md'), 'utf8')),
  )
})

test('every fence sibling spelling that the matcher cannot read is refused', () => {
  const root = fixture('fence-register-spellings')
  const spellings = [
    ['unslashed-dir', 'config'],
    ['dot-slash', './'],
    ['dot', '.'],
    ['absolute', join(root, 'lib/widget.mjs')],
    ['glob', 'lib/*.mjs'],
    ['traversal', 'lib/../lib/widget.mjs'],
    ['trailing-space', 'lib/widget.mjs '],
    ['case-variant', 'Lib/widget.mjs'],
  ]
  // Acceptance table mirrored from docs/audits/2026-08-23/hunt/h2/repro/C-a3-fence-register.mjs.
  for (const [label, spelling] of spellings) {
    const path = put(root, `${label}.json`, `${JSON.stringify({ lanes: [
      { lane: 'own', files: ['lib/widget.mjs'] },
      { lane: 'sibling', files: [spelling] },
    ] }, null, 2)}\n`)
    assert.throws(() => gatherFences({ fencesPath: path, checkout: root }), (error) => REFUSAL_REASONS.includes(error.reason), label)
  }
})

test('standing blocks and unfilled slots render verbatim', () => {
  const root = fixture('standing')
  const { brief } = compile(root)
  assert.ok(brief.includes(ACCEPTANCE_GATE_BLOCK))
  assert.ok(brief.includes(CONVENTIONS_BLOCK))
  assert.ok(brief.includes('GATE-SUMMARY {"total":n,"failed":n,"errored":n}'))
  assert.ok(brief.includes('#153'))
  assert.ok(brief.includes('#168'))
  assert.ok(brief.includes('#240'))
  assert.ok(brief.includes('#137'))
  assert.ok(brief.includes('Co-Authored-By'))
  assert.ok(brief.includes('Never push'))
  assert.ok(brief.includes('ReturnEnvelope'))
  assert.ok(brief.split(SLOT_MARKER).length - 1 >= 2)
  // Every other standing block is byte-identical to fc13fa1; b76 touched only the
  // mutation contract, and b161 moved the conventions block's floor.
  const digest = (text) => createHash('sha256').update(text).digest('hex')
  assert.equal(digest(ACCEPTANCE_GATE_BLOCK), 'd8fc7641f8ad456c0bd60032571a3c09d5f2a81e2fe0a480190369e854db61a2')
  assert.equal(digest(CONVENTIONS_BLOCK), 'e3d510a9129041cc5d30e2a81e4b2eadf898f812219a82d16ea6fd2f4d8d47f5')
})

// #672: the gate and the defect shared a blind spot — every check ran on the
// author's box, with the author's $HOME, $PATH and installed binaries. The rule
// ships in the standing acceptance block because that is the one surface that
// reaches every future lane without touching the protected driver.
test('every compiled brief requires a hostile-environment pass of the lane\'s own tests', () => {
  const root = fixture('hostile-env')
  const { brief } = compile(root)
  const gate = section(brief, '## Acceptance gate')
  assert.ok(gate.includes(HOSTILE_ENV_BLOCK))
  // the mechanism, not just the intent
  assert.ok(gate.includes('env -u CREW_CLAUDE_BIN HOME='))
  // and why: the three assumptions a same-environment gate cannot see
  for (const reason of ['resolved binary', '$HOME', '$PATH']) assert.ok(gate.includes(reason), reason)
  // stub-or-skip, both sanctioned forms, both precedents
  for (const clause of ['STUB', 'SKIP with a named reason', 't.skip(', 'crew/crew.test.mjs', 'crew/adapter-pi.test.mjs']) {
    assert.ok(gate.includes(clause), clause)
  }
  // additive: the block sits inside the acceptance section, once, and removing it
  // leaves the rest of the brief untouched.
  const inserted = `\n\n${HOSTILE_ENV_BLOCK}`
  assert.equal(brief.split(inserted).length, 2)
  assert.ok(brief.indexOf(ACCEPTANCE_GATE_BLOCK) < brief.indexOf(HOSTILE_ENV_BLOCK))
  assert.ok(brief.indexOf(HOSTILE_ENV_BLOCK) < brief.indexOf('## Per-check mutations'))
  assert.equal(brief.replace(inserted, '').includes('CREW_CLAUDE_BIN'), false)
})

// The per-check mutation contract must reach a planner mechanically: two lanes lost
// a plan round each to a format that lived only inside crew/drive.mjs (#330, #345).
// This test is also the anti-drift pin — the constants come from the enforcement
// point, so changing MUTATIONS_MAX or CHECK_FAIL_PREFIX reddens the prose.
test('every compiled brief carries the per-check mutation contract', () => {
  const root = fixture('mutation-contract')
  const { brief } = compile(root)
  assert.ok(brief.includes(MUTATION_CONTRACT_BLOCK))
  const contract = section(brief, '## Per-check mutations')
  assert.ok(contract.includes(MUTATION_CONTRACT_BLOCK))
  for (const clause of [
    'stable token', 'unique', `${CHECK_FAIL_PREFIX} <check>`, 'exempt', 'files_in_scope',
    'non-empty LITERAL', 'must DIFFER', 'at most', String(MUTATIONS_MAX), 'TOKEN SEQUENCE',
    'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe', 'unapplied',
    '/^[A-Za-z0-9][A-Za-z0-9._-]*$/', '"find"', '"replace"', '"check"',
  ]) assert.ok(MUTATION_CONTRACT_BLOCK.includes(clause), clause)
  // Additive: the section sits between the acceptance block and the validation lane,
  // appears once, and removing it leaves the rest of the brief untouched.
  const inserted = `\n## Per-check mutations\n${MUTATION_CONTRACT_BLOCK}`
  assert.equal(brief.split(inserted).length, 2)
  assert.ok(brief.indexOf(ACCEPTANCE_GATE_BLOCK) < brief.indexOf(inserted))
  assert.ok(brief.indexOf(inserted) < brief.indexOf('## Validation lane'))
  assert.equal(brief.replace(inserted, '').includes('Per-check mutations'), false)
})

// The delimiter is load-bearing: checkFailureLine (crew/drive.mjs) accepts the bare
// line or a colon and nothing else, and two lanes lost four gate generations to a
// human-readable separator (#387). The forms are asserted LITERALLY.
test('the mutation contract states the FAIL-line separator rule', () => {
  const root = fixture('fail-separator')
  const { brief } = compile(root)
  const contract = section(brief, '## Per-check mutations')
  assert.equal(contract, MUTATION_CONTRACT_BLOCK)
  const normalized = (text) => text.replace(/\s+/g, ' ').trim().replaceAll('**', '')
  const flat = normalized(contract)
  for (const clause of [
    'binds by TOKEN SEQUENCE',
    'whitespace and line wrapping are not load-bearing',
    'whitespace-only',
    'anchor must be unique after normalization',
    '`unapplied` (the declared file does not exist in the built tree)',
    '`anchor-absent` (the find text is nowhere in the file under either attempt)',
    '`anchor-ambiguous` (the normalized find matches more than one span)',
    '`anchor-unsafe` (the normalized match crosses a line carrying a `//` comment inside the span, so a verbatim replacement would land in that comment — declare a find that starts after the comment)',
    '`survived` remains the only gate defect',
    '#733',
  ]) assert.ok(flat.includes(clause), clause)
  assert.ok(flat.includes('non-empty LITERAL text naming the token sequence to bind'))
  assert.ok(/find and replace differ only in whitespace — that mutates no token(?![A-Za-z])/.test(flat))
  const unsafeClause = flat.slice(flat.indexOf('`anchor-unsafe`'), flat.indexOf('None of the four'))
  assert.ok(unsafeClause.includes('so a verbatim replacement would land in that comment'))
  assert.equal(unsafeClause.includes('single-line'), false)
  assert.equal(flat.includes('non-empty LITERAL text that actually occurs in that file'), false)
  for (const form of [
    'FAIL <check>',
    'FAIL <check>: <why>',
    'FAIL <check> — <why>',
    'FAIL <check> <why>',
  ]) assert.ok(contract.includes(form), form)
  for (const token of ['accepted', 'REJECTED', 'checkFailureLine', 'EXTENDED', 'FAIL cache-v2', '#330', '#387']) {
    assert.ok(contract.includes(token), token)
  }
})

test('the contract and ADR-030 name anchor-unsafe', () => {
  const adr = readFileSync(join(ROOT, 'docs', 'adr', 'adr-030-acceptance-authorship.md'), 'utf8')
  const paragraphs = adr.split(/\n\s*\n/).filter((paragraph) => paragraph.includes('anchor-absent'))
  assert.ok(paragraphs.length > 0)
  for (const paragraph of paragraphs) assert.ok(paragraph.includes('anchor-unsafe'))
  assert.ok(MUTATION_CONTRACT_BLOCK.includes('anchor-unsafe'))
})

// node --test picks its reporter by context, so the summary line's leading character is
// a fact about the invocation and not about the suite: measured on this checkout the
// default reporter emits `ℹ pass N` (U+2139) while --test-reporter=tap emits `# pass N`.
// Three separate failures in one day came from that gap (#399). The shapes are asserted
// LITERALLY, the same mechanism that closed the FAIL-separator problem above.
test('the mutation contract states the node --test reporter rule', () => {
  const root = fixture('reporter-rule')
  const { brief } = compile(root)
  const contract = section(brief, '## Per-check mutations')
  assert.equal(contract, MUTATION_CONTRACT_BLOCK)
  for (const form of ['ℹ pass 7', 'ℹ fail 0', '# pass 7', '# fail 0']) {
    assert.ok(contract.includes(form), form)
  }
  assert.ok(contract.includes('A gate that shells out to `node --test` MUST pass `--test-reporter=tap`'))
  for (const token of [
    'U+2139', 'context-dependent', 'future Node release', 'tolerant regex',
    'still silently depends on the reporter', 'LAST summary line', 'FORCE_COLOR',
    'OVERRIDES', 'NO_COLOR', 'DELETE', 'CLICOLOR_FORCE', '#240', '#399',
  ]) assert.ok(contract.includes(token), token)
})

// #409: the per-check proof asks whether a mutation reddens a check, never whether it
// exercises what the check CLAIMS. Four checks certified `killed` on 2026-08-20 were
// weaker than their own prose. The counter-examples are asserted inside the bullet that
// carries them — the same narrowness the clause demands, so a stray keyword elsewhere in
// the contract cannot satisfy this test.
test('the mutation contract demands a mutation exercising the narrowest claim', () => {
  const root = fixture('narrowest-claim')
  const { brief } = compile(root)
  const second = compile(root, {}, [], 'brief-second.md').brief
  assert.equal(second, brief)
  const contract = section(brief, '## Per-check mutations')
  assert.equal(contract, MUTATION_CONTRACT_BLOCK)
  const flat = (text) => text.replace(/\s+/g, ' ').trim()
  assert.ok(flat(contract).includes(
    "A declared mutation must exercise the check's NARROWEST claimed property, not merely redden the check.",
  ))
  const bullets = contract.split(/\n(?=- )/).filter((chunk) => chunk.startsWith('- ')).map(flat)
  const comment = bullets.filter((bullet) => bullet.includes('IN A COMMENT'))
  assert.equal(comment.length, 1)
  for (const clause of ['`C1`', 're-ask', 'text the check never reads',
    'Mutate the text the check actually parses']) assert.ok(comment[0].includes(clause), clause)
  const negative = bullets.filter((bullet) => bullet.includes('INDISTINGUISHABLE'))
  assert.equal(negative.length, 1)
  for (const clause of ['`G15`', 'an extension the target ALREADY had', 'the duplicate dedupes',
    'the injected fixture must be DISTINCTIVE',
    'compared BEFORE-AND-AFTER, never merely observed to be empty',
  ]) assert.ok(negative[0].includes(clause), clause)
  const compound = contract.split(/\n\s*\n/).map(flat).filter((p) => p.includes('COMPOUND CLAIM'))
  assert.equal(compound.length, 1)
  for (const clause of ['A COMPOUND CLAIM needs one mutation per half.', '`G15`', '`L11`',
    'two verbs', '#409']) assert.ok(compound[0].includes(clause), clause)
})

test('the charter and the checklist state the contract the driver enforces', () => {
  const charter = readFileSync(join(ROOT, 'crew', 'roles', 'planner.md'), 'utf8')
  const checklist = readFileSync(join(ROOT, 'crew', 'guidelines', 'seat-pre-return-checklist.md'), 'utf8')
  for (const token of ['"check"', '"file"', '"find"', '"replace"', '"exempt"', 'files_in_scope', '#330']) {
    assert.ok(charter.includes(token), token)
  }
  assert.match(charter, /\{\s*"check":\s*"[A-Za-z0-9][A-Za-z0-9._-]*"/)
  // the worked example pairs a token label with the human sentence in a comment
  assert.match(charter, /\/\/ MUTATION [A-Za-z0-9][A-Za-z0-9._-]*:/)
  assert.ok(charter.includes(String(MUTATIONS_MAX)))
  const p3 = checklist.slice(checklist.indexOf('- **P3'))
  for (const token of ['`find`', '`replace`', '`exempt`', 'files_in_scope', 'stable token']) {
    assert.ok(p3.includes(token), token)
  }
  assert.ok(p3.includes(`${CHECK_FAIL_PREFIX} <check>`))
})

test('out refusal and force overwrite follow the CLI contract', () => {
  const root = fixture('out-contract')
  const requestPath = request(root)
  const out = join(root, 'result.md')
  let result = run(root, ['--request', requestPath, '--checkout', root, '--out', out])
  assert.equal(result.status, 0)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', out])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-exists/)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', out, '--force'])
  assert.equal(result.status, 0)
  const outputDirectory = join(root, 'output-directory')
  mkdirSync(outputDirectory)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', outputDirectory, '--force'])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-exists/)
  result = run(root, ['--request', requestPath, '--checkout', root, '--out', join(root, 'missing', 'brief.md')])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /out-dir-missing/)
})

test('a nested git checkout resolves to the repository root', () => {
  const root = fixture('nested-checkout')
  const nested = join(root, 'scripts', 'factory')
  mkdirSync(nested, { recursive: true })
  const requestPath = request(root, { where: ['lib/widget.mjs'] })
  const outPath = join(root, 'nested-brief.md')
  const result = spawnSync(process.execPath, [
    SCRIPT, '--request', requestPath, '--out', outPath,
  ], {
    cwd: nested,
    encoding: 'utf8',
    env: { ...process.env, DEVTEAM_FACTORY_DIR: EMPTY_FACTORY },
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const brief = readFileSync(outPath, 'utf8')
  assert.match(section(brief, '## Baseline'), /pass 2/)
  assert.match(brief, /test\/widget\.test\.mjs/)
})

test('directory where entries expand for discovery while the authored directory is rendered', () => {
  const root = fixture('directory')
  const { brief } = compile(root, { where: ['lib'] })
  assert.match(section(brief, '## Where'), /verified · directory · lib/)
  assert.match(brief, /computeWidget/)
})

test('one-file scopes render a marked mechanical proposal with reasons', () => {
  const root = fixture('one-file-proposal')
  const { brief } = compile(root, { where: ['lib/widget.mjs'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /PROPOSAL ONLY/)
  assert.match(body, /proposed tier: mechanical/)
  assert.match(body, /^- .+/m)
  assert.ok(brief.indexOf('## The ask') < brief.indexOf('## Proposed tier'))
  assert.ok(brief.indexOf('## Proposed tier') < brief.indexOf('## Where'))
})

test('directory breadth proposes a higher tier and explains its source count', () => {
  const root = fixture('directory-proposal', { broad: true })
  const { brief } = compile(root, { where: ['lib'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /proposed tier: (build|judge)/)
  assert.match(body, /scope breadth: 2 source files/)
})

test('proposeTier pins breadth bands, directory raises, and tripwire-floor raises', () => {
  const proposal = (sourceCount, extra = {}) => proposeTier({
    where: Array.from({ length: sourceCount }, (_, index) => ({
      path: `lib/source-${index}.mjs`, kind: 'file',
    })),
    discovery: {
      candidates: Array.from({ length: sourceCount }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    ...extra,
  })
  assert.equal(proposal(1).tier, 'mechanical')
  assert.equal(proposal(2).tier, 'build')
  assert.equal(proposal(4).tier, 'build')
  assert.equal(proposal(5).tier, 'judge')

  const directory = proposeTier({
    where: [{ path: 'lib', kind: 'directory' }],
    discovery: { candidates: ['lib/source.mjs'], tripwires: [], broadKeys: [] },
  })
  assert.equal(directory.tier, 'build')
  assert.match(directory.reasons.join('\n'), /directory.*lib.*mechanical.*build/i)

  const floor = proposal(1, {
    discovery: {
      candidates: ['lib/source-0.mjs', ...Array.from({ length: 6 }, (_, index) => `test/pin-${index}.test.mjs`)],
      tripwires: Array.from({ length: 6 }, (_, index) => ({ file: `test/pin-${index}.test.mjs`, keys: [] })),
      broadKeys: [],
    },
  })
  assert.equal(floor.tier, 'build')
  assert.match(floor.reasons.join('\n'), /6 tripwire tests.*mechanical.*build/i)
})

test('proposeTier returns separate shape and strength proposals with distinct reasons', () => {
  const proposal = proposeTier({
    where: [{ path: 'lib/source.mjs', kind: 'file' }],
    discovery: { candidates: ['lib/source.mjs'], tripwires: [], broadKeys: [] },
    protectedPaths: ['lib/source.mjs'],
  })
  for (const field of ['tier', 'shape', 'strength', 'reasons', 'shapeReasons', 'strengthReasons', 'signals']) {
    assert.ok(Object.prototype.hasOwnProperty.call(proposal, field), `${field} missing`)
  }
  assert.equal(proposal.shape, 'build')
  assert.equal(proposal.strength, 'utility')
  assert.notDeepEqual(proposal.shapeReasons, proposal.strengthReasons)
  assert.ok(!TIER_NAMES.includes(proposal.strength))
})

test('risk signals drive shape independently of complexity', () => {
  const proposal = (sourceCount, protectedPaths = []) => proposeTier({
    where: Array.from({ length: sourceCount }, (_, index) => ({ path: `lib/source-${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: sourceCount }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths,
  })
  assert.equal(proposal(5).shape, 'mechanical')
  assert.equal(proposal(1, ['lib/source-0.mjs']).shape, 'build')
  assert.equal(proposal(5, ['lib/source-0.mjs', 'lib/source-1.mjs']).shape, 'judge')
})

test('complexity signals drive ratified strength independently of risk', () => {
  const proposal = (sourceCount, protectedPaths = []) => proposeTier({
    where: Array.from({ length: sourceCount }, (_, index) => ({ path: `lib/source-${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: sourceCount }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths,
  })
  assert.equal(proposal(1).strength, 'utility')
  assert.equal(proposal(3).strength, 'workhorse')
  assert.equal(proposal(5).strength, 'frontier')
  assert.equal(proposal(1, ['lib/source-0.mjs']).strength, 'utility')
})

test('strength proposals are restricted to the ratified ladder and explain each signal group', () => {
  assert.deepEqual([...LADDER_BANDS], readLadderBands())
  assert.ok(Object.isFrozen(LADDER_BANDS))
  assert.deepEqual(readLadderBands(join(fixtureRoot, 'missing-model-ladder.json')), [])
  const proposal = proposeTier({
    where: Array.from({ length: 5 }, (_, index) => ({ path: `lib/source-${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: 5 }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths: ['lib/source-0.mjs'],
    ladderBands: ['basement'],
  })
  assert.equal(proposal.strength, null)
  assert.match(proposal.shapeReasons.join('\n'), /protected/i)
  assert.match(proposal.strengthReasons.join('\n'), /scope breadth/)
  assert.match(proposal.strengthReasons.join('\n'), /tripwire tests pinning that scope/)
  assert.doesNotMatch(proposal.strengthReasons.join('\n'), /protected/i)
})

test('renderProposedTier labels tier, shape, and strength in risk then complexity order', () => {
  const proposal = proposeTier({
    where: Array.from({ length: 5 }, (_, index) => ({ path: `lib/source-${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: 5 }, (_, index) => `lib/source-${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths: [],
  })
  const rendered = (renderBrief({
    request: { ask: 'ask', done_means: 'done', out_of_scope: 'out' },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
    proposal,
  })).split('## Proposed tier')[1]
  assert.match(rendered, /proposed tier: judge/)
  assert.match(rendered, /proposed shape: mechanical/)
  assert.match(rendered, /because \(risk signals\):/)
  assert.match(rendered, /proposed strength: frontier/)
  assert.match(rendered, /because \(complexity signals\):/)
  assert.ok(rendered.indexOf('proposed shape:') < rendered.indexOf('proposed strength:'))
})

test('a mechanical shape priced above its column is named a misclassification in the brief', () => {
  const body = section(compiledProposal(proposalFor(5)), '## Proposed tier')
  const line = body.split('\n').find((candidate) => /misclassified/i.test(candidate))
  assert.ok(line)
  assert.match(line, /repropose the shape/)
  assert.match(line, /mechanical/)
  assert.match(line, /frontier/)
})

test('the misclassification discriminates by shape and complexity', () => {
  const cases = [
    proposalFor(1),
    proposalFor(5),
    proposalFor(5, ['lib/source-0.mjs', 'lib/source-1.mjs']),
  ]
  const carriesMisclassification = cases.map((proposal) => /misclassified/i.test(
    section(compiledProposal(proposal), '## Proposed tier'),
  ))
  assert.deepEqual(carriesMisclassification, [false, true, false])
  assert.equal(carriesMisclassification.filter(Boolean).length, 1)
  assert.ok(carriesMisclassification[1])
})

test('the misclassification flag rewrites neither proposal or proposal fence', () => {
  const proposal = proposalFor(5)
  const body = section(compiledProposal(proposal), '## Proposed tier')
  assert.equal(proposal.shape, 'mechanical')
  assert.equal(proposal.strength, 'frontier')
  assert.equal(proposal.tier, 'judge')
  const fence = body.match(/```proposal\n([\s\S]*?)\n```/)
  assert.ok(fence)
  assert.deepEqual(JSON.parse(fence[1]), { shape: 'mechanical', strength: 'frontier' })
})

test('governance survives a frugal strength', () => {
  const proposal = proposalFor(1, ['lib/source-0.mjs'])
  const body = section(compiledProposal(proposal), '## Proposed tier')
  // One protected hit is the ratified build shape floor; strength remains frugal.
  assert.equal(proposal.shape, 'build')
  assert.equal(proposal.strength, 'utility')
  assert.equal(proposal.tier, 'build')
  assert.match(body, /proposed shape: build/)
  assert.match(body, /proposed strength: utility/)
})

test('protected-path risk leaves the legacy tier and protected hits unchanged', () => {
  const proposal = proposeTier({
    where: [{ path: 'lib/source.mjs', kind: 'file' }],
    discovery: { candidates: ['lib/source.mjs'], tripwires: [], broadKeys: [] },
    protectedPaths: ['lib/source.mjs'],
  })
  assert.equal(proposal.tier, 'build')
  assert.deepEqual(proposal.signals.protectedHits, ['lib/source.mjs'])
})

test('protected paths default to the floor, raise one step, match directory prefixes, and reject malformed input', () => {
  const where = [{ path: 'lib/widget.mjs', kind: 'file' }]
  const discovery = {
    candidates: ['lib/widget.mjs', 'test/widget.test.mjs'],
    tripwires: [{ file: 'test/widget.test.mjs', keys: ['computeWidget'] }],
    broadKeys: [],
  }
  const omitted = proposeTier({ where, discovery })
  const empty = proposeTier({ where, discovery, protectedPaths: [] })
  for (const path of PROTECTED_PATHS) assert.ok(DEFAULT_PROTECTED_PATHS.includes(path), `${path} missing from the floor`)
  assert.equal(omitted.tier, empty.tier)
  assert.ok(omitted.signals.protectedHits.length === 0)
  assert.match(omitted.reasons.join('\n'), /protected paths in force: \d+/)
  const floorWhere = [{ path: 'crew/drive.mjs', kind: 'file' }]
  const floorDiscovery = { candidates: ['crew/drive.mjs', 'crew/drive.test.mjs'], tripwires: [{ file: 'crew/drive.test.mjs', keys: [] }], broadKeys: [] }
  for (const protectedPaths of [[], ['.github/workflows/', 'docs/adr/', 'package-lock.json']]) {
    const floorProposal = proposeTier({ where: floorWhere, discovery: floorDiscovery, protectedPaths })
    assert.ok(floorProposal.signals.protectedHits.includes('crew/drive.mjs'))
  }
  const raised = proposeTier({ where, discovery, protectedPaths: ['lib/widget.mjs'] })
  assert.equal(raised.tier, 'build')
  assert.deepEqual(raised.signals.protectedHits, ['lib/widget.mjs'])
  assert.match(raised.reasons.join('\n'), /protected path hit: lib\/widget\.mjs.*raised mechanical.*build/)
  assert.match(raised.reasons.join('\n'), /protected paths in force: \d+/)

  const prefix = proposeTier({
    where,
    discovery,
    protectedPaths: ['test/'],
  })
  assert.equal(prefix.tier, 'build')
  assert.deepEqual(prefix.signals.protectedHits, ['test/widget.test.mjs'])

  const judge = proposeTier({
    where: Array.from({ length: 5 }, (_, index) => ({ path: `lib/${index}.mjs`, kind: 'file' })),
    discovery: {
      candidates: Array.from({ length: 5 }, (_, index) => `lib/${index}.mjs`),
      tripwires: [],
      broadKeys: [],
    },
    protectedPaths: ['lib/0.mjs'],
  })
  assert.equal(judge.tier, 'judge')
  assert.match(judge.reasons.join('\n'), /protected path hit: lib\/0\.mjs.*unchanged/i)
  assert.match(judge.reasons.join('\n'), /protected paths in force: \d+/)
  assert.throws(() => proposeTier({ where, discovery, protectedPaths: 'lib/widget.mjs' }), (error) => error.reason === 'bad-protected')
  assert.throws(() => proposeTier({ where, discovery, protectedPaths: ['   '] }), (error) => error.reason === 'bad-protected')
})

test('protected file input is normalized, deduped, and wired through the CLI', () => {
  const root = fixture('protected-file')
  const protectedPath = put(root, 'protected.json', JSON.stringify({ paths: ['./lib/widget.mjs', 'lib\\widget.mjs', './lib/widget.mjs'] }) + '\n')
  const gathered = gatherProtectedPaths({ protectedPathsFile: protectedPath })
  assert.ok(gathered.includes('lib/widget.mjs'))
  for (const path of PROTECTED_PATHS) assert.ok(gathered.includes(path), `${path} missing from gathered paths`)
  const { brief } = compile(root, { where: ['lib/widget.mjs'] }, ['--protected', protectedPath])
  assert.match(section(brief, '## Proposed tier'), /proposed tier: build/)
  assert.match(section(brief, '## Proposed tier'), /lib\/widget\.mjs/)

  const malformed = put(root, 'bad-protected.json', '{"paths":"lib/widget.mjs"}\n')
  const result = run(root, [
    '--request', request(root, { where: ['lib/widget.mjs'] }), '--checkout', root,
    '--protected', malformed,
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /bad-protected/)
})

test('a ratified protected-path list adds to the floor and names its basis in the compiled brief', () => {
  const root = fixture('profile-protected-list')
  const profilePath = profile('protected-list', { protected_paths_candidates: ratified(['lib/']) })
  const { brief } = compile(root, {}, ['--profile', profilePath])
  const proposedSection = section(brief, '## Proposed tier')
  assert.match(proposedSection, /lib\/widget\.mjs/)
  assert.match(proposedSection, /protected_paths_candidates/)
  assert.match(proposedSection, new RegExp(profilePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
})

test('a brief compiled without a ratified list names the authored floor', () => {
  const root = fixture('profile-protected-floor')
  const { brief } = compile(root)
  const proposedSection = section(brief, '## Proposed tier')
  assert.match(proposedSection, /protected paths in force: \d+/)
  assert.match(proposedSection, /authored floor/)
})

test('a ratified protected-path list that is not a list refuses the compile', () => {
  const root = fixture('profile-protected-invalid')
  const profilePath = profile('protected-invalid', { protected_paths_candidates: ratified('lib/') })
  const outPath = join(root, 'invalid.md')
  const result = run(root, [
    '--request', request(root), '--checkout', root, '--out', outPath, '--profile', profilePath,
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /bad-protected/)
  assert.match(result.stderr, /protected-paths-invalid/)
  assert.equal(existsSync(outPath), false)
})

test('absence cases return neither proposal with reasons and render no proposal', () => {
  const emptyWhere = proposeTier({ where: [], discovery: { candidates: ['lib/a.mjs'], tripwires: [], broadKeys: [] } })
  assert.equal(emptyWhere.tier, null)
  assert.equal(emptyWhere.shape, null)
  assert.equal(emptyWhere.strength, null)
  assert.ok(emptyWhere.reasons.length)
  assert.ok(emptyWhere.shapeReasons.length)
  assert.ok(emptyWhere.strengthReasons.length)
  const emptyCandidates = proposeTier({ where: [{ path: 'lib/a.mjs', kind: 'file' }], discovery: { candidates: [], tripwires: [], broadKeys: [] } })
  assert.equal(emptyCandidates.tier, null)
  assert.equal(emptyCandidates.shape, null)
  assert.equal(emptyCandidates.strength, null)
  assert.ok(emptyCandidates.reasons.length)
  assert.ok(emptyCandidates.shapeReasons.length)
  assert.ok(emptyCandidates.strengthReasons.length)
  assert.deepEqual(emptyCandidates.signals.directoryWhere, [])
  const suppressed = proposeTier({
    where: [{ path: 'lib/a.mjs', kind: 'file' }],
    discovery: { candidates: ['lib/a.mjs'], tripwires: [], broadKeys: [{ key: 'a', count: 99 }, { key: 'b', count: 99 }] },
  })
  assert.equal(suppressed.tier, null)
  assert.equal(suppressed.shape, null)
  assert.equal(suppressed.strength, null)
  assert.ok(suppressed.shapeReasons.length)
  assert.ok(suppressed.strengthReasons.length)
  assert.match(suppressed.reasons.find((reason) => /2 key\(s\).*absent, not zero/.test(reason)), /2 key\(s\).*absent, not zero/)

  const root = fixture('no-proposal-render', { broad: true })
  const { brief } = compile(root, { where: ['lib/broad.mjs'] })
  const body = section(brief, '## Proposed tier')
  assert.match(body, /proposed tier: no proposal/)
  assert.match(body, /proposed shape: no proposal/)
  assert.match(body, /proposed strength: no proposal/)
  assert.match(body, /^- .+/m)
  assert.equal(renderProposalBlock({ shape: null, strength: null }), [
    '```proposal',
    '{',
    '  "shape": null,',
    '  "strength": null',
    '}',
    '```',
  ].join('\n'))
  assert.match(body, /```proposal\n\{\n  "shape": null,\n  "strength": null\n\n?\}\n```/)
})

test('shape and strength proposals ship inside the Proposed tier section', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  assert.match(source, /export function proposeTier/)
  assert.doesNotMatch(source, /--blueprint|proposeBlueprint/i)
  assert.doesNotMatch(source, /^##+\s*(Shape|Blueprint)\b/im)
  const brief = renderBrief({
    request: { ask: 'an ask', done_means: 'done means', out_of_scope: 'out of scope' },
    where: [],
    discovery: { candidates: [], tripwires: [], broadKeys: [] },
    proposal: proposeTier({ where: [], discovery: { candidates: [], tripwires: [], broadKeys: [] } }),
  })
  assert.deepEqual(brief.match(/^## .+$/gm), [
    '## The ask', '## Intent', '## Proposed tier', '## Where', '## Done means', '## Tripwires',
    '## Coupled sources', '## Baseline', '## Out of scope', '## Fences',
    '## What the crew decides', '## Acceptance', '## Acceptance gate',
    '## Per-check mutations', '## Validation lane', '## Conventions',
  ])
  assert.equal((brief.match(/proposed strength:/g) || []).length, 1)
  const start = brief.indexOf('## Proposed tier')
  const end = brief.indexOf('## Where')
  const strength = brief.indexOf('proposed strength:')
  const fence = brief.indexOf('```proposal')
  assert.ok(strength > start && strength < fence)
  assert.ok(fence > start && fence < end)
  assert.equal(brief.slice(fence, brief.indexOf('```', fence + 3) + 3), renderProposalBlock(brief.includes('proposed shape: mechanical')
    ? { shape: 'mechanical', strength: 'workhorse' }
    : { shape: null, strength: null }))
})

test('proposal block renders exact mechanical/workhorse bytes and filters out-of-vocabulary values', () => {
  assert.equal(renderProposalBlock({ shape: 'mechanical', strength: 'workhorse' }), [
    '```proposal',
    '{',
    '  "shape": "mechanical",',
    '  "strength": "workhorse"',
    '}',
    '```',
  ].join('\n'))
  assert.equal(renderProposalBlock({ shape: 'not-a-shape', strength: 'not-a-band' }), [
    '```proposal',
    '{',
    '  "shape": null,',
    '  "strength": null',
    '}',
    '```',
  ].join('\n'))
})

test('compiler and emitter proposal declarations stay in agreement', () => {
  assert.equal(PROPOSAL_BLOCK, EMIT_PROPOSAL_BLOCK)
  assert.deepEqual(PROPOSAL_KEYS, EMIT_PROPOSAL_KEYS)
})

test('the parser returns a refusal code for an unknown CLI option', () => {
  assert.equal(main(['--bogus']), 2)
  assert.equal(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length)
  assert.equal(REFUSAL_REASONS.length, 24)
  assert.ok(REFUSAL_REASONS.includes('directed-unknown-key'))
  assert.ok(REFUSAL_REASONS.includes('directed-shape'))
  assert.ok(REFUSAL_REASONS.includes('directed-fence-collision'))
  assert.ok(REFUSAL_REASONS.includes('scope-directory-unslashed'))
  assert.ok(REFUSAL_REASONS.includes('scope-entry-shape'))
  assert.ok(REFUSAL_REASONS.includes('scope-entry-case'))
  assert.ok(REFUSAL_REASONS.includes('coupled-source-unfenced'))
  assert.ok(REFUSAL_REASONS.includes('stale-read-ack'))
  assert.ok(REFUSAL_REASONS.includes('profile-unreadable'))
  assert.ok(REFUSAL_REASONS.includes('profile-unratified'))
  assert.ok(REFUSAL_REASONS.includes('bad-protected'))
  assert.ok(REFUSAL_REASONS.includes('creates-exists'))
  assert.ok(REFUSAL_REASONS.includes('creates-parent-missing'))
})

test('the compiler parses cleanly with node --check', () => {
  const result = spawnSync(process.execPath, ['--check', SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('direct gatherers refuse a non-git checkout and preserve verified entries', () => {
  const nonRepo = join(fixtureRoot, 'not-a-repo')
  mkdirSync(nonRepo, { recursive: true })
  put(nonRepo, 'file.txt', 'x\n')
  assert.throws(() => verifyWhere({ checkout: nonRepo, where: ['file.txt'] }), (error) => error.reason === 'not-a-git-repo')
  const root = fixture('direct-gatherers')
  const verified = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  assert.deepEqual(verified, [{ path: 'lib/widget.mjs', kind: 'file' }])
  const found = discoverTripwires({ checkout: root, files: verified })
  assert.ok(Array.isArray(found.candidates))
  assert.ok(Array.isArray(found.tripwires))
})

test('extractSymbols is the exported-symbol half and tolerates object input', () => {
  const source = { file: './lib/example.mjs', source: [
    'export const PublicValue = 1',
    'export async function runThing() {}',
    'export { hidden as PublicAlias, plain }',
    "const code = 'cache:miss'",
  ].join('\n') }
  assert.deepEqual(extractSymbols(source), ['PublicAlias', 'PublicValue', 'plain', 'runThing'])
  const names = [...new Set(exportEntries(source).map((entry) => entry.name))].filter((name) => name.length >= 4).sort()
  assert.deepEqual(extractSymbols(source), names)
  assert.deepEqual(extractSymbols("export const PublicValue = 1", 'docs/example.txt'), [])
})

test('real limits discovery names its non-test callers without widening tripwires', () => {
  const where = verifyWhere({ checkout: ROOT, where: ['crew/limits.mjs'] })
  const discovery = discoverTripwires({ checkout: ROOT, files: where })
  const caller = discovery.coupled.find((entry) => entry.file === 'crew/child.mjs')
  assert.ok(caller)
  assert.ok(caller.keys.includes('resolveLimits'))
  assert.equal(discovery.coupled.some((entry) => entry.file === 'crew/arms.mjs'), false)
})

test('real crew-drive discovery retains crew-child as an exported-symbol caller', () => {
  const where = verifyWhere({ checkout: ROOT, where: ['crew/drive.mjs'] })
  const discovery = discoverTripwires({ checkout: ROOT, files: where })
  const caller = discovery.coupled.find((entry) => entry.file === 'crew/child.mjs')
  assert.ok(caller)
  assert.ok(caller.keys.includes('driveTask'))
})

test('coupling refuses an unfenced caller and quiets when every caller is covered', () => {
  const where = verifyWhere({ checkout: ROOT, where: ['crew/limits.mjs'] })
  const discovery = discoverTripwires({ checkout: ROOT, files: where })
  assert.throws(() => crossCheckCoupling({
    discovery,
    writeSurface: { basis: 'fences', files: ['crew/limits.mjs'], reads: [] },
  }), (error) => error.reason === 'coupled-source-unfenced' && /crew\/child\.mjs/.test(error.message))
  const quiet = crossCheckCoupling({
    discovery,
    writeSurface: { basis: 'fences', files: [
      'crew/limits.mjs',
      ...discovery.coupled.map((entry) => entry.file),
    ], reads: [] },
  })
  assert.deepEqual(quiet.unfenced, [])
})

test('a coupled fixture refuses a fence that omits its caller', () => {
  const root = fixture('coupled-firing', { coupledCaller: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'] }],
  }, null, 2)}\n`)
  const result = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'refused.md'),
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /coupled-source-unfenced/)
  assert.match(result.stderr, /lib\/caller\.mjs/)
})

test('a valid acknowledgement does not clear another unfenced coupled source', () => {
  const where = verifyWhere({ checkout: ROOT, where: ['crew/limits.mjs'] })
  const discovery = discoverTripwires({ checkout: ROOT, files: where })
  assert.throws(() => crossCheckCoupling({
    discovery,
    writeSurface: {
      basis: 'fences',
      files: ['crew/limits.mjs'],
      reads: [{ file: 'crew/child.mjs', why: 'read only here' }],
    },
  }), (error) => error.reason === 'coupled-source-unfenced' && /crew\/crew\.mjs/.test(error.message))
})

test('a coupled fixture renders an in-fence caller', () => {
  const root = fixture('coupled-quiet', { coupledCaller: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs', 'lib/caller.mjs'] }],
  }, null, 2)}\n`)
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'])
  const body = section(brief, '## Coupled sources')
  assert.match(body, /lib\/caller\.mjs · .*computeWidget.*inside this lane's fence/)
  assert.match(brief, /floor, not a proof/)
  assert.match(brief, /cit(e|ation)/i)
})

test('a coupled fixture can acknowledge a read-only caller verbatim', () => {
  const root = fixture('coupled-ack', { coupledCaller: true })
  const why = 'caller is owned by the adjacent lane; do not edit it'
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'], reads: [{ file: './lib/caller.mjs', why }] }],
  }, null, 2)}\n`)
  assert.deepEqual(gatherFences({ fencesPath })[0].reads, [{ file: 'lib/caller.mjs', why }])
  const { brief } = compile(root, {}, ['--fences', fencesPath, '--lane', 'own'])
  assert.match(section(brief, '## Coupled sources'), new RegExp(`acknowledged read-only: ${why}`))
})

test('stale and malformed coupling acknowledgements refuse by input reason', () => {
  const root = fixture('coupled-bad-reads', { coupledCaller: true })
  const stalePath = put(root, 'stale-fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'], reads: [{ file: 'config/thing.yml', why: 'not a caller' }] }],
  }, null, 2)}\n`)
  const stale = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', stalePath, '--lane', 'own', '--out', join(root, 'stale.md'),
  ])
  assert.equal(stale.status, 2)
  assert.match(stale.stderr, /stale-read-ack/)
  for (const [label, reads] of [
    ['blank', [{ file: 'lib/caller.mjs', why: '   ' }]],
    ['not-object', ['lib/caller.mjs']],
    ['duplicate', [
      { file: 'lib/caller.mjs', why: 'one' },
      { file: './lib/caller.mjs', why: 'two' },
    ]],
  ]) {
    const path = put(root, `${label}-fences.json`, `${JSON.stringify({
      lanes: [{ lane: 'own', files: ['lib/widget.mjs'], reads }],
    }, null, 2)}\n`)
    const result = run(root, [
      '--request', request(root), '--checkout', root,
      '--fences', path, '--lane', 'own', '--out', join(root, `${label}.md`),
    ])
    assert.equal(result.status, 2, label)
    assert.match(result.stderr, /bad-fences/, label)
  }
  const notesPath = put(root, 'notes-fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'], notes: 'mute' }],
  }, null, 2)}\n`)
  const notes = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', notesPath, '--lane', 'own', '--out', join(root, 'notes.md'),
  ])
  assert.equal(notes.status, 2)
  assert.match(notes.stderr, /bad-fences/)
})

test('isTripwireFile recognises test suffixes and the test directory', () => {
  assert.equal(isTripwireFile('crew/crew.test.mjs'), true)
  assert.equal(isTripwireFile('test/helpers.mjs'), true)
  assert.equal(isTripwireFile('crew/crew.mjs'), false)
})

test('no fence reports coupling without enforcing it', () => {
  const root = fixture('coupled-no-fence', { coupledCaller: true })
  const { brief } = compile(root)
  assert.match(section(brief, '## Coupled sources'), /lib\/caller\.mjs.*no fence in play/)
  const where = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  const discovery = discoverTripwires({ checkout: root, files: where })
  const report = crossCheckCoupling({
    discovery,
    writeSurface: resolveWriteSurface({ fences: null, lane: null, where }),
  })
  assert.equal(report.enforced, false)
  assert.ok(report.coupled.length > 0)
  assert.ok(report.coupled.every((entry) => entry.status === 'no-fence'))
})

test('broad exported keys never become coupled sources', () => {
  const root = fixture('broad-sources', { broadSources: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/broad.mjs'] }],
  }, null, 2)}\n`)
  const { brief } = compile(root, { where: ['lib/broad.mjs'] }, [
    '--fences', fencesPath, '--lane', 'own',
  ], 'broad-sources.md')
  const tripwires = section(brief, '## Tripwires')
  const coupled = section(brief, '## Coupled sources')
  assert.match(tripwires, /BROAD_PIN · .* hits/)
  assert.doesNotMatch(coupled, /BROAD_PIN/)
})

test('rendering absent coupling discovery states that it was not checked', () => {
  const root = fixture('render-absent-coupling')
  const where = verifyWhere({ checkout: root, where: ['lib/widget.mjs'] })
  const brief = renderBrief({
    request: JSON.parse(readFileSync(request(root), 'utf8')),
    where,
    discovery: { candidates: ['lib/widget.mjs'], tripwires: [], broadKeys: [] },
    baseline: { lane: null, pass: null, fail: null, status: 'unknown', reason: 'not-gathered' },
    writeSurface: { basis: 'fences', lane: 'own', files: ['lib/widget.mjs'], reads: [] },
  })
  const body = section(brief, '## Coupled sources')
  assert.match(body, /not discovered — this caller supplied no coupling discovery/)
  assert.doesNotMatch(body, /none discovered/)
})

test('stale acknowledgements refuse before unfenced coupled sources', () => {
  const root = fixture('coupled-ordering', { coupledCaller: true })
  const fencesPath = put(root, 'fences.json', `${JSON.stringify({
    lanes: [{ lane: 'own', files: ['lib/widget.mjs'], reads: [{ file: 'config/thing.yml', why: 'stale' }] }],
  }, null, 2)}\n`)
  const result = run(root, [
    '--request', request(root), '--checkout', root,
    '--fences', fencesPath, '--lane', 'own', '--out', join(root, 'ordering.md'),
  ])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /stale-read-ack/)
  assert.doesNotMatch(result.stderr, /coupled-source-unfenced/)
})
