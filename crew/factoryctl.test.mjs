import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemon } from './daemon.mjs'
import { formatRows, main } from './factoryctl.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'factoryctl-'))
  const crewDir = join(root, 'crew')
  const returnsDir = join(crewDir, 'returns')
  const taskReturn = join(returnsDir, 'task.json')
  const brief = join(root, 'brief.md')
  mkdirSync(returnsDir, { recursive: true })
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
    task: 'demo-task', checkout: process.cwd(), task_return: 'returns/task.json',
    roles: ['builder'], members: { builder: { transport: 'pane' } },
  }))
  writeFileSync(join(crewDir, 'journal.jsonl'), '')
  writeFileSync(brief, '# brief\n')
  let uuid = 0
  const d = daemon({
    root,
    deps: {
      fork: () => ({ pid: 4242, on() { return this }, unref() {} }),
      kill: (_pid, signal) => { if (signal !== 0) return true },
      now: () => Date.now(), uuid: () => `run-${++uuid}`,
      setInterval: () => null, clearInterval: () => {},
    },
  })
  return { root, crewDir, taskReturn, brief, daemon: d, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function withDaemon(name, fn) {
  test(name, async () => {
    const f = fixture()
    try {
      await f.daemon.start()
      await fn(f)
    } finally {
      await f.daemon.stop()
      f.cleanup()
    }
  })
}

async function invoke(f, argv, extra = {}) {
  let stdout = ''
  let stderr = ''
  const code = await main([...argv, '--root', f.root], {
    ...extra,
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr }
}

async function enqueue(f) {
  const result = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief])
  assert.equal(result.code, 0)
  return { result, runId: JSON.parse(result.stdout).run_id }
}

withDaemon('run enqueues against the daemon and prints the run id', async (f) => {
  // Pins run as a socket enqueue and not as a locally invented run record.
  const { runId } = await enqueue(f)
  assert.ok(runId)
  const row = f.daemon.list().find((run) => run.run_id === runId)
  assert.ok(row)
  assert.equal(row.crew_dir, f.crewDir)
})

withDaemon("run surfaces the daemon's refusal verbatim", async (f) => {
  // Pins the daemon's invalid-spec and run-active vocabulary instead of client aliases.
  const missingCrew = join(f.root, 'missing-crew')
  mkdirSync(missingCrew)
  const invalid = await invoke(f, ['run', '--crew-dir', missingCrew, '--brief', f.brief])
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, new RegExp(`cannot read crew\\.json at ${missingCrew.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(invalid.stderr, /conflict|duplicate|busy/i)

  await enqueue(f)
  const duplicate = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief])
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.stderr, new RegExp(`is already active for ${f.crewDir.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`))
  assert.doesNotMatch(duplicate.stderr, /conflict|duplicate|busy/i)
})

withDaemon('run rejects a missing --crew-dir/--brief before touching the socket', async (f) => {
  // Pins client-side argument checks before connect, leaving the daemon untouched.
  let touched = false
  const net = { connect: () => { touched = true; throw new Error('socket should not be touched') } }
  const noCrew = await invoke(f, ['run', '--brief', f.brief], { net })
  assert.equal(noCrew.code, 1)
  assert.match(noCrew.stderr, /--crew-dir/)
  const noBrief = await invoke(f, ['run', '--crew-dir', f.crewDir], { net })
  assert.equal(noBrief.code, 1)
  assert.match(noBrief.stderr, /--brief/)
  assert.equal(touched, false)
})

withDaemon("ls lists the daemon's runs with their daemon-derived state", async (f) => {
  // Pins STATE to the daemon's list projection rather than a client lifecycle guess.
  const { runId } = await enqueue(f)
  const listed = await invoke(f, ['ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.stdout, new RegExp(runId))
  assert.match(listed.stdout, /working/)
})

withDaemon('ls never reports an outcome for an unsettled run', async (f) => {
  // Pins an unsettled result to a visibly empty outcome cell, never an implied success.
  const { runId } = await enqueue(f)
  const json = await invoke(f, ['ls', '--json'])
  assert.equal(json.code, 0)
  const rows = JSON.parse(json.stdout)
  assert.equal(rows.find((row) => row.run_id === runId).outcome, null)
  const table = await invoke(f, ['ls'])
  const row = table.stdout.split('\n').find((line) => line.includes(runId))
  const residue = row.replace(runId, '').replace('demo-task', '').replace('working', '')
  assert.doesNotMatch(residue, /[A-Za-z]/)
})

withDaemon('a settled ESCALATION shows as done with no success implied', async (f) => {
  // Pins settled escalation as done plus result-derived escalation, not success from state.
  const { runId } = await enqueue(f)
  writeFileSync(f.taskReturn, JSON.stringify({ status: 'escalation' }))
  f.daemon.poll()
  const listed = await invoke(f, ['ls'])
  assert.equal(listed.code, 0)
  assert.match(listed.stdout, new RegExp(`${runId}.*done.*escalation`))
  assert.equal(f.daemon.state({ run: runId }).state, 'done')
  assert.doesNotMatch(listed.stdout, /success|succeeded|\bok\b|passed|complete/i)
})

test('both verbs fail clearly with no daemon listening', async () => {
  // Pins absent-daemon guidance for both verbs without silently starting one.
  const f = fixture()
  try {
    const run = await invoke(f, ['run', '--crew-dir', f.crewDir, '--brief', f.brief])
    const ls = await invoke(f, ['ls'])
    for (const result of [run, ls]) {
      assert.equal(result.code, 1)
      assert.match(result.stderr, /no crew daemon is listening/)
      assert.match(result.stderr, new RegExp(f.root.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '/daemon\\.sock'))
      assert.match(result.stderr, /crew\/daemon\.mjs/)
    }
  } finally { f.cleanup() }
})

test('a stale socket file is the same clear refusal, not a stack trace', async () => {
  // Pins ENOTSOCK/ECONNREFUSED normalization instead of exposing a transport stack trace.
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'daemon.sock'), 'not a socket')
    const result = await invoke(f, ['ls'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no crew daemon is listening/)
    assert.match(result.stderr, /crew\/daemon\.mjs/)
    assert.doesNotMatch(result.stderr, /Error:\s+(?:ENOTSOCK|ECONNREFUSED)/)
  } finally { f.cleanup() }
})

test('formatRows renders an absent outcome as an empty cell', () => {
  // Pins the pure table renderer's null outcome as padding, not idle or success.
  const text = formatRows([
    { run_id: 'runalpha', task: 'demotask', state: 'working', outcome: null },
    { run_id: 'runbeta', task: 'demotask', state: 'done', outcome: 'escalation' },
  ])
  const lines = text.split('\n')
  assert.match(lines[0], /^RUN\s+STATE\s+OUTCOME\s+TASK$/)
  assert.match(lines[1], /runalpha/)
  assert.match(lines[2], /runbeta.*done.*escalation/)
  const residue = lines[1].replace(/runalpha|demotask|working/g, '')
  assert.doesNotMatch(residue, /[A-Za-z]/)
})
