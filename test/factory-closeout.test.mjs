import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync as makeTempDir,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AMBIGUOUS_MARK,
  ARCHIVE_MARK,
  CLOSEOUT_REFUSALS,
  ENVELOPE_ACCEPTED,
  ENVELOPE_ABSENT,
  ENVELOPE_REFUSED,
  MERGE_CHECK_STEPS,
  REAP_STEPS,
  RECOVER_STEPS,
  REFS_PATTERN,
  ROT_MARK,
  STEP_EVENT,
  STEP_OUTCOMES,
  adoptCommandLine,
  archiveName,
  classifyRepairRefusals,
  envelopeReport,
  main,
  mergeCheck,
  newestMtime,
  normalDeps,
  parseArgs,
  parseRepairOutput,
  quietProbe,
  reap,
  recover,
  refsFromPrBody,
  stripAnsi,
} from '../scripts/factory/closeout.mjs'

const scratchDirs = new Set()
const lane = 'b415-closeout'

function scratch(prefix = 'factory-closeout-') {
  const dir = makeTempDir(join(tmpdir(), prefix))
  scratchDirs.add(dir)
  return dir
}

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

function answerFor(argv, answers) {
  for (const [needle, reply] of answers) {
    if (argv.includes(needle)) return typeof reply === 'function' ? reply(argv) : reply
  }
  return { status: 0, stdout: '', stderr: '' }
}

function harness({ home = null, answers = [], newest = () => 1000, now = null, log = null } = {}) {
  const calls = { spawn: [], cp: [], rename: [], rm: [], log: [] }
  let clock = 0
  const deps = normalDeps({
    home,
    mkdtempSync: (prefix) => {
      const dir = makeTempDir(prefix)
      scratchDirs.add(dir)
      return dir
    },
    now: now || (() => { clock += 5; return clock }),
    sleep: () => {},
    newest,
    cpSync: (from, to, options) => calls.cp.push([from, to, options]),
    renameSync: (from, to) => calls.rename.push([from, to]),
    rmSync: (path, options) => calls.rm.push([path, options]),
    log: log || ((line) => calls.log.push(line)),
    spawn: (options) => {
      const argv = [options.file, ...(options.args || [])].join(' ')
      calls.spawn.push({ argv, cwd: options.cwd, file: options.file, args: options.args || [], env: options.env })
      return answerFor(argv, answers)
    },
  })
  return { deps, calls }
}

function laneFixture(prefix, { commit = null, envelopeId = 'd3', mutations = 30 } = {}) {
  const home = scratch(prefix)
  const checkout = join(home, 'dt-b415-closeout')
  const crewDir = join(home, '.crew', 'dt-b415-closeout', lane)
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  mkdirSync(join(crewDir, 'task'), { recursive: true })
  mkdirSync(checkout, { recursive: true })
  put(join(crewDir, 'crew.json'), JSON.stringify({
    task: lane,
    checkout,
    lane_name: lane,
    lane_fence: [{ lane: 'b414-turnceiling', files: ['crew/drive.mjs'] }],
  }))
  put(join(crewDir, 'journal.jsonl'), `${JSON.stringify({
    at: '2026-09-04T06:04:46.127Z',
    event: 'boot',
    task: lane,
    brief: `${home}/batch-2026-09-04-r18/out/${lane}.brief.md`,
  })}\n`)
  put(join(crewDir, 'returns', 'task.json'), JSON.stringify({
    status: 'escalation',
    details: {
      stages: ['plan:r1', 'plan:r2', 'check:r2', 'plan:r3'],
      escalation: { where: 'planner', why: `planner: no valid envelope at ${crewDir}/returns/d5.planner.json within 2700s` },
      commit,
      head: 'cbeee0500c53a9eadca603cadf76232afc6e8140',
    },
  }))
  put(join(crewDir, 'returns', 'd5.planner.json'), JSON.stringify({
    assignment_id: envelopeId,
    role: 'planner',
    status: 'done',
    summary: 'Applied all seven plan-check findings.',
    details: { mutations: Array.from({ length: mutations }, (_, index) => ({ check: `C${index}`, file: 'a.mjs', find: 'x', replace: 'y' })) },
  }))
  put(join(crewDir, 'task', 'plan.md'), '# Plan\n')
  put(join(crewDir, 'task', 'gate.mjs'), '// gate\n')
  put(join(crewDir, 'task', 'plan-check.md'), 'VERDICT: accept\n')
  mkdirSync(join(home, 'batch-2026-09-04-r18'), { recursive: true })
  put(join(home, 'batch-2026-09-04-r18', 'fences.json'), '{}')
  return { home, checkout, crewDir }
}

function teardownReply({ seats = { seats: 4, proven: 4, failed: 0, recorded: 4 }, status = 0, archived = '/x.archive-2026-09-04T00-00-00-000Z' } = {}) {
  return { status, stdout: `${JSON.stringify({ archived, seats })}\n`, stderr: '' }
}

function spawned(calls, needle) {
  return calls.spawn.filter((call) => call.argv.includes(needle))
}

function rows(result) {
  return result.lines.map((row) => typeof row === 'string' ? JSON.parse(row) : row)
}

after(() => {
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* scratch cleanup */ }
  }
  scratchDirs.clear()
})

test('refsFromPrBody reads both trailer shapes and ignores closing keywords', () => {
  assert.deepEqual(refsFromPrBody('Refs #758, #800\n'), [758, 800])
  assert.deepEqual(refsFromPrBody('Refs: #12\n'), [12])
  assert.deepEqual(refsFromPrBody('Closes #999\n'), [])
  assert.deepEqual(refsFromPrBody('no trailer here\n'), [])
  assert.match('Refs #758', REFS_PATTERN)
})

test('repair output partitions rot, ambiguity, and deferred pin refusals', () => {
  const text = [
    'repaired crew/drive.mjs:52 -> crew/drive.mjs:54',
    `refused crew/drive.mjs:52: content appears nowhere in crew/drive.mjs; ${ROT_MARK}`,
    `refused crew/drive.mjs:52: content occurs 2 times in crew/drive.mjs; ${AMBIGUOUS_MARK}`,
    'refused crew/drive.mjs:52: manifest has no entry',
    'refused crew/drive.mjs:52: manifest entry is orphaned (no citation)',
  ].join('\n')
  const parsed = parseRepairOutput(text)
  assert.deepEqual(parsed.repairs, [{ key: 'crew/drive.mjs:52', nextKey: 'crew/drive.mjs:54' }])
  const classified = classifyRepairRefusals(parsed.refusals)
  assert.equal(classified.rot.length, 1)
  assert.equal(classified.ambiguous.length, 1)
  assert.equal(classified.other.length, 2)
})

test('archiveName uses the status archive marker and ISO-safe punctuation', () => {
  const value = archiveName('/tmp/lane', '2026-09-04T10:50:36.577Z')
  assert.match(value, /\.archive-\d{4}-\d{2}-\d{2}T/)
  assert.equal(value, '/tmp/lane.archive-2026-09-04T10-50-36-577Z')
  assert.equal(ARCHIVE_MARK, '.archive-')
})

test('newestMtime reports the largest file mtime and unknown for an absent tree', () => {
  const dir = scratch('closeout-mtime-')
  put(join(dir, 'a', 'one.txt'), 'one')
  put(join(dir, 'two.txt'), 'two')
  utimesSync(join(dir, 'a', 'one.txt'), 10, 10)
  utimesSync(join(dir, 'two.txt'), 20, 20)
  assert.equal(newestMtime(dir), statSync(join(dir, 'two.txt')).mtimeMs)
  assert.equal(newestMtime(join(dir, 'missing')), null)
})

test('quietProbe distinguishes equal, advancing, and unknown reads', () => {
  let advancing = 0
  const equal = quietProbe({ dirs: ['tree', 'crew'], deps: { newest: () => 10, sleep: () => {} } })
  const moving = quietProbe({ dirs: ['tree'], deps: { newest: () => { advancing += 1; return advancing }, sleep: () => {} } })
  const unknown = quietProbe({ dirs: ['tree'], deps: { newest: () => null, sleep: () => {} } })
  assert.equal(equal.quiet, true)
  assert.equal(equal.unknown, false)
  assert.equal(moving.quiet, false)
  assert.equal(unknown.quiet, false)
  assert.equal(unknown.unknown, true)
  assert.equal(equal.reads.length, 2)
})

test('envelopeReport classifies stale and matching assignment ids', () => {
  const dir = scratch('closeout-envelope-')
  put(join(dir, 'd5.planner.json'), JSON.stringify({ assignment_id: 'd3', status: 'done', details: { mutations: Array(30).fill({}) } }))
  put(join(dir, 'd2.builder.json'), JSON.stringify({ assignment_id: 'd2', status: 'done', details: { mutations: [] } }))
  const stale = envelopeReport({ returnsDir: dir })
  assert.equal(stale.present, true)
  assert.equal(stale.file, 'd5.planner.json')
  assert.equal(stale.expected_id, 'd5')
  assert.equal(stale.assignment_id, 'd3')
  assert.equal(stale.status, 'done')
  assert.equal(stale.mutations, 30)
  assert.equal(stale.verdict, ENVELOPE_REFUSED)
  put(join(dir, 'd5.planner.json'), JSON.stringify({ assignment_id: 'd5', status: 'done', details: { mutations: [] } }))
  assert.equal(envelopeReport({ returnsDir: dir }).verdict, ENVELOPE_ACCEPTED)
  const empty = envelopeReport({ returnsDir: scratch('closeout-empty-') })
  assert.equal(empty.present, false)
  assert.equal(empty.verdict, ENVELOPE_ABSENT)
})

test('adoptCommandLine carries the measured batch and fence values or explicit unknowns', () => {
  const command = adoptCommandLine({ lane, archive: '/tmp/lane.recovery-copy', batchDir: '/tmp/batch', fencesPath: '/tmp/batch/fences.json' })
  assert.equal(command, 'node scripts/factory/dispatch-batch.mjs --batch /tmp/batch --fences /tmp/batch/fences.json --adopt b415-closeout=/tmp/lane.recovery-copy')
  const unknown = adoptCommandLine({ lane, archive: '/tmp/lane.recovery-copy' })
  assert.match(unknown, /<batch-dir UNKNOWN: no boot brief row in journal\.jsonl>/)
  assert.match(unknown, /<fences UNKNOWN: no fences\.json under the batch dir>/)
})

test('mergeCheck uses one scratch, merges every lane, runs suite and repairs every manifest', () => {
  const logs = []
  const { deps, calls } = harness({
    answers: [
      ['gh pr view', (argv) => ({ status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', headRefName: argv.includes('lane-b') ? 'lane-b' : 'lane-a', body: 'Refs #758' }), stderr: '' })],
      ['--test', { status: 0, stdout: '\u001b[32m# pass 3501\u001b[0m\n# fail 0\n# skipped 1\n', stderr: '' }],
      ['anchor-pin.mjs', { status: 0, stdout: 'repaired crew/drive.mjs:52 -> crew/drive.mjs:54\n', stderr: '' }],
    ],
    log: (line) => logs.push(line),
  })
  const result = mergeCheck({ lanes: ['lane-a', 'lane-b'], checkout: process.cwd(), deps })
  assert.equal(result.code, 0)
  assert.equal(result.refusal, null)
  assert.equal(spawned(calls, 'worktree add').length, 1)
  assert.equal(spawned(calls, 'git merge ').length, 2)
  assert.equal(spawned(calls, '--test').length, 1)
  assert.equal(result.report.merged, 2)
  assert.equal(result.report.suite.pass, 3501)
  assert.equal(result.report.suite.fail, 0)
  assert.equal(result.report.pins_moved.length > 0, true)
  assert.equal(spawned(calls, 'git worktree remove --force').length, 1)
  assert.equal(logs.length, MERGE_CHECK_STEPS.length)
  assert.equal(result.lines.length, MERGE_CHECK_STEPS.length)
})

test('mergeCheck stops on red suite and removes the scratch worktree', () => {
  const { deps, calls } = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 1, stdout: '# pass 2\n# fail 1\n', stderr: 'failed' }],
    ],
  })
  const result = mergeCheck({ lanes: [lane], checkout: process.cwd(), deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.SUITE_RED)
  assert.equal(result.lines.at(-1).step, 'suite')
  assert.equal(spawned(calls, 'git worktree remove --force').length, 1)
})

test('RV2-1 mergeCheck blocks anchor refusals and main returns named refusal exit codes', () => {
  const check = (repair, reason) => {
    const { deps, calls } = harness({
      answers: [
        ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
        ['--test', { status: 0, stdout: '# pass 3501\n# fail 0\n# skipped 1\n', stderr: '' }],
        ['anchor-pin.mjs', { status: 1, stdout: `refused crew/drive.mjs:52: ${repair}\n`, stderr: '' }],
      ],
    })
    const result = mergeCheck({ lanes: [lane], checkout: process.cwd(), deps })
    assert.equal(result.code, 1)
    assert.equal(result.refusal.reason, reason)
    assert.equal(result.refusal.step, 'anchor-repair')
    assert.equal(result.lines.at(-1).step, 'anchor-repair')
    assert.equal(spawned(calls, 'git worktree remove --force').length, 1)
    return deps
  }
  const rotDeps = check(`content appears nowhere in crew/drive.mjs; ${ROT_MARK}`, CLOSEOUT_REFUSALS.ANCHOR_ROT)
  check(`content occurs 2 times in crew/drive.mjs; ${AMBIGUOUS_MARK}`, CLOSEOUT_REFUSALS.ANCHOR_AMBIGUOUS)
  assert.equal(main(['merge-check', lane, '--checkout', process.cwd()], rotDeps), 1)
})

test('reap closes every Refs issue and archives only unarchived recovery copies', () => {
  const home = scratch('closeout-reap-')
  const checkout = join(home, 'dt-b415-closeout')
  const crewDir = join(home, '.crew', 'dt-b415-closeout', lane)
  mkdirSync(`${crewDir}.recovery-copy`, { recursive: true })
  mkdirSync(`${crewDir}${ARCHIVE_MARK}2026-09-04T10-50-36-577Z.recovery-copy`, { recursive: true })
  const { deps, calls } = harness({
    home,
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'MERGED', headRefName: lane, body: 'Refs #758, #800' }), stderr: '' }]],
  })
  const result = reap({ lanes: [lane], checkout, deps })
  assert.equal(result.code, 0)
  const closes = spawned(calls, 'issue close')
  assert.equal(closes.length, 2)
  for (const call of closes) {
    const commentAt = call.args.indexOf('--comment')
    assert.notEqual(commentAt, -1)
    assert.equal(call.args[commentAt + 1], `closed by ${lane} in PR #895 (reaped by scripts/factory/closeout.mjs)`)
  }
  assert.equal(calls.rename.length, 1)
  assert.match(calls.rename[0][1], /\.archive-\d{4}-\d{2}-\d{2}T/)
  assert.equal(calls.rm.filter(([path]) => path.startsWith(join(home, '.crew'))).length, 0)
})

test('reap refuses an open PR before closing issues or removing anything', () => {
  const { deps, calls } = harness({
    home: scratch('closeout-reap-open-'),
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'OPEN', body: 'Refs #758' }), stderr: '' }]],
  })
  const result = reap({ lanes: [lane], checkout: process.cwd(), deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.PR_NOT_MERGED)
  assert.equal(spawned(calls, 'issue close').length, 0)
  assert.equal(spawned(calls, 'worktree remove').length, 0)
})

test('RV1-2 reap archives recovery copies under the dispatched lane worktree root', () => {
  const home = scratch('closeout-reap-lane-root-')
  const checkout = join(home, 'dt-main')
  const laneDir = join(home, `dt-${lane}`)
  const crewDir = join(home, '.crew', `dt-${lane}`, lane)
  mkdirSync(`${crewDir}.recovery-copy`, { recursive: true })
  const { deps, calls } = harness({
    home,
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'MERGED', body: '' }), stderr: '' }]],
  })
  const result = reap({ lanes: [lane], checkout, deps })
  assert.equal(result.code, 0)
  assert.deepEqual(calls.rename.map(([from]) => from), [`${crewDir}.recovery-copy`])
  assert.equal(result.report.archived[0].from, `${crewDir}.recovery-copy`)
  assert.equal(spawned(calls, 'worktree remove')[0].args.at(-1), laneDir)
})

test('RV1-3 reap attributes unreadable PR failures to pr-merged', () => {
  const { deps, calls } = harness({
    home: scratch('closeout-reap-pr-unreadable-'),
    answers: [['gh pr view', { status: 1, stdout: '', stderr: 'network unavailable' }]],
  })
  const result = reap({ lanes: [lane], checkout: process.cwd(), deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.PR_UNREADABLE)
  assert.equal(result.refusal.step, 'pr-merged')
  assert.equal(result.lines.length, 1)
  assert.equal(result.lines[0].step, 'pr-merged')
  assert.equal(result.lines[0].reason, CLOSEOUT_REFUSALS.PR_UNREADABLE)
  assert.equal(spawned(calls, 'worktree remove').length, 0)
})

test('recover refuses a moving tree before preserve or teardown', () => {
  const fixture = laneFixture('closeout-recover-moving-')
  let tick = 0
  const { deps, calls } = harness({
    home: fixture.home,
    newest: () => { tick += 1; return 1000 + tick },
    answers: [['crew.mjs teardown', teardownReply()]],
  })
  const result = recover({ lane, checkout: fixture.checkout, deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.TREE_NOT_QUIET)
  assert.equal(calls.cp.length, 0)
  assert.equal(spawned(calls, 'teardown').length, 0)
})

test('recover treats incomplete and seats-null teardown evidence as unproven', () => {
  const incomplete = laneFixture('closeout-recover-incomplete-')
  const incompleteDeps = harness({
    home: incomplete.home,
    answers: [['crew.mjs teardown', teardownReply({ seats: { seats: 4, proven: 2, failed: 2, recorded: 4 } })]],
  })
  assert.equal(recover({ lane, checkout: incomplete.checkout, deps: incompleteDeps.deps }).refusal.reason, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN)
  const absent = laneFixture('closeout-recover-null-')
  const absentDeps = harness({
    home: absent.home,
    answers: [
      ['crew.mjs teardown', { status: 0, stdout: `${JSON.stringify({ seats: null })}\n`, stderr: '' }],
      ['pgrep', { status: 0, stdout: '41234\n41235\n', stderr: '' }],
    ],
  })
  const result = recover({ lane, checkout: absent.checkout, deps: absentDeps.deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.TEARDOWN_UNPROVEN)
  assert.equal(spawned(absentDeps.calls, 'pgrep').length, 1)
})

test('RV1-1 recover reads the archived crew directory after a real teardown', () => {
  const fixture = laneFixture('closeout-recover-real-teardown-')
  const archived = `${fixture.crewDir}${ARCHIVE_MARK}2026-09-04T10-50-36-577Z`
  const { deps, calls } = harness({
    home: fixture.home,
    answers: [['crew.mjs teardown', () => {
      renameSync(fixture.crewDir, archived)
      return teardownReply({ archived })
    }]],
  })
  const result = recover({ lane, checkout: fixture.checkout, deps })
  assert.equal(existsSync(fixture.crewDir), false)
  assert.equal(existsSync(archived), true)
  assert.equal(result.refusal, null)
  assert.equal(result.code, 0)
  assert.equal(result.report.crew_dir, archived)
  assert.equal(result.report.adopt.archive, `${fixture.crewDir}.recovery-copy`)
  assert.equal(result.lines.at(-1).step, 'closeout')
  assert.equal(spawned(calls, 'dispatch-batch').length, 0)
})

test('recover continues after a clear seats-null pgrep and stops pre-commit at adopt-ready', () => {
  const fixture = laneFixture('closeout-recover-adopt-')
  const { deps, calls } = harness({
    home: fixture.home,
    answers: [
      ['crew.mjs teardown', { status: 0, stdout: `${JSON.stringify({ seats: null })}\n`, stderr: '' }],
      ['pgrep', { status: 1, stdout: '', stderr: '' }],
    ],
  })
  const result = recover({ lane, checkout: fixture.checkout, deps })
  assert.equal(result.code, 0)
  assert.equal(result.report.adopt.archive, `${fixture.crewDir}.recovery-copy`)
  assert.match(result.report.adopt.command, /--adopt b415-closeout=.*\.recovery-copy/)
  assert.match(result.report.adopt.command, /--batch .*batch-2026-09-04-r18/)
  assert.match(result.report.adopt.command, /--fences .*fences\.json/)
  assert.equal(result.lines.some((row) => row.step === 'rebase'), false)
  assert.equal(spawned(calls, 'dispatch-batch').length, 0)
})

test('RV1-1 recover ignores its own pgrep PID in seats-null fallback', () => {
  const fixture = laneFixture('closeout-recover-self-pid-')
  const { deps, calls } = harness({
    home: fixture.home,
    answers: [
      ['crew.mjs teardown', { status: 0, stdout: `${JSON.stringify({ seats: null })}\n`, stderr: '' }],
      ['pgrep', { status: 0, stdout: `${process.pid}\n`, stderr: '' }],
    ],
  })
  const result = recover({ lane, checkout: fixture.checkout, deps })
  assert.equal(result.code, 0)
  assert.equal(result.refusal, null)
  assert.equal(result.report.teardown.pgrep, 'clear')
  assert.equal(spawned(calls, 'pgrep').length, 1)
})

test('recover reports a stale envelope and refuses missing lane fences', () => {
  const fixture = laneFixture('closeout-recover-envelope-')
  const { deps } = harness({ home: fixture.home, answers: [['crew.mjs teardown', teardownReply()]] })
  const result = recover({ lane, checkout: fixture.checkout, deps })
  assert.equal(result.report.envelope.verdict, ENVELOPE_REFUSED)
  assert.equal(result.report.envelope.assignment_id, 'd3')
  assert.equal(result.report.envelope.expected_id, 'd5')
  assert.equal(result.report.envelope.mutations, 30)
  put(join(fixture.crewDir, 'crew.json'), JSON.stringify({ checkout: fixture.checkout, lane_name: lane }))
  const missing = recover({ lane, checkout: fixture.checkout, deps: harness({ home: fixture.home, answers: [['crew.mjs teardown', teardownReply()]] }).deps })
  assert.equal(missing.refusal.reason, CLOSEOUT_REFUSALS.FENCE_ABSENT)
})

test('recover emits unknown adoption placeholders when journal boot evidence is absent', () => {
  const fixture = laneFixture('closeout-recover-unknown-')
  put(join(fixture.crewDir, 'journal.jsonl'), '')
  const result = recover({ lane, checkout: fixture.checkout, deps: harness({ home: fixture.home, answers: [['crew.mjs teardown', teardownReply()]] }).deps })
  assert.match(result.report.adopt.batch_dir, /<batch-dir UNKNOWN/)
  assert.match(result.report.adopt.fences, /<fences UNKNOWN/)
})

test('run-log convention applies to merge-check, reap, and recover', () => {
  const mergeOutput = []
  const mergeRun = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 1, stdout: '# pass 2\n# fail 1\n', stderr: 'failed' }],
    ],
    log: (line) => mergeOutput.push(line),
  })
  const mergeResult = mergeCheck({ lanes: [lane], checkout: process.cwd(), deps: mergeRun.deps })

  const reapOutput = []
  const reapRun = harness({
    home: scratch('closeout-log-reap-'),
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'OPEN', body: '' }), stderr: '' }]],
    log: (line) => reapOutput.push(line),
  })
  const reapResult = reap({ lanes: [lane], checkout: process.cwd(), deps: reapRun.deps })

  const fixture = laneFixture('closeout-log-recover-')
  const recoverOutput = []
  let tick = 0
  const recoverRun = harness({
    home: fixture.home,
    newest: () => { tick += 1; return tick },
    log: (line) => recoverOutput.push(line),
  })
  const recoverResult = recover({ lane, checkout: fixture.checkout, deps: recoverRun.deps })

  for (const execution of [
    { verb: 'merge-check', result: mergeResult, output: mergeOutput },
    { verb: 'reap', result: reapResult, output: reapOutput },
    { verb: 'recover', result: recoverResult, output: recoverOutput },
  ]) {
    const emitted = execution.output.map((line) => JSON.parse(line))
    assert.equal(emitted.length, execution.result.lines.length, `${execution.verb} emits one JSON line per step`)
    assert.equal(execution.result.refusal !== null, true)
    for (const row of emitted) {
      assert.equal(row.event, STEP_EVENT)
      assert.equal(typeof row.step, 'string')
      assert.equal(Number.isFinite(row.ms), true)
      assert.equal(row.ms >= 0, true)
      assert.equal(Object.values(STEP_OUTCOMES).includes(row.outcome), true)
    }
    assert.equal(emitted.at(-1).outcome, STEP_OUTCOMES.REFUSED)
    assert.equal(emitted.at(-1).step, execution.result.refusal.step)
  }
})

test('all emitted step rows carry JSON, finite durations, and the refused row is last', () => {
  const fixture = laneFixture('closeout-log-')
  const output = []
  const result = recover({
    lane,
    checkout: fixture.checkout,
    deps: harness({
      home: fixture.home,
      newest: (() => { let n = 0; return () => { n += 1; return n } })(),
      answers: [['crew.mjs teardown', teardownReply()]],
      log: (line) => output.push(line),
    }).deps,
  })
  const emitted = output.map((line) => JSON.parse(line)).filter((row) => row.event === STEP_EVENT)
  assert.equal(emitted.length, result.lines.length)
  for (const row of emitted) {
    assert.equal(typeof row.step, 'string')
    assert.equal(Number.isFinite(row.ms), true)
    assert.equal(row.ms >= 0, true)
    assert.equal(typeof row.outcome, 'string')
  }
  const refusedAt = result.lines.findIndex((row) => row.outcome === STEP_OUTCOMES.REFUSED)
  assert.equal(refusedAt, result.lines.length - 1)
})

test('parseArgs and main use usage, refusal, and success exit codes', () => {
  assert.deepEqual(parseArgs(['merge-check', 'lane-a', '--checkout', '/tmp/repo']), {
    verb: 'merge-check', lanes: ['lane-a'], checkout: '/tmp/repo', help: false,
  })
  assert.throws(() => parseArgs(['unknown', 'lane']), (error) => error.reason === CLOSEOUT_REFUSALS.USAGE)
  assert.throws(() => parseArgs(['reap']), (error) => error.reason === CLOSEOUT_REFUSALS.USAGE)
  assert.equal(main(['unknown'], { log: () => {} }), 2)
  const fixture = laneFixture('closeout-main-')
  const deps = harness({ home: fixture.home, answers: [['crew.mjs teardown', teardownReply()]], log: () => {} }).deps
  assert.equal(main(['recover', lane, '--checkout', fixture.checkout], deps), 0)
})

// Keep imported frozen step definitions exercised as data, not as an export-presence assertion.
test('verb step tables preserve their ordered contracts', () => {
  assert.deepEqual([...MERGE_CHECK_STEPS], ['pr-open', 'scratch-worktree', 'merge', 'suite', 'anchor-repair', 'report'])
  assert.deepEqual([...REAP_STEPS], ['pr-merged', 'issues', 'worktree', 'branch', 'prune', 'archive'])
  assert.deepEqual([...RECOVER_STEPS], ['quiet', 'preserve', 'teardown', 'verify', 'closeout'])
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
})

test('merge-check refuses anchor-rot when a repair reports content nowhere', () => {
  const { deps } = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 0, stdout: '# pass 3501\n# fail 0\n# skipped 1\n', stderr: '' }],
      ['anchor-pin.mjs', { status: 1, stdout: 'refused crew/drive.mjs:52: content appears nowhere in crew/drive.mjs; this is rot, not a shift\n', stderr: '' }],
    ],
  })
  const result = mergeCheck({ lanes: ['lane-a'], checkout: process.cwd(), deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.ANCHOR_ROT)
  assert.equal(result.lines.some((row) => row.step === 'report'), false)
})

test('merge-check refuses anchor-ambiguous when a repair reports more than one match', () => {
  const { deps } = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 0, stdout: '# pass 3501\n# fail 0\n# skipped 1\n', stderr: '' }],
      ['anchor-pin.mjs', { status: 1, stdout: 'refused crew/drive.mjs:52: content occurs 3 times in crew/drive.mjs; a repair refuses to guess\n', stderr: '' }],
    ],
  })
  const result = mergeCheck({ lanes: ['lane-a'], checkout: process.cwd(), deps })
  assert.equal(result.refusal.reason, CLOSEOUT_REFUSALS.ANCHOR_AMBIGUOUS)
})

test('main returns exit code 1 for a named refusal', () => {
  const refused = harness({
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }]],
    log: () => {},
  })
  assert.equal(main(['reap', 'lane-a'], refused.deps), 1)

  const success = harness({
    home: scratch('closeout-main-success-'),
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'MERGED', body: '' }), stderr: '' }]],
    log: () => {},
  })
  assert.equal(main(['reap', 'lane-a'], success.deps), 0)
  assert.equal(main(['unknown'], { log: () => {} }), 2)
})

test('merge-check removes the scratch worktree on the success path', () => {
  const checkout = process.cwd()
  const { deps, calls } = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 0, stdout: '# pass 3501\n# fail 0\n# skipped 1\n', stderr: '' }],
      ['anchor-pin.mjs', { status: 0, stdout: '', stderr: '' }],
    ],
  })
  const result = mergeCheck({ lanes: ['lane-a'], checkout, deps })
  const removals = calls.spawn.filter((call) => call.argv.includes('worktree remove --force'))
  assert.equal(result.code, 0)
  assert.equal(removals.length, 1)
  assert.equal(removals[0].cwd, checkout)
  assert.equal(calls.rm.some(([path]) => String(path) === result.scratch), false)
})

test('reap closes each issue with a comment naming the PR', () => {
  const { deps, calls } = harness({
    home: scratch('closeout-named-comment-'),
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'MERGED', body: 'Refs #758, #800' }), stderr: '' }]],
  })
  const result = reap({ lanes: ['lane-a'], checkout: process.cwd(), deps })
  const closes = spawned(calls, 'issue close')
  assert.equal(result.code, 0)
  assert.equal(closes.length, 2)
  for (const call of closes) {
    const at = call.args.indexOf('--comment')
    assert.notEqual(at, -1)
    assert.match(call.args[at + 1], /PR #895/)
    assert.match(call.args[at + 1], /lane-a/)
  }
})

test('merge-check emits one JSON line per step with step, ms and outcome', () => {
  const logged = []
  const { deps } = harness({
    answers: [
      ['gh pr view', { status: 0, stdout: JSON.stringify({ number: 900, state: 'OPEN', body: '' }), stderr: '' }],
      ['--test', { status: 0, stdout: '# pass 3501\n# fail 0\n# skipped 1\n', stderr: '' }],
      ['anchor-pin.mjs', { status: 0, stdout: '', stderr: '' }],
    ],
    log: (line) => logged.push(line),
  })
  const result = mergeCheck({ lanes: ['lane-a'], checkout: process.cwd(), deps })
  const rows = logged.map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((row) => row.step), [...MERGE_CHECK_STEPS])
  assert.deepEqual(result.lines.map((row) => row.step), [...MERGE_CHECK_STEPS])
  for (const row of rows) {
    assert.equal(Number.isFinite(row.ms), true)
    assert.equal(row.ms >= 0, true)
    assert.equal(Object.values(STEP_OUTCOMES).includes(row.outcome), true)
  }
})

test('reap emits one JSON line per step with step, ms and outcome', () => {
  const logged = []
  const { deps } = harness({
    home: scratch('closeout-reap-log-'),
    answers: [['gh pr view', { status: 0, stdout: JSON.stringify({ number: 895, state: 'MERGED', body: '' }), stderr: '' }]],
    log: (line) => logged.push(line),
  })
  const result = reap({ lanes: ['lane-a'], checkout: process.cwd(), deps })
  const loggedRows = logged.map((line) => JSON.parse(line))
  assert.deepEqual(loggedRows.map((row) => row.step), [...REAP_STEPS])
  assert.deepEqual(result.lines.map((row) => row.step), [...REAP_STEPS])
  for (const row of [...loggedRows, ...result.lines]) {
    assert.equal(Number.isFinite(row.ms), true)
    assert.equal(row.ms >= 0, true)
    assert.equal(Object.values(STEP_OUTCOMES).includes(row.outcome), true)
  }
})
