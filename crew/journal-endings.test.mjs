import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scratchDir } from '../test/helpers.mjs'
import { stateless } from './lean-journal-order.mjs'
import { deadRun, pidRecord } from './run-pid.mjs'
import { createLeanSource } from './lean-source.mjs'
import { main as finish } from './finish.mjs'
import { main as closeout } from './closeout.mjs'
import { recordPr } from './record-pr.mjs'
import { main as steps } from './steps.mjs'

const lane = 'endings', at = Date.UTC(2026, 10, 28), dead = 4242, live = 4243
const pr = { number: 73, url: 'https://github.com/o/r/pull/73' }
const head = 'b'.repeat(40)
const start = (stage) => ({ event: 'stage-start', stage })
const end = (stage, outcome = { status: 'green' }) => ({ event: 'stage-end', stage, outcome })
const stop = (stage, reason) => ({ event: 'verdict', stage, status: 'stopped', reason })
const runStart = { event: 'run-start', stage: null, run_id: lane }
const openBuild = [runStart, start('build')]
const stopped = [...openBuild, stop('build', 'seat-escalated'), end('build', { status: 'stopped', reason: 'seat-escalated' })]
const planStop = [runStart, start('plan'), stop('plan', 'seat-escalated'), end('plan', { status: 'stopped', reason: 'seat-escalated' })]
const inFlight = [runStart, start('suite'), start('review'), stop('review', 'seat-escalated'),
  end('review', { status: 'stopped', reason: 'seat-escalated' }),
  { event: 'check', stage: 'suite', check: 'suite', result: { status: 'green', code: 0 } }, end('suite')]
const publish = { event: 'pr', stage: null, pr }
const published = [...openBuild, end('build'), start('publish'), end('publish'), publish]
const awaiting = [...published.slice(0, -1), { ...publish, awaitingCi: true }, start('ci'), { event: 'ci-progress', stage: 'ci', head, checks: [] }]
const ciCheck = (status) => ({ event: 'check', stage: 'ci', check: 'ci', action: 'wait', result: { status, head } })
const ciDone = [...awaiting, ciCheck('green'), end('ci'), { event: 'verdict', stage: null, status: 'done', reason: null }]
const ciStop = [...awaiting, ciCheck('red'), end('ci', { status: 'red' }), stop(null, 'ci-red')]
const readyRow = { event: 'finish-ready', stage: null, status: 'ready-for-operator', head, subject: 'fix: example', body: 'Measured', reviewRounds: 1 }
const ready = [...stopped, runStart, start('rebase'), end('rebase', { status: 'green', head }), readyRow]
const decision = (choice) => ({ event: 'finish-decision', choice, notesSha256: null })
const returned = (before, after = [], late = false) => {
  const row = { ...decision('return'), launchedAt: before.length, notesSha256: 'a'.repeat(64) }
  return late ? [...before, ...after, row] : [...before, row, ...after]
}
const republish = [runStart, start('publish'), end('publish'), publish]
const reready = [runStart, start('review'), end('review'), readyRow]
const restop = [runStart, start('review'), stop('review', 'lead-escalated'), end('review', { status: 'stopped', reason: 'lead-escalated' })]
const operatorPr = { ...publish, actor: 'operator', stage: 'operator' }
const notified = (rows, ending, payload) => [...rows, { event: 'run-end-command', ending, payload, status: 'green', command: 'notify', code: 0 }]

const DONE = ['done', null], STOP = ['stopped', 'seat-escalated'], DIED = ['stopped', 'run-died']
const READY = ['ready-for-operator', null], RETURNED = ['returned', null], ABANDONED = ['abandoned', null]
const NO_PR = /task journal records no pull request/, DEAD_NO_PR = /run-died: .* died with no pull request recorded/
const USE_FINISH = /lane has a finish record; use crew finish endings/, NOT_STOPPED = /lane endings is not stopped/
const HAS_PR = /already records a pull request/, NO_STOP = /finish-premise: lane endings has not stopped/
const FINISH_RUNNING = /finish-running: lane endings has run again since it stopped/
const PUBLISHED = `published ${pr.url}`

// Each row supplies the history and eight independent reader expectations.
// true means archive for closeout/discard, append for recordPr, include for steps.
const endings = [
  // ending, rows, run.pid, ignored indices, dead pid, lane [status, reason], finish report/refusal, closeout, discard, recordPr, steps
  ['lane-mode publication', published, null, [2, 4], null, DONE, PUBLISHED, true, NOT_STOPPED, HAS_PR, true],
  ['CI-mode done', ciDone, null, [2, 4, 7, 9], null, DONE, PUBLISHED, true, true, HAS_PR, true],
  ['stopped before publication with in-flight check', inFlight, null, [4, 5, 6], null, STOP, 'stop=seat-escalated', NO_PR, true, true, true],
  ['CI-mode stopped after publication', ciStop, null, [2, 4, 7, 9], null, ['stopped', 'ci-red'], PUBLISHED, true, true, HAS_PR, true],
  ['dead in open stage', openBuild, dead, [], dead, DIED, 'stop=run-died', DEAD_NO_PR, true, true, true],
  ['dead awaiting CI', awaiting, dead, [2, 4, 7], dead, DIED, PUBLISHED, true, true, HAS_PR, true],
  ['finish ready', ready, null, [3, 6], null, READY, 'stop=finish-ready', NO_PR, USE_FINISH, true, true],
  ['returned planning stop', returned(planStop), live, [3], null, RETURNED, FINISH_RUNNING, NO_PR, USE_FINISH, NOT_STOPPED, true,
    { finish: 'Bare finish reports the old planning stop after its return has already launched.' }],
  ['returned post-build stop', returned(stopped), live, [3], null, RETURNED, FINISH_RUNNING, NO_PR, USE_FINISH, NOT_STOPPED, true,
    { finish: 'Bare finish reports the old post-build stop after its return has already launched.' }],
  ['returned from death', returned(openBuild), live, [], null, RETURNED, NO_STOP, NO_PR, USE_FINISH, NOT_STOPPED, true],
  ['returned ready', returned(ready), live, [3, 6], null, RETURNED, FINISH_RUNNING, NO_PR, USE_FINISH, NOT_STOPPED, true],
  ['planning return then publication', returned(planStop, republish), null, [3, 7], null, DONE, PUBLISHED, true, NOT_STOPPED, HAS_PR, true],
  ['publication before parent return', returned(planStop, republish, true), null, [3, 6], null, DONE, PUBLISHED, true, NOT_STOPPED, HAS_PR, true],
  ['return then ready again', returned(ready, reready), null, [3, 6, 11], null, READY, 'stop=finish-ready', NO_PR, USE_FINISH, true, true],
  ['ready again before parent return', returned(ready, reready, true), null, [3, 6, 10], null, READY, 'stop=finish-ready', NO_PR, USE_FINISH, true, true],
  ['return then stopped again', returned(ready, restop), null, [3, 6, 12], null, ['stopped', 'lead-escalated'], 'stop=lead-escalated', NO_PR, USE_FINISH, true, true],
  ['stopped again before parent return', returned(ready, restop, true), null, [3, 6, 11], null, ['stopped', 'lead-escalated'], 'stop=lead-escalated', NO_PR, USE_FINISH, true, true],
  ['accepted ready', [...ready, { ...publish, stage: 'publish' }, decision('accept')], null, [3, 6], null, DONE, PUBLISHED, true, true, HAS_PR, true],
  ['abandoned stop', [...stopped, decision('abandon')], null, [3], null, ABANDONED, 'abandoned', NO_PR, true, /was abandoned/, true],
  ['abandoned death', [...openBuild, decision('abandon')], dead, [], null, ABANDONED, 'abandoned', NO_PR, true, /was abandoned/, true],
  ['abandoned ready', [...ready, decision('abandon')], null, [3, 6], null, ABANDONED, 'abandoned', NO_PR, true, /was abandoned/, true],
  ['operator PR on stop', [...stopped, operatorPr], null, [3], null, DONE, PUBLISHED, true, true, HAS_PR, true],
  ['operator PR on death', [...openBuild, operatorPr], dead, [], null, DONE, PUBLISHED, true, true, HAS_PR, true],
  ['operator PR on quiet ready', [...ready, operatorPr], null, [3, 6], null, DONE, PUBLISHED, true, USE_FINISH, HAS_PR, true],
  ['base-CI check without a run', [{ event: 'check', check: 'base-ci', state: 'green', baseCommit: head, base: 'main', repository: 'github.com/o/r' }], null, [0], null, ['unknown', 'task journal has no state rows'], NO_STOP, NO_PR, true, NOT_STOPPED, true],
  ['notification after stop', notified(stopped, 'stopped', 'seat-escalated'), null, [3, 4], null, STOP, 'stop=seat-escalated', NO_PR, true, true, true],
  ['notification after publication', notified(published, 'pr', pr.url), null, [2, 4, 6], null, DONE, PUBLISHED, true, NOT_STOPPED, HAS_PR, true],
  ['notification after ready', notified(ready, 'finish-ready', 'finish-ready'), null, [3, 6, 8], null, READY, 'stop=finish-ready', NO_PR, USE_FINISH, true, true],
]

const unexpected = () => assert.fail('a journal reader must not launch a process or signal a PID')
const alive = (pid, startedAt) => {
  if (pid === dead || pid === live) assert.equal(startedAt, at)
  return pid !== dead && pid !== process.pid
}

function fixture(parent, rows, pid, { absent = false } = {}) {
  const home = scratchDir('reader-', { parent }), root = join(home, 'crew'), archiveRoot = join(home, 'archive')
  const dir = join(root, `dt-${lane}`, lane), taskDir = join(dir, 'task'), cwd = join(home, `dt-${lane}`)
  const journal = join(taskDir, 'journal.jsonl'), text = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
  mkdirSync(taskDir, { recursive: true })
  // Use closeout's missing-worktree retry path to avoid OS process discovery.
  if (absent) mkdirSync(join(home, 'checkout', '.git'), { recursive: true })
  else mkdirSync(cwd)
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ members: { builder: { agent: 'pi' } } }))
  writeFileSync(join(taskDir, 'lean.json'), JSON.stringify({ id: lane, taskDir, cwd, branch: lane, base: 'main', tier: 'build', shape: 'standard' }))
  writeFileSync(journal, text)
  if (pid !== null) writeFileSync(join(taskDir, 'run.pid'), pidRecord(pid, at))
  return { home, root, archiveRoot, taskDir, journal, text, alive }
}

function checkCloseout(f, discard, expected) {
  let output = '', error = ''
  const status = closeout(discard ? [lane, '--discard'] : [lane], {
    ...f, stdout: (text) => { output += text }, stderr: (text) => { error += text }, kill: unexpected,
    run(cmd, args) {
      let stdout
      if (cmd === 'gh') {
        assert.deepEqual(args, ['pr', 'view', pr.url, '--json', discard ? 'state' : 'state,headRefOid'])
        stdout = JSON.stringify(discard ? { state: 'CLOSED' } : { state: 'MERGED', headRefOid: head })
      } else {
        assert.equal(cmd, 'git')
        assert.equal(discard, false)
        assert.deepEqual(args.slice(0, 2), ['-C', join(f.home, 'checkout')])
        const command = args.slice(2).join(' ')
        const replies = {
          'remote get-url origin': 'https://github.com/o/r.git\n',
          [`rev-parse --verify --quiet refs/heads/${lane}^{commit}`]: `${head}\n`,
          'worktree list --porcelain': '',
          [`branch -D ${lane}`]: '',
        }
        assert.ok(Object.hasOwn(replies, command), `unexpected git command: ${command}`)
        stdout = replies[command]
      }
      return { status: 0, stdout }
    },
  })
  const archived = join(f.archiveRoot, `dt-${lane}`, lane, 'task', 'journal.jsonl')
  if (expected === true) {
    assert.equal(status, 0, error)
    assert.match(output, discard ? /^discarded endings:/ : /^closed out endings:/)
    assert.equal(existsSync(f.journal), false)
    assert.equal(readFileSync(archived, 'utf8'), f.text)
  } else {
    assert.equal(status, 1, output)
    assert.match(error, expected)
    assert.equal(existsSync(archived), false)
    assert.equal(readFileSync(f.journal, 'utf8'), f.text)
  }
}

test('lane endings through journal readers', async (t) => {
  for (const [name, history, pid, ignored, died, state, report, close, discard, record, included, todos = {}] of endings) {
    await t.test(name, async (t) => {
      const parent = scratchDir('journal-endings-')
      t.after(() => rmSync(parent, { recursive: true, force: true }))
      const rows = history.map((row, i) => ({ lane, at: at + i, ...row }))
      const f = fixture(parent, rows, pid)
      await t.test('stateless', () => assert.deepEqual(rows.flatMap((row, i) => stateless(rows, row, i) ? [i] : []), ignored))
      await t.test('deadRun', () => assert.equal(deadRun({ ...f, rows })?.pid ?? null, died))
      await t.test('lean source', () => {
        const [run] = createLeanSource({ crewRoot: f.root, archiveRoot: f.archiveRoot, alive }).listRuns()
        assert.deepEqual([run.status, run.reason], state)
      })
      await t.test('finish', { todo: todos.finish ?? false }, async () => {
        const logs = [], write = process.stderr.write
        let error = '', status
        process.stderr.write = (text) => { error += text; return true }
        try {
          status = await finish([lane], { crewRoot: f.root, alive, log: (text) => logs.push(text), spawnDetached: unexpected, run: unexpected, kill: unexpected })
        } finally { process.stderr.write = write }
        if (typeof report === 'string') {
          assert.equal(status, 0, error)
          assert.deepEqual(logs, [`crew finish: lane=${lane} ${report}`])
        } else {
          assert.equal(status, 1, logs.join('\n'))
          assert.match(error, report)
        }
        assert.equal(readFileSync(f.journal, 'utf8'), f.text)
      })
      await t.test('closeout', () => checkCloseout(fixture(parent, rows, pid, { absent: true }), false, close))
      await t.test('discard', () => checkCloseout(fixture(parent, rows, pid, { absent: true }), true, discard))
      await t.test('recordPr', () => {
        const copy = fixture(parent, rows, pid)
        const next = { event: 'pr', lane, stage: 'operator', actor: 'operator', at: at + rows.length, pr }
        const append = () => recordPr({ lane, url: pr.url, root: copy.root, alive, now: () => next.at })
        if (record === true) assert.deepEqual(append().pr, pr)
        else assert.throws(append, record)
        assert.equal(readFileSync(copy.journal, 'utf8'), copy.text + (record === true ? `${JSON.stringify(next)}\n` : ''))
      })
      await t.test('steps', () => {
        let text = ''
        assert.equal(steps(['--since', '2026-11-28', '--json'], { ...f, stdout: (chunk) => { text += chunk }, stderr: assert.fail }), 0)
        const result = JSON.parse(text)
        const entry = result.lanes.find((entry) => entry.lane === lane)
        assert.equal(!!entry?.started_at && !entry.reason, included)
        if (included) assert.equal(result.totals.excluded, 0)
      })
    })
  }
})
