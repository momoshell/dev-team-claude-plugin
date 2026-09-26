import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { psSnapshot } from '../crew/seat-io.mjs'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { scratchDir, git } from './helpers.mjs'
import * as mod from '../scripts/factory/prove-mutations.mjs'
import { parseDiffMutationReport } from '../crew/drive.mjs'

// Each child side effect below lands after its runner's old fixed bound on purpose: the
// tests order on the event, so a bigger delay costs time, never a verdict.
const LATE_SPAWN_DELAY_MS = Number(process.env.REAP_LATE_SPAWN_DELAY_MS ?? 2000)
const PIPE_LINGER_MS = Number(process.env.REAP_PIPE_LINGER_MS ?? 1200)
const WRITER_DELAY_MS = Number(process.env.REAP_WRITER_DELAY_MS ?? 1000)

const WIDGET = [
  'export function widget(mode) {',
  "  const alpha = 'alpha'",
  '  return `${alpha}:${mode}`',
  '}',
  '',
].join('\n')
const FIND = "const alpha = 'alpha'"
const REPLACE = "const alpha = 'beta'"
const OTHER = 'export const other = 1\n'
const BLOB = Buffer.from([0x41, 0xff, 0xfe, 0x0a])
const BLOB_TAMPERED = Buffer.from([0x41, 0xfe, 0xff, 0x0a])
const LINK = Buffer.from([0x41, 0xff, 0xfe])
const LINK_TAMPERED = Buffer.from([0x41, 0xfe, 0xff])
const DECL = Object.freeze({ check: 'X1', file: 'lib/widget.mjs', find: FIND, replace: REPLACE })
const GREEN = { ok: true, output: 'GATE-SUMMARY {"total":1,"failed":0,"errored":0}' }
const GREEN_COLOURED = { ok: true, output: '\x1b[32mok X1\x1b[39m\n\x1b[34mGATE-SUMMARY {"total":1,"failed":0,"errored":0}\x1b[39m' }
const RED = { ok: false, output: 'FAIL X1: the alpha branch is gone\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}' }

function fixture() {
  const root = scratchDir('prove-mutations-')
  const checkout = join(root, 'repo')
  mkdirSync(join(checkout, 'lib'), { recursive: true })
  execFileSync('git', ['init', '-q', checkout], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(join(checkout, 'lib/widget.mjs'), WIDGET)
  writeFileSync(join(checkout, 'lib/other.mjs'), OTHER)
  writeFileSync(join(checkout, 'lib/blob.bin'), BLOB)
  symlinkSync(LINK, join(checkout, 'lib/link'))
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-q', '-m', 'base')
  return {
    root,
    checkout,
    file: join(checkout, 'lib/widget.mjs'),
    other: join(checkout, 'lib/other.mjs'),
    blob: join(checkout, 'lib/blob.bin'),
    link: join(checkout, 'lib/link'),
  }
}

function sequence(...results) {
  let index = 0
  return (...args) => results[Math.min(index++, results.length - 1)](...args)
}

function plannerEnvelope(declarations = [DECL]) {
  return { details: { mutations: declarations, gate_cmd: 'stub' } }
}

function builderEnvelope(corrections) {
  return { details: { mutation_corrections: corrections } }
}

function commitBuilt(checkout, relative, file, text) {
  writeFileSync(file, text)
  git(checkout, 'add', relative)
  git(checkout, 'commit', '-q', '-m', 'built')
}

function noOutput() {
  return { stdout: () => {}, stderr: () => {} }
}

function removeKept(result) {
  for (const dir of result?.kept || []) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

function allOutcomes(counts) {
  return counts.killed + counts.survived + counts.bindFail + counts.unapplied + counts.errored + counts.exempt
}

// Mutation killed: accepting an invalid declaration as absent silently drops proof coverage.
test('readDeclarations normalizes check and id and reports malformed entries', () => {
  const read = mod.readDeclarations({ details: { mutations: [
    DECL,
    { id: 'X2', file: 'lib/widget.mjs', find: FIND, replace: REPLACE },
    { check: 'X3', exempt: 'covered by another lane' },
    { check: 'X4', file: 'lib/widget.mjs', replace: REPLACE },
  ] } })
  assert.deepEqual(read.declarations.map((entry) => entry.check), ['X1', 'X2', 'X3'])
  assert.equal(read.declarations[2].exempt, 'covered by another lane')
  assert.equal(read.refusals.length, 1)
  assert.equal(read.refusals[0].check, 'X4')
  assert.match(read.refusals[0].why, /find/)
})

// Mutation killed: measuring mutations against a non-green baseline credits failures that predate the mutation.
test('a non-green baseline is refused before mutation rows are made', () => {
  const { checkout } = fixture()
  const calls = []
  const runGate = (cmd, cwd) => {
    calls.push(cwd)
    return { ok: false, output: 'FAIL X1\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}' }
  }
  const result = mod.proveMutations({ checkout, declarations: [DECL], gateCmd: 'stub', deps: { runGate } })
  assert.equal(result.refusal.reason, 'baseline-not-green')
  assert.equal(result.rows.length, 0)
  assert.equal(result.counts.killed, 0)
  assert.equal(calls.length, 1)
  removeKept(result)
})

// Mutation killed: ignoring unrelated dirty paths measures HEAD instead of the built tree.
test('an uncommitted declared file refuses without running the gate', () => {
  const { checkout, file } = fixture()
  writeFileSync(file, `${WIDGET}// uncommitted build\n`)
  let runs = 0
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: () => { runs += 1; return GREEN } },
  })
  assert.equal(result.refusal.reason, 'tree-uncommitted')
  assert.equal(runs, 0)
})

// Mutation killed: restoring only on the happy path leaks mutated bytes when the gate throws.
test('proveOne restores bytes after a gate throw', () => {
  const { checkout, file } = fixture()
  const original = readFileSync(file)
  let seen = null
  assert.throws(() => mod.proveOne({
    dir: checkout,
    mutation: DECL,
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        seen = readFileSync(file)
        throw new Error('gate interrupted')
      },
    },
  }))
  assert.ok(seen)
  assert.ok(seen.includes(Buffer.from(REPLACE)))
  assert.deepEqual(readFileSync(file), original)
})

// Mutation killed: omitting the occurrence count hides whether a declaration bound zero or many spans.
test('zero and multiple bind occurrences report BIND-FAIL counts and later rows continue', () => {
  const { checkout } = fixture()
  const zero = { check: 'X2', file: 'lib/widget.mjs', find: 'not-present-9f3a', replace: 'beta' }
  const many = { check: 'X3', file: 'lib/widget.mjs', find: 'alpha', replace: 'beta' }
  const result = mod.proveMutations({
    checkout,
    declarations: [zero, many, DECL],
    gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => RED) },
  })
  assert.deepEqual(result.rows.map((row) => row.outcome), ['bind-fail', 'bind-fail', 'killed'])
  const report = mod.formatReport(result).join('\n')
  assert.match(report, /X2 .*BIND-FAIL\(0\)/)
  assert.match(report, /X3 .*BIND-FAIL\(3\)/)
  assert.equal(result.rows.at(-1).check, 'X1')
})

// Mutation killed: reporting every bound mutation as killed turns an unnoticed mutation into proof.
test('a green mutation is survived and not counted as killed', () => {
  const { checkout } = fixture()
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => GREEN) },
  })
  assert.equal(result.rows[0].outcome, 'survived')
  assert.equal(result.counts.killed, 0)
  assert.match(mod.formatReport(result).join('\n'), /SURVIVED/)
})

test('A1 corrected anchor resolution uses the builder correction', () => {
  const { root, checkout, file } = fixture()
  const correctedFind = "const alpha = 'built'"
  const built = WIDGET.replace(FIND, correctedFind)
  commitBuilt(checkout, 'lib/widget.mjs', file, built)
  const planner = plannerEnvelope()
  const resolved = mod.resolveDeclarations(planner, builderEnvelope([
    { check: 'X1', find: correctedFind, replace: "const alpha = 'corrected'" },
  ]), (path) => path === DECL.file ? readFileSync(file, 'utf8') : null)
  assert.equal(mod.bindOccurrences(built, FIND), 0)
  assert.equal(mod.bindOccurrences(built, correctedFind), 1)
  assert.equal(resolved.refusals.length, 0)
  assert.equal(resolved.declarations[0].find, correctedFind)
  assert.equal(resolved.declarations[0].provenance, 'builder-correction')
  const result = mod.proveMutations({
    checkout, declarations: resolved.declarations, invalid: resolved.refusals, gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => RED) },
  })
  assert.equal(result.refusal, null)
  assert.deepEqual(result.rows.map((row) => row.outcome), ['killed'])
  assert.equal(result.rows[0].check, 'X1')
  assert.equal(result.rows[0].provenance, 'builder-correction')
  assert.equal(result.counts.bindFail, 0)
  removeKept(result)
  rmSync(root, { recursive: true, force: true })
})

test('B1 proof rows name builder and planner anchor provenance', () => {
  const { root, checkout, file } = fixture()
  const correctedFind = "const alpha = 'built'"
  const second = { check: 'X2', file: 'lib/other.mjs', find: 'export const other = 1', replace: 'export const other = 2' }
  const built = WIDGET.replace(FIND, correctedFind)
  commitBuilt(checkout, 'lib/widget.mjs', file, built)
  const resolved = mod.resolveDeclarations(
    plannerEnvelope([DECL, second]),
    builderEnvelope([{ check: 'X1', find: correctedFind, replace: "const alpha = 'corrected'" }]),
    (path) => path === DECL.file ? readFileSync(file, 'utf8') : path === second.file ? OTHER : null,
  )
  assert.deepEqual(resolved.declarations.map((row) => row.provenance), ['builder-correction', 'planner-declaration'])
  let runs = 0
  const result = mod.proveMutations({
    checkout, declarations: resolved.declarations, invalid: resolved.refusals, gateCmd: 'stub',
    deps: {
      runGate: () => {
        runs += 1
        if (runs === 1) return GREEN
        const check = runs === 2 ? 'X1' : 'X2'
        return { ok: false, output: `FAIL ${check}\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}` }
      },
    },
  })
  const jsonRows = JSON.parse(JSON.stringify(result)).rows
  assert.deepEqual(jsonRows.map((row) => row.provenance), ['builder-correction', 'planner-declaration'])
  const human = mod.formatReport(result).join('\n')
  assert.match(human, /anchor=builder-correction \(standalone validation\)/)
  assert.match(human, /anchor=planner-declaration/)
  removeKept(result)
  rmSync(root, { recursive: true, force: true })
})

test('C1 declarations without corrections retain the planner anchor', () => {
  const { root, checkout, file } = fixture()
  const resolved = mod.resolveDeclarations(plannerEnvelope(), undefined, () => { throw new Error('no builder read expected') })
  assert.equal(resolved.refusals.length, 0)
  assert.equal(resolved.declarations[0].find, FIND)
  assert.equal(resolved.declarations[0].replace, REPLACE)
  assert.equal(resolved.declarations[0].provenance, 'planner-declaration')
  let runs = 0
  let mutated = null
  const result = mod.proveMutations({
    checkout, declarations: resolved.declarations, invalid: resolved.refusals, gateCmd: 'stub',
    deps: {
      runGate: (cmd, cwd) => {
        if (runs++ === 0) return GREEN
        mutated = readFileSync(join(cwd, DECL.file), 'utf8')
        return RED
      },
    },
  })
  assert.equal(result.refusal, null)
  assert.equal(result.rows[0].outcome, 'killed')
  assert.equal(result.rows[0].provenance, 'planner-declaration')
  assert.ok(mutated.includes(REPLACE))
  assert.doesNotMatch(mod.formatReport(result).join('\n'), /builder-correction/)
  removeKept(result)
  rmSync(root, { recursive: true, force: true })
})

test('D1 stale and ambiguous corrections refuse without planner fallback', () => {
  const cases = [
    { reason: 'correction-absent', correctedFind: 'const alpha = \'missing-correction\'', built: WIDGET.replace(FIND, "const alpha = 'built'") },
    { reason: 'correction-ambiguous', correctedFind: "const alpha = 'built'", built: "const alpha = 'built'\nconst alpha = 'built'\n" },
  ]
  for (const scenario of cases) {
    const { root, checkout, file } = fixture()
    writeFileSync(file, scenario.built)
    const resolved = mod.resolveDeclarations(
      plannerEnvelope(),
      builderEnvelope([{ check: 'X1', find: scenario.correctedFind, replace: "const alpha = 'corrected'" }]),
      (path) => path === DECL.file ? readFileSync(file, 'utf8') : null,
    )
    assert.deepEqual(resolved.declarations, [])
    assert.equal(resolved.refusals.length, 1)
    assert.equal(resolved.refusals[0].reason, scenario.reason)
    let runs = 0
    const result = mod.proveMutations({
      checkout, declarations: resolved.declarations, invalid: resolved.refusals, gateCmd: 'stub',
      deps: { runGate: () => { runs += 1; return GREEN } },
    })
    assert.equal(result.refusal.reason, scenario.reason)
    assert.equal(result.counts.declared, 0)
    assert.equal(result.rows.length, 0)
    assert.equal(runs, 0)
    assert.match(mod.formatReport(result, resolved.refusals).join('\n'), new RegExp(scenario.reason))
    removeKept(result)
    rmSync(root, { recursive: true, force: true })
  }
})

test('E1 per-check output distinguishes BIND-FAIL from SURVIVED', () => {
  const { root, checkout } = fixture()
  const zero = { check: 'X2', file: 'lib/widget.mjs', find: 'not-present-9f3a', replace: 'beta' }
  const result = mod.proveMutations({
    checkout, declarations: [zero, DECL], gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => GREEN) },
  })
  assert.deepEqual(result.rows.map((row) => row.outcome), ['bind-fail', 'survived'])
  const rows = mod.formatReport(result).slice(0, 2)
  assert.match(rows[0], /^X2 BIND-FAIL\(0\)/)
  assert.match(rows[1], /X1 SURVIVED/)
  assert.doesNotMatch(rows[0], /SURVIVED/)
  assert.doesNotMatch(rows[1], /BIND-FAIL/)
  removeKept(result)
  rmSync(root, { recursive: true, force: true })
})

test('E2 summary output distinguishes bind-fail from survived', () => {
  const { root, checkout } = fixture()
  const zero = { check: 'X2', file: 'lib/widget.mjs', find: 'not-present-9f3a', replace: 'beta' }
  const result = mod.proveMutations({
    checkout, declarations: [zero, DECL], gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => GREEN) },
  })
  assert.equal(result.counts.bindFail, 1)
  assert.equal(result.counts.survived, 1)
  assert.equal(result.counts.killed, 0)
  const summary = mod.formatReport(result).at(-1)
  assert.match(summary, /survived 1/)
  assert.match(summary, /bind-fail 1/)
  removeKept(result)
  rmSync(root, { recursive: true, force: true })
})

// Mutation killed: parsing coloured output raw makes a coloured FAIL line look like a survivor.
test('coloured FAIL and GATE-SUMMARY output still adjudicate a kill', () => {
  const { checkout } = fixture()
  const coloured = { ok: false, output: '\x1b[31mFAIL X1\x1b[39m\n\x1b[34mGATE-SUMMARY {"total":1,"failed":1,"errored":0}\x1b[39m' }
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => coloured) },
  })
  assert.equal(result.rows[0].outcome, 'killed')
  assert.equal(result.rows[0].summary.failed, 1)
})

// Mutation killed: mutating the lane checkout in place races the proof against its own gate.
test('mutations run in detached worktrees while the checkout stays unchanged', () => {
  const { checkout, file } = fixture()
  const original = readFileSync(file, 'utf8')
  const observations = []
  let runs = 0
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: (cmd, cwd) => {
        if (runs++ === 0) return GREEN
        const listed = git(checkout, 'worktree', 'list', '--porcelain')
        observations.push({
          cwd,
          real: realpathSync(cwd),
          lane: readFileSync(file, 'utf8'),
          mutated: readFileSync(join(cwd, 'lib/widget.mjs'), 'utf8'),
          listed,
        })
        return RED
      },
    },
  })
  assert.equal(result.rows[0].outcome, 'killed')
  assert.equal(observations.length, 1)
  const observation = observations[0]
  assert.notEqual(observation.real, realpathSync(checkout))
  assert.equal(observation.lane, original)
  assert.match(observation.mutated, new RegExp(REPLACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const block = observation.listed.split('\n\n').find((entry) => entry.includes(`worktree ${observation.real}`))
  assert.ok(block, JSON.stringify({ observation, blocks: observation.listed.split('\n\n') }))
  assert.match(block, /detached/)
  removeKept(result)
})

// Mutation killed: comparing only a successful run leaves same-length checkout corruption undetected.
test('tampering during a run refuses tree-not-restored and clean runs account for every declaration', () => {
  const tampered = fixture()
  const changed = WIDGET.replace("'alpha'", "'ALPHA'")
  assert.equal(changed.length, WIDGET.length)
  let tamperRun = 0
  const tamperedResult = mod.proveMutations({
    checkout: tampered.checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        if (tamperRun++ === 0) return GREEN
        writeFileSync(tampered.file, changed)
        return RED
      },
    },
  })
  assert.equal(tamperedResult.refusal.reason, 'tree-not-restored')

  const clean = fixture()
  const cleanResult = mod.proveMutations({
    checkout: clean.checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN, () => RED) },
  })
  assert.equal(cleanResult.refusal, null)
  assert.equal(allOutcomes(cleanResult.counts), cleanResult.counts.declared)
})

// Mutation killed: treating usage and envelope failures as successful proof hides an invocation error.
test('parseArgs has closed usage reasons and main returns 2 for missing inputs', async () => {
  assert.throws(() => mod.parseArgs(['--unknown']), (error) => {
    assert.ok(error instanceof mod.ProveUsageError)
    assert.equal(error.reason, 'unknown-flag')
    return true
  })
  assert.throws(() => mod.parseArgs([]), (error) => {
    assert.ok(error instanceof mod.ProveUsageError)
    assert.equal(error.reason, 'missing-envelope')
    return true
  })
  assert.equal(await mod.main(['--envelope', '/missing'], { ...noOutput(), readFile: () => null }), 2)
  assert.equal(await mod.main(['--envelope', '/bad'], { ...noOutput(), readFile: () => '{not-json' }), 2)
  const envelope = JSON.stringify({ details: { mutations: [] } })
  assert.equal(await mod.main(['--envelope', '/no-gate'], { ...noOutput(), readFile: () => envelope }), 2)
})

test('builder envelope CLI is optional, exclusive, and fails closed', async () => {
  const { root, checkout } = fixture()
  const plannerPath = join(root, 'planner.json')
  const builderPath = join(root, 'builder.json')
  const plannerRaw = JSON.stringify(plannerEnvelope())
  const builderRaw = JSON.stringify(builderEnvelope([]))
  assert.ok(mod.USAGE.includes('--builder-envelope <path>'))
  assert.throws(() => mod.parseArgs(['--builder-envelope', builderPath]), (error) => error.reason === 'builder-envelope-without-envelope')
  assert.throws(() => mod.parseArgs(['--diff-config', '/diff.json', '--builder-envelope', builderPath]), (error) => error.reason === 'mutually-exclusive')

  let gateRuns = 0
  const absentErrors = []
  const absentCode = await mod.main(['--envelope', plannerPath, '--builder-envelope', builderPath, '--checkout', checkout, '--gate', 'stub'], {
    readFile: (path) => path === plannerPath ? plannerRaw : null,
    runGate: () => { gateRuns += 1; return GREEN },
    stdout: () => {}, stderr: (text) => absentErrors.push(text),
  })
  assert.equal(absentCode, 2)
  assert.equal(gateRuns, 0)
  assert.match(absentErrors.join(''), /builder-envelope-absent/)

  const malformedErrors = []
  const malformedCode = await mod.main(['--envelope', plannerPath, '--builder-envelope', builderPath, '--checkout', checkout, '--gate', 'stub'], {
    readFile: (path) => path === plannerPath ? plannerRaw : '{not-json',
    runGate: () => { gateRuns += 1; return GREEN },
    stdout: () => {}, stderr: (text) => malformedErrors.push(text),
  })
  assert.equal(malformedCode, 2)
  assert.equal(gateRuns, 0)
  assert.match(malformedErrors.join(''), /builder-envelope-unreadable/)

  const corrected = fixture()
  const correctedPlannerPath = join(corrected.root, 'planner.json')
  const correctedBuilderPath = join(corrected.root, 'builder.json')
  const correctedFind = "const alpha = 'built'"
  commitBuilt(corrected.checkout, 'lib/widget.mjs', corrected.file, WIDGET.replace(FIND, correctedFind))
  const correctedOutput = []
  let correctedRuns = 0
  const correctedCode = await mod.main(['--envelope', correctedPlannerPath, '--builder-envelope', correctedBuilderPath, '--checkout', corrected.checkout, '--gate', 'stub', '--json'], {
    readFile: (path) => path === correctedPlannerPath
      ? JSON.stringify(plannerEnvelope())
      : path === correctedBuilderPath
        ? JSON.stringify(builderEnvelope([{ check: 'X1', find: correctedFind, replace: "const alpha = 'corrected'" }]))
        : readFileSync(path, 'utf8'),
    runGate: () => correctedRuns++ === 0 ? GREEN : RED,
    stdout: (text) => correctedOutput.push(text), stderr: () => {},
  })
  assert.equal(correctedCode, 0)
  assert.equal(JSON.parse(correctedOutput.join('')).rows[0].provenance, 'builder-correction')
  rmSync(corrected.root, { recursive: true, force: true })

  const jsonOutput = []
  let jsonRuns = 0
  const jsonCode = await mod.main(['--envelope', plannerPath, '--builder-envelope', builderPath, '--checkout', checkout, '--gate', 'stub', '--json'], {
    readFile: (path) => path === plannerPath ? plannerRaw : path === builderPath ? builderRaw : readFileSync(path, 'utf8'),
    runGate: () => jsonRuns++ === 0 ? GREEN : RED,
    stdout: (text) => jsonOutput.push(text), stderr: () => {},
  })
  assert.equal(jsonCode, 0)
  assert.equal(jsonRuns, 2)
  assert.equal(JSON.parse(jsonOutput.join('')).rows[0].provenance, 'planner-declaration')

  const humanOutput = []
  let humanRuns = 0
  const compatibilityCode = await mod.main(['--envelope', plannerPath, '--checkout', checkout, '--gate', 'stub'], {
    readFile: (path) => path === plannerPath ? plannerRaw : readFileSync(path, 'utf8'),
    runGate: () => humanRuns++ === 0 ? GREEN : RED,
    stdout: (text) => humanOutput.push(text), stderr: () => {},
  })
  assert.equal(compatibilityCode, 0)
  assert.match(humanOutput.join(''), /anchor=planner-declaration/)
  rmSync(root, { recursive: true, force: true })
})

// Mutation killed: passing the ambient FORCE_COLOR through overrides NO_COLOR and corrupts gate parsing.
test('a real gate child receives a colour-neutral environment', () => {
  const { root, checkout } = fixture()
  const record = join(root, 'env.json')
  const probe = join(root, 'gate.mjs')
  writeFileSync(probe, [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ FORCE_COLOR: process.env.FORCE_COLOR ?? null, CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? null, NO_COLOR: process.env.NO_COLOR ?? null }))`,
    "const text = readFileSync(join(process.cwd(), 'lib/widget.mjs'), 'utf8')",
    `if (text.includes(${JSON.stringify(REPLACE)})) {`,
    "  console.log('FAIL X1: the alpha branch is gone')",
    '  console.log(\'GATE-SUMMARY {"total":1,"failed":1,"errored":0}\')',
    '  process.exit(1)',
    '}',
    "console.log('ok X1')",
    'console.log(\'GATE-SUMMARY {"total":1,"failed":0,"errored":0}\')',
    '',
  ].join('\n'))
  const saved = { FORCE_COLOR: process.env.FORCE_COLOR, CLICOLOR_FORCE: process.env.CLICOLOR_FORCE }
  process.env.FORCE_COLOR = '3'
  process.env.CLICOLOR_FORCE = '1'
  let result
  try {
    result = mod.proveMutations({ checkout, declarations: [DECL], gateCmd: `node ${JSON.stringify(probe)}` })
  } finally {
    if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved.FORCE_COLOR
    if (saved.CLICOLOR_FORCE === undefined) delete process.env.CLICOLOR_FORCE
    else process.env.CLICOLOR_FORCE = saved.CLICOLOR_FORCE
  }
  assert.equal(result.refusal, null)
  assert.equal(result.rows[0].outcome, 'killed')
  const env = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(env.FORCE_COLOR, null)
  assert.equal(env.CLICOLOR_FORCE, null)
  assert.equal(env.NO_COLOR, '1')
  removeKept(result)
})

// Mutation killed: a baseline with no readable summary or an errored summary is not proof of a green tree.
test('baselines require a readable, non-errored summary and a zero exit', () => {
  const cases = [
    { ok: true, output: 'the gate printed no summary' },
    { ok: true, output: 'GATE-SUMMARY {"total":1,"failed":0,"errored":1}' },
    { ok: false, output: 'GATE-SUMMARY {"total":1,"failed":0,"errored":0}' },
  ]
  for (const baseline of cases) {
    const { checkout } = fixture()
    let runs = 0
    const result = mod.proveMutations({
      checkout,
      declarations: [DECL],
      gateCmd: 'stub',
      deps: { runGate: () => { runs += 1; return baseline } },
    })
    assert.equal(result.refusal.reason, 'baseline-not-green')
    assert.equal(result.rows.length, 0)
    assert.equal(runs, 1)
    removeKept(result)
  }
})

// Mutation killed: a red FAIL line without structural gate evidence falsely credits a kill.
test('red mutation output without a valid summary is survived', () => {
  const cases = [
    { ok: false, output: 'FAIL X1: the alpha branch is gone' },
    { ok: false, output: 'FAIL X1\nGATE-SUMMARY {"total":3,"failed":1,"errored":2}' },
  ]
  for (const mutation of cases) {
    const { checkout } = fixture()
    const result = mod.proveMutations({
      checkout,
      declarations: [DECL],
      gateCmd: 'stub',
      deps: { runGate: sequence(() => GREEN, () => mutation) },
    })
    assert.equal(result.rows[0].outcome, 'survived')
    assert.equal(result.counts.killed, 0)
  }
})

// Mutation killed: silently dropping one unreadable declaration inflates a partial proof to a complete one.
test('a mixed envelope refuses declarations-invalid before any gate run', async () => {
  const { checkout } = fixture()
  const envelope = { details: { mutations: [
    DECL,
    { check: 'X9', file: 'lib/widget.mjs', replace: REPLACE },
  ] } }
  const read = mod.readDeclarations(envelope)
  assert.equal(read.declarations.length, 1)
  assert.equal(read.refusals.length, 1)
  let runs = 0
  const result = mod.proveMutations({
    checkout,
    declarations: read.declarations,
    invalid: read.refusals,
    gateCmd: 'stub',
    deps: { runGate: () => { runs += 1; return GREEN } },
  })
  assert.equal(result.refusal.reason, 'declarations-invalid')
  assert.equal(result.rows.length, 0)
  assert.equal(runs, 0)
  assert.match(mod.formatReport(result, read.refusals).join('\n'), /unreadable 1/)

  const output = []
  const code = await mod.main(['--envelope', '/envelope.json', '--checkout', checkout, '--gate', 'stub'], {
    readFile: () => JSON.stringify(envelope),
    runGate: () => { runs += 1; return GREEN },
    stdout: (text) => output.push(text),
    stderr: () => {},
  })
  assert.equal(code, 2)
  assert.equal(runs, 0)
  assert.match(output.join(''), /unreadable 1/)
})

// Mutation killed: hashing decoded text makes distinct invalid UTF-8 file bytes indistinguishable.
test('raw file fingerprints detect same-length invalid UTF-8 tampering', () => {
  assert.notEqual(mod.entryFingerprint({ type: 'file', bytes: BLOB }), mod.entryFingerprint({ type: 'file', bytes: BLOB_TAMPERED }))
  assert.equal(BLOB.length, BLOB_TAMPERED.length)
  assert.equal(BLOB.toString('utf8'), BLOB_TAMPERED.toString('utf8'))
  const { checkout, blob } = fixture()
  let runs = 0
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        if (runs++ === 0) return GREEN
        writeFileSync(blob, BLOB_TAMPERED)
        return RED
      },
    },
  })
  assert.equal(result.refusal.reason, 'tree-not-restored')
})

// Mutation killed: snapshotting only declared paths misses corruption and additions elsewhere in the checkout.
test('whole-checkout inventory catches unrelated corruption, additions, and dirty paths', () => {
  const corrupt = fixture()
  let corruptRuns = 0
  const corruptResult = mod.proveMutations({
    checkout: corrupt.checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        if (corruptRuns++ === 0) return GREEN
        writeFileSync(corrupt.other, `${OTHER}// corrupt non-declared file\n`)
        return RED
      },
    },
  })
  assert.equal(corruptResult.refusal.reason, 'tree-not-restored')

  const added = fixture()
  let addedRuns = 0
  const addedResult = mod.proveMutations({
    checkout: added.checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        if (addedRuns++ === 0) return GREEN
        writeFileSync(join(added.checkout, 'new-file.mjs'), 'export const leftBehind = true\n')
        return RED
      },
    },
  })
  assert.equal(addedResult.refusal.reason, 'tree-not-restored')

  const dirty = fixture()
  writeFileSync(dirty.other, `${OTHER}// dirty non-declared file\n`)
  let dirtyRuns = 0
  const dirtyResult = mod.proveMutations({
    checkout: dirty.checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: () => { dirtyRuns += 1; return GREEN } },
  })
  assert.equal(dirtyResult.refusal.reason, 'tree-uncommitted')
  assert.equal(dirtyRuns, 0)
})

// Mutation killed: stripping ANSI only for mutations rejects a valid coloured baseline before proving anything.
test('a coloured green baseline is stripped and accepted on both seams', () => {
  assert.equal(mod.baselineNotGreen(GREEN_COLOURED), null)
  const { checkout } = fixture()
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: { runGate: sequence(() => GREEN_COLOURED, () => RED) },
  })
  assert.equal(result.refusal, null)
  assert.equal(result.rows[0].outcome, 'killed')
})

// Mutation killed: accepting exempt-plus-mutation and conflicting labels credits a shape the driver rejects.
test('readDeclarations rejects invalid exemption shapes and conflicting labels', async () => {
  const badExempt = { check: 'X8', exempt: 'covered elsewhere', file: 'lib/widget.mjs', find: FIND, replace: REPLACE }
  const conflicting = { check: 'X1', id: 'X2', file: 'lib/widget.mjs', find: FIND, replace: REPLACE }
  const same = { check: 'X3', id: 'X3', file: 'lib/widget.mjs', find: FIND, replace: REPLACE }
  const read = mod.readDeclarations({ details: { mutations: [badExempt, conflicting, same] } })
  assert.deepEqual(read.declarations.map((entry) => entry.check), ['X3'])
  assert.equal(read.refusals.length, 2)
  assert.ok(read.refusals.some((entry) => entry.check === 'X8' && /exemption|mutation/.test(entry.why)))
  assert.ok(read.refusals.some((entry) => entry.check === 'X1' && /both.*check.*id|disagree/.test(entry.why)))

  const { checkout } = fixture()
  let runs = 0
  const envelope = { details: { mutations: [badExempt] } }
  const code = await mod.main(['--envelope', '/invalid-exempt.json', '--checkout', checkout, '--gate', 'stub'], {
    readFile: () => JSON.stringify(envelope),
    runGate: () => { runs += 1; return GREEN },
    stdout: () => {},
    stderr: () => {},
  })
  assert.equal(code, 2)
  assert.equal(runs, 0)
})

// Mutation killed: decoding symlink targets before hashing makes distinct raw targets indistinguishable.
test('raw symlink fingerprints detect same-length invalid UTF-8 target tampering', () => {
  assert.notEqual(mod.entryFingerprint({ type: 'symlink', target: LINK }), mod.entryFingerprint({ type: 'symlink', target: LINK_TAMPERED }))
  assert.equal(LINK.length, LINK_TAMPERED.length)
  assert.equal(LINK.toString('utf8'), LINK_TAMPERED.toString('utf8'))
  const { checkout, link } = fixture()
  let runs = 0
  const result = mod.proveMutations({
    checkout,
    declarations: [DECL],
    gateCmd: 'stub',
    deps: {
      runGate: () => {
        if (runs++ === 0) return GREEN
        rmSync(link)
        symlinkSync(LINK_TAMPERED, link)
        return RED
      },
    },
  })
  assert.equal(result.refusal.reason, 'tree-not-restored')
})

function diffPatch(path, before, after) {
  const oldLines = before === null ? [] : String(before).replace(/\n$/, '').split('\n')
  const newLines = after === null ? [] : String(after).replace(/\n$/, '').split('\n')
  return [
    `diff --git a/${path} b/${path}`,
    before === null ? '--- /dev/null' : `--- a/${path}`,
    after === null ? '+++ /dev/null' : `+++ b/${path}`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

function diffDeps(results, writes = []) {
  return {
    runCommand(command) {
      results.push(command)
      return { ok: true, output: '', status: 0, completed: true }
    },
    writeFile(abs, bytes) {
      writes.push(abs)
      writeFileSync(abs, bytes)
    },
  }
}

test('A1 diff hunk conditional produces an adjudicated flipped mutant', async () => {
  const { root, checkout, file } = fixture()
  const before = 'if (false) return true\n'
  const after = 'if (true) return true\n'
  writeFileSync(file, after)
  const commands = []
  const result = await mod.runDiffMutationProof({
    version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'],
    validation_lane: 'npm run lint -- --color=never', gate_cmd: 'node gate.mjs --strict', cap: 8, generation: 1,
  }, {
    ...diffDeps(commands),
    runCommand(command) {
      commands.push(command)
      return command === 'node gate.mjs --strict'
        ? { ok: false, output: 'FAIL flipped\nGATE-SUMMARY {"total":1,"failed":1,"errored":0}', status: 1, completed: true }
        : { ok: true, output: 'lane', status: 0, completed: true }
    },
  })
  assert.equal(result.fatal, undefined)
  const conditional = result.mutants.find((row) => row.operator === 'conditional')
  assert.ok(conditional)
  assert.equal(conditional.outcome, 'killed')
  assert.deepEqual(commands.slice(0, 2), ['npm run lint -- --color=never', 'node gate.mjs --strict'])
  rmSync(root, { recursive: true, force: true })
})

test('C1 out-of-fence hunks are skipped and never written', async () => {
  const { root, checkout } = fixture()
  const outside = join(checkout, 'other/outside.mjs')
  const linkTarget = join(checkout, 'other/link-target.mjs')
  mkdirSync(join(checkout, 'other'), { recursive: true })
  writeFileSync(outside, 'const outside = true\n')
  writeFileSync(linkTarget, 'const link = true\n')
  symlinkSync('../other/link-target.mjs', join(checkout, 'lib/link.mjs'))
  const writes = []
  const patch = [
    diffPatch('other/outside.mjs', 'const outside = false\n', 'const outside = true\n'),
    diffPatch('lib/link.mjs', 'const link = false\n', 'const link = true\n'),
  ].join('\n')
  const result = await mod.runDiffMutationProof({
    version: 1, checkout, patch, files_in_scope: ['lib/'], validation_lane: 'lane exact', gate_cmd: 'gate exact', cap: 8, generation: 1,
  }, { ...diffDeps([], writes) })
  assert.equal(result.fatal, undefined)
  assert.equal(writes.some((path) => path === outside), false)
  assert.ok(result.skip_counts['out-of-scope'] > 0)
  assert.ok(result.skip_counts['unsafe-target:symlink'] > 0)
  assert.equal(readFileSync(outside, 'utf8'), 'const outside = true\n')
  assert.equal(readFileSync(linkTarget, 'utf8'), 'const link = true\n')
  rmSync(root, { recursive: true, force: true })
})

test('F1 mutant cap is enforced and prints its blind spot', async () => {
  const { root, checkout, file } = fixture()
  const before = Array.from({ length: 10 }, (_, index) => `const value${index} = false`).join('\n') + '\n'
  const after = Array.from({ length: 10 }, (_, index) => `const value${index} = true`).join('\n') + '\n'
  writeFileSync(file, after)
  const commands = []
  const result = await mod.runDiffMutationProof({
    version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: 'gate', cap: 8, generation: 1,
  }, { ...diffDeps(commands), runCommand(command) { commands.push(command); return { ok: true, output: '', status: 0, completed: true } } })
  assert.equal(result.cap, 8)
  assert.equal(result.generated, 8)
  assert.equal(result.mutants.length, 8)
  assert.equal(result.omitted, result.total_candidates - 8)
  assert.equal(result.cap_omitted, result.omitted)
  assert.match(result.blind_spot, /each mutant runs both the accepted validation lane and gate/)
  assert.equal(commands.length, 16)
  rmSync(root, { recursive: true, force: true })
})

test('A4 a hanging diff gate is counted as a timeout kill', async () => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const hang = join(root, 'hang.pid')
  const config = { version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: hangCommand(hang), cap: 1, generation: 1 }
  // The runner's first table waits for the hang's own marker, so shell startup can never beat the bound.
  const runCommand = (command, cwd, options) => command === 'lane'
    ? { ok: true, output: '', status: 0, completed: true }
    : mod.normalDeps().runCommand(command, cwd, { ...options, pollMs: 50, snapshot: gatedSnapshot([() => existsSync(hang)]) })
  let pid = null
  try {
    const result = await mod.runDiffMutationProof(config, { runCommand, runTimeoutMs: 350 })
    assert.ok(existsSync(hang), 'the hanging gate never started')
    pid = Number(readFileSync(hang, 'utf8'))
    assert.equal(result.mutants.find((row) => row.kill_reason === 'timeout')?.outcome, 'killed')
    assert.equal(await waitDead(pid), true, 'the hanging gate outlived its timeout')
    assert.equal(readFileSync(file, 'utf8'), after)
  } finally { if (pid) killQuietly(pid); rmSync(root, { recursive: true, force: true }) }
})

test('A3 a SIGTERM-ignoring descendant is killed with its timed-out group', async () => {
  const { root, checkout } = fixture()
  const shellMarker = join(root, 'child.pid')
  const ready = join(root, 'child.ready')
  const observed = join(root, 'child.observed')
  let pid = null
  let probeSent = false
  try {
    const command = `node -e 'const fs = require("node:fs"); const observedPath = ${JSON.stringify(observed)}; process.on("SIGTERM", () => { fs.writeFileSync(observedPath, "observed") }); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)' & echo $! > ${JSON.stringify(shellMarker)}; wait`
    const snapshot = gatedSnapshot([() => existsSync(ready) && readyPid(ready) !== null && (probeSent = true, process.kill(readyPid(ready), 'SIGTERM'), true), () => existsSync(observed) || pidDead(Number(readFileSync(ready, 'utf8')))])
    const result = await mod.normalDeps().runCommand(command, checkout, { timeout: 350, snapshot })
    assert.equal(existsSync(ready), true, 'descendant never reported its handler installed')
    assert.equal(probeSent, true, 'the readiness probe never signalled the descendant')
    assert.equal(existsSync(observed), true, 'descendant did not acknowledge SIGTERM before timeout')
    assert.equal(existsSync(shellMarker), true, 'child marker was never written')
    assert.equal(result.error?.code, 'ETIMEDOUT')
    pid = Number(readFileSync(ready, 'utf8').trim())
    assert.equal(await waitDead(pid), true, 'the SIGTERM-ignoring descendant outlived its timed-out group')
  } finally {
    if (!pid) {
      const marker = existsSync(ready) ? ready : shellMarker
      if (existsSync(marker)) pid = Number(readFileSync(marker, 'utf8').trim())
    }
    if (pid) killQuietly(pid)
    rmSync(root, { recursive: true, force: true })
  }
})


test('A3 readiness probe signals only a positive pid, never its own process group', () => {
  const root = scratchDir('ready-pid-')
  try {
    const file = join(root, 'child.ready')
    for (const text of ['', '0', '-1', 'x']) { writeFileSync(file, text); assert.equal(readyPid(file), null, `readiness text ${JSON.stringify(text)} must not be signalled`) }
    writeFileSync(file, '4242'); assert.equal(readyPid(file), 4242)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// An empty read between the child's open and write is Number('') === 0, and kill(0) signals our own group.
const readyPid = (path) => { const pid = Number(readFileSync(path, 'utf8')); return Number.isInteger(pid) && pid > 0 ? pid : null }
const pidDead = (pid) => { try { process.kill(pid, 0); return false } catch (err) { return err?.code === 'ESRCH' } }
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL') } catch {} }
// Exit and reap evidence is positive: kill(pid, 0) throwing ESRCH. A row missing from one ps
// table is never taken as an exit, and no assertion rests on a fixed delay. The cap bounds a
// wait for that event; it is not the event.
async function waitDead(pid, capMs = 5000) {
  const deadline = Date.now() + capMs
  while (!pidDead(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return pidDead(pid)
}
// A hang that records its own pid and outlives any bound here by far: the kill is proven by
// ESRCH on that pid, never by how long the run took.
const hangCommand = (pidFile) => `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30`
const detachedSpawner = (marker, lingerMs) => `node -e 'const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); setTimeout(() => {}, ${lingerMs})' ; sleep 30`

// lean: synchronous wait capped at 20s; upgrade path: a readiness hook in runCommandDefault
// onRelease runs once, just before the gated table goes to the runner, so a test can record
// independent evidence of the state the runner is about to act on.
function gatedSnapshot(stages, onRelease = null) {
  let first = true
  return () => {
    if (!first) return psSnapshot()
    first = false
    let captured = psSnapshot()
    let current = captured
    const deadline = Date.now() + 20_000
    for (let index = 0; index < stages.length; index++) {
      while (!stages[index](current) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
        current = psSnapshot()
      }
      if (!stages[index](current)) break
      if (index === 0) captured = current
    }
    onRelease?.()
    return captured
  }
}

test('A3b a detached descendant outside the timed-out group is reaped before the run settles', async () => {
  const { root, checkout } = fixture()
  const marker = join(root, 'escaped.pid')
  let pid = null
  try {
    const snapshot = gatedSnapshot([table => {
      const child = existsSync(marker) ? table.rows.get(Number(readFileSync(marker, 'utf8'))) : null
      return Boolean(child)
    }])
    const result = await mod.normalDeps().runCommand(detachedSpawner(marker, 30_000), checkout, { timeout: 800, pollMs: 50, snapshot })
    assert.ok(pid = Number(readFileSync(marker, 'utf8').trim()), 'detached child marker was never written')
    assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.equal(result.reap_survivors, 0)
    assert.equal(await waitDead(pid), true, 'the escaped detached descendant outlived the timed-out run')
  } finally { if (pid) killQuietly(-pid); rmSync(root, { recursive: true, force: true }) }
})

test('A3c an escaped descendant whose parent already exited is reaped through the sampled lineage', async () => {
  const { root, checkout } = fixture()
  const marker = join(root, 'orphan.pid'), parentFile = join(root, 'parent.pid'), release = join(root, 'release')
  let pid = null, parentGoneAtRelease = null
  try {
    const parentPid = () => existsSync(parentFile) ? Number(readFileSync(parentFile, 'utf8')) : null
    const releaseStages = [
      table => {
        const child = existsSync(marker) ? table.rows.get(Number(readFileSync(marker, 'utf8'))) : null
        const parent = existsSync(parentFile) ? Number(readFileSync(parentFile, 'utf8')) : null
        if (child && child.ppid === parent) { writeFileSync(release, 'go'); return true }
        return false
      },
      () => Boolean(parentPid()) && pidDead(parentPid()),
    ]
    const snapshot = gatedSnapshot(releaseStages, () => { parentGoneAtRelease = Boolean(parentPid()) && pidDead(parentPid()) })
    const command = `node -e 'const fs=require("node:fs"),c=require("node:child_process").spawn("sleep",["30"],{detached:true,stdio:"ignore"});fs.writeFileSync(${JSON.stringify(parentFile)},String(process.pid));fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)' ; sleep 30`
    const result = await mod.normalDeps().runCommand(command, checkout, { timeout: 1500, pollMs: 50, snapshot })
    assert.ok(pid = Number(readFileSync(marker, 'utf8').trim()), 'child marker was never written')
    assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.equal(parentGoneAtRelease, true, 'the runner was handed its table before the parent had exited')
    assert.equal(result.reap_survivors, 0)
    assert.equal(await waitDead(pid), true, 'the reparented escapee outlived the timed-out run')
  } finally { if (pid) killQuietly(-pid); rmSync(root, { recursive: true, force: true }) }
})

test('A3e a group spawned by an already-orphaned escapee is reaped through the tracked escapee', async t => {
  const { root, checkout } = fixture()
  const marker = join(root, 'late.pid'), script = join(root, 'late-escape.cjs')
  const parentFile = join(root, 'parent.pid'), escapeeFile = join(root, 'escapee.pid'), seen = join(root, 'seen')
  let escapeePid = null, latePid = null, parentPid = null, lineageCaptured = false, orphanBeforeLate = false
  writeFileSync(script, [
    'const fs = require("node:fs")',
    'const { spawn } = require("node:child_process")',
    'if (process.argv[2] === "escapee") {',
    '  const parentPid = process.ppid',
    `  fs.writeFileSync(${JSON.stringify(escapeeFile)}, String(process.pid))`,
    '  while (process.ppid === parentPid) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)',
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${LATE_SPAWN_DELAY_MS})`,
    '  const late = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })',
    `  fs.writeFileSync(${JSON.stringify(marker)}, String(late.pid))`,
    '  late.unref()',
    '  setTimeout(() => {}, 30_000)',
    '} else {',
    `  fs.writeFileSync(${JSON.stringify(parentFile)}, String(process.pid))`,
    '  const escapee = spawn(process.execPath, [__filename, "escapee"], { detached: true, stdio: "ignore" })',
    '  escapee.unref()',
    `  while (!fs.existsSync(${JSON.stringify(seen)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)`,
    '}',
  ].join('\n'))
  const stages = [
    table => {
      const e = existsSync(escapeeFile) ? table.rows.get(Number(readFileSync(escapeeFile, 'utf8'))) : null
      const p = existsSync(parentFile) ? table.rows.get(Number(readFileSync(parentFile, 'utf8'))) : null
      if (e && p && e.ppid === p.pid) { lineageCaptured = true; writeFileSync(seen, 'yes'); return true }
      return false
    },
    table => {
      const escapeePid = existsSync(escapeeFile) ? Number(readFileSync(escapeeFile, 'utf8')) : null
      const e = escapeePid ? table.rows.get(escapeePid) : null
      const parent = existsSync(parentFile) ? Number(readFileSync(parentFile, 'utf8')) : null
      const late = existsSync(marker) ? table.rows.get(Number(readFileSync(marker, 'utf8'))) : null
      if (e && e.ppid !== parent && late && late.ppid === escapeePid) { orphanBeforeLate = true; return true }
      return false
    },
  ]
  const snapshot = gatedSnapshot(stages)
  try {
    const command = `node ${JSON.stringify(script)} ; sleep 30`
    const result = await mod.normalDeps().runCommand(command, checkout, { timeout: 1500, pollMs: 50, snapshot })
    const lateReady = existsSync(marker)
    assert.equal(lineageCaptured, true, 'lineage observation never completed')
    assert.equal(orphanBeforeLate, true, 'escapee was not observed orphaned before late spawn')
    assert.equal(lateReady, true, 'late child marker was never written')
    parentPid = Number(readFileSync(parentFile, 'utf8')); escapeePid = Number(readFileSync(escapeeFile, 'utf8')); latePid = Number(readFileSync(marker, 'utf8'))
    assert.equal(result.error?.code, 'ETIMEDOUT'); assert.equal(result.reap_survivors, 0)
    const lateDead = await waitDead(latePid)
    assert.equal(lateDead, true, 'the group started by an orphaned escapee outlived the timed-out run')
    t.diagnostic('REAP-EVENT ' + JSON.stringify({ test: 'A3e', lateSpawnDelayMs: LATE_SPAWN_DELAY_MS, lineageCaptured, orphanBeforeLate, lateReady, timedOut: true, lateDead }))
  } finally {
    if (existsSync(escapeeFile)) escapeePid = Number(readFileSync(escapeeFile, 'utf8'))
    if (existsSync(marker)) latePid = Number(readFileSync(marker, 'utf8'))
    if (existsSync(parentFile)) parentPid = Number(readFileSync(parentFile, 'utf8'))
    if (escapeePid) killQuietly(-escapeePid)
    if (latePid) killQuietly(-latePid)
    if (parentPid) killQuietly(parentPid)
    rmSync(root, { recursive: true, force: true })
  }
})

// With a release path, node does not start its linger until the test has sampled the holder
// under it, so a slow first sample can never see node already gone. The trailing `; :` keeps
// the shell from exec'ing node, so the shell reaps it and its exit reads as ESRCH, never as a
// zombie of this blocked process.
const pipeHolder = (marker, nodeMarker, lingerMs, release = null) => `node -e 'const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(nodeMarker)},String(process.pid));const c=require("node:child_process").spawn("sleep",["30"],{detached:true,stdio:["ignore","inherit","inherit"]});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();const hold=${JSON.stringify(release)};while(hold&&!fs.existsSync(hold))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);setTimeout(()=>{},${lingerMs})' ; :`
const pipeSnapshot = (stages, onRelease) => { return gatedSnapshot(stages, onRelease) }

test('A3f a shell that exited early while a tracked detached child holds its pipes still settles at the timeout', async t => {
  const { root, checkout } = fixture()
  const marker = join(root, 'holder.pid'), nodeFile = join(root, 'node.pid'), release = join(root, 'release')
  let pid = null, nodePid = null, holderReady = false, nodeExited = false, tracked = false, nodeGoneAtRelease = null
  try {
    const stages = [
      table => {
        pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null
        nodePid = existsSync(nodeFile) ? Number(readFileSync(nodeFile, 'utf8')) : null
        const holder = pid ? table.rows.get(pid) : null
        holderReady = Boolean(holder && nodePid && holder.ppid === nodePid)
        tracked = holderReady
        if (holderReady) writeFileSync(release, 'go')
        return holderReady
      },
      () => { nodeExited = pidDead(nodePid); return nodeExited },
    ]
    const result = await mod.normalDeps().runCommand(pipeHolder(marker, nodeFile, PIPE_LINGER_MS, release), checkout, { timeout: 800, pollMs: 50, snapshot: pipeSnapshot(stages, () => { nodeGoneAtRelease = Boolean(nodePid) && pidDead(nodePid) }) })
    assert.equal(holderReady, true); assert.equal(nodeExited, true); assert.equal(result.error?.code, 'ETIMEDOUT'); assert.equal(result.reap_survivors, 0)
    assert.equal(nodeGoneAtRelease, true, 'the runner was handed its table before node had exited')
    assert.equal(await waitDead(pid), true, 'the tracked pipe holder outlived the timed-out run')
    t.diagnostic('REAP-EVENT ' + JSON.stringify({ test: 'A3f', lingerMs: PIPE_LINGER_MS, holderReady, nodeExited, tracked, timedOut: true }))
  } finally {
    pid ??= existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null
    nodePid ??= existsSync(nodeFile) ? Number(readFileSync(nodeFile, 'utf8')) : null
    if (pid) killQuietly(-pid)
    if (nodePid) killQuietly(nodePid)
    rmSync(root, { recursive: true, force: true })
  }
})

test('A3g an untracked pipe holder settles at the timeout as an unproven reap', async t => {
  const { root, checkout } = fixture()
  const marker = join(root, 'untracked.pid'), nodeFile = join(root, 'node.pid')
  let pid = null, nodePid = null, holderReady = false, nodeExited = false, tracked = true, nodeGoneAtRelease = null
  try {
    const stages = [table => {
      pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null
      nodePid = existsSync(nodeFile) ? Number(readFileSync(nodeFile, 'utf8')) : null
      const holder = pid ? table.rows.get(pid) : null
      nodeExited = Boolean(nodePid) && pidDead(nodePid)
      holderReady = Boolean(holder && nodeExited)
      tracked = Boolean(holder && holder.ppid === nodePid)
      return holderReady && nodeExited && !tracked
    }]
    const result = await mod.normalDeps().runCommand(pipeHolder(marker, nodeFile, PIPE_LINGER_MS), checkout, { timeout: 800, pollMs: 50, snapshot: pipeSnapshot(stages, () => { nodeGoneAtRelease = Boolean(nodePid) && pidDead(nodePid) }) })
    assert.equal(holderReady, true); assert.equal(nodeExited, true); assert.equal(tracked, false); assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.equal(nodeGoneAtRelease, true, 'the runner was handed its table before node had exited')
    assert.ok(result.reap_survivors >= 1); assert.equal(mod.normalizeDiffCommandResult(result).available, false)
    t.diagnostic('REAP-EVENT ' + JSON.stringify({ test: 'A3g', lingerMs: PIPE_LINGER_MS, holderReady, nodeExited, tracked, timedOut: true }))
  } finally {
    pid ??= existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : null
    nodePid ??= existsSync(nodeFile) ? Number(readFileSync(nodeFile, 'utf8')) : null
    if (pid) killQuietly(-pid)
    if (nodePid) killQuietly(nodePid)
    rmSync(root, { recursive: true, force: true })
  }
})

test('A3d a timeout with an unproven reap is an escaped descendant, never a timeout kill or a skip', () => {
  assert.deepEqual(mod.normalizeDiffCommandResult({ ok: false, status: null, error: { code: 'ETIMEDOUT' }, completed: false, reap_survivors: 1 }), { available: false, escaped: true, why: 'descendant-escaped', survivors: 1 })
  assert.equal(mod.normalizeDiffCommandResult({ ok: false, status: null, error: { code: 'ETIMEDOUT' }, completed: false, reap_survivors: 0 }).timeout, true)
})

test('A5 a grandchild that escapes the poll and rewrites the target makes the proof fatal, restored at report time', async t => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const marker = join(root, 'writer.pid'), ready = join(root, 'writer.ready'), nodeFile = join(root, 'node.pid')
  // The grandchild detaches, keeps the command's pipes, rewrites the target and only then
  // writes the ready file. The runner's first table is taken once that file exists AND its
  // node parent is ESRCH, so nothing the runner samples can reach the writer and its deadline
  // cannot fire before the rewrite however slowly the children boot. The trailing `; :` keeps
  // the shell from exec'ing node, so the shell reaps it.
  const writer = `sleep ${WRITER_DELAY_MS / 1000}; printf rewritten > ${JSON.stringify(file)}; : > ${JSON.stringify(ready)}; sleep 30`
  const command = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(nodeFile)}, String(process.pid)); const c = require("node:child_process").spawn("sh", ["-c", ${JSON.stringify(writer)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref()' ; :`
  const inflight = join(root, 'inflight.json')
  const nodePid = () => existsSync(nodeFile) ? Number(readFileSync(nodeFile, 'utf8')) : null
  let readyAtFirstTable = null, nodeGoneAtFirstTable = null
  const orderedSnapshot = () => gatedSnapshot([() => existsSync(ready) && Boolean(nodePid()) && pidDead(nodePid())], () => {
    readyAtFirstTable = existsSync(ready)
    nodeGoneAtFirstTable = Boolean(nodePid()) && pidDead(nodePid())
  })
  const runCommand = (cmd, cwd, options) => cmd === 'gate'
    ? { ok: false, output: '', status: 1, completed: true }
    : mod.normalDeps().runCommand(cmd, cwd, { ...options, pollMs: 50, snapshot: orderedSnapshot() })
  let pid = null
  try {
    const result = await mod.runDiffMutationProof({ version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: command, gate_cmd: 'gate', cap: 1, generation: 1 }, { runCommand, runTimeoutMs: 900, inflightPath: inflight })
    if (existsSync(marker)) pid = Number(readFileSync(marker, 'utf8').trim())
    assert.equal(existsSync(ready), true, 'the orphaned writer never reported its rewrite')
    assert.equal(readyAtFirstTable, true, 'the runner sampled, and could time out, before the orphaned writer rewrote the target')
    assert.equal(nodeGoneAtFirstTable, true, 'the runner sampled while the writer was still reachable through node')
    assert.equal(readFileSync(file, 'utf8'), after, 'the target was not at its pre-mutation bytes at report time')
    assert.equal(result.fatal?.reason, 'tree-not-restored')
    assert.equal(result.fatal?.cause, 'descendant-escaped')
    assert.equal(result.mutants.some((row) => row.outcome === 'skipped'), false)
    const record = JSON.parse(readFileSync(inflight, 'utf8'))
    assert.equal(record.path, 'lib/widget.mjs')
    assert.equal(record.generation, 1)
    t.diagnostic('REAP-EVENT ' + JSON.stringify({ test: 'A5', writerDelayMs: WRITER_DELAY_MS, readyAtFirstTable, nodeGoneAtFirstTable, fatal: result.fatal.cause }))
  } finally {
    if (!pid && existsSync(marker)) pid = Number(readFileSync(marker, 'utf8').trim())
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})

test('A2 a hanging diff validation is timed out, killed, and restored', async () => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const hang = join(root, 'hang.pid')
  const config = { version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: hangCommand(hang), gate_cmd: 'gate', cap: 1, generation: 1 }
  // The runner's first table waits for the hang's own marker, so shell startup can never beat the bound.
  const runCommand = (command, cwd, options) => command === config.validation_lane
    ? mod.normalDeps().runCommand(command, cwd, { ...options, pollMs: 50, snapshot: gatedSnapshot([() => existsSync(hang)]) })
    : mod.normalDeps().runCommand(command, cwd, options)
  let pid = null
  try {
    const result = await mod.runDiffMutationProof(config, { runCommand, runTimeoutMs: 350 })
    assert.ok(existsSync(hang), 'the hanging validation never started')
    pid = Number(readFileSync(hang, 'utf8'))
    const timedOut = result.mutants.find((row) => row.kill_reason === 'timeout')
    assert.ok(timedOut)
    assert.equal(timedOut.outcome, 'killed')
    assert.equal(result.timeout_killed, 1)
    assert.equal(await waitDead(pid), true, 'the hanging validation outlived its timeout')
    assert.equal(readFileSync(file, 'utf8'), after)
  } finally { if (pid) killQuietly(pid); rmSync(root, { recursive: true, force: true }) }
})

test('RV1-2 total deadline skips later mutants without killing them', async () => {
  const { root, checkout, file } = fixture()
  const before = 'const first = false\nconst second = false\n'
  const after = 'const first = true\nconst second = true\n'
  writeFileSync(file, after)
  let clock = 0
  let calls = 0
  const result = await mod.runDiffMutationProof({
    version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: 'gate', cap: 8, generation: 1,
  }, {
    now: () => clock,
    totalDeadlineMs: 1,
    runCommand: () => { calls++; clock = 2; return { ok: true, output: '', status: 0, completed: true } },
  })
  assert.equal(calls, 1)
  assert.equal(result.killed, 0)
  assert.ok(result.mutants.length >= 2)
  assert.ok(result.mutants.every((row) => row.outcome === 'skipped' && row.skip_reason === 'runner-unavailable'))
  rmSync(root, { recursive: true, force: true })
})

test('C1a-e diff runner failures retain five closed causes and stable why', async () => {
  const cases = [
    [null, 'result-not-object'],
    [{ error: { code: 'EIO' } }, 'result-incomplete'],
    [{ ok: 'yes' }, 'ok-missing'],
    [{ ok: false, status: 0 }, 'status-ok-mismatch'],
  ]
  for (const [result, cause] of cases) assert.deepEqual(mod.normalizeDiffCommandResult(result), { available: false, why: 'runner-unavailable', cause })
  assert.deepEqual(await mod.runDiffCommand({ runCommand: () => ({ ok: false, status: null, completed: false }) }, 'lane', '/tmp'), { available: false, why: 'runner-unavailable', cause: 'result-incomplete' })
  assert.deepEqual(await mod.runDiffCommand({ runCommand: () => { throw new Error('interrupted') } }, 'lane', '/tmp'), { available: false, why: 'runner-unavailable', cause: 'runner-threw' })
})

test('D1 diff runner causes are frozen and reject unknown values', () => {
  assert.deepEqual([...mod.DIFF_RUNNER_UNAVAILABLE_CAUSES], ['result-not-object', 'result-incomplete', 'ok-missing', 'status-ok-mismatch', 'runner-threw'])
  assert.equal(Object.isFrozen(mod.DIFF_RUNNER_UNAVAILABLE_CAUSES), true)
  assert.throws(() => mod.diffRunnerUnavailable('unknown-cause'), /unknown diff runner-unavailable cause/)
})

test('E1 a non-empty diff serializes the runner cause on a skipped mutant', async () => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const result = await mod.runDiffMutationProof({
    version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: 'gate', cap: 8, generation: 1,
  }, { runCommand: () => null, writeFile: (path, bytes) => writeFileSync(path, bytes) })
  const skipped = result.mutants.find((row) => row.outcome === 'skipped')
  assert.ok(skipped)
  assert.equal(skipped.skip_reason, 'runner-unavailable')
  assert.equal(skipped.why, 'runner-unavailable')
  assert.equal(skipped.runner_unavailable_cause, 'result-not-object')
  rmSync(root, { recursive: true, force: true })
})

test('E2 diff config input stays byte-identical while the sibling report is written', async () => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const configPath = join(root, 'diff-mutation-1.json')
  const reportPath = join(root, 'diff-mutation-1.report.json')
  const config = { version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: 'gate', cap: 8, generation: 1 }
  const input = `${JSON.stringify(config)}\n`
  writeFileSync(configPath, input)
  const reports = new Map()
  const output = []
  const code = await mod.main(['--diff-config', configPath], {
    readFile: (path) => path === configPath ? input : null,
    writeFile: (path, bytes) => path === reportPath ? reports.set(path, String(bytes)) : writeFileSync(path, bytes),
    runCommand: () => null,
    stdout: (text) => output.push(text), stderr: () => {},
  })
  assert.equal(code, 0)
  assert.equal(readFileSync(configPath, 'utf8'), input)
  assert.ok(reports.has(reportPath))
  const report = JSON.parse(reports.get(reportPath))
  assert.equal(report.mutants.find((row) => row.outcome === 'skipped').runner_unavailable_cause, 'result-not-object')
  assert.match(output.join(''), /^DIFF-MUTATION-SUMMARY /)
  rmSync(root, { recursive: true, force: true })
})

test('E4 main records the in-flight mutant beside the config, before the mutant is written', async () => {
  const { root, checkout, file } = fixture()
  const before = WIDGET
  const after = WIDGET.replace(FIND, REPLACE)
  writeFileSync(file, after)
  const configPath = join(root, 'diff-mutation-1.json')
  const inflightPath = join(root, 'diff-mutation-1.inflight.json')
  assert.equal(mod.diffInflightPath(configPath), inflightPath)
  const config = { version: 1, checkout, patch: diffPatch('lib/widget.mjs', before, after), files_in_scope: ['lib/'], validation_lane: 'lane', gate_cmd: 'gate', cap: 1, generation: 1 }
  writeFileSync(configPath, JSON.stringify(config))
  const order = []
  const code = await mod.main(['--diff-config', configPath], {
    writeFile: (path, bytes) => { order.push(path); writeFileSync(path, bytes) },
    runCommand: () => ({ ok: false, output: '', status: 1, completed: true }),
    stdout: () => {}, stderr: () => {},
  })
  assert.equal(code, 0)
  assert.ok(order.indexOf(inflightPath) >= 0 && order.indexOf(inflightPath) < order.indexOf(file), JSON.stringify(order))
  const record = JSON.parse(readFileSync(inflightPath, 'utf8'))
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(record.path, 'lib/widget.mjs')
  assert.equal(record.original_sha256, digest(Buffer.from(after)))
  assert.notEqual(record.mutant_sha256, record.original_sha256)
  rmSync(root, { recursive: true, force: true })
})

test('E3 the driver parser rejects missing and unknown runner causes', () => {
  const base = {
    generation: 1, cap: 1, configured_cap: 1, cap_omitted: 0, total_candidates: 1, generated: 1,
    killed: 0, survived: 0, skipped: 1, omitted: 0, skip_counts: { 'runner-unavailable': 1 },
  }
  for (const mutant of [
    { outcome: 'skipped', skip_reason: 'runner-unavailable', why: 'runner-unavailable' },
    { outcome: 'skipped', skip_reason: 'runner-unavailable', why: 'runner-unavailable', runner_unavailable_cause: 'not-closed' },
  ]) {
    assert.equal(parseDiffMutationReport(`DIFF-MUTATION-SUMMARY ${JSON.stringify({ ...base, mutants: [mutant] })}`, { generation: 1, cap: 1 }), null)
  }
})
