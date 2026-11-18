import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, showLane } from './show.mjs'
import { scratchDir } from '../test/helpers.mjs'

const SHOW = fileURLToPath(new URL('./show.mjs', import.meta.url))
const frame = (update) => `${JSON.stringify({ sessionId: 's', update })}\n`
const chunk = (sessionUpdate, text) => frame({ sessionUpdate, content: { type: 'text', text } })
const RAW = chunk('agent_message_chunk', 'hello')
const MEMBERS = {
  builder: { agent: 'claude', model: 'claude-sonnet-5-5', transport: 'lean-acp' },
  reviewer: { agent: 'claude', model: 'claude-opus-5', transport: 'lean-acp' },
  planner: { agent: 'pi', model: 'openai-codex/gpt-6.1-sol', transport: 'lean-acp' },
  lead: { agent: 'pi', model: 'openai-codex/gpt-6-astra', transport: 'lean-acp' },
}

function put(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

function lane(crewRoot, name, { suffix = '', members = MEMBERS, turns } = {}) {
  const dir = join(crewRoot, `dt-${name}`, `${name}${suffix}`)
  put(join(dir, 'crew.json'), JSON.stringify({ members }))
  for (const [role, turn, raw] of turns ?? [['builder', 1, RAW], ['reviewer', 1, RAW], ['planner', 1, RAW]]) {
    put(join(dir, 'task', 'lean', role, `${name}.${role}.${turn}.jsonl`), raw)
  }
  return dir
}

function fixture() {
  const home = scratchDir('crew-show-')
  const crewRoot = join(home, '.crew')
  return { home, crewRoot }
}

const cli = (home, args) => spawnSync(process.execPath, [SHOW, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 })

// Names, kinds, modes, mtimes and bytes; atimes move on every read, so they stay out.
function fingerprint(root) {
  const rows = []
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name)
      const stat = lstatSync(file)
      rows.push([file.slice(root.length), stat.mode, stat.mtimeMs, stat.isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : stat.isSymbolicLink() ? readlinkSync(file) : null])
      if (stat.isDirectory()) walk(file)
    }
  }
  walk(root)
  return JSON.stringify(rows)
}

test('S6-2 a lane raised to judge lists and renders the tech-lead seat its raise added, from the row seats or its recordings', () => {
  const { crewRoot } = fixture()
  const members = { planner: MEMBERS.planner, builder: MEMBERS.builder, reviewer: MEMBERS.reviewer }
  for (const [name, seats] of [
    ['raised1', { ...members, lead: { agent: null, model: null, effort: null }, 'tech-lead': { agent: 'claude', model: 'anthropic/claude-opus-5', effort: 'high' } }],
    ['raised2', undefined],
  ]) {
    const dir = lane(crewRoot, name, { members, turns: [['tech-lead', 1, RAW]] })
    put(join(dir, 'task/journal.jsonl'), `${JSON.stringify({ event: 'tier-raised', lane: name, stage: 'plan', from: 'build', to: 'judge', reason: 'protected-path', paths: ['crew/loop.mjs'], seats, at: 1 })}\n{torn`)
  }
  lane(crewRoot, 'plain', { members, turns: [['other', 1, RAW]] })
  const before = fingerprint(crewRoot)
  for (const [name, metadata] of [['raised1', 'claude  anthropic/claude-opus-5'], ['raised2', 'unknown  unknown']]) {
    const out = [], err = []
    const deps = { crewRoot, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }
    assert.equal(main([name, 'tech-lead'], deps), 0, err.join(''))
    assert.match(out.join(''), /ASSISTANT\nhello/)
    out.length = 0
    assert.equal(main([name], deps), 0, err.join(''))
    assert.ok(out.join('').includes(`tech-lead  ${metadata}  lean-acp`))
    assert.doesNotMatch(out.join(''), /^lead  /m)
    assert.ok(out.join('').indexOf('reviewer  ') < out.join('').indexOf('tech-lead  '))
  }
  assert.doesNotMatch(showLane({ lane: 'plain', deps: { crewRoot } }), /^other  /m)
  assert.equal(fingerprint(crewRoot), before)
})

test('CS1 a closed-out lane resolves from the journal archive beside the crew root (S3-6)', () => {
  const { home, crewRoot } = fixture()
  const dir = lane(join(home, '.crew-journal-archive'), 'closed', { turns: [['builder', 1, RAW]] })
  put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: 'closed' }))
  let listing
  assert.doesNotThrow(() => { listing = showLane({ lane: 'closed', deps: { crewRoot } }) })
  assert.match(listing, /builder.*lean-acp/)
  assert.match(showLane({ lane: 'closed', role: 'builder', deps: { crewRoot } }), /ASSISTANT\nhello/)
})

test('CS4 bad arity and options print one usage line and exit 2, before any lane is read', () => {
  const lines = []
  const deps = { stdout: () => assert.fail('wrote output'), stderr: (text) => lines.push(text), crewRoot: '/nonexistent' }
  for (const argv of [[], ['a', 'b', 'c'], ['a', '--wat'], ['a', '--json'], ['a', 'b', '--json', '--json'], ['--json'], ['a', 'b', '-x']]) {
    assert.equal(main(argv, deps), 2, JSON.stringify(argv))
  }
  assert.deepEqual([...new Set(lines)], ['usage: crew show <lane> [<role>] [--json]\n'])
})

test('CS4 a lane or role that could name another path is refused, not resolved', () => {
  const { crewRoot } = fixture()
  lane(crewRoot, 'pi')
  put(join(crewRoot, 'secret.txt'), 'x')
  for (const bad of ['../x', 'a/b', '.', 'UPPER', '']) assert.throws(() => showLane({ lane: bad, deps: { crewRoot } }), /is not a lane name/, bad)
  for (const bad of ['../planner', 'a/b', '..', '']) assert.throws(() => showLane({ lane: 'pi', role: bad, deps: { crewRoot } }), /is not a role name/, bad)
  assert.throws(() => showLane({ lane: 'pi', role: 'constructor', deps: { crewRoot } }), /has no role constructor/)
  assert.throws(() => showLane({ lane: 'pi', json: true, deps: { crewRoot } }), /--json needs a role/)
})

test('CS4 unreadable crew metadata is a refusal, never an empty roster', () => {
  const { crewRoot } = fixture()
  const dirOf = (name) => join(crewRoot, `dt-${name}`, name)
  for (const [name, crewJson, reason] of [
    ['bad-json', '{ not json', /crew\.json is not valid JSON/],
    ['no-members', '{}', /has no members object/],
    ['array-members', '{"members":[]}', /has no members object/],
    ['empty-members', '{"members":{}}', /lists no members/],
    ['scalar-member', '{"members":{"builder":3}}', /member builder .* is not an object/],
    ['unsafe-member', '{"members":{"../x":{}}}', /names unsafe member/],
  ]) {
    put(join(dirOf(name), 'crew.json'), crewJson)
    assert.throws(() => showLane({ lane: name, deps: { crewRoot } }), reason, name)
  }
  mkdirSync(dirOf('no-file'), { recursive: true })
  assert.throws(() => showLane({ lane: 'no-file', deps: { crewRoot } }), /crew\.json is missing/)
})

test('CS4 the CLI reports a refusal from main as one sanitized line and returns 1', () => {
  const { crewRoot } = fixture()
  lane(crewRoot, 'tau')
  const out = []
  const err = []
  const deps = { crewRoot, stdout: (text) => out.push(text), stderr: (text) => err.push(text) }
  assert.equal(main(['tau', 'nobody\nline'], deps), 1)
  assert.equal(err.join(''), 'crew show: "nobody\\nline" is not a role name\n')
  assert.equal(main(['tau', 'planner', '--json'], deps), 0)
  assert.equal(out.join(''), RAW)
  err.length = 0
  put(join(crewRoot, 'dt-ctl', 'ctl', 'crew.json'), '{"members":{"b":{}}}')
  assert.equal(main(['ctl'], deps), 0)
  assert.equal(main(['absent'], deps), 1)
  assert.equal(err.length, 1)
  assert.match(err[0], /^crew show: [^\n]*\n$/)
})

// MUTATION: write a file beside the raw return and the crew tree fingerprint changes.
test('CS6 listing, text and --json reads of live and archived lanes leave the crew tree untouched', () => {
  const { home, crewRoot } = fixture()
  lane(crewRoot, 'upsilon')
  lane(crewRoot, 'phi', { suffix: '.archive-2026-10-24T16-59-50-798Z' })
  const before = fingerprint(crewRoot)
  assert.ok(before.length > 100)
  for (const [args, status] of [[['upsilon'], 0], [['upsilon', 'builder'], 0], [['upsilon', 'planner', '--json'], 0], [['phi'], 0], [['phi', 'reviewer'], 0], [['phi', 'builder', '--json'], 0], [['absent'], 1], [['upsilon', 'lead'], 1]]) {
    const out = cli(home, args)
    assert.equal(out.status, status, `${args.join(' ')}: ${out.stderr}`)
  }
  assert.equal(fingerprint(crewRoot), before)
  assert.deepEqual(readdirSync(home), ['.crew'])
})

const LEAN = { builder: { agent: 'pi', model: 'test/model', transport: 'lean-acp' }, reviewer: { agent: 'claude', model: 'claude-opus-5', transport: 'lean-acp' } }

function leanLane(crewRoot, name, turns, { suffix = '' } = {}) {
  const dir = join(crewRoot, `dt-${name}`, `${name}${suffix}`)
  put(join(dir, 'crew.json'), JSON.stringify({ members: LEAN }))
  for (const [role, turn, raw] of turns) put(join(dir, 'task', 'lean', role, `${name}.${role}.${turn}.jsonl`), raw)
  return dir
}

// MUTATION: sort the lean turn files lexically and turn 10 renders before turn 2.
test('WL7 lean ACP turns list and render per role in numeric order, chunks joined, --json bytes untouched', () => {
  const { crewRoot } = fixture()
  const prompt = (text) => `${JSON.stringify({ type: 'prompt', text })}\n`
  const second = prompt('PROMPT-TEN') + chunk('agent_message_chunk', 'ten ') + chunk('agent_message_chunk', 'done')
  const first = prompt('PROMPT-TWO') + chunk('agent_thought_chunk', 'hm') + chunk('agent_thought_chunk', 'mm') + chunk('agent_message_chunk', 'two')
    + frame({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read file', rawInput: { path: 'a.mjs' } })
    + frame({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'text', text: 'ok' }] })
    + frame({ sessionUpdate: 'usage_update', used: 3 })
    + chunk('user_message_chunk', 'echo')
  leanLane(crewRoot, 'lean1', [['builder', 10, second], ['builder', 2, first], ['reviewer', 1, prompt('REVIEW')]])
  // Files that are not this role's turns are ignored.
  put(join(crewRoot, 'dt-lean1', 'lean1', 'task', 'lean', 'builder', 'lean1.reviewer.3.jsonl'), 'ignored')
  put(join(crewRoot, 'dt-lean1', 'lean1', 'task', 'lean', 'builder', 'notes.txt'), 'ignored')
  const before = fingerprint(crewRoot)
  assert.equal(showLane({ lane: 'lean1', deps: { crewRoot } }), [
    'builder  pi  test/model  lean-acp',
    '  task/lean/builder/lean1.builder.2.jsonl',
    '  task/lean/builder/lean1.builder.10.jsonl',
    'reviewer  claude  claude-opus-5  lean-acp',
    '  task/lean/reviewer/lean1.reviewer.1.jsonl',
    '',
  ].join('\n'))
  const text = showLane({ lane: 'lean1', role: 'builder', deps: { crewRoot } })
  assert.ok(text.indexOf('PROMPT-TWO') < text.indexOf('PROMPT-TEN'))
  assert.match(text, /THINKING\nhmmm\n\nASSISTANT\ntwo/)
  assert.match(text, /ASSISTANT\nten done/)
  assert.match(text, /TOOL Read file tc1\n\{\n  "path": "a\.mjs"\n\}/)
  assert.match(text, /TOOL UPDATE tc1 completed/)
  assert.match(text, /EVENT\n\{[^]*"usage_update"[^]*\}/)
  assert.match(text, /USER\necho/)
  assert.equal(showLane({ lane: 'lean1', role: 'builder', json: true, deps: { crewRoot } }), first + second)
  assert.equal(fingerprint(crewRoot), before)
})

// MUTATION: restore the bare-turn regex and the repair, rerun and retry files are absent.
test('WL7 lean ACP repair, rerun and retry session files list and render in the order they were recorded', () => {
  const { crewRoot } = fixture()
  const turns = ['1', '1.retry-1', '1.retry-2', '1.retry-10', '1.rerun', '1.rerun.retry-1', '1.repair', '1.repair.retry-1', '1.repair.rerun', '1.repair.rerun.retry-1', '2']
  const raw = (turn) => chunk('agent_message_chunk', turn)
  const dir = leanLane(crewRoot, 'lean6', [...turns].reverse().map((turn) => ['builder', turn, raw(turn)]))
  put(join(dir, 'task/lean/builder/lean6.builder.1.bogus.jsonl'), 'ignored')
  const rels = turns.map((turn) => `task/lean/builder/lean6.builder.${turn}.jsonl`)
  assert.equal(showLane({ lane: 'lean6', deps: { crewRoot } }), [
    'builder  pi  test/model  lean-acp',
    ...rels.map((rel) => `  ${rel}`),
    'reviewer  claude  claude-opus-5  lean-acp',
    '  no session file recorded',
    '',
  ].join('\n'))
  const text = showLane({ lane: 'lean6', role: 'builder', deps: { crewRoot } })
  assert.deepEqual([...text.matchAll(/^=== (.+) ===$/gm)].map((match) => match[1]), rels)
  assert.equal(showLane({ lane: 'lean6', role: 'builder', json: true, deps: { crewRoot } }), turns.map(raw).join(''))
})

test('WL7 lean ACP archives resolve, and absent, empty, malformed and unreadable recordings are told apart', () => {
  const { crewRoot } = fixture()
  leanLane(crewRoot, 'lean2', [['builder', 1, chunk('agent_message_chunk', 'archived')]], { suffix: '.archive-2026-10-24T16-59-50-798Z' })
  assert.match(showLane({ lane: 'lean2', role: 'builder', deps: { crewRoot } }), /ASSISTANT\narchived/)
  leanLane(crewRoot, 'lean3', [['builder', 1, '']])
  assert.throws(() => showLane({ lane: 'lean3', role: 'reviewer', deps: { crewRoot } }), /role reviewer has no session: no session file recorded/)
  assert.throws(() => showLane({ lane: 'lean3', role: 'builder', deps: { crewRoot } }), /recorded no events/)
  leanLane(crewRoot, 'lean4', [['builder', 1, `${chunk('agent_message_chunk', 'a')}{"sessionId":`]])
  assert.throws(() => showLane({ lane: 'lean4', role: 'builder', deps: { crewRoot } }), /lean4\.builder\.1\.jsonl line 2 is not a complete JSON record/)
  assert.equal(showLane({ lane: 'lean4', role: 'builder', json: true, deps: { crewRoot } }).endsWith('{"sessionId":'), true)
  leanLane(crewRoot, 'lean5', [['builder', 1, chunk('agent_message_chunk', 'x')]])
  for (const code of ['EACCES', 'EINTR', 'EPERM']) {
    const denied = (needle, fn) => (path, ...rest) => { if (String(path).includes(needle)) throw Object.assign(new Error(code), { code }); return fn(path, ...rest) }
    assert.throws(() => showLane({ lane: 'lean5', deps: { crewRoot, readdirSync: denied(join('task', 'lean', 'builder'), readdirSync) } }), new RegExp(`cannot read .*builder: ${code}`), code)
    assert.throws(() => showLane({ lane: 'lean5', role: 'builder', deps: { crewRoot, readFileSync: denied('lean5.builder.1.jsonl', readFileSync) } }), new RegExp(`lean5\\.builder\\.1\\.jsonl: ${code}`), code)
  }
})
