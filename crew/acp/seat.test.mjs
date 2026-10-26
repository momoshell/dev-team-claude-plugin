import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ROOT, scratchDir } from '../../test/helpers.mjs'
import { runAcpSeat } from './seat.mjs'
import { PANE_USAGE_SETTINGS } from '../adapters/adapter-claude.mjs'

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
function replaySeat(name, options = {}) {
  const root = scratchDir('acp-seat-test-')
  const runtimeRoot = join(root, 'runtimes')
  mkdirSync(runtimeRoot)
  const records = fixture(name)
  const sent = []
  const launches = []
  const expected = []
  const plugins = []
  const kills = []
  let stream = null
  let clock = 1000
  let groupGone = false
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
    if (frame.method === 'session/prompt') {
      options.permissions?.forEach((toolCall, i) => appendFileSync(stream, `${JSON.stringify({
        jsonrpc: '2.0', id: `permit-${i}`, method: 'session/request_permission',
        params: { sessionId: 'fixture', toolCall, options: toolCall?._options ?? PERMISSION_OPTIONS },
      })}\n`))
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
    for (const response of responses) {
      if (response.method === 'session/update') expected.push(response.params)
      appendFileSync(stream, `${JSON.stringify(response)}\n`)
    }
  }
  const deps = {
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
    result = runAcpSeat({
      definition, cwd: options.cwd ?? root, taskDir: options.taskDir, prompt: options.prompt ?? 'fixture prompt', sessionFile,
      binaries: options.binaries ?? { claudeAcp: BIN, claude: BIN, pi: BIN }, deps })
  } catch (caught) { error = caught }
  const leftover = [...runtimes(runtimeRoot)].filter((dir) => !before.has(dir)).map((dir) => join(runtimeRoot, dir))
  const rows = options.unwritable ? [] : readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const replies = (options.permissions ?? []).map((_, i) => sent.find((frame) => frame.id === `permit-${i}` && !frame.method)?.result?.outcome ?? null)
  return { root, result, error, rows, expected, sent, replies, launches, plugins, kills, skills, leftover, sessionFile,
    cleanup() { for (const dir of leftover) rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) } }
}

function use(name, options, inspect) {
  const run = replaySeat(name, options)
  try { return inspect(run) } finally { run.cleanup() }
}

const sessionNew = (run) => run.sent.find((frame) => frame.method === 'session/new')

test('every routed update lands once, in order, after the existing sentinel row (known and unknown kinds)', () => {
  for (const name of ['claude-turn', 'claude-turn-rawsdk', 'pi-turn', 'claude-cancel', 'pi-cancel']) {
    use(name, { unknown: true }, (run) => {
      assert.equal(run.error, undefined, name)
      assert.ok(run.expected.length > 0, `${name} recorded updates`)
      assert.ok(run.expected.some((row) => row.update.sessionUpdate === 'future_recorded_update'), `${name} unknown kind`)
      assert.deepEqual(run.rows, [{ prior: true }, ...run.expected])
      assert.equal(run.result.stopReason, name.endsWith('cancel') ? 'cancelled' : 'end_turn')
    })
  }
})

test('the supplied prompt is sent exactly once as one text block, including an empty prompt', () => {
  for (const prompt of ['fixture prompt', '']) {
    use('claude-turn', { prompt }, (run) => {
      const prompts = run.sent.filter((frame) => frame.method === 'session/prompt')
      assert.equal(prompts.length, 1)
      assert.deepEqual(prompts[0].params.prompt, [{ type: 'text', text: prompt }])
    })
  }
})

test('a typed provider refusal is returned unchanged and the stream still records its updates', () => {
  use('claude-refusal-auth', {}, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.result.stopReason, null)
    assert.equal(run.result.refusal.errorKind, 'authentication_failed')
    assert.deepEqual(run.rows, [{ prior: true }, ...run.expected])
  })
})

test('Claude session/new carries the stripped model id and each requested effort', () => {
  for (const effort of ['low', 'medium', 'high']) {
    use('claude-turn', { effort }, (run) => {
      const options = sessionNew(run).params._meta.claudeCode.options
      assert.equal(options.model, 'claude-opus-4-6')
      assert.equal(options.extraArgs.effort, effort)
    })
  }
})

test('granted skills become exactly one plugin with complete support files; no skills means no plugin', () => {
  use('claude-turn', { grant: true }, (run) => {
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
    use('claude-turn', { definition: { skills } }, (run) => {
      assert.equal(run.error, undefined)
      assert.equal(Object.hasOwn(sessionNew(run).params._meta.claudeCode.options, 'plugins'), false)
    })
  }
})

test('a skill identifier resolves to this checkout skills/<name>/SKILL.md, not the seat cwd', () => {
  use('claude-turn', { skills: ['qa-test-writing'] }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(run.plugins[0].names, ['qa-test-writing'])
    assert.equal(run.plugins[0].files[0].skill, readFileSync(join(ROOT, 'skills', 'qa-test-writing', 'SKILL.md'), 'utf8'))
  })
})

test('a cwd-relative skill path is accepted', () => {
  const run = replaySeat('claude-turn', { grant: true })
  try {
    const again = replaySeat('claude-turn', { cwd: run.root, skills: ['alpha/SKILL.md'] })
    try {
      assert.equal(again.error, undefined)
      assert.deepEqual(again.plugins[0].names, ['alpha'])
    } finally { again.cleanup() }
  } finally { run.cleanup() }
})

test('the Pi launch runs this checkout bridge with the full provider/id model and the frozen worker path', () => {
  use('pi-turn', {}, (run) => {
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
test('a pi seat launches with the legacy provider mapping: openai becomes openai-codex, anthropic and meta stay', () => {
  for (const [model, launched] of [['openai/gpt-6.1-sol', 'openai-codex/gpt-6.1-sol'], ['anthropic/claude-opus-4-6', 'anthropic/claude-opus-4-6'], ['meta/llama-5', 'meta/llama-5']]) {
    use('pi-turn', { model }, (run) => {
      assert.equal(run.error, undefined, model)
      assert.equal(run.result.stopReason, 'end_turn', model)
      const shell = run.launches[0][1][1]
      assert.ok(shell.includes(launched), model)
      assert.ok(launched === model || !shell.includes(model), model)
    })
  }
})

// MUTATION: drop the own-property guard and a prototype name or an unmapped provider launches.
test('a pi seat with an unmapped or prototype provider is refused by name before any process or runtime exists', () => {
  for (const provider of ['mistral', 'constructor']) {
    use('pi-turn', { model: `${provider}/some-model` }, (run) => {
      assert.match(run.error?.message ?? '', new RegExp(`no pi provider for roster provider.*${provider}`, 'i'), provider)
      assert.equal(run.launches.length, 0, provider)
      assert.deepEqual(run.leftover, [], provider)
    })
  }
})

test('Pi receives the same explicit skill paths as --skill arguments', () => {
  use('pi-turn', { grant: true }, (run) => {
    assert.equal(run.error, undefined)
    const shell = run.launches[0][1][1]
    for (const path of run.skills) assert.ok(shell.includes(path), path)
  })
})

test('a recording failure never changes the turn result (directory output, EPERM, EIO)', () => {
  for (const name of ['claude-turn', 'pi-turn', 'claude-refusal-auth', 'claude-cancel']) {
    const expected = use(name, {}, (run) => { assert.equal(run.error, undefined); return run.result })
    for (const options of [{ unwritable: true }, { appendError: 'EPERM' }, { appendError: 'EIO' }]) {
      use(name, options, (run) => {
        assert.equal(run.error, undefined, name)
        assert.deepEqual(run.result, expected, name)
      })
    }
  }
})

test('an unsupported agent (unknown, empty, null) is refused by name before any process or runtime exists', () => {
  for (const agent of ['unsupported', '', null, undefined]) {
    use('pi-turn', { definition: { agent } }, (run) => {
      assert.match(run.error?.message ?? '', /unsupported agent/)
      assert.equal(run.launches.length, 0)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('malformed launch inputs are refused, never coerced, before any process starts', () => {
  const bad = [
    { definition: { model: 'no-slash' } }, { definition: { model: 7 } }, { definition: { effort: 'turbo' } },
    { definition: { effort: undefined } }, { definition: { skills: 'alpha' } }, { skills: [''] }, { skills: [7] },
    { skills: ['../escape'] }, { cwd: '' }, { prompt: 7 },
  ]
  for (const options of bad) {
    use('claude-turn', options, (run) => {
      assert.ok(run.error, JSON.stringify(options))
      assert.equal(run.launches.length, 0, JSON.stringify(options))
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('a missing, directory, duplicate or case-colliding skill refuses before any process starts', () => {
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
      use(name, { skills }, (run) => {
        assert.ok(run.error, `${name} ${label}`)
        assert.equal(run.launches.length, 0, `${name} ${label}`)
        assert.deepEqual(run.leftover, [])
      })
    }
  }
})

test('denied skill materialisation refuses, unlike denied recording', () => {
  const deps = { skillDeps: { cpSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } } }
  use('claude-turn', { grant: true, deps }, (run) => {
    assert.equal(run.error?.code, 'EPERM')
    assert.equal(run.launches.length, 0)
    assert.deepEqual(run.leftover, [])
  })
})

test('a binary that cannot be resolved refuses before any process starts', () => {
  const dir = scratchDir('acp-seat-path-')
  for (const [name, binaries] of [['claude-turn', {}], ['pi-turn', {}], ['claude-turn', { claudeAcp: 'relative/acp', claude: BIN }]]) {
    use(name, { binaries, deps: { env: { PATH: `relative:${dir}` } } }, (run) => {
      assert.match(run.error?.message ?? '', /binary/)
      assert.equal(run.launches.length, 0)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('an explicit absolute binary that is missing, a directory or not executable is refused by name before any process starts', () => {
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
    use(name, { binaries }, (run) => {
      assert.match(run.error?.message ?? '', /is not an executable file/, `${name} ${path}`)
      assert.ok(run.error.message.includes(JSON.stringify(path)), `${name} ${path}`)
      assert.equal(run.launches.length, 0, `${name} ${path}`)
      assert.deepEqual(run.leftover, [])
    })
  }
})

test('a PATH binary is found only through an absolute directory', () => {
  const dir = scratchDir('acp-seat-path-')
  writeFileSync(join(dir, 'pi'), '#!/bin/sh\n', { mode: 0o755 })
  use('pi-turn', { binaries: {}, deps: { env: { PATH: `relative:${dir}` } } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.launches[0][2].env.CREW_PI_BIN, join(dir, 'pi'))
  })
})

test('a startup failure is preserved and its private runtime removed', () => {
  use('claude-turn', { spawnThrows: true }, (run) => {
    assert.match(run.error?.message ?? '', /spawn denied/)
    assert.deepEqual(run.leftover, [])
    assert.equal(readFileSync(run.sessionFile, 'utf8'), '{"prior":true}\n')
  })
})

test('a prompt transport failure is preserved and the client is still closed', () => {
  use('claude-turn', { writeError: 'EIO' }, (run) => {
    assert.equal(run.error?.code, 'EIO')
    assert.ok(run.kills.length > 0)
    assert.deepEqual(run.leftover, [])
  })
})

test('the runtime is removed once teardown is proven and retained when it is not', () => {
  use('claude-turn', {}, (run) => assert.deepEqual(run.leftover, []))
  use('claude-turn', { noExit: true }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.leftover.length, 1)
    assert.ok(existsSync(run.leftover[0]))
  })
})

test('the session file and granted skill sources survive the run', () => {
  use('claude-turn', { grant: true }, (run) => {
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
function withPermissionTree(inspect) {
  const root = realpathSync(scratchDir('acp-seat-permission-'))
  const work = join(root, 'work'), task = join(root, 'task'), outside = join(root, 'outside')
  for (const dir of [work, task, outside, `${work}-sibling`]) mkdirSync(dir)
  writeFileSync(join(work, 'existing'), 'before')
  writeFileSync(join(task, 'existing'), 'before')
  symlinkSync(outside, join(work, 'escape'))
  symlinkSync(outside, join(task, 'escape'))
  symlinkSync(join(outside, 'absent'), join(task, 'dangling'))
  try { return inspect({ root, work, task, outside }) } finally { rmSync(root, { recursive: true, force: true }) }
}

// Replays the permission requests through the real seat and returns one verdict per request.
function decide(tree, writes, requests, { name = 'pi-turn', ...options } = {}) {
  const run = replaySeat(name, { cwd: tree.work, taskDir: tree.task, permissions: requests, ...options, definition: { role: 'planner', writes, ...options.definition } })
  try {
    assert.equal(run.error, undefined)
    return { verdicts: run.replies.map(verdict), rows: run.rows.filter((row) => row.kind === 'permission'), run: { sent: run.sent, rows: run.rows, expected: run.expected, plugins: run.plugins, launches: run.launches } }
  } finally { run.cleanup() }
}

test('task-dir seats write the lane task directory, new and nested files included, never the worktree (Pi path and Claude file_path)', () => {
  withPermissionTree((tree) => {
    for (const [name, key] of [['pi-turn', 'path'], ['claude-turn', 'file_path']]) {
      const allowed = [edit(join(tree.task, 'existing'), key), edit(join(tree.task, 'new', 'deep', 'gate.mjs'), key), edit(relative(tree.work, join(tree.task, 'plan.md')), key)]
      assert.deepEqual(decide(tree, 'task-dir', allowed, { name }).verdicts, ['allow', 'allow', 'allow'], name)
      const denied = [edit(join(tree.work, 'existing'), key), edit('fresh.mjs', key)]
      assert.deepEqual(decide(tree, 'task-dir', denied, { name }).verdicts, ['reject', 'reject'], name)
    }
  })
})

test('repo seats write the worktree and the lane task directory, nothing else', () => {
  withPermissionTree((tree) => {
    const { verdicts } = decide(tree, 'repo', [
      edit('existing'), edit(join(tree.work, 'new', 'code.mjs')), edit(join(tree.task, 'return.json')),
      edit(join(tree.outside, 'new')), edit(join(`${tree.work}-sibling`, 'new')), edit('../outside/new'),
      edit(join(tree.work, 'escape', 'new')), edit(join(tree.task, 'escape', 'new')), edit(join(tree.task, 'dangling')),
      edit(`${tree.task}/escape/../new`), edit(join(tree.work, 'existing', 'child')),
    ])
    assert.deepEqual(verdicts, ['allow', 'allow', 'allow', ...Array(8).fill('reject')])
  })
})

test('a task-dir or repo seat never edits, writes or deletes a lean session record, and the rest of the task directory stays writable', () => {
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
              const { verdicts } = decide({ work, task: taskDir }, writes, [...denied, ...allowed].map(request), { name })
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

test('writes none rejects every file mutation in every root', () => {
  withPermissionTree((tree) => {
    const { verdicts } = decide(tree, 'none', [edit(join(tree.task, 'existing')), edit('existing'), edit(join(tree.outside, 'new'))])
    assert.deepEqual(verdicts, ['reject', 'reject', 'reject'])
  })
})

test('missing, unknown or role-implied writes grant nothing', () => {
  withPermissionTree((tree) => {
    for (const writes of [undefined, null, 'admin', '']) {
      const { verdicts, rows } = decide(tree, writes, [edit('existing'), edit(join(tree.task, 'existing'))], { definition: { role: 'builder', writes } })
      assert.deepEqual(verdicts, ['reject', 'reject'], String(writes))
      assert.deepEqual(rows.map((row) => row.writes), ['none', 'none'])
    }
  })
})

test('shell: repo seats run commands, others only the read-only allowlist', () => {
  withPermissionTree((tree) => {
    const commands = ['touch nope', 'cat existing > nope', 'git status', 'cat existing']
    for (const writes of ['task-dir', 'none']) {
      assert.deepEqual(decide(tree, writes, commands.map(shell)).verdicts, ['reject', 'reject', 'allow', 'allow'], writes)
    }
    assert.deepEqual(decide(tree, 'repo', commands.map(shell)).verdicts, ['allow', 'allow', 'allow', 'allow'])
    const malformed = [{ kind: 'execute', title: 'bash', rawInput: {} }, { kind: 'execute', title: 'bash', rawInput: { command: '' } },
      { kind: 'execute', title: 'bash', rawInput: { command: 7 } }, { kind: 'execute', title: 'bash', rawInput: null }, { kind: 'execute', title: 'bash' }]
    assert.deepEqual(decide(tree, 'repo', malformed).verdicts, Array(5).fill('reject'))
  })
})

test('anything the rules do not name is rejected even for a repo seat', () => {
  withPermissionTree((tree) => {
    const target = join(tree.work, 'existing')
    const { verdicts } = decide(tree, 'repo', [
      { kind: 'other', title: 'write', rawInput: { path: target } }, { kind: 'fetch', title: 'fetch', rawInput: { path: target } },
      { kind: 'read', title: 'read', rawInput: { path: target } }, { kind: 'move', title: 'move', rawInput: { path: target } },
      { kind: 'edit', title: 'write', rawInput: { from: target, to: target } },
      { kind: 'edit', title: 'write', rawInput: {} }, { kind: 'edit', title: 'write' }, { kind: 'edit', title: target },
      { kind: 'edit', title: 'write', rawInput: { path: target, file_path: join(tree.outside, 'x') } },
      { kind: 'edit', title: 'write', rawInput: { path: '' } }, { kind: 'edit', title: 'write', rawInput: { path: 7 } },
      { kind: 'edit', title: 'write', rawInput: { path: `${target}\0x` } }, { title: 'write', rawInput: { path: target } }, null,
    ])
    assert.deepEqual(verdicts, Array(14).fill('reject'))
    assert.deepEqual(decide(tree, 'repo', [{ kind: 'edit', title: 'write', rawInput: { path: target, file_path: target } }]).verdicts, ['allow'])
  })
})

test('an unreadable path component rejects that request only (EPERM, EIO, EINTR), the next request is still decided', () => {
  withPermissionTree((tree) => {
    for (const code of ['EPERM', 'EIO', 'EINTR']) {
      const broken = join(tree.work, 'existing')
      const realpathSync = (path, ...rest) => {
        if (path === broken) throw Object.assign(new Error(code), { code })
        return realpathSync_(path, ...rest)
      }
      const { verdicts } = decide(tree, 'repo', [edit(broken), edit(join(tree.work, 'fresh')), edit(broken)], { deps: { realpathSync } })
      assert.deepEqual(verdicts, ['reject', 'allow', 'reject'], code)
    }
  })
})
const realpathSync_ = realpathSync

test('each decision is one session row, in request order, correlated to the reply and before the updates', () => {
  withPermissionTree((tree) => {
    const requests = [edit(join(tree.task, 'existing')), edit('existing'), shell('git status'),
      { toolCallId: 'unsupported', kind: 'other', title: 'unknown', rawInput: {} },
      { ...edit('existing'), toolCallId: 'always', _options: [{ optionId: 'forever', kind: 'allow_always', name: 'Always' }] },
      { ...edit('existing'), toolCallId: 'reject-always', _options: [{ optionId: 'never', kind: 'reject_always', name: 'Never' }, { optionId: 'forever', kind: 'allow_always', name: 'Always' }] },
      { ...edit(join(tree.task, 'existing')), toolCallId: 'only-always-allowed', _options: [{ optionId: 'no', kind: 'reject_once', name: 'No' }, { optionId: 'forever', kind: 'allow_always', name: 'Always' }] }]
    const { rows, verdicts, run } = decide(tree, 'task-dir', requests)
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

test('a failed permission-row append never changes a decision', () => {
  withPermissionTree((tree) => {
    const appendFileSync = (path, text, ...rest) => { if (text.includes('"kind":"permission"')) throw Object.assign(new Error('denied'), { code: 'EIO' }); return appendFileSync_(path, text, ...rest) }
    const { verdicts } = decide(tree, 'task-dir', [edit(join(tree.task, 'existing')), edit('existing')], { deps: { appendFileSync } })
    assert.deepEqual(verdicts, ['allow', 'reject'])
  })
})
const appendFileSync_ = appendFileSync

test('the actual role reaches the launch and the lane task directory is writable only when writes allow it', () => {
  withPermissionTree((tree) => {
    const dirsOf = (writes, taskDir) => {
      const run = replaySeat('claude-turn', { cwd: tree.work, taskDir, definition: { role: 'planner', writes } })
      try { return sessionNew(run).params._meta.claudeCode.options.additionalDirectories } finally { run.cleanup() }
    }
    assert.deepEqual(dirsOf('task-dir', tree.task), [tree.task])
    assert.deepEqual(dirsOf('repo', tree.task), [tree.task])
    assert.deepEqual(dirsOf('none', tree.task), [])
    assert.deepEqual(dirsOf('task-dir', undefined), [])
    const run = replaySeat('claude-turn', { grant: true, cwd: tree.work, definition: { role: 'planner', writes: 'none' } })
    try { assert.match(sessionNew(run).params._meta.claudeCode.options.plugins[0].path, /claude-skills[\\/]planner$/) } finally { run.cleanup() }
    const unnamed = replaySeat('claude-turn', { grant: true, cwd: tree.work })
    try { assert.match(sessionNew(unnamed).params._meta.claudeCode.options.plugins[0].path, /claude-skills[\\/]seat$/) } finally { unnamed.cleanup() }
    const pi = replaySeat('pi-turn', { cwd: tree.work, definition: { role: 'builder', writes: 'repo' } })
    try { assert.equal(pi.error, undefined); assert.equal(pi.launches.length, 1) } finally { pi.cleanup() }
  })
})

test('an unknown role is refused before any process or runtime exists', () => {
  for (const role of ['seat', '', null, 'admin']) {
    use('pi-turn', { definition: { role } }, (run) => {
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

test('a Claude seat without tools launches the writes-based defaults, none being read and search only', () => {
  for (const [writes, expected] of Object.entries(TOOL_DEFAULTS)) {
    use('claude-turn', { definition: { writes } }, (run) => {
      assert.equal(run.error, undefined, writes)
      const launched = launchTools(run)
      assert.deepEqual(launched.allowedTools, writes === 'repo' ? expected : approved(expected), writes)
      assert.deepEqual(launched.tools, expected, writes)
    })
  }
  use('claude-turn', {}, (run) => assert.deepEqual(launchTools(run).allowedTools, TOOL_DEFAULTS.none))
})

const setModes = (run) => run.sent.filter((frame) => frame.method === 'session/set_mode').map((frame) => frame.params.modeId)

test('a Claude seat asks for every edit unless its definition writes repo, whatever its role or tools', () => {
  const explicit = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'NotebookEdit']
  for (const role of ['reviewer', 'lead', 'tech-lead', 'builder']) {
    for (const tools of [undefined, explicit]) {
      for (const [writes, mode] of [['task-dir', 'default'], ['none', 'default'], [undefined, 'default'], ['bogus', 'default'], ['repo', 'acceptEdits']]) {
        const definition = { role, writes, ...(tools ? { tools } : {}) }
        use('claude-turn', { definition }, (run) => {
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

test('a refused set_mode starts no prompt and still tears the client down', () => {
  const events = []
  const root = scratchDir('acp-seat-mode-refusal-')
  try {
    assert.throws(() => runAcpSeat({
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

test('task-dir seats deny Edit and NotebookEdit even when the explicit tools list Edit', () => {
  for (const definition of [{ writes: 'task-dir' }, { writes: 'task-dir', tools: ['Read', 'Edit'] }]) {
    use('claude-turn', { definition }, (run) => {
      const { disallowedTools } = launchTools(run)
      assert.ok(disallowedTools.includes('Edit'), JSON.stringify(definition))
      assert.ok(disallowedTools.includes('NotebookEdit'), JSON.stringify(definition))
    })
  }
})

test('explicit tools replace the defaults for every writes class', () => {
  for (const writes of Object.keys(TOOL_DEFAULTS)) {
    use('claude-turn', { definition: { writes, tools: ['Read', 'Grep'] } }, (run) => {
      const launched = launchTools(run)
      assert.deepEqual(launched.allowedTools, ['Read', 'Grep'], writes)
      assert.deepEqual(launched.tools, ['Read', 'Grep'], writes)
    })
  }
})

test('a Claude seat reads no setting source, so a permissive target checkout cannot widen it, but keeps usage settings and granted plugin', () => {
  const work = scratchDir('acp-seat-project-settings-')
  try {
    mkdirSync(join(work, '.claude'), { recursive: true })
    for (const name of ['settings.json', 'settings.local.json']) {
      writeFileSync(join(work, '.claude', name), JSON.stringify({ permissions: { allow: ['Bash(*)', 'Write', 'Edit'] } }))
    }
    for (const writes of ['none', 'task-dir', 'repo', undefined, 'bogus']) {
      for (const grant of [false, true]) {
        const label = `writes=${writes} grant=${grant}`
        use('claude-turn', { cwd: work, taskDir: work, grant, definition: { writes } }, (run) => {
          assert.equal(run.error, undefined, label)
          const options = sessionNew(run).params._meta.claudeCode.options
          assert.deepEqual(options.settingSources, [], label)
          assert.equal(options.settings, PANE_USAGE_SETTINGS, label)
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

test('an empty Claude tool list is refused as ACP_EMPTY_TOOLS before any process or runtime exists', () => {
  for (const writes of Object.keys(TOOL_DEFAULTS)) {
    use('claude-turn', { definition: { writes, tools: [] } }, (run) => {
      assert.equal(run.error?.code, 'ACP_EMPTY_TOOLS', writes)
      assert.equal(run.launches.length, 0, writes)
      assert.deepEqual(run.leftover, [], writes)
    })
  }
})

test('malformed Claude tools are refused before any process or runtime exists', () => {
  for (const tools of [null, '', 'Read', 7, {}, [null], [7], [''], [' ']]) {
    use('claude-turn', { definition: { writes: 'repo', tools } }, (run) => {
      assert.match(run.error?.message ?? '', /tools must be a list/, JSON.stringify(tools))
      assert.equal(run.launches.length, 0, JSON.stringify(tools))
      assert.deepEqual(run.leftover, [], JSON.stringify(tools))
    })
  }
})

test('Pi brings its own tools: an explicit empty list still launches', () => {
  use('pi-turn', { definition: { writes: 'repo', tools: [] } }, (run) => {
    assert.equal(run.error, undefined)
    assert.equal(run.launches.length, 1)
  })
})

// A fake client under an injected clock: the deadline loop, cancellation and teardown are observable without a transport.
function deadlineSeat({ agent = 'pi', wait_s, answerAt = null, answer = { stopReason: 'end_turn', usage: null, refusal: null }, pollAdvance = 0, cancelError = null, closeError = null, closeOutcome = 'proven', pollError = null, exitAt = null, settleOnExit = false, exitPollAdvance = 0, exitPollError = null, onStart = () => {} } = {}) {
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
    result = runAcpSeat({
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

function deadline(options, inspect) {
  const run = deadlineSeat(options)
  try { return inspect(run) } finally { run.cleanup() }
}

test('an explicit wait_s answers a turn just before its deadline and cancels a pending one at it, for pi and claude', () => {
  for (const agent of ['pi', 'claude']) {
    deadline({ agent, wait_s: 3, answerAt: 2975 }, (run) => {
      assert.equal(run.error, undefined, agent)
      assert.deepEqual(run.result, { stopReason: 'end_turn', usage: null, refusal: null }, agent)
      assert.deepEqual(run.at('cancel'), [], agent)
    })
    deadline({ agent, wait_s: 3 }, (run) => {
      assert.equal(run.error.reason, 'acp-seat-deadline', agent)
      assert.match(run.error.message, /planner.*3s/, agent)
      assert.equal(run.result, undefined, agent)
      assert.deepEqual(run.at('cancel'), [['cancel', 41, 3000]], agent)
      assert.equal(run.at('begin').length, 1, agent)
    })
  }
})

test('an omitted wait_s expires at 2,400,000ms and malformed supplied values refuse before any runtime exists', () => {
  deadline({}, (run) => {
    assert.equal(run.error.reason, 'acp-seat-deadline')
    assert.deepEqual(run.at('cancel'), [['cancel', 41, 2400000]])
  })
  for (const wait_s of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', NaN, Infinity]) {
    deadline({ wait_s }, (run) => {
      assert.match(run.error.message, /wait_s must be a positive safe integer/, String(wait_s))
      assert.deepEqual(run.events, [], String(wait_s))
      assert.deepEqual(run.leftover, [], String(wait_s))
    })
  }
  deadline({ wait_s: Number.MAX_SAFE_INTEGER, answerAt: 25 }, (run) => assert.equal(run.error, undefined))
})

test('a seat that exits before answering fails its turn at once, not at its deadline, for pi and claude', () => {
  for (const agent of ['pi', 'claude']) {
    deadline({ agent, wait_s: 60, exitAt: 100 }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-closed', agent)
      assert.match(run.error.message, /planner exited before answering/, agent)
      assert.equal(run.result, undefined, agent)
      assert.ok(run.clock() >= 100 && run.clock() < 1000, `${agent} noticed at ${run.clock()}`)
      assert.deepEqual(run.at('cancel'), [], agent)
      assert.equal(run.at('close').length, 1, agent)
    })
  }
})

test('an answer that settled with the exit is returned, and a late exit does not outrank the deadline', () => {
  deadline({ wait_s: 60, answerAt: 100, exitAt: 100 }, (run) => {
    assert.equal(run.error, undefined)
    assert.deepEqual(run.result, { stopReason: 'end_turn', usage: null, refusal: null })
  })
  deadline({ wait_s: 1, exitAt: 5000 }, (run) => assert.equal(run.error?.reason, 'acp-seat-deadline'))
})

test('an answer that settles between an empty poll and the exit marker is returned, not dropped as a closed seat', () => {
  for (const agent of ['pi', 'claude']) {
    for (const answer of [
      { stopReason: 'end_turn', usage: null, refusal: null },
      { stopReason: 'cancelled', usage: null, refusal: null },
      { stopReason: null, usage: null, refusal: { code: 1, message: 'refused', errorKind: null } },
    ]) {
      deadline({ agent, wait_s: 60, settleOnExit: true, answer }, (run) => {
        assert.equal(run.error, undefined, agent)
        assert.equal(run.result, answer, agent)
        assert.deepEqual(run.at('poll').map((event) => event[1]), [41, 41], agent)
        assert.deepEqual(run.at('cancel'), [], agent)
        assert.deepEqual(run.at('cancel-session'), [], agent)
        assert.equal(run.at('close').length, 1, agent)
      })
    }
    deadline({ agent, wait_s: 1, settleOnExit: true, exitPollAdvance: 5000 }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-deadline', agent)
      assert.equal(run.result, undefined, agent)
    })
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' })
    deadline({ agent, wait_s: 60, exitAt: 0, pollError: eio }, (run) => assert.equal(run.error, eio, agent))
    deadline({ agent, wait_s: 60, settleOnExit: true, exitPollError: eio }, (run) => {
      assert.equal(run.error, eio, agent)
      assert.equal(run.at('poll').length, 2, agent)
    })
  }
})

test('an answer at or after the deadline, even one that arrives inside the poll, is never returned', () => {
  for (const [answerAt, pollAdvance] of [[2000, 2000], [2000, 0], [5000, 0]]) {
    deadline({ wait_s: 2, answerAt, pollAdvance }, (run) => {
      assert.equal(run.error?.reason, 'acp-seat-deadline', `${answerAt}/${pollAdvance}`)
      assert.equal(run.result, undefined)
      assert.equal(run.at('cancel').length, 1)
      assert.equal(run.at('cancel')[0][1], 41)
      assert.equal(run.at('cancel-session').length, pollAdvance > 0 ? 1 : 0, 'a settled late turn falls back to the session cancel')
    })
  }
})

test('cancellation is attempted once before close and a cancel failure or throwing close cannot mask the deadline', () => {
  const unknown = new Error('who knows')
  for (const cancelError of [null, ...['EIO', 'EPERM', 'EINTR'].map((code) => Object.assign(new Error(code), { code })), unknown]) {
    for (const closeError of [null, new Error('close broke')]) {
      deadline({ wait_s: 1, cancelError, closeError }, (run) => {
        assert.equal(run.error.reason, 'acp-seat-deadline')
        assert.deepEqual(run.events.map((event) => event[0]).filter((kind) => kind === 'cancel' || kind === 'close'), ['cancel', 'close'])
      })
    }
  }
})

test('a proven close removes the runtime and an unproven or unknown close retains it', () => {
  deadline({ wait_s: 1, closeOutcome: 'proven' }, (run) => assert.deepEqual(run.leftover.filter((dir) => existsSync(dir)), []))
  for (const closeOutcome of ['unproven', 'unknown']) {
    deadline({ wait_s: 1, closeOutcome }, (run) => {
      assert.equal(run.leftover.length, 1, closeOutcome)
      assert.equal(existsSync(run.leftover[0]), true, closeOutcome)
    })
  }
  deadline({ wait_s: 1, closeError: new Error('close broke') }, (run) => {
    assert.equal(run.leftover.length, 1)
    assert.equal(existsSync(run.leftover[0]), true)
  })
})

test('a turn answered at 700,000ms returns the exact normalized object under an explicit 900s and the default deadline, uncancelled', () => {
  const refused = { stopReason: null, usage: null, refusal: { code: 1, message: 'no', errorKind: null } }
  for (const wait_s of [900, undefined]) {
    for (const answer of [{ stopReason: 'end_turn', usage: { input: 3 }, refusal: null }, refused, { stopReason: 'cancelled', usage: null, refusal: null }]) {
      deadline({ wait_s, answerAt: 700000, answer }, (run) => {
        assert.equal(run.error, undefined)
        assert.equal(run.result, answer)
        assert.deepEqual(run.at('cancel'), [])
        assert.equal(run.at('close').length, 1)
      })
    }
  }
})

test('a prompt poll failure propagates unchanged through teardown without a cancel', () => {
  const eio = Object.assign(new Error('pipe'), { code: 'EIO' })
  deadline({ wait_s: 5, pollError: eio }, (run) => {
    assert.equal(run.error, eio)
    assert.deepEqual(run.at('cancel'), [])
    assert.equal(run.at('close').length, 1)
  })
})

// A fake client that records where the runner placed its runtime; no transport exists.
function placementSeat(root, deps, closeOutcome = 'proven') {
  const seen = {}
  const answer = { stopReason: 'end_turn', usage: null, refusal: null }
  runAcpSeat({
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

test('the runtime is created under the injected root and torn down only when proven', () => {
  const root = scratchDir('acp-seat-root-')
  try {
    const runtimeRoot = join(root, 'runtimes')
    mkdirSync(runtimeRoot)
    const proven = placementSeat(root, { seat: { runtimeRoot } })
    assert.equal(realpathSync(dirname(proven.runtime)), realpathSync(runtimeRoot))
    assert.match(basename(proven.runtime), /^acp-seat-[A-Za-z0-9]{6}$/)
    assert.equal(existsSync(proven.runtime), false)
    const unproven = placementSeat(root, { seat: { runtimeRoot } }, 'unproven')
    assert.equal(realpathSync(dirname(unproven.runtime)), realpathSync(runtimeRoot))
    assert.equal(existsSync(unproven.runtime), true)
    assert.equal(existsSync(runtimeRoot), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a seat runtime another process creates in the system temp directory survives a turn and its cleanup', () => {
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
    const turn = deadlineSeat({ wait_s: 1, onStart: () => { assert.equal(run('create').status, 0); created = true } })
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
    model: agent === 'pi' ? 'openai/gpt-6.1-sol' : 'anthropic/claude-opus-4-6', ...arms,
  }
  const run = () => runAcpSeat({
    definition, cwd, taskDir, prompt: 'p', sessionFile: join(taskDir, 'session.jsonl'),
    binaries: { pi: BIN, claude: BIN, claudeAcp: BIN },
    deps: {
      runtimeRoot, env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: baseAgentDir, ...env }, ...options.deps,
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
const armed = (...args) => { const probe = armLaunch(...args); probe.run(); return { ...probe, launch: probe.created[0] } }
const claudeOptions = (launch) => launch.sessionParams._meta.claudeCode.options
const piExtensions = (launch) => launch.args.flatMap((arg, index, args) => arg === '-e' ? [args[index + 1]] : [])
const piTools = (launch) => launch.args[launch.args.indexOf('--tools') + 1].split(',')
const FFF_TOOLS = ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']

test('a claude seat that declares fff launches with the fff server, its tools and CREW_FFF; one that does not has none', () => {
  const { launch } = armed('claude', 'planner', { extensions: ['fff'] })
  const options = claudeOptions(launch)
  assert.deepEqual(options.mcpServers, { fff: { command: '/opt/homebrew/bin/fff-mcp', args: [] } })
  for (const tool of FFF_TOOLS) { assert.ok(options.allowedTools.includes(tool)); assert.ok(options.tools.includes(tool)) }
  assert.equal(launch.env.CREW_FFF, '1')
  for (const tool of ['Glob', 'Grep']) assert.ok(options.disallowedTools.includes(tool), `fff denies native ${tool}`)
  const bare = armed('claude', 'planner', {})
  assert.equal(claudeOptions(bare.launch).mcpServers, undefined)
  for (const tool of ['Glob', 'Grep']) assert.ok(!claudeOptions(bare.launch).disallowedTools.includes(tool))
  assert.equal(bare.launch.env.CREW_FFF, '0')
})

test('a claude seat that declares lab launches with the lab server and its tool allowed', () => {
  const options = claudeOptions(armed('claude', 'planner', { extensions: ['lab'] }).launch)
  assert.equal(options.mcpServers.lab.command, BIN)
  assert.deepEqual(options.mcpServers.lab.args, [join(ROOT, 'crew', 'mcp', 'lab-server.mjs')])
  assert.ok(options.allowedTools.includes('mcp__lab__lab'))
})

test('a claude seat never drops an arm it cannot express: every pi-only extension, advisor, edit assist and codemode refuse before a client', () => {
  const requests = [
    ...['readgate', 'builderloop', 'reminders', 'skeletonread', 'subagent'].map((name) => ({ extensions: [name] })),
    { advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' } }, { edit_assist: true }, { codemode: true },
  ]
  for (const arms of requests) {
    const probe = armLaunch('claude', 'builder', arms)
    assert.throws(() => probe.run(), { reason: 'grant-unsupported' }, JSON.stringify(arms))
    assert.equal(probe.created.length, 0, JSON.stringify(arms))
    assert.deepEqual(readdirSync(probe.runtimeRoot), [], 'a refused seat leaves no runtime')
  }
  // Only a requested arm refuses: false is the absence of the arm.
  assert.equal(armed('claude', 'builder', { edit_assist: false, codemode: false, advisor: null, extensions: [] }).created.length, 1)
})

test('a lean pi seat refuses the arms that read the old task layout: advisor, edit assist, builderloop and skeletonread', () => {
  const requests = [
    { advisor: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' } }, { edit_assist: true },
    { extensions: ['builderloop'] }, { extensions: ['skeletonread'] },
  ]
  for (const arms of requests) {
    const probe = armLaunch('pi', 'builder', arms)
    assert.throws(() => probe.run(), { reason: 'grant-unsupported' }, JSON.stringify(arms))
    assert.equal(probe.created.length, 0, JSON.stringify(arms))
  }
  const none = armed('pi', 'builder', { advisor: null, edit_assist: false }).launch
  assert.equal(none.env.CREW_ADVISOR, undefined)
  assert.deepEqual(piExtensions(none), [])
})

test('a pi builder with edit assist off carries off; an unset field carries none', () => {
  assert.equal(armed('pi', 'builder', { edit_assist: false }).launch.env.CREW_EDIT_ASSIST, 'off')
  assert.equal(armed('pi', 'builder', {}).launch.env.CREW_EDIT_ASSIST, undefined)
})

test('every native extension reaches a pi launch as its checkout extension with its tool; none declared loads none', () => {
  const tools = { readgate: null, reminders: null }
  for (const [name, tool] of Object.entries(tools)) {
    const { launch } = armed('pi', 'builder', { extensions: [name] })
    assert.deepEqual(piExtensions(launch), [join(ROOT, 'crew', 'pi', 'extensions', `${name}.ts`)])
    if (tool) assert.ok(piTools(launch).includes(tool))
  }
  assert.deepEqual(piExtensions(armed('pi', 'builder', {}).launch), [])
  assert.equal(armed('pi', 'builder', {}).launch.env.PI_CODING_AGENT_DIR, undefined)
})

test('a pi seat that declares subagent carries the registered agents the extension needs', () => {
  const { launch } = armed('pi', 'planner', { extensions: ['subagent'] })
  assert.deepEqual(piExtensions(launch), [join(ROOT, 'crew', 'pi', 'extensions', 'subagent.ts')])
  assert.ok(piTools(launch).includes('agent'))
  assert.deepEqual(JSON.parse(launch.env.CREW_PI_AGENTS).map((agent) => agent.name), ['scout'])
  const builder = armed('pi', 'builder', { extensions: ['subagent'] }).launch
  assert.deepEqual(JSON.parse(builder.env.CREW_PI_AGENTS).map((agent) => agent.name), ['scout'])
})

test('a pi seat that declares fff excludes native find and grep; one that does not keeps them', () => {
  const excluded = (launch) => { const i = launch.args.indexOf('--exclude-tools'); return i < 0 ? [] : launch.args[i + 1].split(',') }
  const { launch } = armed('pi', 'builder', { extensions: ['fff'] })
  for (const tool of ['find', 'grep']) assert.ok(excluded(launch).includes(tool), `fff excludes native ${tool}`)
  assert.deepEqual(excluded(armed('pi', 'builder', {}).launch).filter((tool) => ['find', 'grep'].includes(tool)), [])
})

test('a pi seat that declares fff and lab gets builtin MCP, its tools and a runtime agent dir carrying the servers', () => {
  const probe = armed('pi', 'planner', { extensions: ['fff', 'lab'] })
  const { launch } = probe
  assert.equal(launch.env.CREW_FFF, '1')
  for (const tool of [...FFF_TOOLS, 'mcp__lab__lab']) assert.ok(piTools(launch).includes(tool), tool)
  const agentDir = launch.env.PI_CODING_AGENT_DIR
  assert.ok(agentDir.startsWith(probe.runtimeRoot), 'the agent dir is runtime, never the lane task dir')
  assert.equal(agentDir, join(readdirSync(probe.runtimeRoot).map((name) => join(probe.runtimeRoot, name))[0], 'pi-agent', 'planner'))
  const mcp = JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers
  assert.deepEqual(mcp.fff, { command: '/opt/homebrew/bin/fff-mcp', args: [], exposure: 'direct' })
  assert.equal(mcp.lab.timeout, 960)
  assert.equal(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).codemode.mode, 'off')
  assert.equal(readFileSync(join(agentDir, 'auth.json'), 'utf8'), '{}')
})

test('a pi seat that declares codemode runs it in only mode through its own settings; false leaves the operator settings', () => {
  const on = armed('pi', 'planner', { codemode: true }).launch
  assert.ok(piTools(on).includes('codemode'))
  const settings = JSON.parse(readFileSync(join(on.env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'))
  assert.deepEqual(settings, { theme: 'dark', codemode: { mode: 'only', keep: 1 } })
  const off = armed('pi', 'planner', { codemode: false }).launch
  assert.ok(!piTools(off).includes('codemode'))
  assert.equal(off.env.PI_CODING_AGENT_DIR, undefined)
})

test('a pi seat refuses an MCP grant that a project MCP config would override', () => {
  const probe = armLaunch('pi', 'planner', { extensions: ['fff'] })
  mkdirSync(join(probe.cwd, '.pi'), { recursive: true })
  writeFileSync(join(probe.cwd, '.pi', 'mcp.json'), '{}')
  assert.throws(() => probe.run(), { reason: 'grant-unsupported' })
  assert.equal(probe.created.length, 0)
})

test('a declared asset that is missing refuses the seat, and an unknown extension is not guessed', () => {
  const missing = armLaunch('claude', 'planner', { extensions: ['fff'] }, { deps: { exists: () => false } })
  assert.throws(() => missing.run(), { reason: 'extension-missing' })
  const lab = armLaunch('pi', 'planner', { extensions: ['lab'] }, { deps: { exists: (path) => !path.endsWith('lab-server.mjs') } })
  assert.throws(() => lab.run(), { reason: 'extension-missing' })
  const ext = armLaunch('pi', 'planner', { extensions: ['reminders'] }, { deps: { exists: (path) => !path.endsWith('reminders.ts') } })
  assert.throws(() => ext.run(), { reason: 'extension-missing' })
  const unknown = armLaunch('pi', 'planner', { extensions: ['../escape'] })
  assert.throws(() => unknown.run(), { reason: 'unknown-grant' })
  for (const probe of [missing, lab, ext, unknown]) assert.equal(probe.created.length, 0)
})

test('both ACP launches carry the seat role and the lane task dir, not the runtime or cwd, over ambient values', () => {
  for (const agent of ['pi', 'claude']) {
    for (const role of ['planner', 'builder']) {
      const probe = armed(agent, role, {}, { env: { CREW_ROLE: 'poison', CREW_TASK_DIR: '/poison' } })
      assert.equal(probe.launch.env.CREW_ROLE, role)
      assert.equal(probe.launch.env.CREW_TASK_DIR, resolve(probe.taskDir))
      assert.notEqual(probe.launch.env.CREW_TASK_DIR, probe.cwd)
    }
  }
})

test('a claude seat with no MCP grants is still strict about MCP config', () => {
  const options = claudeOptions(armed('claude', 'planner', {}).launch)
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.mcpServers, undefined)
})
