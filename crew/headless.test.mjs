import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyRun, headlessIo, shq } from './headless.mjs'

function makeFixture(overrides = {}, roles = ['builder']) {
  const dir = mkdtempSync(join(tmpdir(), 'headless-extra-'))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const members = Object.fromEntries(roles.map((role) => [role, { model: 'sonnet', transport: 'headless-json' }]))
  const crew = { checkout: dir, members }
  const calls = []
  const adapter = { headlessCommand(spec) { calls.push(spec); return { bin: '/worker/bin', args: ['-p', spec.prompt], env: {} } } }
  let nextPid = 700
  const deps = { pid: 700, uuid: (() => { let n = 0; return () => `extra-${++n}` })(), spawn() { return { pid: ++nextPid, unref() {} } }, log() {}, ...overrides }
  const io = headlessIo({ crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: Object.fromEntries(roles.map((role) => [role, { adapter }])), bin: '/worker/bin', deps })
  return { dir, taskDir, returnsDir, crew, calls, deps, io, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

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

// The planted legacy `starting` marker is the #134 bug: it proves nothing about whether spawn ran.
// RESERVED is the only pre-effect shape that can be reclaimed automatically.
test('a dead RESERVED reservation is reclaimed and keeps its session id', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old-reservation', key: 'builder', phase: 'reserved', owner: { pid: 999999999 }, sessionId: 'old-session', id: 'd0', exit: join(f.taskDir, 'headless', 'd0', 'exit') }))
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(run.id, 'd1')
    assert.equal(f.calls[0].sessionId, 'old-session')
  } finally { f.cleanup() }
})

test('a legacy starting marker is unresolvable, not reclaimed', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ phase: 'starting', role: 'builder', pid: null, ownerPid: 999999999, sessionId: 'old-session' }))
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-unresolvable-reservation')
    assert.equal(f.calls.length, 0)
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

test('allocator is exclusive across supervisors constructed before d1', () => { const a = makeFixture(); try { const b = headlessIo({ crew: a.crew, paths: { dir: a.dir, taskDir: a.taskDir, returnsDir: a.returnsDir }, taskDir: a.taskDir, checkout: a.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, uuid: (() => { let n = 0; return () => `b-${++n}` })(), spawn: () => ({ pid: 900, unref() {} }), log() {} } }); const first = a.io.assign({ role: 'builder', briefFile: '/tmp/b' }); writeFileSync(join(a.dir, 'task', 'headless', first.id, 'exit'), '0'); const second = b.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.notEqual(second.id, first.id); assert.equal(existsSync(join(a.dir, 'task', 'headless', second.id, 'exit')), false) } finally { a.cleanup() } })
test('two roles never adopt one candidate run directory', () => { const f = makeFixture({}, ['builder', 'reviewer']); try { const a = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); const b = f.io.assign({ role: 'reviewer', briefFile: '/tmp/b' }); assert.notEqual(a.id, b.id) } finally { f.cleanup() } })
test('running marker write crash retains SPAWNING reservation', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 901, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"running"')) throw Error('marker write'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 1); const restart = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, spawn: () => { spawned += 1; return { pid: 902, unref() {} } }, kill: () => true, log() {} } }); assert.throws(() => restart.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('post-return crash before pgid lands fails closed', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 901, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"running"')) throw Error('marker write'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); const r = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, kill: () => { const e = Error(); e.code = 'ESRCH'; throw e }, spawn: () => { spawned += 1; return { pid: 902, unref() {} } }, log() {} } }); assert.throws(() => r.assign({ role: 'builder', briefFile: '/tmp/b' }), (e) => e.stage === 'headless-unresolvable-reservation'); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('failed SPAWNING advance does not spawn and clears marker', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 900, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"spawning"')) throw Error('advance'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 0); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })
test('failed command write does not spawn and clears marker', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 900, unref() {} } }, writeFileSync(path, data, options) { if (String(path).endsWith('cmd.json')) throw Error('command'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 0); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })
test('proven-dead pgid reservation is reclaimed', () => { let spawned = 0; const f = makeFixture({ kill: (pid, signal) => { if (signal === 0) { const e = Error(); e.code = 'ESRCH'; throw e } if (Math.abs(pid) === 111) { const e = Error(); e.code = 'ESRCH'; throw e } }, spawn: () => { spawned += 1; return { pid: 900, unref() {} } } }); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); writeFileSync(join(f.taskDir, 'headless', 'd1', 'pgid'), '111'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old', key: 'builder', phase: 'spawning', owner: { pid: 999999999 }, id: 'd1', evidence: { kind: 'pgid', file: join(f.taskDir, 'headless', 'd1', 'pgid') } })); f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('live pgid reservation is busy', () => { let spawned = 0; const f = makeFixture({ kill: () => true, spawn: () => { spawned += 1; return { pid: 900, unref() {} } } }); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); writeFileSync(join(f.taskDir, 'headless', 'd1', 'pgid'), '222'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old', key: 'builder', phase: 'spawning', owner: { pid: 999999999 }, id: 'd1', evidence: { kind: 'pgid', file: join(f.taskDir, 'headless', 'd1', 'pgid') } })); assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' }), (e) => e.stage === 'headless-session-busy'); assert.equal(spawned, 0) } finally { f.cleanup() } })
test('completed legacy marker frees seat', () => { const f = makeFixture(); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); const exit = join(f.taskDir, 'headless', 'd1', 'exit'); writeFileSync(exit, '0'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ phase: 'running', role: 'builder', id: 'd1', exit, sessionId: 'old' })); f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.equal(f.calls[0].sessionId, 'old') } finally { f.cleanup() } })
test('synchronous spawn failure rolls back and retries', () => { let fail = true; const f = makeFixture({ spawn: () => { if (fail) { fail = false; throw Error('spawn') } return { pid: 901, unref() {} } } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false); assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })) } finally { f.cleanup() } })
test('unref failure retains SPAWNING reservation', () => { const f = makeFixture({ spawn: () => ({ pid: 901, unref() { throw Error('unref') } }) }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'headless', '.builder.active.json'))).phase, 'spawning') } finally { f.cleanup() } })
test('timeout EPERM retains marker', () => { let clock = 0; const f = makeFixture({ now: () => clock, sleep: () => { clock += 5000 }, kill() { const e = Error('permission'); e.code = 'EPERM'; throw e } }); try { const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.throws(() => f.io.wait(run.returnPath, 0)); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), true) } finally { f.cleanup() } })
test('timeout EPERM plus dead pgid clears marker', () => { let clock = 0; const f = makeFixture({ now: () => clock, sleep: () => { clock += 5000 }, kill(pid, signal) { if (signal === 'SIGTERM' || signal === 'SIGKILL') { const e = Error(); e.code = 'EPERM'; throw e } const e = Error(); e.code = 'ESRCH'; throw e } }); try { const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); mkdirSync(join(f.taskDir, 'headless', run.id), { recursive: true }); writeFileSync(join(f.taskDir, 'headless', run.id, 'pgid'), '111'); assert.throws(() => f.io.wait(run.returnPath, 0)); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })
