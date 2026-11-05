import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ROOT, git, scratchDir } from '../../test/helpers.mjs'
import { runAcpSeat } from './seat.mjs'
import { parseAgent } from '../protocols.mjs'
import * as claude from '../adapters/adapter-claude.mjs'
import * as muse from '../adapters/adapter-muse.mjs'
import { loadCapabilities } from './grants.mjs'
import { loadAcceptedContext } from '../pi/extensions/skeletonread.ts'
import { loadContext as advisorContext } from '../pi/extensions/advisor.ts'

const FIXTURES = join(ROOT, 'test', 'fixtures', 'acp')
const BIN = process.execPath
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const normal = fixture('claude-turn')
const PERMISSION_OPTIONS = [
  { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
  { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
  { optionId: 'forever', kind: 'allow_always', name: 'Always allow' },
]
const runtimes = (runtimeRoot) => new Set(readdirSync(runtimeRoot).filter((name) => /^acp-seat-[A-Za-z0-9]{6}$/.test(name)))

function makeSkills(root, names = ['alpha', 'beta']) {
  return names.map((name) => {
    const path = join(root, name, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `---\nname: ${name}\ndescription: test skill\n---\n${name}`)
    writeFileSync(join(dirname(path), 'reference.txt'), `${name}-reference`)
    return path
  })
}

// Drives the real runner and acpClient from a recorded directional stream; no agent process exists.
async function replaySeat(name, options = {}) {
  const root = scratchDir('acp-seat-test-')
  const runtimeRoot = join(root, 'runtimes')
  mkdirSync(runtimeRoot)
  const records = fixture(name)
  const sent = []
  const launches = []
  const expected = []
  const plugins = []
  const museSkills = []
  const kills = []
  let stream = null
  let clock = 1000
  let groupGone = false
  let prompts = 0
  const sessionFile = options.unwritable ? root : join(root, 'sessions', 'session.jsonl')
  if (!options.unwritable) {
    mkdirSync(dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, '{"prior":true}\n')
  }
  const skills = options.skills ?? (options.grant ? makeSkills(root) : [])
  const isPi = name.startsWith('pi-')
  const definition = {
    agent: options.agent ?? (isPi ? 'pi' : 'claude'),
    model: options.model ?? (isPi ? 'openai/gpt-6.1-sol' : 'anthropic/claude-opus-4-6'),
    effort: options.effort ?? 'high', skills, ...options.definition,
  }
  const outgoing = (frame) => {
    sent.push(frame)
    if (frame.method === 'session/new') {
      for (const dir of frame.params?.additionalDirectories ?? []) {
        if (basename(dir) === 'muse-skills') museSkills.push({ dir, files: readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name, 'SKILL.md'), 'utf8')]) })
      }
      for (const entry of frame.params?._meta?.claudeCode?.options?.plugins ?? []) {
        const names = readdirSync(join(entry.path, 'skills')).sort()
        plugins.push({ entry, names, files: names.map((skill) => ({
          name: skill,
          skill: readFileSync(join(entry.path, 'skills', skill, 'SKILL.md'), 'utf8'),
          reference: existsSync(join(entry.path, 'skills', skill, 'reference.txt'))
            ? readFileSync(join(entry.path, 'skills', skill, 'reference.txt'), 'utf8') : null,
        })) })
      }
    }
    if (!Object.hasOwn(frame, 'id') || !frame.method) return
    if (frame.method === 'session/prompt' && (!options.permissionsOnlyFirst || prompts++ === 0)) {
      options.permissions?.forEach((toolCall, i) => {
        for (const update of [toolCall?._update].flat().filter(Boolean)) appendFileSync(stream, `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update } })}\n`)
        appendFileSync(stream, `${JSON.stringify({
          jsonrpc: '2.0', id: `permit-${i}`, method: 'session/request_permission',
          params: { sessionId: 'fixture', toolCall, options: toolCall?._options ?? PERMISSION_OPTIONS },
        })}\n`)
      })
    }
    if (options.writeError && frame.method === 'session/prompt') throw Object.assign(new Error('pipe broke'), { code: options.writeError })
    let source = records
    let index = source.findIndex((row) => row.dir === 'client->agent' && row.frame?.method === frame.method)
    if (index < 0 && frame.method === 'session/set_mode') {
      source = normal
      index = source.findIndex((row) => row.dir === 'client->agent' && row.frame?.method === frame.method)
    }
    if (index < 0) throw new Error(`unexpected client method ${frame.method}`)
    const recordedId = source[index].frame.id
    const responses = []
    for (let i = index + 1; i < source.length; i++) {
      const row = source[i]
      if (row.dir === 'client->agent' && Object.hasOwn(row.frame ?? {}, 'id') && row.frame?.method) break
      if (row.dir !== 'agent->client' || !row.frame) continue
      const copy = structuredClone(row.frame)
      if (!copy.method && copy.id === recordedId) copy.id = frame.id
      responses.push(copy)
    }
    if (options.unknown && frame.method === 'session/prompt') {
      const original = responses.find((row) => row.method === 'session/update')
      assert.ok(original, `${name} has a recorded update to clone`)
      const copy = structuredClone(original)
      copy.params.update.sessionUpdate = 'future_recorded_update'
      responses.splice(1, 0, copy)
    }
    if (frame.method === 'session/prompt' && options.usageUpdate) responses.unshift({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'usage_update', used: 500, size: 1000 } } })
    if (frame.method === 'session/prompt' && options.promptUsage) responses.find((response) => response.id === frame.id).result.usage = options.promptUsage
    for (const response of responses) {
      if (response.method === 'session/update') expected.push({ ...response.params, at: 1700000000123 })
      if (options.delayPrompt && frame.method === 'session/prompt' && !response.method) setImmediate(() => appendFileSync(stream, `${JSON.stringify(response)}\n`))
      else appendFileSync(stream, `${JSON.stringify(response)}\n`)
    }
  }
  const deps = {
    recordNow: () => 1700000000123,
    clientDeps: {
      pid: 900,
      spawn: (...args) => {
        launches.push(args)
        if (options.spawnThrows) throw new Error('spawn denied')
        writeFileSync(join(dirname(stream), 'pgid'), '901')
        return { pid: 901, unref() {} }
      },
      openSync: () => 7,
      writeSync: (_fd, buffer, offset = 0, length = buffer.length) => {
        const bytes = Buffer.from(buffer).subarray(offset, offset + length)
        for (const line of bytes.toString().split('\n').filter(Boolean)) outgoing(JSON.parse(line))
        return bytes.length
      },
      closeSync: () => {},
      existsSync: (path) => existsSync(path) || String(path).endsWith('cmd.fifo'),
      readFileSync: (path, ...args) => {
        if (String(path).endsWith('stream.jsonl')) stream = path
        return readFileSync(path, ...args)
      },
      mkdirSync: (path, opts) => {
        mkdirSync(path, opts)
        if (basename(dirname(path)) === 'acp') {
          stream = join(path, 'stream.jsonl')
          writeFileSync(stream, '')
        }
      },
      kill: (pid, signal) => {
        kills.push([pid, signal])
        if (pid !== -901) return true
        if (signal === 0) {
          if (groupGone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
          return true
        }
        if (stream && !options.noExit) { writeFileSync(join(dirname(stream), 'exit'), '0'); groupGone = true }
        return true
      },
      spawnSync: () => ({ status: 1, stdout: '' }),
      now: () => { clock += 1000; return clock },
      sleep: () => {},
      seatCommandRoot: join(root, 'seat-runtime'),
    },
    ...options.deps,
    runtimeRoot,
  }
  if (options.appendError) deps.appendFileSync = () => { throw Object.assign(new Error('denied'), { code: options.appendError }) }
  const before = runtimes(runtimeRoot)
  let result
  let error
  try {
    result = await runAcpSeat({
      definition, cwd: options.cwd ?? root, taskDir: options.taskDir, prompt: options.prompt ?? 'fixture prompt', sessionFile,
      binaries: options.binaries ?? { claudeAcp: BIN, claude: BIN, pi: BIN, muse: BIN }, deps })
  } catch (caught) { error = caught }
  const leftover = [...runtimes(runtimeRoot)].filter((dir) => !before.has(dir)).map((dir) => join(runtimeRoot, dir))
  const rows = options.unwritable ? [] : readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const replies = (options.permissions ?? []).map((_, i) => sent.find((frame) => frame.id === `permit-${i}` && !frame.method)?.result?.outcome ?? null)
  return { root, result, error, rows, expected, sent, replies, launches, plugins, museSkills, kills, skills, leftover, sessionFile,
    cleanup() { for (const dir of leftover) rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) } }
}

async function use(name, options, inspect) {
  const run = await replaySeat(name, options)
  try { return inspect(run) } finally { run.cleanup() }
}

const sessionNew = (run) => run.sent.find((frame) => frame.method === 'session/new')

test('a muse seat that writes task-dir or repo opens its session with the lane task dir as its only additional directory, and one that writes none or has no task dir opens with none', async () => {
  const taskDir = scratchDir('muse-task-')
  try {
    for (const [writes, dir] of [['task-dir', taskDir], ['repo', taskDir], ['none', taskDir], ['task-dir', undefined]]) {
      await use('pi-turn', { agent: 'muse', model: 'meta/muse-wonder-1.0', taskDir: dir, definition: { writes }, deps: { repoState: () => '' } }, (run) => {
        assert.equal(run.error, undefined)
        assert.deepEqual(sessionNew(run).params.additionalDirectories, writes !== 'none' && dir ? [resolve(dir)] : undefined)
      })
    }
  } finally { rmSync(taskDir, { recursive: true, force: true }) }
})

test('a muse seat launches muse acp with the experimental flag, the stripped model, its effort and onRequest mode, and disables writes unless it writes repo', async () => {
  for (const writes of ['none', 'repo']) await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', definition: { writes } }, (run) => {
    assert.equal(run.error, undefined)
    const [, args, options] = run.launches[0]
    const command = `'${BIN}' 'acp' '--model' 'muse-spark-1.3' '-c' 'model_reasoning_efforts={"muse-spark-1.3":"high"}'`
    assert.ok(args[1].includes(command))
    assert.equal(args[1].includes("'--disable-write'"), writes !== 'repo')
    assert.equal(options.env.MUSE_EXPERIMENTAL_ACP, '1')
    assert.equal(run.sent.find((frame) => frame.method === 'session/set_mode').params.modeId, 'onRequest')
    assert.deepEqual(sessionNew(run).params.mcpServers, [])
  })
})

test('a muse seat that writes task-dir, names a non-meta model or declares an unsupported extension is refused by name before any process or runtime exists', async () => {
  for (const [label, definition, reason] of [
    ['task-dir', { writes: 'task-dir' }, 'grant-unsupported'],
    ['openai', { model: 'openai/model' }, undefined],
    ['extensions', { extensions: ['readgate', 'unknown'] }, 'grant-unsupported'],
  ]) await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', definition, deps: { exists: () => true, repoState: () => null } }, (run) => {
    assert.match(run.error?.message ?? '', new RegExp(label))
    assert.equal(run.error?.reason, reason)
    assert.equal(run.launches.length, 0)
    assert.deepEqual(run.leftover, [])
  })
})

test('a muse seat granted fff launches with the fff MCP server and CREW_FFF, and one without has neither', async () => {
  const register = loadCapabilities()
  const server = Object.values(register.roles).flatMap((role) => [role, ...Object.values(role.by_agent ?? {})]).flatMap((role) => role.mcp_servers ?? []).find((entry) => entry.name === 'fff')
  for (const granted of [true, false]) await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', grant: true, definition: { extensions: granted ? ['fff'] : [], writes: 'none' }, deps: { exists: () => true } }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(sessionNew(run).params.mcpServers, granted ? [{ name: 'fff', command: server.command.bin, args: server.command.args, env: [] }] : [])
    assert.equal(run.launches[0][2].env.CREW_FFF, granted ? '1' : '0')
    assert.deepEqual(run.museSkills[0].files.map(([name]) => name), ['alpha', 'beta'])
    assert.match(run.museSkills[0].files[0][1], /name: alpha/)
    assert.ok(sessionNew(run).params.additionalDirectories.includes(run.museSkills[0].dir))
    assert.equal(run.result.museSkillsRoot, run.museSkills[0].dir)
  })
  assert.deepEqual(register.coding_agents.muse.refuses, ['local_provider'])
  for (const bad of [{ name: 'other', command: { bin: BIN, args: [] }, url: null }, { name: 'fff', command: null, url: 'https://example.com' }, { name: 'fff', type: 'http', command: { bin: BIN, args: [] }, url: null }]) {
    assert.throws(() => muse.acpLaunch({ bin: BIN, grants: { mcp_servers: [bad] } }), (error) => error.reason === 'grant-unsupported')
  }
  const root = scratchDir('muse-skill-guards-')
  try {
    const [alpha] = makeSkills(root, ['alpha'])
    const [duplicate] = makeSkills(root, ['Alpha'])
    for (const skills of [[dirname(alpha)], [alpha, duplicate]]) {
      assert.throws(() => muse.writeSeatSkills({ taskDir: root, grants: { skills } }), (error) => error.reason === 'grant-unsupported')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a muse readgate seat refuses search and whole-file shell reads at the permission boundary and admits other calls', async () => {
  const root = scratchDir('muse-readgate-')
  try {
    writeFileSync(join(root, 'large'), 'line\n'.repeat(351))
    writeFileSync(join(root, 'small'), 'one\n')
    const permissions = [
      ...['grep x large', 'rg x', ...['grep x', 'rg x', 'find .', 'fd x'].map((command) => `cd ${root} && ${command}`), 'cat large', 'git status', 'echo $UNKNOWN'].map((command, i) => ({ toolCallId: `c${i}`, _update: { sessionUpdate: 'tool_call', toolCallId: `c${i}`, kind: 'execute', title: 'bash', rawInput: { command } } })),
      ...['large', 'small'].map((path, i) => ({ toolCallId: `r${i}`, _update: { sessionUpdate: 'tool_call', toolCallId: `r${i}`, kind: 'read', title: 'read_file', rawInput: { path } } })),
    ]
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', cwd: root, definition: { writes: 'repo', extensions: ['fff', 'readgate'] }, permissions, deps: { exists: () => true } }, (run) => {
      assert.equal(run.error, undefined)
      assert.deepEqual(run.replies.map((reply) => reply?.optionId), ['deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'yes', 'yes', 'deny', 'yes'])
      const prompt = run.sent.find((frame) => frame.method === 'session/prompt').params.prompt[0].text
      assert.match(prompt, /ranged read/)
      assert.match(prompt, /mcp__fff__grep/)
      assert.match(prompt, /mcp__fff__find_files/)
    })
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', cwd: root, taskDir: root, definition: { writes: 'repo', extensions: ['readgate'] }, deps: { env: { CREW_FFF: '1' } }, permissions: [{ kind: 'read', rawInput: { path: 'missing' } }, { kind: 'execute', rawInput: { command: 'cat missing' } }, { kind: 'read', rawInput: { path: 'large' } }, { kind: 'execute', rawInput: { command: 'grep x large' } }] }, (run) => {
      assert.equal(run.error, undefined)
      assert.deepEqual(run.replies.map((reply) => reply?.optionId), ['deny', 'yes', 'yes', 'yes'])
      const prompt = run.sent.find((frame) => frame.method === 'session/prompt').params.prompt[0].text
      assert.match(prompt, /ranged read/)
      assert.doesNotMatch(prompt, /mcp__fff__/)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a muse seat that writes task-dir launches with writes enabled and settles when the worktree is clean before and after the turn', async () => {
  let checks = 0
  await use('pi-turn', { agent: 'muse', model: 'meta/muse-wonder-1.0', definition: { writes: 'task-dir' }, deps: { repoState: () => { checks++; return '' } } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.launches.length, 1)
    assert.equal(run.launches[0][1][1].includes("'--disable-write'"), false)
    assert.equal(run.result.usage, null)
    assert.equal(run.result.usage_reason, 'usage-unavailable')
    assert.equal(checks, 2)
    assert.deepEqual(run.leftover, [])
  })
})

test('a muse task-dir seat is refused on an unreadable worktree, settles on an unchanged dirty one, and fails when its turn changes the worktree or leaves it unreadable', async () => {
  for (const [states, reason, launches] of [
    [[' M a.mjs sha256:1\0', ' M a.mjs sha256:1\0'], undefined, 1],
    [[null], 'grant-unsupported', 0],
    [[new Error('EPERM')], 'grant-unsupported', 0],
    [[' M a.mjs sha256:1\0', ' M a.mjs sha256:2\0'], 'acp-seat-wrote-repo', 1],
    [['', null], 'acp-seat-repo-unmeasured', 1],
    [['', new Error('EPERM')], 'acp-seat-repo-unmeasured', 1],
  ]) {
    let checks = 0
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-wonder-1.0', definition: { writes: 'task-dir' }, deps: { repoState: () => { const state = states[checks++]; if (state instanceof Error) throw state; return state } } }, (run) => {
      assert.equal(run.error?.reason, reason)
      if (!launches) assert.match(run.error.message, /task-dir/)
      if (reason === 'acp-seat-wrote-repo') assert.match(run.error.message, /a\.mjs/)
      if (!reason) assert.equal(run.result.stopReason, 'end_turn')
      assert.equal(run.launches.length, launches)
      assert.deepEqual(run.leftover, [])
    })
  }
  for (const [after, reason] of [['?? src/x.mjs\0', 'acp-seat-wrote-repo'], [null, 'acp-seat-repo-unmeasured']]) {
    let clock = 0, checks = 0
    const client = { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1, pollPrompt: () => null,
      cancelPrompt: () => true, close: () => ({ outcome: 'proven' }) }
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-wonder-1.0', definition: { writes: 'task-dir', wait_s: 1 }, deps: {
      repoState: () => checks++ === 0 ? '' : after, clientFactory: () => client, now: () => clock, sleep: (ms) => { clock += ms },
    } }, (run) => {
      assert.equal(run.error?.reason, reason)
      assert.equal(clock, 1000)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('the default worktree fingerprint keeps a dirty worktree the muse turn left alone and sees an edit to an already-changed file, a new file and a deletion', async () => {
  for (const [name, mutate] of [
    ['unchanged', () => {}],
    ['a.mjs', (repo) => writeFileSync(join(repo, 'a.mjs'), 'planner edit')],
    ['u.txt', (repo) => writeFileSync(join(repo, 'u.txt'), 'changed untracked')],
    ['c.mjs', (repo) => writeFileSync(join(repo, 'c.mjs'), 'new')],
    ['b.mjs', (repo) => rmSync(join(repo, 'b.mjs'))],
  ]) {
    const repo = scratchDir('muse-fingerprint-')
    try {
      git(repo, 'init')
      for (const file of ['a.mjs', 'b.mjs', 'old.mjs']) writeFileSync(join(repo, file), file)
      git(repo, 'add', '.')
      git(repo, 'commit', '-m', 'base')
      writeFileSync(join(repo, 'a.mjs'), 'builder edit')
      git(repo, 'mv', 'old.mjs', 'new.mjs')
      writeFileSync(join(repo, 'u.txt'), 'untracked')
      const client = { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1,
        pollPrompt: () => { mutate(repo); return { stopReason: 'end_turn' } }, close: () => ({ outcome: 'proven' }) }
      await use('pi-turn', { agent: 'muse', model: 'meta/muse-wonder-1.0', cwd: repo, definition: { writes: 'task-dir' }, deps: { clientFactory: () => client } }, (run) => {
        assert.equal(run.error?.reason, name === 'unchanged' ? undefined : 'acp-seat-wrote-repo', name)
        if (name === 'unchanged') assert.equal(run.result.stopReason, 'end_turn')
        if (name === 'a.mjs') assert.match(run.error.message, /a\.mjs/)
        assert.deepEqual(run.leftover, [])
      })
    } finally { rmSync(repo, { recursive: true, force: true }) }
  }
})

test('a muse permission naming only its toolCallId is decided on the earlier tool_call update, chained commands per segment, and an unseen id is refused', async () => {
  const permissions = [
    ...['git status', 'cd /tmp && git status', 'git status && git push'].map((command, i) => ({ toolCallId: `c${i}`, _update: { sessionUpdate: 'tool_call', toolCallId: `c${i}`, kind: 'execute', title: 'bash', rawInput: { command } } })),
    { toolCallId: 'edit', _update: { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', title: 'write_file', rawInput: { path: '/tmp/file', content: 'x' }, locations: [{ path: '/tmp/file' }] } },
    { toolCallId: 'merged', rawInput: { command: 'git status && git push' }, title: 'frame', _update: [
      { sessionUpdate: 'tool_call', toolCallId: 'merged', kind: 'execute', title: 'old' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'merged', rawInput: { command: 'git status' } },
    ] },
    { toolCallId: 'unseen' },
  ]
  for (const [agent, writes, expected] of [
    ['muse', 'none', ['yes', 'deny', 'deny', 'deny', 'deny', 'deny']],
    ['muse', 'repo', ['yes', 'yes', 'yes', 'deny', 'yes', 'deny']],
    ['pi', 'none', ['deny', 'deny', 'deny', 'deny', 'deny', 'deny']],
  ]) await use('pi-turn', { agent, model: agent === 'muse' ? 'meta/muse-spark-1.3' : 'openai/model', definition: { writes }, permissions }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(run.replies.map((reply) => reply?.optionId), expected)
    const rows = run.rows.filter((row) => row.kind === 'permission')
    assert.deepEqual(rows.map((row) => row.tool), agent === 'muse' ? ['execute', 'execute', 'execute', 'edit', 'execute', null] : [null, null, null, null, null, null])
    assert.equal(rows[4].title, 'frame')
  })
})

test('a muse turn reports usage null with the usage-unavailable reason, never the usage_update context window', async () => {
  await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', usageUpdate: true, promptUsage: { input_tokens: 9, output_tokens: 3 } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.result.usage, null)
    assert.equal(run.result.usage_reason, 'usage-unavailable')
    assert.ok(run.rows.some((row) => row.update?.sessionUpdate === 'usage_update'))
  })
})

// MUTATION: removing `at` from recordUpdate loses the explicit receipt-time oracle.
test('every routed update lands once, timestamped, in order, after the existing sentinel row (known and unknown kinds)', async () => {
  for (const name of ['claude-turn', 'claude-turn-rawsdk', 'pi-turn', 'claude-cancel', 'pi-cancel']) {
    await use(name, { unknown: true }, (run) => {
      assert.equal(run.error, undefined, name)
      assert.ok(run.expected.length > 0, `${name} recorded updates`)
      assert.ok(run.expected.some((row) => row.update.sessionUpdate === 'future_recorded_update'), `${name} unknown kind`)
      assert.deepEqual(run.rows, [{ prior: true }, ...run.expected])
      assert.equal(run.result.stopReason, name.endsWith('cancel') ? 'cancelled' : 'end_turn')
    })
  }
})

test('the supplied prompt is sent exactly once as one text block, including an empty prompt', async () => {
  for (const prompt of ['fixture prompt', '']) {
    await use('claude-turn', { prompt }, (run) => {
      const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
      assert.equal(prompts.length, 1)
      assert.deepEqual(prompts[0].params.prompt, [{ type: 'text', text: prompt }])
    })
  }
})

const LEAN_CLAUDE_PROMPT = 'You are a coding agent. Work in the current directory with the tools you have. Prefer short command output: use quiet or dot reporters and tail long logs. Be concise.'

test('every lean Claude seat launches with the plain-string system prompt asking for short command output, whatever its role or writes', async () => {
  for (const role of [undefined, 'lead', 'planner', 'builder', 'reviewer', 'tech-lead']) {
    for (const writes of ['none', 'task-dir', 'repo']) {
      await use('claude-turn', { definition: { ...(role === undefined ? {} : { role }), writes } }, (run) => {
        assert.equal(run.error, undefined, `${role}/${writes}`)
        const meta = sessionNew(run).params._meta
        assert.equal(typeof meta.systemPrompt, 'string')
        assert.equal(meta.systemPrompt, LEAN_CLAUDE_PROMPT)
        assert.match(meta.systemPrompt, /short command output/)
        assert.equal(meta.claudeCode.options.model, 'claude-opus-4-6')
        assert.equal(meta.claudeCode.options.extraArgs.effort, 'high')
        assert.deepEqual(meta.claudeCode.options.settingSources, [])
        assert.equal(meta.claudeCode.options.settings, claude.CLAUDE_SEAT_SETTINGS)
      })
    }
  }
})

test('a lean Pi seat launches with no system prompt meta, and its supplied prompt is still sent once', async () => {
  for (const writes of ['none', 'task-dir', 'repo']) {
    await use('pi-turn', { definition: { writes } }, (run) => {
      assert.equal(run.error, undefined)
      assert.equal(Object.hasOwn(sessionNew(run).params._meta ?? {}, 'systemPrompt'), false)
      const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
      assert.deepEqual(prompts.map((frame) => frame.params.prompt), [[{ type: 'text', text: 'fixture prompt' }]])
    })
  }
})

test('a typed provider refusal is returned unchanged and the stream still records its updates', async () => {
  await use('claude-refusal-auth', {}, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.result.stopReason, null)
    assert.equal(run.result.refusal.errorKind, 'authentication_failed')
    assert.deepEqual(run.rows, [{ prior: true }, ...run.expected])
  })
})

test('Claude session/new carries the stripped model id and each requested effort', async () => {
  for (const effort of ['low', 'medium', 'high']) {
    await use('claude-turn', { effort }, (run) => {
      const options = sessionNew(run).params._meta.claudeCode.options
      assert.equal(options.model, 'claude-opus-4-6')
      assert.equal(options.extraArgs.effort, effort)
    })
  }
})

test('granted skills become exactly one plugin with complete support files; no skills means no plugin', async () => {
  await use('claude-turn', { grant: true }, (run) => {
    assert.equal(run.error, undefined)
    const entries = sessionNew(run).params._meta.claudeCode.options.plugins
    assert.equal(entries.length, 1)
    assert.equal(entries[0].type, 'local')
    assert.deepEqual(run.plugins[0].names, ['alpha', 'beta'])
    for (const file of run.plugins[0].files) {
      assert.ok(file.skill.includes(`name: ${file.name}`))
      assert.equal(file.reference, `${file.name}-reference`)
    }
  })
  for (const skills of [undefined, []]) {
    await use('claude-turn', { definition: { skills } }, (run) => {
      assert.equal(run.error, undefined)
      assert.equal(Object.hasOwn(sessionNew(run).params._meta.claudeCode.options, 'plugins'), false)
    })
  }
})

test('a skill identifier resolves to this checkout skills/<name>/SKILL.md, not the seat cwd', async () => {
  await use('claude-turn', { skills: ['qa-test-writing'] }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(run.plugins[0].names, ['qa-test-writing'])
    assert.equal(run.plugins[0].files[0].skill, readFileSync(join(ROOT, 'skills', 'qa-test-writing', 'SKILL.md'), 'utf8'))
  })
})

test('a cwd-relative skill path is accepted', async () => {
  const run = await replaySeat('claude-turn', { grant: true })
  try {
    const again = await replaySeat('claude-turn', { cwd: run.root, skills: ['alpha/SKILL.md'] })
    try {
      assert.equal(again.error, undefined)
      assert.deepEqual(again.plugins[0].names, ['alpha'])
    } finally { again.cleanup() }
  } finally { run.cleanup() }
})

test('the Pi launch runs this checkout bridge with the full provider/id model and the frozen worker path', async () => {
  await use('pi-turn', {}, (run) => {
    assert.equal(run.error, undefined)
    const [, args, spawnOptions] = run.launches[0]
    const shell = args[1]
    assert.ok(shell.includes(resolve(ROOT, 'crew/pi/acp-bridge.mjs')))
    assert.ok(shell.includes('--model') && shell.includes('openai-codex/gpt-6.1-sol'))
    assert.ok(!shell.includes(' openai/gpt-6.1-sol'))
    assert.ok(shell.includes('--thinking') && shell.includes('high'))
    assert.equal(spawnOptions.env.CREW_PI_BIN, BIN)
  })
})

// MUTATION: pass definition.model to pi unchanged and an openai seat launches on the metered provider.
test('a pi seat launches with the legacy provider mapping: openai becomes openai-codex, anthropic and meta stay', async () => {
  for (const [model, launched] of [['openai/gpt-6.1-sol', 'openai-codex/gpt-6.1-sol'], ['anthropic/claude-opus-4-6', 'anthropic/claude-opus-4-6'], ['meta/llama-5', 'meta/llama-5']]) {
    await use('pi-turn', { model }, (run) => {
      assert.equal(run.error, undefined, model)
      assert.equal(run.result.stopReason, 'end_turn', model)
      const shell = run.launches[0][1][1]
      assert.ok(shell.includes(launched), model)
      assert.ok(launched === model || !shell.includes(model), model)
    })
  }
})

// MUTATION: drop the own-property guard and a prototype name or an unmapped provider launches.
test('a pi seat with an unmapped or prototype provider is refused by name before any process or runtime exists', async () => {
  for (const provider of ['mistral', 'constructor']) {
    await use('pi-turn', { model: `${provider}/some-model` }, (run) => {
      assert.match(run.error?.message ?? '', new RegExp(`no pi provider for roster provider.*${provider}`, 'i'), provider)
      assert.equal(run.launches.length, 0, provider)
      assert.deepEqual(run.leftover, [], provider)
    })
  }
})

test('Pi receives the same explicit skill paths as --skill arguments', async () => {
  await use('pi-turn', { grant: true }, (run) => {
    assert.equal(run.error, undefined)
    const shell = run.launches[0][1][1]
    for (const path of run.skills) assert.ok(shell.includes(path), path)
  })
})

test('a recording failure never changes the turn result (directory output, EPERM, EIO)', async () => {
  for (const name of ['claude-turn', 'pi-turn', 'claude-refusal-auth', 'claude-cancel']) {
    const expected = await use(name, {}, (run) => { assert.equal(run.error, undefined); return run.result })
    for (const options of [{ unwritable: true }, { appendError: 'EPERM' }, { appendError: 'EIO' }]) {
      await use(name, options, (run) => {
        assert.equal(run.error, undefined, name)
        assert.deepEqual(run.result, expected, name)
      })
    }
  }
})

test('an unsupported agent (unknown, empty, null) is refused by name before any process or runtime exists', async () => {
  for (const agent of ['unsupported', '', null, undefined]) {
    await use('pi-turn', { definition: { agent } }, (run) => {
      assert.match(run.error?.message ?? '', /unsupported agent/)
      assert.equal(run.launches.length, 0)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('malformed launch inputs are refused, never coerced, before any process starts', async () => {
  const bad = [
    { definition: { model: 'no-slash' } }, { definition: { model: 7 } }, { definition: { effort: 'turbo' } },
    { definition: { effort: undefined } }, { definition: { skills: 'alpha' } }, { skills: [''] }, { skills: [7] },
    { skills: ['../escape'] }, { cwd: '' }, { prompt: 7 },
  ]
  for (const options of bad) {
    await use('claude-turn', options, (run) => {
      assert.ok(run.error, JSON.stringify(options))
      assert.equal(run.launches.length, 0, JSON.stringify(options))
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('a missing, directory, duplicate or case-colliding skill refuses before any process starts', async () => {
  const root = scratchDir('acp-seat-skills-')
  const [alpha] = makeSkills(root, ['alpha'])
  const [upper] = makeSkills(join(root, 'u'), ['Alpha'])
  mkdirSync(join(root, 'dir', 'SKILL.md'), { recursive: true })
  const cases = {
    missing: [join(root, 'none', 'SKILL.md')],
    directory: [join(root, 'dir', 'SKILL.md')],
    duplicate: [alpha, alpha],
    'case collision': [alpha, upper],
  }
  for (const [label, skills] of Object.entries(cases)) {
    for (const name of ['claude-turn', 'pi-turn']) {
      if (name === 'pi-turn' && ['duplicate', 'case collision'].includes(label)) continue
      await use(name, { skills }, (run) => {
        assert.ok(run.error, `${name} ${label}`)
        assert.equal(run.launches.length, 0, `${name} ${label}`)
        assert.deepEqual(run.leftover, [])
      })
    }
  }
})

test('denied skill materialisation refuses, unlike denied recording', async () => {
  const deps = { skillDeps: { cpSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }
  await use('claude-turn', { grant: true, deps }, (run) => {
    assert.equal(run.error?.code, 'EPERM')
    assert.equal(run.launches.length, 0)
    assert.deepEqual(run.leftover, [])
  })
})

test('a binary that cannot be resolved refuses before any process starts', async () => {
  const dir = scratchDir('acp-seat-path-')
  for (const [name, binaries] of [['claude-turn', {}], ['pi-turn', {}], ['claude-turn', { claudeAcp: 'relative/acp', claude: BIN }]]) {
    await use(name, { binaries, deps: { env: { PATH: `relative:${dir}` } } }, (run) => {
      assert.match(run.error?.message ?? '', /binary/)
      assert.equal(run.launches.length, 0)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('an explicit absolute binary that is missing, a directory or not executable is refused by name before any process starts', async () => {
  const dir = scratchDir('acp-seat-explicit-')
  const plain = join(dir, 'plain')
  writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 })
  const subdir = join(dir, 'subdir')
  mkdirSync(subdir)
  const cases = [
    ['claude-turn', { claudeAcp: join(dir, 'missing'), claude: BIN }, join(dir, 'missing')],
    ['claude-turn', { claudeAcp: BIN, claude: join(dir, 'missing') }, join(dir, 'missing')],
    ['claude-turn', { claudeAcp: plain, claude: BIN }, plain],
    ['claude-turn', { claudeAcp: BIN, claude: subdir }, subdir],
    ['pi-turn', { pi: join(dir, 'missing') }, join(dir, 'missing')],
    ['pi-turn', { pi: plain }, plain],
  ]
  for (const [name, binaries, path] of cases) {
    await use(name, { binaries }, (run) => {
      assert.match(run.error?.message ?? '', /is not an executable file/, `${name} ${path}`)
      assert.ok(run.error.message.includes(JSON.stringify(path)), `${name} ${path}`)
      assert.equal(run.launches.length, 0, `${name} ${path}`)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('a PATH binary is found only through an absolute directory', async () => {
  const dir = scratchDir('acp-seat-path-')
  writeFileSync(join(dir, 'pi'), '#!/bin/sh\n', { mode: 0o755 })
  await use('pi-turn', { binaries: {}, deps: { env: { PATH: `relative:${dir}` } } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.launches[0][2].env.CREW_PI_BIN, join(dir, 'pi'))
  })
})

test('a startup failure is preserved and its private runtime removed', async () => {
  await use('claude-turn', { spawnThrows: true }, (run) => {
    assert.match(run.error?.message ?? '', /spawn denied/)
    assert.deepEqual(run.leftover, [])
    assert.equal(readFileSync(run.sessionFile, 'utf8'), '{"prior":true}\n')
  })
})

test('a prompt transport failure is preserved and the client is still closed', async () => {
  await use('claude-turn', { writeError: 'EIO' }, (run) => {
    assert.equal(run.error?.code, 'EIO')
    assert.ok(run.kills.length > 0)
    assert.deepEqual(run.leftover, [])
  })
})

test('the runtime is removed once teardown is proven and retained when it is not', async () => {
  await use('claude-turn', {}, (run) => assert.deepEqual(run.leftover, []))
  await use('claude-turn', { noExit: true }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.leftover.length, 1)
    assert.ok(existsSync(run.leftover[0]))
  })
})

test('the session file and granted skill sources survive the run', async () => {
  await use('claude-turn', { grant: true }, (run) => {
    assert.ok(existsSync(run.sessionFile))
    for (const path of run.skills) assert.ok(existsSync(path))
  })
})

// ---- permission decisions: the effective definition's writes and the lane task directory ----

let calls = 0
const edit = (path, key = 'path') => ({ toolCallId: `edit-${++calls}`, kind: 'edit', title: 'write', rawInput: { [key]: path, content: 'after' } })
const shell = (command) => ({ toolCallId: `shell-${++calls}`, kind: 'execute', title: 'bash', rawInput: { command } })
const verdict = (reply) => (reply?.outcome === 'cancelled' ? 'cancelled' : reply?.optionId === 'yes' ? 'allow' : reply?.outcome === 'selected' ? 'reject' : reply)

// A worktree, a lane task directory and everything outside both, with the links an escape would use.
async function withPermissionTree(inspect) {
  const root = realpathSync(scratchDir('acp-seat-permission-'))
  const work = join(root, 'work'), task = join(root, 'task'), outside = join(root, 'outside')
  for (const dir of [work, task, outside, `${work}-sibling`]) mkdirSync(dir)
  writeFileSync(join(work, 'existing'), 'before')
  writeFileSync(join(task, 'existing'), 'before')
  symlinkSync(outside, join(work, 'escape'))
  symlinkSync(outside, join(task, 'escape'))
  symlinkSync(join(outside, 'absent'), join(task, 'dangling'))
  try { return await inspect({ root, work, task, outside }) } finally { rmSync(root, { recursive: true, force: true }) }
}

// Replays the permission requests through the real seat and returns one verdict per request.
async function decide(tree, writes, requests, { name = 'pi-turn', ...options } = {}) {
  const run = await replaySeat(name, { cwd: tree.work, taskDir: tree.task, permissions: requests, ...options, definition: { role: 'planner', writes, ...options.definition } })
  try {
    assert.equal(run.error, undefined)
    return { verdicts: run.replies.map(verdict), rows: run.rows.filter((row) => row.kind === 'permission'), run: { sent: run.sent, rows: run.rows, expected: run.expected, plugins: run.plugins, launches: run.launches } }
  } finally { run.cleanup() }
}

test('read-only seat launches carry a launch-authoritative flag, repo seats disable it, and chains are decided per segment', async () => {
  await withPermissionTree(async (tree) => {
    const commands = ['git status --short && git diff --stat', 'git status && git push']
    const requests = commands.map((command) => ({ kind: 'execute', title: 'shell', rawInput: { command } }))
    for (const name of ['pi-turn', 'claude-turn']) for (const writes of ['none', 'task-dir', 'repo']) {
      const { verdicts, run } = (await decide(tree, writes, requests, { name }))
      assert.deepEqual(verdicts, writes === 'repo' ? ['allow', 'allow'] : ['allow', 'reject'], `${name}/${writes}`)
      const env = run.launches[0][2].env
      assert.equal(env.CREW_READ_ONLY, writes === 'repo' ? '0' : '1', `${name}/${writes}`)
      assert.equal(env.CREW_READ_ONLY_NODE, process.execPath)
      assert.ok(env.CREW_READ_ONLY_HOOK.endsWith('crew/adapters/claude-readonly.mjs'))
    }
  })
})

test('task-dir seats write the lane task directory, new and nested files included, never the worktree (Pi path and Claude file_path)', async () => {
  await withPermissionTree(async (tree) => {
    for (const [name, key] of [['pi-turn', 'path'], ['claude-turn', 'file_path']]) {
      const allowed = [edit(join(tree.task, 'existing'), key), edit(join(tree.task, 'new', 'deep', 'gate.mjs'), key), edit(relative(tree.work, join(tree.task, 'plan.md')), key)]
      assert.deepEqual((await decide(tree, 'task-dir', allowed, { name })).verdicts, ['allow', 'allow', 'allow'], name)
      const denied = [edit(join(tree.work, 'existing'), key), edit('fresh.mjs', key)]
      assert.deepEqual((await decide(tree, 'task-dir', denied, { name })).verdicts, ['reject', 'reject'], name)
    }
  })
})

test('repo seats write the worktree and the lane task directory, nothing else', async () => {
  await withPermissionTree(async (tree) => {
    const { verdicts } = (await decide(tree, 'repo', [
      edit('existing'), edit(join(tree.work, 'new', 'code.mjs')), edit(join(tree.task, 'return.json')),
      edit(join(tree.outside, 'new')), edit(join(`${tree.work}-sibling`, 'new')), edit('../outside/new'),
      edit(join(tree.work, 'escape', 'new')), edit(join(tree.task, 'escape', 'new')), edit(join(tree.task, 'dangling')),
      edit(`${tree.task}/escape/../new`), edit(join(tree.work, 'existing', 'child')),
    ]))
    assert.deepEqual(verdicts, ['allow', 'allow', 'allow', ...Array(8).fill('reject')])
  })
})

test('a task-dir or repo seat never edits, writes or deletes a lean session record, and the rest of the task directory stays writable', async () => {
  const root = realpathSync(scratchDir('acp-seat-lean-'))
  try {
    for (const placement of ['external', 'nested', 'symlinked']) {
      for (const existing of [false, true]) {
        const home = join(root, `${placement}-${existing}`)
        const work = join(home, 'work')
        const task = placement === 'nested' ? join(work, 'task') : join(home, 'task')
        mkdirSync(task, { recursive: true })
        mkdirSync(work, { recursive: true })
        const lean = join(task, 'lean')
        if (existing) {
          mkdirSync(join(lean, 'planner'), { recursive: true })
          writeFileSync(join(lean, 'planner', 'turn.jsonl'), 'trusted\n')
        }
        symlinkSync(lean, join(work, 'session-alias'))
        const taskDir = placement === 'symlinked' ? join(home, 'task-alias') : task
        if (placement === 'symlinked') symlinkSync(task, taskDir)
        const denied = [
          lean, join(lean, 'planner', 'turn.jsonl'), join(lean, 'new', 'deep.jsonl'), `${task}/./lean/planner/turn.jsonl`,
          relative(work, join(lean, 'planner', 'turn.jsonl')), join(work, 'session-alias', 'planner', 'turn.jsonl'),
          join(taskDir, 'lean', 'planner', 'turn.jsonl'), join(task, 'LEAN', 'planner', 'turn.jsonl'), join(task, 'Lean', 'new.jsonl'),
        ]
        const allowed = [
          join(task, 'plan.md'), join(task, 'gate.mjs'), join(task, 'return.json'), join(task, 'new', 'artifact.json'),
          join(task, 'leaner', 'keep.jsonl'), join(task, 'lean-other', 'keep.jsonl'),
        ]
        for (const [name, key] of [['pi-turn', 'path'], ['claude-turn', 'file_path']]) {
          for (const writes of ['task-dir', 'repo']) {
            for (const kind of ['edit', 'write', 'delete']) {
              const request = (path) => ({ ...edit(path, key), kind })
              const { verdicts } = (await decide({ work, task: taskDir }, writes, [...denied, ...allowed].map(request), { name }))
              const label = `${placement}/${existing}/${name}/${writes}/${kind}`
              assert.deepEqual(verdicts, [...denied.map(() => 'reject'), ...allowed.map(() => 'allow')], label)
            }
          }
        }
        if (existing) assert.equal(readFileSync(join(lean, 'planner', 'turn.jsonl'), 'utf8'), 'trusted\n')
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('writes none rejects every file mutation in every root', async () => {
  await withPermissionTree(async (tree) => {
    const { verdicts } = (await decide(tree, 'none', [edit(join(tree.task, 'existing')), edit('existing'), edit(join(tree.outside, 'new'))]))
    assert.deepEqual(verdicts, ['reject', 'reject', 'reject'])
  })
})

test('missing, unknown or role-implied writes grant nothing', async () => {
  await withPermissionTree(async (tree) => {
    for (const writes of [undefined, null, 'admin', '']) {
      const { verdicts, rows } = (await decide(tree, writes, [edit('existing'), edit(join(tree.task, 'existing'))], { definition: { role: 'builder', writes } }))
      assert.deepEqual(verdicts, ['reject', 'reject'], String(writes))
      assert.deepEqual(rows.map((row) => row.writes), ['none', 'none'])
    }
  })
})

test('shell: repo seats run commands, others only the read-only allowlist', async () => {
  await withPermissionTree(async (tree) => {
    const commands = ['touch nope', 'cat existing > nope', 'git status', 'cat existing']
    for (const writes of ['task-dir', 'none']) {
      assert.deepEqual((await decide(tree, writes, commands.map(shell))).verdicts, ['reject', 'reject', 'allow', 'allow'], writes)
    }
    assert.deepEqual((await decide(tree, 'repo', commands.map(shell))).verdicts, ['allow', 'allow', 'allow', 'allow'])
    const malformed = [{ kind: 'execute', title: 'bash', rawInput: {} }, { kind: 'execute', title: 'bash', rawInput: { command: '' } },
      { kind: 'execute', title: 'bash', rawInput: { command: 7 } }, { kind: 'execute', title: 'bash', rawInput: null }, { kind: 'execute', title: 'bash' }]
    assert.deepEqual((await decide(tree, 'repo', malformed)).verdicts, Array(5).fill('reject'))
  })
})

test('anything the rules do not name is rejected even for a repo seat', async () => {
  await withPermissionTree(async (tree) => {
    const target = join(tree.work, 'existing')
    const { verdicts } = (await decide(tree, 'repo', [
      { kind: 'other', title: 'write', rawInput: { path: target } }, { kind: 'fetch', title: 'fetch', rawInput: { path: target } },
      { kind: 'read', title: 'read', rawInput: { path: target } }, { kind: 'move', title: 'move', rawInput: { path: target } },
      { kind: 'edit', title: 'write', rawInput: { from: target, to: target } },
      { kind: 'edit', title: 'write', rawInput: {} }, { kind: 'edit', title: 'write' }, { kind: 'edit', title: target },
      { kind: 'edit', title: 'write', rawInput: { path: target, file_path: join(tree.outside, 'x') } },
      { kind: 'edit', title: 'write', rawInput: { path: '' } }, { kind: 'edit', title: 'write', rawInput: { path: 7 } },
      { kind: 'edit', title: 'write', rawInput: { path: `${target}\0x` } }, { title: 'write', rawInput: { path: target } }, null,
    ]))
    assert.deepEqual(verdicts, Array(14).fill('reject'))
    assert.deepEqual((await decide(tree, 'repo', [{ kind: 'edit', title: 'write', rawInput: { path: target, file_path: target } }])).verdicts, ['allow'])
  })
})

test('an unreadable path component rejects that request only (EPERM, EIO, EINTR), the next request is still decided', async () => {
  await withPermissionTree(async (tree) => {
    for (const code of ['EPERM', 'EIO', 'EINTR']) {
      const broken = join(tree.work, 'existing')
      const realpathSync = (path, ...rest) => {
        if (path === broken) throw Object.assign(new Error(code), { code })
        return realpathSync_(path, ...rest)
      }
      const { verdicts } = (await decide(tree, 'repo', [edit(broken), edit(join(tree.work, 'fresh')), edit(broken)], { deps: { realpathSync } }))
      assert.deepEqual(verdicts, ['reject', 'allow', 'reject'], code)
    }
  })
})
const realpathSync_ = realpathSync

test('each decision is one session row, in request order, correlated to the reply and before the updates', async () => {
  await withPermissionTree(async (tree) => {
    const requests = [edit(join(tree.task, 'existing')), edit('existing'), shell('git status'),
      { toolCallId: 'unsupported', kind: 'other', title: 'unknown', rawInput: {} },
      { ...edit('existing'), toolCallId: 'always', _options: [{ optionId: 'forever', kind: 'allow_always', name: 'Always' }] },
      { ...edit('existing'), toolCallId: 'reject-always', _options: [{ optionId: 'never', kind: 'reject_always', name: 'Never' }, { optionId: 'forever', kind: 'allow_always', name: 'Always' }] },
      { ...edit(join(tree.task, 'existing')), toolCallId: 'only-always-allowed', _options: [{ optionId: 'no', kind: 'reject_once', name: 'No' }, { optionId: 'forever', kind: 'allow_always', name: 'Always' }] }]
    const { rows, verdicts, run } = (await decide(tree, 'task-dir', requests))
    assert.deepEqual(verdicts, ['allow', 'reject', 'allow', 'reject', 'cancelled', 'reject', 'reject'])
    const base = { kind: 'permission', role: 'planner', writes: 'task-dir', sessionId: 'fixture' }
    assert.deepEqual(rows, [
      { ...base, tool_call_id: requests[0].toolCallId, tool: 'edit', title: 'write', option: 'yes', option_kind: 'allow_once' },
      { ...base, tool_call_id: requests[1].toolCallId, tool: 'edit', title: 'write', option: 'deny', option_kind: 'reject_once' },
      { ...base, tool_call_id: requests[2].toolCallId, tool: 'execute', title: 'bash', option: 'yes', option_kind: 'allow_once' },
      { ...base, tool_call_id: 'unsupported', tool: 'other', title: 'unknown', option: 'deny', option_kind: 'reject_once' },
      { ...base, tool_call_id: 'always', tool: 'edit', title: 'write', option: null, option_kind: null },
      { ...base, tool_call_id: 'reject-always', tool: 'edit', title: 'write', option: 'never', option_kind: 'reject_always' },
      { ...base, tool_call_id: 'only-always-allowed', tool: 'edit', title: 'write', option: 'no', option_kind: 'reject_once' },
    ])
    assert.deepEqual(run.rows, [{ prior: true }, ...rows, ...run.expected])
  })
})

test('a failed permission-row append never changes a decision', async () => {
  await withPermissionTree(async (tree) => {
    const appendFileSync = (path, text, ...rest) => { if (text.includes('"kind":"permission"')) throw Object.assign(new Error('denied'), { code: 'EIO' }); return appendFileSync_(path, text, ...rest) }
    const { verdicts } = (await decide(tree, 'task-dir', [edit(join(tree.task, 'existing')), edit('existing')], { deps: { appendFileSync } }))
    assert.deepEqual(verdicts, ['allow', 'reject'])
  })
})
const appendFileSync_ = appendFileSync

test('the actual role reaches the launch and the lane task directory is writable only when writes allow it', async () => {
  await withPermissionTree(async (tree) => {
    const dirsOf = async (writes, taskDir) => {
      const run = await replaySeat('claude-turn', { cwd: tree.work, taskDir, definition: { role: 'planner', writes } })
      try { return sessionNew(run).params._meta.claudeCode.options.additionalDirectories } finally { run.cleanup() }
    }
    assert.deepEqual(await dirsOf('task-dir', tree.task), [tree.task])
    assert.deepEqual(await dirsOf('repo', tree.task), [tree.task])
    assert.deepEqual(await dirsOf('none', tree.task), [])
    assert.deepEqual(await dirsOf('task-dir', undefined), [])
    const run = await replaySeat('claude-turn', { grant: true, cwd: tree.work, definition: { role: 'planner', writes: 'none' } })
    try { assert.match(sessionNew(run).params._meta.claudeCode.options.plugins[0].path, /claude-skills[\\/]planner$/) } finally { run.cleanup() }
    const unnamed = await replaySeat('claude-turn', { grant: true, cwd: tree.work })
    try { assert.match(sessionNew(unnamed).params._meta.claudeCode.options.plugins[0].path, /claude-skills[\\/]seat$/) } finally { unnamed.cleanup() }
    const pi = await replaySeat('pi-turn', { cwd: tree.work, definition: { role: 'builder', writes: 'repo' } })
    try { assert.equal(pi.error, undefined); assert.equal(pi.launches.length, 1) } finally { pi.cleanup() }
  })
})

test('an unknown role is refused before any process or runtime exists', async () => {
  for (const role of ['seat', '', null, 'admin']) {
    await use('pi-turn', { definition: { role } }, (run) => {
      assert.match(run.error?.message ?? '', /unknown role/, String(role))
      assert.equal(run.launches.length, 0)
      assert.deepEqual(run.leftover, [])
    })
  }
})

const launchTools = (run) => {
  const { allowedTools, tools, disallowedTools } = sessionNew(run).params._meta.claudeCode.options
  return { allowedTools, tools, disallowedTools }
}
const TOOL_DEFAULTS = {
  repo: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  'task-dir': ['Read', 'Glob', 'Grep', 'Bash', 'Write'],
  none: ['Read', 'Glob', 'Grep'],
}

const MUTATORS = ['Write', 'Edit', 'NotebookEdit', 'Bash']
const approved = (tools) => tools.filter((tool) => !MUTATORS.includes(tool))

test('a Claude seat without tools launches the writes-based defaults, none being read and search only', async () => {
  for (const [writes, expected] of Object.entries(TOOL_DEFAULTS)) {
    await use('claude-turn', { definition: { writes } }, (run) => {
      assert.equal(run.error, undefined, writes)
      const launched = launchTools(run)
      assert.deepEqual(launched.allowedTools, writes === 'repo' ? expected : approved(expected), writes)
      assert.deepEqual(launched.tools, expected, writes)
    })
  }
  await use('claude-turn', {}, (run) => assert.deepEqual(launchTools(run).allowedTools, TOOL_DEFAULTS.none))
})

const setModes = (run) => run.sent.filter((frame) => frame.method === 'session/set_mode').map((frame) => frame.params.modeId)

test('a Claude seat asks for every edit unless its definition writes repo, whatever its role or tools', async () => {
  const explicit = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'NotebookEdit']
  for (const role of ['reviewer', 'lead', 'tech-lead', 'builder']) {
    for (const tools of [undefined, explicit]) {
      for (const [writes, mode] of [['task-dir', 'default'], ['none', 'default'], [undefined, 'default'], ['bogus', 'default'], ['repo', 'acceptEdits']]) {
        const definition = { role, writes, ...(tools ? { tools } : {}) }
        await use('claude-turn', { definition }, (run) => {
          const label = JSON.stringify(definition)
          assert.equal(run.error, undefined, label)
          assert.deepEqual(setModes(run), [mode], label)
          const launched = launchTools(run)
          const available = tools ?? TOOL_DEFAULTS[['task-dir', 'repo'].includes(writes) ? writes : 'none']
          assert.deepEqual(launched.tools, available, label)
          assert.deepEqual(launched.allowedTools, writes === 'repo' ? available : approved(available), label)
        })
      }
    }
  }
})

test('a refused set_mode starts no prompt and still tears the client down', async () => {
  const events = []
  const root = scratchDir('acp-seat-mode-refusal-')
  try {
    await assert.rejects(() => runAcpSeat({
      definition: { agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', role: 'reviewer', skills: [], writes: 'task-dir' },
      cwd: root, taskDir: root, prompt: 'x', sessionFile: join(root, 'session.jsonl'),
      binaries: { claudeAcp: BIN, claude: BIN },
      deps: { runtimeRoot: root, clientFactory: () => ({
        start() { events.push('start') },
        initialize() { events.push('initialize') },
        newSession() { events.push('new') },
        setMode() { events.push('mode'); throw new Error('mode refused') },
        beginPrompt() { events.push('prompt') },
        close() { events.push('close'); return { outcome: 'proven' } },
      }) },
    }), /mode refused/)
    assert.deepEqual(events, ['start', 'initialize', 'new', 'mode', 'close'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION: drop the client?.spawned term.
test('S2-17 a start that fails after spawn keeps the runtime unless teardown is proven', async () => {
  for (const outcome of ['unproven', 'failed', 'proven']) {
    const root = scratchDir('acp-seat-start-failure-')
    try {
      await assert.rejects(() => runAcpSeat({
        definition: { agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high', role: 'reviewer', skills: [], writes: 'task-dir' },
        cwd: root, taskDir: root, prompt: 'x', sessionFile: join(root, 'session.jsonl'),
        binaries: { claudeAcp: BIN, claude: BIN },
        deps: { runtimeRoot: root, clientFactory: () => ({
          spawned: true, start() { throw new Error('start failed') }, close() { return { outcome } },
        }) },
      }), /start failed/)
      assert.equal(runtimes(root).size, outcome === 'proven' ? 0 : 1, outcome)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('task-dir seats deny Edit and NotebookEdit even when the explicit tools list Edit', async () => {
  for (const definition of [{ writes: 'task-dir' }, { writes: 'task-dir', tools: ['Read', 'Edit'] }]) {
    await use('claude-turn', { definition }, (run) => {
      const { disallowedTools } = launchTools(run)
      assert.ok(disallowedTools.includes('Edit'), JSON.stringify(definition))
      assert.ok(disallowedTools.includes('NotebookEdit'), JSON.stringify(definition))
    })
  }
})

test('explicit tools replace the defaults for every writes class', async () => {
  for (const writes of Object.keys(TOOL_DEFAULTS)) {
    await use('claude-turn', { definition: { writes, tools: ['Read', 'Grep'] } }, (run) => {
      const launched = launchTools(run)
      assert.deepEqual(launched.allowedTools, ['Read', 'Grep'], writes)
      assert.deepEqual(launched.tools, ['Read', 'Grep'], writes)
    })
  }
})

test('a Claude seat reads no setting source, so a permissive target checkout cannot widen it, but keeps usage settings and granted plugin', async () => {
  const work = scratchDir('acp-seat-project-settings-')
  try {
    mkdirSync(join(work, '.claude'), { recursive: true })
    for (const name of ['settings.json', 'settings.local.json']) {
      writeFileSync(join(work, '.claude', name), JSON.stringify({ permissions: { allow: ['Bash(*)', 'Write', 'Edit'] } }))
    }
    for (const writes of ['none', 'task-dir', 'repo', undefined, 'bogus']) {
      for (const grant of [false, true]) {
        const label = `writes=${writes} grant=${grant}`
        await use('claude-turn', { cwd: work, taskDir: work, grant, definition: { writes } }, (run) => {
          assert.equal(run.error, undefined, label)
          const options = sessionNew(run).params._meta.claudeCode.options
          assert.deepEqual(options.settingSources, [], label)
          assert.equal(options.settings, claude.CLAUDE_SEAT_SETTINGS, label)
          if (!grant) return assert.equal(Object.hasOwn(options, 'plugins'), false, label)
          assert.equal(options.plugins.length, 1, label)
          assert.equal(options.plugins[0].type, 'local', label)
          assert.deepEqual(run.plugins[0].names, ['alpha', 'beta'], label)
          assert.ok(options.tools.includes('Skill'), label)
        })
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }) }
})

test('an empty Claude tool list is refused as ACP_EMPTY_TOOLS before any process or runtime exists', async () => {
  for (const writes of Object.keys(TOOL_DEFAULTS)) {
    await use('claude-turn', { definition: { writes, tools: [] } }, (run) => {
      assert.equal(run.error?.code, 'ACP_EMPTY_TOOLS', writes)
      assert.equal(run.launches.length, 0, writes)
      assert.deepEqual(run.leftover, [], writes)
    })
  }
})

test('malformed Claude tools are refused before any process or runtime exists', async () => {
  for (const tools of [null, '', 'Read', 7, {}, [null], [7], [''], [' ']]) {
    await use('claude-turn', { definition: { writes: 'repo', tools } }, (run) => {
      assert.match(run.error?.message ?? '', /tools must be a list/, JSON.stringify(tools))
      assert.equal(run.launches.length, 0, JSON.stringify(tools))
      assert.deepEqual(run.leftover, [], JSON.stringify(tools))
    })
  }
})

test('Pi brings its own tools: an explicit empty list still launches', async () => {
  await use('pi-turn', { definition: { writes: 'repo', tools: [] } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.launches.length, 1)
  })
})

// A fake client under an injected clock: the deadline loop, cancellation and teardown are observable without a transport.
async function deadlineSeat({ agent = 'pi', wait_s, answerAt = null, answer = { stopReason: 'end_turn', usage: null, refusal: null }, pollAdvance = 0, cancelError = null, closeError = null, closeOutcome = 'proven', pollError = null, exitAt = null, settleOnExit = false, exitPollAdvance = 0, exitPollError = null, onStart = () => {} } = {}) {
  const root = scratchDir('acp-seat-deadline-')
  const runtimeRoot = join(root, 'runtimes')
  mkdirSync(runtimeRoot)
  let clock = 0
  const events = []
  const sleeps = []
  let pending = false
  let exitSeen = false
  const client = {
    start() { onStart() }, initialize() {}, newSession() {}, setMode() {},
    prompt() { throw new Error('the seat never calls the blocking prompt') },
    cancel() { events.push(['cancel-session', clock]) },
    // settleOnExit: the answer lands after the empty poll, at the moment the exit marker is observed.
    hasExitMarker() { if (settleOnExit) { exitSeen = true; return true } return exitAt !== null && clock >= exitAt },
    beginPrompt() { events.push(['begin', clock]); pending = true; return 41 },
    pollPrompt(id) {
      events.push(['poll', id, clock])
      if (pollError || (exitSeen && exitPollError)) throw pollError ?? exitPollError
      clock += exitSeen ? exitPollAdvance : pollAdvance
      if (exitSeen) { pending = false; return answer }
      if (answerAt === null || clock < answerAt) return null
      pending = false
      return answer
    },
    cancelPrompt(id) { events.push(['cancel', id, clock]); if (cancelError) throw cancelError; return pending },
    close() { events.push(['close', clock]); if (closeError) throw closeError; return { outcome: closeOutcome } },
  }
  const before = runtimes(runtimeRoot)
  let result
  let error
  try {
    result = await runAcpSeat({
      definition: { role: 'planner', agent, model: agent === 'pi' ? 'openai/gpt-6.1-sol' : 'anthropic/claude-opus-4-6', effort: 'high', skills: [], ...(wait_s === undefined ? {} : { wait_s }) },
      cwd: root, prompt: 'deadline prompt', sessionFile: join(root, 'session.jsonl'),
      binaries: { claudeAcp: BIN, claude: BIN, pi: BIN },
      deps: { runtimeRoot, clientFactory: () => client, now: () => clock, sleep: (ms) => { sleeps.push(ms); clock += ms } },
    })
  } catch (caught) { error = caught }
  const leftover = [...runtimes(runtimeRoot)].filter((dir) => !before.has(dir)).map((dir) => join(runtimeRoot, dir))
  const at = (kind) => events.filter((event) => event[0] === kind)
  return { result, error, events, sleeps, at, leftover, clock: () => clock,
    cleanup() { for (const dir of leftover) rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) } }
}

async function deadline(options, inspect) {
  const run = await deadlineSeat(options)
  try { return inspect(run) } finally { run.cleanup() }
}

test('an explicit wait_s answers a turn just before its deadline and cancels a pending one at it, for pi and claude', async () => {
  for (const agent of ['pi', 'claude']) {
    await deadline({ agent, wait_s: 3, answerAt: 2975 }, (run) => {
      assert.equal(run.error, undefined, agent)
      assert.deepEqual(run.result, { stopReason: 'end_turn', usage: null, refusal: null }, agent)
      assert.deepEqual(run.at('cancel'), [], agent)
    })
    await deadline({ agent, wait_s: 3 }, (run) => {
      assert.equal(run.error.reason, 'acp-seat-deadline', agent)
      assert.match(run.error.message, /planner.*3s/, agent)
      assert.equal(run.result, undefined, agent)
      assert.deepEqual(run.at('cancel'), [['cancel', 41, 3000]], agent)
      assert.equal(run.at('begin').length, 1, agent)
    })
  }
})

test('an omitted wait_s expires at 2,400,000ms and malformed supplied values refuse before any runtime exists', async () => {
  await deadline({}, (run) => {
    assert.equal(run.error.reason, 'acp-seat-deadline')
    assert.deepEqual(run.at('cancel'), [['cancel', 41, 2400000]])
  })
  for (const wait_s of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', NaN, Infinity]) {
    await deadline({ wait_s }, (run) => {
      assert.match(run.error.message, /wait_s must be a positive safe integer/, String(wait_s))
      assert.deepEqual(run.events, [], String(wait_s))
      assert.deepEqual(run.leftover, [], String(wait_s))
    })
  }
  await deadline({ wait_s: Number.MAX_SAFE_INTEGER, answerAt: 25 }, (run) => assert.equal(run.error, undefined))
})

test('a seat that exits before answering fails its turn at once, not at its deadline, for pi and claude', async () => {
  for (const agent of ['pi', 'claude']) {
    await deadline({ agent, wait_s: 60, exitAt: 100 }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-closed', agent)
      assert.match(run.error.message, /planner exited before answering/, agent)
      assert.equal(run.result, undefined, agent)
      assert.ok(run.clock() >= 100 && run.clock() < 1000, `${agent} noticed at ${run.clock()}`)
      assert.deepEqual(run.at('cancel'), [], agent)
      assert.equal(run.at('close').length, 1, agent)
    })
  }
})

test('an answer that settled with the exit is returned, and a late exit does not outrank the deadline', async () => {
  await deadline({ wait_s: 60, answerAt: 100, exitAt: 100 }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(run.result, { stopReason: 'end_turn', usage: null, refusal: null })
  })
  await deadline({ wait_s: 1, exitAt: 5000 }, (run) => assert.equal(run.error?.reason, 'acp-seat-deadline'))
})

test('an answer that settles between an empty poll and the exit marker is returned, not dropped as a closed seat', async () => {
  for (const agent of ['pi', 'claude']) {
    for (const answer of [
      { stopReason: 'end_turn', usage: null, refusal: null },
      { stopReason: 'cancelled', usage: null, refusal: null },
      { stopReason: null, usage: null, refusal: { code: 1, message: 'refused', errorKind: null } },
    ]) {
      await deadline({ agent, wait_s: 60, settleOnExit: true, answer }, (run) => {
        assert.equal(run.error, undefined, agent)
        assert.equal(run.result, answer, agent)
        assert.deepEqual(run.at('poll').map((event) => event[1]), [41, 41], agent)
        assert.deepEqual(run.at('cancel'), [], agent)
        assert.deepEqual(run.at('cancel-session'), [], agent)
        assert.equal(run.at('close').length, 1, agent)
      })
    }
    await deadline({ agent, wait_s: 1, settleOnExit: true, exitPollAdvance: 5000 }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-deadline', agent)
      assert.equal(run.result, undefined, agent)
    })
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' })
    await deadline({ agent, wait_s: 60, exitAt: 0, pollError: eio }, (run) => assert.equal(run.error, eio, agent))
    await deadline({ agent, wait_s: 60, settleOnExit: true, exitPollError: eio }, (run) => {
      assert.equal(run.error, eio, agent)
      assert.equal(run.at('poll').length, 2, agent)
    })
  }
})

test('an answer at or after the deadline, even one that arrives inside the poll, is never returned', async () => {
  for (const [answerAt, pollAdvance] of [[2000, 2000], [2000, 0], [5000, 0]]) {
    await deadline({ wait_s: 2, answerAt, pollAdvance }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-deadline', `${answerAt}/${pollAdvance}`)
      assert.equal(run.result, undefined)
      assert.equal(run.at('cancel').length, 1)
      assert.equal(run.at('cancel')[0][1], 41)
      assert.equal(run.at('cancel-session').length, pollAdvance > 0 ? 1 : 0, 'a settled late turn falls back to the session cancel')
    })
  }
})

test('cancellation is attempted once before close and a cancel failure or throwing close cannot mask the deadline', async () => {
  const unknown = new Error('who knows')
  for (const cancelError of [null, ...['EIO', 'EPERM', 'EINTR'].map((code) => Object.assign(new Error(code), { code })), unknown]) {
    for (const closeError of [null, new Error('close broke')]) {
      await deadline({ wait_s: 1, cancelError, closeError }, (run) => {
        assert.equal(run.error.reason, 'acp-seat-deadline')
        assert.deepEqual(run.events.map((event) => event[0]).filter((kind) => kind === 'cancel' || kind === 'close'), ['cancel', 'close'])
      })
    }
  }
})

test('a proven close removes the runtime and an unproven or unknown close retains it', async () => {
  await deadline({ wait_s: 1, closeOutcome: 'proven' }, (run) => assert.deepEqual(run.leftover.filter((dir) => existsSync(dir)), []))
  for (const closeOutcome of ['unproven', 'unknown']) {
    await deadline({ wait_s: 1, closeOutcome }, (run) => {
      assert.equal(run.leftover.length, 1, closeOutcome)
      assert.equal(existsSync(run.leftover[0]), true, closeOutcome)
    })
  }
  await deadline({ wait_s: 1, closeError: new Error('close broke') }, (run) => {
    assert.equal(run.leftover.length, 1)
    assert.equal(existsSync(run.leftover[0]), true)
  })
})

test('a turn answered at 700,000ms returns the exact normalized object under an explicit 900s and the default deadline, uncancelled', async () => {
  const refused = { stopReason: null, usage: null, refusal: { code: 1, message: 'no', errorKind: null } }
  for (const wait_s of [900, undefined]) {
    for (const answer of [{ stopReason: 'end_turn', usage: { input: 3 }, refusal: null }, refused, { stopReason: 'cancelled', usage: null, refusal: null }]) {
      await deadline({ wait_s, answerAt: 700000, answer }, (run) => {
        assert.equal(run.error, undefined)
        assert.equal(run.result, answer)
        assert.deepEqual(run.at('cancel'), [])
        assert.equal(run.at('close').length, 1)
      })
    }
  }
})

test('a prompt poll failure propagates unchanged through teardown without a cancel', async () => {
  const eio = Object.assign(new Error('pipe'), { code: 'EIO' })
  await deadline({ wait_s: 5, pollError: eio }, (run) => {
    assert.equal(run.error, eio)
    assert.deepEqual(run.at('cancel'), [])
    assert.equal(run.at('close').length, 1)
  })
})

// A fake client that records where the runner placed its runtime; no transport exists.
async function placementSeat(root, deps, closeOutcome = 'proven') {
  const seen = {}
  const answer = { stopReason: 'end_turn', usage: null, refusal: null }
  await runAcpSeat({
    definition: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', skills: [], wait_s: 1 },
    cwd: root, prompt: 'x', sessionFile: join(root, 'session.jsonl'),
    binaries: { pi: BIN },
    deps: {
      now: () => 0,
      clientFactory: ({ dir }) => {
        seen.runtime = dirname(dir)
        deps.during?.(seen)
        return {
          start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1, pollPrompt: () => answer,
          close: () => ({ outcome: closeOutcome }),
        }
      },
      ...deps.seat,
    },
  })
  return seen
}

test('the runtime is created under the injected root and torn down only when proven', async () => {
  const root = scratchDir('acp-seat-root-')
  try {
    const runtimeRoot = join(root, 'runtimes')
    mkdirSync(runtimeRoot)
    const proven = await placementSeat(root, { seat: { runtimeRoot } })
    assert.equal(realpathSync(dirname(proven.runtime)), realpathSync(runtimeRoot))
    assert.match(basename(proven.runtime), /^acp-seat-[A-Za-z0-9]{6}$/)
    assert.equal(existsSync(proven.runtime), false)
    const unproven = await placementSeat(root, { seat: { runtimeRoot } }, 'unproven')
    assert.equal(realpathSync(dirname(unproven.runtime)), realpathSync(runtimeRoot))
    assert.equal(existsSync(unproven.runtime), true)
    assert.equal(existsSync(runtimeRoot), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RI1 a lean seat runtime is created beside its lane task dir and its command FIFO root is that runtime', async () => {
  const root = scratchDir('acp-seat-lane-')
  try {
    const lane = join(root, 'lane')
    const taskDir = join(lane, 'task')
    mkdirSync(taskDir, { recursive: true })
    let input = null
    await runAcpSeat({
      definition: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', skills: [], wait_s: 1 },
      cwd: root, taskDir, prompt: 'x', sessionFile: join(lane, 'session.jsonl'), binaries: { pi: BIN },
      deps: {
        now: () => 0,
        clientFactory: (given) => {
          input = given
          return {
            start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1,
            pollPrompt: () => ({ stopReason: 'end_turn', usage: null, refusal: null }), close: () => ({ outcome: 'unproven' }),
          }
        },
      },
    })
    const runtime = dirname(input.dir)
    assert.equal(realpathSync(dirname(runtime)), join(realpathSync(lane), 'seat-runtime'))
    assert.match(basename(runtime), /^acp-seat-[A-Za-z0-9]{6}$/)
    assert.equal(statSync(dirname(runtime)).mode & 0o077, 0, 'the runtime collection is private')
    assert.equal(input.deps.seatCommandRoot, runtime)
    assert.equal(relative(taskDir, runtime).startsWith('..'), true, 'the runtime stays outside the task tree')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RI2 a seat whose runtime vanishes mid-turn ends with acp-seat-runtime-missing within two polls', async () => {
  const root = scratchDir('acp-seat-vanish-')
  try {
    const runtimeRoot = join(root, 'runtimes')
    mkdirSync(runtimeRoot)
    let clock = 0
    let runtime = null
    let closes = 0
    let polls = 0
    let error = null
    try {
      await runAcpSeat({
        definition: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high', skills: [], wait_s: 3600 },
        cwd: root, prompt: 'x', sessionFile: join(root, 'session.jsonl'), binaries: { pi: BIN },
        deps: {
          runtimeRoot, now: () => clock, sleep: (ms) => { clock += ms; rmSync(runtime, { recursive: true, force: true }) },
          clientFactory: ({ dir }) => {
            runtime = dirname(dir)
            return {
              start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1,
              pollPrompt: () => { polls += 1; return null }, cancelPrompt: () => true, cancel() {},
              close: () => { closes += 1; return { outcome: 'proven' } },
            }
          },
        },
      })
    } catch (caught) { error = caught }
    assert.equal(error?.reason, 'acp-seat-runtime-missing')
    assert.equal(polls, 1, 'the lost runtime is noticed before another poll')
    assert.ok(clock <= 50, `runtime loss cost ${clock}ms`)
    assert.equal(closes, 1)
    assert.equal(existsSync(runtime), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a seat runtime another process creates in the system temp directory survives a turn and its cleanup', async () => {
  // The helper owns its sentinel: it creates, verifies and removes it; the seat harness never lists or reads shared temp.
  const helper = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
    const mode = process.argv[1]
    const state = path.join(process.argv[2], 'sentinel.json')
    if (mode === 'create') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-seat-'))
      fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'foreign')
      fs.writeFileSync(state, JSON.stringify({ dir }))
    } else {
      const { dir } = JSON.parse(fs.readFileSync(state, 'utf8'))
      let intact = false
      try { intact = fs.readFileSync(path.join(dir, 'sentinel.txt'), 'utf8') === 'foreign' } catch { /* missing or unreadable is not intact */ }
      fs.rmSync(dir, { recursive: true, force: true })
      process.exit(intact ? 0 : 3)
    }`
  const root = scratchDir('acp-seat-foreign-')
  const run = (mode) => spawnSync(BIN, ['-e', helper, mode, root], { encoding: 'utf8', timeout: 10000 })
  let created = false
  try {
    // Created between the turn's start and its cleanup, where a shared-temp diff would adopt it.
    const turn = await deadlineSeat({ wait_s: 1, onStart: () => { assert.equal(run('create').status, 0); created = true } })
    assert.ok(created)
    turn.cleanup()
    assert.equal(run('verify').status, 0, 'the foreign runtime was removed or changed')
  } finally {
    if (created && existsSync(join(root, 'sentinel.json'))) run('verify')
    rmSync(root, { recursive: true, force: true })
  }
})

// Launches the real runner against a recording client factory: the launch an agent definition's arms produce, no process.
function armLaunch(agent, role, arms, { env = {}, ...options } = {}) {
  const root = scratchDir('acp-seat-arms-')
  const cwd = join(root, 'checkout')
  const taskDir = join(root, 'lane')
  const runtimeRoot = join(root, 'runtime')
  const baseAgentDir = join(root, 'base-agent')
  for (const dir of [cwd, taskDir, runtimeRoot, baseAgentDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(baseAgentDir, 'auth.json'), '{}')
  writeFileSync(join(baseAgentDir, 'settings.json'), JSON.stringify({ theme: 'dark', codemode: { mode: 'off', keep: 1 } }))
  const created = []
  const definition = {
    role, agent, writes: role === 'builder' ? 'repo' : 'task-dir', effort: 'high', skills: [],
    model: agent === 'pi' ? 'openai/gpt-6.1-sol' : agent === 'muse' ? 'meta/muse-spark-1.3' : 'anthropic/claude-opus-4-6', ...arms,
  }
  const run = () => runAcpSeat({
    definition, cwd, taskDir, prompt: 'p', sessionFile: join(taskDir, 'session.jsonl'),
    binaries: { pi: BIN, claude: BIN, claudeAcp: BIN, muse: BIN },
    deps: {
      // The fff server binary is a host install; the launch shape must not depend on this host having it.
      runtimeRoot, env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: baseAgentDir, ...env }, exists: (path) => path === '/opt/homebrew/bin/fff-mcp' || existsSync(path), ...options.deps,
      clientFactory(input) {
        created.push(input.launch)
        return {
          start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt() { return 1 },
          pollPrompt() { return { stopReason: 'end_turn', refusal: null } }, close() { return { outcome: 'unproven' } },
        }
      },
    },
  })
  return { run, created, cwd, taskDir, runtimeRoot, baseAgentDir }
}
const armed = async (...args) => { const probe = armLaunch(...args); await probe.run(); return { ...probe, launch: probe.created[0] } }
const claudeOptions = (launch) => launch.sessionParams._meta.claudeCode.options
const piExtensions = (launch) => launch.args.flatMap((arg, index, args) => arg === '-e' ? [args[index + 1]] : [])
const piTools = (launch) => launch.args[launch.args.indexOf('--tools') + 1].split(',')
const FFF_TOOLS = ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']

test('a claude seat that declares fff launches with the fff server, its tools and CREW_FFF; one that does not has none', async () => {
  const { launch } = (await armed('claude', 'planner', { extensions: ['fff'] }))
  const options = claudeOptions(launch)
  assert.deepEqual(options.mcpServers, { fff: { command: '/opt/homebrew/bin/fff-mcp', args: [] } })
  for (const tool of FFF_TOOLS) { assert.ok(options.allowedTools.includes(tool)); assert.ok(options.tools.includes(tool)) }
  assert.equal(launch.env.CREW_FFF, '1')
  for (const tool of ['Glob', 'Grep']) assert.ok(options.disallowedTools.includes(tool), `fff denies native ${tool}`)
  const bare = (await armed('claude', 'planner', {}))
  assert.equal(claudeOptions(bare.launch).mcpServers, undefined)
  for (const tool of ['Glob', 'Grep']) assert.ok(!claudeOptions(bare.launch).disallowedTools.includes(tool))
  assert.equal(bare.launch.env.CREW_FFF, '0')
})

// MUTATION: silently discard a missing extension grant.
test('both agents refuse a retired lab grant before client construction', async () => {
  for (const agent of ['pi', 'claude']) {
    const probe = armLaunch(agent, 'planner', { extensions: ['lab'] })
    await assert.rejects(() => probe.run(), { reason: 'extension-missing' })
    assert.equal(probe.created.length, 0)
  }
})

test('a claude seat refuses the arms it cannot carry before a client: subagent, alone or beside arms it can', async () => {
  const requests = [
    { extensions: ['subagent'] }, { extensions: ['readgate', 'subagent'] }, { extensions: ['subagent'], advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' } },
  ]
  for (const arms of requests) {
    const probe = armLaunch('claude', 'builder', arms)
    await assert.rejects(() => probe.run(), { reason: 'grant-unsupported' }, JSON.stringify(arms))
    assert.equal(probe.created.length, 0, JSON.stringify(arms))
    assert.deepEqual(readdirSync(probe.runtimeRoot), [], 'a refused seat leaves no runtime')
  }
  // Only a requested arm refuses: false is the absence of the arm.
  assert.equal((await armed('claude', 'builder', { advisor: null, extensions: [] })).created.length, 1)
})

test('a claude seat granted nothing launches without plugins', async () => {
  assert.equal(Object.hasOwn(claudeOptions((await armed('claude', 'builder', {})).launch), 'plugins'), false)
})

// The lane context a lean pi seat's context arms read: the loop's run-start and the planner's return, in the lane's own task dir.
const laneDetails = { subject: 'fix(crew): resolve lean arm context', plan_path: 'plan.md', gate_path: 'gate.mjs', acceptance: ['AC1'], mutations: [{ check: 'AC1', file: 'a.mjs', find: 'a', replace: 'b' }], files_in_scope: ['a.mjs'], validation_lane: 'node --test a.test.mjs', gate_cmd: 'node gate.mjs' }
function leanLane(taskDir, { anchor = Date.now() - 60_000, details = laneDetails, number = 3, mtime = anchor + 5_000 } = {}) {
  if (anchor !== null) writeFileSync(join(taskDir, 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: anchor, lane: 'lane', run_id: 'lane' })}\n`)
  if (details !== null) {
    if (details.plan_path === laneDetails.plan_path) writeFileSync(join(taskDir, details.plan_path), '# plan\n')
    const path = join(taskDir, `planner-${number}.json`)
    writeFileSync(path, JSON.stringify({ role: 'planner', id: `lane.planner.${number}`, status: 'done', summary: 's', details }))
    utimesSync(path, mtime / 1000, mtime / 1000)
  }
}
test('a muse seat granted skeletonread launches crew-extras retrieve and refuses without lane context', async () => {
  const taskDir = scratchDir('muse-context-')
  try {
    leanLane(taskDir)
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', taskDir, definition: { role: 'builder', extensions: ['skeletonread'] } }, (run) => {
      assert.equal(run.error, undefined)
      const server = sessionNew(run).params.mcpServers[0]
      assert.equal(server.name, 'crew-extras')
      assert.deepEqual(JSON.parse(server.env.find((entry) => entry.name === 'CREW_EXTRAS').value), ['retrieve', 'skeleton'])
      assert.match(run.sent.find((frame) => frame.method === 'session/prompt').params.prompt[0].text, /mcp__crew-extras__retrieve/)
    })
    rmSync(join(taskDir, 'plan.md'))
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', taskDir, definition: { role: 'builder', extensions: ['skeletonread'] } }, (run) => {
      assert.equal(run.error?.reason, 'grant-unsupported')
      assert.equal(run.launches.length, 0)
    })
  } finally { rmSync(taskDir, { recursive: true, force: true }) }
})

test('a muse builder granted skeletonread is refused a whole read of a large in-scope file and pointed at the skeleton tool, and keeps ranged and small reads', async () => {
  const root = scratchDir('muse-skeleton-')
  const taskDir = join(root, 'task')
  try {
    mkdirSync(taskDir)
    leanLane(taskDir)
    writeFileSync(join(root, 'a.mjs'), 'export const a = 1\n'.repeat(351))
    writeFileSync(join(root, 'b.mjs'), 'export const b = 1\n')
    const permissions = [{ path: 'a.mjs' }, { path: 'a.mjs', offset: 1, limit: 20 }, { path: 'b.mjs' }]
      .map((rawInput, i) => ({ toolCallId: `r${i}`, _update: { sessionUpdate: 'tool_call', toolCallId: `r${i}`, kind: 'read', title: 'read_file', rawInput } }))
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', cwd: root, taskDir, definition: { role: 'builder', writes: 'repo', extensions: ['readgate', 'skeletonread'] }, permissions, deps: { exists: () => true } }, (run) => {
      assert.equal(run.error, undefined)
      assert.deepEqual(run.replies.map((reply) => reply?.optionId), ['deny', 'yes', 'yes'])
      assert.match(run.sent.find((frame) => frame.method === 'session/prompt').params.prompt[0].text, /call mcp__crew-extras__skeleton with its path/)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a muse seat granted subagent launches crew-extras agent with the registered scout', async () => {
  await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', definition: { role: 'builder', extensions: ['subagent'] } }, (run) => {
    assert.equal(run.error, undefined)
    const server = sessionNew(run).params.mcpServers[0]
    assert.deepEqual(JSON.parse(server.env.find((entry) => entry.name === 'CREW_EXTRAS').value), ['agent'])
    assert.deepEqual(JSON.parse(server.env.find((entry) => entry.name === 'CREW_PI_AGENTS').value).map((entry) => entry.name), ['scout'])
    assert.equal(server.env.find((entry) => entry.name === 'CREW_PI_BINARY')?.value, BIN)
    assert.match(run.sent.find((frame) => frame.method === 'session/prompt').params.prompt[0].text, /mcp__crew-extras__agent/)
  })
  const binDir = scratchDir('muse-pi-bin-')
  try {
    for (const available of [false, true]) {
      if (available) symlinkSync(BIN, join(binDir, 'pi'))
      await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', definition: { role: 'builder', extensions: ['subagent'] }, binaries: { muse: BIN }, deps: { env: { PATH: binDir } } }, (run) => {
        assert.equal(run.error, undefined)
        assert.equal(sessionNew(run).params.mcpServers[0].env.find((entry) => entry.name === 'CREW_PI_BINARY')?.value, available ? join(binDir, 'pi') : '')
      })
    }
  } finally { rmSync(binDir, { recursive: true, force: true }) }
  const register = structuredClone(loadCapabilities())
  for (const role of Object.values(register.roles)) for (const group of [role, ...Object.values(role.by_agent ?? {})]) group.agents = []
  await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', definition: { role: 'builder', extensions: ['subagent'] }, deps: { register } }, (run) => {
    assert.equal(run.error?.reason, 'unknown-grant')
    assert.equal(run.launches.length, 0)
  })
})

test('a muse subagent grant nudges after reads across directories and journals once', async () => {
  const taskDir = scratchDir('muse-nudge-')
  try {
    const updates = Array.from({ length: 8 }, (_, i) => ({ sessionUpdate: 'tool_call', toolCallId: `read-${i}`, kind: 'read', rawInput: { path: `dir${i % 3}/file.mjs` } }))
    for (const granted of [false, true]) {
      writeFileSync(join(taskDir, 'journal.jsonl'), '')
      await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', taskDir, permissionsOnlyFirst: true, definition: { role: 'builder', extensions: granted ? ['subagent'] : [] }, permissions: [{ toolCallId: 'reads', _update: updates }] }, (run) => {
        const rows = readFileSync(join(taskDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
        assert.deepEqual(rows.filter((row) => row.scout_nudge).map((row) => row.scout_nudge), granted ? [{ reads: 8, directories: 3 }] : [])
        assert.equal(run.error, undefined)
        const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
        assert.equal(prompts.length, granted ? 2 : 1)
        if (granted) assert.match(prompts[1].params.prompt[0].text, /asking a scout/)
      })
    }
  } finally { rmSync(taskDir, { recursive: true, force: true }) }
})

test('a muse builder advisor journals its note and delivers it in a follow-up prompt', async () => {
  const taskDir = scratchDir('muse-advisor-')
  try {
    leanLane(taskDir)
    const advisor = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', taskDir, definition: { role: 'builder', advisor }, permissions: [{ toolCallId: 'outside', _update: { sessionUpdate: 'tool_call', toolCallId: 'outside', kind: 'edit', rawInput: { path: 'outside.mjs', content: 'x' } } }] }, (run) => {
      assert.equal(run.error, undefined)
      assert.ok(existsSync(join(taskDir, 'advisor-manifest.json')))
      assert.ok(readFileSync(join(taskDir, 'journal.jsonl'), 'utf8').split('\n').some((line) => line && JSON.parse(line).advisor_note?.tier === 0))
      const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
      assert.equal(prompts.length, 2)
      assert.match(prompts[1].params.prompt[0].text, /outside\.mjs/)
    })
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', taskDir, definition: { role: 'reviewer', advisor } }, (run) => {
      assert.equal(run.error?.reason, 'grant-unsupported')
      assert.equal(run.launches.length, 0)
    })
  } finally { rmSync(taskDir, { recursive: true, force: true }) }
})

function advisorChild(hang = false) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdin = { end(value) {
    if (hang) return
    setImmediate(() => {
      const request = JSON.parse(value)
      const anchor = request.delta.flatMap((entry) => String(entry.text).split('\n')).map((line) => /^([^:]+:\d+): /.exec(line)?.[1]).find(Boolean)
      const judgment = { class: 'edge-path', severity: 'medium', claim: 'guard handles a grounded edge case', evidence: [anchor] }
      child.stdout.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: JSON.stringify(judgment), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })}\n`)
      child.emit('close', 0)
    })
  } }
  child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); return true }
  return child
}

async function museAdvisorConsult(kind, inspect) {
  const root = scratchDir('muse-consult-'), taskDir = join(root, 'task'), cwd = join(root, 'work')
  mkdirSync(taskDir); mkdirSync(cwd); leanLane(taskDir)
  writeFileSync(join(cwd, 'a.mjs'), 'grounded condition\n')
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'read', kind: 'read', rawInput: { path: 'a.mjs' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'grounded condition' },
    { sessionUpdate: 'tool_call', toolCallId: 'fire', kind: kind === 'pre-return' ? 'write' : 'edit', rawInput: { path: kind === 'pre-return' ? join(taskDir, 'builder-1.json') : 'outside.mjs', content: 'x' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'fire', status: 'completed', rawOutput: 'ok' },
  ]
  let clock = 0
  try {
    await use('pi-turn', { agent: 'muse', model: 'meta/muse-spark-1.3', cwd, taskDir, permissionsOnlyFirst: true, delayPrompt: true,
      definition: { role: 'builder', wait_s: 1, advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' } },
      permissions: [{ toolCallId: 'fire', _update: updates }],
      deps: { now: () => clock, sleep: (ms) => { clock += ms }, wait: async (ms) => { clock += ms; await new Promise(setImmediate) }, advisorDeps: { spawn: () => advisorChild(kind === 'timeout'), consultTimeoutMs: kind === 'timeout' ? 10 : 5000, childKillGraceMs: 10 } },
    }, (run) => inspect(run, readFileSync(join(taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('a muse builder advisor tier-1 consult settles during polling and delivers its note in a follow-up prompt', async () => {
  await museAdvisorConsult('tier1', (run, rows) => {
    assert.ok(rows.some((row) => row.advisor_consult?.trigger === 'tier0-note'))
    assert.equal(run.error, undefined)
    assert.ok(rows.some((row) => row.advisor_note?.tier === 1 && row.advisor_note.outcome === 'injected'))
    assert.match(run.sent.filter((frame) => frame.method === 'session/prompt').at(-1).params.prompt[0].text, /guard handles a grounded edge case/)
  })
})

test('a muse builder advisor pre-return verdict settles before the seat returns and sends its block as a follow-up prompt', async () => {
  await museAdvisorConsult('pre-return', (run, rows) => {
    assert.ok(rows.some((row) => row.advisor_consult?.trigger === 'pre-return'))
    assert.equal(run.error, undefined)
    const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
    assert.equal(prompts.length, 2)
    assert.match(prompts[1].params.prompt[0].text, /guard handles a grounded edge case/)
  })
})

test('a muse builder advisor consult that times out lets the seat return and journals the failure', async () => {
  await museAdvisorConsult('timeout', (run, rows) => {
    assert.ok(rows.some((row) => row.advisor_cell_failure?.kind === 'timeout'))
    assert.equal(run.error, undefined)
    assert.equal(run.result.stopReason, 'end_turn')
  })
})

test('adapter-muse accepts fff with crew-extras and refuses foreign servers and pi extensions', async () => {
  const fff = { name: 'fff', command: { bin: BIN, args: [] }, url: null }
  const spec = { bin: BIN, cwd: '/tmp', model: 'm', effort: 'high', grants: { mcp_servers: [fff], skeletonread: true, agents: [], advisor: true }, env: { CREW_ROLE: 'builder', CREW_TASK_DIR: '/tmp/task' } }
  let launch
  assert.doesNotThrow(() => { launch = muse.acpLaunch(spec) })
  assert.deepEqual(launch.sessionParams.mcpServers.map((server) => server.name), ['fff', 'crew-extras'])
  assert.equal(launch.sessionParams.mcpServers[1].command, BIN)
  for (const grants of [{ extensions: ['/tmp/foo.ts'] }, { mcp_servers: [{ ...fff, name: 'foreign' }] }, { mcp_servers: [{ ...fff, name: 'crew-extras' }] }, { mcp_servers: [{ ...fff, type: 'http' }] }, { mcp_servers: [{ name: 'fff', command: null, url: 'https://example.com' }] }]) {
    assert.throws(() => muse.acpLaunch({ ...spec, grants }), { reason: 'grant-unsupported' })
  }
})

const advisorArm = { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }
const contextArms = { advisor: advisorArm, extensions: ['skeletonread'] }
const refusedBeforeClient = async (arms, lane, options = {}) => {
  const probe = armLaunch('pi', 'builder', arms, options)
  lane(probe.taskDir)
  await assert.rejects(() => probe.run(), { reason: 'grant-unsupported' }, JSON.stringify(arms))
  assert.equal(probe.created.length, 0, 'a refused seat constructs no client')
  assert.deepEqual(readdirSync(probe.runtimeRoot), [], 'a refused seat leaves no runtime')
  return probe
}

// MUTATION: disable the pi advisor role predicate
test('pi refuses unsupported advisor roles before client construction', async () => {
  for (const role of ['planner', 'reviewer', 'lead', 'tech-lead', undefined]) {
    const probe = armLaunch('pi', role, { advisor: advisorArm })
    leanLane(probe.taskDir)
    await assert.rejects(() => probe.run(), (error) => error.reason === 'grant-unsupported' && /advisor/.test(error.message) && error.message.includes(role ?? 'seat'))
    assert.equal(probe.created.length, 0)
    assert.deepEqual(readdirSync(probe.runtimeRoot), [])
    const bare = armLaunch('pi', role, {})
    await bare.run()
    assert.equal(bare.created.length, 1)
  }
  for (const role of ['builder']) {
    const probe = armLaunch('pi', role, { advisor: advisorArm })
    leanLane(probe.taskDir)
    await probe.run()
    assert.equal(probe.created.length, 1)
  }
})

test('the shipped mechanical builder launches without a plan while the planned builder still requires one', async () => {
  const { fields, defects } = parseAgent(readFileSync(join(ROOT, 'crew', 'agents', 'builder.md'), 'utf8'))
  assert.deepEqual(defects, [])
  for (const tier of ['mechanical', 'build']) {
    const effective = { ...fields, ...fields.tiers?.[tier] }
    const probe = armLaunch('pi', 'builder', { extensions: effective.extensions, advisor: effective.advisor })
    leanLane(probe.taskDir, { details: null })
    if (tier === 'mechanical') {
      await assert.doesNotReject(() => probe.run())
      assert.equal(probe.created.length, 1)
    } else {
      await assert.rejects(() => probe.run(), { reason: 'grant-unsupported' })
      leanLane(probe.taskDir)
      await probe.run()
      assert.equal(probe.created.length, 1)
    }
  }
})

// MUTATION: drop the criteria field from the manifest
test('the advisor manifest carries the accepted plan criteria and named tests', async () => {
  const probe = armLaunch('pi', 'builder', contextArms)
  leanLane(probe.taskDir, { details: { ...laneDetails, tests: [{ file: 'a.test.mjs', title: 'T1' }] } })
  writeFileSync(join(probe.taskDir, 'plan.md'), '## Criteria\n1. first\nignored\n2. second\n## Tasks\n1. outside\n')
  await probe.run()
  const manifest = JSON.parse(readFileSync(join(probe.taskDir, 'advisor-manifest.json'), 'utf8'))
  assert.deepEqual(manifest.criteria, ['1. first', '2. second'])
  assert.deepEqual(manifest.tests, [{ file: 'a.test.mjs', title: 'T1' }])
  assert.equal('tripwires' in manifest, false)
  assert.equal('acceptance_items' in manifest, false)
})

test('a large advisor basis stays within the manifest read cap', async () => {
  for (const text of ['x', '\u0001']) {
    const probe = armLaunch('pi', 'builder', { advisor: advisorArm })
    const tests = Array.from({ length: 32 }, (_, i) => ({ file: `a${i}.test.mjs`, title: text.repeat(200) }))
    leanLane(probe.taskDir, { details: { ...laneDetails, tests } })
    writeFileSync(join(probe.taskDir, 'plan.md'), `## Criteria\n${Array.from({ length: 60 }, (_, i) => `${i + 1}. ${text.repeat(996)}`).join('\n')}\n`)
    await assert.doesNotReject(() => probe.run())
    const raw = readFileSync(join(probe.taskDir, 'advisor-manifest.json'), 'utf8')
    const manifest = JSON.parse(raw)
    assert.ok(Buffer.byteLength(raw) <= 65_536)
    assert.equal(probe.created.length, 1)
    assert.ok(manifest.criteria?.length > 0)
    assert.equal(manifest.tests.length, 32)
    assert.deepEqual(advisorContext({ taskDir: probe.taskDir, env: {} }).files_in_scope, ['a.mjs'])
  }
})

// MUTATION: take tests only when the accepted plan is readable
test('an advisor-only seat whose accepted plan is unreadable boots with no criteria and keeps the named tests', async () => {
  const probe = armLaunch('pi', 'builder', { advisor: advisorArm })
  leanLane(probe.taskDir, { details: { ...laneDetails, plan_path: 'missing.md', tests: [{ file: 'a.test.mjs', title: 'T1' }] } })
  await assert.doesNotReject(() => probe.run())
  assert.equal(probe.created.length, 1)
  const manifest = JSON.parse(readFileSync(join(probe.taskDir, 'advisor-manifest.json'), 'utf8'))
  assert.deepEqual(manifest.criteria, [])
  assert.deepEqual(manifest.tests, [{ file: 'a.test.mjs', title: 'T1' }])
})

test('a lean pi builder declaring advisor and skeletonread launches with both on the lane layout', async () => {
  const probe = armLaunch('pi', 'builder', contextArms)
  const anchor = Date.now() - 60_000
  leanLane(probe.taskDir, { anchor })
  await probe.run()
  const [launch] = probe.created
  assert.equal(launch.env.CREW_CONTEXT_LAYOUT, 'lean')
  assert.equal(launch.env.CREW_TASK_DIR, probe.taskDir)
  assert.equal(launch.env.CREW_ADVISOR, '1')
  for (const name of ['advisor', 'skeletonread']) assert.ok(piExtensions(launch).includes(join(ROOT, 'crew', 'pi', 'extensions', `${name}.ts`)), name)
  assert.ok(piTools(launch).includes('retrieve'))
  const manifest = JSON.parse(readFileSync(join(probe.taskDir, 'advisor-manifest.json'), 'utf8'))
  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.run_started_at, anchor, 'the manifest is dated by the lane start, never the seat start')
  assert.deepEqual(manifest.criteria, [])
  assert.deepEqual(manifest.tests, [])
  assert.deepEqual(manifest.cell, { provider: 'openai', id: 'gpt-6.1-sol', agent: 'pi', effort: 'high', model: 'openai/gpt-6.1-sol' })
  assert.equal(existsSync(join(probe.taskDir, 'advisor-manifest.json.tmp')), false)
  const replanned = armLaunch('pi', 'builder', contextArms)
  leanLane(replanned.taskDir, { anchor })
  const accepted = JSON.parse(readFileSync(join(replanned.taskDir, 'planner-3.json'), 'utf8'))
  writeFileSync(join(replanned.taskDir, 'planner-4.json'), JSON.stringify({ ...accepted, details: { ...accepted.details, subject: 'invalid' } }))
  writeFileSync(join(replanned.taskDir, 'planner-5.json'), JSON.stringify({ ...accepted, status: 'insufficient', details: { ...accepted.details, files_in_scope: ['wrong.mjs'] } }))
  await replanned.run()
  const env = { CREW_CONTEXT_LAYOUT: 'lean', CREW_TASK_DIR: replanned.taskDir }
  assert.equal(loadAcceptedContext({ taskDir: replanned.taskDir, cwd: replanned.cwd, env })?.planner_number, 3)
  assert.deepEqual(advisorContext({ taskDir: replanned.taskDir, env }).files_in_scope, ['a.mjs'])
})

test('a lean pi seat with context arms refuses before a client when the lane has no run-start of its own, whatever its parent holds', async () => {
  for (const arms of [{ advisor: advisorArm }, { extensions: ['skeletonread'] }]) {
    await refusedBeforeClient(arms, (taskDir) => {
      // The old layout's journal and returns beside the task dir are another lane's context.
      writeFileSync(join(dirname(taskDir), 'journal.jsonl'), `${JSON.stringify({ event: 'run-start', at: 1, run_id: 'foreign' })}\n`)
      mkdirSync(join(dirname(taskDir), 'returns', 'foreign'), { recursive: true })
      leanLane(taskDir, { anchor: null })
    })
  }
  await refusedBeforeClient({ extensions: ['skeletonread'] }, (taskDir) => { leanLane(taskDir); writeFileSync(join(taskDir, 'journal.jsonl'), 'not json\n{"event":"stage-start"}\n') })
})

test('a lean pi seat with context arms refuses when the lane planner return is missing, stale, newest-invalid or lacks what an arm reads', async () => {
  const arms = { extensions: ['skeletonread'] }
  await refusedBeforeClient(arms, (taskDir) => leanLane(taskDir, { details: null }))
  await refusedBeforeClient(arms, (taskDir) => leanLane(taskDir, { anchor: Date.now() - 60_000, mtime: Date.now() - 120_000 }))
  await refusedBeforeClient({ extensions: ['skeletonread'] }, (taskDir) => leanLane(taskDir, { details: { ...laneDetails, files_in_scope: [] } }))
  // A malformed or unreadable newer return cannot silently fall back to an older plan.
  await refusedBeforeClient(arms, (taskDir) => {
    leanLane(taskDir, { number: 2 })
    writeFileSync(join(taskDir, 'planner-9.json'), '{"role":"planner"')
  })
  await refusedBeforeClient(arms, (taskDir) => { leanLane(taskDir, { number: 2 }); leanLane(taskDir, { number: 9 }) }, { deps: { readFileSync: (path, ...args) => { if (String(path).endsWith('planner-9.json')) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return readFileSync(path, ...args) } } })
  // A planner seat has no planner return yet, but still needs the lane's anchor.
  const planner = armLaunch('pi', 'planner', { extensions: ['skeletonread'] })
  leanLane(planner.taskDir, { details: null })
  await planner.run()
  assert.equal(planner.created.length, 1)
})

test('a lean pi seat granted the advisor refuses without a pi cell or a written manifest, and never boots silently', async () => {
  for (const advisor of [{ agent: 'claude', model: 'anthropic/claude-opus-4-6', effort: 'high' }, { agent: 'pi', model: 'not a model', effort: 'high' }, { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'huge' }]) {
    await refusedBeforeClient({ advisor }, (taskDir) => leanLane(taskDir))
  }
  const failing = await refusedBeforeClient({ advisor: advisorArm }, (taskDir) => leanLane(taskDir), { deps: { writeFileSync: (path, ...rest) => { if (path.includes('advisor-manifest')) throw new Error('disk full'); return writeFileSync(path, ...rest) } } })
  assert.equal(existsSync(join(failing.taskDir, 'advisor-manifest.json')), false)
})

// MUTATION: admit extensions, or compute contextArms for claude.
test('a claude seat refuses readgate, skeletonread and an advisor before a client', async () => {
  for (const arms of [{ extensions: ['readgate'] }, { extensions: ['skeletonread'] }, { advisor: advisorArm }]) {
    const probe = armLaunch('claude', 'builder', arms)
    leanLane(probe.taskDir)
    await assert.rejects(() => probe.run(), { reason: 'grant-unsupported' })
    assert.equal(probe.created.length, 0)
    assert.deepEqual(readdirSync(probe.runtimeRoot), [])
    assert.equal(existsSync(join(probe.taskDir, 'advisor-manifest.json')), false)
  }
})

const claudeSpec = (grants = {}) => {
  const dir = scratchDir('acp-seat-claude-launch-')
  return { bin: BIN, claudeBin: BIN, cwd: dir, model: 'claude-opus-4-6', tools: 'Read', deny: '', effort: 'high', promptFile: join(dir, 'p.md'), writableDirs: [dir], env: {}, role: 'builder', taskDir: dir, grants: { tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [], mcp_servers: [], ...grants } }
}

// MUTATION: drop the advisor refusal.
test('claude acpLaunch refuses an advisor grant it cannot carry', async () => {
  assert.throws(() => claude.acpLaunch(claudeSpec({ advisor: true })), { reason: 'grant-unsupported' })
  assert.equal(typeof claude.acpLaunch(claudeSpec()), 'object')
})

// MUTATION: restore policy in acpLaunch.
test('the claude adapter ships no arms, capability profile or launch policy', async () => {
  for (const name of ['capabilitiesFor', 'ACP_BINARY', 'PANE_USAGE_SETTINGS', 'writeSeatArms', 'hasFffPreToolUseHook', 'hasSkillIsolationSettings']) assert.equal(name in claude, false)
  assert.equal(typeof claude.CLAUDE_SEAT_SETTINGS, 'string')
  assert.equal(existsSync(claude.CLAUDE_SEAT_SETTINGS), true)
  assert.equal(existsSync(join(ROOT, 'crew/adapters/claude-arms.mjs')), false)
  assert.equal(Object.hasOwn(claude.acpLaunch(claudeSpec()), 'policy'), false)
})

test('every native extension reaches a pi launch as its checkout extension with its tool; none declared loads none', async () => {
  const tools = { readgate: null }
  for (const [name, tool] of Object.entries(tools)) {
    const { launch } = (await armed('pi', 'builder', { extensions: [name] }))
    assert.deepEqual(piExtensions(launch), [join(ROOT, 'crew', 'pi', 'extensions', `${name}.ts`)])
    if (tool) assert.ok(piTools(launch).includes(tool))
  }
  assert.deepEqual(piExtensions((await armed('pi', 'builder', {})).launch), [])
  assert.equal((await armed('pi', 'builder', {})).launch.env.PI_CODING_AGENT_DIR, undefined)
})

test('a pi seat that declares subagent carries the registered agents the extension needs', async () => {
  const { launch } = (await armed('pi', 'planner', { extensions: ['subagent'] }))
  assert.deepEqual(piExtensions(launch), [join(ROOT, 'crew', 'pi', 'extensions', 'subagent.ts')])
  assert.ok(piTools(launch).includes('agent'))
  assert.deepEqual(JSON.parse(launch.env.CREW_PI_AGENTS).map((agent) => agent.name), ['scout'])
  const builder = (await armed('pi', 'builder', { extensions: ['subagent'] })).launch
  assert.deepEqual(JSON.parse(builder.env.CREW_PI_AGENTS).map((agent) => agent.name), ['scout'])
})

test('a pi seat that declares fff excludes native find and grep; one that does not keeps them', async () => {
  const excluded = (launch) => { const i = launch.args.indexOf('--exclude-tools'); return i < 0 ? [] : launch.args[i + 1].split(',') }
  const { launch } = (await armed('pi', 'builder', { extensions: ['fff'] }))
  for (const tool of ['find', 'grep']) assert.ok(excluded(launch).includes(tool), `fff excludes native ${tool}`)
  assert.deepEqual(excluded((await armed('pi', 'builder', {})).launch).filter((tool) => ['find', 'grep'].includes(tool)), [])
})

test('a pi seat that declares fff gets builtin MCP, its tools and a runtime agent dir carrying the server', async () => {
  const probe = (await armed('pi', 'planner', { extensions: ['fff'] }))
  const { launch } = probe
  assert.equal(launch.env.CREW_FFF, '1')
  for (const tool of FFF_TOOLS) assert.ok(piTools(launch).includes(tool), tool)
  const agentDir = launch.env.PI_CODING_AGENT_DIR
  assert.ok(agentDir.startsWith(probe.runtimeRoot), 'the agent dir is runtime, never the lane task dir')
  assert.equal(agentDir, join(readdirSync(probe.runtimeRoot).map((name) => join(probe.runtimeRoot, name))[0], 'pi-agent', 'planner'))
  const mcp = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers
  assert.deepEqual(mcp.fff, { command: '/opt/homebrew/bin/fff-mcp', args: [], exposure: 'direct' })
  assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).codemode.mode, 'off')
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{}')
})

test('a pi MCP seat refuses an empty agent directory before creating a client', async () => {
  const probe = armLaunch('pi', 'planner', { extensions: ['fff'] }, { env: { PI_CODING_AGENT_DIR: '' } })
  await assert.rejects(() => probe.run(), { reason: 'grant-unsupported', message: /PI_CODING_AGENT_DIR must not be empty/ })
  assert.equal(probe.created.length, 0)
})

test('a pi seat refuses an MCP grant that a project MCP config would override', async () => {
  const probe = armLaunch('pi', 'planner', { extensions: ['fff'] })
  mkdirSync(join(probe.cwd, '.pi'), { recursive: true })
  writeFileSync(join(probe.cwd, '.pi', 'mcp.json'), '{}')
  await assert.rejects(() => probe.run(), { reason: 'grant-unsupported' })
  assert.equal(probe.created.length, 0)
})

test('a declared asset that is missing refuses the seat, and an unknown extension is not guessed', async () => {
  const missing = armLaunch('claude', 'planner', { extensions: ['fff'] }, { deps: { exists: () => false } })
  await assert.rejects(() => missing.run(), { reason: 'extension-missing' })
  const ext = armLaunch('pi', 'planner', { extensions: ['readgate'] }, { deps: { exists: () => false } })
  await assert.rejects(() => ext.run(), { reason: 'extension-missing' })
  const unknown = armLaunch('pi', 'planner', { extensions: ['../escape'] })
  await assert.rejects(() => unknown.run(), { reason: 'unknown-grant' })
  for (const probe of [missing, ext, unknown]) assert.equal(probe.created.length, 0)
})

test('both ACP launches carry the seat role and the lane task dir, not the runtime or cwd, over ambient values', async () => {
  for (const agent of ['pi', 'claude']) {
    for (const role of ['planner', 'builder']) {
      const probe = (await armed(agent, role, {}, { env: { CREW_ROLE: 'poison', CREW_TASK_DIR: '/poison' } }))
      assert.equal(probe.launch.env.CREW_ROLE, role)
      assert.equal(probe.launch.env.CREW_TASK_DIR, resolve(probe.taskDir))
      assert.notEqual(probe.launch.env.CREW_TASK_DIR, probe.cwd)
    }
  }
})

test('a claude seat with no MCP grants is still strict about MCP config', async () => {
  const options = claudeOptions((await armed('claude', 'planner', {})).launch)
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.mcpServers, undefined)
})

test('a lean skeletonread seat refuses a planner return its reader rejects for sharing the run-start mtime', async () => {
  const anchor = Date.now() - 60_000
  await refusedBeforeClient({ extensions: ['skeletonread'] }, (taskDir) => leanLane(taskDir, { anchor, mtime: anchor }))
})

test('a failed receipt-time clock is non-load-bearing and cannot change the seat outcome', async () => {
  // MUTATION: move the clock outside recordUpdate's recording-only try/catch.
  await use('claude-turn', { deps: { recordNow: () => { throw new Error('clock unavailable') } } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.result.stopReason, 'end_turn')
    assert.deepEqual(run.rows, [{ prior: true }])
  })
})
