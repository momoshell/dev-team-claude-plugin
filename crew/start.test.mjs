import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import childProcess, { spawn, spawnSync } from 'node:child_process'
import fs, { appendFileSync as appendFileSyncReal, cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { projectHash } from './onboard.mjs'
import { holdIdleSleep } from './host-sleep.mjs'
import { main as leanMain, runLean } from './lean.mjs'
import { runAcpSeat } from './acp/seat.mjs'
import { readOnlyCommand } from './acp-permission.mjs'
import { parseAgent, TIERS, validateEnvelope } from './protocols.mjs'
import { resolveAgents, snapshotRoster } from './agents.mjs'
import { PROVIDER_RETRY_TOTAL_WAIT_MS } from './acp/provider.mjs'
import { git, scratchDir } from '../test/helpers.mjs'

test('start freezes effective wait_s for later lean turns and finish passes', async () => {
  const dir = scratchDir('wait-snapshot-')
  try {
    cpSync(AGENTS, dir, { recursive: true })
    const planner = join(dir, 'planner.md')
    writeFileSync(planner, readFileSync(planner, 'utf8').replace('writes: task-dir', 'writes: task-dir\nwait_s: 7').replace(/tiers: .*/, 'tiers: {"build":{"wait_s":3}}'))
    const defaults = fakes()
    defaults.deps.snapshotRoster = (overlay) => snapshotRoster(overlay, dir)
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: defaults.deps })
    const savedDefaults = JSON.parse(written(defaults.calls, '/task/lean.json')[2]).roster.snapshot
    assert.equal(savedDefaults.planner.wait_s, 7)
    assert.equal(savedDefaults.planner.tiers.build.wait_s, 3)
    assert.equal(savedDefaults.reviewer.wait_s, 2400)
    const overrides = {
      '/home/.crew/agents.json': JSON.stringify({ builder: { wait_s: 11, tiers: { judge: { wait_s: 19 } } }, lead: { wait_s: 23 } }),
      '/repo/checkout/.crew/agents.json': JSON.stringify({ lead: { wait_s: 29 } }),
    }
    const lane = fakes({ overrides, resolve: (tier, _, overlay) => resolveAgents(tier, dir, overlay) })
    lane.deps.snapshotRoster = (overlay) => snapshotRoster(overlay, dir)
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: lane.deps })
    const captured = JSON.parse(written(lane.calls, '/task/lean.json')[2])
    const expected = { lead: 29, planner: 7, builder: 11, reviewer: 2400, 'tech-lead': 2400 }
    for (const [role, base] of Object.entries(expected)) {
      const cell = captured.roster.snapshot[role]
      const path = join(dir, `${role}.md`)
      const text = readFileSync(path, 'utf8'), { fields } = parseAgent(text)
      assert.equal(cell.wait_s, base, role)
      for (const tier of TIERS) {
        if (fields.tiers?.[tier] === null) assert.equal(cell.tiers[tier], null)
        else assert.equal(cell.tiers[tier].wait_s, role === 'planner' && tier === 'build' ? 3 : role === 'builder' && tier === 'judge' ? 19 : base, `${role}/${tier}`)
      }
      writeFileSync(path, text.replace(/\nwait_s: \d+/, '').replace('role: ' + role, `role: ${role}\nwait_s: 99`).replace(/tiers: .*/, 'tiers: {"mechanical":{"wait_s":98},"build":{"wait_s":98},"judge":{"wait_s":98}}'))
    }
    for (const path of Object.keys(overrides)) overrides[path] = '{later invalid edit'
    for (const tier of TIERS) for (const finish of [false, true]) {
      const rows = []
      const f = leanFixture({ tier, status: finish ? ['', 'M  src/a.mjs\0'] : 'M  src/a.mjs\0', loopDeps: {
        journal: async (row) => rows.push(row),
        rebaseBranch: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40), onto: 'c'.repeat(40) }),
      }, deps: { readFileSync: (path, ...args) => readFileSync(String(path).startsWith(AGENTS) ? join(dir, String(path).slice(AGENTS.length)) : path, ...args) } })
      Object.assign(f.spec, captured, { id: 'lane', cwd: f.spec.cwd, taskDir: f.spec.taskDir, tier })
      if (finish) Object.assign(f.spec, { shape: 'finish', finish: { subject: 'fix(crew): finish', planPath: null, findings: [], stop: { reason: 'seat-unmeasured' }, turnOffset: 0 } })
      const result = await f.go()
      assert.equal(result.status, 'done', `${tier}/${finish}: ${JSON.stringify(rows.at(-1))}`)
      assert.ok(f.requests.length > 0)
      for (const { definition } of f.requests) assert.equal(definition.wait_s, captured.roster.snapshot[definition.role].tiers[tier].wait_s, `${tier}/${finish}/${definition.role}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('crew start refuses a bad override file before any worktree, naming the file and the key', async () => {
  const path = '/repo/checkout/.crew/agents.json'
  for (const [raw, key] of [
    ['{', 'root'], ['[]', 'root'], [JSON.stringify({ ghost: {} }), 'ghost'],
    [JSON.stringify({ planner: { writes: 'repo' } }), 'planner.writes'],
    [JSON.stringify({ planner: { skills: [] } }), 'planner.skills'],
    [JSON.stringify({ planner: { effort: 'invalid' } }), 'planner.effort'],
    [JSON.stringify({ planner: { tiers: { build: { writes: 'repo' } } } }), 'planner.tiers.build.writes'],
    [JSON.stringify({ planner: { tiers: { unknown: null } } }), 'planner.tiers.unknown'],
    [JSON.stringify({ builder: { tiers: { judge: null } } }), 'builder.tiers.judge'],
    [Object.assign(new Error('denied'), { code: 'EACCES' }), 'read'],
    [JSON.stringify({ planner: { advisor: { agent: 'pi', model: 'local/other', effort: 'low' } } }), 'planner'],
  ]) {
    const f = fakes({ overrides: { [path]: raw }, resolve: resolveAgents })
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }), (error) => error instanceof StartRefusal && error.message.includes(path) && error.message.includes(key), String(key))
    assert.equal(spawned(f.calls, 'worktree'), undefined)
  }
})

test('an existing lane directory or worktree refusal names crew closeout and --discard', async () => {
  for (const path of ['/home/.crew/dt-b1/b1', '/repo/dt-b1']) {
    const { deps } = fakes({ exists: (p) => p === path })
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /crew closeout b1 or crew closeout b1 --discard/)
  }
})

test('a failed detached launch is a StartRefusal that names the left worktree', async () => {
  for (const result of [null, 0, -1, 1.5, new Error('spawn')]) {
    const { deps } = fakes()
    deps.spawnDetached = () => { if (result instanceof Error) throw result; return result }
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (e) => e instanceof StartRefusal && e.message.includes('/repo/dt-b1') && e.message.includes('branch b1'))
  }
})

test('crew start never launches real caffeinate in a test worker', async () => {
  const f = fakes(), calls = []
  const originalSpawn = childProcess.spawn, platform = Object.getOwnPropertyDescriptor(process, 'platform')
  delete f.deps.platform
  delete f.deps.spawn
  try {
    assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined)
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    childProcess.spawn = (...args) => { calls.push(args); return { on() {}, unref() {} } }
    syncBuiltinESMExports()
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
    assert.equal(result.pid, 4242)
    assert.deepEqual(calls, [])
  } finally {
    Object.defineProperty(process, 'platform', platform)
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
})

test('idle sleep retains its default spawn outside a test worker', () => {
  const calls = [], events = []
  const originalSpawn = childProcess.spawn, context = process.env.NODE_TEST_CONTEXT
  try {
    delete process.env.NODE_TEST_CONTEXT
    childProcess.spawn = (...args) => { calls.push(args); return { on: (name) => events.push(name), unref: () => events.push('unref') } }
    syncBuiltinESMExports()
    holdIdleSleep(4242, { platform: 'darwin' })
    assert.deepEqual(calls, [['caffeinate', ['-i', '-w', '4242'], { detached: true, stdio: 'ignore' }]])
    assert.deepEqual(events, ['error', 'unref'])
  } finally {
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT
    else process.env.NODE_TEST_CONTEXT = context
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
})

test('crew start binds an idle sleep assertion to the detached run pid', async () => {
  const f = fakes(), assertions = [], events = []
  Object.assign(f.deps, {
    platform: 'darwin',
    spawn: (...args) => {
      assertions.push(args)
      return { on: (name, handler) => events.push([name, handler]), unref: () => events.push(['unref']) }
    },
  })
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
  assert.deepEqual(assertions, [['caffeinate', ['-i', '-w', String(result.pid)], { detached: true, stdio: 'ignore' }]])
  assert.equal(events[0][0], 'error')
  assert.doesNotThrow(() => events[0][1](Object.assign(new Error('missing'), { code: 'ENOENT' })))
  assert.equal(events[1][0], 'unref')
  assert.match(written(f.calls, '/task/run.pid')[2], /^4242 /)
})

test('idle assertion failures never refuse a crew start', async () => {
  for (const kind of ['linux', 'missing', 'helper']) {
    const f = fakes()
    Object.assign(f.deps, { platform: kind === 'linux' ? 'linux' : 'darwin', spawn: () => { if (kind === 'linux') assert.fail('Linux must not spawn'); throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
    if (kind === 'helper') f.deps.holdIdleSleep = () => { throw new Error('helper failed') }
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
    assert.equal(result.pid, 4242)
    assert.match(written(f.calls, '/task/run.pid')[2], /^4242 /)
  }
})

test('a started lane records its run pid, and a failed pid write only logs', async () => {
  for (const fail of [false, true]) {
    const { deps, calls } = fakes({ write: (kind, path) => { if (fail && path.endsWith('/run.pid')) throw new Error('disk') } })
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
    assert.equal(result.pid, 4242)
    assert.match(written(calls, '/task/run.pid')?.[2], /^4242 \d+\n$/)
    assert.equal(calls.some(([kind, line]) => kind === 'log' && line.includes('run pid not recorded')), fail)
  }
})

const AGENTS = fileURLToPath(new URL('./agents/', import.meta.url))

const BRIEF = `---
source: issue 1961
closes: 1961
shape: standard
out_of_scope: the visualizer
---
## Context

- \`crew/agents.mjs\`
`

// Every effect is a recorded call; nothing touches git, the disk or a process. The agent
// resolution is injected too; the default resolves the committed definitions.
const projectFile = (suite = 'npm test', proof = [], suiteTimeoutMs, proofTimeoutMs) => ({ suite, proof, ...(suiteTimeoutMs === undefined ? {} : { suiteTimeoutMs }), ...(proofTimeoutMs === undefined ? {} : { proofTimeoutMs }), onboarded: { hash: createHash('sha256').update(JSON.stringify([suite, proof.map((e) => [e.match, e.setup ?? null, e.run])])).digest('hex') } })

function fakes({ brief = BRIEF, project = projectFile(), overrides = {}, exists = () => false, worktreeStatus = 0, originHead = 'origin/main', inGit = true, issueBody = 'Refuse roster edits that cannot boot.\n', issueTitle = 'Refuse roster edits', issues = {}, resolve = (tier) => resolveAgents(tier), write = () => {} } = {}) {
  const calls = []
  const deps = {
    platform: 'linux',
    readFileSync: (path) => {
      if (path.endsWith('/.crew/agents.json')) {
        if (Object.hasOwn(overrides, path)) { if (overrides[path] instanceof Error) throw overrides[path]; return overrides[path] }
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      if (!path.endsWith('/.crew/project.json')) return brief
      if (project === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return typeof project === 'string' ? project : JSON.stringify(project)
    },
    resolveAgents: resolve,
    existsSync: (path) => exists(path),
    mkdirSync: (path) => { calls.push(['mkdir', path]); write('mkdir', path) },
    writeFileSync: (path, text) => { calls.push(['write', path, text]); write('write', path, text) },
    appendFileSync: (path, text) => { calls.push(['append', path, text]) },
    spawnSync: (file, args, options) => {
      calls.push(['spawn', file, args, options?.cwd ?? null])
      if (file === 'gh') {
        const field = args.at(-1) === '.title' ? 'title' : 'body'
        const value = issues[args[2]]?.[field] ?? (field === 'title' ? issueTitle : issueBody)
        if (value !== null && typeof value === 'object') return value
        return value === null ? { status: 1, stdout: '' } : { status: 0, stdout: value }
      }
      if (file === 'git' && args.includes('symbolic-ref')) return originHead ? { status: 0, stdout: `${originHead}\n` } : { status: 1, stdout: '' }
      if (file === 'git' && args.includes('ls-tree')) {
        const path = args.at(-1)
        if (path === '.crew/project.json') return { status: 0, stdout: `100644 blob ${'a'.repeat(40)}\t.crew/project.json\n` }
        return { status: 0, stdout: `${path.includes('.') ? '100644 blob' : '040000 tree'} ${'a'.repeat(40)}\t${path}\0` }
      }
      if (file === 'git' && args.includes('worktree')) return { status: worktreeStatus, stdout: '' }
      if (file === 'git' && args.includes('show')) return { status: 0, stdout: JSON.stringify(project) }
      if (file === 'git' && args.includes('rev-parse')) return inGit ? { status: 0, stdout: args.includes('--verify') ? `${'a'.repeat(40)}\n` : '/repo/checkout\n' } : { status: 128, stdout: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    spawnDetached: (file, args, options) => { calls.push(['detached', file, args, options]); return 4242 },
    crewRoot: '/home/.crew',
    transcriptRoot: '/virtual/no-transcripts',
    log: (line) => calls.push(['log', line]),
  }
  return { deps, calls }
}

const effects = (calls) => calls.filter(([kind]) => ['spawn', 'detached', 'mkdir', 'write'].includes(kind))
const written = (calls, suffix) => calls.find(([kind, path]) => kind === 'write' && path.endsWith(suffix))
const spawned = (calls, verb) => calls.find(([kind, , args]) => (kind === 'spawn' || kind === 'detached') && args.includes(verb))

test('crew start refuses ask lines the operator never typed: seat prompts, pasted text and stale transcripts (ADR-056)', async () => {
  const root = scratchDir('provenance-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  const row = (content, promptSource = 'typed', kind = 'human') => ({ type: 'user', origin: { kind }, promptSource, message: { content } })
  writeFileSync(join(dir, 'a.jsonl'), [
    row('first   typed line\nsecond typed line'),
    row([{ text: 'array seat prompt' }], 'sdk'),
    row('string seat prompt', 'sdk'),
    row('notification text', 'system', 'task-notification'),
    row('outside <pasted_content id="c57b">pasted text</pasted_content id="c57b"> outside'),
  ].map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'))
  const old = join(dir, 'old.jsonl')
  writeFileSync(old, JSON.stringify(row('stale transcript')))
  const then = new Date(Date.now() - 40 * 86400000)
  utimesSync(old, then, then)
  const typed = ['first typed line', 'second typed line']
  const excluded = ['array seat prompt', 'string seat prompt', 'notification text', 'pasted text', 'stale transcript']
  const brief = BRIEF.replace('source: issue 1961', 'source: operator request')
    .replace('## Context', `## The ask\n\n${typed.map((line) => `> ${line}`).join('\n')}\n\n${excluded.map((line) => `> ${line}`).join('\n\n')}\n\n## Context`)
  const expected = `brief /d/b1.md quotes words the operator did not type (ADR-056):\n${excluded.map((text, i) => `- ask block at line ${12 + 2 * i} is not one whole message the operator typed: ${JSON.stringify(text)}`).join('\n')}`
  {
    let resolutions = 0
    const { deps, calls } = fakes({ brief, resolve: () => { resolutions++; return { seats: {} } } })
    deps.transcriptRoot = root
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (error) => error instanceof StartRefusal && error.message === expected)
    assert.equal(resolutions, 0)
    assert.deepEqual(effects(calls), [])
  }
  const pass = fakes({ brief: brief.replace(`${excluded.map((line) => `> ${line}`).join('\n\n')}\n\n`, '') })
  pass.deps.transcriptRoot = root
  await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', deps: pass.deps }))
})

test('crew start accepts queued operator messages as provenance and refuses words no queued or typed message contains (ADR-056)', async () => {
  const root = scratchDir('provenance-queued-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  const row = (content, promptSource = 'queued', kind = 'human') => ({ type: 'user', origin: { kind }, promptSource, message: { content } })
  const path = join(dir, 'a.jsonl')
  writeFileSync(path, [
    row('whole queued message'), row('sdk message', 'sdk'), row('system message', 'system'),
    row('non-human message', 'queued', 'task-notification'), row(['array message']),
    { ...row('non-user message'), type: 'assistant' },
  ].map(JSON.stringify).join('\n'))
  const old = join(dir, 'old.jsonl')
  writeFileSync(old, JSON.stringify(row('stale queued message')))
  const then = new Date(Date.now() - 40 * 86400000)
  utimesSync(old, then, then)
  const makeBrief = (ask) => BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', `## The ask\n\n${ask}\n\n## Context`)
  const excluded = ['unrelated words', 'queued message', 'sdk message', 'system message', 'non-human message', 'array message', 'non-user message', 'stale queued message']
  {
    let resolutions = 0
    const fail = fakes({ brief: makeBrief(excluded.map((text) => `> ${text}`).join('\n\n')), resolve: () => { resolutions++; return { seats: {} } } })
    fail.deps.transcriptRoot = root
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: fail.deps }), (error) => error instanceof StartRefusal && excluded.every((text) => error.message.includes(JSON.stringify(text))))
    assert.equal(resolutions, 0)
    assert.deepEqual(effects(fail.calls), [])
    const pass = fakes({ brief: makeBrief('> whole queued message') })
    pass.deps.transcriptRoot = root
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: pass.deps }))
    assert.equal(pass.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured')), false)
  }
  appendFileSyncReal(path, `\n${JSON.stringify(row('whole typed message', 'typed'))}`)
  const both = fakes({ brief: makeBrief('> whole queued message\n\n> whole typed message') })
  both.deps.transcriptRoot = root
  await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', deps: both.deps }))
})

test('crew start reports ask provenance unmeasured with no transcript and starts; an issue brief reads none (ADR-056)', async () => {
  const brief = BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', '## The ask\n\n> Do this.\n\n## Context')
  const empty = scratchDir('provenance-empty-')
  for (const [root, reason] of [['/virtual/no-transcripts', 'no Claude Code transcript directory'], [empty, 'no typed operator message']]) {
    const operator = fakes({ brief })
    operator.deps.transcriptRoot = root
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: operator.deps })
    assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes(`crew start: ask provenance unmeasured: ${reason}`)))
    assert.ok(effects(operator.calls).length)
  }
  const root = scratchDir('provenance-partial-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  const row = (content) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content } })
  writeFileSync(join(dir, 'readable.jsonl'), row('Unrelated words.'))
  for (const code of ['EACCES', 'EPERM', undefined]) {
    const original = fs.readdirSync
    fs.readdirSync = (...args) => { if (args[0] === root) throw Object.assign(new Error('denied'), { code }); return original(...args) }
    syncBuiltinESMExports()
    try {
      const operator = fakes({ brief })
      operator.deps.transcriptRoot = root
      await startLane({ briefPath: '/d/b1.md', deps: operator.deps })
      assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes(`cannot read Claude Code transcript directory at ${root}: ${code ?? 'unknown error'}`)))
    } finally { fs.readdirSync = original; syncBuiltinESMExports() }
  }
  const hidden = join(dir, 'unreadable.jsonl')
  writeFileSync(hidden, row('Do this.'))
  for (const [method, path] of [['readFileSync', hidden], ['statSync', hidden], ['readdirSync', dir]]) {
    const original = fs[method]
    fs[method] = (...args) => { if (args[0] === path) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return original(...args) }
    syncBuiltinESMExports()
    try {
      {
        const operator = fakes({ brief })
        operator.deps.transcriptRoot = root
        await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: operator.deps })
        assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured: incomplete Claude Code transcript scan')))
        assert.ok(effects(operator.calls).length)
      }
    } finally { fs[method] = original; syncBuiltinESMExports() }
  }
  writeFileSync(hidden, row('Do this.').slice(0, -1))
  {
    const operator = fakes({ brief })
    operator.deps.transcriptRoot = root
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: operator.deps })
    assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured: incomplete Claude Code transcript scan')))
    assert.ok(effects(operator.calls).length)
  }
  const issue = fakes()
  issue.deps.transcriptRoot = { [Symbol.toPrimitive]() { throw new Error('transcript root read') } }
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: issue.deps })
  assert.equal(issue.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance')), false)
})

const pipeFixture = `
import { writeSync } from 'node:fs'
const invalid = process.argv[1] === 'invalid'
process.argv[1] = process.execPath
const { main } = await import(${JSON.stringify(new URL('./start.mjs', import.meta.url).href)})
const deps = {
  readFileSync: (path) => path.endsWith('/agents.json') ? (() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })() : path.endsWith('/.crew/project.json') ? ${JSON.stringify(JSON.stringify({suite:'npm test',proof:[],onboarded:{hash:createHash('sha256').update(JSON.stringify(['npm test',[]])).digest('hex')}}))} : invalid ? ${JSON.stringify(BRIEF)}.replace('shape: standard', 'tier: build\\nshape: standard') : ${JSON.stringify(BRIEF)},
  resolveAgents: () => ({ seats: {} }), existsSync: () => false,
  mkdirSync: () => {}, writeFileSync: () => {},
  spawnSync: (file, args) => ({ status: 0, stdout: args.includes('ls-tree') ? (args.at(-1) === '.crew/project.json' ? '100644 blob ' + 'a'.repeat(40) + '\\t.crew/project.json' : (args.at(-1).includes('.') ? '100644 blob ' : '040000 tree ') + 'a'.repeat(40) + '\\t' + args.at(-1) + '\\0') : args.includes('show') ? ${JSON.stringify(JSON.stringify({suite:'npm test',proof:[],onboarded:{hash:createHash('sha256').update(JSON.stringify(['npm test',[]])).digest('hex')}}))} : args.includes('--verify') ? 'a'.repeat(40) : 'origin/main' }),
  platform: 'linux', spawnDetached: () => { writeSync(3, 'started\\n'); return 4242 }, crewRoot: '/virtual/crew',
}
const argv = invalid ? ['/d/b1.md'] :
  ['/d/b1.md', '--checkout', '/virtual/' + 'x'.repeat(1024 * 1024) + '/checkout']
process.exitCode = await main(argv, deps)
`

function runPipeChild(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', pipeFixture, mode], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', started = '', closed = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 10000)
    child.on('error', reject)
    child.stderr.on('data', (data) => { stderr += data })
    child.stdio[3].on('data', (data) => { started += data })
    child.stdout.on('data', (data) => {
      stdout += data
      if (stdout.includes('\n') && !closed) { closed = true; child.stdout.destroy() }
    })
    if (mode === 'invalid') child.stdout.destroy()
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, started, closed, timedOut }) })
  })
}

// MUTATION: change the successful main return to 1 and a started lane reports failure.
test('(SE1) a reader closing stdout after the first line does not crash a started lane', async () => {
  const result = await runPipeChild('pipe')
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.started, 'started\n')
  assert.equal(result.closed, true)
  assert.match(result.stdout, /^crew start: lane=b1 .*pid=4242\n/)
  assert.equal(result.stderr, '')
})

test('throwing injected loggers do not change start metadata or main status', async () => {
  for (const error of [Object.assign(new Error('EIO'), { code: 'EIO' }), new StartRefusal('output')]) {
    const lane = fakes()
    lane.deps.log = () => { throw error }
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: lane.deps })
    assert.equal(result.lane, 'b1')
    assert.equal(result.pid, 4242)
    assert.ok(leanLaunch(lane.calls))
    const run = fakes()
    run.deps.log = () => { throw error }
    assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], run.deps), 0)
    assert.ok(leanLaunch(run.calls))
  }
})

test('the lane name is the brief file name and must be a slug', () => {
  assert.equal(laneName('/drafts/b1360-lean-entry.md'), 'b1360-lean-entry')
  assert.throws(() => laneName('/drafts/My Brief.md'), StartRefusal)
})

test('a brief with mechanical: true starts a mechanical lane and a brief without it starts a build lane', async () => {
  for (const tier of ['mechanical', 'build']) {
    const brief = tier === 'mechanical' ? BRIEF.replace('shape: standard', 'mechanical: true\nshape: standard') : BRIEF
    const resolved = []
    const f = fakes({ brief, resolve: (t) => { resolved.push(t); return resolveAgents(t) } })
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }))
    assert.deepEqual(resolved, [tier])
    assert.ok(f.calls.some(([kind, line]) => kind === 'log' && line.includes(`loop=lean tier=${tier}`)))
    assert.equal(JSON.parse(written(f.calls, '/task/lean.json')[2]).tier, tier)
  }
})

test('without a readable origin/HEAD the start is refused before any worktree is made', async () => {
  const { deps, calls } = fakes({ originHead: null })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /origin\/HEAD.*git remote set-head origin --auto/)
  assert.equal(spawned(calls, 'worktree'), undefined)
  assert.equal(calls.some(([kind]) => ['write', 'mkdir', 'detached'].includes(kind)), false)
})

test('main reports usage, refusals and success as exit codes', async () => {
  assert.equal(await main([], fakes().deps), 2)
  assert.equal(await main(['a.md', 'b.md'], fakes().deps), 2)
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], fakes({ worktreeStatus: 1 }).deps), 1)
})

test('a start needs a checkout', async () => {
  assert.equal(await main(['/d/b1.md'], fakes({ inGit: false }).deps), 2)
})

test('an issue brief starts with the issue body quoted as its ask, and an unreadable or empty issue refuses before the worktree', async () => {
  const issueBody = 'First $& line\n  \n## Not a heading\n  last line  \n'
  const f = fakes({ issueBody, issueTitle: '  Refuse\n roster   edits  ' })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
  const calls = f.calls
  const gh = calls.filter(([kind, file]) => kind === 'spawn' && file === 'gh')
  assert.deepEqual(gh, [
    ['spawn', 'gh', ['issue', 'view', '1961', '--json', 'body', '--jq', '.body'], '/repo/checkout'],
    ['spawn', 'gh', ['issue', 'view', '1961', '--json', 'title', '--jq', '.title'], '/repo/checkout'],
  ])
  assert.ok(calls.indexOf(spawned(calls, 'symbolic-ref')) < calls.indexOf(gh[0]))
  assert.ok(calls.indexOf(gh[1]) < calls.indexOf(spawned(calls, 'worktree')))
  const expected = runBrief(BRIEF, 1961).replace('---\n## Context', () => '---\nIssue title: Refuse roster edits\n## The ask\n\n> First $& line\n>\n> ## Not a heading\n>   last line\n\n## Context')
  assert.equal(written(calls, '/briefs/started/b1.md')[2], expected)
  assert.equal(JSON.parse(written(calls, '/task/lean.json')[2]).brief, expected)
  const spaced = fakes({ brief: BRIEF.replace('---\n## Context', '---  \n## Context') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: spaced.deps })
  assert.match(written(spaced.calls, '/briefs/started/b1.md')[2], /---  \nIssue title: Refuse roster edits\n## The ask\n\n> Refuse/)
  for (const [result, message] of [
    [{ status: null, error: new Error('spawnSync gh ENOENT') }, /issue 1961: spawnSync gh ENOENT/],
    [{ status: 1, stderr: 'authentication required\n' }, /issue 1961: authentication required/],
    [{ status: 1 }, /issue 1961: gh exited with status 1/],
    ...['', ' \n\t', '>\n> > \n', '---\n'].map((stdout) => [{ status: 0, stdout }, /issue 1961 has an empty body/]),
  ]) {
    const failed = fakes()
    const spawnSync = failed.deps.spawnSync
    failed.deps.spawnSync = (file, args, options) => file === 'gh' ? (spawnSync(file, args, options), result) : spawnSync(file, args, options)
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: failed.deps }), (error) => error instanceof StartRefusal && message.test(error.message))
    assert.equal(spawned(failed.calls, 'worktree'), undefined)
    assert.equal(failed.calls.some(([kind]) => ['mkdir', 'write', 'detached'].includes(kind)), false)
  }
  for (const [result, message] of [
    [{ status: null, error: new Error('spawnSync gh ENOENT') }, /issue 1961: spawnSync gh ENOENT/],
    [{ status: 1, stderr: 'authentication required\n' }, /issue 1961: authentication required/],
    [{ status: 1 }, /issue 1961: gh exited with status 1/],
    ...['', ' \n\t'].map((stdout) => [{ status: 0, stdout }, /issue 1961 has an empty title/]),
  ]) {
    const failed = fakes()
    const spawnSync = failed.deps.spawnSync
    failed.deps.spawnSync = (file, args, options) => file === 'gh' && args.at(-1) === '.title' ? (spawnSync(file, args, options), result) : spawnSync(file, args, options)
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: failed.deps }), (error) => error instanceof StartRefusal && message.test(error.message))
    assert.equal(spawned(failed.calls, 'worktree'), undefined)
    assert.equal(failed.calls.some(([kind]) => ['mkdir', 'write', 'detached'].includes(kind)), false)
  }
  const operatorBrief = BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', '## The ask\n\n> Do this.\n\n## Context')
  const run = fakes({ brief: operatorBrief })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: run.deps })
  assert.equal(run.calls.some(([kind, file]) => kind === 'spawn' && file === 'gh'), false)
  assert.equal(JSON.parse(written(run.calls, '/task/lean.json')[2]).brief, runBrief(operatorBrief, 1961))
})

test('crew start snapshots distinct referenced issues as quoted context for both source kinds', async () => {
  const body = 'First $& $` $\' $$ line\n\n## Context\n\n```md\n## The ask\n```\n> nested quote\n#900 and issue 998\n' + 'long tail '.repeat(8000) + 'TAIL_SENTINEL\n'
  const context = '## Context\n\n- issue 1961 issue 12 PR 56\n- `issue 77` issue 34 issue 12\n'
  const ask = '## The ask\n\n> Read issue 999.\n> ## Context\n> ```\n> ## The ask\n> ```\n\n'
  for (const [source, draftBody, closes, crlf] of [
    ['issue 1961', context, 1961, false],
    ['operator request', ask + context, null, false],
    ['operator request', context + '\n' + ask, 42, true],
  ]) {
    let brief = BRIEF.slice(0, BRIEF.indexOf('## Context')).replace('source: issue 1961', `source: ${source}`).replace('closes: 1961', `closes: ${closes}`) + (source === 'operator request' ? draftBody.replace('issue 1961 ', '') : draftBody)
    if (crlf) brief = brief.replace(/\n/g, '\r\n')
    const f = fakes({ brief, issueBody: 'Source ask\n## Context\n```\n## The ask\n```\n', issues: {
      12: { title: '  Related\n issue  ', body },
      34: { title: 'Second issue', body: 'Other context.' },
    } })
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
    const snapshot = written(f.calls, '/briefs/started/b1.md')[2]
    const spec = JSON.parse(written(f.calls, '/task/lean.json')[2])
    assert.equal(snapshot.split('\n').filter((line) => line === '## Referenced issues').length, 1)
    const section = '## Referenced issues\n\nThese are context, not asks; only closes binds an issue.\n\n### issue 12: Related issue\n\n' + body.trimEnd().split('\n').map((line) => line ? `> ${line}` : '>').join('\n') + '\n\n### issue 34: Second issue\n\n> Other context.\n\n'
    const contextEnd = snapshot.indexOf('- `issue 77` issue 34 issue 12') + '- `issue 77` issue 34 issue 12'.length
    assert.equal(snapshot.slice(contextEnd), `\n\n${section}${draftBody.startsWith('## Context') && source === 'operator request' ? ask.replace(/\n/g, '\r\n') : ''}`)
    assert.equal(spec.brief, snapshot)
    assert.equal(spec.source, source)
    assert.deepEqual(spec.closes, closes === null ? [] : [closes])
    assert.deepEqual(snapshot.match(/^<!-- crew:bound-issue .* -->$/gm) ?? [], closes === null ? [] : [`<!-- crew:bound-issue #${closes} -->`])
    if (source.startsWith('issue')) assert.ok(snapshot.includes('> Source ask\n> ## Context\n> ```\n> ## The ask\n> ```'))
    else assert.ok(snapshot.includes(crlf ? ask.trimEnd().replace(/\n/g, '\r\n') : ask.trimEnd()))
    const gh = f.calls.filter(([kind, file]) => kind === 'spawn' && file === 'gh')
    assert.deepEqual(gh.map(([, , args, cwd]) => [args[2], args.at(-1), cwd]), (source.startsWith('issue') ? ['1961', '12', '34'] : ['12', '34']).flatMap((number) => [
      [number, '.body', '/repo/checkout'], [number, '.title', '/repo/checkout'],
    ]))
    assert.ok(f.calls.indexOf(gh.at(-1)) < f.calls.indexOf(spawned(f.calls, 'worktree')))
  }
})

test('crew start includes titles and empty body markers for referenced issues', async () => {
  const f = fakes({ brief: BRIEF + '- issue 12 issue 34 issue 56\n', issues: {
    12: { title: 'Empty issue', body: '' },
    34: { title: 'Whitespace issue', body: ' \n\t' },
    56: { title: 'Nonempty issue', body: '---\n' },
  } })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps })
  const snapshot = written(f.calls, '/briefs/started/b1.md')[2]
  for (const [number, title, body] of [[12, 'Empty issue', 'empty body'], [34, 'Whitespace issue', 'empty body'], [56, 'Nonempty issue', '---']]) {
    assert.ok(snapshot.includes(`### issue ${number}: ${title}\n\n> ${body}`))
  }
})

// stderr of main, captured; the exit code is returned beside it.
async function mainWithStderr(argv, deps) {
  let stderr = ''
  const write = process.stderr.write
  process.stderr.write = (text) => { stderr += String(text); return true }
  try { return { code: await main(argv, deps), stderr } } finally { process.stderr.write = write }
}

const LEAN = fileURLToPath(new URL('./lean.mjs', import.meta.url))
const leanLaunch = (calls) => calls.find(([kind, , args]) => kind === 'detached' && args[0] === LEAN)

test('a configured builderChecks in project.json reaches the lane spec and an absent one writes no key', async () => {
  const checks = ['cargo clippy -- -D warnings', 'cargo test -p fence']
  for (const field of [{ builderChecks: checks }, {}]) {
    const { deps, calls } = fakes({ project: { ...projectFile(), ...field } })
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
    const spec = JSON.parse(written(calls, '/task/lean.json')[2])
    assert.equal(Object.hasOwn(spec, 'builderChecks'), Object.hasOwn(field, 'builderChecks'))
    assert.deepEqual(spec.builderChecks, field.builderChecks)
  }
})

test('start refuses when the selected lane base lacks the approved onboarding', async () => {
  for (const [baseProject, reason] of [[null, 'not-onboarded'], ['{', 'onboarding-stale'], [projectFile('cargo test'), 'onboarding-stale'], [projectFile(), null]]) {
    const root = scratchDir('start-base-onboarding-')
    const repo = join(root, 'checkout')
    mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.test')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'initial'), 'initial')
    mkdirSync(join(repo, 'crew'))
    writeFileSync(join(repo, 'crew', 'agents.mjs'), '')
    if (baseProject !== null) {
      mkdirSync(join(repo, '.crew'))
      writeFileSync(join(repo, '.crew', 'project.json'), typeof baseProject === 'string' ? baseProject : JSON.stringify(baseProject))
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    const baseCommit = git(repo, 'rev-parse', 'HEAD').trim()
    git(root, 'init', '--bare', '-b', 'main', join(root, 'origin.git'))
    git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'))
    git(repo, 'push', 'origin', 'main')
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(repo, 'checkout', '-b', 'feature')
    mkdirSync(join(repo, '.crew'), { recursive: true })
    writeFileSync(join(repo, '.crew', 'project.json'), JSON.stringify(projectFile()))
    writeFileSync(join(repo, 'feature-only'), 'feature')
    git(repo, 'add', '.crew/project.json', 'feature-only')
    git(repo, 'commit', '-m', 'onboard feature')
    const briefPath = join(root, 'b1.md')
    writeFileSync(briefPath, BRIEF)
    const calls = []
    const deps = {
      crewRoot: join(root, 'crew'), resolveAgents: () => ({ seats: {} }),
      spawnSync: (file, args, options) => {
        calls.push([file, args])
        return file === 'git' ? spawnSync(file, args, { ...options, encoding: 'utf8' }) : { status: 0, stdout: 'issue body' }
      },
      platform: 'linux', spawnDetached: () => { calls.push(['launch']); return 1 }, log: () => {},
    }
    if (reason) {
      await assert.rejects(startLane({ briefPath, checkout: repo, deps }), (error) => error instanceof StartRefusal && error.message.includes(reason) && error.message.includes('/onboard') && error.message.includes('main'))
      assert.equal(calls.some(([file, args]) => file === 'launch' || args.includes('worktree')), false)
      assert.equal(existsSync(join(root, 'crew')), false)
      assert.equal(existsSync(join(root, 'dt-b1')), false)
    } else {
      const lane = await startLane({ briefPath, checkout: repo, deps })
      assert.equal(git(repo, 'rev-parse', 'b1').trim(), baseCommit)
      assert.equal(existsSync(join(lane.worktree, 'feature-only')), false)
      assert.equal(JSON.parse(readFileSync(lane.specPath, 'utf8')).base, 'main')
    }
  }
})

function originBaseFixture(change) {
  const root = scratchDir('start-origin-base-')
  const seed = join(root, 'seed'), checkout = join(root, 'checkout'), origin = join(root, 'origin.git')
  mkdirSync(seed)
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(seed, 'init', '-b', 'main')
  git(seed, 'config', 'user.email', 'test@example.test')
  git(seed, 'config', 'user.name', 'Test')
  mkdirSync(join(seed, '.crew'))
  writeFileSync(join(seed, '.crew', 'project.json'), JSON.stringify(projectFile()))
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'base')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', 'origin', 'main')
  const a = git(seed, 'rev-parse', 'HEAD').trim()
  git(root, 'clone', origin, checkout)
  change(seed)
  git(seed, 'add', '.')
  git(seed, 'commit', '-m', 'origin update')
  git(seed, 'push', 'origin', 'main')
  const b = git(seed, 'rev-parse', 'HEAD').trim()
  const briefPath = join(root, 'b1.md')
  writeFileSync(briefPath, BRIEF.replace('`crew/agents.mjs`', '`origin-only`'))
  const calls = []
  const deps = {
    crewRoot: join(root, 'crew'), transcriptRoot: '/virtual/no-transcripts', resolveAgents: () => ({ seats: {} }),
    spawnSync: (file, args, options) => {
      calls.push([file, args])
      return file === 'git' ? spawnSync(file, args, { ...options, encoding: 'utf8' }) : { status: 0, stdout: 'issue body' }
    },
    platform: 'linux', spawnDetached: () => { calls.push(['launch']); return 1 }, log: () => {},
  }
  return { root, checkout, briefPath, deps, calls, a, b }
}

function worktreeSetupFixture(dirty) {
  const f = originBaseFixture((seed) => {
    const root = join(seed, '..')
    const script = join(root, 'setup.mjs')
    writeFileSync(script, `import { appendFileSync, writeFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(root, 'setup.log'))}, process.cwd() + '\\n')\n${dirty ? "writeFileSync('initial', 'changed'); writeFileSync('seeded.txt', 'seeded')" : "writeFileSync('seeded.bin', 'seeded')"}\n`)
    writeFileSync(join(seed, 'initial'), 'initial')
    writeFileSync(join(seed, '.gitignore'), 'seeded.bin\n')
    writeFileSync(join(seed, 'origin-only'), '')
    const project = { suite: 'npm test', proof: [], worktreeSetup: `${process.execPath} ${script}` }
    writeFileSync(join(seed, '.crew', 'project.json'), JSON.stringify({ ...project, onboarded: { hash: projectHash(project) } }))
  })
  writeFileSync(join(f.checkout, '.crew', 'project.json'), readFileSync(join(f.root, 'seed', '.crew', 'project.json')))
  return f
}

test('crew start refuses a worktreeSetup that leaves changed or untracked paths, names them and starts no run', async () => {
  for (const [status, reason] of [['green', null], ['red', 'exit-nonzero'], ['unmeasured', 'timeout']]) {
    const f = worktreeSetupFixture(true)
    if (status === 'red') appendFileSyncReal(join(f.root, 'setup.mjs'), '\nprocess.exitCode = 1\n')
    if (status === 'unmeasured') f.deps.runSuite = async ({ cwd }) => {
      writeFileSync(join(cwd, 'initial'), 'changed')
      writeFileSync(join(cwd, 'seeded.txt'), 'seeded')
      return { status, reason }
    }
    await assert.rejects(startLane({ briefPath: f.briefPath, checkout: f.checkout, deps: f.deps }), (error) => error instanceof StartRefusal && error.message.includes('initial') && error.message.includes('seeded.txt'))
    assert.equal(f.calls.some(([kind]) => kind === 'launch'), false)
    const task = join(f.root, 'crew', 'dt-b1', 'b1', 'task')
    assert.equal(existsSync(join(task, 'lean.json')), false)
    assert.equal(existsSync(join(task, 'journal.jsonl')), true)
    const rows = readFileSync(join(task, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, status)
    assert.equal(rows[0].reason, reason)
  }
})

test('crew start refuses when the origin fetch fails and does not fall back to the local branch', async () => {
  const f = originBaseFixture((seed) => writeFileSync(join(seed, 'origin-only'), 'origin'))
  writeFileSync(f.briefPath, BRIEF.replace('`crew/agents.mjs`', '`.crew/project.json`'))
  git(f.checkout, 'remote', 'set-url', 'origin', join(f.root, 'gone.git'))
  await assert.rejects(startLane({ briefPath: f.briefPath, checkout: f.checkout, deps: f.deps }), (error) => error instanceof StartRefusal && error.message.includes('fetch') && error.message.includes('gone.git'))
  assert.equal(existsSync(join(f.root, 'dt-b1')), false)
  assert.equal(f.calls.some(([file]) => file === 'launch'), false)
  assert.notEqual(spawnSync('git', ['-C', f.checkout, 'show-ref', '--verify', '--quiet', 'refs/heads/b1']).status, 0)
})

test('crew start names the signal when the origin fetch is interrupted', async () => {
  for (const stderr of ['', 'fetch interrupted']) {
    const f = fakes()
    const spawn = f.deps.spawnSync
    f.deps.spawnSync = (file, args, options) => args.includes('fetch')
      ? { status: null, signal: 'SIGTERM', stderr }
      : spawn(file, args, options)
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }), (error) => error instanceof StartRefusal && error.message.includes('fetch') && error.message.includes('SIGTERM') && error.message.includes(stderr))
    assert.equal(spawned(f.calls, 'worktree'), undefined)
    assert.equal(f.calls.some(([kind]) => kind === 'detached'), false)
  }
})

test('crew start writes the brief generated paths and regenerate command into the lane spec, and no generated key when the brief declares neither', async () => {
  for (const declared of [true, false]) {
    const f = fakes({ brief: declared ? BRIEF.replace('out_of_scope:', 'generated: [gen.txt, dist/]\nregenerate: npm run generate\nout_of_scope:') : BRIEF })
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }))
    const spec = JSON.parse(written(f.calls, '/task/lean.json')[2])
    assert.equal(Object.hasOwn(spec, 'generated'), declared)
    if (declared) assert.deepEqual(spec.generated, { paths: ['gen.txt', 'dist/'], command: 'npm', args: ['run', 'generate'], timeoutMs: 1800000 })
  }
})

test('main refuses --check as usage and starts nothing', async () => {
  for (const argv of [['/d/b1.md', '--check'], ['--check', '/d/b1.md'], ['/d/b1.md', '--check', '--check'], ['/d/b1.md', '--checkout', '--check']]) {
    const { deps, calls } = fakes()
    assert.deepEqual(await mainWithStderr(argv, deps), { code: 2, stderr: 'usage: crew start <brief.md> [--checkout <dir>]\n' })
    assert.deepEqual(effects(calls), [])
  }
})

test('a plain start is the only validation: defective, missing-context and stale-onboarding briefs refuse before any effect and check:true starts a valid lane', async () => {
  for (const kind of ['defect', 'missing-context', 'checkout-onboarding', 'base-onboarding']) {
    const run = fakes({
      brief: kind === 'defect' ? BRIEF.replace('shape: standard', 'tier: build\nshape: standard') : BRIEF,
      project: kind === 'checkout-onboarding' ? null : projectFile(),
    })
    const spawn = run.deps.spawnSync
    run.deps.spawnSync = (file, args, options) => {
      const result = spawn(file, args, options)
      if (kind === 'missing-context' && args.includes(`${'a'.repeat(40)}:crew/agents.mjs`)) return { status: 1 }
      if (kind === 'base-onboarding' && args.includes('show')) return { status: 0, stdout: JSON.stringify(projectFile('cargo test')) }
      return result
    }
    const expected = kind === 'defect' ? /tier is not a brief field/ : kind === 'missing-context' ? /main[\s\S]*crew\/agents\.mjs/ : /\/onboard/
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: run.deps }), (error) => error instanceof StartRefusal && expected.test(error.message))
    if (kind === 'defect' || kind === 'checkout-onboarding') assert.deepEqual(effects(run.calls), [])
    assert.equal(run.calls.some(([type, file, args]) => ['mkdir', 'write', 'detached'].includes(type) || (type === 'spawn' && (file === 'gh' || args.includes('worktree')))), false)
  }
  const valid = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps: valid.deps })
  assert.equal(result.checked, undefined)
  assert.ok(spawned(valid.calls, 'worktree'))
  assert.ok(leanLaunch(valid.calls))
  assert.equal(valid.calls.some(([type, line]) => type === 'log' && line.includes('brief ok')), false)
})

test('(LS2) a refusing start in a child process loads no old driver, roster or crew module', () => {
  const dir = scratchDir('lean-start-trace-')
  const tracer = join(dir, 'trace.mjs')
  const trace = join(dir, 'trace.log')
  const brief = join(dir, 'b1.md')
  writeFileSync(brief, BRIEF.replace('shape: standard', 'shape: stepped'))
  writeFileSync(tracer, `import { registerHooks } from 'node:module'\nimport { appendFileSync } from 'node:fs'\nregisterHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(trace)}, url + '\\n'); return next(url, context) } })\n`)
  const start = fileURLToPath(new URL('./start.mjs', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', tracer, start, brief], { encoding: 'utf8' })
  assert.equal(child.status, 1, child.stderr)
  assert.match(child.stderr, /not a P1 brief/)
  const loaded = readFileSync(trace, 'utf8')
  assert.match(loaded, /crew\/start\.mjs/)
  for (const name of ['drive', 'roster', 'roster-validate', 'roster-generate', 'crew']) assert.equal(loaded.includes(`/crew/${name}.mjs`), false, name)
})

test('a lean start refuses before any effect when the agent definitions do not resolve or the brief is not P1', async () => {
  const bad = fakes({ resolve: () => { throw new Error('agent definitions are refused: empty') } })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: bad.deps }), (error) => error instanceof StartRefusal && /agent definitions/.test(error.message))
  assert.deepEqual(bad.calls.filter(([kind]) => kind !== 'log'), [])
  const defect = fakes({ brief: BRIEF.replace('shape: standard', 'tier: build\nshape: standard') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: defect.deps }), /tier is not a brief field/)
  assert.deepEqual(defect.calls.filter(([kind]) => kind !== 'log'), [])
})

// MUTATION: swallow the metadata failure and the bridge launches without a spec.
test('a denied lean metadata write stops the launch and names the left worktree', async () => {
  for (const [failing, at] of [['mkdir', 2], ['write', 2], ['write', 3]]) {
    // mkdir 1 and write 1 are the brief snapshot (lean writes no roster); the lean directory and its two files follow.
    const seen = { mkdir: 0, write: 0 }
    const { deps, calls } = fakes({ write: (kind) => { if (++seen[kind] === at && kind === failing) throw Object.assign(new Error('EPERM injected'), { code: 'EPERM' }) } })
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (error) => error instanceof StartRefusal && error.message.includes('EPERM') && /worktree \/repo\/dt-b1 and branch b1 are left for inspection/.test(error.message), `${failing} ${at}`)
    assert.equal(calls.some(([kind]) => kind === 'detached'), false, `${failing} ${at}`)
  }
})

// ---- crew/lean.mjs: the detached bridge, over a fake ACP seat and fake loop checks ----

const GREEN = { status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const EPERM = Object.assign(new Error('denied'), { code: 'EPERM' })

// A lane's whole loop with every outside effect faked: seats answer by envelope id, recordings are real files.
function leanFixture({ tier = 'build', answers = {}, acp, deps = {}, loopDeps = {}, scope = ['src/a.mjs'], planTests = [{ file: 'lib.test.mjs', title: 'works' }], repairPlan = false, repairBuilder = false, status = 'M  src/a.mjs\0' } = {}) {
  const dir = scratchDir('lean-')
  const spec = {
    id: 'lane', cwd: join(dir, 'worktree'), taskDir: join(dir, 'task'), tier, shape: 'standard', brief: BRIEF,
    source: 'issue 1961', branch: 'lane', base: 'main', suite: { command: 'npm', args: ['test'] },
  }
  mkdirSync(spec.cwd, { recursive: true })
  const requests = [], logs = [], reviews = answers.reviews ?? ['pass']
  let review = 0, reads = 0, rebasedHead = null, committed = false, baseOid = 'c'.repeat(40)
  const envelope = (role, id) => {
    const n = Number(id.split('.').at(-1))
    const own = answers[`${role}.${n}`]
    const details = role === 'planner' ? { subject: 'fix(crew): publish measured lane results', tests: planTests, plan_path: join(spec.taskDir, 'plan.md'), files_in_scope: scope }
      : role === 'builder' ? { summary: 'built', ...(tier === 'mechanical' ? { subject: 'docs(crew): fix typo' } : {}), tests: [{ file: 'lib.test.mjs', title: 'works' }], notes: `builder turn ${n}` }
      : role === 'lead' ? { decision: 'bounce', target: 'builder' }
      : { verdict: reviews[review] ?? 'pass', findings: reviews[review++] === 'changes-needed' ? [{ id: 'F1', severity: 'must-fix', location: 'a:1', summary: 'redo-this', trigger: 'bad input' }] : [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['a'], complete: true }, ...(review > 1 ? { closed: [{ id: 'F1', evidence: 'fixed' }] } : {}) }
    if (role === 'builder' && own === 'escalate') details.question = 'What next?'
    return { role, id, status: own ?? 'done', summary: 'fixture', details }
  }
  const fakeAcp = acp ?? (async (input) => {
    requests.push(input)
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
    // The real seat swallows a failed append and never tells its caller.
    try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk-${id}` } } })}\n`, 'utf8') } catch {}
    mkdirSync(spec.taskDir, { recursive: true })
    // the planner's artifacts exist in the task dir, as the loop requires of its two paths
    if (input.definition.role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(spec.taskDir, name), '')
    const value = envelope(input.definition.role, id)
    if (repairPlan && input.definition.role === 'planner' && !input.prompt.startsWith('Your envelope was refused.')) value.details.files_in_scope = [123]
    if (repairBuilder && input.definition.role === 'builder' && !input.prompt.startsWith('Your envelope was refused.')) delete value.details[tier === 'mechanical' && spec.shape !== 'finish' ? 'subject' : 'summary']
    writeFileSync(path, JSON.stringify(value))
    return { stopReason: 'end_turn', usage: null, refusal: null }
  })
  const options = {
    runEndCommandDeps: { crewRoot: join(dir, 'personal') },
    log: (line) => logs.push(line),
    runAcpSeat: (input) => { if (!acp) return fakeAcp(input); requests.push(input); return fakeAcp(input) },
    loopDeps: {
      journal: async () => {},
      proveTests: async () => ({ status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }),
      runSuite: async () => GREEN,
      commitChanges: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40) }),
      rebaseBranch: async () => ({ status: 'green', reason: null, head: (committed ? 'a' : 'b').repeat(40), onto: baseOid }),
      openPullRequest: async () => ({ status: 'green', reason: null, pr: { number: 7, url: 'https://example.test/7' } }),
      // After the rebase the tree is the rebased head and clean; before it, status reads the scripted paths.
      run: async (input) => input.args.includes('write-tree') ? { ...GREEN, stdout: `${'e'.repeat(40)}\n` }
        : input.args.includes('rev-parse') ? { ...GREEN, stdout: `${input.args.at(-1) === `refs/remotes/origin/${spec.base}` ? baseOid : rebasedHead}\n` }
        : input.args.includes('status') ? { ...GREEN, stdout: rebasedHead ? '' : [status].flat()[Math.min(reads++, [status].flat().length - 1)] } : GREEN,
      ...loopDeps,
    },
    ...deps,
  }
  const commit = options.loopDeps.commitChanges
  options.loopDeps.commitChanges = async (input) => { const result = await commit(input); if (result.status === 'green') committed = true; return result }
  const rebase = options.loopDeps.rebaseBranch
  options.loopDeps.rebaseBranch = async (input) => { const result = await rebase(input); if (result.status === 'green') { baseOid = result.onto; if (committed) rebasedHead = result.head } return result }
  const sessionOf = (role, n) => join(spec.taskDir, 'lean', role, `lane.${role}.${n}.jsonl`)
  return { spec, requests, logs, go: () => runLean(spec, options), sessionOf, options }
}
// MUTATION: leave the section out of the suite-repair prompt.
test('with builderChecks set, the build and suite-repair builder prompts hold every entry verbatim and planner and reviewer prompts hold none', async () => {
  let suites = 0
  const f = leanFixture({ loopDeps: { runSuite: async () => ++suites === 1 ? { ...GREEN, status: 'red', code: 1, reason: 'exit-nonzero' } : GREEN } })
  f.spec.builderChecks = ['cargo clippy --all-targets -- -D warnings', 'cargo test -p fence --lib']
  await f.go()
  const builders = f.requests.filter((request) => request.definition.role === 'builder')
  assert.ok(builders.length >= 2)
  assert.ok(builders[1].prompt.includes('The project suite is red after your change: npm test.'))
  for (const { prompt } of builders) {
    assert.ok(prompt.includes('## Project checks'))
    for (const check of f.spec.builderChecks) assert.ok(prompt.includes(`- ${check}\n`))
  }
  for (const role of ['planner', 'reviewer']) {
    const requests = f.requests.filter((request) => request.definition.role === role)
    assert.ok(requests.length > 0)
    for (const { prompt } of requests) {
      assert.ok(!prompt.includes('## Project checks'))
      for (const check of f.spec.builderChecks) assert.ok(!prompt.includes(check))
    }
  }
})

test('lean journals suspension credit for successful and failed seat attempts', async () => {
  for (const kind of ['success', 'failure', 'unknown', 'provider-retry']) {
    const rows = []
    const f = leanFixture({ loopDeps: { journal: async (row) => rows.push(row) }, deps: { sleep: async () => {} } })
    const original = f.options.runAcpSeat
    let attempts = 0
    f.options.runAcpSeat = async (input) => {
      if (input.definition.role === 'planner') {
        attempts++
        if (kind === 'failure' && attempts === 1) throw Object.assign(new Error('closed'), { reason: 'acp-seat-closed', sleep_credited_s: 10 })
        if (kind === 'provider-retry' && attempts === 1) return { stopReason: 'end_turn', sleep_credited_s: 10, refusal: { errorKind: 'overloaded', errorMessage: 'overloaded', message: 'overloaded' } }
        return { ...await original(input), ...(kind === 'unknown' ? { sleep_credited_s: null, sleep_credit_reason: 'clock-unavailable' } : { sleep_credited_s: 20 }) }
      }
      return original(input)
    }
    assert.equal((await f.go()).status, 'done', kind)
    const seats = rows.filter((row) => row.event === 'seat-turn' && row.role === 'planner')
    assert.deepEqual(seats.map((row) => row.sleep_credited_s), kind === 'failure' ? [10, 20] : [kind === 'unknown' ? null : kind === 'provider-retry' ? 30 : 20], kind)
    if (kind === 'unknown') assert.equal(seats[0].sleep_credit_reason, 'clock-unavailable')
  }
})

test('a lean seat turn journals its agent, model, effort, distinct tool calls, stop reason and usage (#2287)', async () => {
  const rows = [], usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 1, totalTokens: 15 }
  const f = leanFixture({ loopDeps: { journal: async (row) => rows.push(row) }, acp: async (input) => {
    const role = input.definition.role
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
    for (const [sessionUpdate, toolCallId] of [['tool_call', 'a'], ['tool_call', 'b'], ['tool_call_update', 'a'], ['tool_call', 'a'], ['tool_call_update', 'c']]) {
      input.deps.appendFileSync(input.sessionFile, `${JSON.stringify({ sessionId: 's', update: { sessionUpdate, toolCallId, title: 'read', kind: 'read', status: 'in_progress', rawInput: { path: 'file' } } })}\n`, 'utf8')
    }
    input.deps.appendFileSync(input.sessionFile, 'not json\n', 'utf8')
    mkdirSync(f.spec.taskDir, { recursive: true })
    if (role === 'planner') writeFileSync(join(f.spec.taskDir, 'plan.md'), '')
    const details = role === 'planner' ? { subject: 'fix(crew): planned', plan_path: 'plan.md', tests: [{ file: 'lib.test.mjs', title: 'works' }], files_in_scope: ['src/a.mjs'] }
      : role === 'builder' ? { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
      : { verdict: 'pass', findings: [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['a'], complete: true } }
    writeFileSync(path, JSON.stringify({ role, id, status: 'done', summary: 'ok', details }))
    return { stopReason: 'end_turn', usage: role === 'reviewer' ? null : usage, ...(role === 'reviewer' ? { usage_reason: 'usage-unavailable' } : {}), refusal: null }
  } })
  assert.equal((await f.go()).status, 'done')
  const planner = rows.find((row) => row.event === 'seat-turn' && row.role === 'planner')
  assert.ok(planner)
  const definition = f.requests.find((request) => request.definition.role === 'planner').definition
  for (const field of ['agent', 'model', 'effort']) assert.equal(planner[field], definition[field])
  assert.equal(planner.tool_calls, 2)
  assert.equal(planner.stop_reason, 'end_turn')
  assert.deepEqual(planner.usage, usage)
  const reviewer = rows.find((row) => row.event === 'seat-turn' && row.role === 'reviewer')
  assert.equal(reviewer.usage, null)
  assert.equal(reviewer.unmeasured.usage, 'usage-unavailable')
})

test('lean journals partial usage from interrupted and refused seats separately from usage', async () => {
  for (const usage_partial of [
    { kind: 'tokens', inputTokens: 13, outputTokens: 7, cachedReadTokens: 2, cachedWriteTokens: 5, totalTokens: 27 },
    { kind: 'context', used: 25474, cost: { amount: 0.114063, currency: 'USD' } },
  ]) {
    for (const mode of ['acp-seat-deadline', 'acp-seat-closed', 'refusal']) {
      const rows = []
      let attempts = 0
      const f = leanFixture({ loopDeps: { journal: async (row) => rows.push(row) }, acp: async () => {
        if (attempts++ > 0) throw new Error('next attempt has no measurements')
        if (mode !== 'refusal') throw Object.assign(new Error(mode), { reason: mode, usage_partial })
        return { stopReason: null, usage: null, usage_partial, refusal: { code: 1, message: 'refused', errorKind: null } }
      } })
      await f.go()
      const turns = rows.filter((row) => row.event === 'seat-turn')
      assert.ok(turns.length >= 2, mode)
      assert.deepEqual(turns[0].usage_partial, usage_partial, mode)
      assert.equal(turns[0].usage, null, mode)
      assert.equal(turns[0].unmeasured.usage, 'turn-failed', mode)
      for (const turn of turns.slice(1)) assert.equal(Object.hasOwn(turn, 'usage_partial'), false, mode)
      if (mode === 'refusal') {
        const recorded = readFileSync(f.requests[0].sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.type === 'turn')
        assert.deepEqual(recorded.usage_partial, usage_partial)
        assert.equal(recorded.usage, null)
      }
    }
  }
})

test('a Muse seat refused at session/new for being logged out stops as authentication_failed with no rerun', async () => {
  const message = 'log in to Muse before opening a session'
  for (const [errorKind, errorMessage, frozen] of [[null, message, false], ['authentication_failed', 'denied', true], ['oauth_org_not_allowed', 'denied', false], ['verification_required', 'denied', false]]) {
    const rows = []
    const f = leanFixture({ acp: async () => {
      const error = Object.assign(new Error(`acp seat planner refused session/new: ${errorMessage} [acp-protocol-mismatch]`), { reason: 'acp-protocol-mismatch', method: 'session/new', errorKind, errorMessage })
      throw frozen ? Object.freeze(error) : error
    }, loopDeps: { journal: async (row) => rows.push(row), resolveAgents: (tier) => {
      const resolved = resolveAgents(tier)
      resolved.seats.planner = { ...resolved.seats.planner, agent: 'muse' }
      return resolved
    } } })
    assert.deepEqual(await f.go(), { status: 'stopped', reason: 'authentication_failed', pr: null })
    assert.equal(f.requests.length, 1)
    const verdicts = rows.filter((row) => row.event === 'verdict')
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0].reason, 'authentication_failed')
    assert.match(verdicts[0].observation.error.message, new RegExp(errorMessage))
  }
  for (const target of ['lead', 'conflict']) {
    const rows = []
    let rebases = 0
    const f = leanFixture({ tier: target === 'conflict' ? 'mechanical' : 'build', answers: target === 'lead' ? { 'builder.2': 'insufficient' } : {}, loopDeps: {
      journal: async (row) => rows.push(row),
      ...(target === 'conflict' ? { rebaseBranch: async () => ++rebases === 1 ? { status: 'green', reason: null, head: 'b'.repeat(40), onto: 'c'.repeat(40) } : { status: 'red', reason: 'rebase-conflict', conflicts: ['file'] } } : {}),
    } })
    if (target === 'conflict') {
      const run = f.options.loopDeps.run
      f.options.loopDeps.run = async (input) => input.args.includes('rev-parse') ? { ...GREEN, stdout: `${'c'.repeat(40)}\n` } : run(input)
    }
    const answered = f.options.runAcpSeat
    f.options.runAcpSeat = async (input) => {
      if (target === 'lead' ? input.definition.role === 'lead' : input.prompt.includes('Rebase ')) {
        throw Object.assign(new Error(message), { method: 'session/new', errorKind: null, errorMessage: message })
      }
      return answered(input)
    }
    assert.equal((await f.go()).reason, 'authentication_failed', target)
    const verdicts = rows.filter((row) => row.event === 'verdict')
    assert.equal(verdicts.length, 1, target)
    assert.match(JSON.stringify(verdicts[0].observation), /log in to Muse/, target)
  }
  const f = leanFixture()
  const answered = f.options.runAcpSeat
  f.options.runAcpSeat = async (input) => {
    const turn = await answered(input)
    if (input.definition.role === 'planner') throw Object.assign(new Error(message), { method: 'session/new', errorKind: null, errorMessage: message })
    return turn
  }
  assert.equal((await f.go()).status, 'done')
})

test("a builder prompt's P2 example names tests only when the lane requires them", async () => {
  for (const [tier, planTests, required, finish] of [
    ['mechanical', undefined, false, false], ['build', [], false, false], ['build', undefined, true, false],
    ['mechanical', undefined, false, true], ['build', [], false, true], ['build', undefined, true, true],
  ]) {
    const f = leanFixture({ tier, planTests, repairBuilder: true })
    if (finish) {
      f.spec.shape = 'finish'
      f.spec.finish = { planPath: tier === 'mechanical' ? null : 'plan.md', subject: 'fix: test', filesInScope: ['src/a.mjs'], testsRequired: required, stop: { reason: 'stopped' }, findings: [], turnOffset: 3 }
      f.options.loopDeps.rebaseBranch = async () => ({ status: 'green', reason: null, head: 'b'.repeat(40), onto: 'c'.repeat(40) })
    }
    await f.go()
    const prompts = f.requests.filter((r) => r.definition.role === 'builder').map((r) => r.prompt)
    assert.equal(prompts.length, 2)
    for (const prompt of prompts) {
      const example = JSON.parse(prompt.slice(prompt.lastIndexOf('{\n  "role"'), prompt.lastIndexOf('}') + 1))
      assert.equal(Object.hasOwn(example.details, 'tests'), required)
      if (required) assert.deepEqual(example.details.tests, [{ file: '<repo-relative test file>', title: '<exact test title>' }])
      assert.deepEqual(validateEnvelope('builder', example).defects, [])
    }
  }
})

test('a judge tech-lead turn gets the reviewer map grants by scope, the builder report, the changed paths and a valid P2 tech-lead example', async () => {
  const f = leanFixture({ tier: 'judge', scope: ['crew/lean.mjs', 'elsewhere/a.spec.ts'] })
  assert.equal((await f.go()).status, 'done')
  const leads = f.requests.filter((r) => r.definition.role === 'tech-lead')
  assert.equal(leads.length, 1)
  const lead = leads[0], reviewer = f.requests.find((r) => r.definition.role === 'reviewer')
  assert.deepEqual([...lead.definition.skills].sort(), [...reviewer.definition.skills].sort())
  for (const skill of ['pr-review', 'test-strength']) assert.ok(lead.definition.skills.includes(skill))
  assert.match(lead.prompt, /## Builder report\nTests: \[{"file":"lib.test.mjs","title":"works"}\]\nNotes: "builder turn 2"/)
  assert.match(lead.prompt, /## Changed paths\n- "src\/a.mjs"/)
  const example = JSON.parse(lead.prompt.split(`Task directory: ${f.spec.taskDir}\n`)[1].split('\nstatus is done')[0])
  assert.deepEqual(validateEnvelope('tech-lead', example).defects, [])
})

const terminal = (logs) => logs.map((line) => JSON.parse(line)).filter((row) => row.event === 'loop-result')

test('a thrown loop and a failing journal reach the result and the loop-result line with their described errors', async () => {
  const command = ' notify \t --flag ; $(literal) "two words" '
  for (const [mode, config, execution, journalFails] of [
    ['throw', 'configured', GREEN],
    ['journal', 'configured', GREEN],
    ['stop', 'configured', GREEN],
    ['pr', 'configured', GREEN],
    ['finish-ready', 'configured', GREEN],
    ['throw', 'absent'],
    ['throw', '{}'],
    ...['{', 'null', '[]', '{"runEndCommand":null}', '{"runEndCommand":3}', '{"runEndCommand":"  "}', JSON.stringify({ runEndCommand: 'bad\0command' }), 'unreadable'].map((config) => ['throw', config]),
    ['throw', 'configured', { ...GREEN, status: 'red', reason: 'exit-nonzero', code: 9, stdout: 'discard output', stderr: 'discard error' }],
    ['throw', 'configured', { ...GREEN, status: 'unmeasured', reason: 'timeout', code: null, signal: 'SIGKILL', timedOut: true }],
    ['throw', 'configured', { ...GREEN, status: 'unmeasured', reason: 'spawn-error', code: null }],
    ['throw', 'configured', { ...GREEN, status: 'unmeasured', reason: 'output-limit', code: null, stdout: 'discard output' }],
    ['throw', 'configured', 'throws'],
    ['throw', 'configured', null],
    ['throw', 'configured', GREEN, true],
  ]) {
    const f = leanFixture({
      tier: mode === 'finish-ready' ? 'mechanical' : 'build',
      status: mode === 'finish-ready' ? ['', 'M  src/a.mjs\0'] : 'M  src/a.mjs\0',
      loopDeps: mode === 'journal' ? { journal: async () => { throw EPERM } }
        : mode === 'stop' ? { openPullRequest: async () => ({ ...GREEN, status: 'unmeasured', reason: 'spawn-error', code: null }) } : {},
    })
    if (mode === 'throw') f.options.loopDeps = Object.defineProperty({}, 'run', { enumerable: true, get() { throw EPERM } })
    if (mode === 'finish-ready') Object.assign(f.spec, { shape: 'finish', finish: { subject: 'fix(crew): finish', planPath: null, findings: [], stop: { reason: 'seat-unmeasured' }, turnOffset: 0 } })
    f.spec.cwd = join(f.spec.cwd, 'checkout $literal; space')
    mkdirSync(join(f.spec.cwd, '.crew'), { recursive: true })
    for (const name of ['settings.json', 'project.json']) writeFileSync(join(f.spec.cwd, '.crew', name), JSON.stringify({ runEndCommand: 'project-unsafe' }))
    f.spec.runEndCommand = 'lane-unsafe'
    const calls = [], rows = [], reads = []
    const { crewRoot } = f.options.runEndCommandDeps
    mkdirSync(crewRoot, { recursive: true })
    if (config !== 'absent' && config !== 'unreadable') writeFileSync(join(crewRoot, 'settings.json'), config === 'configured' ? JSON.stringify({ runEndCommand: command }) : config)
    Object.assign(f.options.runEndCommandDeps, {
      readFileSync: (path, ...args) => { reads.push(path); if (config === 'unreadable') throw EPERM; return readFileSync(path, ...args) },
      run: async (input) => { calls.push(input); if (execution === 'throws') throw EPERM; return execution },
      journal: async (row) => { rows.push(row); if (journalFails) throw EPERM },
      now: () => 1234,
    })
    const result = await f.go()
    // Check dispatch before reading any new row: this fails in its own body on old source.
    assert.equal(calls.length, config === 'configured' ? 1 : 0, `${mode}/${config}`)
    if (mode === 'throw') assert.deepEqual(result, { status: 'stopped', reason: 'runner-threw', pr: null, error: { code: 'EPERM', message: 'denied' } })
    else if (mode === 'journal') { assert.ok(result.journal.unwritten > 0); assert.deepEqual(result.journal.error, { code: 'EPERM', message: 'denied' }) }
    else if (mode === 'stop') { assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'spawn-error') }
    else assert.deepEqual(result, { status: 'done', reason: null, pr: mode === 'pr' ? { number: 7, url: 'https://example.test/7' } : null })
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
    assert.equal(f.logs.length, 1)
    assert.deepEqual(reads, [join(crewRoot, 'settings.json')])
    if (config === 'absent' || config === '{}') { assert.deepEqual(rows, []); continue }
    const ending = result.status === 'stopped' ? 'stopped' : result.pr ? 'pr' : 'finish-ready'
    const payload = ending === 'stopped' ? result.reason : ending === 'pr' ? result.pr.url : 'finish-ready'
    if (config === 'configured') assert.deepEqual(calls, [{ cwd: f.spec.cwd, command: 'notify', args: ['--flag', ';', '$(literal)', '"two', 'words"', 'lane', ending, payload, f.spec.cwd], timeoutMs: 5000 }])
    const measured = execution && typeof execution === 'object' ? execution : null
    const configured = config === 'configured' ? command : config.startsWith('{"runEndCommand"') ? JSON.parse(config).runEndCommand : null
    const reason = config === 'unreadable' ? 'settings-unreadable'
      : config !== 'configured' ? (config.startsWith('{"runEndCommand"') ? 'invalid-command' : 'invalid-settings')
        : measured ? measured.reason : 'runner-threw'
    assert.deepEqual(rows, [{
      event: 'run-end-command', lane: 'lane', ending, payload,
      command: typeof configured === 'string' ? configured : null,
      at: 1234, status: measured?.status ?? 'unmeasured', reason,
      code: measured?.code ?? null, signal: measured?.signal ?? null, timedOut: measured?.timedOut ?? null,
    }])
  }
})

test('a moved-head recheck prompt scopes the reviewer and the tech-lead to what the rebase changed, with no full review (#2359)', async () => {
  const R = 'a'.repeat(40), O = 'c'.repeat(40), H = 'd'.repeat(40)
  const heads = ['b'.repeat(40), H, R]
  const f = leanFixture({ tier: 'judge', loopDeps: { rebaseBranch: async () => ({ status: 'green', reason: null, head: heads.shift(), onto: O }) } })
  const run = f.options.loopDeps.run
  f.options.loopDeps.run = async (input) => input.args.includes('write-tree') ? { ...GREEN, stdout: `${String(heads.length).repeat(40)}\n` } : run(input)
  await f.go()
  const reviewers = f.requests.filter((r) => r.definition.role === 'reviewer').map((r) => r.prompt)
  const leads = f.requests.filter((r) => r.definition.role === 'tech-lead').map((r) => r.prompt)
  assert.equal(reviewers.length, 2)
  assert.equal(leads.length, 2)
  assert.match(reviewers[0], /^## Full review$/m)
  assert.doesNotMatch(reviewers[0], /^## Recheck review$/m)
  for (const prompt of [reviewers[1], leads[1]]) {
    assert.match(prompt, /^## Recheck review$/m)
    assert.doesNotMatch(prompt, /^## Full review$/m)
    for (const command of [`git diff ${R}^ ${R}`, `git diff ${O} ${H}`, `git diff ${R}^ ${O}`]) {
      assert.ok(prompt.includes(command))
      assert.ok(readOnlyCommand(command), command)
    }
    assert.ok(prompt.includes("A must-fix is an earlier finding still unresolved, a defect in lane code the rebase or the conflict turn altered, or a defect where the base's new commits meet the lane's change. A new problem elsewhere in the already-reviewed diff is a should-fix."))
  }
})

// MUTATION: remove reviewer from the laneRole predicate.
test('LG2: reviewer gets scope grants rather than changed-path grants', async () => {
  for (const tier of ['build', 'judge']) for (const [scope, extra] of [
    [['crew/lean.mjs'], ['backend-node']],
    [['visualizer/a.svelte'], ['frontend-svelte', 'ui-design', 'ux']],
    [['other/a.ts'], []],
    [['elsewhere/a.spec.ts'], ['test-strength']],
  ]) {
    const f = leanFixture({ tier, scope, repairPlan: true, status: 'M  crew/other.mjs\0', answers: { reviews: ['changes-needed', 'pass'] } })
    assert.equal((await f.go()).status, 'done')
    for (const { definition } of f.requests.filter((r) => r.definition.role === 'reviewer')) {
      assert.deepEqual(definition.skills, ['code-less', 'pr-review', ...extra])
      assert.deepEqual(definition.requires, [])
    }
  }
})

const memoryDefinition = (line) => (path, ...args) => {
  const text = readFileSync(path, ...args)
  // The shipped definition's own memory field is removed first, so each case states the whole effective value.
  return path === join(AGENTS, 'planner.md') ? text.replace(/^memory: .*\n/m, '').replace(/tiers: .*/, line) : text
}
const populateMemory = (dir, body) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '- [entry](entry.md)\n')
  writeFileSync(join(dir, 'entry.md'), body)
}

// MUTATION: drop `memory: true` from crew/agents/planner.md and the shipped planner boots without team memory.
test('the shipped planner definition injects the lane checkout memory', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    delete process.env.CREW_MEMORY_DIR
    const f = leanFixture()
    populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'shipped judgment')
    assert.equal((await f.go()).status, 'done')
    assert.match(f.requests[0].prompt, /## Team memory[\s\S]*shipped judgment/)
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

test('a memory-empty row lists at most ten dropped entries and counts the rest (#2341)', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    const rows = []
    const f = leanFixture({ deps: { readFileSync: memoryDefinition('memory: true\ntiers: {}') }, loopDeps: { journal: async (row) => rows.push(row) } })
    process.env.CREW_MEMORY_DIR = join(f.spec.cwd, 'override')
    mkdirSync(process.env.CREW_MEMORY_DIR, { recursive: true })
    const names = Array.from({ length: 15 }, (_, i) => `entry-${i}.md`)
    for (const name of names) writeFileSync(join(process.env.CREW_MEMORY_DIR, name), 'entry')
    writeFileSync(join(process.env.CREW_MEMORY_DIR, 'MEMORY.md'), `${names.map((name) => `- [entry](${name})`).join('\n')}\n${'x'.repeat(8000)}`)
    assert.equal((await f.go()).status, 'done')
    const event = rows.find((row) => row.event === 'memory-empty')
    assert.equal(event.dropped.length, 10)
    assert.equal(event.dropped_omitted, 6)
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

test('concurrent muse reviews ignore sibling sessions but still refuse other lean record writes (#2425)', async () => {
  for (const role of ['reviewer', 'tech-lead']) for (const first of ['reviewer', 'tech-lead']) for (const tamper of ['none', 'prior', 'sibling']) {
    const f = leanFixture({ tier: 'judge', loopDeps: { resolveAgents: (tier) => {
      const resolved = resolveAgents(tier)
      resolved.seats[role] = { ...resolved.seats[role], agent: 'muse', provider: 'meta', id: 'muse-wonder-1.0-contributor' }
      return resolved
    } } })
    const prior = join(f.spec.taskDir, 'lean', 'planner', 'prior.jsonl')
    mkdirSync(join(prior, '..'), { recursive: true })
    writeFileSync(prior, 'prior')
    const gates = Object.fromEntries(['reviewer', 'tech-lead'].map((seat) => [seat, Promise.withResolvers()]))
    const started = Object.fromEntries(['reviewer', 'tech-lead'].map((seat) => [seat, Promise.withResolvers()]))
    const answered = f.options.runAcpSeat
    f.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (gates[input.definition.role]) {
        started[input.definition.role].resolve()
        await gates[input.definition.role].promise
      }
      return turn
    }
    const pending = f.go()
    try {
      await Promise.race([Promise.all(Object.values(started).map((signal) => signal.promise)), pending.then((result) => assert.fail(JSON.stringify(result)))])
      const muse = f.requests.find((input) => input.definition.role === role)
      const sibling = f.requests.find((input) => input.definition.role === (role === 'reviewer' ? 'tech-lead' : 'reviewer'))
      assert.ok(muse)
      assert.ok(sibling)
      sibling.deps.appendFileSync(sibling.sessionFile, `${JSON.stringify({ type: 'sibling-update' })}\n`, 'utf8')
      if (tamper === 'prior') writeFileSync(prior, 'forged')
      if (tamper === 'sibling') appendFileSyncReal(sibling.sessionFile, 'forged\n')
      gates[first].resolve()
      await new Promise(setImmediate)
    } finally {
      for (const gate of Object.values(gates)) gate.resolve()
      await pending
    }
    const result = await pending
    assert.equal(result.status, tamper !== 'none' ? 'stopped' : 'done', `${role}/${first}/${tamper}`)
    if (tamper !== 'none') assert.equal(result.reason, 'seat-unmeasured')
    const checkedRole = tamper === 'sibling' ? (role === 'reviewer' ? 'tech-lead' : 'reviewer') : role
    const checked = f.requests.find((input) => input.definition.role === checkedRole)
    const returnPath = /^Return path: (.+)$/m.exec(checked.prompt)[1]
    assert.equal(existsSync(returnPath), tamper === 'none')
  }
})

test('a muse planner whose lean records cannot be read before or after its turn stops seat-unmeasured with no return', async () => {
  for (const [failAt, deletionFails] of [[1, false], [2, false], [2, true]]) {
    let calls = 0
    const f = leanFixture({ deps: { recordState: () => ++calls === failAt ? null : 'measured', ...(deletionFails ? { rmSync: () => { throw EPERM } } : {}) }, loopDeps: { resolveAgents: (tier) => {
      const resolved = resolveAgents(tier)
      resolved.seats.planner = { ...resolved.seats.planner, agent: 'muse', provider: 'meta', id: 'muse-wonder-1.0-contributor' }
      return resolved
    } } })
    mkdirSync(f.spec.taskDir, { recursive: true })
    writeFileSync(join(f.spec.taskDir, 'planner-1.json'), 'unearned')
    assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null }, String(failAt))
    assert.equal(existsSync(join(f.spec.taskDir, 'planner-1.json')), deletionFails, String(failAt))
    assert.equal(f.requests.length, failAt - 1)
  }
})

test('a build-lane planner bounce after builder edits replans through a real muse seat, and a replan that edits an already-modified file leaves no return', async () => {
  for (const edit of [false, true]) {
    const f = leanFixture({ answers: { 'builder.2': 'insufficient' } })
    try {
      git(f.spec.cwd, 'init')
      mkdirSync(join(f.spec.cwd, 'src'))
      writeFileSync(join(f.spec.cwd, 'src/a.mjs'), 'base')
      git(f.spec.cwd, 'add', '.')
      git(f.spec.cwd, 'commit', '-m', 'base')
      const answered = f.options.runAcpSeat
      const plannerReturns = []
      f.options.runAcpSeat = async (input) => {
        const role = input.definition.role
        if (role === 'builder') writeFileSync(join(f.spec.cwd, 'src/a.mjs'), 'builder edit')
        if (role === 'planner') {
          plannerReturns.push(/^Return path: (.+)$/m.exec(input.prompt)[1])
          const client = { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1,
            pollPrompt: () => {
              answered(input)
              if (edit && plannerReturns.length === 2) writeFileSync(join(f.spec.cwd, 'src/a.mjs'), 'planner edit')
              return { stopReason: 'end_turn' }
            }, close: () => ({ outcome: 'proven' }) }
          return runAcpSeat({ ...input, definition: { ...input.definition, agent: 'muse', model: 'meta/muse-wonder-1.0' },
            binaries: { muse: process.execPath }, deps: { ...input.deps, clientFactory: () => client } })
        }
        const turn = await answered(input)
        if (role === 'lead' || role === 'builder') {
          const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
          const value = JSON.parse(readFileSync(path, 'utf8'))
          if (role === 'lead') value.details = { decision: 'bounce', target: 'planner' }
          else if (value.status === 'insufficient') value.details.gap = 'The plan needs revision'
          writeFileSync(path, JSON.stringify(value))
        }
        return turn
      }
      const result = await f.go()
      if (edit) {
        assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
        assert.equal(existsSync(plannerReturns[1]), false)
      } else assert.equal(result.status, 'done')
      assert.equal(plannerReturns.length, 2)
    } finally { rmSync(join(f.spec.cwd, '..'), { recursive: true, force: true }) }
  }
})

// One planner turn whose ACP result is `turn`; a present return file is written first so a read of it would be visible.
async function oneTurn(turn, { withFile = true, deps = {} } = {}) {
  let reads = 0
  const verdicts = []
  const f = leanFixture({
    acp: async (input) => {
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk' } } })}\n`, 'utf8') } catch {}
      if (withFile) {
        mkdirSync(f.spec.taskDir, { recursive: true })
        writeFileSync(path, JSON.stringify({ role: 'planner', id, status: 'done', summary: 'x', details: { subject: 'fix(crew): publish measured lane results', plan_path: 'p' } }))
      }
      return turn
    },
    deps,
    loopDeps: {
      readFile: async (...args) => { reads++; return readFileSync(...args) },
      journal: async (row) => { if (row.event === 'verdict') verdicts.push(row) },
    },
  })
  const result = await f.go()
  const rows = readFileSync(f.sessionOf('planner', 1), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { f, result, reads: () => reads, verdicts, rows }
}

// MUTATION: drop the missing-stop-reason clause and a turn that never measured a stop is accepted on its envelope.
test('an ACP turn with no stop reason (null, empty, absent, no turn at all) is read and rerun once', async () => {
  for (const turn of [{ stopReason: null, usage: null, refusal: null }, { stopReason: '', usage: null, refusal: null }, { usage: null, refusal: null }, undefined, null]) {
    const run = await oneTurn(turn)
    const label = JSON.stringify(turn) ?? 'undefined'
    assert.deepEqual(run.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, label)
    assert.ok(run.reads() > 0, label)
    assert.equal(run.f.requests.length, 2, label)
    assert.deepEqual(run.verdicts[0].observation.error, { code: null, message: 'ACP seat turn returned no stop reason' }, label)
    assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason: turn?.stopReason ?? null, usage: null, refusal: null }, label)
  }
})

// A planner whose first `refusals.length` turns are refused, then accepted; the clock and the wait are virtual.
async function retryRun(refusals, { oversleep = 0 } = {}) {
  const sleeps = [], sessions = []
  let clock = Date.parse('2026-10-26T00:00:00Z'), turns = 0
  const f = leanFixture({
    acp: async (input) => {
      sessions.push(input.sessionFile)
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      const wanted = input.definition.role === 'planner' ? refusals[turns++] : undefined
      const refusal = typeof wanted === 'function' ? wanted(clock) : wanted
      if (refusal) return { stopReason: null, usage: null, refusal }
      mkdirSync(f.spec.taskDir, { recursive: true })
      if (input.definition.role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(f.spec.taskDir, name), '')
      const details = input.definition.role === 'planner' ? { subject: 'fix(crew): publish measured lane results', tests: [{ file: 'lib.test.mjs', title: 'works' }], plan_path: 'plan.md', files_in_scope: ['src/a.mjs'] }
        : input.definition.role === 'builder' ? { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }] } : { verdict: 'pass', findings: [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['a'], complete: true } }
      writeFileSync(path, JSON.stringify({ role: input.definition.role, id, status: 'done', summary: 'x', details }))
      return { stopReason: 'end_turn', usage: { input_tokens: 1 }, refusal: null }
    },
    deps: { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms + oversleep } },
  })
  const result = await f.go()
  return { f, result, sleeps, sessions }
}
const rateLimit = (at, hours) => {
  const d = new Date(at + hours * 3600000)
  const h = d.getUTCHours()
  return { code: -32000, errorKind: 'rate_limit', message: `resets ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} (UTC)` }
}

test('pi overload and WebSocket failures retry in a fresh session; unknown and resetless usage limit do not retry', async () => {
  const refusal = (errorMessage) => ({ code: -32000, errorKind: 'pi-agent-error', message: 'pi agent run failed', errorMessage })
  for (const message of ['Codex error: Our servers are currently overloaded. Please try again later.', 'WebSocket error', 'WebSocket idle timeout after 300000ms']) {
    const run = await retryRun([refusal(message)])
    assert.equal(run.result.status, 'done')
    assert.deepEqual(run.sleeps, [60_000])
    assert.equal(run.sessions.length, 4)
    assert.equal(new Set(run.sessions).size, 4)
    assert.equal(run.sessions[1], run.f.sessionOf('planner', 1).replace('.jsonl', '.retry-1.jsonl'))
  }
  for (const message of ['Operation aborted', 'unrecognised', 'Codex error: The usage limit has been reached']) {
    const stopped = await retryRun([refusal(message)])
    assert.equal(stopped.result.status, message.includes('usage limit') ? 'stopped' : 'done')
    assert.deepEqual([stopped.sleeps.length, stopped.sessions.length], [0, message.includes('usage limit') ? 1 : 4])
  }
})

test('a retry never runs past the total wait: a reset beyond it, repeated resets, and an oversleep stop the lane', async () => {
  const at = Date.parse('2026-10-26T00:00:00Z')
  const far = await retryRun([rateLimit(at, 6)])
  assert.equal(far.result.reason, 'seat-unmeasured')
  assert.deepEqual([far.sleeps.length, far.sessions.length], [0, 1])
  const repeated = await retryRun(Array(4).fill((now) => rateLimit(now, 2)))
  assert.equal(repeated.result.reason, 'seat-unmeasured')
  assert.equal(repeated.sleeps.length, 2)
  assert.ok(repeated.sleeps.reduce((a, b) => a + b, 0) <= PROVIDER_RETRY_TOTAL_WAIT_MS)
  const overslept = await retryRun([{ code: -32000, errorKind: 'server_error', message: 'boom' }], { oversleep: PROVIDER_RETRY_TOTAL_WAIT_MS })
  assert.equal(overslept.result.reason, 'seat-unmeasured')
  assert.deepEqual([overslept.sleeps.length, overslept.sessions.length], [1, 1])
})

// MUTATION: take the effort from the file's base fields and a tier override never reaches the seat.
test('a seat turn runs the recorded override and keeps the definition\'s other fields', async () => {
  const advisor = { agent: 'pi', model: 'local/advisor', effort: 'low' }
  const f = leanFixture({ tier: 'mechanical', answers: { 'builder.1': 'escalate' } })
  f.spec.roster = { overrides: { builder: { tiers: { mechanical: { advisor } } }, lead: { tiers: { mechanical: {} } } }, files: [] }
  await f.go()
  const builder = f.requests.find((r) => r.definition.role === 'builder').definition
  const parsed = parseAgent(readFileSync(join(AGENTS, 'builder.md'), 'utf8'))
  assert.deepEqual(builder.advisor, advisor)
  assert.deepEqual(builder.extensions, parsed.fields.tiers.mechanical.extensions)
  assert.equal(builder.writes, parsed.fields.writes)
  assert.equal(builder.body, parsed.body)
  assert.ok(parsed.fields.skills.every((skill) => builder.skills.includes(skill)))
  assert.ok(f.requests.some((r) => r.definition.role === 'lead'))

  const lane = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: lane.deps })
  const recorded = JSON.parse(written(lane.calls, '/task/lean.json')[2]).roster
  const changed = leanFixture({ deps: { readFileSync: (path, ...args) => {
    const text = readFileSync(path, ...args)
    return String(path) === join(AGENTS, 'builder.md') ? text.replace('advisor: {"agent":"pi","model":"openai/gpt-6.1-sol","effort":"medium"}', 'advisor: null').replace('extensions: [fff, readgate, skeletonread]', 'extensions: [fff]') : text
  } } })
  changed.spec.roster = recorded
  await changed.go()
  const definition = changed.requests.find((r) => r.definition.role === 'builder').definition
  assert.deepEqual(definition.advisor, recorded.snapshot.builder.tiers.build.advisor)
  assert.deepEqual(definition.extensions, ['fff'])
})

test('a tier override applies and an unseating override refuses the turn', async () => {
  const mechanical = leanFixture({ tier: 'mechanical' })
  assert.equal((await mechanical.go()).status, 'done')
  assert.equal(mechanical.requests[0].definition.advisor, null)
  const seat = resolveAgents('build').seats.lead
  const unseated = leanFixture({ tier: 'mechanical', answers: { 'builder.1': 'escalate' }, loopDeps: { resolveAgents: (tier) => ({ ...resolveAgents(tier), seats: { ...resolveAgents(tier).seats, lead: seat } }) } })
  const result = await unseated.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'lead-refused', pr: null })
  assert.deepEqual(unseated.requests.map((r) => r.definition.role), ['builder'])
})

// MUTATION: let a failed permission-row append pass and a decision the lane cannot replay goes unseen.
test('a permission row whose append fails stops the turn like any other recording failure', async () => {
  const acp = async (input) => {
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const row = { kind: 'permission', role: input.definition.role, writes: input.definition.writes, sessionId: 's', tool_call_id: 't', tool: 'edit', title: 'write', option: 'deny', option_kind: 'reject_once' }
    try { input.deps.appendFileSync(input.sessionFile, `${JSON.stringify(row)}\n`, 'utf8') } catch {}
    assert.ok(id)
  }
  const f = leanFixture({ acp, deps: { appendFileSync: (path, text, ...rest) => { if (text.includes('"kind":"permission"')) throw EPERM; return appendFileSyncReal(path, text, ...rest) } } })
  assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(f.requests.length, 2)
})

// MUTATION: launch the loop on an unreadable spec and a seat starts with no input.
test('the bridge entry reads one spec file; a malformed or unreadable spec is one invalid-input row and no seat', async () => {
  const dir = scratchDir('lean-main-')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"id":')
  const rows = []
  const acp = async () => { throw new Error('a seat was launched') }
  for (const path of [bad, join(dir, 'missing.json')]) {
    assert.equal(await leanMain([path], { log: (line) => rows.push(line), runAcpSeat: acp }), 1)
  }
  assert.deepEqual(rows.map((row) => JSON.parse(row)), Array(2).fill({ event: 'loop-result', status: 'stopped', reason: 'invalid-input', pr: null }))
  assert.equal(await leanMain([], { log: () => {} }), 2)
  assert.equal(await leanMain([bad, bad], { log: () => {} }), 2)
  const good = leanFixture()
  const specPath = join(dir, 'spec.json')
  writeFileSync(specPath, JSON.stringify(good.spec))
  assert.equal(await leanMain([specPath], good.options), 0)
  assert.equal(existsSync(good.sessionOf('planner', 1)), true)
  const stoppedRows = []
  const failing = leanFixture({ loopDeps: { run: async ({ args }) => { if (args.includes('status')) throw EPERM; return { ...GREEN, stdout: args.includes('rev-parse') ? 'c'.repeat(40) : '' } } } })
  const failingPath = join(dir, 'failing.json')
  writeFileSync(failingPath, JSON.stringify(failing.spec))
  assert.equal(await leanMain([failingPath], { ...failing.options, log: (line) => stoppedRows.push(line) }), 1)
  assert.equal(JSON.parse(stoppedRows.at(-1)).reason, 'paths-unmeasured')
})

test('importing the bridge launches nothing', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(LEAN).href)})`], { encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, '')
})
