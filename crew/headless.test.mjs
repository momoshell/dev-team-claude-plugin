import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyRun, foldUsage, headlessIo, recogniseProviderCondition, shq, updateCrewJson } from './headless.mjs'
import { startFileWriter } from '../test/helpers.mjs'

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

test('a captured 529 stderr is recognised as an overloaded provider condition', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const runDir = join(f.taskDir, 'headless', run.id)
    writeFileSync(join(runDir, 'stderr.log'), 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(join(runDir, 'exit'), '1')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
      assert.equal(err.stage, 'headless-no-envelope')
      assert.equal(err.providerCondition, 'overloaded')
      return true
    })
    assert.equal(recogniseProviderCondition('{"type":"rate_limit_error"}'), 'rate-limit')
    assert.equal(recogniseProviderCondition('{"type":"authentication_error","status":401}'), 'auth')
  } finally { f.cleanup() }
})

test('ANSI-laden stderr matches through the CSI stripper a naive matcher would miss', () => {
  const raw = 'API Error: \x1b[1;31mrate\x1b[0m limit exceeded for this organization'
  assert.equal(/rate limit/i.test(raw), false)
  assert.equal(recogniseProviderCondition(raw), 'rate-limit')
})

test('an unrecognised, missing, empty or unreadable stderr carries no recognition', () => {
  const failure = (stderr, overrides = {}) => {
    const f = makeFixture(overrides)
    try {
      const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      const runDir = join(f.taskDir, 'headless', run.id)
      if (stderr !== undefined) writeFileSync(join(runDir, 'stderr.log'), stderr)
      writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
      writeFileSync(join(runDir, 'exit'), '1')
      assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
        assert.equal(err.stage, 'headless-no-envelope')
        assert.equal(Object.hasOwn(err, 'providerCondition'), false)
        return true
      })
    } finally { f.cleanup() }
  }
  failure('ordinary stderr text')
  failure('')
  failure(undefined)
  const realRead = readFileSync
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  failure('unreadable stderr', {
    readFileSync: (path, ...args) => {
      if (String(path).endsWith('/stderr.log')) throw denied
      return realRead(path, ...args)
    },
  })
})

test('recognition reads only the stderr the wrapper already captured and adds no poll', () => {
  const readPaths = []; let sleeps = 0
  const realRead = readFileSync
  const f = makeFixture({
    readFileSync: (path, ...args) => { readPaths.push(String(path)); return realRead(path, ...args) },
    sleep: () => { sleeps += 1; throw new Error('unexpected poll') },
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const runDir = join(f.taskDir, 'headless', run.id)
    const stderrPath = join(runDir, 'stderr.log')
    writeFileSync(stderrPath, 'ordinary stderr text')
    writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(join(runDir, 'exit'), '1')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-no-envelope')
    assert.equal(sleeps, 0)
    const allowed = new Set(['stream.jsonl', 'stderr.log', 'exit', 'cmd.json', 'pgid'])
    const underRun = readPaths.filter((path) => path.startsWith(`${runDir}/`))
    assert.ok(underRun.length > 0)
    assert.equal(underRun.every((path) => allowed.has(path.slice(runDir.length + 1))), true)
    assert.ok(readPaths.filter((path) => path === stderrPath).length <= 1)
  } finally { f.cleanup() }
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

test('the wrapper publishes its pgid atomically before the worker runs', () => {
  let shell = null
  const f = makeFixture({ spawn: (bin, args) => { shell = args[1]; return { pid: 901, unref() {} } } })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    const pgid = join(f.taskDir, 'headless', run.id, 'pgid')
    assert.ok(shell.startsWith(`printf '%s' $$ >'${pgid}.tmp';`), 'wrapper must publish its pgid as its first act')
    const published = shell.indexOf(`mv '${pgid}.tmp' '${pgid}'`)
    assert.ok(published > -1, 'pgid must be published by an atomic rename')
    assert.ok(published < shell.indexOf('/worker/bin'), 'pgid must exist before the worker starts')
  } finally { f.cleanup() }
})

test('allocation never re-adopts an existing run directory', () => {
  const f = makeFixture({ readdirSync: (p, opts) => (String(p).endsWith('/headless') ? [] : readdirSync(p, opts)) })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    writeFileSync(join(f.taskDir, 'headless', first.id, 'exit'), '0')
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    assert.notEqual(second.id, first.id)
    assert.equal(existsSync(join(f.taskDir, 'headless', second.id, 'exit')), false)
  } finally { f.cleanup() }
})

test('foldUsage prefers the claude result aggregate over assistant snapshots', () => {
  const capture = readFileSync(new URL('../tasks/headless-worker/captures/a-baseline.jsonl', import.meta.url), 'utf8')
  assert.deepEqual(foldUsage(capture), {
    billed_input_tokens: 18, billed_output_tokens: 287,
    billed_cache_write_tokens: 7709, billed_cache_read_tokens: 43575,
  })
})

test('foldUsage dedupes repeated assistant message ids with last occurrence wins', () => {
  const line = (id, output) => JSON.stringify({
    type: 'assistant', message: { id, usage: {
      input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000,
    } },
  })
  const text = [line('m1', 5), line('m1', 5), line('m1', 400), JSON.stringify({
    type: 'assistant', message: { id: 'm2', usage: {
      input_tokens: 8, output_tokens: 1, cache_creation_input_tokens: 36, cache_read_input_tokens: 74,
    } },
  })].join('\n')
  assert.deepEqual(foldUsage(text), {
    billed_input_tokens: 18, billed_output_tokens: 401,
    billed_cache_write_tokens: 136, billed_cache_read_tokens: 1074,
  })
})

test('headless usage stays null when a stream reports no usage', () => {
  const seen = []; const f = makeFixture({ emit: (event) => seen.push(event) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(f.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    assert.deepEqual(seen.map((event) => ({ kind: event.kind, usage: event.usage })), [{ kind: 'usage', usage: null }])
  } finally { f.cleanup() }
})

test('aborted headless runs emit deduped partial usage without changing classification', () => {
  const seen = []; const f = makeFixture({ emit: (event) => seen.push(event) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const assistant = (output) => JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: {
      input_tokens: 4, output_tokens: output, cache_creation_input_tokens: 2, cache_read_input_tokens: 3,
    } } })
    writeFileSync(join(f.taskDir, 'headless', run.id, 'stream.jsonl'), `${assistant(1)}\n${assistant(9)}\n`)
    writeFileSync(join(f.taskDir, 'headless', run.id, 'exit'), '137')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-aborted')
    assert.deepEqual(seen.at(-1).usage, {
      billed_input_tokens: 4, billed_output_tokens: 9,
      billed_cache_write_tokens: 2, billed_cache_read_tokens: 3,
    })
  } finally { f.cleanup() }
})

test('headless usage emission is never load-bearing on happy or aborted paths', () => {
  const happy = makeFixture({ emit: () => { throw new Error('emitter down') } })
  try {
    const run = happy.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(happy.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"result"}\n')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, status: 'done' }))
    assert.deepEqual(happy.io.wait(run.returnPath, 1), { assignment_id: run.id, status: 'done' })
  } finally { happy.cleanup() }
  const aborted = makeFixture({ emit: () => { throw new Error('emitter down') } })
  try {
    const run = aborted.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(aborted.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"assistant","message":{"id":"m","usage":{"output_tokens":1}}}\n')
    writeFileSync(join(aborted.taskDir, 'headless', run.id, 'exit'), '137')
    assert.throws(() => aborted.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-aborted')
  } finally { aborted.cleanup() }
})

function durabilityDocument() {
  return {
    task: 'crew-json-durability',
    members: {
      builder: { role: 'builder', model: 'builder-model', transport: 'headless-json' },
      reviewer: { role: 'reviewer', model: 'reviewer-model', transport: 'headless-json' },
    },
    seats: { builder: { model: 'builder-model' }, reviewer: { model: 'reviewer-model' } },
    padding: 'x'.repeat(4096),
  }
}

function durabilityPaths(tag) {
  const dir = mkdtempSync(join(tmpdir(), `headless-json-${tag}-`))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  return { dir, taskDir, returnsDir }
}

test('T1 harness control proves plain writes tear while atomic writes race safely', async () => {
  const paths = durabilityPaths('t1')
  const file = join(paths.dir, 'crew.json')
  const text = JSON.stringify({ ...durabilityDocument(), version: '%N%' })
  let plain = null; let atomic = null
  try {
    plain = await startFileWriter({ file, text, mode: 'plain', maxMs: 2000 })
    let torn = 0
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      try { JSON.parse(readFileSync(file, 'utf8')) } catch { torn += 1 }
    }
    assert.notEqual(plain.pid, process.pid)
    assert.ok(torn > 0, 'plain writer must produce an unparseable or empty read')
    await plain.stop(); plain = null
    rmSync(`${file}.stop`, { force: true })

    writeFileSync(file, text.replace('"%N%"', '"seed"'))
    atomic = await startFileWriter({ file, text, mode: 'atomic', maxMs: 2000 })
    const contents = new Set()
    const atomicDeadline = Date.now() + 500
    while (Date.now() < atomicDeadline) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      contents.add(JSON.stringify(parsed.version))
    }
    assert.ok(contents.size >= 2, 'atomic writer must publish at least two distinct contents')
    await atomic.stop(); atomic = null
  } finally {
    if (plain) await plain.stop()
    if (atomic) await atomic.stop()
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('T2 owner publishes through a rename and never targets crew.json with writeFileSync', () => {
  const paths = durabilityPaths('t2')
  const file = join(paths.dir, 'crew.json')
  writeFileSync(file, JSON.stringify(durabilityDocument(), null, 2))
  const before = statSync(file).ino
  const targets = []; let n = 0
  try {
    const result = updateCrewJson(paths, (disk) => { disk.owner_marker = true; return true }, {
      uuid: () => `t2-${++n}`,
      writeFileSync: (path, data, options) => { targets.push(String(path)); return writeFileSync(path, data, options) },
    })
    assert.equal(result.ok, true)
    assert.notEqual(statSync(file).ino, before)
    assert.equal(targets.includes(file), false)
    assert.ok(targets.some((path) => path.includes('crew.json.tmp.')))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).owner_marker, true)
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T3 an atomic foreign writer cannot tear the locked owner', async () => {
  const paths = durabilityPaths('t3')
  const file = join(paths.dir, 'crew.json')
  const text = JSON.stringify({ ...durabilityDocument(), version: '%N%' })
  writeFileSync(file, text.replace('"%N%"', '"seed"'))
  let writer = null; let n = 0
  try {
    writer = await startFileWriter({ file, text, mode: 'atomic', maxMs: 2000 })
    for (let i = 0; i < 12; i += 1) {
      const result = updateCrewJson(paths, (disk) => { disk.owner_updates = (disk.owner_updates || 0) + 1; return true }, { uuid: () => `t3-${++n}` })
      assert.equal(result.ok, true)
      assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
    }
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
  } finally {
    if (writer) await writer.stop()
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('T4 owner RMW preserves a reseat and the seat delta from a stale copy', () => {
  const paths = durabilityPaths('t4')
  const file = join(paths.dir, 'crew.json')
  try {
    writeFileSync(file, JSON.stringify(durabilityDocument(), null, 2))
    const result = updateCrewJson(paths, (disk) => {
      disk.members.reviewer.model = 'reseated-model'
      disk.reseated = { role: 'reviewer' }
      return true
    })
    assert.equal(result.ok, true)
    const persist = updateCrewJson(paths, (disk) => {
      disk.members.builder.session_id = 'stale-seat-session'
      return true
    })
    assert.equal(persist.ok, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.members.reviewer.model, 'reseated-model')
    assert.deepEqual(after.reseated, { role: 'reviewer' })
    assert.equal(after.members.builder.session_id, 'stale-seat-session')
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T5 owner fails closed for absent and unparseable crew.json', () => {
  const absent = durabilityPaths('t5-absent')
  try {
    const result = updateCrewJson(absent, (disk) => { disk.created = true; return true })
    assert.deepEqual(result, { ok: false, reason: 'absent' })
    assert.equal(existsSync(join(absent.dir, 'crew.json')), false)
  } finally { rmSync(absent.dir, { recursive: true, force: true }) }
  const unreadable = durabilityPaths('t5-unreadable')
  const file = join(unreadable.dir, 'crew.json')
  const bytes = '{"broken":'
  try {
    writeFileSync(file, bytes)
    const result = updateCrewJson(unreadable, (disk) => { disk.changed = true; return true })
    assert.deepEqual(result, { ok: false, reason: 'unreadable' })
    assert.equal(readFileSync(file, 'utf8'), bytes)
  } finally { rmSync(unreadable.dir, { recursive: true, force: true }) }
})

test('T6 headless transport persists its own deltas without erasing a disk reseat', () => {
  const paths = durabilityPaths('t6')
  const file = join(paths.dir, 'crew.json')
  const crew = { ...durabilityDocument(), checkout: paths.dir }
  const disk = durabilityDocument()
  disk.members.reviewer.model = 'operator-reseated-model'; disk.reseated = { role: 'reviewer' }
  writeFileSync(file, JSON.stringify(disk, null, 2))
  let n = 0
  try {
    const io = headlessIo({
      crew, paths, taskDir: paths.taskDir, checkout: paths.dir,
      adapters: { reviewer: { headlessCommand: (spec) => ({ bin: '/bin/worker', args: [spec.model] }) } }, bin: '/bin/worker',
      deps: { spawn: () => ({ pid: 7001, unref() {} }), uuid: () => `t6-${++n}`, now: () => 0, sleep: () => {}, pid: 7000, log() {} },
    })
    io.assign({ role: 'reviewer', briefFile: join(paths.taskDir, 'brief.md') })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.members.reviewer.model, 'operator-reseated-model')
    assert.deepEqual(after.reseated, { role: 'reviewer' })
    assert.match(after.members.reviewer.session_id, /^t6-/)
    assert.equal(after.members.reviewer.started, true)
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T7 headless transport journals a failed crew.json persist', () => {
  const paths = durabilityPaths('t7')
  const file = join(paths.dir, 'crew.json')
  const crew = { ...durabilityDocument(), checkout: paths.dir }
  writeFileSync(file, JSON.stringify(crew, null, 2))
  const events = []; let n = 0
  try {
    const io = headlessIo({
      crew, paths, taskDir: paths.taskDir, checkout: paths.dir,
      adapters: { reviewer: { headlessCommand: () => ({ bin: '/bin/worker', args: [] }) } }, bin: '/bin/worker',
      deps: {
        spawn: () => ({ pid: 7011, unref() {} }), uuid: () => `t7-${++n}`, now: () => 0, sleep: () => {}, pid: 7010,
        log: (event) => events.push(event), writeFileSync: (path, data, options) => {
          if (String(path).includes('crew.json.tmp.')) throw new Error('simulated crew.json write failure')
          return writeFileSync(path, data, options)
        },
      },
    })
    io.assign({ role: 'reviewer', briefFile: join(paths.taskDir, 'brief.md') })
    const failures = events.filter((event) => event.event === 'crew-json-persist-failed')
    assert.ok(failures.length >= 1)
    assert.ok(failures.every((event) => event.role === 'reviewer' && event.reason === 'write-failed'))
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})
