import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyRun, headlessIo, shq } from './headless.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'headless-io-'))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const crew = { checkout: dir, members: { builder: { model: 'sonnet', transport: 'headless-json' } } }
  const calls = []
  const adapter = { headlessCommand(spec) {
    calls.push(spec)
    return { bin: '/worker/bin', args: ['-p', spec.prompt, '--session-id', spec.sessionId], env: {} }
  } }
  let pid = 700
  const io = headlessIo({ crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: { builder: { adapter } }, bin: '/worker/bin', deps: {
    spawn() { return { pid: ++pid, unref() {} } }, uuid: () => 'uuid-1', log() {},
  } })
  return { dir, taskDir, returnsDir, crew, calls, io, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('classifyRun keeps all six worker traps distinct', () => {
  const cases = [
    ['ok', { exitCode: 0, terminal: true, sawJson: true, envelope: {}, timedOut: false }],
    ['ok-degraded', { exitCode: 137, terminal: false, sawJson: true, envelope: {}, timedOut: false }],
    ['aborted', { exitCode: 143, terminal: false, sawJson: true, envelope: null, timedOut: false }],
    ['no-envelope', { exitCode: 0, terminal: true, sawJson: true, envelope: null, timedOut: false }],
    ['malformed', { exitCode: 1, terminal: false, sawJson: false, envelope: null, timedOut: false }],
    ['timeout', { exitCode: null, terminal: false, sawJson: false, envelope: null, timedOut: true }],
  ]
  assert.deepEqual(cases.map(([expected, input]) => classifyRun(input)), cases.map(([expected]) => expected))
})

test('envelope wins over exit and stream evidence', () => {
  assert.equal(classifyRun({ exitCode: 137, terminal: false, sawJson: true, envelope: { status: 'done' }, timedOut: false }), 'ok-degraded')
})

test('assign composes through adapter, removes stale envelope, and resumes one session', () => {
  const f = fixture()
  try {
    const stale = join(f.returnsDir, 'd1.builder.json'); writeFileSync(stale, '{}')
    const first = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md', note: 'extra' })
    assert.deepEqual({ id: first.id, returnPath: first.returnPath }, { id: 'd1', returnPath: stale })
    assert.equal(f.calls[0].resume, false); assert.equal(f.calls[0].sessionId, 'uuid-1')
    const restarted = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: f.calls ? { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } : null } }, bin: '/worker/bin', deps: { spawn() { return { pid: 901, unref() {} } }, uuid: () => 'uuid-2', log() {} } })
    assert.throws(() => restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-session-busy')
    writeFileSync(join(f.dir, 'task', 'headless', 'd1', 'exit'), '0')
    const second = restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(second.id, 'd2'); assert.equal(f.crew.members.builder.started, true)
    assert.equal(readFileSync(join(f.dir, 'task', 'headless', '.builder.active.json'), 'utf8').includes('uuid-1'), true)
  } finally { f.cleanup() }
})

test('dead pre-spawn reservation is reclaimed before the next assignment', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ phase: 'starting', role: 'builder', pid: null, ownerPid: 999999999, sessionId: 'old-session', exit: join(f.taskDir, 'headless', 'd0', 'exit') }))
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(run.id, 'd1')
    assert.equal(f.calls[0].sessionId, 'old-session')
  } finally { f.cleanup() }
})

test('assign rejects a concurrent invocation for one session', () => {
  const f = fixture()
  try {
    f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-session-busy')
  } finally { f.cleanup() }
})

test('wait returns an envelope as soon as it appears', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: 'd1', status: 'done' }))
    assert.deepEqual(f.io.wait(run.returnPath, 1), { assignment_id: 'd1', status: 'done' })
  } finally { f.cleanup() }
})

test('truncated stream, clean stream without envelope, and malformed stream have distinct stages', () => {
  for (const [stream, exit, stage] of [
    ['{"type":"assistant"}\n', '137', 'headless-aborted'],
    ['{"type":"result","terminal_reason":"done"}\n', '0', 'headless-no-envelope'],
    ['not json\n', '1', 'headless-malformed'],
  ]) {
    const f = fixture()
    try {
      const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      writeFileSync(join(f.dir, 'task', 'headless', run.id, 'stream.jsonl'), stream)
      writeFileSync(join(f.dir, 'task', 'headless', run.id, 'exit'), exit)
      assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === stage)
    } finally { f.cleanup() }
  }
})

test('shq round-trips a single quote as a shell token', () => {
  assert.equal(shq("a'b"), "'a'\\''b'")
})

test('timeout kills the detached process group and never hangs', () => {
  const f = fixture(); let clock = 0; const signals = []
  const io = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: f.calls ? { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } : null } }, bin: '/worker/bin', deps: {
    spawn() { return { pid: 88, unref() {} } }, uuid: () => 'u', now: () => clock, sleep: () => { clock += 5000 }, kill: (pid, signal) => signals.push([pid, signal]), log() {},
  } })
  try {
    const run = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => io.wait(run.returnPath, 1), (err) => err.stage === 'headless-timeout')
    assert.ok(signals.some(([pid, signal]) => pid === -88 && signal === 'SIGTERM'))
    assert.ok(signals.some(([pid, signal]) => pid === -88 && signal === 'SIGKILL'))
    assert.equal(existsSync(join(f.dir, 'task', 'headless', '.builder.active.json')), false)
    const restarted = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } } }, bin: '/worker/bin', deps: { spawn() { return { pid: 89, unref() {} } }, uuid: () => 'u2', log() {} } })
    assert.equal(restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' }).id, 'd2')
  } finally { f.cleanup() }
})
