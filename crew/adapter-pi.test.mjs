// crew/adapter-pi.test.mjs — the adapter's own test home. The --provider
// invariant lives here because its omission is load-bearing behaviour that a
// well-intentioned edit would otherwise silently undo (#147).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, join, basename } from 'node:path'
import { seatCommand, modelString, translateDeny, PI_BUILTIN_TOOLS, PI_PROVIDERS, PI_ADVISOR_EXTENSION, shellSingleQuote } from './adapters/adapter-pi.mjs'
import { SEAT_DEFAULTS, ROLE_ORDER } from './crew.mjs'

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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

test('PI_BUILTIN_TOOLS and every seat activator stay pinned to pi\'s complete built-in set', () => {
  const expected = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
  const expectedActivator = '--tools "read,bash,edit,write,grep,find,ls"'
  assert.deepEqual(PI_BUILTIN_TOOLS, expected)
  assert.equal(`--tools "${PI_BUILTIN_TOOLS.join(',')}"`, expectedActivator)

  let count = 0
  for (const shape of seatShapes()) {
    const command = seatCommand(shape)
    const label = `role=${shape.role} model=${shape.model} effort=${shape.effort ?? 'none'}`
    assert.match(command, new RegExp(`(^|\\s)${escapeRegex(expectedActivator)}(\\s|$)`), label)
    const activator = command.match(/(?:^|\s)--tools "([^"]*)"/)?.[1]
    assert.equal(activator, expected.join(','), label)
    for (const tool of expected) assert.ok(activator.split(',').includes(tool), `${label} missing ${tool}`)
    count += 1
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length, `seat matrix unexpectedly covered only ${count} shapes`)
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
    const cmd = seatCommand(shape)
    const label = `role=${shape.role} model=${shape.model} effort=${shape.effort ?? 'none'}`
    assert.doesNotMatch(cmd, /(^|\s)--provider(\s|$)/, label)
    assert.doesNotMatch(cmd, /(^|\s)--provider=/, label)
    count += 1
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length, `seat matrix unexpectedly covered only ${count} shapes`)
})

test('the model id reaches pi whole, unnarrowed', () => {
  for (const model of MODELS) {
    const shape = [...seatShapes()].find((candidate) => candidate.model === model)
    const cmd = seatCommand(shape)
    const pattern = new RegExp(`(^|\\s)--model ${escapeRegex(model)}(\\s|$)`)
    assert.match(cmd, pattern, `model id was not passed whole: ${model}`)
  }
})

test('both deny branches are exercised by the seat matrix', () => {
  let excluded = 0
  let omitted = 0
  for (const shape of seatShapes()) {
    const cmd = seatCommand(shape)
    const translated = translateDeny(shape.deny)
    if (translated.includes('edit') && cmd.includes('--exclude-tools "edit"')) excluded += 1
    if (translated.length === 0 && !cmd.includes('--exclude-tools')) omitted += 1
  }
  assert.ok(excluded > 0, 'matrix must include a translated deny list')
  assert.ok(omitted > 0, 'matrix must include an empty translated deny list')
})

test('both effort branches are exercised by the seat matrix', () => {
  let thinkingHigh = 0
  let noThinking = 0
  for (const shape of seatShapes()) {
    const cmd = seatCommand(shape)
    if (cmd.includes('--thinking high')) thinkingHigh += 1
    if (!cmd.includes('--thinking')) noThinking += 1
  }
  assert.ok(thinkingHigh > 0, 'matrix must include the high effort branch')
  assert.ok(noThinking > 0, 'matrix must include the absent effort branch')
})

// #147: modelString is the roster-facing half of the same pi model-resolution defence as omitting --provider.
test('modelString refuses an unmapped provider rather than guessing', () => {
  assert.equal(modelString({ provider: 'openai', id: 'gpt-5.6-luna' }), `${PI_PROVIDERS.openai}/gpt-5.6-luna`)
  assert.equal(modelString({ provider: 'anthropic', id: 'claude-opus-5' }), `${PI_PROVIDERS.anthropic}/claude-opus-5`)
  assert.throws(() => modelString({ provider: 'google', id: 'x' }), /google/)
})

test('the seat\'s claude-named `tools` allowlist cannot influence a composed pi seat command', () => {
  let count = 0
  const variants = ['', 'Read', 'Bash,Write,Edit,Glob,Grep', 'NoSuchTool,Read', undefined]
  for (const shape of seatShapes()) {
    const reference = seatCommand(shape)
    const label = `role=${shape.role} model=${shape.model} effort=${shape.effort ?? 'none'}`
    assert.match(reference, new RegExp(`(^|\\s)--tools "${escapeRegex(PI_BUILTIN_TOOLS.join(','))}"(\\s|$)`), label)
    for (const tools of variants) {
      const candidate = seatCommand({ ...shape, tools })
      assert.equal(candidate, reference, `${label} tools=${String(tools)}`)
    }
    count += 1
  }
  assert.ok(count >= ROLE_ORDER.length * MODELS.length * EFFORTS.length, `seat matrix unexpectedly covered only ${count} shapes`)
})

test('--exclude-tools is the pi seat\'s only tool boundary, and unmapped deny names drop', () => {
  assert.deepEqual(translateDeny('Read,NoSuchTool'), ['read'])
  assert.deepEqual(translateDeny('Task,Agent'), [])
  for (const role of ROLE_ORDER) {
    const shape = [...seatShapes()].find((candidate) => candidate.role === role)
    const translated = translateDeny(SEAT_DEFAULTS[role].deny)
    const command = seatCommand(shape)
    const label = `role=${role}`
    if (translated.length) assert.match(command, new RegExp(`--exclude-tools "${escapeRegex(translated.join(','))}"`), label)
    else assert.doesNotMatch(command, /--exclude-tools/, label)
  }
})

test('ungranted pi seats disable extension and skill discovery across the full seat matrix', () => {
  for (const shape of seatShapes()) {
    const command = seatCommand(shape)
    const label = `role=${shape.role} model=${shape.model} effort=${shape.effort ?? 'none'}`
    assert.match(command, /(^|\s)--no-extensions(\s|$)/, label)
    assert.match(command, /(^|\s)--no-skills(\s|$)/, label)
    assert.doesNotMatch(command, /(^|\s)-e\s/, label)
    assert.doesNotMatch(command, /(^|\s)--skill\s/, label)
    assert.equal(command.match(/(?:^|\s)--tools "([^"]*)"/)?.[1], PI_BUILTIN_TOOLS.join(','), label)
  }
})

test('granted pi seats append deduped activators and checkout-pinned extension, skill, and config paths', () => {
  const command = seatCommand({
    ...[...seatShapes()][0],
    grants: {
      tools: ['read', 'task', 'task'], extensions: ['/checkout/crew/pi/fanout.js'],
      skills: ['/checkout/crew/pi/skills/scout.md'], agents: [], advisor: false,
    },
    configDir: '/checkout/crew/pi',
  })
  assert.equal(command.match(/(?:^|\s)--tools "([^"]*)"/)?.[1], `${PI_BUILTIN_TOOLS.join(',')},task`)
  assert.match(command, /--no-extensions/)
  assert.match(command, /-e "\/checkout\/crew\/pi\/fanout\.js"/)
  assert.match(command, /--skill "\/checkout\/crew\/pi\/skills\/scout\.md"/)
  assert.doesNotMatch(command, /--no-skills/)
  assert.match(command, /PI_CODING_AGENT_DIR="\/checkout\/crew\/pi"/)
  assert.doesNotMatch(command, /--provider/)
})

test('a granted pi tool cannot widen the deny boundary', () => {
  const shape = [...seatShapes()].find((candidate) => candidate.role === 'planner')
  const command = seatCommand({ ...shape, deny: 'Edit,NotebookEdit', grants: { tools: ['edit'], extensions: [], skills: [], agents: [], advisor: false } })
  assert.match(command, /--tools "[^"]*,edit[^"]*"/)
  assert.match(command, /--exclude-tools "edit"/)
})

test('modelString maps a local provider only when the register supplies its pi namespace', () => {
  assert.equal(modelString({ provider: 'local-pi', id: 'qwen3-coder', localProviders: { 'local-pi': { pi_provider: 'local-pi' } } }), 'local-pi/qwen3-coder')
  assert.throws(() => modelString({ provider: 'local-pi', id: 'qwen3-coder' }), /local-pi/)
})

test('advisor grant appends only its extension and safely transports its cell', () => {
  const shape = {
    role: 'builder', model: 'sonnet', promptFile: '/tmp/prompt.md', tools: '', deny: '',
    taskDir: '/tmp/task', bootBrief: 'brief', grants: { tools: [], extensions: [], agents: [], skills: [], advisor: true },
    advisorCell: { endpoint: "http://127.0.0.1/it's/v1", model: "q'wen3" },
  }
  const plain = seatCommand({ ...shape, grants: { ...shape.grants, advisor: false }, advisorCell: null })
  const granted = seatCommand(shape)
  assert.equal(granted.match(/(?:^|\s)--tools "([^"]*)"/)?.[1], plain.match(/(?:^|\s)--tools "([^"]*)"/)?.[1])
  assert.match(granted, new RegExp(`-e "${escapeRegex(PI_ADVISOR_EXTENSION)}"`))
  assert.match(granted, /CREW_ADVISOR=1/)
  assert.match(granted, /CREW_ADVISOR_ENDPOINT='http:\/\/127\.0\.0\.1\/it'"'"'s\/v1'/)
  assert.equal(shellSingleQuote("q'wen3"), `'q'"'"'wen3'`)
  assert.doesNotMatch(plain, /CREW_ADVISOR|advisor\.ts/)
})
