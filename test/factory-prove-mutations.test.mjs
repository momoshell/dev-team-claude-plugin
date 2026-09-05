import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir, git } from './helpers.mjs'
import * as mod from '../scripts/factory/prove-mutations.mjs'

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
