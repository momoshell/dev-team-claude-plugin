// crew/adapter-pi.test.mjs — the adapter's own test home. The --provider
// invariant lives here because its omission is load-bearing behaviour that a
// well-intentioned edit would otherwise silently undo (#147).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, basename } from 'node:path'
import { acpLaunch, modelString, translateDeny, piActivatedTools, validatePiExtensionTools, PI_BUILTIN_TOOLS, PI_FIRST_PARTY_EXTENSION_TOOLS, PI_BUILTIN_EXTENSION_TOOLS, PI_MCP_SERVER_TOOLS, PI_PROVIDERS, PI_ADVISOR_EXTENSION } from './adapters/adapter-pi.mjs'
import * as pi from './adapters/adapter-pi.mjs'
import { ROOT } from '../test/helpers.mjs'
import { childArgs, resolvePiBinary } from './pi/extensions/subagent.ts'

const piSeatParts = (...args) => pi.piSeatParts(...args)

// MUTATION: restore policy in acpLaunch.
test('the pi adapter ships no capability profile, advisor cell, mcp path or launch policy', () => {
  for (const name of ['capabilitiesFor', 'advisorLaunchCell', 'mcpConfigPath', 'piRpcSeatParts']) assert.equal(name in pi, false)
  assert.equal(typeof pi.piSeatParts, 'function')
  assert.equal(Object.hasOwn(pi.acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {} }), 'policy'), false)
  assert.throws(() => pi.piActivatedTools({ extensions: ['/vendor/pkg/index.ts'], vendorExtensions: [{ package: 'vendor', tools: ['t'], entries: ['/vendor/pkg/index.ts'] }] }), /unknown-registering-extension/)
})

// Seat tool boundaries the pi seat command must translate (the retired driver's seat defaults).
const NO_FANOUT = 'Task,Agent,Workflow'
const ROLE_ORDER = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
const SEAT_DEFAULTS = Object.freeze({
  lead: { tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}` },
  planner: { tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit' },
  builder: { tools: 'Read,Edit,Write,Glob,Grep,Bash', deny: NO_FANOUT },
  reviewer: { tools: 'Read,Glob,Grep,Bash,Write', deny: 'Edit,NotebookEdit' },
  'tech-lead': { tools: 'Read,Glob,Grep,Bash,Write', deny: `Edit,NotebookEdit,${NO_FANOUT}` },
})

test('K7 and K8 MCP tools are pinned and unknown servers refuse', () => {
  // MUTATION: skip MCP table activation or its own-property guard.
  const expected = ['mcp__fff__find_files', 'mcp__fff__grep', 'mcp__fff__multi_grep']
  assert.deepEqual(piActivatedTools({ extensions: ['builtin:mcp'], mcpServers: [{ name: 'fff' }] }).filter((tool) => tool.startsWith('mcp__')), expected)
  assert.throws(() => piActivatedTools({ extensions: ['builtin:mcp'], mcpServers: [{ name: 'toString' }] }), (error) => error.reason === 'grant-unsupported' && error.message.includes('toString'))
  assert.deepEqual(PI_MCP_SERVER_TOOLS.fff, expected)
  assert.ok(Object.isFrozen(PI_MCP_SERVER_TOOLS) && Object.isFrozen(PI_MCP_SERVER_TOOLS.fff))
})
test('K15 and K16 MCP selects the deterministic rpc agent directory', () => {
  // MUTATION: restore configDir as the agent directory.
  const grants = { extensions: ['builtin:mcp'], mcp_servers: [{ name: 'fff', command: { bin: '/opt/homebrew/bin/fff-mcp', args: [] }, url: null }] }
  const expected = '/tmp/task/pi-agent/builder'
  const rpc = piSeatParts({ role: 'builder', taskDir: '/tmp/task', configDir: '/legacy', model: 'm', promptFile: 'p', grants })
  assert.equal(rpc.env.PI_CODING_AGENT_DIR, expected)
})
test('K17 ACP launch retains deterministic agent directory', () => {
  // MUTATION: override the launch env with spec.configDir.
  const launch = acpLaunch({ role: 'builder', taskDir: '/tmp/task', configDir: '/legacy', bin: '/opt/pi', model: 'm', promptFile: 'p', grants: { extensions: ['builtin:mcp'], mcp_servers: [{ name: 'fff', command: { bin: '/opt/homebrew/bin/fff-mcp', args: [] }, url: null }] } })
  assert.equal(launch.env.PI_CODING_AGENT_DIR, '/tmp/task/pi-agent/builder')
})

test('ADR047 M1 legacy cellless grant now loads extension and strips inherited rpc env', () => {
  const rpc = piSeatParts({ model: 'sonnet', promptFile: '/tmp/prompt', deny: '', grants: { advisor: true }, advisorCell: null, env: { CREW_ADVISOR_MODEL: 'inherited' } })
  assert.equal(rpc.args.includes(PI_ADVISOR_EXTENSION), true)
  assert.equal(Object.hasOwn(rpc.env, 'CREW_ADVISOR_MODEL'), false)
})
test('ADR047 M2 advisor cell transports canonical model and provenance', () => {
  const cell = { model: 'anthropic/claude-sonnet-5', models: { 'anthropic/claude-sonnet-5': {} } }
  const rpc = piSeatParts({ model: 'sonnet', promptFile: '/tmp/prompt', deny: '', grants: { advisor: true }, advisorCell: cell })
  assert.equal(rpc.args.includes(PI_ADVISOR_EXTENSION), true)
  assert.equal(Object.hasOwn(rpc.env, 'CREW_ADVISOR_MODEL'), false)
  assert.equal(Object.keys(rpc.env).filter((key) => key.startsWith('CREW_ADVISOR')).join(','), 'CREW_ADVISOR')
})

test('ADR47-L2 G1 null-cell advisor grant loads extension in rpc', () => {
  const grants = { advisor: true }
  const rpc = piSeatParts({ model: 'sonnet', promptFile: 'p', grants, advisorCell: null, env: {} })
  assert.ok(rpc.args.includes(PI_ADVISOR_EXTENSION))
})

test('ADR47-L2 G2 rpc and acp expose only advisor activation env', () => {
  const grants = { advisor: true, tools: [], extensions: [], agents: [], skills: [] }
  const cell = { model: 'provider/model', endpoint: 'http://sentinel.invalid' }
  const rpc = piSeatParts({ model: 'sonnet', promptFile: 'p', grants, advisorCell: cell, env: { CREW_ADVISOR_MODEL: 'inherited', CREW_ADVISOR_SENTINEL: 'secret' } })
  const acp = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'sonnet', promptFile: 'p', cwd: '/tmp', grants, advisorCell: cell, env: {} })
  assert.deepEqual(Object.keys(rpc.env).filter((key) => key.startsWith('CREW_ADVISOR')), ['CREW_ADVISOR'])
  assert.deepEqual(Object.keys(acp.env).filter((key) => key.startsWith('CREW_ADVISOR')), ['CREW_ADVISOR'])
})

// MUTATION: drop && key !== 'CREW_PI_AGENTS' from the piSeatParts passthrough filter, or drop the grants agents spread, and this test reddens.
test('PI_AGENTS inherited value is stripped and the grant-built value wins across rpc and ACP', () => {
  const evil = '[{"name":"evil","def":"/x.json"}]'
  const rpc = piSeatParts({ model: 'sonnet', promptFile: '/tmp/p', env: { SENTINEL: 'yes', CREW_PI_AGENTS: evil } })
  assert.deepEqual(rpc.env, { SENTINEL: 'yes', CREW_FFF: '0' })
  const acp = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'sonnet', promptFile: '/tmp/p', cwd: '/tmp', env: { SENTINEL: 'yes', CREW_PI_AGENTS: evil } })
  assert.equal(acp.env.CREW_PI_AGENTS, undefined)
  const granted = piSeatParts({ model: 'sonnet', promptFile: '/tmp/p', env: { CREW_PI_AGENTS: evil }, grants: { tools: [], extensions: ['/repo/crew/pi/extensions/subagent.ts'], agents: [{ name: 'scout', def: '/scout.json' }], skills: [] } })
  assert.equal(granted.env.CREW_PI_AGENTS, JSON.stringify([{ name: 'scout', def: '/scout.json' }]))
})

const SKELETONREAD_EXTENSION = join(ROOT, 'crew/pi/extensions/skeletonread.ts')
const RETRIEVE_TOOL = PI_FIRST_PARTY_EXTENSION_TOOLS['crew/pi/extensions/skeletonread.ts'][0]

const MODELS = ['sonnet', 'anthropic/claude-opus-5', 'openai-codex/gpt-5.6-luna']
const EFFORTS = [undefined, 'low', 'high', 'xhigh', 'max']

function* seatShapes() {
  for (const role of ROLE_ORDER)
    for (const model of MODELS)
      for (const effort of EFFORTS)
        yield {
          role, model, effort,
          promptFile: `/tmp/crew-task/role-${role}.md`,
          tools: SEAT_DEFAULTS[role].tools, deny: SEAT_DEFAULTS[role].deny,
          taskDir: '/tmp/crew-task', bootBrief: `Crew for task demo. Read your role, reply exactly ready: ${role}.`,
        }
}

function piOnPath() {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = join(directory || '.', 'pi')
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

test('ACP launch matrix, grants, all-denied policy, and refusal paths', () => {
  const bridge = join(ROOT, 'crew/pi/acp-bridge.mjs')
  const toolSet = 'read,bash,edit,write,grep,find,ls'
  const roles = [
    ['builder', 'Task,Agent,Workflow', [], ['bash', 'edit', 'write', 'powershell']],
    ['planner', 'Edit,NotebookEdit', ['edit'], ['bash', 'write', 'powershell']],
    ['tech-lead', 'Edit,NotebookEdit,Task,Agent,Workflow', ['edit'], ['bash', 'write', 'powershell']],
  ]
  for (const [role, deny, autoDeny, escalate] of roles) {
    const spec = { bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', role, deny, cwd: '/tmp', env: { SENTINEL: 'yes' } }
    const launch = acpLaunch(spec)
    assert.deepEqual(launch, {
      bin: process.execPath,
      args: [bridge, '--model', spec.model, '--append-system-prompt', spec.promptFile, '--tools', toolSet,
        ...(autoDeny.length ? ['--exclude-tools', autoDeny.join(',')] : []), '--no-context-files', '--no-extensions', '--no-skills'],
      env: { SENTINEL: 'yes', CREW_FFF: '0', CREW_PI_BIN: spec.bin, CREW_ACP_GATED_TOOLS: escalate.join(',') },
      sessionParams: { cwd: '/tmp', mcpServers: [] },
    }, role)
  }

  const bare = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', cwd: '/tmp', env: {} })
  assert.equal(bare.args.includes('-e'), false)
  assert.equal(Object.hasOwn(bare.env, 'CREW_ADVISOR_ENDPOINT'), false)
  const extension = join(ROOT, 'crew/pi/extensions/subagent.ts')
  const grants = { tools: [], extensions: [extension], agents: [{ name: 'scout', def: '/scout.json' }], skills: ['/skill.md'], advisor: true }
  const granted = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'openai-codex/x', promptFile: '/tmp/prompt.md', deny: 'Task', cwd: '/tmp', env: { SENTINEL: 'yes' }, grants, advisorCell: { endpoint: 'http://127.0.0.1:4567', model: 'openai-codex/advisor' } })
  const advisorExtension = join(ROOT, 'crew/pi/extensions/advisor.ts')
  assert.deepEqual(granted.args, [bridge, '--model', 'openai-codex/x', '--append-system-prompt', '/tmp/prompt.md', '--tools', `${toolSet},agent`, '--no-context-files', '--no-extensions', '-e', extension, '-e', advisorExtension, '--no-skills', '--skill', '/skill.md'])
  assert.deepEqual(granted.env, { SENTINEL: 'yes', CREW_FFF: '0', CREW_ADVISOR: '1', CREW_PI_AGENTS: JSON.stringify([{ name: 'scout', def: '/scout.json' }]), CREW_PI_BIN: '/opt/pi/dist/cli.js', CREW_ACP_GATED_TOOLS: 'bash,edit,write,powershell' })
  const unseatedAdvisor = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, grants: { ...grants, advisor: true } })
  assert.deepEqual(Object.keys(unseatedAdvisor.env).filter((key) => key.startsWith('CREW_ADVISOR')), ['CREW_ADVISOR'])
  assert.equal(unseatedAdvisor.args.includes(advisorExtension), true)

  // No Claude deny name maps to pi's ACP-only powershell gate; it remains gated.
  const allDenied = acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, deny: 'Bash,Edit,Write' })
  assert.equal(allDenied.env.CREW_ACP_GATED_TOOLS, 'powershell')
  assert.deepEqual(allDenied.args.slice(allDenied.args.indexOf('--exclude-tools'), allDenied.args.indexOf('--exclude-tools') + 2), ['--exclude-tools', 'bash,edit,write'])
  for (const name of ['Task', 'Agent', 'Workflow']) assert.doesNotThrow(() => acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/p', cwd: '/tmp', env: {}, deny: name }))
  for (const bin of ['pi', './pi']) assert.throws(() => acpLaunch({ bin }), /absolute/)
  assert.throws(() => acpLaunch({ bin: '/opt/pi/dist/cli.js', deny: 'Read,NoSuchTool' }), /NoSuchTool/)
})

test('SI4 granted pi RPC seats disable skill discovery before explicit grants', () => {
  // MUTATION: drop --no-skills from piSeatParts.
  const { args } = piSeatParts({ model: 'sonnet', promptFile: '/tmp/prompt', deny: '', env: {}, grants: { skills: ['/granted/code-less.md'] } })
  assert.equal(args.filter((arg) => arg === '--no-skills').length, 1)
  assert.deepEqual(args.slice(-3), ['--no-skills', '--skill', '/granted/code-less.md'])
})

test('ACP C4 a submit extension grant is refused: lean seats have no submit tool', () => {
  const extension = join(ROOT, 'crew/pi/extensions/submit.ts')
  assert.throws(() => acpLaunch({ bin: '/opt/pi/dist/cli.js', model: 'x', promptFile: '/tmp/prompt.md', cwd: process.cwd(), env: {}, grants: { tools: [], extensions: [extension], agents: [], skills: [], advisor: false } }), /unknown-registering-extension/)
})

test('PI_BUILTIN_TOOLS and every seat activator stay pinned to pi\'s complete built-in set', () => {
  const expected = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  assert.deepEqual(PI_BUILTIN_TOOLS, expected)
  let count = 0
  for (const shape of seatShapes()) {
    const { args } = piSeatParts(shape)
    assert.equal(args[args.indexOf('--tools') + 1], expected.join(','))
    count++
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length)
})

test('pi extension activation declares tools, preserves passive entries, and refuses unknown or malformed grants', () => {
  assert.deepEqual(
    piActivatedTools({
      extensions: ['/checkout/crew/pi/extensions/custom.ts'],
      table: { 'crew/pi/extensions/custom.ts': ['custom'] },
    }),
    [...PI_BUILTIN_TOOLS, 'custom'],
  )
  assert.deepEqual(piActivatedTools({ extensions: ['/repo/crew/pi/extensions/readgate.ts'] }), PI_BUILTIN_TOOLS)

  assert.throws(
    () => piSeatParts({
      role: 'planner', model: 'sonnet', promptFile: '/tmp/prompt.md', tools: '', deny: '', taskDir: '/tmp', bootBrief: 'boot',
      grants: { tools: [], extensions: ['/repo/crew/pi/extensions/unknown-registering-extension.ts'], agents: [], skills: [], advisor: false },
    }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('unknown-registering-extension'),
  )
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-array.ts': 'bad' }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('bad-array.ts') && error.message.includes('"bad"'),
  )
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-tool.ts': [42] }),
    (error) => error.reason === 'grant-unsupported' && error.message.includes('bad-tool.ts') && error.message.includes('42'),
  )
  // TL-G1 (must-fix at review, closed by hand at closeout). Before this, the only
  // two call sites in the repo passed 'bad' and [42], so `tool.trim() === ''` and
  // the non-object table guard were both VACUOUS: deleting either left the lane
  // and all 13 gate checks green while a whitespace tool name activated into
  // --tools, or a null table degraded into an incidental Object.entries TypeError
  // instead of a typed refusal. MUTATION: drop `|| tool.trim() === ''`, or the
  // table guard, and one half of this test goes red.
  for (const blank of ['', ' ', '\t', '\n  ']) {
    assert.throws(
      () => validatePiExtensionTools({ 'crew/pi/extensions/blank-tool.ts': [blank] }),
      (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'malformed-extension-declaration' && error.message.includes('blank-tool.ts'),
      `blank tool name ${JSON.stringify(blank)} must refuse`,
    )
  }
  for (const table of [null, undefined, 42, 'table', ['crew/pi/extensions/subagent.ts'], true]) {
    assert.throws(
      () => validatePiExtensionTools(table),
      (error) => error.reason === 'grant-unsupported' && error.diagnosis === 'malformed-extension-declaration' && error.message.includes('<table>'),
      `non-object table ${JSON.stringify(table)} must refuse by name, not throw incidentally`,
    )
  }
  // RV1-2: the diagnosis names the actual cause. Only a genuinely unknown
  // extension may claim 'unknown-registering-extension'; a declared-but-malformed
  // one previously reported that same token, and every assertion checking for it
  // passed on text the interpolated fixture path supplied anyway.
  assert.throws(
    () => validatePiExtensionTools({ 'crew/pi/extensions/bad-array.ts': null }),
    (error) => error.diagnosis === 'malformed-extension-declaration',
  )
  assert.throws(
    () => piActivatedTools({ extensions: ['/repo/crew/pi/extensions/nope.ts'] }),
    (error) => error.diagnosis === 'unknown-registering-extension',
  )
})

test('C1P keeps the subagent-only rpc activator', () => {
  const extension = join(ROOT, 'crew/pi/extensions/subagent.ts')
  const { args } = piSeatParts({ model: 'openai-codex/x', promptFile: '/tmp/prompt.md', grants: { extensions: [extension], agents: [{ name: 'scout', def: '/scout.json' }] } })
  assert.equal(args[args.indexOf('--tools') + 1], `${PI_BUILTIN_TOOLS.join(',')},agent`)
  assert.equal(args[args.indexOf('-e') + 1], extension)
  assert.doesNotMatch(args[args.indexOf('--tools') + 1], /retrieve|,lab(?:$|,)/)
})

test('E1 and H1 activate shipped rpc tools in extension order', () => {
  const builder = piSeatParts({ grants: { extensions: ['/repo/crew/pi/extensions/skeletonread.ts'] } }).args
  assert.equal(builder[builder.indexOf('--tools') + 1], `${PI_BUILTIN_TOOLS.join(',')},retrieve`)
  const planner = piSeatParts({ grants: { tools: ['Task'], extensions: ['/repo/crew/pi/extensions/subagent.ts', '/repo/crew/pi/extensions/readgate.ts'], agents: [{ name: 'scout', def: '/scout.json' }] } }).args
  assert.equal(planner[planner.indexOf('--tools') + 1], `${PI_BUILTIN_TOOLS.join(',')},Task,agent`)
})

test('PI_BUILTIN_TOOLS matches pi\'s bundle when pi is installed', (t) => {
  const command = piOnPath()
  if (!command) return t.skip('pi is not installed on PATH')

  let cliPath
  try { cliPath = realpathSync(command) } catch (error) {
    return t.skip(`could not realpath pi on PATH: ${error.message}`)
  }
  if (basename(cliPath) !== 'cli.js' || basename(dirname(cliPath)) !== 'dist') {
    return t.skip(`pi on PATH does not resolve to dist/cli.js: ${cliPath}`)
  }

  const toolsPath = join(dirname(cliPath), 'core', 'tools', 'index.js')
  let source
  try { source = readFileSync(toolsPath, 'utf8') } catch (error) {
    return t.skip(`could not read pi's built-in tool bundle at ${toolsPath}: ${error.message}`)
  }
  const declaration = source.match(/allToolNames\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/)
  if (!declaration) return t.skip(`pi's built-in tool declaration was not found in ${toolsPath}`)
  const parsed = [...declaration[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2])
  assert.deepEqual(new Set(parsed), new Set(PI_BUILTIN_TOOLS))
})

test('--provider never appears in any composed pi seat command', () => {
  let count = 0
  for (const shape of seatShapes()) {
    const { args } = piSeatParts(shape)
    assert.equal(args.some((arg) => arg === '--provider' || String(arg).startsWith('--provider=')), false)
    count++
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length)
})

test('the model id reaches pi whole, unnarrowed', () => {
  for (const model of MODELS) {
    const { args } = piSeatParts([...seatShapes()].find((candidate) => candidate.model === model))
    assert.equal(args[args.indexOf('--model') + 1], model)
  }
})

test('both deny branches are exercised by the seat matrix', () => {
  let excluded = 0; let omitted = 0
  for (const shape of seatShapes()) {
    const { args } = piSeatParts(shape); const translated = translateDeny(shape.deny)
    if (translated.includes('edit') && args[args.indexOf('--exclude-tools') + 1] === 'edit') excluded++
    if (translated.length === 0 && !args.includes('--exclude-tools')) omitted++
  }
  assert.ok(excluded > 0); assert.ok(omitted > 0)
})

test('both effort branches are exercised by the seat matrix', () => {
  let thinkingHigh = 0; let noThinking = 0
  for (const shape of seatShapes()) {
    const { args } = piSeatParts(shape)
    if (args.includes('--thinking') && args[args.indexOf('--thinking') + 1] === 'high') thinkingHigh++
    if (!args.includes('--thinking')) noThinking++
  }
  assert.ok(thinkingHigh > 0); assert.ok(noThinking > 0)
})

// #147: modelString is the roster-facing half of the same pi model-resolution defence as omitting --provider.
test('modelString refuses an unmapped provider rather than guessing', () => {
  assert.equal(modelString({ provider: 'openai', id: 'gpt-5.6-luna' }), `${PI_PROVIDERS.openai}/gpt-5.6-luna`)
  assert.equal(modelString({ provider: 'anthropic', id: 'claude-opus-5' }), `${PI_PROVIDERS.anthropic}/claude-opus-5`)
  assert.throws(() => modelString({ provider: 'google', id: 'x' }), /google/)
})

test('modelString refuses providers inherited from Object.prototype', () => {
  const names = ['toString', 'constructor', 'hasOwnProperty', 'valueOf']
  for (const name of names) {
    const expected = `adapter-pi: no pi provider for roster provider "${name}" (known: openai, anthropic, meta) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`
    assert.throws(
      () => modelString({ provider: name, id: 'x' }),
      (error) => error.message === expected,
    )
  }
})

test('modelString refuses undeclared Object.prototype providers with a local register', () => {
  const localProviders = { 'local-pi': { pi_provider: 'local-pi' } }
  const names = ['toString', 'constructor', 'hasOwnProperty', 'valueOf']
  for (const name of names) {
    const expected = `adapter-pi: no pi provider for roster provider "${name}" (known: openai, anthropic, meta, local-pi) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups`
    assert.throws(
      () => modelString({ provider: name, id: 'x', localProviders }),
      (error) => error.message === expected,
    )
  }
})

test('the seat\'s claude-named `tools` allowlist cannot influence a composed pi seat command', () => {
  let count = 0
  for (const shape of seatShapes()) {
    const reference = piSeatParts(shape)
    assert.equal(reference.args[reference.args.indexOf('--tools') + 1], PI_BUILTIN_TOOLS.join(','))
    for (const tools of ['', 'Read', 'Bash,Write,Edit,Glob,Grep', 'NoSuchTool,Read', undefined]) assert.deepEqual(piSeatParts({ ...shape, tools }), reference)
    count++
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length)
})

test('--exclude-tools is the pi seat\'s only tool boundary, and unmapped deny names drop', () => {
  assert.deepEqual(translateDeny('Read,NoSuchTool'), ['read'])
  assert.deepEqual(translateDeny('Task,Agent'), [])
  for (const role of ROLE_ORDER) {
    const shape = [...seatShapes()].find((candidate) => candidate.role === role)
    const translated = translateDeny(SEAT_DEFAULTS[role].deny)
    const { args } = piSeatParts(shape)
    if (translated.length) assert.equal(args[args.indexOf('--exclude-tools') + 1], translated.join(','))
    else assert.equal(args.includes('--exclude-tools'), false)
  }
})

test('ungranted pi seats disable extension and skill discovery across the full seat matrix', () => {
  for (const shape of seatShapes()) {
    const { args } = piSeatParts(shape)
    assert.ok(args.includes('--no-extensions'))
    assert.ok(args.includes('--no-skills'))
    assert.equal(args.includes('-e'), false)
    assert.equal(args.includes('--skill'), false)
    assert.equal(args[args.indexOf('--tools') + 1], PI_BUILTIN_TOOLS.join(','))
  }

  const binary = resolvePiBinary({ argv: ['/abs/node', '/abs/pi/dist/cli.js'], execPath: '/abs/node', existsSync: () => true })
  assert.equal(binary.error, undefined)
  assert.equal(binary.command, '/abs/node')
  assert.deepEqual(binary.args, ['/abs/pi/dist/cli.js'])
  const refused = resolvePiBinary({ argv: ['node', 'pi'], execPath: 'node', existsSync: () => false })
  assert.ok(refused.error)
  const child = childArgs({ def: { tools: ['read'], prompt: 'p' }, task: 't', promptFile: '/tmp/p', model: 'anthropic/x', thinking: 'high' })
  assert.equal(child.some((arg) => arg === '--provider' || String(arg).startsWith('--provider=')), false)
  assert.ok(child.includes('--no-extensions'))
  assert.equal(child.includes('-e'), false)
})

test('granted pi seats append deduped activators and checkout-pinned extension, skill, and config paths', () => {
  const { args, env } = piSeatParts({ ...[...seatShapes()][0], grants: { tools: ['read', 'task', 'task'], extensions: ['/checkout/crew/pi/extensions/readgate.ts'], skills: ['/checkout/crew/pi/skills/scout.md'], agents: [], advisor: false }, configDir: '/checkout/crew/pi' })
  assert.equal(args[args.indexOf('--tools') + 1], `${PI_BUILTIN_TOOLS.join(',')},task`)
  assert.ok(args.includes('--no-extensions'))
  assert.equal(args[args.indexOf('-e') + 1], '/checkout/crew/pi/extensions/readgate.ts')
  assert.equal(args[args.indexOf('--skill') + 1], '/checkout/crew/pi/skills/scout.md')
  assert.ok(args.includes('--no-skills'))
  assert.equal(env.PI_CODING_AGENT_DIR, '/checkout/crew/pi')
  assert.equal(args.includes('--provider'), false)
})

test('a passive extension-only grant adds exactly one operand without changing seat posture', () => {
  const shape = { model: 'sonnet', promptFile: '/tmp/role-builder.md', deny: 'Edit,NotebookEdit' }
  const grants = { tools: [], extensions: ['/repo/crew/pi/extensions/readgate.ts'], agents: [], skills: [], advisor: false }
  const plain = piSeatParts({ ...shape, grants: { ...grants, extensions: [] } })
  const granted = piSeatParts({ ...shape, grants })
  assert.equal(granted.args.filter((arg) => arg === '-e').length, 1)
  const index = granted.args.indexOf('-e')
  assert.equal(granted.args[index + 1], grants.extensions[0])
  granted.args.splice(index, 2)
  assert.deepEqual(granted, plain)
})

test('GA1', () => {
  const shape = { model: 'sonnet', promptFile: '/tmp/role-builder.md', deny: 'Task,Agent' }
  const plain = piSeatParts({ ...shape, grants: { extensions: [] } })
  const granted = piSeatParts({ ...shape, grants: { extensions: [SKELETONREAD_EXTENSION] } })
  const index = granted.args.indexOf('--tools') + 1
  assert.equal(granted.args[index], `${PI_BUILTIN_TOOLS.join(',')},${RETRIEVE_TOOL}`)
  assert.equal(granted.args[granted.args.indexOf('-e') + 1], SKELETONREAD_EXTENSION)
  granted.args[index] = PI_BUILTIN_TOOLS.join(',')
  granted.args.splice(granted.args.indexOf('-e'), 2)
  assert.deepEqual(granted, plain)
  assert.equal(plain.args.includes(RETRIEVE_TOOL), false)
})

test('a granted pi tool cannot widen the deny boundary', () => {
  const shape = [...seatShapes()].find((candidate) => candidate.role === 'planner')
  const { args } = piSeatParts({ ...shape, deny: 'Edit,NotebookEdit', grants: { tools: ['edit'], extensions: [], skills: [], agents: [], advisor: false } })
  assert.ok(args[args.indexOf('--tools') + 1].split(',').includes('edit'))
  assert.equal(args[args.indexOf('--exclude-tools') + 1], 'edit')
})

test('modelString maps a local provider only when the register supplies its pi namespace', () => {
  assert.equal(modelString({ provider: 'local-pi', id: 'qwen3-coder', localProviders: { 'local-pi': { pi_provider: 'local-pi' } } }), 'local-pi/qwen3-coder')
  assert.throws(() => modelString({ provider: 'local-pi', id: 'qwen3-coder' }), /local-pi/)
})

test('modelString honours an own local provider named after Object.prototype', () => {
  assert.equal(
    modelString({ provider: 'hasOwnProperty', id: 'qwen3-coder', localProviders: { hasOwnProperty: { pi_provider: 'local-pi' } } }),
    'local-pi/qwen3-coder',
  )
})

test('modelString handles null-prototype local provider registers', () => {
  const localProviders = Object.create(null)
  localProviders['local-pi'] = { pi_provider: 'local-pi' }
  assert.equal(modelString({ provider: 'local-pi', id: 'qwen3-coder', localProviders }), 'local-pi/qwen3-coder')
  assert.throws(
    () => modelString({ provider: 'toString', id: 'x', localProviders }),
    (error) => error.message === 'adapter-pi: no pi provider for roster provider "toString" (known: openai, anthropic, meta, local-pi) — refusing a guessed passthrough: pi synthesizes phantom models on narrowed lookups',
  )
})

test('legacy F1: mcp_servers do not alter the seat command', () => {
  const shape = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/prompt.md', tools: 'Read', deny: 'Task,Agent',
    taskDir: '/tmp/task', bootBrief: 'boot',
  }
  const normal = {
    tools: [], extensions: [], agents: [], skills: [], advisor: false, requires: [],
    mcp_servers: [],
  }
  const baseline = piSeatParts({ ...shape, grants: normal })
  const withMcp = piSeatParts({
    ...shape,
    grants: {
      ...normal,
      mcp_servers: [{ name: 'search', command: { bin: '/opt/mcp-search', args: [] }, url: null }],
    },
  })
  assert.deepEqual(withMcp, baseline)
})

// Kills: piFffEnv's granted CREW_FFF changed from 1 to 0 (RV1-1: readgate stops refusing bash grep/find).
test('NP7 the grant decides CREW_FFF for rpc and acp, and readgate points at native fff tools', async () => {
  const { createReadGate } = await import('./pi/extensions/readgate.ts')
  const grants = { tools: [], extensions: ['builtin:mcp'], agents: [], skills: [], advisor: false, mcp_servers: [{ name: 'fff', command: { bin: '/opt/homebrew/bin/fff-mcp', args: [] }, url: null }] }
  const base = { role: 'builder', taskDir: '/np/task', model: 'openai-codex/model', promptFile: '/np/role.md', bootBrief: 'boot', env: {}, grants }
  const parts = piSeatParts(base)
  assert.equal(parts.env.CREW_FFF, '1')
  assert.equal(parts.env.PI_CODING_AGENT_DIR, '/np/task/pi-agent/builder')
  assert.equal(acpLaunch({ ...base, bin: '/np/pi', cwd: '/np/checkout' }).env.PI_CODING_AGENT_DIR, '/np/task/pi-agent/builder')
  const ungranted = { ...base, grants: { ...grants, extensions: [], mcp_servers: [] } }
  assert.equal(piSeatParts(ungranted).env.CREW_FFF, '0')
  const hostile = { ...ungranted, env: { CREW_FFF: '1' } }
  assert.equal(piSeatParts(hostile).env.CREW_FFF, '0')
  const gate = createReadGate({ env: parts.env, hasUnquotedPipe: () => false })
  for (const [program, replacement] of [['grep', 'mcp__fff__grep'], ['find', 'mcp__fff__find_files']]) {
    const result = gate.onToolCall({ toolName: 'bash', input: { command: `${program} needle` } }, { cwd: '/np/checkout' })
    assert.equal(result?.block, true, program); assert.match(result.reason, new RegExp(replacement))
  }
})

test('pi ACP launch carries the seat env the lean runner supplies: role and lane task dir', () => {
  const launch = acpLaunch({ bin: '/bin/pi', cwd: '/tmp', model: 'm', promptFile: 'p', role: 'planner', env: { CREW_ROLE: 'planner', CREW_TASK_DIR: '/lane' } })
  assert.equal(launch.env.CREW_ROLE, 'planner')
  assert.equal(launch.env.CREW_TASK_DIR, '/lane')
})
