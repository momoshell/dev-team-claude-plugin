import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cellFailureKind, emitAdapter, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, providerConditionDetail,
  readEnvelopeFile, samplePaneScreen, seatIo, WAIT_POLL_MS, waitForEnvelope,
} from './seat-io.mjs'
import { recogniseProviderCondition } from './headless.mjs'

const CONTENT = Object.freeze({
  committed: 'committed tracked content\n',
  dirty: 'dirty tracked content\n',
  untracked: 'untracked content\n',
  ignored: 'ignored secret content\n',
  node: 'node package content\n',
})

function git(repoDir, ...args) {
  return execFileSync('git', [
    '-c', 'user.email=crew@example.invalid',
    '-c', 'user.name=Crew Test',
    '-C', repoDir, ...args,
  ], { encoding: 'utf8' })
}

function makeRepo({ dirty = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-run-clean-'))
  const repoDir = join(root, 'repo')
  mkdirSync(repoDir)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir)
  mkdirSync(paths.returnsDir)

  git(repoDir, 'init')
  writeFileSync(join(repoDir, '.gitignore'), 'ignored/\nnode_modules/\n')
  writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.committed)
  git(repoDir, 'add', '.gitignore', 'tracked.txt')
  git(repoDir, 'commit', '-m', 'initial')

  if (dirty) {
    writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.dirty)
    writeFileSync(join(repoDir, 'untracked.txt'), CONTENT.untracked)
    mkdirSync(join(repoDir, 'ignored'))
    writeFileSync(join(repoDir, 'ignored', 'secret.txt'), CONTENT.ignored)
    mkdirSync(join(repoDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), CONTENT.node)
  }

  return { root, repoDir, paths }
}

function makeIo({ repoDir, paths }) {
  return seatIo({ members: {} }, paths, repoDir, null, null, {}, {})
}

function restored(fixture) {
  const { repoDir } = fixture
  assert.equal(readFileSync(join(repoDir, 'tracked.txt'), 'utf8'), CONTENT.dirty)
  assert.equal(readFileSync(join(repoDir, 'untracked.txt'), 'utf8'), CONTENT.untracked)
  assert.equal(readFileSync(join(repoDir, 'ignored', 'secret.txt'), 'utf8'), CONTENT.ignored)
  assert.equal(readFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), 'utf8'), CONTENT.node)
  assert.equal(git(repoDir, 'stash', 'list').trim(), '')
}

function withRepo(options, fn) {
  const fixture = makeRepo(options)
  try {
    return fn(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

const treeCommand = [
  'git status --porcelain -uall',
  "printf 'TRACKED\\n'; cat tracked.txt",
  "printf 'UNTRACKED\\n'; if [ -e untracked.txt ]; then cat untracked.txt; else printf '<absent>\\n'; fi",
  "printf 'IGNORED\\n'; cat ignored/secret.txt",
  "printf 'NODE_MODULE\\n'; cat node_modules/pkg/index.js",
].join('; ')

test('runClean shows committed tracked work while ignored paths stay visible', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean(treeCommand)
    assert.equal(result.ok, true)
    assert.match(result.output, /TRACKED\ncommitted tracked content\n/)
    assert.match(result.output, /UNTRACKED\n<absent>/)
    assert.match(result.output, /IGNORED\nignored secret content\n/)
    assert.match(result.output, /NODE_MODULE\nnode package content\n/)
    assert.doesNotMatch(result.output, /untracked content/)
  })
})

test('runClean restores tracked, untracked, ignored, and node_modules work with no stash left', () => {
  withRepo({}, (fixture) => {
    makeIo(fixture).runClean('printf clean')
    restored(fixture)
    assert.equal(existsSync(join(fixture.repoDir, 'untracked.txt')), true)
  })
})

test('runClean on a clean tree runs without creating a stash entry', () => {
  withRepo({ dirty: false }, (fixture) => {
    const io = makeIo(fixture)
    const result = io.runClean('printf clean-tree')
    assert.deepEqual(result, { ok: true, output: 'clean-tree' })
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
  })
})

test('runClean restores the tree when the command throws', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    io.run = () => { throw new Error('command failed') }
    assert.throws(() => io.runClean('boom'), /command failed/)
    restored(fixture)
  })
})

test('runClean preserves a non-zero command result and still restores the tree', () => {
  withRepo({}, (fixture) => {
    const result = makeIo(fixture).runClean("printf 'command output'; exit 7")
    assert.equal(result.ok, false)
    assert.equal(result.output, 'command output')
    restored(fixture)
  })
})

test('seatIo teardown is a measured zero when no transport was instantiated', () => {
  withRepo({ dirty: false }, (fixture) => {
    assert.deepEqual(makeIo(fixture).teardown(), [])
  })
})

test('run keeps a nested node test summary parseable under FORCE_COLOR', () => {
  const saved = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  try {
    withRepo({ dirty: false }, (fixture) => {
      writeFileSync(join(fixture.repoDir, 'sample.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('sample', () => { assert.equal(1, 1) })\n")
      const io = makeIo(fixture)
      const result = io.run(`env -u NODE_TEST_CONTEXT ${process.execPath} --test sample.test.mjs`)
      assert.equal(result.output.includes('\x1b'), false)
      const match = /^\s*(?:ℹ|#)?\s*pass (\d+)/m.exec(result.output)
      assert.equal(match?.[1], '1')
      assert.equal(result.ok, true)
    })
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = saved
  }
})

test('samplePaneScreen asks for scrollback and sees through colour and box rules', () => {
  const calls = []
  const frame = '╭──╮\n│ \x1b[31mrate\x1b[0m│limit exceeded │\n╰──╯\n'
  const condition = samplePaneScreen('surface-builder', {
    cmux: (verb, args, options) => {
      calls.push({ verb, args: [...args], options })
      return { ok: true, stdout: frame }
    },
  })
  assert.equal(condition, 'rate-limit')
  assert.equal(recogniseProviderCondition(frame), null)
  assert.deepEqual(calls, [{
    verb: 'read-screen',
    args: ['--surface', 'surface-builder', '--scrollback', '--lines', '200'],
    options: { timeoutMs: 5000 },
  }])
})

test('a failed, empty or throwing screen read records nothing', () => {
  assert.equal(samplePaneScreen('surface-builder', {
    cmux: () => ({ ok: false, stdout: 'API Error 529 overloaded' }),
  }), null)
  assert.equal(samplePaneScreen('surface-builder', {
    cmux: () => ({ ok: true, stdout: '' }),
  }), null)
  assert.equal(samplePaneScreen('surface-builder', {
    cmux: () => { throw new Error('read-screen failed') },
  }), null)

  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    const journal = []
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      cmux: () => ({ ok: false, stdout: 'API Error 529 overloaded' }),
      logLine: (_path, row) => journal.push(row),
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: () => false,
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(io.wait(assignment.returnPath, 35), null)
    assert.equal(journal.some((row) => row.event === 'pane-provider-sample'), false)
  })
})

test('waitForEnvelope sampling cannot change liveness decisions', () => {
  const aliveRun = (sampleSeat) => {
    let clock = 0
    let probes = 0
    const outcomes = [true, null, false, true]
    const aliveAt = []
    const envelope = waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
      readEnvelope: () => (probes >= outcomes.length ? { status: 'done' } : null),
      probeSeat: () => outcomes[probes++], sampleSeat,
      onAlive: (at) => aliveAt.push(at), now: () => clock,
      sleep: (ms) => { clock += ms },
    })
    return { envelope, aliveAt }
  }
  const deadRun = (sampleSeat) => {
    let clock = 0
    let error
    try {
      waitForEnvelope({
        returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
        readEnvelope: () => null, probeSeat: () => false, sampleSeat,
        now: () => clock, sleep: (ms) => { clock += ms },
      })
    } catch (err) { error = err }
    return { stage: error?.stage, role: error?.role, message: error?.message }
  }
  const base = aliveRun(undefined)
  assert.deepEqual(aliveRun(() => 'overloaded'), base)
  assert.deepEqual(aliveRun(() => { throw new Error('sample failed') }), base)
  const deadBase = deadRun(undefined)
  assert.deepEqual(deadRun(() => 'overloaded'), deadBase)
  assert.deepEqual(deadRun(() => { throw new Error('sample failed') }), deadBase)
  assert.equal(LIVENESS_PROBE_MS, 30_000)
  assert.equal(LIVENESS_MISSES_TO_DIE, 2)
})

test('waitForEnvelope calls onAlive only for observed alive probes with their timestamps', () => {
  let clock = 0
  let probes = 0
  const outcomes = [true, null, false, true]
  const aliveAt = []
  const envelope = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
    readEnvelope: () => (probes >= outcomes.length ? { status: 'done' } : null),
    probeSeat: () => outcomes[probes++],
    onAlive: (at) => aliveAt.push(at),
    now: () => clock,
    sleep: (ms) => { clock += ms },
  })
  assert.deepEqual(envelope, { status: 'done' })
  assert.deepEqual(aliveAt, [LIVENESS_PROBE_MS, LIVENESS_PROBE_MS * 4])
})

test('waitForEnvelope keeps seat-died accounting unchanged and never stamps missed probes', () => {
  let clock = 0
  const aliveAt = []
  let error
  try {
    waitForEnvelope({
      returnPath: '/tmp/return.json', timeoutS: 1200, role: 'builder',
      readEnvelope: () => null,
      probeSeat: () => false,
      onAlive: (at) => aliveAt.push(at),
      now: () => clock,
      sleep: (ms) => { clock += ms },
    })
  } catch (err) {
    error = err
  }
  assert.ok(error)
  assert.equal(error.stage, 'seat-died')
  assert.equal(error.role, 'builder')
  assert.equal(error.message, `seat died: builder — its pane is gone (${LIVENESS_MISSES_TO_DIE} consecutive liveness probes) and no envelope arrived at /tmp/return.json`)
  assert.deepEqual(aliveAt, [])
})

test('emitAdapter maps only finite heartbeat timestamps to the session writer', () => {
  const calls = []
  const emitter = {
    adwId: 'adw-heartbeat',
    emit: (fn) => fn({ heartbeat: (row) => calls.push(row) }),
  }
  const adapter = emitAdapter(emitter)
  adapter({ kind: 'heartbeat', at: 12345 })
  for (const at of [undefined, null, '12345', Infinity, NaN]) adapter({ kind: 'heartbeat', at })
  assert.deepEqual(calls, [{ adw_id: 'adw-heartbeat', target: 'session', at: 12345 }])
})

test('seatIo stamps a pane heartbeat from the probe timestamp before the envelope arrives', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
    const heartbeats = []
    const emitter = {
      adwId: 'adw-pane',
      emit: (fn) => fn({ heartbeat: (row) => heartbeats.push(row) }),
    }
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, emitter, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? clock > LIVENESS_PROBE_MS : existsSync(path),
      readFileSync: (path, ...args) => path === returnPath ? JSON.stringify(envelope) : readFileSync(path, ...args),
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    assert.deepEqual(io.wait(returnPath, 600), envelope)
    assert.deepEqual(heartbeats, [{ adw_id: 'adw-pane', target: 'session', at: LIVENESS_PROBE_MS }])
  })
})

test('a recognised provider condition lands in the cell-failure detail with role, transport and model', () => {
  withRepo({ dirty: false }, (fixture) => {
    const events = []
    const crew = {
      task: 'b70-provider', claude_bin: '/worker/bin',
      members: { builder: {
        agent: 'claude', provider: 'anthropic', id: 'model-id', model: 'sonnet', effort: 'high', transport: 'headless-json',
      } },
    }
    const failure = Object.assign(new Error('headless no-envelope: provider did not answer'), {
      stage: 'headless-no-envelope', providerCondition: 'overloaded',
    })
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      headlessIo: () => ({
        assign: () => ({ id: 'd1', returnPath: join(fixture.paths.returnsDir, 'd1.builder.json') }),
        wait: () => { throw failure },
      }),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => io.wait(assignment.returnPath, 1), (err) => {
      assert.equal(err.stage, 'headless-no-envelope')
      return true
    })
    const event = events.find((candidate) => candidate.kind === 'cell-failure')
    assert.ok(event)
    assert.equal(event.failure, 'no-envelope')
    assert.equal(event.stage, 'headless-no-envelope')
    assert.match(event.detail, /^\[provider:overloaded\] /)

    const rows = []
    const adapter = emitAdapter({
      adwId: 'adw-provider',
      emit: (fn) => fn({ recordCellFailure: (row) => rows.push(row) }),
    }, crew)
    adapter(event)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].transport, 'headless-json')
    assert.equal(rows[0].model, 'sonnet')
    assert.equal(rows[0].detail, event.detail)
  })
})

test('a sampled condition lands on the seat failure with SAMPLED evidence', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    const events = []
    const journal = []
    const crew = {
      task: 'b73-pane',
      members: { builder: {
        agent: 'claude', provider: 'anthropic', id: 'model-id', model: 'sonnet', transport: 'pane',
        surface_id: 'surface-builder',
      } },
    }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      cmux: () => ({ ok: true, stdout: 'API Error 529 overloaded' }),
      logLine: (_path, row) => journal.push(row),
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: () => false,
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(io.wait(assignment.returnPath, 35), null)
    const event = events.find((candidate) => candidate.kind === 'cell-failure')
    assert.ok(event)
    assert.match(event.detail, /^\[provider-sampled:overloaded\] /)
    assert.equal(journal.filter((row) => row.event === 'pane-provider-sample').length, 1)

    const rows = []
    const adapter = emitAdapter({
      adwId: 'adw-pane-provider',
      emit: (fn) => fn({ recordCellFailure: (row) => rows.push(row) }),
    }, crew)
    adapter(event)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, 'builder')
    assert.equal(rows[0].transport, 'pane')
    assert.equal(rows[0].model, 'sonnet')
    assert.equal(rows[0].detail, event.detail)

    assert.match(providerConditionDetail({ message: 'captured', providerCondition: 'overloaded' }), /^\[provider:overloaded\] /)
    assert.equal(providerConditionDetail({ message: 'transport failure' }), 'transport failure')
  })
})

test('nothing branches on a sampled condition', () => {
  const run = (stdout) => withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    const events = []
    const thrown = new Error('driver transport failure')
    const crew = { members: { builder: { model: 'sonnet', transport: 'pane', surface_id: 'surface-builder' } } }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      cmux: () => ({ ok: true, stdout }),
      now: () => clock,
      sleep: (ms) => {
        clock += ms
        if (clock > LIVENESS_PROBE_MS) throw thrown
      },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: () => false,
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => io.wait(assignment.returnPath, 35), (err) => {
      assert.equal(err, thrown)
      return true
    })
    return { event: events.find((event) => event.kind === 'cell-failure'), thrown }
  })

  const sampled = run('API Error 529 overloaded')
  const clean = run('nothing interesting here')
  assert.deepEqual(
    [sampled.event.failure, sampled.event.stage, cellFailureKind(sampled.thrown), sampled.thrown.message],
    [clean.event.failure, clean.event.stage, cellFailureKind(clean.thrown), clean.thrown.message],
  )
  assert.notEqual(sampled.event.detail, clean.event.detail)
  for (const condition of ['not-a-condition', '__proto__']) {
    assert.equal(providerConditionDetail({ message: 'same provider failure', sampledProviderCondition: condition }), 'same provider failure')
  }
})

test('sample counts are lower bounds, never totals', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    const journal = []
    const crew = { members: { builder: { model: 'sonnet', transport: 'pane', surface_id: 'surface-builder' } } }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      cmux: () => ({ ok: true, stdout: 'API Error 529 overloaded' }),
      logLine: (_path, row) => journal.push(row),
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: () => false,
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(io.wait(assignment.returnPath, 65), null)
    const samples = journal.filter((row) => row.event === 'pane-provider-sample')
    assert.equal(samples.length, 2)
    assert.deepEqual(samples.map((row) => [row.basis, row.bound, row.observed_at_least]), [
      ['sampled', 'lower', 1], ['sampled', 'lower', 2],
    ])
    for (const row of samples) assert.equal(Object.keys(row).some((key) => /^(total|count|samples_total)$/.test(key)), false)
  })
})

test('provider recognition branches no adjudication, escalation, reseat or retry', () => {
  withRepo({ dirty: false }, (fixture) => {
    const runFailure = (condition) => {
      const events = []
      const crew = {
        claude_bin: '/worker/bin',
        members: { builder: { model: 'sonnet', transport: 'headless-json' } },
      }
      const failure = Object.assign(new Error('same provider failure'), { stage: 'headless-no-envelope' })
      if (condition !== undefined) failure.providerCondition = condition
      const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
        headlessIo: () => ({
          assign: () => ({ id: 'd1', returnPath: join(fixture.paths.returnsDir, 'd1.builder.json') }),
          wait: () => { throw failure },
        }),
      })
      io.emit = (event) => events.push(event)
      const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      let thrown
      try { io.wait(assignment.returnPath, 1) } catch (err) { thrown = err }
      return { event: events.find((event) => event.kind === 'cell-failure'), thrown }
    }

    const recognised = runFailure('overloaded')
    const plain = runFailure(undefined)
    assert.deepEqual(
      [recognised.event.failure, recognised.event.stage],
      [plain.event.failure, plain.event.stage],
    )
    assert.equal(recognised.thrown.stage, plain.thrown.stage)
    assert.equal(cellFailureKind(recognised.thrown), cellFailureKind(plain.thrown))

    for (const condition of ['not-a-condition', '__proto__']) {
      const forged = runFailure(condition)
      assert.equal(forged.event.detail, 'same provider failure')
    }

    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const listed = execFileSync('git', [
      'grep', '-l', '-e', 'providerCondition', '-e', 'PROVIDER_CONDITIONS', '-e', 'recogniseProviderCondition', '--', 'crew/', 'scripts/', 'visualizer/',
    ], { cwd: repoRoot, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort()
    assert.deepEqual(listed, [
      'crew/headless.mjs', 'crew/headless.test.mjs', 'crew/seat-io-runclean.test.mjs', 'crew/seat-io.mjs',
    ])
    const seatIoSource = readFileSync(join(repoRoot, 'crew/seat-io.mjs'), 'utf8')
    for (const pattern of [/overloaded_error/, /rate_limit_error/, /authentication_error/, /\b529\b/, /\b429\b/]) {
      assert.doesNotMatch(seatIoSource, pattern)
    }
  })
})

test('seatIo waits through an absent or refusing heartbeat emitter', () => {
  for (const emitter of [null, {
    adwId: 'adw-refusing',
    emit: (fn) => fn({ heartbeat: () => { throw new Error('ledger down') } }),
  }]) {
    withRepo({ dirty: false }, (fixture) => {
      let clock = 0
      let returnPath = null
      const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
      const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, emitter, null, {}, {
        now: () => clock,
        sleep: (ms) => { clock += ms },
        sendLine: () => {},
        tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
        locate: (_tree, id) => id === 'surface-builder',
        existsSync: (path) => path === returnPath ? clock > LIVENESS_PROBE_MS : existsSync(path),
        readFileSync: (path, ...args) => path === returnPath ? JSON.stringify(envelope) : readFileSync(path, ...args),
      })
      const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      returnPath = assignment.returnPath
      assert.doesNotThrow(() => assert.deepEqual(io.wait(returnPath, 600), envelope))
    })
  }
})

test('readEnvelopeFile returns null for an absent return file and parses a present one', () => {
  const returnPath = '/tmp/pane-return.json'
  const envelope = { assignment_id: 'd1', role: 'builder', status: 'done' }
  assert.equal(readEnvelopeFile(returnPath, {
    existsSync: () => false,
    readFileSync: () => JSON.stringify(envelope),
  }), null)
  assert.deepEqual(readEnvelopeFile(returnPath, {
    existsSync: () => true,
    readFileSync: () => JSON.stringify(envelope),
  }), envelope)
})

test('readEnvelopeFile returns null when the read itself fails', () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  assert.equal(readEnvelopeFile('/tmp/pane-return.json', {
    existsSync: () => true,
    readFileSync: () => { throw error },
  }), null)
})

test("readEnvelopeFile throws a pane-parse-error naming the path, its existence and the parser's position", () => {
  const returnPath = '/tmp/pane-return.json'
  const malformed = '{"summary":"finished\nthe build"}'
  let error
  try {
    readEnvelopeFile(returnPath, {
      existsSync: () => true,
      readFileSync: () => malformed,
    })
  } catch (err) {
    error = err
  }
  assert.ok(error)
  assert.equal(error.stage, 'pane-parse-error')
  assert.match(error.message, new RegExp(returnPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(error.message, /EXIST/i)
  assert.match(error.message, /position \d+/)
  assert.equal(cellFailureKind(error), 'unusable-envelope')
})

test('seatIo.wait surfaces a malformed return file immediately as an unusable-envelope cell failure', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const events = []
    const malformed = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath,
      readFileSync: (path) => path === returnPath ? malformed : readFileSync(path, 'utf8'),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    let error
    try { io.wait(returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(error.stage, 'pane-parse-error')
    assert.ok(clock <= WAIT_POLL_MS)
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'unusable-envelope')
    assert.match(failures[0].detail, new RegExp(returnPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('seatIo.wait keeps polling an absent return file to its deadline', () => {
  withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let returnPath = null
    const events = []
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? false : existsSync(path),
      readFileSync: (path, ...args) => readFileSync(path, ...args),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    assert.equal(io.wait(returnPath, 600), null)
    assert.ok(clock >= 600 * 1000)
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'timeout')
  })
})
