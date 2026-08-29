import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync as realSpawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  COLD_PATH_FALLBACK_ROOTS, COLD_PATH_MIN_SHARED, cellFailureKind, claudeRefusalFrames, claudeTranscriptPaths, coldGuardNames, coldPathCollision, coldPathRoots, DESCENDANT_STORE_DIRS, descendantCapture, emitAdapter, HEADLESS_RPC_TRANSPORT, HEADLESS_TRANSPORT, LIVENESS_MISSES_TO_DIE, LIVENESS_PROBE_MS, neutralColdPath, REASK_SETTLE_POLLS, SUBSTRATE_GRACE_MS, paneRetryFrame, piRefusalFrames, piSessionDir, piTranscriptPaths,
  providerConditionDetail, paneUsageFrames, readEnvelopeFile, reaskDecision, recogniseProviderRetry, saveCrew, seatIo, settleSeatTeardown,
  SEAT_REFUSAL_STAGE, SILENCE_REASK_MS, TRANSCRIPT_STALE_MS, WAIT_POLL_MS, waitForEnvelope, waitState, transcriptGrowth, silenceReaskDecision,
} from './seat-io.mjs'
import { headlessIo, recogniseProviderCondition, SEAT_REFUSALS } from './headless.mjs'
import { JOURNAL_CHANNEL_NAMES } from './drive.mjs'
import { git, ROOT, scratchDir, startFileWriter } from '../test/helpers.mjs'
import { teardownCore } from './crew.mjs'

const CONTENT = Object.freeze({
  committed: 'committed tracked content\n',
  dirty: 'dirty tracked content\n',
  target: 'target v1\n',
  victim: 'victim v1\n',
  untracked: 'untracked content\n',
  ignored: 'ignored secret content\n',
  node: 'node package content\n',
})

function makeRepo({ dirty = true, linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crew-run-clean-'))
  const repoDir = join(root, 'repo')
  mkdirSync(repoDir)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir)
  mkdirSync(paths.returnsDir)

  git(repoDir, 'init')
  writeFileSync(join(repoDir, '.gitignore'), 'ignored/\nnode_modules/\n')
  writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.committed)
  writeFileSync(join(repoDir, 'witness-target.txt'), CONTENT.target)
  writeFileSync(join(repoDir, 'witness-victim.txt'), CONTENT.victim)
  git(repoDir, 'add', '-A')
  git(repoDir, 'commit', '-m', 'initial')

  if (dirty) {
    writeFileSync(join(repoDir, 'tracked.txt'), CONTENT.dirty)
    writeFileSync(join(repoDir, 'untracked.txt'), CONTENT.untracked)
    mkdirSync(join(repoDir, 'ignored'))
    writeFileSync(join(repoDir, 'ignored', 'secret.txt'), CONTENT.ignored)
    mkdirSync(join(repoDir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repoDir, 'node_modules', 'pkg', 'index.js'), CONTENT.node)
  }

  const fixture = { root, repoDir, paths, checkout: repoDir }
  if (linked) fixture.checkout = addLane(fixture, 'linkedLane', CONTENT.dirty)
  return fixture
}

function addLane(fixture, name, tracked) {
  const dir = join(fixture.root, name)
  git(fixture.repoDir, 'worktree', 'add', '-q', '-b', name, dir)
  writeFileSync(join(dir, 'tracked.txt'), tracked)
  writeFileSync(join(dir, `${name}-untracked.txt`), `${name} untracked\n`)
  return dir
}

function makeIo({ repoDir, checkout, paths }, deps = {}) {
  return seatIo({ members: {} }, paths, checkout || repoDir, null, null, {}, deps)
}

function commitRepo(tag, files) {
  const root = scratchDir(`crew-commit-${tag}-`)
  git(root, 'init', '-q')
  // commit() shells out to plain `git`, which inherits no identity from the
  // test helper; configure the repo itself for a lane with an empty HOME.
  git(root, 'config', 'user.email', 'crew@example.invalid')
  git(root, 'config', 'user.name', 'Crew Test')
  for (const name of files) writeFileSync(join(root, name), `${name} initial\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'initial')
  const paths = { dir: root, taskDir: root, returnsDir: root }
  return { root, io: seatIo({ members: {} }, paths, root, null, null, {}, {}) }
}

// The seat-side inventory mirrors gate.mjs: event discriminators and payload
// keys are separate projections, and the three forwarding sinks are excluded.
const SEAT_SINK = /(?:io\?\.log\?\.\(|io\.log\(|(?<![.\w])log\?\.\(|logLine\(join\(paths\.dir, 'journal\.jsonl'\), )/g
const SEAT_PASS_THROUGH = new Set([
  'log: (obj) => io.log(obj),',
  "log: (obj) => logLine(join(paths.dir, 'journal.jsonl'), obj),",
  "log(obj) { logLine(join(paths.dir, 'journal.jsonl'), obj) },",
])
function seatPayloadElements(text, from) {
  let i = from
  while (i < text.length && text[i] !== '{') i += 1
  if (text[i] !== '{') return null
  i += 1
  const parts = []
  let buf = ''
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const two = text.slice(i, i + 2)
    if (two === '//') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (two === '/*') { i = text.indexOf('*/', i); if (i < 0) return null; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      let j = i + 1
      while (j < text.length) { if (text[j] === '\\') { j += 2; continue } if (text[j] === q) break; j += 1 }
      buf += text.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '{' || c === '[' || c === '(') { depth += 1; buf += c; i += 1; continue }
    if (c === ']' || c === ')') { depth -= 1; buf += c; i += 1; continue }
    if (c === '}') { if (depth === 0) { parts.push(buf); break } depth -= 1; buf += c; i += 1; continue }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; i += 1; continue }
    buf += c; i += 1
  }
  const collapse = (s) => s.trim().replace(/\s+/g, ' ')
  const events = []
  const keys = []
  for (const raw of parts.map(collapse).filter((s) => s.length > 0)) {
    let m = raw.match(/^event\s*:\s*'([^']*)'/); if (m) { events.push(`event='${m[1]}'`); continue }
    if (raw.startsWith('...')) { keys.push(`...${collapse(raw.slice(3))}`); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)\s*:/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)$/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^'([^']*)'\s*:/); if (m) { keys.push(m[1]); continue }
    keys.push(raw)
  }
  return { events: events.join(' '), keys: keys.join(' ') }
}
function seatJournalSites(text) {
  SEAT_SINK.lastIndex = 0
  const lines = text.split('\n')
  const out = []
  let hit
  while ((hit = SEAT_SINK.exec(text)) !== null) {
    const line = text.slice(0, hit.index).split('\n').length
    if (SEAT_PASS_THROUGH.has(lines[line - 1].trim())) continue
    const after = text.slice(hit.index + hit[0].length)
    const payload = seatPayloadElements(text, hit.index + hit[0].length)
    out.push({
      line,
      wrapper: after.startsWith('recordRow(') ? 'recordRow' : after.startsWith('operationalRow(') ? 'operationalRow' : null,
      events: payload?.events ?? null,
      keys: payload?.keys ?? null,
    })
  }
  return out
}
const SEAT_JOURNAL_EXPECTED = Object.freeze([
  ['operationalRow', "event='descendant-capture'", 'at records captures discovery_failures'],
  ['operationalRow', "event='seat-root-settle'", 'at ...record ...result'],
  ['operationalRow', "event='seat-root-settle-sweep'", 'at ...summary'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...empty'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...summary'],
  ['operationalRow', "event='descendant-reclaim'", 'at ...row'],
  ['operationalRow', "event='descendant-reclaim-record-failed'", 'at ...row'],
  ['operationalRow', "event='descendant-reclaim-error'", 'at key reason'],
  ['operationalRow', "event='descendant-reclaim-sweep'", 'at ...summary'],
  ['operationalRow', "event='seat-teardown'", 'at ...seat'],
  ['operationalRow', "event='seat-teardown-record-failed'", 'at role outcome reason'],
  ['operationalRow', "event='seat-teardown-sweep'", 'at ...summary'],
  ['recordRow', "event='seat-refusal'", "role id member source message at outcome ...(frame.member === 'overflowed' ? { news: 'first-occurrence' } : {}) ...extra"],
  ['operationalRow', "event='seat-retrying'", 'at role id attempt of retry_in_s condition source'],
  ['operationalRow', "event='seat-retry-cleared'", 'at role id source'],
  ['operationalRow', "event='seat-substrate-down'", 'at role id misses grace_ms'],
  ['operationalRow', "event='seat-substrate-recovered'", 'at role id misses grace_ms'],
  ['operationalRow', "event='seat-stale-cleared'", 'at role id'],
  ['operationalRow', "event='seat-stale'", 'at role id last_frame_at stale_ms threshold_ms'],
  ['recordRow', "event='seat-silence-reask'", 'at role id returnPath outcome why silent_ms ...extra'],
  ['recordRow', "event='envelope-reask'", 'at role id returnPath transport outcome ...extra'],
  ['operationalRow', "event='pane-usage'", 'role id session_id parent subagents subagent_files measured'],
  ['operationalRow', "event='tree-witness'", 'at checkout outcome refused modified removed added head_changed cause detail'],
  ['recordRow', '', 'at seat_died returnPath'],
  ['recordRow', '', 'at substrate_gone returnPath'],
  ['operationalRow', "event='teardown-transports'", 'at declared transports init_failed seats'],
  ['recordRow', '', 'at reseat'],
  ['operationalRow', "event='doc-viewer'", 'at path surface_id'],
])

test('every journal emit site in seat-io is inventoried, wrapped and on the right channel', () => {
  const text = readFileSync(new URL('./seat-io.mjs', import.meta.url), 'utf8')
  for (const sink of SEAT_PASS_THROUGH) assert.equal(text.split(sink).length - 1, 1, `pass-through changed or duplicated: ${sink}`)
  const sites = seatJournalSites(text)
  assert.equal(sites.length, 28)
  assert.deepEqual(sites.map(({ wrapper, events, keys }) => [wrapper, events, keys]), SEAT_JOURNAL_EXPECTED)
  assert.ok(sites.every(({ wrapper }) => wrapper === 'recordRow' || wrapper === 'operationalRow'))
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'operationalRow').length, 22)
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'recordRow').length, 6)
})

test('the teardown family stamps the operational channel at the sink', () => {
  const root = scratchDir('journal-channel-capture-')
  const taskDir = join(root, 'task')
  const transportDir = join(taskDir, DESCENDANT_STORE_DIRS['headless-json'])
  mkdirSync(transportDir, { recursive: true })
  writeFileSync(join(transportDir, '.builder.active.json'), JSON.stringify({
    reservation_id: 'reservation-channel', key: 'builder', phase: 'running', role: 'builder', id: 'd-channel',
    dir: join('headless', 'd-channel'), pid: process.pid, owner: { pid: process.pid, startedAt: Date.now() },
  }))
  const snapshot = () => ({ ok: true, rows: new Map([[process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' }]]) })
  const captured = []
  try {
    const result = descendantCapture({ taskDir, log: (row) => captured.push(row), deps: { snapshot } }).round()
    const row = captured.find((entry) => entry.event === 'descendant-capture')
    assert.equal(row.channel, 'operational')
    assert.equal(row.event, 'descendant-capture')
    assert.equal(row.records, result.records)
    assert.equal(row.captures, result.captures)
    assert.equal(row.discovery_failures, result.discovery_failures)
  } finally { rmSync(root, { recursive: true, force: true }) }

  const logged = []
  settleSeatTeardown({
    teardown: () => [{ role: 'builder', outcome: 'proven', reason: 'probe-dead' }],
    log: (row) => logged.push(row), emit: () => true,
  })
  for (const row of logged) {
    assert.ok(JOURNAL_CHANNEL_NAMES.includes(row.channel), `${JSON.stringify(row)} carries no channel`)
  }
})

test('descendant capture distinguishes valid, malformed and absent markers', () => {
  const snapshot = () => ({ ok: true, rows: new Map([[process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, start: 'root' }]]) })
  const round = (content) => {
    const root = scratchDir('descendant-marker-')
    const taskDir = join(root, 'task')
    const transportDir = join(taskDir, DESCENDANT_STORE_DIRS['headless-json'])
    mkdirSync(transportDir, { recursive: true })
    if (content !== null) {
      writeFileSync(join(transportDir, '.builder.active.json'), content)
    }
    return descendantCapture({ taskDir, log: () => {}, deps: { snapshot } }).round()
  }
  const valid = round(JSON.stringify({
    reservation_id: 'reservation-1', key: 'builder', phase: 'running', role: 'builder', id: 'd1',
    dir: join('headless', 'd1'), pid: process.pid, owner: { pid: process.pid, startedAt: Date.now() },
  }))
  assert.equal(valid.records, 1)
  assert.equal(valid.captures, 1)
  assert.equal(valid.discovery_failures, 0)
  const malformed = round('{not json')
  assert.equal(malformed.discovery_failures, 1)
  const absent = round(null)
  assert.equal(absent.discovery_failures, 0)
  assert.equal(absent.records, 0)
  assert.equal(absent.captures, 0)
})

test('paneUsageFrames folds claude spend once, then emits deltas and zeroes without repeating totals', () => {
  withRepo({ dirty: false }, (fixture) => {
    const session = '11111111-1111-4111-8111-111111111111'
    const transcriptPath = join(fixture.paths.taskDir, `${session}.jsonl`)
    const usageDir = join(fixture.paths.taskDir, 'usage')
    mkdirSync(usageDir, { recursive: true })
    const line = (id, input, output, cacheWrite, cacheRead) => JSON.stringify({
      type: 'assistant', message: { id, usage: {
        input_tokens: input, output_tokens: output,
        cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
      } },
    })
    writeFileSync(transcriptPath, `${line('a1', 1, 100, 10, 1000)}\n`)
    writeFileSync(join(usageDir, 'planner.jsonl'), `${JSON.stringify({ session_id: session, transcript_path: transcriptPath })}\n`)

    const first = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd1', model: 'claude-opus-5', sent: {} })
    assert.equal(first.frames.length, 1)
    assert.equal(first.frames[0].usage.billed_output_tokens, 100)
    writeFileSync(transcriptPath, `${line('a1', 1, 100, 10, 1000)}\n${line('a2', 2, 25, 5, 500)}\n`)
    const second = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd2', model: 'claude-opus-5', sent: first.sent })
    assert.equal(second.frames.length, 1)
    assert.deepEqual(second.frames[0].usage, {
      billed_input_tokens: 2, billed_output_tokens: 25,
      billed_cache_write_tokens: 5, billed_cache_read_tokens: 500,
    })
    const third = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', id: 'd3', model: 'claude-opus-5', sent: second.sent })
    assert.deepEqual(third.frames[0].usage, {
      billed_input_tokens: 0, billed_output_tokens: 0,
      billed_cache_write_tokens: 0, billed_cache_read_tokens: 0,
    })

    const unmeasured = '22222222-2222-4222-8222-222222222222'
    const unmeasuredPath = join(fixture.paths.taskDir, `${unmeasured}.jsonl`)
    writeFileSync(unmeasuredPath, `${JSON.stringify({ type: 'assistant', message: { id: 'u1', usage: { output_tokens_v2: 99 } } })}\n`)
    writeFileSync(join(usageDir, 'reviewer.jsonl'), `${JSON.stringify({ session_id: unmeasured, transcript_path: unmeasuredPath })}\n`)
    const absent = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'reviewer', id: 'd4', model: 'claude-opus-5', sent: {} })
    assert.equal(absent.frames.length, 1)
    assert.equal(absent.frames[0].usage, null)
    assert.equal(Object.hasOwn(absent.sent, unmeasured), false)

    const pi = paneUsageFrames({ taskDir: fixture.paths.taskDir, role: 'planner', agent: 'pi', sent: {} })
    assert.deepEqual(pi.frames, [])
  })
})

test('a pane wait emits usage and persists sent totals across a second seatIo instance', () => {
  withRepo({ dirty: false }, (fixture) => {
    const session = '33333333-3333-4333-8333-333333333333'
    const transcriptPath = join(fixture.paths.taskDir, `${session}.jsonl`)
    mkdirSync(join(fixture.paths.taskDir, 'usage'), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({ type: 'assistant', message: { id: 'w1', usage: {
      input_tokens: 1, output_tokens: 77, cache_creation_input_tokens: 3, cache_read_input_tokens: 9,
    } } }))
    writeFileSync(join(fixture.paths.taskDir, 'usage', 'planner.jsonl'), JSON.stringify({ session_id: session, transcript_path: transcriptPath }))
    const make = () => {
      const events = []
      const journal = []
      const crew = { members: { planner: { surface_id: 'surface-planner', transport: 'pane', agent: 'claude', model: 'claude-opus-5' } } }
      const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
        now: () => 0, sleep: () => {}, tree: () => ({ windows: [] }), locate: () => false,
        sendLine: () => {}, assignmentLine: () => 'assignment', logLine: (_path, row) => journal.push(row), cmux: () => ({ ok: false }),
      })
      io.emit = (event) => events.push(event)
      const assignment = io.assign({ role: 'planner', briefFile: join(fixture.paths.taskDir, 'brief.md') })
      assert.doesNotThrow(() => io.wait(assignment.returnPath, 0))
      return { events, journal }
    }
    const first = make()
    const usage1 = first.events.filter((event) => event.kind === 'usage')
    assert.equal(usage1.length, 1)
    assert.equal(usage1[0].usage.billed_output_tokens, 77)
    assert.equal(readFileSync(join(fixture.paths.taskDir, 'usage', 'planner.sent.json')).includes(session), true)
    const second = make()
    const usage2 = second.events.filter((event) => event.kind === 'usage')
    assert.equal(usage2.length, 1)
    assert.equal(usage2[0].usage.billed_output_tokens, 0)
    assert.equal(first.journal.filter((row) => row.event === 'pane-usage').length, 1)
  })
})

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

test('runClean refuses a tracked file modified during the window and names it', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.match(error.message, /tree-witness/)
    assert.match(error.message, /witness-target\.txt/)
  })
})

test('runClean refuses a tracked file removed during the window and names it', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean('rm witness-victim.txt; printf ok'), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.match(error.message, /tree-witness/)
    assert.match(error.message, /witness-victim\.txt/)
  })
})

test('runClean reports an added path without refusing the window', () => {
  withRepo({}, (fixture) => {
    const journal = []
    const result = makeIo(fixture, { logLine: (_path, row) => journal.push(row) })
      .runClean("printf 'new\\n' > witness-added.txt; printf ok")
    assert.deepEqual(result, { ok: true, output: 'ok' })
    const row = journal.find((entry) => entry.event === 'tree-witness')
    assert.ok(row)
    assert.equal(row.outcome, 'changed')
    assert.equal(row.refused, false)
    assert.deepEqual(row.added, ['witness-added.txt'])
  })
})

test('runClean refuses an unmeasurable witness on either side without reporting unchanged', () => {
  for (const [side, unmeasurableCall] of [['open', 1], ['close', 2]]) {
    withRepo({}, (fixture) => {
      let calls = 0
      const cause = `injected-${side}-unmeasurable`
      const journal = []
      const deps = {
        fingerprintTree: (checkout) => {
          calls += 1
          if (calls === unmeasurableCall) return { measured: false, checkout, at: 'injected', cause, detail: 'test injection' }
          return { measured: true, checkout, at: 'injected', head: 'HEADSHA', entries: {} }
        },
        logLine: (_path, row) => journal.push(row),
      }
      let error
      assert.throws(() => makeIo(fixture, deps).runClean('printf clean'), (err) => { error = err; return true })
      assert.match(error.message, new RegExp(cause))
      assert.equal(journal.length, 1)
      assert.notEqual(journal[0].outcome, 'unchanged')
    })
  }
})

test('runClean restores stashed work before refusing a witness violation', () => {
  withRepo({}, (fixture) => {
    let error
    assert.throws(() => makeIo(fixture).runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    restored(fixture)
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
  })
})

test('runClean carries the witness through the clean-tree arm', () => {
  withRepo({ dirty: false }, (fixture) => {
    const journal = []
    let error
    assert.throws(() => makeIo(fixture, { logLine: (_path, row) => journal.push(row) })
      .runClean("printf 'target v2\\n' > witness-target.txt; printf ok"), (err) => { error = err; return true })
    assert.equal(error.reason, 'tree-witness')
    assert.equal(readFileSync(join(fixture.repoDir, 'witness-target.txt'), 'utf8'), 'target v2\n')
    assert.equal(git(fixture.repoDir, 'stash', 'list').trim(), '')
    assert.equal(journal.find((entry) => entry.event === 'tree-witness')?.refused, true)
  })
})

test('runClean keeps a quiet window unchanged and unjournalled', () => {
  withRepo({}, (fixture) => {
    const journal = []
    const result = makeIo(fixture, { logLine: (_path, row) => journal.push(row) }).runClean('printf clean')
    assert.deepEqual(result, { ok: true, output: 'clean' })
    restored(fixture)
    assert.equal(journal.some((entry) => entry.event === 'tree-witness'), false)
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

test('runCold runs the command outside the lane checkout and returns its path', () => {
  withRepo({ dirty: false }, (fixture) => {
    const result = makeIo(fixture).runCold('pwd')
    const cwd = String(result.output || '').trim().split('\n').pop() || ''
    assert.equal(result.ok, true)
    assert.ok(cwd)
    assert.notEqual(cwd, fixture.checkout)
    assert.equal(result.kept, null)
  })
})

test('runCold cuts the checkout at the current HEAD', () => {
  withRepo({ dirty: false }, (fixture) => {
    writeFileSync(join(fixture.checkout, 'cold-marker.txt'), 'marker-ok\n')
    git(fixture.checkout, 'add', '-A')
    git(fixture.checkout, 'commit', '-q', '-m', 'the build')
    const result = makeIo(fixture).runCold('cat cold-marker.txt')
    assert.equal(result.ok, true)
    assert.match(result.output, /marker-ok/)
  })
})

test('runCold removes a green checkout and keeps a red checkout for inspection', () => {
  withRepo({ dirty: false }, (fixture) => {
    const green = makeIo(fixture).runCold('true')
    assert.equal(green.ok, true)
    assert.equal(existsSync(green.path), false)

    const red = makeIo(fixture).runCold("printf 'cold output'; exit 3")
    try {
      assert.equal(red.ok, false)
      assert.equal(red.kept, red.path)
      assert.equal(existsSync(red.kept), true)
      assert.match(red.output, /cold output/)
    } finally {
      if (red.kept) git(fixture.checkout, 'worktree', 'remove', '--force', red.kept)
    }
  })
})

test('runCold throws when git worktree add fails', () => {
  withRepo({ dirty: false }, (fixture) => {
    const deps = {
      spawnSync: (bin, argv, opts) => (Array.isArray(argv) && argv.includes('worktree') && argv.includes('add')
        ? { status: 1, stdout: '', stderr: 'injected add failure\n' }
        : realSpawnSync(bin, argv, opts)),
    }
    assert.throws(() => makeIo(fixture, deps).runCold('true'), /worktree add failed/)
  })
})

test('runCold throws when green cleanup fails and names the registered path', () => {
  withRepo({ dirty: false }, (fixture) => {
    let path = null
    const deps = {
      spawnSync: (bin, argv, opts) => {
        if (Array.isArray(argv) && argv.includes('remove')) {
          path = argv.at(-1)
          return { status: 1, stdout: '', stderr: 'injected remove failure\n' }
        }
        return realSpawnSync(bin, argv, opts)
      },
    }
    try {
      assert.throws(() => makeIo(fixture, deps).runCold('true'), (error) => /still registered/.test(error.message) && error.message.includes(path))
    } finally {
      if (path) git(fixture.checkout, 'worktree', 'remove', '--force', path)
    }
  })
})

test('runCold throws when the suite cannot be spawned', () => {
  withRepo({ dirty: false }, (fixture) => {
    let path = null
    const deps = {
      spawnSync: (bin, argv, opts) => {
        if (String(bin) === '/bin/sh') {
          path = opts.cwd
          return { status: null, stdout: '', stderr: '', error: new Error('injected spawn failure') }
        }
        return realSpawnSync(bin, argv, opts)
      },
    }
    try {
      assert.throws(() => makeIo(fixture, deps).runCold('true'), /could not be spawned/)
    } finally {
      if (path) git(fixture.checkout, 'worktree', 'remove', '--force', path)
    }
  })
})

test('runCold refuses to cut an unguarded checkout when repository lookup fails', () => {
  withRepo({ dirty: false }, (fixture) => {
    const deps = { execSync: () => { throw new Error('injected rev-parse failure') } }
    assert.throws(() => makeIo(fixture, deps).runCold('true'), /repository-name guard/)
  })
})

test('runCold redraws paths carrying lane, repository, and checkout names', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const root = scratchDir('zqneutral-')
    const draw = (first, names) => {
      const result = makeIo(fixture, { cold: { tmpRoot: root, rand: (i) => i === 0 ? first : 'f9f9f9', attempts: 8 } }).runCold('true', names)
      assert.equal(basename(result.path), 'f9f9f9')
    }
    draw('zqlane5x', ['zqlane5'])
    draw('repo9x', [])
    draw('linkedLanex', [])
  })
})

test('coldPathCollision reports shared case-insensitive windows only', () => {
  const hit = coldPathCollision('/zz/coldcheck-9budget9', ['b281-spawnBUDGET'])
  assert.equal(typeof hit, 'string')
  assert.equal(hit.length, COLD_PATH_MIN_SHARED)
  assert.ok('/zz/coldcheck-9budget9'.toLowerCase().includes(hit.toLowerCase()))
  assert.ok('b281-spawnBUDGET'.toLowerCase().includes(hit.toLowerCase()))
  assert.equal(coldPathCollision('/zz/9f9f9f', ['b281-spawnbudget']), '')
})

test('neutralColdPath redraws a collision and throws on exhausted roots', () => {
  const path = neutralColdPath(['b304-coldverify'], {
    tmpRoots: ['/zz'], rand: (i) => ['b304ab', 'f9f9f9'][i], attempts: 4, realpath: (p) => p,
  })
  assert.equal(basename(path), 'f9f9f9')
  assert.throws(() => neutralColdPath(['spawnbudget'], {
    tmpRoots: ['/zz'], rand: () => 'budgetx', attempts: 3, realpath: (p) => p,
  }), /TMPDIR/)
})

test('coldGuardNames derives repository and drops short or dot names', () => {
  assert.deepEqual(coldGuardNames('/tmp/zqcheckout', '/tmp/zqrepo/.git'), ['zqcheckout', 'zqrepo'])
  assert.deepEqual(coldGuardNames('.', '/tmp/zqrepo/.git'), ['zqrepo'])
  assert.deepEqual(coldGuardNames('/tmp/ab', '/tmp/xy/.git'), [])
})

test('runCold leaves runClean and the stash stack alone on a dirty linked tree', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const result = makeIo(fixture).runCold('git show -s --format=%s')
    assert.equal(result.ok, true)
    assert.match(result.output, /initial/)
    assert.equal(git(fixture.checkout, 'stash', 'list').trim(), '')
    assert.equal(readFileSync(join(fixture.checkout, 'tracked.txt'), 'utf8'), CONTENT.dirty)
  })
})

test('neutralColdPath rejects a colliding root before drawing and uses the next root', () => {
  let draws = 0
  const path = neutralColdPath(['b304-coldverify'], {
    tmpRoots: ['/zz/folders/T', '/zz/neutral9'], rand: () => { draws += 1; return `n${draws}n` },
    attempts: 8, realpath: (p) => p,
  })
  assert.match(path, /^\/zz\/neutral9\//)
  assert.equal(draws, 1)
})

test('coldPathRoots preserves explicit order and does not silently fall back', () => {
  assert.deepEqual(coldPathRoots({}), [tmpdir(), ...COLD_PATH_FALLBACK_ROOTS])
  assert.deepEqual(coldPathRoots({ tmpRoot: '/zz/one' }), ['/zz/one'])
  assert.deepEqual(coldPathRoots({ tmpRoots: ['/zz/one', '/zz/two'] }), ['/zz/one', '/zz/two'])
})

test('neutralColdPath canonicalizes symlink roots before judging and building', () => {
  const root = scratchDir('zqsymlink-')
  const target = join(root, 'zqcoldverify9')
  const link = join(root, 'zqlink')
  mkdirSync(target)
  symlinkSync(target, link)
  assert.throws(() => neutralColdPath(['zqcoldverify9'], { tmpRoots: [link], rand: () => 'f9f9f9', attempts: 2 }), /every candidate root was rejected/)

  const neutral = join(root, 'zqneutral')
  const link2 = join(root, 'zqlink2')
  mkdirSync(neutral)
  symlinkSync(neutral, link2)
  const path = neutralColdPath(['nothingatall'], { tmpRoots: [link2], rand: () => 'f9f9f9', attempts: 2 })
  assert.match(path, new RegExp(`^${realpathSync(neutral)}/`))
})

test('the shipped default roots yield a neutral path for this lane and repository', () => {
  withRepo({ dirty: false, linked: true }, (fixture) => {
    const common = git(fixture.checkout, 'rev-parse', '--git-common-dir').trim()
    const resolved = common.startsWith('/') ? common : join(fixture.checkout, common)
    const repo = basename(dirname(resolved))
    const names = ['b304-coldverify', basename(fixture.checkout), repo]
    assert.ok(repo)
    assert.notEqual(repo, basename(fixture.checkout))
    const path = neutralColdPath(names)
    assert.equal(coldPathCollision(path, names), '')
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
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'channel', 'declared', 'event', 'init_failed', 'seats', 'transports'])
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

test('piRefusalFrames reads typed refusal frames and preserves provider text', () => {
  const home = scratchDir('pi-refusal-home-')
  const checkout = '/Users/x/Development/dt-b183-seatrefusal'
  const dir = join(home, '.pi', 'agent', 'sessions', `-${checkout.replaceAll('/', '-')}--`)
  mkdirSync(dir, { recursive: true })
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  const frame = (stop, message, content, timestamp) => JSON.stringify({ timestamp, message: { stopReason: stop, errorMessage: message, content, usage } })
  writeFileSync(join(dir, 'session.jsonl'), [
    frame('error', 'WebSocket error', [{ type: 'thinking', thinking: '' }], '2026-08-23T21:31:42.796Z'),
    frame('error', 'prompt_cache_retention is not supported on this model', [], '2026-08-23T22:01:41.213Z'),
  ].join('\n') + '\n')
  const frames = piRefusalFrames({ checkout, deps: { home } })
  assert.deepEqual(frames.map((row) => [row.member, row.source]), [['transient', 'pi'], ['rejected', 'pi']])
  assert.equal(frames[0].message, 'WebSocket error')
  assert.deepEqual(piRefusalFrames({ checkout, since: Date.parse('2026-08-23T21:40:00.000Z'), deps: { home } }).map((row) => row.member), ['rejected'])
})

test('piRefusalFrames ignores non-refusal stops and degrades every store/read/parse failure to no evidence', () => {
  const home = scratchDir('pi-refusal-edge-')
  const checkout = '/tmp/pi-edge'
  const dir = join(home, '.pi', 'agent', 'sessions', `-${checkout.replaceAll('/', '-')}--`)
  mkdirSync(dir, { recursive: true })
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
  writeFileSync(join(dir, 'session.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-23T21:31:42.796Z', message: { stopReason: 'aborted', errorMessage: 'WebSocket error', content: [], usage } }),
    JSON.stringify({ timestamp: '2026-08-23T21:32:42.796Z', message: { stopReason: 'stop', content: [], usage } }),
    'not json', '',
  ].join('\n'))
  assert.deepEqual(piRefusalFrames({ checkout, deps: { home } }), [])
  assert.deepEqual(piRefusalFrames({ checkout: '/missing', deps: { home } }), [])
  assert.deepEqual(piRefusalFrames({ checkout, deps: { home, existsSync: () => true, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }), [])
})

test('claudeRefusalFrames reads only API error transcript rows and tolerates absent usage', () => {
  const root = scratchDir('claude-refusal-')
  const transcript = join(root, 'transcript.jsonl')
  const taskDir = join(root, 'task')
  mkdirSync(join(taskDir, 'usage'), { recursive: true })
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: '2026-08-23T09:10:00.000Z', message: { content: [{ text: 'working line 403' }] } }),
    JSON.stringify({ timestamp: '2026-08-23T09:17:40.719Z', isApiErrorMessage: true, message: { content: [{ text: "You've hit your session limit · resets 2pm (Europe/Belgrade)" }] } }),
  ].join('\n') + '\n')
  writeFileSync(join(taskDir, 'usage', 'builder.jsonl'), `${JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: transcript })}\n`)
  const frames = claudeRefusalFrames({ taskDir, role: 'builder' })
  assert.deepEqual(frames.map((row) => [row.member, row.source]), [['quota', 'claude']])
  assert.deepEqual(claudeRefusalFrames({ taskDir: join(root, 'empty'), role: 'builder' }), [])
})

test('refusal detail is guarded and refusal failures stay in the ledger vocabulary', () => {
  assert.match(providerConditionDetail({ message: 'wait ended', seatRefusal: 'quota' }), /^\[refusal:quota\] /)
  for (const value of ['not-a-member', '__proto__']) assert.equal(providerConditionDetail({ message: 'wait ended', seatRefusal: value }), 'wait ended')
  assert.equal(cellFailureKind({ stage: SEAT_REFUSAL_STAGE }), 'transport-error')
})

test('seatIo reprompts a rejection once, ends on the second, and journals other members', () => {
  withRepo({ dirty: false }, (fixture) => {
    const text = 'prompt_cache_retention is not supported on this model'
    const queue = [
      [{ at: 30_000, member: 'rejected', message: text, source: 'pi' }],
      [],
      [{ at: 90_000, member: 'rejected', message: text, source: 'pi' }],
    ]
    const sends = []
    const journal = []
    let clock = 0
    const io = seatIo({ members: { builder: { agent: 'pi', model: 'sonnet', transport: 'pane', surface_id: 'surface-builder' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock, sleep: (ms) => { clock += ms }, sendLine: (surface, line) => sends.push({ surface, line }),
      refusalFrames: () => queue.shift() || [], logLine: (_path, row) => journal.push(row), existsSync: () => false,
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    let thrown
    try { io.wait(assignment.returnPath, 300) } catch (err) { thrown = err }
    assert.equal(sends.length, 2)
    assert.equal(sends[0].line, sends[1].line)
    assert.equal(thrown?.stage, SEAT_REFUSAL_STAGE)
    assert.match(thrown.message, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(journal.filter((row) => row.event === 'seat-refusal').length, 2)
  })
})

test('seatIo policy matrix acts on every refusal member without parking quota', () => {
  const refusal = (member, message) => [{ at: LIVENESS_PROBE_MS, member, message, source: 'pi' }]
  const run = ({ member, message, surface = 'surface-builder', timeoutS = 35 }) => withRepo({ dirty: false }, (fixture) => {
    let clock = 0
    let reads = 0
    const sends = []
    const journal = []
    const crew = { members: { builder: { agent: 'pi', model: 'sonnet', transport: 'pane', ...(surface ? { surface_id: surface } : {}) } } }
    const io = seatIo(crew, fixture.paths, fixture.repoDir, null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      sendLine: (id, line) => sends.push({ id, line }),
      refusalFrames: () => {
        reads += 1
        return reads === 1 ? refusal(member, message) : []
      },
      logLine: (_path, row) => journal.push(row),
      existsSync: () => false,
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    let thrown = null
    let env = null
    try { env = io.wait(assignment.returnPath, timeoutS) } catch (err) { thrown = err }
    return { clock, env, thrown, sends, resends: sends.slice(1), journal }
  })

  const quotaText = "You've hit your session limit · resets 3pm (Europe/Belgrade)"
  const quota = run({ member: 'quota', message: quotaText, timeoutS: 300 })
  assert.equal(quota.resends.length, 0)
  assert.equal(quota.thrown?.stage, SEAT_REFUSAL_STAGE)
  assert.ok(quota.thrown.message.includes(quotaText))
  assert.equal(quota.clock, LIVENESS_PROBE_MS)
  assert.equal(quota.journal.some((row) => row.event === 'seat-refusal' && row.outcome === 'ended'), true)
  assert.equal(quota.journal.some((row) => row.event === 'attention' || Object.hasOwn(row, 'park_id')), false)

  const declined = run({ member: 'rejected', message: 'prompt_cache_retention is not supported on this model', surface: null })
  assert.equal(declined.resends.length, 0)
  assert.equal(declined.thrown, null)
  assert.equal(declined.env, null)
  assert.deepEqual(declined.journal.find((row) => row.event === 'seat-refusal'), {
    event: 'seat-refusal', role: 'builder', id: 'd1', member: 'rejected', source: 'pi',
    message: 'prompt_cache_retention is not supported on this model', at: LIVENESS_PROBE_MS,
    outcome: 'declined', why: 'no surface_id', channel: 'record',
  })

  for (const [member, message] of [
    ['transient', 'WebSocket error'],
    ['suspended', 'API Error: Your computer went to sleep mid-response.'],
  ]) {
    const journalOnly = run({ member, message })
    assert.equal(journalOnly.resends.length, 0)
    assert.equal(journalOnly.thrown, null)
    assert.equal(journalOnly.env, null)
    assert.equal(journalOnly.clock, 35_000)
    assert.equal(journalOnly.journal.some((row) => row.event === 'seat-refusal' && row.member === member && row.outcome === 'journalled'), true)
  }

  const overflowed = run({ member: 'overflowed', message: 'context_length_exceeded' })
  assert.equal(overflowed.resends.length, 0)
  assert.equal(overflowed.thrown, null)
  assert.equal(overflowed.journal.some((row) => row.event === 'seat-refusal' && row.member === 'overflowed' && row.news === 'first-occurrence'), true)
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

    const listed = execFileSync('git', [
      'grep', '-l', '-e', 'providerCondition', '-e', 'PROVIDER_CONDITIONS', '-e', 'recogniseProviderCondition', '--', 'crew/', 'scripts/', 'visualizer/',
    ], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).sort()
    assert.deepEqual(listed, [
      'crew/headless.mjs', 'crew/headless.test.mjs', 'crew/seat-io-runclean.test.mjs', 'crew/seat-io.mjs',
    ])
    const seatIoSource = readFileSync(join(ROOT, 'crew/seat-io.mjs'), 'utf8')
    const executable = seatIoSource.replace(/\/\/.*$/gm, '')
    for (const pattern of [/overloaded_error/, /rate_limit_error/, /authentication_error/, /\b529\b/, /\b429\b/]) {
      assert.doesNotMatch(executable, pattern)
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

function makeRetryHarness({ transport = 'pane', screen = () => '529 Overloaded · Retrying in 6s · attempt 8/10', envelopeVisible = () => false, envelopeBody = () => JSON.stringify({ status: 'done' }), refusalFrames = null } = {}) {
  const root = scratchDir('seat-retry-transitions-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const logs = []; const events = []; const sends = []
  const box = { clock: 0, reads: 0, returnPath: null, envelope: false }
  const returnFile = join(paths.returnsDir, 'd1.lead.json')
  let workerBin = null
  let priorWorkerBin = null
  const member = transport === HEADLESS_TRANSPORT
    ? { transport, agent: 'claude' }
    : { surface_id: 'surface-lead', transport: 'pane', agent: 'claude' }
  const deps = {
    now: () => box.clock,
    sleep: (ms) => { box.clock += ms },
    sendLine: (surface, line) => sends.push({ surface, line }),
    assignmentLine: () => 'assignment',
    logLine: (_path, row) => logs.push(row),
    existsSync: (path) => path === box.returnPath ? envelopeVisible(box) : existsSync(path),
    readFileSync: (path, enc) => path === box.returnPath ? envelopeBody(box) : readFileSync(path, enc),
  }
  if (transport === 'pane') {
    deps.cmux = (verb) => {
      if (verb !== 'read-screen') return { ok: true, stdout: '' }
      box.reads += 1
      return { ok: true, stdout: screen(box) }
    }
    deps.tree = () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-lead' }] }] }] }] })
    deps.locate = (_tree, id) => id === 'surface-lead'
    if (refusalFrames) deps.refusalFrames = refusalFrames
  } else {
    // `io.assign` resolves the frozen worker binary BEFORE it consults
    // deps.headlessIo, so a machine without a claude install cannot reach the
    // injected seam at all — CI runners have none, and this test is about the
    // retry transition, not about binary resolution. Stub it the way
    // crew/crew.test.mjs:550 does, and restore in cleanup().
    workerBin = join(root, 'stub-claude')
    writeFileSync(workerBin, '')
    priorWorkerBin = process.env.CREW_CLAUDE_BIN
    process.env.CREW_CLAUDE_BIN = workerBin
    deps.headlessIo = () => ({
      assign: () => ({ id: 'd1', returnPath: returnFile }),
      wait: () => null,
    })
  }
  const io = seatIo({ members: { lead: member } }, paths, process.cwd(), null, null, {}, deps)
  io.emit = (event) => events.push(event)
  const assignment = io.assign({ role: 'lead', briefFile: '/tmp/brief.md' })
  box.returnPath = assignment.returnPath
  return { io, logs, events, sends, box, returnPath: box.returnPath, cleanup: () => {
    if (workerBin !== null) {
      if (priorWorkerBin === undefined) delete process.env.CREW_CLAUDE_BIN
      else process.env.CREW_CLAUDE_BIN = priorWorkerBin
    }
    rmSync(root, { recursive: true, force: true })
  } }
}

const MALFORMED_REASK = '{"assignment_id":"d1","role":"builder","status":"done","summary":"finished\nthe build"}'
const MALFORMED_REASK_2 = '{"assignment_id":"d1","role":"builder","status":"done","summary":"second\ntry"}'
const VALID_REASK = JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done', summary: 'finished the build', artifacts: [], details: {} })

function makeTransportReaskHarness({ transport = HEADLESS_TRANSPORT, waits = [], assignFails = [] } = {}) {
  const root = scratchDir(`seat-transport-reask-${transport}-`)
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const workerBin = join(root, 'stub-claude')
  writeFileSync(workerBin, '')
  const logs = []; const events = []; const assigns = []
  let clock = 0; let waitIndex = 0
  const transportIo = {
    assign(spec) {
      assigns.push(spec)
      const failure = assignFails[assigns.length - 1]
      if (failure) throw failure
      const id = spec?.reask?.id || `d${assigns.length}`
      const returnPath = spec?.reask?.returnPath || join(paths.returnsDir, `${id}.builder.json`)
      return { id, returnPath }
    },
    wait(path) {
      const step = waits[waitIndex++]
      if (typeof step !== 'function') throw new Error(`no scripted wait for ${path}`)
      return step(path)
    },
    teardown() { return [] },
  }
  const crew = {
    checkout: root,
    claude_bin: workerBin,
    members: { builder: { model: 'sonnet', transport } },
  }
  const deps = {
    now: () => clock,
    sleep: (ms) => { clock += ms },
    logLine: (_path, row) => logs.push(row),
    ...(transport === HEADLESS_RPC_TRANSPORT ? { headlessRpcIo: () => transportIo } : { headlessIo: () => transportIo }),
  }
  const io = seatIo(crew, paths, root, null, null, {}, deps)
  io.emit = (event) => events.push(event)
  const first = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
  const reaskPath = join(paths.returnsDir, `${first.id}.reask.builder.json`)
  return { root, paths, crew, io, first, reaskPath, assigns, logs, events, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function parseReaskFailure(stage, raw = MALFORMED_REASK) {
  const error = new Error(`unusable envelope from ${stage}`)
  error.stage = stage; error.role = 'builder'; error.raw = raw
  return error
}
function stagedReaskFailure(stage, message = stage) {
  const error = new Error(message)
  error.stage = stage; error.role = 'builder'
  return error
}

test('both pane waits journal the retry transition and the wait exit retires it', () => {
  const ordinary = makeRetryHarness({
    envelopeVisible: (box) => box.envelope,
    screen: (box) => { if (box.reads === 1) box.envelope = true; return '529 Overloaded · Retrying in 6s · attempt 8/10' },
  })
  try {
    assert.deepEqual(ordinary.io.wait(ordinary.returnPath, 120), { status: 'done' })
    assert.equal(ordinary.box.reads, 1)
    assert.equal(ordinary.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(ordinary.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { ordinary.cleanup() }

  const malformed = makeRetryHarness({ envelopeVisible: () => true, envelopeBody: () => '{', screen: () => '529 Overloaded · Retrying in 6s · attempt 8/10' })
  try {
    assert.throws(() => malformed.io.wait(malformed.returnPath, 40), /unparseable|unusable|envelope/i)
    assert.ok(malformed.box.reads >= 1)
    assert.equal(malformed.logs.filter((row) => row.event === 'envelope-reask').length >= 1, true)
    assert.equal(malformed.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(malformed.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { malformed.cleanup() }

  const throwing = makeRetryHarness({
    refusalFrames: () => [{ at: 30_000, member: 'quota', message: 'session limit', source: 'claude' }],
  })
  try {
    assert.throws(() => throwing.io.wait(throwing.returnPath, 60), /seat refused/)
    assert.equal(throwing.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(throwing.logs.filter((row) => row.event === 'seat-retry-cleared').length, 1)
  } finally { throwing.cleanup() }

  const headless = makeRetryHarness({ transport: HEADLESS_TRANSPORT })
  try {
    assert.equal(headless.io.wait(headless.returnPath, 60), null)
    assert.equal(headless.logs.some((row) => row.event === 'seat-retrying' || row.event === 'seat-retry-cleared'), false)
  } finally { headless.cleanup() }

  const climbing = makeRetryHarness({
    screen: (box) => `529 Overloaded · Retrying in 6s · attempt ${box.reads === 1 ? 8 : 10}/10`,
  })
  try {
    assert.equal(climbing.io.wait(climbing.returnPath, 61), null)
    assert.equal(climbing.logs.filter((row) => row.event === 'seat-retrying').length, 1)
    assert.equal(climbing.io.waitDiagnosis(climbing.returnPath).state, 'retrying')
    assert.ok(climbing.io.waitDiagnosis(climbing.returnPath).text.includes('attempt 10/10'))
  } finally { climbing.cleanup() }
})

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
    { kind: 'unusable-envelope', transport: HEADLESS_TRANSPORT, surfaceId: null, alive: null, asked: false }
  ]
  for (const args of refusals) {
    const result = reaskDecision(args)
    assert.equal(result.ask, false)
    assert.match(result.why, /\S/)
  }
  assert.equal(reaskDecision({ kind: 'unusable-envelope', transport: 'pane', surfaceId: 'surface-builder', alive: true, asked: false }).ask, true)
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    assert.equal(reaskDecision({ kind: 'unusable-envelope', transport, surfaceId: null, alive: null, asked: false, reassignable: true }).ask, true)
  }
})

test('a headless-json seat gets exactly one re-ask carrying the original assignment id, and a valid second envelope continues the run', () => {
  const harness = makeTransportReaskHarness({
    transport: HEADLESS_TRANSPORT,
    waits: [
      () => { throw parseReaskFailure('headless-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.assigns[1].reask.id, harness.first.id)
    assert.equal(harness.assigns[1].reask.returnPath, harness.reaskPath)
    assert.equal(harness.events.filter((event) => event.kind === 'cell-failure').length, 1)
  } finally { harness.cleanup() }
})

test("a headless-rpc seat's re-ask is delegated to its transport io", () => {
  const harness = makeTransportReaskHarness({
    transport: HEADLESS_RPC_TRANSPORT,
    waits: [
      () => { throw parseReaskFailure('rpc-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(harness.assigns.length, 2)
    assert.equal(harness.assigns[1].reask.id, harness.first.id)
    assert.equal(harness.assigns[1].reask.returnPath, harness.reaskPath)
  } finally { harness.cleanup() }
})

test('the re-ask bound holds on every transport', () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({
      transport,
      waits: [
        () => { throw parseReaskFailure(stage) },
        () => { throw parseReaskFailure(stage, MALFORMED_REASK_2) },
      ],
    })
    try {
      let first
      try { harness.io.wait(harness.first.returnPath, 600) } catch (error) { first = error }
      assert.ok(first)
      assert.match(first.message, /re-ask attempted/)
      assert.match(first.message, /second envelope is still unparseable/)
      assert.equal(harness.assigns.length, 2)
      assert.throws(() => harness.io.wait(harness.first.returnPath, 600))
      assert.equal(harness.assigns.length, 2)
    } finally { harness.cleanup() }
  }
})

test('every delivery attempt is journalled with its ordinal', () => {
  const busy = stagedReaskFailure('headless-session-busy', 'seat is still busy')
  const harness = makeTransportReaskHarness({
    waits: [
      () => { throw parseReaskFailure('headless-parse-error') },
      () => JSON.parse(VALID_REASK),
    ],
    assignFails: [null, busy],
  })
  try {
    assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.deepEqual(rows.map((row) => [row.outcome, row.attempt]), [['busy', 1], ['sent', 2], ['recovered', undefined]])
    assert.ok(rows.every((row) => row.transport === HEADLESS_TRANSPORT))
  } finally { harness.cleanup() }
})

test('a seat that never settles fails the run after the named bound', () => {
  const busy = stagedReaskFailure('headless-session-busy', 'seat is still busy')
  const harness = makeTransportReaskHarness({
    waits: [() => { throw parseReaskFailure('headless-parse-error') }],
    assignFails: [null, ...Array.from({ length: REASK_SETTLE_POLLS + 1 }, () => busy)],
  })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    assert.equal(harness.assigns.length, REASK_SETTLE_POLLS + 2)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.filter((row) => row.outcome === 'busy').length, REASK_SETTLE_POLLS)
    const terminal = rows.at(-1)
    assert.deepEqual([terminal.outcome, terminal.attempt], ['undelivered', REASK_SETTLE_POLLS + 1])
    assert.equal(terminal.transport, HEADLESS_TRANSPORT)
  } finally { harness.cleanup() }
})

test('every envelope-reask row names its transport', () => {
  withRepo({ dirty: false }, (fixture) => {
    const logs = []; let sends = 0; let returnPath = null
    const io = seatIo({ members: { builder: { transport: 'pane', surface_id: 'surface-builder' } } }, fixture.paths, fixture.repoDir, null, null, {}, {
      logLine: (_path, row) => logs.push(row),
      sendLine: () => { sends += 1; if (sends === 2) writeFileSync(returnPath, VALID_REASK) },
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
    })
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }); returnPath = assignment.returnPath
    writeFileSync(returnPath, MALFORMED_REASK)
    assert.deepEqual(io.wait(returnPath, 600), JSON.parse(VALID_REASK))
    assert.equal(logs.filter((row) => row.event === 'envelope-reask').every((row) => row.transport === 'pane'), true)
  })

  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({ transport, waits: [() => { throw parseReaskFailure(stage) }, () => JSON.parse(VALID_REASK)] })
    try {
      harness.io.wait(harness.first.returnPath, 600)
      assert.equal(harness.logs.filter((row) => row.event === 'envelope-reask').every((row) => row.transport === transport), true)
    } finally { harness.cleanup() }
  }
})

test("a transport re-ask leaves the seat's own return file byte-identical", () => {
  for (const transport of [HEADLESS_TRANSPORT, HEADLESS_RPC_TRANSPORT]) {
    const stage = transport === HEADLESS_RPC_TRANSPORT ? 'rpc-parse-error' : 'headless-parse-error'
    const harness = makeTransportReaskHarness({ transport, waits: [() => { throw parseReaskFailure(stage) }, () => JSON.parse(VALID_REASK)] })
    try {
      writeFileSync(harness.first.returnPath, MALFORMED_REASK)
      const before = readFileSync(harness.first.returnPath, 'utf8')
      assert.deepEqual(harness.io.wait(harness.first.returnPath, 600), JSON.parse(VALID_REASK))
      assert.equal(readFileSync(harness.first.returnPath, 'utf8'), before)
      assert.notEqual(harness.assigns[1].reask.returnPath, harness.first.returnPath)
    } finally { harness.cleanup() }
  }
})

test('a second failure that is not a parse failure is journalled as failed', () => {
  const harness = makeTransportReaskHarness({ waits: [
    () => { throw parseReaskFailure('headless-parse-error') },
    () => { throw stagedReaskFailure('headless-timeout', 'headless timeout') },
  ] })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.ok(error)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.some((row) => row.outcome === 'unparseable-again'), false)
    const failed = rows.find((row) => row.outcome === 'failed')
    assert.deepEqual({ failure: failed.failure, second: failed.second }, { failure: 'timeout', second: 'headless-timeout' })
    assert.match(error.message, /is not JSON this driver can read|unusable envelope/)
  } finally { harness.cleanup() }
})

test('a seat refusal on the re-ask writes its terminal row before it is rethrown', () => {
  const refusal = stagedReaskFailure(SEAT_REFUSAL_STAGE, 'provider refused')
  const harness = makeTransportReaskHarness({ waits: [
    () => { throw parseReaskFailure('headless-parse-error') },
    () => { throw refusal },
  ] })
  try {
    let error
    try { harness.io.wait(harness.first.returnPath, 600) } catch (err) { error = err }
    assert.equal(error, refusal)
    const rows = harness.logs.filter((row) => row.event === 'envelope-reask')
    assert.equal(rows.at(-1).outcome, 'failed')
    assert.equal(rows.at(-1).second, SEAT_REFUSAL_STAGE)
  } finally { harness.cleanup() }
})

test('a transport this build never enrolled is refused a re-ask', () => {
  const harness = makeTransportReaskHarness({ waits: [() => { throw parseReaskFailure('headless-parse-error') }] })
  try {
    harness.crew.members.builder.transport = 'some-future-transport'
    assert.throws(() => harness.io.wait(harness.first.returnPath, 600))
    assert.equal(harness.assigns.length, 1)
    const declined = harness.logs.find((row) => row.event === 'envelope-reask' && row.outcome === 'declined')
    assert.equal(declined.transport, 'some-future-transport')
  } finally { harness.cleanup() }
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

test('recogniseProviderRetry reads the measured retry banner and nothing else', () => {
  const banner = `${String.fromCharCode(27)}[31m529 Overloaded${String.fromCharCode(27)}[39m · Retrying in 6s · attempt 8/10`
  assert.deepEqual(recogniseProviderRetry(banner), {
    retry_in_s: 6, attempt: 8, of: 10, condition: 'overloaded',
  })
  assert.equal(recogniseProviderRetry('Adjudicating (esc to interrupt · 142s)'), null)
  assert.equal(recogniseProviderRetry('529 Overloaded · attempt 8/10'), null)
  assert.equal(recogniseProviderRetry(null), null)
})

test('paneRetryFrame degrades to null for an absent surface, a failed read and a throw', () => {
  const banner = '529 Overloaded · Retrying in 6s · attempt 8/10'
  assert.deepEqual(paneRetryFrame('surface-builder', { cmux: () => ({ ok: true, stdout: banner }) }), {
    retry_in_s: 6, attempt: 8, of: 10, condition: 'overloaded',
  })
  assert.equal(paneRetryFrame(null, { cmux: () => ({ ok: true, stdout: banner }) }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => ({ ok: false, stdout: banner }) }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => { throw new Error('EPERM') } }), null)
  assert.equal(paneRetryFrame('surface-builder', { cmux: () => ({ ok: true, stdout: '' }) }), null)
})

test('waitState names a retrying seat above a stale one and leaves the other states alone', () => {
  const at = 2_000_000
  const retry = { retry_in_s: 6, attempt: 10, of: 10, condition: 'overloaded' }
  const verdict = waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400, retry })
  assert.equal(verdict.state, 'retrying')
  assert.match(verdict.text, /RETRYING/)
  assert.ok(verdict.text.includes('attempt 10/10'))
  assert.equal(waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 }).state, 'stale')
  assert.equal(waitState({ role: 'builder', latest: at - 1000, refusal: { member: 'transient', message: 'WebSocket error' }, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: at - 1000, refusal: null, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: null, refusal: null, at, timeoutS: 2400, retry: null }), null)
})

test('a stale condition survives a timeout and is retired only by measured growth', () => {
  withTranscriptSeat({ timeoutS: 31, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: -1_000_000 }) }, ({ logs, env }) => {
    assert.equal(env, null)
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 0)
  })

  withTranscriptSeat({
    timeoutS: 61, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at >= 45_000 ? at - 1000 : -1_000_000 }),
  }, ({ logs, env }) => {
    assert.equal(env, null)
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 1)
  })

  withTranscriptSeat({
    timeoutS: 60, envelopeAt: 35_000, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: () => ({ mtimeMs: -1_000_000 }),
  }, ({ logs, env }) => {
    assert.deepEqual(env, { status: 'done' })
    assert.equal(logs.filter((row) => row.event === 'seat-stale').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-stale-cleared').length, 1)
  })
})

test('waitState names stale, refused and working states and stays silent without growth', () => {
  const at = 2_000_000
  const stale = waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 })
  assert.equal(stale.state, 'stale')
  assert.match(stale.text, /1000s ago/)
  assert.match(stale.text, /a spinner and an elapsed timer are not evidence of life/)
  const refused = waitState({ role: 'builder', latest: at - 1000, refusal: { member: 'suspended', message: 'computer went to sleep' }, at, timeoutS: 2400 })
  assert.equal(refused.state, 'refused')
  assert.match(refused.text, /computer went to sleep/)
  const working = waitState({ role: 'builder', latest: at - 500_000, refusal: null, at, timeoutS: 2400 })
  assert.equal(working.state, 'working')
  assert.match(working.text, /2400s budget/)
  assert.equal(waitState({ role: 'builder', latest: null, refusal: null, at, timeoutS: 2400 }), null)
  for (const row of SEAT_REFUSALS) {
    const verdict = waitState({ role: 'builder', latest: at - 1000, refusal: { member: row.member, message: 'named condition' }, at, timeoutS: 2400 })
    assert.equal(verdict.state, row.terminal ? 'refused' : 'working')
  }
})

test('waitState expires terminal refusal readings at the measured boundary', () => {
  const at = 2_000_000
  const verdict = (age, refusal = {}) => waitState({
    role: 'builder', latest: at - 1000,
    refusal: { member: 'suspended', message: 'computer went to sleep', ...refusal },
    at, timeoutS: 2400,
  })
  assert.equal(verdict(300_000, { at: at - 300_000 }).state, 'working')
  assert.equal(verdict(299_999, { at: at - 299_999 }).state, 'refused')
  assert.equal(verdict(null).state, 'refused')
})

test('waitState never names an unclassified refusal frame', () => {
  const at = 2_000_000
  for (const member of [null, 'overloaded', undefined]) {
    const refusal = { member, message: 'something the closed vocabulary does not match' }
    const fresh = waitState({ role: 'builder', latest: at - 1000, refusal, at, timeoutS: 2400 })
    assert.equal(fresh.state, 'working')
    assert.doesNotMatch(fresh.text, /refused|unclassified/i)
    assert.equal(waitState({ role: 'builder', latest: null, refusal, at, timeoutS: 2400 }), null)
  }
})

test('waitState uses the measured 900-second threshold at both arms', () => {
  assert.equal(TRANSCRIPT_STALE_MS, 900_000)
  const at = 2_000_000
  assert.equal(waitState({ role: 'builder', latest: at - 500_000, refusal: null, at, timeoutS: 2400 }).state, 'working')
  assert.equal(waitState({ role: 'builder', latest: at - 1_000_000, refusal: null, at, timeoutS: 2400 }).state, 'stale')
  assert.equal(waitState({ role: 'builder', latest: at - TRANSCRIPT_STALE_MS, refusal: null, at, timeoutS: 2400 }).state, 'stale')
})

test('transcriptGrowth chooses the newest readable mtime and refuses to guess', () => {
  const stat = (path) => ({ mtimeMs: path === '/x/a.jsonl' ? 1000 : 5000 })
  assert.equal(transcriptGrowth(['/x/a.jsonl', '/x/b.jsonl'], { statSync: stat }), 5000)
  assert.equal(transcriptGrowth(['/x/b.jsonl', '/x/a.jsonl'], { statSync: stat }), 5000)
  assert.equal(transcriptGrowth(['/x/a.jsonl'], { statSync: () => { throw new Error('EPERM') } }), null)
  assert.equal(transcriptGrowth('not-an-array', { statSync: stat }), null)
  assert.equal(transcriptGrowth(['/x/a.jsonl', '/x/b.jsonl'], { statSync: (path) => ({ mtimeMs: path === '/x/a.jsonl' ? Number.NaN : 5000 }) }), 5000)
})

test('waitForEnvelope samples transcript growth on each liveness tick without changing the wait', () => {
  const run = (growth) => {
    let clock = 0; let probes = 0; const seen = []; const aliveAt = []
    const options = {
      returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder',
      readEnvelope: () => (probes >= 4 ? { status: 'done' } : null),
      probeSeat: () => { probes += 1; return true }, onAlive: (at) => aliveAt.push(at), now: () => clock,
      sleep: (ms) => { clock += ms },
    }
    if (growth) { options.sampleGrowth = () => 4242; options.onGrowth = (record) => seen.push(record) }
    const env = waitForEnvelope(options)
    return { env, aliveAt, probes, seen }
  }
  const plain = run(null)
  const measured = run(true)
  assert.deepEqual({ env: measured.env, aliveAt: measured.aliveAt, probes: measured.probes }, { env: plain.env, aliveAt: plain.aliveAt, probes: plain.probes })
  assert.deepEqual(measured.seen, [1, 2, 3, 4].map((n) => ({ at: n * LIVENESS_PROBE_MS, latest: 4242 })))

  let clock = 0; let probes = 0
  const env = waitForEnvelope({
    returnPath: '/tmp/return.json', timeoutS: 600, role: 'builder', readEnvelope: () => (probes >= 1 ? { status: 'done' } : null),
    probeSeat: () => { probes += 1; return true }, sampleGrowth: () => { throw new Error('interrupted stat') },
    onGrowth: () => { throw new Error('growth callback is not load-bearing') }, now: () => clock, sleep: (ms) => { clock += ms },
  })
  assert.deepEqual(env, { status: 'done' })
})

function withTranscriptSeat({ start = 0, timeoutS = 2000, transcriptPaths, statSync, refusalFrames, sendLine, envelopeAt, surfaceId = 'surface-builder', transportAt = null }, body) {
  const root = scratchDir('seat-transcript-growth-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  let clock = start; let returnPath = null; let envelopeWritten = false
  const logs = []; const events = []
  const member = { ...(surfaceId ? { surface_id: surfaceId } : {}), transport: 'pane', agent: 'claude' }
  const crew = { members: { builder: member } }
  const envelopeReady = () => {
    if (typeof envelopeAt === 'function') {
      try { return envelopeAt(clock) === true } catch { return false }
    }
    return Number.isFinite(envelopeAt) && clock >= envelopeAt
  }
  const deps = {
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      if (!envelopeWritten && returnPath && envelopeReady()) {
        writeFileSync(returnPath, JSON.stringify({ status: 'done' }))
        envelopeWritten = true
      }
    },
    sendLine: (surface, line) => { if (sendLine) sendLine(surface, line, clock) },
    logLine: (_path, row) => logs.push(row),
    tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: surfaceId }] }] }] }] }),
    locate: (_tree, id) => id === surfaceId,
    existsSync: (path) => path === returnPath ? envelopeWritten : (typeof path === 'string' && existsSync(path)),
  }
  if (transcriptPaths) deps.transcriptPaths = transcriptPaths
  if (statSync === true) deps.statSync = () => ({ mtimeMs: clock })
  else if (statSync) deps.statSync = (path) => statSync(path, clock)
  if (refusalFrames) deps.refusalFrames = (context) => {
    if (Number.isFinite(transportAt) && clock >= transportAt) member.transport = 'headless-json'
    return refusalFrames(context)
  }
  try {
    const io = seatIo(crew, paths, process.cwd(), null, null, {}, deps)
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    returnPath = assignment.returnPath
    const env = io.wait(returnPath, timeoutS)
    return body({ io, paths, logs, events, env, assignment, clock: () => clock })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('waitForEnvelope consumes an envelope written at the deadline and times out after it', () => {
  withTranscriptSeat({ timeoutS: 30, envelopeAt: 30_000 }, ({ env, events }) => {
    assert.deepEqual(env, { status: 'done' })
    assert.equal(events.some((event) => event.kind === 'cell-failure' && event.failure === 'timeout'), false)
  })

  withTranscriptSeat({ timeoutS: 30, envelopeAt: 35_000 }, ({ env, events, assignment }) => {
    assert.equal(env, null)
    assert.equal(events.some((event) => event.kind === 'cell-failure' && event.failure === 'timeout'), true)
    assert.equal(events.some((event) => event.detail?.includes(`no envelope at ${assignment.returnPath}`)), true)
  })
})

test('silenceReaskDecision gates one quiet re-send on measured transcript growth', () => {
  const frameAt = 1_000_000
  assert.equal(SILENCE_REASK_MS, 300_000)
  assert.ok(SILENCE_REASK_MS < TRANSCRIPT_STALE_MS)
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt, at: frameAt + SILENCE_REASK_MS - 1 }).act, 'wait')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt, at: frameAt + SILENCE_REASK_MS }).act, 'reask')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt + 1, at: frameAt + SILENCE_REASK_MS }).act, 'none')
  assert.equal(silenceReaskDecision({ frameAt: Number.NaN, latest: null, at: frameAt + SILENCE_REASK_MS }).act, 'none')
  assert.equal(silenceReaskDecision({ frameAt, latest: null, at: frameAt + 1 + SILENCE_REASK_MS, sentAt: frameAt + 1 }).act, 'still-silent')
  assert.equal(silenceReaskDecision({ frameAt, latest: frameAt + 2, at: frameAt + SILENCE_REASK_MS, sentAt: frameAt + 1 }).act, 'revived')
  assert.notEqual(silenceReaskDecision({ frameAt, latest: null, at: frameAt + SILENCE_REASK_MS * 10, sentAt: frameAt + 1 }).act, 'reask')
})

test('an unclassified refusal plus frozen transcript is re-sent exactly once at the quiet threshold', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 600, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 2)
    assert.equal(sends[1].line, sends[0].line)
    assert.equal(sends[1].at, 30_000 + SILENCE_REASK_MS)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent').length, 1)
  })
})

test('a second silence after the bounded re-send is journalled without another re-send', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 700, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 2)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent').length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'still-silent').length, 1)
  })
})

test('a seat still producing transcript frames is never re-sent', () => {
  let seen = false
  const sends = []
  withTranscriptSeat({
    timeoutS: 600, transcriptPaths: () => ['/x/builder.jsonl'], statSync: true,
    sendLine: (surface, line, at) => sends.push({ surface, line, at }),
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(sends.length, 1)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'growing').length, 1)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask' && row.outcome === 'sent'), false)
  })
})

test('a revived seat gets a fresh wait budget after the silence re-send', () => {
  let seen = false
  let resentAt = null
  const sends = []
  withTranscriptSeat({
    timeoutS: 2_000, envelopeAt: 2_100_000,
    transcriptPaths: () => ['/x/builder.jsonl'], statSync: (_path, at) => ({ mtimeMs: resentAt !== null && at > resentAt ? at : 0 }),
    sendLine: (surface, line, at) => {
      sends.push({ surface, line, at })
      if (sends.length === 2) resentAt = at
    },
    refusalFrames: () => {
      if (seen) return []
      seen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs, env }) => {
    assert.ok(2_100_000 > 2_000_000)
    assert.deepEqual(env, { status: 'done' })
    assert.equal(sends.length, 2)
    assert.equal(logs.filter((row) => row.event === 'seat-silence-reask' && row.outcome === 'revived').length, 1)
  })
})

test('classified refusal actions remain immediate or journal-only', () => {
  let transientSeen = false
  const transientSends = []
  withTranscriptSeat({
    timeoutS: 35, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => transientSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (transientSeen) return []
      transientSeen = true
      return [{ at: 30_000, member: 'transient', message: 'WebSocket error', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(transientSends.length, 1)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask'), false)
  })

  let rejectedSeen = false
  const rejectedSends = []
  withTranscriptSeat({
    timeoutS: 35, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => rejectedSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (rejectedSeen) return []
      rejectedSeen = true
      return [{ at: 30_000, member: 'rejected', message: 'model not found', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(rejectedSends.length, 2)
    assert.equal(rejectedSends[1].at, 30_000)
    assert.equal(logs.some((row) => row.event === 'seat-silence-reask'), false)
  })
})

test('silence re-send declines without a surface or on a non-pane transport', () => {
  let noSurfaceSeen = false
  const noSurfaceSends = []
  withTranscriptSeat({
    surfaceId: null, timeoutS: 400, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => noSurfaceSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (noSurfaceSeen) return []
      noSurfaceSeen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(noSurfaceSends.length, 1)
    const declined = logs.find((row) => row.event === 'seat-silence-reask' && row.outcome === 'declined')
    assert.equal(declined?.why, 'no surface_id')
  })

  let nonPaneSeen = false
  const nonPaneSends = []
  withTranscriptSeat({
    transportAt: 30_000, timeoutS: 400, transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }),
    sendLine: (surface, line, at) => nonPaneSends.push({ surface, line, at }),
    refusalFrames: () => {
      if (nonPaneSeen) return []
      nonPaneSeen = true
      return [{ at: 30_000, member: null, message: 'API Error: Server error mid-response', source: 'claude' }]
    },
  }, ({ logs }) => {
    assert.equal(nonPaneSends.length, 1)
    const declined = logs.find((row) => row.event === 'seat-silence-reask' && row.outcome === 'declined')
    assert.equal(declined?.why, 'transport headless-json is not pane')
  })
})

test('seatIo names a stale pane at expiry and journals one warning', () => {
  withTranscriptSeat({ transcriptPaths: () => ['/x/builder.jsonl'], statSync: () => ({ mtimeMs: 0 }) }, ({ io, logs, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath).state, 'stale')
    assert.ok(events.find((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)))
    assert.equal(logs.filter((row) => row.event === 'seat-stale' && row.role === 'builder').length, 1)
  })
})

test('seatIo names a producing seat working and leaves an unmeasurable seat unnamed', () => {
  withTranscriptSeat({ transcriptPaths: () => ['/x/builder.jsonl'], statSync: true }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath).state, 'working')
    assert.match(events.find((event) => event.kind === 'cell-failure').detail, /the seat is WORKING:/)
  })

  withTranscriptSeat({ transcriptPaths: () => [] }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    assert.equal(io.waitDiagnosis(assignment.returnPath), null)
    assert.equal(events.find((event) => event.kind === 'cell-failure').detail, `no envelope at ${assignment.returnPath} within 2000s`)
  })
})

test('the shipped Claude transcript address chain measures a real aged transcript', () => {
  const root = scratchDir('seat-shipped-claude-')
  const taskDir = join(root, 'task'); const usageDir = join(taskDir, 'usage'); const transcript = join(root, 'session.jsonl')
  mkdirSync(usageDir, { recursive: true }); writeFileSync(transcript, '{}\n')
  const aged = (Date.now() - 1_000_000) / 1000; utimesSync(transcript, aged, aged)
  writeFileSync(join(usageDir, 'builder.jsonl'), `${JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: transcript })}\n`)
  try {
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'builder' }), [transcript])
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'absent' }), [])
    writeFileSync(join(usageDir, 'bad.jsonl'), ['not json', JSON.stringify({ session_id: 'bad', transcript_path: transcript }), JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', transcript_path: 'relative.jsonl' })].join('\n') + '\n')
    assert.deepEqual(claudeTranscriptPaths({ taskDir, role: 'bad' }), [])

    const start = Date.now(); const paths = { dir: root, taskDir, returnsDir: join(root, 'returns') }; mkdirSync(paths.returnsDir, { recursive: true })
    let clock = start; let returnPath = null; const events = []
    const io = seatIo({ members: { builder: { surface_id: 'surface-builder', transport: 'pane', agent: 'claude' } } }, paths, process.cwd(), null, null, {}, {
      now: () => clock, sleep: (ms) => { clock += ms }, sendLine: () => {},
      tree: () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{ id: 'surface-builder' }] }] }] }] }),
      locate: (_tree, id) => id === 'surface-builder',
      existsSync: (path) => path === returnPath ? false : (typeof path === 'string' && existsSync(path)),
    })
    io.emit = (event) => events.push(event)
    const assignment = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }); returnPath = assignment.returnPath
    assert.equal(io.wait(returnPath, 31), null)
    const verdict = io.waitDiagnosis(returnPath)
    assert.equal(verdict.state, 'stale'); assert.match(verdict.text, /10\d\ds ago/)
    assert.ok(events.some((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the shipped pi transcript address chain filters only jsonl files and degrades to empty', () => {
  const root = scratchDir('seat-shipped-pi-'); const home = join(root, 'home'); const checkout = '/tmp/pi-checkout'
  const sessions = piSessionDir(checkout, { home }); mkdirSync(sessions, { recursive: true })
  for (const name of ['session.jsonl', 'other.jsonl', 'sleep.log']) writeFileSync(join(sessions, name), '{}\n')
  try {
    const expected = readdirSync(sessions).filter((name) => name.endsWith('.jsonl')).map((name) => join(sessions, name))
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home } }), expected)
    assert.deepEqual(piTranscriptPaths({ checkout: '/tmp/missing-pi', deps: { home } }), [])
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home, existsSync: () => true, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }), [])
    assert.deepEqual(piTranscriptPaths({ checkout, deps: { home, existsSync: () => true, readdirSync: () => 'interrupted' } }), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a journalled transient refusal reaches expiry as evidence, not as the state', () => {
  let sent = false
  withTranscriptSeat({ start: 1_000_000_000_000, transcriptPaths: () => ['/x/builder.jsonl'], statSync: true, refusalFrames: () => {
    if (sent) return []
    sent = true
    return [{ at: 1_000_000_030_000, member: 'transient', message: 'Overloaded', source: 'claude' }]
  } }, ({ io, logs, events, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    assert.equal(verdict.state, 'working')
    assert.doesNotMatch(verdict.text, /REFUSED/)
    const timeout = events.find((event) => event.kind === 'cell-failure' && event.failure === 'timeout')
    assert.ok(timeout); assert.match(timeout.detail, /\[refusal:transient\]/); assert.match(timeout.detail, /the provider says: Overloaded/)
    assert.equal(logs.some((row) => row.event === 'seat-refusal' && row.outcome === 'journalled' && row.member === 'transient'), true)
  })
})

test('a recovered transient followed by a stale transcript remains stale', () => {
  let sent = false
  withTranscriptSeat({
    timeoutS: 61, transcriptPaths: () => ['/x/builder.jsonl'],
    statSync: (_path, at) => ({ mtimeMs: at < 45_000 ? at : at - TRANSCRIPT_STALE_MS }),
    refusalFrames: () => {
      if (sent) return []
      sent = true
      return [{ at: 30_000, member: 'transient', message: 'WebSocket error', source: 'claude' }]
    },
  }, ({ io, events, env, assignment }) => {
    assert.equal(env, null)
    const verdict = io.waitDiagnosis(assignment.returnPath)
    assert.equal(verdict.state, 'stale')
    assert.match(verdict.text, /the seat is STALE:/)
    assert.doesNotMatch(verdict.text, /the seat is WORKING:/)
    assert.equal(events.some((event) => event.kind === 'cell-failure' && /the seat is STALE:/.test(event.detail)), true)
  })
})

test('seatIo commit stages an ALREADY-STAGED deletion beside a modification', () => {
  const fixture = commitRepo('staged-del', ['gone.txt', 'mod.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    git(fixture.root, 'rm', '-q', 'gone.txt')
    const sha = fixture.io.commit(['gone.txt', 'mod.txt'], 'retire gone.txt')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['D gone.txt', 'M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit records an UNSTAGED worktree deletion', () => {
  const fixture = commitRepo('unstaged-del', ['gone.txt'])
  try {
    rmSync(join(fixture.root, 'gone.txt'))
    const sha = fixture.io.commit(['gone.txt'], 'retire gone.txt')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    assert.equal(git(fixture.root, 'ls-tree', '--name-only', 'HEAD', '--', 'gone.txt').trim(), '')
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit carries an add, a modify and both deletion shapes at once', () => {
  const fixture = commitRepo('mixed', ['mod.txt', 'staged-gone.txt', 'worktree-gone.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    writeFileSync(join(fixture.root, 'added.txt'), 'added\n')
    git(fixture.root, 'rm', '-q', 'staged-gone.txt')
    rmSync(join(fixture.root, 'worktree-gone.txt'))
    const scope = ['added.txt', 'mod.txt', 'staged-gone.txt', 'worktree-gone.txt']
    const sha = fixture.io.commit(scope, 'a mixed lane')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['A added.txt', 'D staged-gone.txt', 'D worktree-gone.txt', 'M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit stages nothing outside the lane\'s scope', () => {
  const fixture = commitRepo('fence', ['mod.txt', 'gone.txt', 'oos-dirty.txt', 'oos-gone.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    git(fixture.root, 'rm', '-q', 'gone.txt')
    writeFileSync(join(fixture.root, 'oos-dirty.txt'), 'dirtied out of scope\n')
    rmSync(join(fixture.root, 'oos-gone.txt'))
    const sha = fixture.io.commit(['mod.txt', 'gone.txt'], 'the b264 shape')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' ')).sort()
    assert.deepEqual(recorded, ['D gone.txt', 'M mod.txt'])
    const after = git(fixture.root, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).sort()
    assert.deepEqual(after, [' D oos-gone.txt', ' M oos-dirty.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit still refuses an empty scope with its verbatim message', () => {
  const fixture = commitRepo('empty', ['a.txt'])
  try {
    writeFileSync(join(fixture.root, 'untouched-by-scope.txt'), 'x\n')
    const before = git(fixture.root, 'status', '--porcelain')
    assert.throws(() => fixture.io.commit(['a.txt'], 'nothing here'), (error) => {
      assert.match(error.message, /^commit: nothing in scope actually changed — refusing an empty commit$/)
      return true
    })
    assert.equal(git(fixture.root, 'status', '--porcelain'), before)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit treats a scope of ONLY an already-staged deletion as a real change', () => {
  const fixture = commitRepo('only-del', ['gone.txt', 'other.txt'])
  try {
    git(fixture.root, 'rm', '-q', 'gone.txt')
    const sha = fixture.io.commit(['gone.txt'], 'only a deletion')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' '))
    assert.deepEqual(recorded, ['D gone.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('seatIo commit skips a planned-but-never-created path', () => {
  const fixture = commitRepo('never-created', ['mod.txt'])
  try {
    writeFileSync(join(fixture.root, 'mod.txt'), 'modified\n')
    const sha = fixture.io.commit(['mod.txt', 'planned/never-created.mjs'], 'a plan that named a file nobody wrote')
    assert.match(sha, /^[0-9a-f]{7,}$/)
    const recorded = git(fixture.root, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(Boolean).map((line) => line.replace('\t', ' '))
    assert.deepEqual(recorded, ['M mod.txt'])
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a seat waiting through a substrate outage is journalled and recovers', () => {
  const root = scratchDir('substrate-journal-')
  const paths = { dir: root, taskDir: join(root, 'task'), returnsDir: join(root, 'returns') }
  mkdirSync(paths.taskDir, { recursive: true }); mkdirSync(paths.returnsDir, { recursive: true })
  const crew = { members: { builder: { surface_id: 'surface-builder', transport: 'pane' } } }
  let clock = 0
  let returnPath = null
  const journal = []
  const priorBin = process.env.CREW_CLAUDE_BIN
  const restoreBin = () => {
    if (priorBin === undefined) delete process.env.CREW_CLAUDE_BIN
    else process.env.CREW_CLAUDE_BIN = priorBin
  }
  try {
    const io = seatIo(crew, paths, process.cwd(), null, null, {}, {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      tree: () => {
        const probe = Math.round(clock / LIVENESS_PROBE_MS)
        if (probe >= 1 && probe <= 4) throw new Error('pane manager unavailable')
        return { windows: [] }
      },
      locate: () => ({ id: 'surface-builder' }),
      sendLine: () => {},
      assignmentLine: () => 'assignment',
      cmux: () => ({ ok: false, stdout: '' }),
      logLine: (_path, row) => journal.push(row),
      existsSync: (path) => path === returnPath
        ? clock >= 6 * LIVENESS_PROBE_MS
        : existsSync(path),
      readFileSync: (path, ...args) => path === returnPath && clock >= 6 * LIVENESS_PROBE_MS
        ? JSON.stringify({ status: 'done' })
        : readFileSync(path, ...args),
    })
    process.env.CREW_CLAUDE_BIN = process.execPath
    let assignment
    try { assignment = io.assign({ role: 'builder', briefFile: join(root, 'brief.md') }) }
    finally { restoreBin() }
    returnPath = assignment.returnPath
    assert.deepEqual(io.wait(returnPath, 1200), { status: 'done' })
    const down = journal.filter((row) => row?.event === 'seat-substrate-down')
    const recovered = journal.filter((row) => row?.event === 'seat-substrate-recovered')
    assert.equal(down.length, 1)
    assert.equal(down[0].role, 'builder')
    assert.equal(down[0].grace_ms, SUBSTRATE_GRACE_MS)
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].misses, 4)
    assert.equal(recovered[0].grace_ms, SUBSTRATE_GRACE_MS)
  } finally {
    restoreBin()
    rmSync(root, { recursive: true, force: true })
  }
})

test('seatIo changedFiles keeps both sides of a rename', () => {
  const fixture = commitRepo('rename', ['old.txt', 'kept.txt'])
  try {
    git(fixture.root, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(fixture.root, 'kept.txt'), 'modified\n')
    const changed = fixture.io.changedFiles()
    assert.ok(changed.includes('new.txt'))
    assert.ok(changed.includes('old.txt'))
    assert.ok(changed.includes('kept.txt'))
    assert.equal(changed.length, 3)
    assert.equal(changed.indexOf('old.txt'), changed.indexOf('new.txt') + 1)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})
