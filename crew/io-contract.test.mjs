// Gate-facing shared contract: the same behavioral assertions run against both io subjects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, unlinkSync as fsUnlinkSync, renameSync as fsRenameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitAdapter, realIo } from './realio.mjs'
import { headlessIo } from './headless.mjs'
import { headlessRpcIo } from './headless-rpc.mjs'
import { WAIT_POLL_MS } from './realio.mjs'
import { assignmentLine } from './driver.mjs'

const REQUIRED = ['assign', 'wait', 'writeFile', 'readFile', 'run', 'changedFiles', 'commit', 'log', 'now']
const OPTIONAL = ['runClean', 'status', 'showDoc', 'emit']
const FAULT = process.env.CREW_IO_CONTRACT_FAULT || ''

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'crew-io-contract-'))
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  return paths
}

function makeRealIo() {
  const paths = dirs()
  let clock = 0
  let resultPath = null
  let polls = 0
  let dirtyMode = false
  let popFailure = false
  const sent = []
  const added = []
  const commands = []
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
    locate: (_tree, id) => id === 'surface-builder',
    sendLine: (surface, line) => sent.push({ surface, line }),
    assignmentLine,
    logLine: (_path, obj) => commands.push({ kind: 'log', obj }),
    cmux: (verb) => { if (verb === 'markdown') throw new Error('cmux unavailable'); return { ok: true } },
    closeSurface: () => {},
    existsSync: (path) => {
      if (path === resultPath) {
        polls += 1
        return FAULT === 'wait-poll' ? polls >= 8 : true
      }
      return fsExistsSync(path)
    },
    readFileSync: (path, ...args) => {
      if (path === resultPath && (FAULT !== 'wait-poll' || polls >= 8)) return JSON.stringify({ status: 'done', subject: 'realIo' })
      return fsReadFileSync(path, ...args)
    },
    writeFileSync: fsWriteFileSync,
    unlinkSync: fsUnlinkSync,
    renameSync: fsRenameSync,
    execSync: (cmd, opts) => {
      if (cmd.includes('status --porcelain -uall -z')) {
        if (FAULT === 'changed-parse') return 'foo\0'
        return ' M changed.txt\0R  renamed.txt\0old.txt\0'
      }
      if (cmd.includes('status --porcelain')) return dirtyMode ? ' M dirty.txt' : ''
      return ''
    },
    execFileSync: (cmd, argv, opts) => {
      if (argv[0] === 'add') { if (FAULT !== 'commit-add') added.push(...argv.slice(2)); return '' }
      if (argv[0] === 'rev-parse') return 'abc123\n'
      commands.push({ kind: 'exec', cmd, argv, opts }); return ''
    },
    spawnSync: (cmd, argv) => {
      commands.push({ kind: 'spawn', argv })
      if (cmd === 'git' && argv?.[0] === 'stash' && argv?.[1] === 'pop' && popFailure) return { status: 1, stdout: '', stderr: 'pop failed' }
      if (argv?.[0] === '-c') {
        const command = argv[1]
        if (command === 'fail') return { status: 3, stdout: 'bad\n', stderr: 'err\n' }
        if (command === 'signal') return { status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: new Error('timeout') }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
  if (FAULT === 'assign-send') deps.sendLine = () => {}
  if (FAULT === 'assign-surface') deps.sendLine = (surface, line) => sent.push({ surface: 'wrong-surface', line })
  const crew = { workspace_id: 'ws', window_id: 'win', members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }
  const io = realIo(crew, paths, paths.dir, null, null, {}, deps)
  return { io, paths, sent, added, commands, clock: () => clock, setResult: (p) => { resultPath = p }, setDirty: (v) => { dirtyMode = v }, setPopFailure: (v) => { popFailure = v }, assignmentPolls: () => polls }
}

function makeHeadlessIo() {
  const paths = dirs()
  let clock = 0
  let resultPath = null
  let polls = 0
  const commands = []
  const baseExists = fsExistsSync
  const baseRead = fsReadFileSync
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    pid: 777,
    uuid: () => 'session-1',
    spawn: (_bin, argv) => { commands.push({ kind: 'spawn', argv }); return { pid: 888, unref() {} } },
    existsSync: (path) => {
      if (path === resultPath) { polls += 1; return FAULT === 'wait-poll' ? polls >= 8 : true }
      return baseExists(path)
    },
    readFileSync: (path, ...args) => {
      if (path === resultPath && (FAULT !== 'wait-poll' || polls >= 8)) return JSON.stringify({ status: 'done', subject: 'headlessIo' })
      return baseRead(path, ...args)
    },
    writeFileSync: fsWriteFileSync,
    unlinkSync: fsUnlinkSync,
    mkdirSync,
    readdirSync,
    log: () => {},
  }
  const adapter = { headlessCommand: (spec) => { commands.push({ kind: 'command', spec }); return { bin: '/bin/worker', args: [] } } }
  const crew = { members: { builder: { model: 'model', transport: 'headless-json' } } }
  const io = headlessIo({ crew, paths, taskDir: paths.taskDir, checkout: paths.dir, adapters: { builder: adapter }, bin: '/bin/worker', deps })
  return { io, paths, commands, clock: () => clock, setResult: (p) => { resultPath = p }, assignmentPolls: () => polls }
}

function makeHeadlessRpcIo() {
  const paths = dirs()
  let clock = 0
  let resultPath = null
  let polls = 0
  const commands = []
  const baseExists = fsExistsSync
  const baseRead = fsReadFileSync
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    pid: 777,
    uuid: () => 'session-rpc-1',
    spawn: (_bin, argv) => { commands.push({ kind: 'spawn', argv }); return { pid: 889, unref() {} } },
    openSync: () => 19,
    writeSync: (_fd, line) => { commands.push({ kind: 'write', line }) },
    closeSync: () => {},
    existsSync: (path) => {
      if (path === resultPath) { polls += 1; return FAULT === 'wait-poll' ? polls >= 8 : true }
      if (String(path).endsWith('/cmd.fifo')) return true
      return baseExists(path)
    },
    readFileSync: (path, ...args) => {
      if (path === resultPath && (FAULT !== 'wait-poll' || polls >= 8)) return JSON.stringify({ status: 'done', subject: 'headlessRpcIo' })
      return baseRead(path, ...args)
    },
    writeFileSync: fsWriteFileSync,
    unlinkSync: fsUnlinkSync,
    mkdirSync,
    readdirSync,
    log: () => {},
  }
  const crew = { members: { builder: { model: 'model', transport: 'headless-rpc' } } }
  const io = headlessRpcIo({ crew, paths, taskDir: paths.taskDir, checkout: paths.dir, adapters: { builder: {} }, bin: '/bin/pi', deps })
  return { io, paths, commands, clock: () => clock, setResult: (p) => { resultPath = p }, assignmentPolls: () => polls }
}

const SUBJECTS = [
  { name: 'realIo', methods: [...REQUIRED, ...OPTIONAL], make: makeRealIo },
  { name: 'headlessIo', methods: ['assign', 'wait'], make: makeHeadlessIo },
  { name: 'headlessRpcIo', methods: ['assign', 'wait'], make: makeHeadlessRpcIo },
]

for (const subject of SUBJECTS) {
  test(`${subject.name} satisfies the declared io shape`, () => {
    const fixture = subject.make()
    for (const name of REQUIRED) if (subject.methods.includes(name)) assert.equal(typeof fixture.io[name], 'function', `${subject.name}.${name}`)
    for (const name of OPTIONAL) assert.ok(fixture.io[name] === undefined || typeof fixture.io[name] === 'function', `${subject.name}.${name}`)
  })

  test(`${subject.name} assign composes and delivers its assignment`, () => {
    const fixture = subject.make()
    const briefFile = join(fixture.paths.taskDir, 'brief.md')
    const out = fixture.io.assign({ role: 'builder', briefFile })
    assert.equal(typeof out.id, 'string')
    assert.ok(out.returnPath.startsWith(fixture.paths.returnsDir + '/'))
    if (subject.name === 'realIo') {
      assert.equal(fixture.sent.length, 1)
      assert.equal(fixture.sent[0].surface, 'surface-builder')
      for (const value of [briefFile, out.id, 'builder', out.returnPath]) assert.ok(fixture.sent[0].line.includes(value))
      fixture.setResult(out.returnPath)
    } else if (subject.name === 'headlessIo') {
      const command = fixture.commands.find((x) => x.kind === 'command').spec
      for (const value of [briefFile, out.id, 'builder', out.returnPath]) assert.ok(command.prompt.includes(value))
      fixture.setResult(out.returnPath)
    } else {
      const command = fixture.commands.find((x) => x.kind === 'write' && JSON.parse(x.line).type === 'prompt')
      for (const value of [briefFile, out.id, 'builder', out.returnPath]) assert.ok(JSON.parse(command.line).message.includes(value))
      fixture.setResult(out.returnPath)
    }
  })

  test(`${subject.name} rejects an unseated role`, () => {
    const fixture = subject.make()
    assert.throws(() => fixture.io.assign({ role: 'nobody' }), /role nobody not seated in this crew/)
  })

  test(`${subject.name} wait polls on the injected clock`, () => {
    const fixture = subject.make()
    const out = fixture.io.assign({ role: 'builder', briefFile: '/brief.md' })
    fixture.setResult(out.returnPath)
    assert.deepEqual(fixture.io.wait(out.returnPath, 600), { status: 'done', subject: subject.name })
  })
}

test('realIo removes stale return files and round-trips files', () => {
  const f = makeRealIo()
  const stale = join(f.paths.returnsDir, 'd1.builder.json')
  fsWriteFileSync(stale, 'stale')
  const out = f.io.assign({ role: 'builder', briefFile: '/brief.md' })
  assert.equal(out.returnPath, stale)
  assert.equal(fsExistsSync(stale), false)
  f.io.writeFile(join(f.paths.taskDir, 'x'), 'content')
  assert.equal(f.io.readFile(join(f.paths.taskDir, 'x')), 'content')
  assert.equal(f.io.readFile(join(f.paths.taskDir, 'missing')), null)
})

test('realIo run reports status, spawn errors, and signals', () => {
  const f = makeRealIo()
  assert.deepEqual(f.io.run('ok'), { ok: true, output: '' })
  assert.equal(f.io.run('fail').ok, false)
  assert.match(f.io.run('signal').output, /spawn error|killed by SIGTERM/)
})

test('realIo runClean skips stash on a clean tree and restores dirty work on command failure', () => {
  const f = makeRealIo()
  f.io.runClean.call(f.io, 'ok')
  assert.deepEqual(f.commands.filter((x) => x.kind === 'spawn').map((x) => x.argv), [['-c', 'ok']])

  f.setDirty(true)
  const originalRun = f.io.run
  f.io.run = () => { throw new Error('command failed') }
  assert.throws(() => f.io.runClean.call(f.io, 'boom'), /command failed/)
  const stash = f.commands.filter((x) => x.kind === 'spawn' && x.argv?.[0] === 'stash').map((x) => ['git', ...(x.argv || [])].join(' '))
  assert.deepEqual(stash, ['git stash push --include-untracked -m crew:runClean', 'git stash pop'])
  f.io.run = originalRun
})

test('realIo runClean throws when restoring the stash fails', () => {
  const f = makeRealIo()
  f.setDirty(true)
  f.setPopFailure(true)
  assert.throws(() => f.io.runClean.call(f.io, 'ok'), /stash pop FAILED/)
})

test('realIo changedFiles parses NUL porcelain and both rename paths', () => {
  const f = makeRealIo()
  assert.deepEqual(f.io.changedFiles(), ['changed.txt', 'renamed.txt', 'old.txt'])
})

test('realIo commit stages changed files and returns the short hash', () => {
  const f = makeRealIo()
  assert.equal(f.io.commit(['changed.txt', 'not-present.txt'], 'message'), 'abc123')
  assert.deepEqual(f.added, ['changed.txt'])
  assert.throws(() => f.io.commit(['not-present.txt'], 'message'), /refusing an empty commit/)
})

test('realIo log, now, status, and showDoc use injected effects best-effort', () => {
  const f = makeRealIo()
  assert.equal(f.io.now(), 0)
  f.io.log({ event: 'test' })
  assert.doesNotThrow(() => f.io.status('build'))
  assert.doesNotThrow(() => f.io.showDoc('/plan.md'))
  assert.ok(f.commands.some((x) => x.kind === 'log'))
})

test('realIo delegates headless transport through the injected headless factory', () => {
  const f = makeRealIo()
  const delegated = { assign: () => ({ id: 'h1', returnPath: '/tmp/h1' }), wait: () => ({ status: 'done' }) }
  const crew = { members: { builder: { transport: 'headless-json' } } }
  const io = realIo(crew, f.paths, f.paths.dir, null, null, {}, { headlessIo: () => delegated, resolveWorkerBin: () => '/bin/worker' })
  assert.deepEqual(io.assign({ role: 'builder' }), { id: 'h1', returnPath: '/tmp/h1' })
  assert.deepEqual(io.wait('/tmp/h1', 1), { status: 'done' })
})

test('realIo gives headless-rpc pi rather than the claude worker binary', () => {
  const f = makeRealIo(); let args = null
  const delegated = { assign: () => ({ id: 'r1', returnPath: '/tmp/r1' }), wait: () => ({ status: 'done' }) }
  const crew = { members: { builder: { transport: 'headless-rpc' } } }
  const io = realIo(crew, f.paths, f.paths.dir, null, null, {}, {
    headlessRpcIo: (received) => { args = received; return delegated },
    resolveWorkerBin: () => { throw new Error('RPC must not resolve claude-bin') },
  })
  assert.deepEqual(io.assign({ role: 'builder' }), { id: 'r1', returnPath: '/tmp/r1' })
  assert.equal(args.bin, 'pi')
})

test('outer realIo keeps runClean available for headless-json and headless-rpc seats', () => {
  const f = makeRealIo()
  const executed = []
  for (const [transport, factory] of [
    ['headless-json', 'headlessIo'],
    ['headless-rpc', 'headlessRpcIo'],
  ]) {
    const io = realIo(
      { members: { builder: { transport } } }, f.paths, f.paths.dir, null, null, {},
      {
        [factory]: () => ({ assign() {}, wait() {} }),
        execSync: () => '',
        spawnSync: (_bin, argv) => { executed.push(argv); return { status: 0, stdout: '', stderr: '' } },
      },
    )
    assert.equal(typeof io.runClean, 'function')
    assert.deepEqual(io.runClean.call(io, 'outer-realio-run'), { ok: true, output: '' })
  }
  assert.deepEqual(executed, [['-c', 'outer-realio-run'], ['-c', 'outer-realio-run']])
})

test('emitAdapter writes usage measurements to agent_sessions with explicit null context fields', () => {
  const starts = []; const ends = []
  const emitter = {
    adwId: 'adw-usage',
    emit: (fn) => fn({
      startAgentSession: (row) => starts.push(row),
      endAgentSession: (row) => ends.push(row),
    }),
  }
  emitAdapter(emitter)({
    kind: 'usage', id: 'd1', role: 'builder', model: 'sonnet', session_id: 's1', transcript_path: '/tmp/stream',
    usage: { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 4 },
  })
  assert.equal(starts.length, 1); assert.equal(ends.length, 1)
  assert.deepEqual(ends[0], {
    adw_id: 'adw-usage', claude_session_id: 's1',
    context_tokens: null, context_window: null, raw_read_tokens: null, raw_written_tokens: null,
    billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 4,
  })
})

test('emitAdapter writes the running total for repeated usage on one worker session', () => {
  const ends = []
  const emitter = {
    adwId: 'adw-total',
    emit: (fn) => fn({ startAgentSession() {}, endAgentSession: (row) => ends.push(row) }),
  }
  const adapter = emitAdapter(emitter)
  const base = { kind: 'usage', role: 'builder', model: 'sonnet', session_id: 's1', transcript_path: '/tmp/stream' }
  adapter({ ...base, id: 'd1', usage: { billed_input_tokens: 10, billed_output_tokens: 20, billed_cache_write_tokens: 30, billed_cache_read_tokens: 40 } })
  adapter({ ...base, id: 'd2', usage: { billed_input_tokens: 1, billed_output_tokens: 2, billed_cache_write_tokens: 3, billed_cache_read_tokens: 4 } })
  assert.deepEqual(ends.map((row) => [row.billed_input_tokens, row.billed_output_tokens, row.billed_cache_write_tokens, row.billed_cache_read_tokens]), [[10, 20, 30, 40], [11, 22, 33, 44]])
})

test('emitAdapter leaves billed columns NULL when usage is unmeasured', () => {
  const starts = []; const ends = []
  const emitter = {
    adwId: 'adw-null',
    emit: (fn) => fn({ startAgentSession: (row) => starts.push(row), endAgentSession: (row) => ends.push(row) }),
  }
  emitAdapter(emitter)({ kind: 'usage', id: 'd1', role: 'builder', model: null, session_id: 's1', transcript_path: null, usage: null })
  assert.equal(starts.length, 1); assert.equal(ends.length, 0)
  assert.equal(starts[0].billed_input_tokens, undefined)
})

test('realIo passes a guarded transport emitter that routes through io.emit', () => {
  const paths = dirs(); let received; const starts = []
  const emitter = {
    adwId: 'adw-route',
    emit: (fn) => fn({ startAgentSession: (row) => starts.push(row), endAgentSession() {} }),
  }
  const transport = { assign: () => ({ id: 'd1', returnPath: '/tmp/d1' }), wait: () => ({ status: 'done' }) }
  const crew = { members: { builder: { model: 'sonnet', transport: 'headless-json' } } }
  const io = realIo(crew, paths, paths.dir, emitter, null, {}, {
    headlessIo: (args) => { received = args; return transport }, resolveWorkerBin: () => '/bin/worker',
  })
  io.assign({ role: 'builder', briefFile: '/brief.md' })
  assert.equal(typeof received.deps.emit, 'function')
  received.deps.emit({ kind: 'usage', id: 'd1', role: 'builder', model: 'sonnet', session_id: 's1', transcript_path: '/tmp/s', usage: null })
  assert.equal(starts.length, 1)
  io.emit = () => { throw new Error('ledger down') }
  assert.doesNotThrow(() => received.deps.emit({ kind: 'usage', usage: null }))
})
