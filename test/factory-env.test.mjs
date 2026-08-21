import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'
import { NODE_FLOOR } from '../scripts/factory/ledger.mjs'

const workflowYml = readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const configMd = readFileSync(join(ROOT, '.claude/dev-team/config.md'), 'utf8')

test('CI workflow runs exactly one Node job, at or above NODE_FLOOR', () => {
  const matches = [...workflowYml.matchAll(/node-version:\s*"?(\d+)/g)]
  assert.equal(matches.length, 1, `expected exactly one concrete node-version declaration, found ${matches.length}`)
  const major = Number(matches[0][1])
  const floorMajor = Number(NODE_FLOOR.split('.')[0])
  assert.ok(major >= floorMajor, `CI node major ${major} is below NODE_FLOOR ${NODE_FLOOR}`)
})

test('CI workflow declares no Node 20 leg', () => {
  const versionLines = workflowYml.split('\n').filter((line) => line.includes('node-version:'))
  assert.ok(!versionLines.some((line) => /\b20\b/.test(line)), 'a node-version line still mentions Node 20')
})

test('.gitignore contains all four run-trace mirror db artifact patterns', () => {
  const lines = gitignore.split('\n').map((s) => s.trim())
  for (const p of ['*.db', '*.db-wal', '*.db-shm', '*.db-journal']) {
    assert.ok(lines.includes(p), `missing ignore pattern ${p}`)
  }
})

test('package.json exposes the eight read-only ledger recipes pointing at the ledger entry point', () => {
  const names = ['ledger:sessions', 'ledger:phases', 'ledger:tail', 'ledger:procs', 'ledger:gate-review-gap', 'ledger:eligible-tasks', 'ledger:run-set', 'ledger:task']
  for (const name of names) {
    assert.ok(name in pkg.scripts, `missing script ${name}`)
    assert.match(pkg.scripts[name], /scripts\/factory\/ledger\.mjs/, `${name} does not invoke the ledger entry point`)
  }
})

test('no npm script name exposes a destructive ledger verb', () => {
  for (const name of Object.keys(pkg.scripts)) {
    assert.doesNotMatch(name, /kill|prune|delete|reset/i, `script name ${name} looks destructive`)
  }
})

// Replaced the former "has no `engines` field" assertion; superseded by ADR-031.
test("package.json's engines.node floor is exactly NODE_FLOOR", () => {
  const declared = pkg.engines?.node
  const message = `package.json engines.node (${declared}) must declare the same floor as NODE_FLOOR (${NODE_FLOOR}) in scripts/factory/ledger.mjs — change both or neither`
  assert.ok(declared, message)
  const match = String(declared).match(/(\d+)\.(\d+)\.(\d+)/)
  assert.ok(match, message)
  assert.equal(match[0], NODE_FLOOR, message)
  assert.match(String(declared), />=/, message)
})

test('config.md review_defaults section documents scripts/factory/*.mjs', () => {
  const start = configMd.indexOf('## review_defaults')
  assert.ok(start !== -1, 'review_defaults heading not found')
  const rest = configMd.slice(start + '## review_defaults'.length)
  const nextHeadingIdx = rest.indexOf('\n## ')
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  assert.ok(section.includes('scripts/factory/*.mjs'), 'review_defaults section is missing scripts/factory/*.mjs')
})

// Ledger sandbox tripwire (#432). A test file that drives openRun() writes rows
// through DEVTEAM_LEDGER_DIR || homedir()/.dev-team/factory
// (scripts/factory/ledger.mjs:2903). crew/crew.test.mjs and crew/daemon.test.mjs
// wrote 13 and 7 records into the operator's live register before this lane;
// this tripwire is what stops the next such file doing it silently. The sandbox
// must be at MODULE SCOPE — a column-0 assignment, before any test runs —
// because per-call wrapping is precisely what leaked.
const LEDGER_WRITER_KEY = 'openRun('
const LEDGER_SANDBOX_ASSIGNMENT = /^process\.env\.DEVTEAM_LEDGER_(DIR|DB) = /m
// Measured 2026-08-21 under a sentinel HOME: each of these runs openRun() with
// an explicit dbPath under a per-test temp stateDir and creates nothing under
// ~/.dev-team. An exemption is a deliberate, reviewed entry — never silence.
const LEDGER_SANDBOX_EXEMPT = new Map([
  ['test/factory-emit.test.mjs', 'passes an explicit dbPath under a per-test temp stateDir; measured to create nothing under a sentinel HOME'],
  ['test/factory-emit-floor.test.mjs', 'passes an explicit dbPath under a per-test temp stateDir; measured to create nothing under a sentinel HOME'],
  ['test/factory-ledger.test.mjs', 'sets DEVTEAM_LEDGER_DB per call and passes explicit db paths; measured to create nothing under a sentinel HOME'],
])
const TRIPWIRE_SELF = 'test/factory-env.test.mjs'

function ledgerSandboxVerdict(source) {
  if (!source.includes(LEDGER_WRITER_KEY)) return 'not-a-writer'
  return LEDGER_SANDBOX_ASSIGNMENT.test(source) ? 'sandboxed' : 'unsandboxed'
}

function testFilesUnder(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1))
}

test('ledger sandbox tripwire — every test file that drives a ledger writer sandboxes it at module scope', () => {
  const offenders = []
  for (const file of [...testFilesUnder('crew'), ...testFilesUnder('test')]) {
    if (file === TRIPWIRE_SELF) continue
    if (LEDGER_SANDBOX_EXEMPT.has(file)) continue
    if (ledgerSandboxVerdict(readFileSync(join(ROOT, file), 'utf8')) === 'unsandboxed') offenders.push(file)
  }
  assert.deepEqual(offenders, [], `these files drive ${LEDGER_WRITER_KEY}) with no module-scope DEVTEAM_LEDGER_DIR sandbox, so they write into the operator's ~/.dev-team/factory: ${offenders.join(', ')}`)
})

test('ledger sandbox tripwire — the verdict accepts a module-scope sandbox and rejects a per-call one', () => {
  const writer = ['openRun({ stateDir })', ''].join('\n')
  assert.equal(ledgerSandboxVerdict(`${writer}process.env.DEVTEAM_LEDGER_DIR = dir\n`), 'sandboxed')
  assert.equal(ledgerSandboxVerdict(`${writer}  process.env.DEVTEAM_LEDGER_DIR = dir\n`), 'unsandboxed')
  assert.equal(ledgerSandboxVerdict(`${writer}const dir = tmpdir()\n`), 'unsandboxed')
  assert.equal(ledgerSandboxVerdict('const x = 1\n'), 'not-a-writer')
})

test('ledger sandbox tripwire — every exemption names a live writer file', () => {
  for (const [file, why] of LEDGER_SANDBOX_EXEMPT) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(source.includes(LEDGER_WRITER_KEY), `exemption ${file} no longer drives ${LEDGER_WRITER_KEY}) — delete it`)
    assert.ok(why.length > 20, `exemption ${file} carries no reason`)
  }
  for (const file of ['crew/crew.test.mjs', 'crew/daemon.test.mjs']) {
    assert.ok(!LEDGER_SANDBOX_EXEMPT.has(file), `${file} is the leak this tripwire exists for and may never be exempted`)
  }
})
