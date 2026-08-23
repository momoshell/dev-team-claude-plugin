import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cellFailureKind, emitAdapter, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, providerConditionDetail,
  readEnvelopeFile, reaskDecision, samplePaneScreen, saveCrew, seatIo, settleSeatTeardown, WAIT_POLL_MS, waitForEnvelope,
} from './seat-io.mjs'
import { headlessIo, recogniseProviderCondition } from './headless.mjs'
import { startFileWriter } from '../test/helpers.mjs'
import { teardownCore } from './crew.mjs'

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

function addLane(fixture, name, tracked) {
  const dir = join(fixture.root, name)
  git(fixture.repoDir, 'worktree', 'add', '-q', '-b', name, dir)
  writeFileSync(join(dir, 'tracked.txt'), tracked)
  writeFileSync(join(dir, `${name}-untracked.txt`), `${name} untracked\n`)
  return dir
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

function interleavedRun() {
  return withRepo({}, (fixture) => {
    const laneB = addLane(fixture, 'laneB', 'LANE-B dirty tracked\n')
    const io = makeIo(fixture)
    const run = io.run.bind(io)
    io.run = (cmd) => {
      git(laneB, 'stash', 'push', '--include-untracked', '-q', '-m', 'sibling-lane-work')
      return run(cmd)
    }
    io.runClean('printf clean')
    return {
      tracked: readFileSync(join(fixture.repoDir, 'tracked.txt'), 'utf8'),
      untracked: existsSync(join(fixture.repoDir, 'untracked.txt'))
        ? readFileSync(join(fixture.repoDir, 'untracked.txt'), 'utf8') : null,
      foreignFile: existsSync(join(fixture.repoDir, 'laneB-untracked.txt')),
      subjects: git(fixture.repoDir, 'stash', 'list', '--format=%gs').split('\n').map((line) => line.trim()).filter(Boolean),
      laneBTracked: readFileSync(join(laneB, 'tracked.txt'), 'utf8'),
    }
  })
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

test('runClean restores its own entry when a sibling lane stashes in between', () => {
  const result = interleavedRun()
  assert.equal(result.tracked, CONTENT.dirty)
  assert.equal(result.untracked, CONTENT.untracked)
  assert.equal(result.foreignFile, false)
})

test("runClean leaves the sibling lane's entry for its owner", () => {
  const result = interleavedRun()
  assert.equal(result.subjects.length, 1)
  assert.match(result.subjects[0], /sibling-lane-work/)
  assert.equal(result.laneBTracked, CONTENT.committed)
})

test('runClean refuses loudly when its own entry is gone', () => {
  withRepo({}, (fixture) => {
    const io = makeIo(fixture)
    const run = io.run.bind(io)
    const decoy = 'decoy tracked content\n'
    io.run = (cmd) => {
      const own = git(fixture.repoDir, 'stash', 'list', '--format=%H %gs').split('\n')
        .filter((line) => line.includes('crew:runClean'))
      assert.equal(own.length, 1)
      git(fixture.repoDir, 'stash', 'drop', 'stash@{0}')
      writeFileSync(join(fixture.repoDir, 'tracked.txt'), decoy)
      git(fixture.repoDir, 'stash', 'push', '-q', '-m', 'decoy-entry')
      return run(cmd)
    }
    let error = null
    try { io.runClean('printf clean') } catch (err) { error = err }
    assert.ok(error)
    assert.match(error.message, /refus/i)
    assert.notEqual(readFileSync(join(fixture.repoDir, 'tracked.txt'), 'utf8'), decoy)
    assert.ok(git(fixture.repoDir, 'stash', 'list', '--format=%gs').includes('decoy-entry'))
  })
})

test('seatIo teardown is a measured zero when no transport was instantiated', () => {
  withRepo({ dirty: false }, (fixture) => {
    assert.deepEqual(makeIo(fixture).teardown(), [])
  })
})

test('seatIo teardown rows every declared pane seat with a recorded surface', () => {
  withRepo({ dirty: false }, (fixture) => {
    const roles = ['lead', 'planner', 'builder', 'reviewer']
    const members = Object.fromEntries(roles.map((role) => [role, { transport: 'pane', surface_id: `s-${role}` }]))
    const journal = []
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }),
      locate: (_tree, id) => ({ id }),
      logLine: (_path, row) => journal.push(row),
    })
    const rows = io.teardown()
    assert.deepEqual(rows.map((row) => row.role), roles)
    assert.ok(rows.every((row) => row.outcome === 'unproven' && row.reason === 'surface-open-not-closed-here' && row.record === false))
    const lines = journal.filter((row) => row.event === 'teardown-transports')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].seats, 4)
  })
})

test('a live unclosed pane seat is never failed by the automatic sweep', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = {
      lead: { transport: 'pane', surface_id: 's-lead' },
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
      reviewer: { transport: 'pane', surface_id: 's-reviewer' },
    }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 'still-open' }),
    })
    const rows = io.teardown()
    assert.equal(rows.some((row) => row.outcome === 'failed'), false)
    assert.ok(rows.every((row) => row.outcome === 'unproven'))
  })
})

test('a vanished pane surface is proven and ledger-owned by the automatic sweep', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = {
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
    }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [] }), locate: () => null,
    })
    const rows = io.teardown()
    assert.ok(rows.every((row) => row.outcome === 'proven' && row.reason === 'probe-dead'))
    assert.ok(rows.every((row) => !Object.hasOwn(row, 'record')))
  })
})

test('an indeterminate pane probe is unproven and does not own the ledger row', () => {
  withRepo({ dirty: false }, (fixture) => {
    const members = { builder: { transport: 'pane', surface_id: 's-builder' } }
    const io = seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: undefined }), locate: () => { throw new Error('locate must not run') },
    })
    const rows = io.teardown()
    assert.deepEqual(rows.map((row) => [row.outcome, row.reason, row.record]), [['unproven', 'probe-unknown', false]])
  })
})

test('a seatless crew remains a measured zero in the transport journal', () => {
  withRepo({ dirty: false }, (fixture) => {
    const journal = []
    const io = seatIo({ members: {} }, fixture.paths, fixture.repoDir, null, null, {}, {
      logLine: (_path, row) => journal.push(row),
    })
    assert.deepEqual(io.teardown(), [])
    const lines = journal.filter((row) => row.event === 'teardown-transports')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].seats, 0)
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'declared', 'event', 'init_failed', 'seats', 'transports'])
  })
})

test('the headless-rpc construction guard stays separate from pane coverage', () => {
  withRepo({ dirty: false }, (fixture) => {
    const throwing = { headlessRpcIo: () => { throw new Error('fifo refused') } }
    const headless = seatIo({ members: {
      planner: { transport: 'headless-rpc' }, reviewer: { transport: 'headless-rpc' },
    } }, fixture.paths, fixture.repoDir, null, null, {}, throwing).teardown()
    assert.equal(headless.length, 2)
    assert.ok(headless.every((row) => row.outcome === 'unproven' && row.reason === 'teardown-threw' && row.transport === 'headless-rpc'))

    const mixed = seatIo({ members: {
      pane: { transport: 'pane', surface_id: 's-pane' }, rpc: { transport: 'headless-rpc' },
    } }, fixture.paths, fixture.repoDir, null, null, {}, {
      ...throwing,
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 's-pane' }),
    }).teardown()
    assert.deepEqual(mixed.map((row) => row.role).sort(), ['pane', 'rpc'])
    assert.equal(new Set(mixed.map((row) => row.role)).size, mixed.length)
  })
})

test('automatic and teardownCore sweeps agree on surfaced pane seats', () => {
  withRepo({ dirty: false }, (fixture) => {
    const baseMembers = {
      planner: { transport: 'pane', surface_id: 's-planner' },
      builder: { transport: 'pane', surface_id: 's-builder' },
    }
    const automatic = (members) => seatIo({ members }, fixture.paths, fixture.repoDir, null, null, {}, {
      tree: () => ({ windows: [{}] }), locate: () => ({ id: 'open' }),
    }).teardown()
    const manual = (members) => teardownCore(fixture.paths, { members }, {
      closeSurface: () => {}, closeWorkspace: () => {}, renameSync: () => {},
      probe: () => false, sleep: () => {}, settleSeatRoots: () => null,
      reclaimDescendants: () => null, io: { log: () => {}, emit: () => true },
    })

    const firstAutomatic = automatic(baseMembers)
    const firstManual = manual(baseMembers)
    assert.equal(firstAutomatic.length, firstManual.seats.seats)
    assert.equal(firstManual.seats.seats, 2)

    const surfacedAndSurfaceless = { ...baseMembers, watcher: { transport: 'pane' } }
    const secondAutomatic = automatic(surfacedAndSurfaceless)
    const secondManual = manual(surfacedAndSurfaceless)
    assert.equal(secondAutomatic.length, secondManual.seats.seats)
    assert.equal(secondManual.seats.seats, 2)
    assert.equal(secondAutomatic.some((row) => row.role === 'watcher'), false)
  })
})

test('settleSeatTeardown tallies and journals unowned rows but never emits them', () => {
  const journal = []
  const emitted = []
  const summary = settleSeatTeardown({
    teardown: () => [
      { role: 'builder', transport: 'pane', outcome: 'unproven', reason: 'surface-open-not-closed-here', record: false },
      { role: 'planner', transport: 'pane', outcome: 'proven', reason: 'probe-dead' },
    ],
    log: (row) => journal.push(row), emit: (event) => { emitted.push(event); return true },
  })
  assert.deepEqual({ seats: summary.seats, proven: summary.proven, unproven: summary.unproven, record_failed: summary.record_failed }, {
    seats: 2, proven: 1, unproven: 1, record_failed: 0,
  })
  assert.equal(journal.filter((row) => row.event === 'seat-teardown').length, 2)
  assert.deepEqual(emitted.map((event) => event.role), ['planner'])
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
  const sample = samplePaneScreen('surface-builder', {
    cmux: (verb, args, options) => {
      calls.push({ verb, args: [...args], options })
      return { ok: true, stdout: frame }
    },
  })
  assert.deepEqual(sample, { read: true, condition: 'rate-limit' })
  assert.equal(recogniseProviderCondition(frame), null)
  assert.deepEqual(calls, [{
    verb: 'read-screen',
    args: ['--surface', 'surface-builder', '--scrollback', '--lines', '200'],
    options: { timeoutMs: 5000 },
  }])
})

test('a failed, empty or throwing screen read records nothing', () => {
  assert.deepEqual(samplePaneScreen('surface-builder', {
    cmux: () => ({ ok: false, stdout: 'API Error 529 overloaded' }),
  }), { read: false, condition: null })
  assert.deepEqual(samplePaneScreen('surface-builder', {
    cmux: () => ({ ok: true, stdout: '' }),
  }), { read: false, condition: null })
  assert.deepEqual(samplePaneScreen('surface-builder', {
    cmux: () => { throw new Error('read-screen failed') },
  }), { read: false, condition: null })
  // A failed, empty or throwing read is NOT a clean screen: `read: false` is
  // what keeps it from being read as evidence a condition ended.
  assert.deepEqual(samplePaneScreen('surface-builder', {
    cmux: () => ({ ok: true, stdout: 'nothing interesting here' }),
  }), { read: true, condition: null })

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

// One 95s wait fires the liveness probe three times (30s / 60s / 90s), reading
// one scripted screen each; the last screen repeats if fewer are supplied.
function paneSampleRun(fixture, screens) {
  let clock = 0
  let reads = 0
  const journal = []
  const crew = { members: { builder: { model: 'sonnet', transport: 'pane', surface_id: 'surface-builder' } } }
  const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
    cmux: (verb) => {
      if (verb !== 'read-screen') return { ok: true, stdout: '' }
      return screens[Math.min(reads++, screens.length - 1)]
    },
    logLine: (_path, row) => journal.push(row),
    now: () => clock,
    sleep: (ms) => { clock += ms },
    sendLine: () => {},
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
    locate: (_tree, id) => id === 'surface-builder',
    existsSync: () => false,
  })
  const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
  assert.equal(io.wait(assignment.returnPath, 95), null)
  assert.equal(reads, 3)
  return journal.filter((row) => row.event === 'pane-provider-sample')
}

const CONDITION_SCREEN = { ok: true, stdout: 'API Error 529 overloaded' }
const CLEAN_SCREEN = { ok: true, stdout: 'nothing interesting here' }
const FAILED_READ = { ok: false, stdout: 'API Error 529 overloaded' }

test('a condition persisting across probes is ONE record, first sighting to last', () => {
  withRepo({ dirty: false }, (fixture) => {
    const samples = paneSampleRun(fixture, [CONDITION_SCREEN])
    assert.equal(samples.length, 1)
    assert.deepEqual(
      [samples[0].condition, samples[0].basis, samples[0].bound, samples[0].first_seen_at, samples[0].last_seen_at],
      ['overloaded', 'sampled', 'lower', LIVENESS_PROBE_MS, 3 * LIVENESS_PROBE_MS],
    )
    // The row is a WINDOW, never a tally: three probes saw one condition, and
    // nothing on the row can be read as three of anything (#413).
    for (const row of samples) {
      assert.equal(Object.keys(row).some((key) => /(count|total|observed|sightings|probes)/i.test(key)), false)
    }
  })
})

test('an intermittent condition stays distinguishable from a persistent one', () => {
  withRepo({ dirty: false }, (fixture) => {
    const samples = paneSampleRun(fixture, [CONDITION_SCREEN, CLEAN_SCREEN, CONDITION_SCREEN])
    assert.equal(samples.length, 2)
    assert.deepEqual(samples.map((row) => [row.first_seen_at, row.last_seen_at]), [
      [LIVENESS_PROBE_MS, LIVENESS_PROBE_MS],
      [3 * LIVENESS_PROBE_MS, 3 * LIVENESS_PROBE_MS],
    ])
    assert.deepEqual([...new Set(samples.map((row) => row.condition))], ['overloaded'])
  })
})

test('a failed read never splits one run into two records', () => {
  withRepo({ dirty: false }, (fixture) => {
    const samples = paneSampleRun(fixture, [CONDITION_SCREEN, FAILED_READ, CONDITION_SCREEN])
    assert.equal(samples.length, 1)
    assert.deepEqual(
      [samples[0].first_seen_at, samples[0].last_seen_at],
      [LIVENESS_PROBE_MS, 3 * LIVENESS_PROBE_MS],
    )
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
      // This pane is not steerable; the immediate-surface property is what the
      // no-re-ask path preserves.
      locate: () => false,
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
    assert.match(error.message, /no re-ask/)
    const failures = events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'unusable-envelope')
    assert.match(failures[0].detail, new RegExp(returnPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

function makeReaskHarness(fixture, { alive = true, onReask = null } = {}) {
  let clock = 0
  let returnPath = null
  const sends = []
  const events = []
  const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    cmux: () => ({ ok: false, stdout: '' }),
    sendLine: (surface, line) => {
      sends.push({ surface, line })
      if (sends.length === 2 && onReask) onReask({ returnPath, line })
    },
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
    locate: (_tree, id) => alive === true && id === 'surface-builder',
    existsSync: (path) => existsSync(path),
    readFileSync: (path, ...args) => readFileSync(path, ...args),
    writeFileSync: (path, content) => writeFileSync(path, content),
  })
  io.emit = (event) => events.push(event)
  const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
  returnPath = assignment.returnPath
  return {
    io, sends, events, returnPath, clock: () => clock,
    seed: (content) => writeFileSync(returnPath, content),
  }
}

const MALFORMED_REASK = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
const MALFORMED_REASK_2 = '{"assignment_id":"d1","role":"builder","status":"done","summary":"second\ntry"}'
const VALID_REASK = JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done', summary: 'finished the build', artifacts: [], details: {} })

test('a live steerable pane seat gets exactly one re-ask carrying the return path and the verbatim parse failure', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, MALFORMED_REASK_2) })
    harness.seed(MALFORMED_REASK)
    assert.throws(() => harness.io.wait(harness.returnPath, 1), (error) => {
      assert.match(error.message, /re-ask attempted/)
      return true
    })
    assert.equal(harness.sends.length, 2)
    assert.equal(harness.sends[1].surface, 'surface-builder')
    assert.match(harness.sends[1].line, new RegExp(harness.returnPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')))
    const briefPath = join(fixture.paths.taskDir, 'reask-d1.builder.md')
    assert.equal(existsSync(briefPath), true)
    assert.match(readFileSync(briefPath, 'utf8'), /verbatim parse failure:/)
    assert.match(readFileSync(briefPath, 'utf8'), /the file EXISTED \(\d+ bytes\) and is not JSON this driver can read/)
  })
})

test('a valid envelope on the re-ask continues the run as if the first envelope had been readable', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, VALID_REASK) })
    harness.seed(MALFORMED_REASK)
    assert.deepEqual(harness.io.wait(harness.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.sends.length, 2)
    const failures = harness.events.filter((event) => event.kind === 'cell-failure')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].failure, 'unusable-envelope')
  })
})

test('a second unparseable envelope escalates naming the attempted re-ask, and the bound sends nothing more', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { onReask: ({ returnPath }) => writeFileSync(returnPath, MALFORMED_REASK_2) })
    harness.seed(MALFORMED_REASK)
    let first
    try { harness.io.wait(harness.returnPath, 600) } catch (error) { first = error }
    assert.ok(first)
    assert.match(first.message, /the file EXISTED \(\d+ bytes\) and is not JSON this driver can read/)
    assert.match(first.message, /re-ask attempted.*second envelope is still unparseable/s)
    assert.equal(harness.sends.length, 2)
    let second
    try { harness.io.wait(harness.returnPath, 600) } catch (error) { second = error }
    assert.ok(second)
    assert.match(second.message, /no re-ask/)
    assert.equal(harness.sends.length, 2)
  })
})

test('a non-steerable seat gets no re-ask and the escalation says so', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture, { alive: false })
    harness.seed(MALFORMED_REASK)
    let error
    try { harness.io.wait(harness.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.match(error.message, /no re-ask/)
    assert.match(error.message, /probe-dead/)
    assert.equal(harness.sends.length, 1)
  })
})

test('a failed re-ask leaves the envelope file byte-identical', () => {
  withRepo({ dirty: false }, (fixture) => {
    const harness = makeReaskHarness(fixture)
    harness.seed(MALFORMED_REASK)
    const before = readFileSync(harness.returnPath, 'utf8')
    let error
    try { harness.io.wait(harness.returnPath, 1) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(readFileSync(harness.returnPath, 'utf8'), before)
    assert.match(error.message, /re-ask attempted/)
    assert.equal(harness.sends.length, 2)
  })
})

test('reaskDecision refuses a settled, absent, indeterminate or non-pane seat and states why', () => {
  const refusals = [
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: true, asked: true },
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: null, alive: true, asked: false },
    { kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: null, asked: false },
    { kind: 'unusable-envelope', transport: 'headless-json', surfaceId: 'surface-builder', alive: true, asked: false },
  ]
  for (const args of refusals) {
    const result = reaskDecision(args)
    assert.equal(result.ask, false)
    assert.match(result.why, /\S/)
  }
  assert.equal(reaskDecision({ kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: true, asked: false }).ask, true)
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

const DURABILITY_ROSTER = JSON.parse(readFileSync(new URL('./roster.json', import.meta.url), 'utf8'))

function makeCrewJsonSeatFixture({ writeCrew = writeFileSync, logLine, extraDeps = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-seat-'))
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const source = DURABILITY_ROSTER.tiers.mechanical.reviewer
  const member = {
    transport: 'headless-json', agent: 'pi', model: source.id, effort: source.effort,
    provider: source.provider, id: source.id,
  }
  const crew = { members: { reviewer: member }, tier: 'mechanical', seats: { reviewer: { ...member } } }
  const logs = []
  const io = seatIo(crew, paths, root, null, { reviewer: { adapter: { modelString: ({ id }) => `model:${id}` } } }, {}, {
    readRoster: () => DURABILITY_ROSTER,
    logLine: logLine || ((_path, value) => logs.push(value)),
    writeFileSync: writeCrew,
    ...extraDeps,
  })
  return { root, paths, crew, io, logs, source, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('reseat uses locked RMW: another member survives and a stale transport persist keeps the new cell', async () => {
  const f = makeCrewJsonSeatFixture()
  const file = join(f.paths.dir, 'crew.json')
  const stale = JSON.parse(JSON.stringify(f.crew))
  const onDisk = {
    ...f.crew,
    members: { ...f.crew.members, builder: { role: 'builder', model: 'concurrent-member' } },
    seats: { ...f.crew.seats, builder: { model: 'concurrent-member' } },
  }
  writeFileSync(file, JSON.stringify(onDisk, null, 2))
  let writer = null
  try {
    // The second process publishes the concurrent member change through the
    // real harness; stop after its first atomic write so the RMW seam below is
    // deterministic while still exercising a process boundary.
    writer = await startFileWriter({ file, text: JSON.stringify({ ...onDisk, writer: '%N%' }), mode: 'atomic', maxMs: 1000 })
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
    rmSync(`${file}.stop`, { force: true })
    const result = f.io.reseat('reviewer', { reason: 'lane' })
    assert.equal(result.applied, true)
    const afterReseat = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterReseat.members.builder.model, 'concurrent-member')
    assert.equal(afterReseat.members.reviewer.id, result.to.id)
    const transport = headlessIo({
      crew: stale, paths: f.paths, taskDir: f.paths.taskDir, checkout: f.paths.dir,
      adapters: { reviewer: { headlessCommand: () => ({ bin: '/bin/worker', args: [] }) } }, bin: '/bin/worker',
      deps: { spawn: () => ({ pid: 8121, unref() {} }), uuid: () => 'stale-seat-session', now: () => 0, sleep: () => {}, pid: 8120, log() {} },
    })
    transport.assign({ role: 'reviewer', briefFile: join(f.paths.taskDir, 'brief.md') })
    const afterPersist = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(afterPersist.members.builder.model, 'concurrent-member')
    assert.equal(afterPersist.members.reviewer.id, result.to.id)
    assert.equal(afterPersist.members.reviewer.session_id, 'stale-seat-session')
  } finally {
    if (writer) await writer.stop()
    f.cleanup()
  }
})

test('a failed reseat persist records persisted:false and warns with crew.json', () => {
  const realWrite = writeFileSync
  const f = makeCrewJsonSeatFixture({
    writeCrew: (path, data, options) => {
      if (String(path).includes('crew.json.tmp.')) throw new Error('simulated crew.json write failure')
      return realWrite(path, data, options)
    },
  })
  const file = join(f.paths.dir, 'crew.json')
  writeFileSync(file, JSON.stringify(f.crew, null, 2))
  const errors = []; const original = process.stderr.write
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true }
  let result
  try { result = f.io.reseat('reviewer', { reason: 'lane' }) } finally {
    process.stderr.write = original
    f.cleanup()
  }
  assert.equal(result.applied, true)
  assert.equal(result.persisted, false)
  assert.match(result.why, /write-failed/)
  const record = f.logs.map((entry) => entry.reseat).find(Boolean)
  assert.equal(record.persisted, false)
  assert.match(record.persist_error, /write-failed/)
  assert.match(errors.join(''), /warning: reseat of .*crew\.json/)
})

test('saveCrew publishes a whole crew atomically for boot', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-save-'))
  const paths = { dir: root }
  const file = join(root, 'crew.json')
  const crew = { boot: true, members: { builder: { model: 'boot-model' } } }
  try {
    writeFileSync(file, JSON.stringify({ old: true }))
    const before = statSync(file).ino
    saveCrew(paths, crew, { uuid: () => 'boot-save' })
    assert.notEqual(statSync(file).ino, before)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), crew)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('showDoc updates doc_viewer without clobbering a concurrent member change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-json-doc-'))
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir); mkdirSync(paths.returnsDir)
  const crew = { workspace_id: 'ws', window_id: 'win', members: { reviewer: { model: 'stale' } } }
  const file = join(root, 'crew.json')
  const onDisk = { members: { reviewer: { model: 'stale' }, builder: { model: 'concurrent-builder' } } }
  writeFileSync(file, JSON.stringify(onDisk, null, 2))
  const before = { windows: [] }
  const after = { windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'doc-surface' }] }] }] }] }
  let trees = 0; let writer = null
  try {
    writer = await startFileWriter({ file, text: JSON.stringify({ ...onDisk, writer: '%N%' }), mode: 'atomic', maxMs: 1000 })
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
    rmSync(`${file}.stop`, { force: true })
    const io = seatIo(crew, paths, root, null, null, {}, {
      tree: () => trees++ === 0 ? before : after,
      cmux: (verb) => { assert.equal(verb, 'markdown'); return { ok: true } },
      closeSurface: () => {},
      logLine: () => {},
    })
    io.showDoc('/plan.md')
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(disk.members.builder.model, 'concurrent-builder')
    assert.deepEqual(disk.doc_viewer, { path: '/plan.md', surface_id: 'doc-surface' })
  } finally {
    if (writer) await writer.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
