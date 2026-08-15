// crew/adapter-pi.test.mjs — the adapter's own test home. The --provider
// invariant lives here because its omission is load-bearing behaviour that a
// well-intentioned edit would otherwise silently undo (#147).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seatCommand, modelString, translateDeny, PI_PROVIDERS } from './adapters/adapter-pi.mjs'
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
    assert.doesNotMatch(reference, /(^|\s)(--tools|-t)(\s|=)/, label)
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
