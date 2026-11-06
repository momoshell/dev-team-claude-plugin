import { test } from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs, { appendFileSync as appendFileSyncReal, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { laneName, main, runBrief, startLane, StartRefusal } from './start.mjs'
import { main as leanMain, runLean } from './lean.mjs'
import { runAcpSeat } from './acp/seat.mjs'
import { parseAgent, TIERS, validateEnvelope } from './protocols.mjs'
import { resolveAgents } from './agents.mjs'
import { PROVIDER_RESET_SETTLE_MS, PROVIDER_RETRY_MAX, PROVIDER_RETRY_TOTAL_WAIT_MS } from './acp/provider.mjs'
import { git, scratchDir } from '../test/helpers.mjs'

test('an existing crew lane directory is refused before any worktree is made', async () => {
  const { deps, calls } = fakes({ exists: (path) => path === '/home/.crew/dt-b1/b1' })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /\/home\/\.crew\/dt-b1\/b1/)
  assert.deepEqual(effects(calls), [])
})

test('a failed detached launch is a StartRefusal that names the left worktree', async () => {
  for (const result of [null, 0, -1, 1.5, new Error('spawn')]) {
    const { deps } = fakes()
    deps.spawnDetached = () => { if (result instanceof Error) throw result; return result }
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), (e) => e instanceof StartRefusal && e.message.includes('/repo/dt-b1') && e.message.includes('branch b1'))
  }
})

test('a started lane records its run pid, and a failed pid write only logs', async () => {
  for (const fail of [false, true]) {
    const { deps, calls } = fakes({ write: (kind, path) => { if (fail && path.endsWith('/run.pid')) throw new Error('disk') } })
    const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
    assert.equal(result.pid, 4242)
    assert.equal(written(calls, '/task/run.pid')?.[2], '4242\n')
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

function fakes({ brief = BRIEF, project = projectFile(), exists = () => false, worktreeStatus = 0, originHead = 'origin/main', inGit = true, issueBody = 'Refuse roster edits that cannot boot.\n', issueTitle = 'Refuse roster edits', resolve = (tier) => resolveAgents(tier), write = () => {} } = {}) {
  const calls = []
  const deps = {
    readFileSync: (path) => {
      if (!path.endsWith('/.crew/project.json')) return brief
      if (project === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return typeof project === 'string' ? project : JSON.stringify(project)
    },
    resolveAgents: resolve,
    existsSync: (path) => exists(path),
    mkdirSync: (path) => { calls.push(['mkdir', path]); write('mkdir', path) },
    writeFileSync: (path, text) => { calls.push(['write', path, text]); write('write', path, text) },
    spawnSync: (file, args, options) => {
      calls.push(['spawn', file, args, options?.cwd ?? null])
      if (file === 'gh') {
        const value = args.at(-1) === '.title' ? issueTitle : issueBody
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
  for (const check of [true, false]) {
    let resolutions = 0
    const { deps, calls } = fakes({ brief, resolve: () => { resolutions++; return { seats: {} } } })
    deps.transcriptRoot = root
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps }), (error) => error instanceof StartRefusal && error.message === expected)
    assert.equal(resolutions, 0)
    assert.deepEqual(effects(calls), [])
  }
  const pass = fakes({ brief: brief.replace(`${excluded.map((line) => `> ${line}`).join('\n\n')}\n\n`, '') })
  pass.deps.transcriptRoot = root
  assert.equal((await startLane({ briefPath: '/d/b1.md', check: true, deps: pass.deps })).checked, true)
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
  for (const check of [true, false]) {
    let resolutions = 0
    const fail = fakes({ brief: makeBrief(excluded.map((text) => `> ${text}`).join('\n\n')), resolve: () => { resolutions++; return { seats: {} } } })
    fail.deps.transcriptRoot = root
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: fail.deps }), (error) => error instanceof StartRefusal && excluded.every((text) => error.message.includes(JSON.stringify(text))))
    assert.equal(resolutions, 0)
    assert.deepEqual(effects(fail.calls), [])
    const pass = fakes({ brief: makeBrief('> whole queued message') })
    pass.deps.transcriptRoot = root
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: pass.deps }))
    assert.equal(pass.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured')), false)
  }
  appendFileSyncReal(path, `\n${JSON.stringify(row('whole typed message', 'typed'))}`)
  const both = fakes({ brief: makeBrief('> whole queued message\n\n> whole typed message') })
  both.deps.transcriptRoot = root
  assert.equal((await startLane({ briefPath: '/d/b1.md', check: true, deps: both.deps })).checked, true)
})

test('crew start strips pasted content from queued messages and still refuses the pasted text itself (ADR-056)', async () => {
  const root = scratchDir('provenance-queued-paste-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.jsonl'), JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'queued', message: { content: 'before <pasted_content id="p1">pasted words</pasted_content id="p1"> after' } }))
  const makeBrief = (ask) => BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', `## The ask\n\n> ${ask}\n\n## Context`)
  for (const check of [true, false]) {
    const fail = fakes({ brief: makeBrief('pasted words') })
    fail.deps.transcriptRoot = root
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: fail.deps }), (error) => error instanceof StartRefusal && error.message.includes('"pasted words"'))
    assert.deepEqual(effects(fail.calls), [])
    const pass = fakes({ brief: makeBrief('before after') })
    pass.deps.transcriptRoot = root
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: pass.deps }))
    assert.equal(pass.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured')), false)
  }
})

test('crew start reports ask provenance unmeasured for a malformed queued transcript row and starts (ADR-056)', async () => {
  const root = scratchDir('provenance-queued-malformed-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  const path = join(dir, 'a.jsonl')
  const brief = BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', '## The ask\n\n> Do this.\n\n## Context')
  for (const readable of [false, true]) {
    writeFileSync(path, `${readable ? `${JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content: 'Unrelated words.' } })}\n` : ''}{"promptSource":"queued",`)
    for (const check of [true, false]) {
      const operator = fakes({ brief })
      operator.deps.transcriptRoot = root
      await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: operator.deps }))
      assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes(`crew start: ask provenance unmeasured: incomplete Claude Code transcript scan under ${root}`)))
      assert.equal(effects(operator.calls).length > 0, !check)
    }
  }
})

test('crew start refuses a ## Context path missing on the base before the worktree (ADR-056 Amendment 1)', async () => {
  for (const status of [128, 1, null]) {
    const missing = fakes({ brief: BRIEF.replace('`crew/agents.mjs`', '`crew/missing.mjs`') })
    const spawnSync = missing.deps.spawnSync
    missing.deps.spawnSync = (file, args, options) => {
      const result = spawnSync(file, args, options)
      return file === 'git' && args.includes('main:crew/missing.mjs') ? { status } : result
    }
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: missing.deps }), (error) => error instanceof StartRefusal && error.message.includes('could not verify') && error.message.includes('main') && error.message.includes('crew/missing.mjs'))
    assert.equal(missing.calls.some(([kind, file, args]) => kind === 'spawn' && (file === 'gh' || args.includes('worktree'))), false)
  }

  const pass = fakes({ brief: BRIEF.replace('`crew/agents.mjs`', '`crew/agents.mjs` `resolveAgents`\n- `crew/`') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: pass.deps })
  const checks = pass.calls.filter(([kind, file, args]) => kind === 'spawn' && file === 'git' && args.includes('cat-file')).map(([, , args]) => args.at(-1))
  assert.deepEqual(checks, ['main:crew/agents.mjs', 'main:crew'])

  const repo = scratchDir('context-base-')
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com']]) {
    assert.equal(spawnSync('git', args, { cwd: repo }).status, 0)
  }
  writeFileSync(join(repo, 'tracked'), 'base')
  mkdirSync(join(repo, '.crew'))
  writeFileSync(join(repo, '.crew', 'project.json'), JSON.stringify(projectFile()))
  fs.symlinkSync('/outside/notes.md', join(repo, 'notes.md'))
  fs.symlinkSync('/outside', join(repo, 'linked-dir'))
  for (const args of [['add', '.'], ['commit', '-m', 'base']]) assert.equal(spawnSync('git', args, { cwd: repo }).status, 0)
  writeFileSync(join(repo, 'remote-only'), 'remote')
  for (const args of [['add', '.'], ['commit', '-m', 'remote'], ['update-ref', 'refs/remotes/origin/main', 'HEAD'], ['reset', '--hard', 'HEAD^']]) {
    assert.equal(spawnSync('git', args, { cwd: repo }).status, 0)
  }
  for (const path of ['tracked', 'remote-only', 'notes.md', 'linked-dir/file']) {
    const fail = fakes({ brief: BRIEF.replace('`crew/agents.mjs`', `\`${path}\``) })
    const fakeSpawn = fail.deps.spawnSync
    fail.deps.spawnSync = (file, args, options) => {
      const result = fakeSpawn(file, args, options)
      return file === 'git' && !args.includes('symbolic-ref') && !args.includes('worktree') ? spawnSync(file, args, { encoding: 'utf8' }) : result
    }
    if (path === 'tracked') await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: repo, deps: fail.deps }))
    else {
      await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: repo, deps: fail.deps }), (error) => error instanceof StartRefusal && error.message.includes(path) && error.message.includes('main'))
      assert.equal(fail.calls.some(([kind, file, args]) => kind === 'spawn' && (file === 'gh' || args.includes('worktree'))), false)
    }
  }
})

test('crew start accepts a quoted ask block only as one whole typed message (ADR-056 Amendment 1)', async () => {
  const root = scratchDir('whole-message-')
  const dir = join(root, 'proj')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.jsonl'), [
    'will this enforce proper briefs now?',
    'yes, all; probably best as followup',
    'see <pasted_content id="p1">x</pasted_content id="p1"> please',
  ].map((content) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content } })).join('\n'))
  const makeBrief = (ask) => BRIEF.replace('source: issue 1961', 'source: operator request').replace('## Context', `## The ask\n\n${ask}\n\n## Context`)
  const good = '> will this enforce proper\n> briefs now?\n\n> yes, all; probably best as followup\n\n> see please'
  for (const check of [true, false]) {
    const pass = fakes({ brief: makeBrief(good) })
    pass.deps.transcriptRoot = root
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: pass.deps }))
    for (const ask of ['> yes', '> will this enforce proper briefs now?\n> yes, all; probably best as followup']) {
      const fail = fakes({ brief: makeBrief(ask) })
      fail.deps.transcriptRoot = root
      await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: fail.deps }), (error) => error instanceof StartRefusal && error.message.includes('ask block at line 9 is not one whole message the operator typed'))
      assert.deepEqual(effects(fail.calls), [])
    }
  }
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
      await startLane({ briefPath: '/d/b1.md', check: true, deps: operator.deps })
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
      for (const check of [true, false]) {
        const operator = fakes({ brief })
        operator.deps.transcriptRoot = root
        await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: operator.deps })
        assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured: incomplete Claude Code transcript scan')))
        assert.equal(effects(operator.calls).length > 0, !check)
      }
    } finally { fs[method] = original; syncBuiltinESMExports() }
  }
  writeFileSync(hidden, row('Do this.').slice(0, -1))
  for (const check of [true, false]) {
    const operator = fakes({ brief })
    operator.deps.transcriptRoot = root
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: operator.deps })
    assert.ok(operator.calls.some(([kind, line]) => kind === 'log' && line.includes('ask provenance unmeasured: incomplete Claude Code transcript scan')))
    assert.equal(effects(operator.calls).length > 0, !check)
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
  readFileSync: (path) => path.endsWith('/.crew/project.json') ? ${JSON.stringify(JSON.stringify({suite:'npm test',proof:[],onboarded:{hash:createHash('sha256').update(JSON.stringify(['npm test',[]])).digest('hex')}}))} : invalid ? ${JSON.stringify(BRIEF)}.replace('shape: standard', 'tier: build\\nshape: standard') : ${JSON.stringify(BRIEF)},
  resolveAgents: () => ({ seats: {} }), existsSync: () => false,
  mkdirSync: () => {}, writeFileSync: () => {},
  spawnSync: (file, args) => ({ status: 0, stdout: args.includes('ls-tree') ? (args.at(-1) === '.crew/project.json' ? '100644 blob ' + 'a'.repeat(40) + '\\t.crew/project.json' : (args.at(-1).includes('.') ? '100644 blob ' : '040000 tree ') + 'a'.repeat(40) + '\\t' + args.at(-1) + '\\0') : args.includes('show') ? ${JSON.stringify(JSON.stringify({suite:'npm test',proof:[],onboarded:{hash:createHash('sha256').update(JSON.stringify(['npm test',[]])).digest('hex')}}))} : args.includes('--verify') ? 'a'.repeat(40) : 'origin/main' }),
  spawnDetached: () => { writeSync(3, 'started\\n'); return 4242 }, crewRoot: '/virtual/crew',
}
const argv = invalid ? ['/d/b1.md', '--check'] :
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

// MUTATION: change the refusal return to 0 and an invalid brief reports success.
test('(SE2) invalid --check still refuses with stdout closed', async () => {
  const result = await runPipeChild('invalid')
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.ok(Number.isInteger(result.code) && result.code !== 0)
  assert.match(result.stderr, /brief .* is not a P1 brief:/)
  assert.match(result.stderr, /tier is not a brief field/)
  assert.doesNotMatch(result.stderr, /\n\s+at |Unhandled 'error' event/)
  assert.equal(result.started, '')
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

// MUTATION: skip the brief check and a malformed brief starts a lane.
test('a brief with defects is refused before any git call', async () => {
  const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'tier: build\nshape: standard') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /tier is not a brief field/)
  assert.deepEqual(calls.filter(([kind]) => kind !== 'log'), [])
})

test('a brief with mechanical: true starts a mechanical lane and a brief without it starts a build lane', async () => {
  for (const tier of ['mechanical', 'build']) {
    const brief = tier === 'mechanical' ? BRIEF.replace('shape: standard', 'mechanical: true\nshape: standard') : BRIEF
    const resolved = []
    const f = fakes({ brief, resolve: (t) => { resolved.push(t); return resolveAgents(t) } })
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', check: true, deps: f.deps }))
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }))
    assert.deepEqual(resolved, [tier, tier])
    assert.ok(f.calls.some(([kind, line]) => kind === 'log' && line.includes(`brief ok lane=b1 tier=${tier}`)))
    assert.ok(f.calls.some(([kind, line]) => kind === 'log' && line.includes(`loop=lean tier=${tier}`)))
    assert.equal(JSON.parse(written(f.calls, '/task/lean.json')[2]).tier, tier)
  }
})

test('--check validates the brief and the agent definitions and starts nothing', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps })
  assert.equal(result.checked, true)
  assert.deepEqual(effects(calls), [])
  assert.match(calls.at(-1)[1], /brief ok lane=b1 tier=build shape=standard closes=1961/)
})

test('without a readable origin/HEAD the start is refused before any worktree is made', async () => {
  const { deps, calls } = fakes({ originHead: null })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /origin\/HEAD.*git remote set-head origin --auto/)
  assert.equal(spawned(calls, 'worktree'), undefined)
  assert.equal(calls.some(([kind]) => ['write', 'mkdir', 'detached'].includes(kind)), false)
})

test('an existing worktree or a failed worktree add stops the start and launches nothing', async () => {
  const exists = fakes({ exists: (path) => path === '/repo/dt-b1' })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: exists.deps }), /worktree \/repo\/dt-b1 already exists/)
  assert.equal(exists.calls.some(([kind]) => kind === 'detached'), false)
  const failed = fakes({ worktreeStatus: 1 })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: failed.deps }), /git worktree add -b b1 \/repo\/dt-b1 main failed/)
  assert.equal(failed.calls.some(([kind]) => kind === 'detached' || kind === 'write'), false)
})

test('main reports usage, refusals and success as exit codes', async () => {
  assert.equal(await main([], fakes().deps), 2)
  assert.equal(await main(['a.md', 'b.md'], fakes().deps), 2)
  assert.equal(await main(['/d/b1.md', '--check'], fakes().deps), 0)
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], fakes({ worktreeStatus: 1 }).deps), 1)
})

test('--check and a real start need a checkout', async () => {
  for (const args of [['/d/b1.md', '--check'], ['/d/b1.md']]) assert.equal(await main(args, fakes({ inGit: false }).deps), 2)
})

// MUTATION: drop the bound-issue slot and the run brief carries no bound issue.
test('the run brief carries the header and the bound-issue slot when closes is set', () => {
  const run = runBrief(BRIEF, 1961)
  assert.equal(run.split('\n').slice(0, 2).join('\n'), '# Task\n<!-- crew:bound-issue #1961 -->')
  assert.equal(runBrief(BRIEF.replace('closes: 1961', 'closes: null'), null).split('\n')[1], '')
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
  for (const [brief, check] of [[operatorBrief, false], [BRIEF, true], [operatorBrief, true]]) {
    const run = fakes({ brief })
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps: run.deps })
    assert.equal(run.calls.some(([kind, file]) => kind === 'spawn' && file === 'gh'), false)
    if (!check) assert.equal(JSON.parse(written(run.calls, '/task/lean.json')[2]).brief, runBrief(brief, 1961))
  }
})

// MUTATION: restore the body-wide #N guard and the start refuses the source's words.
test('an operator brief starts with its quoted ask verbatim, #N included, and binds only closes', async () => {
  for (const closes of [null, 1961]) {
    const brief = BRIEF.replace('source: issue 1961', 'source: operator request')
      .replace('closes: 1961', `closes: ${closes}`)
      .replace('## Context', '## The ask\n\n> Fix #42 after PR #7.\n\n## Context')
    const f = fakes({ brief })
    await assert.doesNotReject(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: f.deps }))
    assert.equal(f.calls.some(([kind, file]) => kind === 'spawn' && file === 'gh'), false)
    const snapshot = written(f.calls, '/briefs/started/b1.md')[2]
    const spec = JSON.parse(written(f.calls, '/task/lean.json')[2])
    assert.equal(snapshot, runBrief(brief, closes))
    assert.equal(spec.brief, snapshot)
    assert.ok(snapshot.includes('> Fix #42 after PR #7.'))
    assert.deepEqual(snapshot.match(/^<!-- crew:bound-issue .* -->$/gm) ?? [], closes ? ['<!-- crew:bound-issue #1961 -->'] : [])
    assert.deepEqual(spec.closes, closes ? [closes] : [])
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

// MUTATION: force the lean decision false and the lane detaches crew run, with no spec or lean members.
test('start detaches the bridge on a measured spec and boots nothing', async () => {
  const { deps, calls } = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const launch = leanLaunch(calls)
  assert.deepEqual(launch.slice(1, 3), [process.execPath, [LEAN, '/home/.crew/dt-b1/b1/task/lean.json']])
  assert.equal(launch[3].cwd, '/repo/dt-b1')
  assert.equal(launch[3].log, '/home/.crew/briefs/started/b1.run.log')
  assert.equal(spawned(calls, 'boot'), undefined)
  assert.equal(spawned(calls, 'run'), undefined)
  assert.equal(result.pid, 4242)
  const spec = JSON.parse(written(calls, '/task/lean.json')[2])
  assert.match(spec.brief, /\nIssue title: Refuse roster edits\n## The ask\n/)
  assert.deepEqual(spec, {
    id: 'b1', cwd: '/repo/dt-b1', taskDir: '/home/.crew/dt-b1/b1/task', tier: 'build', shape: 'standard', brief: runBrief(BRIEF, 1961, 'Refuse roster edits that cannot boot.\n', 'Refuse roster edits'),
    source: 'issue 1961', branch: 'b1', base: 'main', closes: [1961], suite: { command: 'npm', args: ['test'], timeoutMs: 1800000 }, proofTimeoutMs: 120000, onboarded: projectFile().onboarded.hash,
  })
  assert.equal(spec.timeoutMs, undefined)
  const { members } = JSON.parse(written(calls, '/dt-b1/b1/crew.json')[2])
  const { seats } = resolveAgents('build')
  assert.deepEqual(Object.keys(members), Object.keys(seats))
  for (const [role, cell] of Object.entries(seats)) assert.deepEqual(members[role], { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' })
  const unbound = fakes({ brief: BRIEF.replace('closes: 1961', 'closes: null') })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: unbound.deps })
  assert.deepEqual(JSON.parse(written(unbound.calls, '/task/lean.json')[2]).closes, [])
})

test('the project suite and onboarded hash become the lean spec suite and onboarded (ADR-057)', async () => {
  const project = projectFile('cargo test -p power-api')
  const { deps, calls } = fakes({ project })
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const spec = JSON.parse(written(calls, '/task/lean.json')[2])
  assert.deepEqual(spec.suite, { command: 'cargo', args: ['test', '-p', 'power-api'], timeoutMs: 1800000 })
  assert.equal(spec.onboarded, project.onboarded.hash)
})

test('a configured suiteTimeoutMs in project.json reaches the lane suite spec and an absent one keeps 1800000', async () => {
  for (const [value, expected] of [[3600000, 3600000], [undefined, 1800000]]) {
    const { deps, calls } = fakes({ project: projectFile('npm test', [], value) })
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
    assert.equal(JSON.parse(written(calls, '/task/lean.json')[2]).suite.timeoutMs, expected)
  }
})

test('a configured proofTimeoutMs in project.json reaches the lane spec and an absent one keeps 120000', async () => {
  for (const [value, expected] of [[360000, 360000], [undefined, 120000]]) {
    const { deps, calls } = fakes({ project: projectFile('npm test', [], undefined, value) })
    await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
    assert.equal(JSON.parse(written(calls, '/task/lean.json')[2]).proofTimeoutMs, expected)
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
      spawnDetached: () => { calls.push(['launch']); return 1 }, log: () => {},
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

test('crew start and --check refuse a checkout that is not onboarded or is stale, naming /onboard, and start nothing (ADR-057)', async () => {
  for (const project of [null, { suite: 'npm test', proof: [] }, '{', { ...projectFile(), suite: 'cargo test' }, { ...projectFile(), proof: null }]) for (const check of [false, true]) {
    const { deps, calls } = fakes({ project })
    await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check, deps }), (e) => e instanceof StartRefusal && e.message.includes('/onboard') && e.message.includes(project === null || !Object.hasOwn(Object(project), 'onboarded') && typeof project !== 'string' ? 'not-onboarded' : 'onboarding-stale'))
    assert.deepEqual(effects(calls), [])
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

test('main reads only --check and --checkout: --loop, an unknown flag, a duplicate or a missing value is usage', async () => {
  for (const argv of [['a.md', '--loop', 'lean'], ['a.md', '--bogus'], ['a.md', '--check', '--check'], ['a.md', '--checkout', 'x', '--checkout', 'y'], ['a.md', '--checkout'], ['a.md', '--checkout', '--check'], [], ['a.md', 'b.md']]) {
    const f = fakes()
    const { code, stderr } = await mainWithStderr(argv, f.deps)
    assert.equal(code, 2, argv.join(' '))
    assert.equal(stderr, 'usage: crew start <brief.md> [--check] [--checkout <dir>]\n')
    assert.deepEqual(effects(f.calls), [])
  }
  assert.equal(await main(['a.md', '--check'], fakes().deps), 0)
  assert.equal(await main(['a.md', '--checkout', '/repo/checkout'], fakes().deps), 0)
})

// A start with no --loop is the lean loop, whether it comes through startLane or main.
test('(SW1) a start with no --loop, from startLane or main, runs the lean loop', async () => {
  const viaLane = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: viaLane.deps })
  const viaMain = fakes()
  assert.equal(await main(['/d/b1.md', '--checkout', '/repo/checkout'], viaMain.deps), 0)
  for (const { calls } of [viaLane, viaMain]) {
    assert.ok(leanLaunch(calls))
    assert.ok(written(calls, '/lean.json'))
    assert.equal(spawned(calls, 'boot'), undefined)
    assert.equal(spawned(calls, 'run'), undefined)
  }
})

// MUTATION: allow a finish brief to start without an escalated lane.
test('(SW4) --check refuses a brief the lean loop cannot run', async () => {
  const finish = fakes({ brief: BRIEF.replace('shape: standard', 'shape: finish') })
  await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', check: true, deps: finish.deps }), /shape finish starts from an escalated lane/)
})

// MUTATION: drop the shape refusal and a stepped brief starts a lean lane that runs only the standard loop.
test('a stepped brief is refused by main --check and startLane before effects', async () => {
  for (const via of ['main', 'startLane']) {
    const { deps, calls } = fakes({ brief: BRIEF.replace('shape: standard', 'shape: stepped') })
    if (via === 'main') {
      const { code, stderr } = await mainWithStderr(['/d/b1.md', '--check'], deps)
      assert.equal(code, 1)
      assert.match(stderr, /not a P1 brief:[\s\S]*shape is one of standard, finish/)
    } else {
      await assert.rejects(startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps }), /not a P1 brief:[\s\S]*shape is one of standard, finish/)
    }
    assert.deepEqual(effects(calls), [])
  }
})

test('(LS1) crew/start.mjs imports none of the old driver or roster modules', () => {
  const source = readFileSync(fileURLToPath(new URL('./start.mjs', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /(?:import\s*\(|from\s+)['"]\.\/(drive|roster|roster-validate|roster-generate|crew)\.mjs['"]/)
})

test('(LS2) a lean --check in a child process loads no old driver, roster or crew module', () => {
  const dir = scratchDir('lean-start-trace-')
  const tracer = join(dir, 'trace.mjs')
  const trace = join(dir, 'trace.log')
  const brief = join(dir, 'b1.md')
  writeFileSync(brief, BRIEF)
  writeFileSync(tracer, `import { registerHooks } from 'node:module'\nimport { appendFileSync } from 'node:fs'\nregisterHooks({ load(url, context, next) { appendFileSync(${JSON.stringify(trace)}, url + '\\n'); return next(url, context) } })\n`)
  const start = fileURLToPath(new URL('./start.mjs', import.meta.url))
  const child = spawnSync(process.execPath, ['--import', tracer, start, brief, '--check'], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const loaded = readFileSync(trace, 'utf8')
  assert.match(loaded, /crew\/start\.mjs/)
  for (const name of ['drive', 'roster', 'roster-validate', 'roster-generate', 'crew']) assert.equal(loaded.includes(`/crew/${name}.mjs`), false, name)
})

test('(LS3, LS5) a lean start keeps the member shape and writes no roster', async () => {
  const run = fakes()
  const result = await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps: run.deps })
  assert.equal(result.pid, 4242)
  assert.equal(leanLaunch(run.calls).length > 0, true)
  assert.equal(spawned(run.calls, 'boot'), undefined)
  assert.equal(spawned(run.calls, 'run'), undefined)
  assert.equal(written(run.calls, '.roster.json'), undefined)
  const { members } = JSON.parse(written(run.calls, '/dt-b1/b1/crew.json')[2])
  const { seats, advisor } = resolveAgents('build')
  assert.deepEqual(members, Object.fromEntries(Object.entries(seats).map(([role, cell]) => [role, { agent: cell.agent, model: `${cell.provider}/${cell.id}`, transport: 'lean-acp' }])))
  assert.equal(advisor !== null && 'advisor' in members, false)
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

const LEAN_MUTATION = { check: 'RV1', file: 'src/a.mjs', find: 'before', replace: 'after' }
const GREEN = { status: 'green', reason: null, code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const EINTR = Object.assign(new Error('turn interrupted'), { code: 'EINTR' })
const EPERM = Object.assign(new Error('denied'), { code: 'EPERM' })

// A lane's whole loop with every outside effect faked: seats answer by envelope id, recordings are real files.
function leanFixture({ tier = 'build', answers = {}, acp, deps = {}, loopDeps = {}, scope, repairPlan = false, repairBuilder = false, status = 'M  src/a.mjs\0' } = {}) {
  const dir = scratchDir('lean-')
  const spec = {
    id: 'lane', cwd: join(dir, 'worktree'), taskDir: join(dir, 'task'), tier, shape: 'standard', brief: BRIEF,
    source: 'issue 1961', branch: 'lane', base: 'main', suite: { command: 'npm', args: ['test'] },
  }
  mkdirSync(spec.cwd, { recursive: true })
  const requests = [], logs = [], reviews = answers.reviews ?? ['pass']
  let review = 0, reads = 0, rebasedHead = null, committed = false
  const envelope = (role, id) => {
    const n = Number(id.split('.').at(-1))
    const own = answers[`${role}.${n}`]
    const details = role === 'planner' ? { subject: 'fix(crew): publish measured lane results', tests: [{ file: 'lib.test.mjs', title: 'works' }], plan_path: join(spec.taskDir, 'plan.md'), ...(scope === undefined ? {} : { files_in_scope: scope }) }
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
    if (repairBuilder && input.definition.role === 'builder' && !input.prompt.startsWith('Your envelope was refused.')) delete value.details.subject
    writeFileSync(path, JSON.stringify(value))
    return { stopReason: 'end_turn', usage: null, refusal: null }
  })
  const options = {
    log: (line) => logs.push(line),
    runAcpSeat: (input) => { if (!acp) return fakeAcp(input); requests.push(input); return fakeAcp(input) },
    loopDeps: {
      journal: async () => {},
      proveTests: async () => ({ status: 'green', reason: null, rows: [{ file: 'lib.test.mjs', title: 'works', proven: true }] }),
      runSuite: async () => GREEN,
      commitChanges: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40) }),
      rebaseBranch: async () => ({ status: 'green', reason: null, head: (committed ? 'a' : 'b').repeat(40) }),
      openPullRequest: async () => ({ status: 'green', reason: null, pr: { number: 7, url: 'https://example.test/7' } }),
      // After the rebase the tree is the rebased head and clean; before it, status reads the scripted paths.
      run: async (input) => input.args.includes('write-tree') ? { ...GREEN, stdout: `${'e'.repeat(40)}\n` }
        : input.args.includes('rev-parse') ? { ...GREEN, stdout: `${rebasedHead}\n` }
        : input.args.includes('status') ? { ...GREEN, stdout: rebasedHead ? '' : [status].flat()[Math.min(reads++, [status].flat().length - 1)] } : GREEN,
      ...loopDeps,
    },
    ...deps,
  }
  const commit = options.loopDeps.commitChanges
  options.loopDeps.commitChanges = async (input) => { const result = await commit(input); if (result.status === 'green') committed = true; return result }
  const rebase = options.loopDeps.rebaseBranch
  options.loopDeps.rebaseBranch = async (input) => { const result = await rebase(input); if (committed && result.status === 'green') rebasedHead = result.head; return result }
  const sessionOf = (role, n) => join(spec.taskDir, 'lean', role, `lane.${role}.${n}.jsonl`)
  return { spec, requests, logs, go: () => runLean(spec, options), sessionOf, options }
}
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
      ...(target === 'conflict' ? { rebaseBranch: async () => ++rebases === 1 ? { status: 'green', reason: null, head: 'b'.repeat(40) } : { status: 'red', reason: 'rebase-conflict', conflicts: ['file'] } } : {}),
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

test('a session/new refusal that is not a logged-out message keeps seat-unmeasured and one rerun', async () => {
  const message = 'log in to Muse before opening a session'
  for (const [method, errorKind, errorMessage, reason, calls] of [
    ['session/new', null, 'session unavailable', 'seat-unmeasured', 2],
    ['session/new', 'rate_limit', message, 'seat-unmeasured', 2],
    ['initialize', 'authentication_failed', message, 'seat-unmeasured', 2],
    ['session/set_mode', 'authentication_failed', message, 'seat-unmeasured', 2],
    ['session/new', 'verification_required', 'verify', 'authentication_failed', 1],
  ]) {
    const rows = []
    const f = leanFixture({ acp: async () => { throw Object.assign(new Error(`acp seat planner refused ${method}: ${errorMessage} [acp-protocol-mismatch]`), { reason: 'acp-protocol-mismatch', method, errorKind, errorMessage }) }, loopDeps: { journal: async (row) => rows.push(row) } })
    assert.deepEqual(await f.go(), { status: 'stopped', reason, pr: null }, method)
    assert.equal(f.requests.length, calls, method)
    const verdicts = rows.filter((row) => row.event === 'verdict')
    assert.equal(verdicts.length, 1)
    assert.match(verdicts[0].observation.error.message, /\[acp-protocol-mismatch\]/)
  }
})

test("a mechanical builder prompt shows a P2 example with a subject, and a build builder's shows none", async () => {
  for (const tier of ['mechanical', 'build']) {
    const f = leanFixture({ tier, repairBuilder: tier === 'mechanical' })
    const result = await f.go()
    const builders = f.requests.filter((r) => r.definition.role === 'builder')
    const prompts = builders.map((r) => r.prompt)
    for (const prompt of prompts) {
      const example = JSON.parse(prompt.slice(prompt.lastIndexOf('{\n  "role"'), prompt.lastIndexOf('}') + 1))
      assert.equal(Object.hasOwn(example.details, 'subject'), tier === 'mechanical')
      assert.deepEqual(validateEnvelope('builder', example).defects, [])
    }
    assert.equal(prompts.length, tier === 'mechanical' ? 2 : 1)
    assert.equal(builders[0].definition.extensions.includes('skeletonread'), tier !== 'mechanical')
    assert.equal(result.status, 'done')
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

test("a raised lane's later turns run the judge tier definition", async () => {
  const f = leanFixture({ tier: 'mechanical', status: [' M crew/loop.mjs\0', 'M  src/a.mjs\0'] })
  f.spec.acceptance = ['RV1'] // archived spec, also accepted before ADR-055
  assert.equal((await f.go()).status, 'done')
  const builder = f.requests.findLast((r) => r.definition.role === 'builder')
  assert.deepEqual(builder.definition.advisor, parseAgent(readFileSync(join(AGENTS, 'builder.md'), 'utf8')).fields.advisor)
})

const terminal = (logs) => logs.map((line) => JSON.parse(line)).filter((row) => row.event === 'loop-result')

test('a thrown loop and a failing journal reach the result and the loop-result line with their described errors', async () => {
  for (const mode of ['throw', 'journal']) {
    const f = mode === 'journal' ? leanFixture({ loopDeps: { journal: async () => { throw EPERM } } }) : leanFixture()
    if (mode === 'throw') f.options.loopDeps = Object.defineProperty({}, 'run', { enumerable: true, get() { throw EPERM } })
    const result = await f.go()
    if (mode === 'throw') assert.deepEqual(result, { status: 'stopped', reason: 'runner-threw', pr: null, error: { code: 'EPERM', message: 'denied' } })
    else { assert.ok(result.journal.unwritten > 0); assert.deepEqual(result.journal.error, { code: 'EPERM', message: 'denied' }) }
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
  }
})

// MUTATION: send a request without the role's definition, effort, prompt or recording and a seat turn loses it.
test('every turn gets its role definition, the complete brief and P2, and its own recording', async () => {
  const f = leanFixture({ answers: { reviews: ['changes-needed', 'pass'] } })
  const result = await f.go()
  assert.equal(result.status, 'done')
  const roles = ['planner', 'builder', 'reviewer', 'builder', 'reviewer']
  assert.deepEqual(f.requests.map((r) => r.definition.role), roles)
  const { seats } = resolveAgents('build')
  f.requests.forEach((request, index) => {
    const role = roles[index]
    const id = `lane.${role}.${index + 1}`
    const returnPath = join(f.spec.taskDir, `${role}-${index + 1}.json`)
    const source = join(AGENTS, `${role}.md`)
    const { body, fields } = parseAgent(readFileSync(source, 'utf8'))
    const cell = seats[role]
    assert.deepEqual(request.definition, { role, agent: cell.agent, model: `${cell.provider}/${cell.id}`, effort: cell.effort, writes: { ...fields, ...fields.tiers?.build }.writes, skills: role === 'builder' ? ['code-less', 'prose-plain'] : role === 'reviewer' ? ['code-less', 'pr-review'] : fields.skills ?? [], requires: [], tools: { ...fields, ...fields.tiers?.build }.tools, extensions: { ...fields, ...fields.tiers?.build }.extensions, advisor: { ...fields, ...fields.tiers?.build }.advisor, wait_s: { ...fields, ...fields.tiers?.build }.wait_s, body })
    assert.equal(request.taskDir, f.spec.taskDir)
    assert.equal(request.cwd, f.spec.cwd)
    assert.notEqual(f.spec.taskDir, request.cwd)
    assert.equal(request.sessionFile, f.sessionOf(role, index + 1))
    for (const wanted of [body, BRIEF, `Envelope id: ${id}`, `Return path: ${returnPath}`, `Task directory: ${f.spec.taskDir}`, `Definition source: ${source}`, 'no submit_envelope', `"role": "${role}"`, `"id": "${id}"`]) {
      assert.ok(request.prompt.includes(wanted), `${id}: ${wanted}`)
    }
    if (role === 'builder' || role === 'reviewer') {
      assert.deepEqual(request.definition.skills, role === 'builder' ? ['code-less', 'prose-plain'] : ['code-less', 'pr-review'], id)
      assert.match(request.prompt, /Read the granted `code-less` skill before (working|reviewing)/, id)
    }
    assert.doesNotMatch(request.prompt, /^Charter file/m, id)
    assert.doesNotMatch(request.prompt, /\]\([^)]*roles\//, id)
    const lines = readFileSync(request.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines[0], { type: 'prompt', text: request.prompt })
    assert.equal(lines[1].update.content.text, `chunk-${id}`)
    assert.deepEqual(lines[2], { type: 'turn', stopReason: 'end_turn', usage: null, refusal: null })
    assert.equal(lines.length, 3)
  })
  assert.doesNotMatch(f.requests[0].prompt, /"mutations"/)
  assert.match(f.requests[1].prompt, /"summary"/)
  assert.match(f.requests[2].prompt, /"findings"/)
  assert.doesNotMatch(f.requests[1].prompt, /redo-this/)
  assert.match(f.requests[3].prompt, /redo-this/)
  assert.equal(new Set(f.requests.map((r) => r.sessionFile)).size, 5)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: emit the loop paragraph for the builder too, or not at all.
test('the loop-stage paragraph is written once by the prompt, not by the non-builder charters', async () => {
  const paragraph = 'The loop runs each test the builder names on the old source and on the build. It then runs the suite, commits, rebases and opens the PR. Do not run those stages yourself.'
  const f = leanFixture({ answers: { reviews: ['pass'] } })
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual([...new Set(f.requests.map((request) => request.definition.role))], ['planner', 'builder', 'reviewer'])
  for (const request of f.requests) {
    const role = request.definition.role
    if (role === 'builder') assert.ok(!request.prompt.includes('Do not run those stages yourself.'))
    else {
      assert.ok(!parseAgent(readFileSync(join(AGENTS, `${role}.md`), 'utf8')).body.includes(paragraph), role)
      assert.equal(request.prompt.split(paragraph).length, 2, role)
    }
  }
  for (const role of ['lead', 'tech-lead']) assert.ok(!parseAgent(readFileSync(join(AGENTS, `${role}.md`), 'utf8')).body.includes(paragraph), role)
})

// MUTATION: remove builder from the laneRole predicate.
test('LG1: builder gets accepted lane grants as bare whole skills', async () => {
  for (const tier of ['build', 'judge']) for (const [scope, extra] of [
    [['crew/lean.mjs'], ['backend-node']],
    [['visualizer/a.svelte'], ['frontend-svelte', 'ui-design', 'ux']],
    [['other/a.ts'], []],
    [['elsewhere/a.spec.ts'], ['test-economy']],
  ]) {
    const f = leanFixture({ tier, scope, repairPlan: true, answers: { reviews: ['changes-needed', 'pass'] } })
    assert.equal((await f.go()).status, 'done')
    for (const { definition } of f.requests.filter((r) => r.definition.role === 'builder')) {
      assert.deepEqual(definition.skills, ['code-less', 'prose-plain', ...extra])
      assert.deepEqual(definition.requires, [])
    }
  }
  const f = leanFixture({ status: ['', 'M  src/a.mjs\0'], loopDeps: {
    rebaseBranch: async () => ({ status: 'green', reason: null, head: 'a'.repeat(40), onto: 'c'.repeat(40) }),
  } })
  f.spec.shape = 'finish'
  f.spec.finish = { planPath: 'plan', gatePath: 'gate', subject: 'fix: test', mutations: [LEAN_MUTATION], stop: { reason: 'stopped' }, findings: [], turnOffset: 3, filesInScope: ['outside/a.svelte'] }
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual(f.requests[0].definition.skills, ['code-less', 'prose-plain', 'frontend-svelte', 'ui-design', 'ux'])
  assert.deepEqual(f.requests[1].definition.skills, ['code-less', 'pr-review', 'frontend-svelte', 'ui-design', 'ux'])
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

// MUTATION: override mechanical builder skills with [code-less].
test('PP2: builder definitions inherit both skills at every tier', async () => {
  for (const tier of TIERS) {
    const f = leanFixture({ tier })
    const result = await f.go()
    assert.equal(result.status, 'done', tier)
    const builders = f.requests.filter((request) => request.definition.role === 'builder')
    assert.ok(builders.length, tier)
    for (const request of builders) assert.deepEqual(request.definition.skills, ['code-less', 'prose-plain'], tier)
  }
})

// MUTATION: drop the changed-path section from the reviewer prompt and the reviewer is told nothing about untracked or renamed files.
test("each reviewer prompt carries the latest builder's tests and notes and a valid P2 reviewer example", async () => {
  const f = leanFixture({ answers: { reviews: ['changes-needed', 'pass'] } })
  assert.equal((await f.go()).status, 'done')
  const reviewers = f.requests.filter((r) => r.definition.role === 'reviewer')
  assert.equal(reviewers.length, 2)
  for (const [i, request] of reviewers.entries()) {
    const report = request.prompt.split('\n## Builder report\n')[1].split('\n## Changed paths')[0]
    assert.match(report, /Tests: \[{"file":"lib.test.mjs","title":"works"}\]/)
    assert.ok(report.includes(`Notes: "builder turn ${i === 0 ? 2 : 4}"`))
    const example = JSON.parse(request.prompt.split(`Task directory: ${f.spec.taskDir}\n`)[1].split('\nstatus is done')[0])
    assert.deepEqual(validateEnvelope('reviewer', example).defects, [])
    assert.ok(example.details.findings.some((finding) => finding.severity === 'must-fix' && finding.trigger))
  }
  for (const request of f.requests.filter((r) => r.definition.role !== 'reviewer')) assert.doesNotMatch(request.prompt, /^## Builder report$/m)
})

test('each reviewer prompt lists that round\'s measured paths as JSON-quoted bullets and no other seat gets the section', async () => {
  const f = leanFixture({
    answers: { reviews: ['changes-needed', 'pass'] },
    status: [' M src/a.mjs\0?? untracked file.txt\0?? line\nbreak.txt\0?? "quoted".txt\0R  moved.mjs\0old.mjs\0', '', 'M  commit-only.mjs\0'],
  })
  assert.equal((await f.go()).status, 'done')
  const section = (prompt) => (prompt.split('\n## Changed paths\n')[1] ?? '').split('\n## ')[0].split('\n').filter((line) => line.startsWith('- '))
  const reviewers = f.requests.filter((r) => r.definition.role === 'reviewer')
  assert.deepEqual(reviewers.map((r) => section(r.prompt)), [
    ['- "src/a.mjs"', '- "untracked file.txt"', '- "line\\nbreak.txt"', '- "\\"quoted\\".txt"', '- "moved.mjs"', '- "old.mjs"'],
    [],
  ])
  assert.match(reviewers[1].prompt, /^## Changed paths\n\n## Feedback$/m)
  for (const request of f.requests.filter((r) => r.definition.role !== 'reviewer')) assert.doesNotMatch(request.prompt, /## Changed paths/)
  const recorded = JSON.parse(readFileSync(reviewers[0].sessionFile, 'utf8').split('\n')[0])
  assert.equal(recorded.text, reviewers[0].prompt)
})

// MUTATION: derive writes from the role instead of the effective definition and a tier override or edited file is ignored.
test('the writes a seat receives are the effective definition writes, tier override included', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const task = leanFixture({ deps: { readFileSync: edit('writes: task-dir', 'writes: repo') } })
  await task.go()
  assert.deepEqual(task.requests.map((r) => r.definition.writes), ['repo', 'repo', 'task-dir'])
  const tiered = leanFixture({ deps: { readFileSync: edit(/tiers: .*/, 'tiers: {"build":{"writes":"none"}}') } })
  await tiered.go()
  assert.equal(tiered.requests[0].definition.writes, 'none')
  assert.equal(tiered.requests[0].definition.role, 'planner')
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

test('effective memory injects lane or override context into the recorded planner prompt', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const line of ['memory: true\ntiers: {}', 'tiers: {"build":{"memory":true}}', 'memory: false\ntiers: {"build":{"memory":true}}']) {
      delete process.env.CREW_MEMORY_DIR
      const f = leanFixture({ deps: { readFileSync: memoryDefinition(line) } })
      populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'lane judgment')
      assert.equal((await f.go()).status, 'done')
      assert.match(f.requests[0].prompt, /## Team memory[\s\S]*lane judgment/)
      assert.equal(JSON.parse(readFileSync(f.sessionOf('planner', 1), 'utf8').split('\n')[0]).text, f.requests[0].prompt)
    }
    const f = leanFixture({ deps: { readFileSync: memoryDefinition('memory: true\ntiers: {}') } })
    populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'lane judgment')
    process.env.CREW_MEMORY_DIR = join(f.spec.taskDir, 'override')
    populateMemory(process.env.CREW_MEMORY_DIR, 'override judgment')
    assert.equal((await f.go()).status, 'done')
    assert.match(f.requests[0].prompt, /override judgment/)
    assert.doesNotMatch(f.requests[0].prompt, /lane judgment/)
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

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

test('missing memory boots and journals the backend reason without fallback', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const reason of ['no-dir', 'no-index']) {
      const rows = []
      const f = leanFixture({ deps: { readFileSync: memoryDefinition('memory: true\ntiers: {}') }, loopDeps: reason === 'no-dir' ? { journal: async (row) => rows.push(row) } : { journal: undefined } })
      if (reason === 'no-index') delete f.options.loopDeps.journal
      populateMemory(join(f.spec.cwd, '.claude/dev-team/memory'), 'must not fall back')
      process.env.CREW_MEMORY_DIR = join(f.spec.cwd, 'missing-override')
      if (reason === 'no-index') mkdirSync(process.env.CREW_MEMORY_DIR)
      assert.equal((await f.go()).status, 'done')
      assert.doesNotMatch(f.requests[0].prompt, /## Team memory/)
      const journal = reason === 'no-dir' ? rows : readFileSync(join(f.spec.taskDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      const event = journal.find((row) => row.event === 'memory-empty')
      assert.equal(event.reason, reason)
      assert.equal(event.role, 'planner')
      assert.equal(event.id, 'lane.planner.1')
    }
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

test('false or absent effective memory neither injects nor journals memory', async () => {
  const previous = process.env.CREW_MEMORY_DIR
  try {
    for (const line of ['tiers: {}', 'memory: false\ntiers: {}', 'memory: true\ntiers: {"build":{"memory":false}}', 'tiers: {"build":{"memory":false}}', 'tiers: {"judge":{"memory":true}}']) {
      const rows = []
      const f = leanFixture({ deps: { readFileSync: memoryDefinition(line) }, loopDeps: { journal: async (row) => rows.push(row) } })
      process.env.CREW_MEMORY_DIR = join(f.spec.cwd, 'override')
      populateMemory(process.env.CREW_MEMORY_DIR, 'secret judgment')
      assert.equal((await f.go()).status, 'done', line)
      assert.doesNotMatch(f.requests[0].prompt, /## Team memory/)
      assert.equal(rows.some((row) => row.event === 'memory-empty'), false)
    }
  } finally {
    if (previous === undefined) delete process.env.CREW_MEMORY_DIR
    else process.env.CREW_MEMORY_DIR = previous
  }
})

// MUTATION: drop effective.tools from the dispatched definition and an authored tool list never reaches the seat.
test('the tools a seat receives are the effective definition tools, tier override and empty list included, absent when unset', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const planned = async (deps) => {
    const f = leanFixture({ acp: () => { throw new Error('capture ends the fake turn') }, deps })
    await f.go()
    return f.requests[0].definition
  }
  assert.equal(Object.hasOwn(await planned({}), 'tools'), true)
  assert.equal((await planned({})).tools, undefined)
  assert.deepEqual((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\ntools: ["Read","Grep"]') })).tools, ['Read', 'Grep'])
  assert.deepEqual((await planned({ readFileSync: edit(/tiers: .*/, 'tools: ["Read"]\ntiers: {"build":{"tools":["Glob"]}}') })).tools, ['Glob'])
  assert.deepEqual((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\ntools: []') })).tools, [])
})

// MUTATION: drop effective.wait_s from the dispatched definition and an authored deadline never reaches the seat.
test('the wait_s a seat receives is the effective definition value, tier override included, absent when unset', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  const planned = async (deps) => {
    const f = leanFixture({ acp: () => { throw new Error('capture ends the fake turn') }, deps })
    await f.go()
    return f.requests[0].definition
  }
  assert.equal(Object.hasOwn(await planned({}), 'wait_s'), true)
  assert.equal((await planned({})).wait_s, undefined)
  assert.equal((await planned({ readFileSync: edit('writes: task-dir', 'writes: task-dir\nwait_s: 7') })).wait_s, 7)
  assert.equal((await planned({ readFileSync: edit(/tiers: .*/, 'wait_s: 7\ntiers: {"build":{"wait_s":3}}') })).wait_s, 3)
})

// MUTATION: skip the return read or the rerun after a deadline and the late invalid envelope is not evaluated twice.
test('an expired real seat turn reads its late invalid envelope and reruns once before stopping', async () => {
  const planner = join(AGENTS, 'planner.md')
  let clock = 0, returnPath, envelopeId, reads = 0, rerun
  const f = leanFixture({
    deps: {
      readFileSync: (path, ...args) => {
        const text = readFileSync(path, ...args)
        return path === planner ? text.replace('writes: task-dir', 'writes: task-dir\nwait_s: 2') : text
      },
      runAcpSeat: (input) => {
        if (returnPath) { rerun = input; throw new Error('rerun failed') }
        returnPath = /^Return path: (.+)$/m.exec(input.prompt)[1]
        envelopeId = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
        const late = () => {
          mkdirSync(f.spec.taskDir, { recursive: true })
          writeFileSync(returnPath, JSON.stringify({ role: 'planner', id: envelopeId, status: 'done', summary: 'late',
            details: { plan_path: join(f.spec.taskDir, 'plan.md') } }))
        }
        const client = {
          start() {}, initialize() {}, newSession() {}, setMode() {},
          beginPrompt: () => 5, pollPrompt: () => null,
          cancelPrompt: () => { late(); return true },
          close: () => ({ outcome: 'proven' }),
        }
        return runAcpSeat({ ...input, definition: { ...input.definition, agent: 'claude', model: 'anthropic/claude-opus-4-6' }, binaries: { pi: process.execPath, claudeAcp: process.execPath, claude: process.execPath },
          deps: { ...input.deps, clientFactory: () => client, now: () => clock, sleep: (ms) => { clock += ms } } })
      },
    },
    loopDeps: { readFile: async (...args) => { reads++; return readFileSync(...args) } },
  })
  const result = await f.go()
  assert.equal(result.status, 'stopped')
  assert.equal(result.reason, 'seat-unmeasured')
  assert.equal(existsSync(returnPath), true)
  assert.equal(reads, 2)
  assert.equal(rerun.definition.role, 'planner')
  assert.ok(rerun.prompt.includes(`Envelope id: ${envelopeId}\n`))
  assert.ok(rerun.prompt.includes(`Return path: ${returnPath}\n`))
  assert.equal(clock, 2000)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

test('a muse planner turn that adds, rewrites or deletes a lean record, or writes its own session file, stops seat-unmeasured with no return, and one that writes only task artifacts completes', async () => {
  for (const [mutation, throws] of [['none', false], ['add', false], ['rewrite', false], ['delete', false], ['session', false], ['add', true]]) {
    const f = leanFixture()
    const prior = join(f.spec.taskDir, 'lean', 'reviewer', 'prior.jsonl')
    mkdirSync(join(f.spec.taskDir, 'lean', 'reviewer'), { recursive: true })
    writeFileSync(prior, 'prior')
    const answered = f.options.runAcpSeat
    f.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (input.definition.role === 'planner') {
        if (mutation === 'add') {
          mkdirSync(join(f.spec.taskDir, 'lean', 'builder'), { recursive: true })
          writeFileSync(join(f.spec.taskDir, 'lean', 'builder', 'forged.jsonl'), 'forged')
        }
        if (mutation === 'rewrite') writeFileSync(prior, 'changed')
        if (mutation === 'delete') rmSync(prior)
        if (mutation === 'session') appendFileSyncReal(input.sessionFile, 'forged\n')
        if (throws) throw new Error('turn failed')
      }
      return turn
    }
    const result = await f.go()
    if (mutation === 'none') assert.equal(result.status, 'done')
    else {
      assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, mutation)
      assert.equal(existsSync(join(f.spec.taskDir, 'planner-1.json')), false, mutation)
      assert.equal(f.requests.filter((input) => input.definition.role === 'planner').length, 1, mutation)
    }
  }
})

test('a muse planner whose lean records cannot be read before or after its turn stops seat-unmeasured with no return', async () => {
  for (const [failAt, deletionFails] of [[1, false], [2, false], [2, true]]) {
    let calls = 0
    const f = leanFixture({ deps: { recordState: () => ++calls === failAt ? null : 'measured', ...(deletionFails ? { rmSync: () => { throw EPERM } } : {}) } })
    mkdirSync(f.spec.taskDir, { recursive: true })
    writeFileSync(join(f.spec.taskDir, 'planner-1.json'), 'unearned')
    assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null }, String(failAt))
    assert.equal(existsSync(join(f.spec.taskDir, 'planner-1.json')), deletionFails, String(failAt))
    assert.equal(f.requests.length, failAt - 1)
  }
})

test('a seat turn that changed the repo it may not write leaves no return for the loop to accept', async () => {
  for (const reason of ['acp-seat-wrote-repo', 'acp-seat-repo-unmeasured']) {
    const f = leanFixture()
    const answered = f.options.runAcpSeat
    f.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (input.definition.role === 'planner') throw Object.assign(new Error(reason), { reason })
      return turn
    }
    const result = await f.go()
    assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
    assert.equal(existsSync(join(f.spec.taskDir, 'planner-1.json')), false)
  }
  const f = leanFixture({ deps: { rmSync: () => { throw EPERM } } })
  const answered = f.options.runAcpSeat
  f.options.runAcpSeat = async (input) => {
    await answered(input)
    throw Object.assign(new Error('changed repo'), { reason: 'acp-seat-wrote-repo' })
  }
  assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(existsSync(join(f.spec.taskDir, 'planner-1.json')), true)
  assert.equal(f.requests.length, 1)
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
        if (role === 'lead') {
          const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
          const value = JSON.parse(readFileSync(path, 'utf8'))
          value.details = { decision: 'bounce', target: 'planner' }
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

test('a muse planner in a repository subdirectory cannot change an already-dirty file and leave a return', async () => {
  const f = leanFixture()
  const repo = f.spec.cwd
  try {
    git(repo, 'init')
    mkdirSync(join(repo, 'src'))
    const file = join(repo, 'src/a.mjs')
    writeFileSync(file, 'base')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    writeFileSync(file, 'builder edit')
    f.spec.cwd = join(repo, 'src')
    const answered = f.options.runAcpSeat
    let returnPath, turns = 0
    f.options.runAcpSeat = (input) => {
      if (input.definition.role !== 'planner') return answered(input)
      turns++
      returnPath = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const client = { start() {}, initialize() {}, newSession() {}, setMode() {}, beginPrompt: () => 1,
        pollPrompt: () => { answered(input); writeFileSync(file, 'planner edit'); return { stopReason: 'end_turn' } },
        close: () => ({ outcome: 'proven' }) }
      return runAcpSeat({ ...input, definition: { ...input.definition, agent: 'muse', model: 'meta/muse-wonder-1.0' },
        binaries: { muse: process.execPath }, deps: { ...input.deps, clientFactory: () => client } })
    }
    assert.deepEqual(await f.go(), { status: 'stopped', reason: 'seat-unmeasured', pr: null })
    assert.equal(readFileSync(file, 'utf8'), 'planner edit')
    assert.equal(turns, 1)
    assert.equal(existsSync(returnPath), false)
  } finally { rmSync(join(repo, '..'), { recursive: true, force: true }) }
})

// MUTATION: skip the empty-list refusal in the seat and a toolless Claude seat starts and runs.
test('a Claude seat authored with an empty tools list stops the lane as seat-unmeasured before any process starts', async () => {
  const planner = join(AGENTS, 'planner.md')
  const spawned = [], refusals = []
  const f = leanFixture({
    deps: {
      readFileSync: (path, ...args) => {
        const text = readFileSync(path, ...args)
        return path === planner ? text.replace('writes: task-dir', 'writes: task-dir\ntools: []') : text
      },
      runAcpSeat: async (input) => {
        try {
          return await runAcpSeat({
            ...input,
            definition: { ...input.definition, agent: 'claude', model: 'anthropic/claude-opus-4-6' },
            binaries: { claudeAcp: process.execPath, claude: process.execPath },
            deps: { ...input.deps, clientDeps: { spawn: (...args) => { spawned.push(args); throw new Error('no process may start') } } },
          })
        } catch (error) { refusals.push(error.code); throw error }
      },
    },
  })
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.deepEqual(refusals, ['ACP_EMPTY_TOOLS', 'ACP_EMPTY_TOOLS'])
  assert.equal(spawned.length, 0)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
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

// MUTATION: refuse to read the return after an ACP refusal, or rerun a provider-routed failure.
test('a refused ACP turn is read after the turn: a valid return is accepted, an invalid one gets one rerun session, a provider-routed refusal none', async () => {
  for (const mode of ['valid', 'invalid', 'rate_limit', 'authentication_failed']) {
    const f = leanFixture({ acp: async (input) => {
      const role = input.definition.role
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      mkdirSync(f.spec.taskDir, { recursive: true })
      if (role === 'planner') writeFileSync(join(f.spec.taskDir, 'plan.md'), '')
      const details = role === 'planner' ? { subject: 'fix(crew): planned', plan_path: 'plan.md', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
        : role === 'builder' ? { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }] }
        : { verdict: 'pass', findings: [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['a'], complete: true } }
      writeFileSync(path, role === 'planner' && mode !== 'valid' ? '{' : JSON.stringify({ role, id, status: 'done', summary: 'ok', details }))
      return role === 'planner' ? { stopReason: null, refusal: { code: -32603, errorKind: mode === 'valid' || mode === 'invalid' ? 'incomplete_tool_call' : mode, message: 'Claude ended the turn without returning results for tool calls' } } : { stopReason: 'end_turn' }
    } })
    const result = await f.go()
    assert.equal(result.status, mode === 'valid' ? 'done' : 'stopped', mode)
    if (mode !== 'valid') assert.equal(result.reason, 'seat-unmeasured')
    const planners = f.requests.filter((r) => r.definition.role === 'planner')
    assert.equal(planners.length, mode === 'invalid' ? 2 : 1)
    if (mode === 'invalid') { assert.equal(planners[1].sessionFile, f.sessionOf('planner', 1).replace('.jsonl', '.rerun.jsonl')); assert.equal(planners[1].prompt, planners[0].prompt) }
  }
})

// MUTATION: ignore the relayed skill rows when a refused turn leaves a valid return.
test('a refused ACP turn with a valid return must prove its required skills', async () => {
  const planner = join(AGENTS, 'planner.md')
  const load = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Skill', kind: 'other', status: 'in_progress', rawInput: { skill: 'crew-skills-planner:alpha' }, _meta: { claudeCode: { toolName: 'Skill' } } } })
  const loaded = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } })
  for (const proven of [false, true]) {
    const rows = []
    const f = leanFixture({ deps: { readFileSync: (path, ...args) => {
      const text = readFileSync(path, ...args)
      return path === planner ? text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]') : text
    } }, loopDeps: { journal: async (row) => rows.push(row), resolveAgents: (tier) => {
      const resolved = resolveAgents(tier)
      resolved.seats.planner = { ...resolved.seats.planner, provider: 'anthropic', id: 'claude-opus-4-6', agent: 'claude' }
      return resolved
    } } })
    const answered = f.options.runAcpSeat
    f.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (input.definition.role !== 'planner') return turn
      if (proven) input.deps.appendFileSync(input.sessionFile, `${load}\n${loaded}\n`, 'utf8')
      return { stopReason: null, refusal: { code: -32603, errorKind: 'incomplete_tool_call', message: 'Claude ended the turn without returning results for tool calls' } }
    }
    const result = await f.go()
    assert.equal(result.status, proven ? 'done' : 'stopped')
    if (!proven) {
      assert.equal(result.reason, 'envelope-refused')
      assert.ok(rows.some((r) => r.event === 'envelope' && r.defects.includes('required-skills-unproven')))
    }
  }
})

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

// MUTATION: swallow the failed turn-row append and the cause is lost while the seat still reports a recorded failure.
test('a denied turn-row append still fails the seat and names the recording error; an earlier recording error wins', async () => {
  const refused = { stopReason: null, usage: null, refusal: { code: 1, message: 'refused', errorKind: 'x' } }
  for (const code of ['EPERM', 'EIO', 'EINTR']) {
    const deny = (match, errorCode) => (...args) => {
      if (String(args[1]).includes(match)) throw Object.assign(new Error(`${errorCode} injected`), { code: errorCode })
      return appendFileSyncReal(...args)
    }
    const turnRow = await oneTurn(refused, { deps: { appendFileSync: deny('"type":"turn"', code) } })
    assert.deepEqual(turnRow.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, code)
    assert.ok(turnRow.reads() > 0, code)
    assert.equal(turnRow.f.requests.length, 2, code)
    assert.equal(turnRow.verdicts[0].observation.error.code, code)
    const earlier = await oneTurn(refused, { deps: { appendFileSync: (...args) => { if (String(args[1]).includes('chunk')) throw Object.assign(new Error('first'), { code }); return deny('"type":"turn"', 'EIO')(...args) } } })
    assert.equal(earlier.verdicts[0].observation.error.code, code)
    assert.ok(earlier.reads() > 0, code)
    assert.equal(earlier.f.requests.length, 2, code)
  }
})

test("a turn row carries the seat's usage reason when the seat names one and keeps its shape otherwise", async () => {
  for (const reason of ['usage-unavailable', undefined]) {
    const run = await oneTurn({ stopReason: 'end_turn', usage: null, refusal: null, usage_reason: reason })
    assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason: 'end_turn', usage: null, refusal: null, ...(reason === undefined ? {} : { usage_reason: reason }) })
  }
})

// MUTATION: null the usage in the turn row and an accepted turn loses its measurement.
test('an accepted turn ends with exactly one turn row carrying its usage, and its envelope is read', async () => {
  for (const usage of [{ input_tokens: 5, output_tokens: 2 }, null]) {
    const run = await oneTurn({ stopReason: 'end_turn', usage, refusal: null })
    assert.equal(run.reads() > 0, true)
    assert.equal(run.rows.filter((row) => row.type === 'turn').length, 1)
    assert.deepEqual(run.rows.at(-1), { type: 'turn', stopReason: 'end_turn', usage, refusal: null })
    assert.equal(run.rows.length, 3)
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
      const details = input.definition.role === 'planner' ? { subject: 'fix(crew): publish measured lane results', tests: [{ file: 'lib.test.mjs', title: 'works' }], plan_path: 'plan.md' }
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

// MUTATION: null the classifier result and a rate-limited turn stops the lane instead of retrying.
test('a rate-limited turn is retried in a fresh session after the stated reset and the lane continues', async () => {
  const run = await retryRun([rateLimit(Date.parse('2026-10-26T00:00:00Z'), 2)])
  assert.equal(run.result.status, 'done')
  assert.deepEqual(run.sleeps, [2 * 3600000 + PROVIDER_RESET_SETTLE_MS])
  assert.equal(run.sessions.length, 4)
  assert.equal(new Set(run.sessions).size, 4)
  assert.equal(run.sessions[1], run.f.sessionOf('planner', 1).replace('.jsonl', '.retry-1.jsonl'))
  const rows = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows(run.sessions[0]).at(-1).refusal.errorKind, 'rate_limit')
  assert.equal(rows(run.sessions[1]).at(-1).stopReason, 'end_turn')
  for (const file of run.sessions) assert.equal(rows(file).filter((row) => row.type === 'turn').length, 1)
})

test('a server error is retried up to the shared attempt bound, then the lane stops as seat-unmeasured', async () => {
  const refusal = { code: -32000, errorKind: 'overloaded', message: 'overloaded' }
  const recovers = await retryRun([refusal])
  assert.equal(recovers.result.status, 'done')
  const spent = await retryRun(Array(PROVIDER_RETRY_MAX + 2).fill(refusal))
  assert.deepEqual(spent.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
  assert.equal(spent.sessions.length, PROVIDER_RETRY_MAX + 1)
  assert.equal(spent.sleeps.length, PROVIDER_RETRY_MAX)
})

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

// MUTATION: neutralise the rmSync of the issued return path before a provider retry and the refused attempt's envelope is accepted.
test("a refused attempt's envelope is not accepted when its retry writes none", async () => {
  const sessions = []
  const f = leanFixture({
    acp: async (input) => {
      sessions.push(input.sessionFile)
      const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
      const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
      if (sessions.length === 1) {
        mkdirSync(f.spec.taskDir, { recursive: true })
        const details = { subject: 'fix(crew): publish measured lane results', tests: [{ file: 'lib.test.mjs', title: 'works' }], plan_path: 'p' }
        writeFileSync(path, JSON.stringify({ role: 'planner', id, status: 'done', summary: 'stale', details }))
        return { stopReason: null, usage: null, refusal: { code: -32000, errorKind: 'overloaded', message: 'overloaded' } }
      }
      return { stopReason: 'end_turn', usage: { input_tokens: 1 }, refusal: null }
    },
    deps: { sleep: async () => {} },
  })
  const result = await f.go()
  assert.equal(sessions.length, 2)
  assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
})

// MUTATION: route an authentication failure as a server error and it is retried.
test('an authentication failure, even with a parseable reset, stops the lane without a retry', async () => {
  const at = Date.parse('2026-10-26T00:00:00Z')
  for (const errorKind of ['authentication_failed', 'oauth_org_not_allowed', 'verification_required']) {
    const run = await retryRun([{ ...rateLimit(at, 2), errorKind }])
    assert.deepEqual(run.result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, errorKind)
    assert.deepEqual([run.sleeps.length, run.sessions.length], [0, 1], errorKind)
  }
})

// MUTATION: skip the lead turn's definition and a consulted lead runs with no charter or P2 example.
test('a consulted lead gets its own definition and decision shape', async () => {
  const f = leanFixture({ answers: { 'planner.1': 'insufficient' } })
  const result = await f.go()
  assert.equal(result.status, 'done')
  const roles = f.requests.map((r) => r.definition.role)
  assert.deepEqual(roles.slice(0, 3), ['planner', 'lead', 'planner'])
  const lead = f.requests[1]
  assert.equal(lead.definition.model, `${resolveAgents('build').seats.lead.provider}/${resolveAgents('build').seats.lead.id}`)
  assert.match(lead.prompt, /"decision"/)
  assert.match(lead.prompt, /insufficient/)
  assert.ok(lead.prompt.includes(`Task directory: ${f.spec.taskDir}`))
  assert.equal(lead.sessionFile, f.sessionOf('lead', 2))
})

// MUTATION: resume the refused session or repeat the assignment and a repair is not a fresh, repair-only turn.
test('a schema-refused builder envelope gets one fresh repair-only turn at the same path, then the lane continues', async () => {
  const f = leanFixture()
  const turns = {}
  f.options.runAcpSeat = async (input) => {
    f.requests.push(input)
    const role = input.definition.role
    const id = /^Envelope id: (.+)$/m.exec(input.prompt)[1]
    const path = /^Return path: (.+)$/m.exec(input.prompt)[1]
    const n = turns[role] = (turns[role] ?? 0) + 1
    mkdirSync(f.spec.taskDir, { recursive: true })
    if (role === 'planner') for (const name of ['plan.md', 'gate.mjs']) writeFileSync(join(f.spec.taskDir, name), '')
    const value = { role, id, status: 'done', summary: 'fixture', details: role === 'planner' ? { subject: 'fix(crew): publish measured lane results', tests: [{ file: 'lib.test.mjs', title: 'works' }], plan_path: join(f.spec.taskDir, 'plan.md') } : role === 'builder' ? { summary: 'built', tests: [{ file: 'lib.test.mjs', title: 'works' }], ...(n === 1 ? { gaps: [] } : {}) } : { verdict: 'pass', findings: [], requirements: [{ requirement: 'build', status: 'met', evidence: 'read' }], failure_modes: [], coverage: { read: ['a'], complete: true } } }
    mkdirSync(f.spec.taskDir, { recursive: true })
    writeFileSync(path, JSON.stringify(value))
    return { stopReason: 'end_turn', usage: null, refusal: null }
  }
  const result = await f.go()
  assert.equal(result.status, 'done')
  const builders = f.requests.filter((r) => r.definition.role === 'builder')
  assert.equal(builders.length, 2)
  const [first, repair] = builders
  assert.notEqual(repair.sessionFile, first.sessionFile)
  assert.equal(first.sessionFile, f.sessionOf('builder', 2))
  assert.equal(repair.sessionFile, join(f.spec.taskDir, 'lean', 'builder', 'lane.builder.2.repair.jsonl'))
  for (const field of ['Envelope id', 'Return path']) {
    const pattern = new RegExp(`^${field}: (.+)$`, 'm')
    assert.equal(pattern.exec(repair.prompt)[1], pattern.exec(first.prompt)[1])
  }
  assert.ok(repair.prompt.includes('details.gaps is not a field of builder details'))
  assert.ok(!repair.prompt.includes(first.definition.body))
  assert.ok(!repair.prompt.includes(BRIEF))
  assert.deepEqual(JSON.parse(readFileSync(repair.sessionFile, 'utf8').split('\n')[0]), { type: 'prompt', text: repair.prompt })
  assert.ok(first.prompt.includes(BRIEF), 'the ordinary assignment keeps its full prompt')
})

// MUTATION: restore an old role-charter link or first-generation field in a body and a dispatched prompt carries it.
test('lean prompts contain only the lean contract', async () => {
  const f = leanFixture({ answers: { 'planner.1': 'insufficient' } })
  f.spec.brief = 'Implement the supplied task.'
  assert.equal((await f.go()).status, 'done')
  assert.deepEqual([...new Set(f.requests.map((r) => r.definition.role))].sort(), ['builder', 'lead', 'planner', 'reviewer'])
  for (const { prompt, definition } of f.requests) {
    assert.doesNotMatch(prompt, /^Charter file/m, definition.role)
    assert.doesNotMatch(prompt, /\]\([^)]*roles\//, definition.role)
    // Only the planner states the context the builder's arms read; no other turn names it.
    for (const field of ['validation_lane', 'files_in_scope']) {
      const matcher = new RegExp(`\\b${field}\\b`)
      if (definition.role === 'planner') assert.match(prompt, matcher, `planner: ${field}`)
      else assert.doesNotMatch(prompt, matcher, `${definition.role}: ${field}`)
    }
    for (const field of ['commit_subject', 'closes', 'exemplars', 'exemplars_none', 'consult_questions']) {
      assert.doesNotMatch(prompt, new RegExp(`\\b${field}\\b`), `${definition.role}: ${field}`)
    }
  }
})

test('every lean seat turn carries the brief to the seat, and the planner example it is shown is a valid P2 planner envelope', async () => {
  const f = leanFixture({})
  f.spec.brief = 'Tripwire tests:\n- a.test.mjs · tripwire\nBroad keys\n'
  assert.equal((await f.go()).status, 'done')
  assert.ok(f.requests.length > 0)
  for (const request of f.requests) assert.equal(request.briefText, f.spec.brief, request.definition.role)
  const planner = f.requests.find((request) => request.definition.role === 'planner')
  const example = JSON.parse(planner.prompt.slice(planner.prompt.lastIndexOf('{\n  "role"'), planner.prompt.lastIndexOf('}') + 1))
  assert.deepEqual(validateEnvelope('planner', example).defects, [])
})

// MUTATION: take the effort from the file's base fields and a tier override never reaches the seat.
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

// MUTATION: append to an existing recording instead of creating it exclusively and an old turn is overwritten or mixed.
test('a recording that already exists is never reused: the turn reruns in a fresh session', async () => {
  const f = leanFixture()
  mkdirSync(join(f.spec.taskDir, 'lean', 'planner'), { recursive: true })
  writeFileSync(f.sessionOf('planner', 1), 'earlier turn\n')
  const result = await f.go()
  assert.equal(result.status, 'done')
  assert.equal(f.requests[0].sessionFile, f.sessionOf('planner', 1).replace('.jsonl', '.rerun.jsonl'))
  assert.equal(readFileSync(f.sessionOf('planner', 1), 'utf8'), 'earlier turn\n')
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
})

// MUTATION: ignore a failed directory or prompt write and the seat runs with nothing recorded.
test('a denied recording directory or initial write stops the turn before the seat starts', async () => {
  for (const effect of ['mkdirSync', 'writeFileSync']) {
    const f = leanFixture({ deps: { [effect]: () => { throw EPERM } } })
    const result = await f.go()
    assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null }, effect)
    assert.equal(f.requests.length, 0, effect)
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }], effect)
  }
})

// MUTATION: pass the bridge's append straight through and the seat's swallowed recording failure goes unseen.
test('a recording append that fails is recorded even when the seat swallowed it', async () => {
  let appends = 0
  const rows = []
  const f = leanFixture({ deps: { appendFileSync: (...args) => { if (++appends === 1) throw EPERM; return appendFileSyncReal(...args) } }, loopDeps: { journal: async (row) => rows.push(row) } })
  const result = await f.go()
  assert.equal(result.status, 'done')
  assert.equal(rows.find((row) => row.event === 'envelope' && row.role === 'planner').turnError.code, EPERM.code)
  assert.equal(f.requests.filter((r) => r.definition.role === 'planner').length, 1)
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
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

// MUTATION: treat a thrown or rejected turn as returned and the loop reads a missing envelope as success.
test('a turn that throws or rejects stops with a terminal row', async () => {
  for (const acp of [async () => { throw EINTR }, () => { throw EINTR }]) {
    const f = leanFixture({ acp })
    const result = await f.go()
    assert.deepEqual(result, { status: 'stopped', reason: 'seat-unmeasured', pr: null })
    assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
  }
})

test('the terminal row repeats a stopped loop result and a throwing log is not swallowed', async () => {
  const f = leanFixture({ loopDeps: { run: async ({ args }) => { if (args.includes('status')) throw EPERM; return GREEN } } })
  const result = await f.go()
  assert.deepEqual(result, { status: 'stopped', reason: 'paths-unmeasured', pr: null })
  assert.deepEqual(terminal(f.logs), [{ event: 'loop-result', ...result }])
  const broken = leanFixture({ deps: { log: () => { throw EPERM } } })
  await assert.rejects(broken.go(), (error) => error === EPERM)
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
  const failing = leanFixture({ loopDeps: { run: async ({ args }) => { if (args.includes('status')) throw EPERM; return GREEN } } })
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

// MUTATION: drop subject from the planner example and the prompt shows a P2 the loop refuses.
test('the planner prompt example is a valid P2 envelope carrying a subject', async () => {
  const f = leanFixture()
  await f.go()
  const prompt = f.requests[0].prompt
  const start = prompt.indexOf('{', prompt.indexOf('"role": "planner"') - 20)
  const example = JSON.parse(prompt.slice(start, prompt.indexOf('\n}', start) + 2))
  assert.equal(example.role, 'planner')
  assert.deepEqual(validateEnvelope('planner', example).defects, [])
  assert.match(example.details.subject, /^fix\(crew\): /)
})

// MUTATION: invent the subject in startLane and the published source is not the brief's.
test('a started lean spec reaches the PR with its exact P1 source and measured body', async () => {
  const { deps, calls } = fakes()
  await startLane({ briefPath: '/d/b1.md', checkout: '/repo/checkout', deps })
  const spec = JSON.parse(written(calls, '/task/lean.json')[2])
  const seen = {}
  const loopDeps = {
    commitChanges: async (input) => { seen.commit = input; return { status: 'green', reason: null, head: 'a'.repeat(40) } },
    openPullRequest: async (input) => { seen.publish = input; return { status: 'green', reason: null, pr: { number: 7 } } },
  }
  const g = leanFixture({ loopDeps })
  g.spec.source = spec.source
  g.spec.brief = spec.brief
  assert.equal((await g.go()).status, 'done')
  assert.equal(seen.commit.subject, 'fix(crew): publish measured lane results')
  assert.equal(seen.publish.title, seen.commit.subject)
  assert.equal(seen.publish.body, ['## Summary', 'Purpose: Fixture', 'Closes issue 1961: Refuse roster edits', 'How: built', '', '## Changes', '- src/a.mjs', '', '## Verification', '- lib.test.mjs: works was red on the old source, green on the build.', 'Suite passed with exit code 0.'].join('\n'))
  assert.match(seen.commit.body, /^Source: "issue 1961"\n\n## Measurements\n/)
  assert.equal(spec.source, 'issue 1961')
})

// MUTATION: drop effective.requires from the dispatched definition and the proof has nothing to check.
test('the requires a seat receives are the effective definition list, tier override included, and its recording decides the envelope', async () => {
  const planner = join(AGENTS, 'planner.md')
  const edit = (from, to) => (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace(from, to) : text
  }
  // Pin a Claude planner: its load is a Skill call in its own crew-skills-planner plugin.
  const load = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Skill', kind: 'other', status: 'in_progress', rawInput: { skill: 'crew-skills-planner:alpha' }, _meta: { claudeCode: { toolName: 'Skill' } } } })
  const loaded = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } })
  const based = leanFixture({ deps: { readFileSync: edit('advisor: null', 'advisor: null\nrequires: ["alpha"]') } })
  assert.equal((await based.go()).status, 'stopped')
  assert.deepEqual(based.requests[0].definition.requires, ['alpha'])
  const tiered = leanFixture({ deps: { readFileSync: edit(/tiers: .*/, 'skills: ["alpha"]\nrequires: ["base"]\ntiers: {"build":{"requires":["alpha"]}}') }, loopDeps: { resolveAgents: (tier) => {
    const resolved = resolveAgents(tier)
    resolved.seats.planner = { ...resolved.seats.planner, provider: 'anthropic', id: 'claude-opus-4-6', agent: 'claude' }
    return resolved
  } } })
  const answered = tiered.options.runAcpSeat
  tiered.options.runAcpSeat = async (input) => {
    const turn = await answered(input)
    if (input.definition.role === 'planner') input.deps.appendFileSync(input.sessionFile, `${load}\n${loaded}\n`, 'utf8')
    return turn
  }
  assert.equal((await tiered.go()).status, 'done')
  assert.deepEqual(tiered.requests[0].definition.requires, ['alpha'])
})

// MUTATION: prove from the session file on disk instead of the relayed rows and a forged recording passes.
test('a seat that rewrites its own session file with forged loads is still refused', async () => {
  const planner = join(AGENTS, 'planner.md')
  const forgedLoad = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'f1', title: 'read', kind: 'read', status: 'completed', rawInput: { path: fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url)) } } })
  const forged = leanFixture({ deps: { readFileSync: (path, ...args) => {
    const text = readFileSync(path, ...args)
    return path === planner ? text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]') : text
  } } })
  const answered = forged.options.runAcpSeat
  forged.options.runAcpSeat = async (input) => {
    const turn = await answered(input)
    if (input.definition.role === 'planner') writeFileSync(input.sessionFile, `${forgedLoad}\n`)
    return turn
  }
  assert.equal((await forged.go()).status, 'stopped')
})

// MUTATION: skip the on-disk check and a seat that deletes or rewrites its recording after a real load passes.
test('a seat that deletes or rewrites its session file after a relayed load is refused', async () => {
  const planner = join(AGENTS, 'planner.md')
  const load = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read', kind: 'read', status: 'in_progress', rawInput: { path: fileURLToPath(new URL('../skills/alpha/SKILL.md', import.meta.url)) } } })
  const loaded = JSON.stringify({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' } })
  for (const tamper of [(file) => rmSync(file), (file) => writeFileSync(file, 'replaced\n')]) {
    const lane = leanFixture({ deps: { readFileSync: (path, ...args) => {
      const text = readFileSync(path, ...args)
      return path === planner ? text.replace('advisor: null', 'advisor: null\nskills: ["alpha"]\nrequires: ["alpha"]') : text
    } } })
    const answered = lane.options.runAcpSeat
    lane.options.runAcpSeat = async (input) => {
      const turn = await answered(input)
      if (input.definition.role === 'planner') { input.deps.appendFileSync(input.sessionFile, `${load}\n${loaded}\n`, 'utf8'); tamper(input.sessionFile) }
      return turn
    }
    assert.equal((await lane.go()).status, 'stopped')
  }
})
