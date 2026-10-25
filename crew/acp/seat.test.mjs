import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ROOT, scratchDir } from '../../test/helpers.mjs'
import { runAcpSeat } from './seat.mjs'

const FIXTURES = join(ROOT, 'test', 'fixtures', 'acp')
const BIN = process.execPath
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
const normal = fixture('claude-turn')
const runtimes = () => new Set(readdirSync(tmpdir()).filter((name) => /^acp-seat-[A-Za-z0-9]{6}$/.test(name)))

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
  const records = fixture(name)
  const sent = []
  const launches = []
  const expected = []
  const plugins = []
  const kills = []
  let stream = null
  let clock = 1000
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
        if (String(path).endsWith('/seat')) {
          stream = join(path, 'stream.jsonl')
          writeFileSync(stream, '')
        }
      },
      kill: (...args) => {
        kills.push(args)
        if (stream && !options.noExit) writeFileSync(join(dirname(stream), 'exit'), '0')
      },
      spawnSync: () => ({ status: 1, stdout: '' }),
      now: () => { clock += 1000; return clock },
      sleep: () => {},
      seatCommandRoot: join(root, 'seat-runtime'),
    },
    ...options.deps,
  }
  if (options.appendError) deps.appendFileSync = () => { throw Object.assign(new Error('denied'), { code: options.appendError }) }
  const before = runtimes()
  let result
  let error
  try {
    result = runAcpSeat({
      definition, cwd: options.cwd ?? root, prompt: options.prompt ?? 'fixture prompt', sessionFile,
      binaries: options.binaries ?? { claudeAcp: BIN, claude: BIN, pi: BIN }, deps })
  } catch (caught) { error = caught }
  const leftover = [...runtimes()].filter((dir) => !before.has(dir)).map((dir) => join(tmpdir(), dir))
  const rows = options.unwritable ? [] : readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { root, result, error, rows, expected, sent, launches, plugins, kills, skills, leftover, sessionFile,
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
    assert.ok(shell.includes('--model') && shell.includes('openai/gpt-6.1-sol'))
    assert.ok(shell.includes('--thinking') && shell.includes('high'))
    assert.equal(spawnOptions.env.CREW_PI_BIN, BIN)
  })
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
