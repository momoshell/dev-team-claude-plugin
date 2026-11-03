import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
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

// MUTATION: restore the headless-rpc branch of sessionsOf and the planner's old stream is listed.
test('a seat recorded on a retired transport lists no session file even when its old stream is on disk', () => {
  const { crewRoot } = fixture()
  const members = {
    builder: { agent: 'claude', model: 'sonnet', transport: 'headless-json' },
    planner: { agent: 'pi', model: 'test', transport: 'headless-rpc' },
  }
  const dir = lane(crewRoot, 'retired', { members, turns: [] })
  put(join(dir, 'task/headless/d1/cmd.json'), '{ nope')
  put(join(dir, 'task/headless/d1/stream.jsonl'), '{"type":"assistant"}\n')
  put(join(dir, 'task/headless-rpc/planner/stream.jsonl'), '{"type":"message_end"}\n')
  let listing
  assert.doesNotThrow(() => { listing = showLane({ lane: 'retired', deps: { crewRoot } }) })
  assert.equal(listing, [
    'builder  claude  sonnet  headless-json',
    '  no session file: transport headless-json records none this reads',
    'planner  pi  test  headless-rpc',
    '  no session file: transport headless-rpc records none this reads',
    '',
  ].join('\n'))
  for (const [role, transport] of [['builder', 'headless-json'], ['planner', 'headless-rpc']]) {
    assert.throws(() => showLane({ lane: 'retired', role, deps: { crewRoot } }), (error) => error.message === `lane retired role ${role} has no session: no session file: transport ${transport} records none this reads`)
  }
})

test('CS1 a seat with absent metadata prints unknown, and a transport nothing reads names that reason', () => {
  const { crewRoot } = fixture()
  lane(crewRoot, 'beta', { members: { solo: {}, scribe: { agent: 'x', transport: 'acp' } }, turns: [] })
  assert.equal(showLane({ lane: 'beta', deps: { crewRoot } }), [
    'solo  unknown  unknown  unknown',
    '  no session file: transport unknown records none this reads',
    'scribe  x  unknown  acp',
    '  no session file: transport acp records none this reads',
    '',
  ].join('\n'))
})

// MUTATION: always take the newest archive and the live lane's stale member would be shown instead.
test('CS1 the live directory wins over any archive and, once it is gone, the newest archive is the lane', () => {
  const { crewRoot } = fixture()
  lane(crewRoot, 'gamma', { members: { live: MEMBERS.builder }, turns: [] })
  lane(crewRoot, 'gamma', { suffix: '.archive-2099-01-01T00-00-00-000Z', members: { later: MEMBERS.builder }, turns: [] })
  assert.match(showLane({ lane: 'gamma', deps: { crewRoot } }), /^live /)
  lane(crewRoot, 'delta', { suffix: '.archive-2026-09-01T00-00-00-000Z', members: { older: MEMBERS.builder }, turns: [] })
  lane(crewRoot, 'delta', { suffix: '.archive-2026-10-24T16-59-50-798Z', members: { newer: MEMBERS.builder }, turns: [] })
  lane(crewRoot, 'delta', { suffix: '.archive-2026-10-02T00-00-00-000Z', members: { middle: MEMBERS.builder }, turns: [] })
  const out = showLane({ lane: 'delta', deps: { crewRoot } })
  assert.match(out, /^newer /)
  assert.doesNotMatch(out, /older|middle/)
})

test('CS1 a sibling lane whose name merely starts with this one is not its archive', () => {
  const { crewRoot } = fixture()
  put(join(crewRoot, 'dt-eps', 'eps-two', 'crew.json'), JSON.stringify({ members: { other: MEMBERS.builder } }))
  assert.throws(() => showLane({ lane: 'eps', deps: { crewRoot } }), /unknown lane eps/)
})

test('CS2 a record that is not an object prints as bare JSON instead of crashing the renderer', () => {
  const { crewRoot } = fixture()
  lane(crewRoot, 'theta-bare', { turns: [['builder', 1, 'null\n42\n"loose"\n']] })
  const out = showLane({ lane: 'theta-bare', role: 'builder', deps: { crewRoot } })
  assert.ok(out.endsWith('EVENT\nnull\n\nEVENT\n42\n\nEVENT\n"loose"\n'))
})

test('CS3 the CLI writes the --json bytes to stdout with nothing added', () => {
  const { home, crewRoot } = fixture()
  lane(crewRoot, 'mu')
  const out = cli(home, ['mu', 'planner', '--json'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, RAW)
  assert.equal(out.stderr, '')
})

// MUTATION: turn the sole refusal exit 1 into 0.
test('CS4 unknown lane, unknown role, a seat with no file and an empty file each exit 1 with one line naming the cause', () => {
  const { home, crewRoot } = fixture()
  lane(crewRoot, 'nu')
  lane(crewRoot, 'xi', { members: { planner: MEMBERS.planner }, turns: [] })
  put(join(crewRoot, 'dt-xi', 'xi', 'task', 'lean', 'planner', 'xi.planner.1.jsonl'), '')
  lane(crewRoot, 'omicron', { members: { planner: MEMBERS.planner }, turns: [] })
  put(join(crewRoot, 'dt-omicron', 'omicron', 'task', 'lean', 'planner', 'omicron.planner.1.jsonl'), ' \n\t\n')
  for (const [args, needle] of [
    [['absent-lane'], /unknown lane absent-lane/],
    [['nu', 'nobody'], /lane nu has no role nobody/],
    [['nu', 'lead'], /lane nu role lead has no session/],
    [['xi', 'planner'], /lane xi role planner recorded no events/],
    [['omicron', 'planner', '--json'], /lane omicron role planner recorded no events/],
  ]) {
    const out = cli(home, args)
    assert.equal(out.status, 1, args.join(' '))
    assert.equal(out.stdout, '')
    assert.match(out.stderr, /^crew show: /)
    assert.match(out.stderr, needle)
    assert.equal(out.stderr.trimEnd().split('\n').length, 1)
  }
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

test('CS4 text mode refuses a malformed record with its file and line, and prints nothing', () => {
  const { home, crewRoot } = fixture()
  lane(crewRoot, 'pi-bad', { turns: [] })
  put(join(crewRoot, 'dt-pi-bad', 'pi-bad', 'task', 'lean', 'planner', 'pi-bad.planner.1.jsonl'), `${RAW.split('\n')[0]}\n\n{"type":"message_end"\n`)
  const out = cli(home, ['pi-bad', 'planner'])
  assert.equal(out.status, 1)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /task\/lean\/planner\/pi-bad\.planner\.1\.jsonl line 3 is not a complete JSON record/)
})

// MUTATION: treat any read error as absence and a denied live directory falls through to the archive.
test('CS4 a denied or interrupted read is an error naming the path, never a missing lane or session', () => {
  const { crewRoot } = fixture()
  const live = lane(crewRoot, 'rho')
  lane(crewRoot, 'rho', { suffix: '.archive-2026-01-01T00-00-00-000Z' })
  const guard = (code, needle, fn) => (path, ...rest) => {
    if (String(path).includes(needle)) throw Object.assign(new Error(`${code}: ${path}`), { code })
    return fn(path, ...rest)
  }
  for (const code of ['EACCES', 'EINTR', 'EPERM']) {
    assert.throws(() => showLane({ lane: 'rho', deps: { crewRoot, statSync: guard(code, join('dt-rho', 'rho'), statSync) } }), new RegExp(`cannot read ${join(crewRoot, 'dt-rho', 'rho').replaceAll('\\', '\\\\')}: ${code}`), code)
    assert.throws(() => showLane({ lane: 'rho', deps: { crewRoot, readFileSync: guard(code, 'crew.json', readFileSync) } }), new RegExp(`crew\\.json: ${code}`), code)
    assert.throws(() => showLane({ lane: 'rho', role: 'planner', deps: { crewRoot, readFileSync: guard(code, 'rho.planner.1.jsonl', readFileSync) } }), new RegExp(`rho\\.planner\\.1\\.jsonl: ${code}`), code)
    assert.throws(() => showLane({ lane: 'rho', deps: { crewRoot, readdirSync: guard(code, join('task', 'lean', 'builder'), readdirSync) } }), new RegExp(`builder: ${code}`), code)
  }
  // The live lane is still intact: the guards, not the tree, caused each error.
  assert.match(showLane({ lane: 'rho', deps: { crewRoot } }), /^builder /)
  // A lane directory that cannot be listed hides its archives from a lane whose live directory is gone.
  const gone = join(crewRoot, 'dt-sigma')
  mkdirSync(gone, { recursive: true })
  assert.throws(() => showLane({ lane: 'sigma', deps: { crewRoot, readdirSync: guard('EACCES', 'dt-sigma', readdirSync) } }), /cannot read .*dt-sigma: EACCES/)
  assert.ok(statSync(live).isDirectory())
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

test('importing the module runs nothing and writes nothing', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(SHOW)})`], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
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
