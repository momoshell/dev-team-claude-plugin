import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpSeat } from '../crew/acp/seat.mjs'
import { startLane, StartRefusal } from '../crew/start.mjs'
import { parseAgent, parseBrief, SHAPES } from '../crew/protocols.mjs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const body = (path) => {
  const text = read(path)
  assert.match(text, /^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}
const flat = (text) => text.replace(/\s+/g, ' ').trim()
const has = (text, expected) => assert.ok(flat(text).includes(flat(expected)), `missing: ${expected}`)
const rungs = [
  '1. Does this need to exist at all? Speculative need: skip it, say so in one line.',
  '2. Already in this codebase? Reuse the helper, util or pattern that lives here.',
  '3. Stdlib does it? Use it.',
  '4. An installed dependency does it? Use it. Never add one for a few lines.',
  '5. Can it be one line? One line.',
  '6. Only then: the minimum code that works.',
]

// MUTATION: remove the named plan gap or permit size and effort as reasons.
test('SC1: both charters define insufficient', () => {
  for (const role of ['builder', 'planner']) {
    const charter = body(`crew/agents/${role}.md`)
    has(charter, '`insufficient` means a named gap in the plan: say what is wrong or missing, and where.')
    has(charter, 'Size or effort is never a reason to return `insufficient`.')
  }
})

// MUTATION: omit a broken caller, test, fixture, config or export from completion.
test('SC2: the builder finishes the whole change', () => {
  const charter = body('crew/agents/builder.md')
  has(charter, 'Finish every place the change reaches: callers, tests, fixtures, config and exports it breaks.')
  has(charter, 'Be lazy about the solution, never about the change itself.')
})

// MUTATION: remove deletions or skeleton retrieval from the scope rule.
test('SC3: planner scope covers all touched files and retrieval', () => {
  has(body('crew/agents/planner.md'), '`files_in_scope` must list every file the build touches, including files to delete; it fences skeleton retrieval as well as edits.')
})

// MUTATION: remove a ladder rung or restore the obsolete shared-charter reference.
test('SC4: the delivered skill owns the ladder and its references', () => {
  const skill = read('skills/code-less/SKILL.md')
  const ladder = body('skills/code-less/SKILL.md').split('## The ladder (before any new code)')[1]?.split('\n## ')[0]
  assert.ok(ladder)
  assert.deepEqual([...ladder.matchAll(/^\d+\.\s+[^\r\n]+/gm)].map((m) => flat(m[0])), rungs)
  for (const text of ['Lazy means efficient, not careless.', 'the ladder shortens the solution, never the reading.', 'Bug fix = root cause, not symptom: grep every caller, fix the shared function once.']) has(ladder, text)
  assert.doesNotMatch(skill, /_shared\.md|ladder is in your shared charter/i)
  for (const path of ['skills/pr-review/SKILL.md', 'skills/pr-review/references/falsification.md']) {
    assert.doesNotMatch(read(path), /_shared\.md|ladder is in your shared charter/i)
    has(read(path), 'skills/code-less/SKILL.md')
  }
  has(skill, 'Derived from ponytail by Dietrich Gebert (MIT)')
  const notice = read('THIRD-PARTY-NOTICES.md').split('## ponytail (MIT)')[1]?.split('\n## ')[0]
  assert.ok(notice)
  for (const text of ['skills/code-less/SKILL.md', 'crew/agents/builder.md', 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156', '01cbf81', 'docs/licenses/ponytail-MIT.txt', 'Copyright (c) 2026 DietrichGebert', 'THE SOFTWARE IS PROVIDED "AS IS"']) has(notice, text)
  assert.doesNotMatch(notice, /_shared\.md|compiled into every role prompt/)
})

// MUTATION: remove either live definition's code-less grant or instruction.
test('lean builder and reviewer deliver code-less through the ACP launch and prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-delivery-'))
  try {
    for (const role of ['builder', 'reviewer']) {
      const { fields, body: prompt, defects } = parseAgent(read(`crew/agents/${role}.md`))
      assert.deepEqual(defects, [])
      assert.deepEqual(fields.skills, ['code-less'])
      assert.match(prompt, /Read the granted `code-less` skill before (working|reviewing)/)
      let launch, sent
      const result = runAcpSeat({
        // Context arms are exercised by lean's integration test; isolate the skill transport here.
        definition: { role, agent: fields.agent, model: fields.model, effort: fields.effort, writes: fields.writes, skills: fields.skills },
        cwd: dir, prompt, sessionFile: join(dir, `${role}.jsonl`), binaries: { pi: process.execPath },
        deps: { runtimeRoot: dir, clientFactory: (input) => {
          launch = input.launch
          return { start() {}, initialize() {}, newSession() {}, beginPrompt(blocks) { sent = blocks; return 1 }, pollPrompt() { return { stopReason: 'end_turn' } }, close() { return { outcome: 'proven' } } }
        } },
      })
      assert.equal(result.stopReason, 'end_turn')
      const path = fileURLToPath(new URL('../skills/code-less/SKILL.md', import.meta.url))
      assert.deepEqual(launch.args.slice(-3), ['--no-skills', '--skill', path])
      assert.deepEqual(sent, [{ type: 'text', text: prompt }])
      has(readFileSync(path, 'utf8'), 'Code you move or merge keeps its error handling and validation.')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// MUTATION: drop error handling or validation from the preservation rule.
test('SC5: moved or merged code retains protections', () => {
  has(body('skills/code-less/SKILL.md'), 'Code you move or merge keeps its error handling and validation.')
})

async function probe(shape) {
  const briefPath = `/virtual/shape-${shape}.md`
  const brief = `---
source: operator request
closes: null
tier: build
shape: ${shape}
acceptance: [SG1]
out_of_scope: everything else
---
## The ask

Check shape support.

## Acceptance

- (SG1) the shape is checked
`
  assert.deepEqual(parseBrief(brief).defects, [])
  const effects = []
  let resolutions = 0
  const forbidden = (name) => () => { effects.push(name); throw new Error(`unexpected effect: ${name}`) }
  const deps = {
    readFileSync: (file) => { assert.equal(file, briefPath); return brief },
    resolveAgents: () => { resolutions++; return { seats: {}, advisor: null } },
    existsSync: forbidden('existsSync'), mkdirSync: forbidden('mkdirSync'),
    writeFileSync: forbidden('writeFileSync'), openSync: forbidden('openSync'),
    closeSync: forbidden('closeSync'), spawnSync: forbidden('spawnSync'),
    spawnDetached: forbidden('spawnDetached'), log: () => {},
  }
  let result, error
  try { result = await startLane({ briefPath, check: true, deps }) } catch (caught) { error = caught }
  return { result, error, effects, resolutions }
}

// MUTATION: offer stepped in the shape field although start refuses it.
test('SC6: brief shape offerings and examples match public start behaviour', async () => {
  assert.deepEqual(SHAPES, ['standard', 'stepped', 'finish'])
  const accepted = []
  for (const shape of SHAPES) {
    const { result, error, effects, resolutions } = await probe(shape)
    assert.deepEqual(effects, [])
    if (shape === 'standard') {
      assert.equal(error, undefined)
      assert.equal(result?.checked, true)
      assert.equal(resolutions, 1)
      accepted.push(shape)
    } else {
      assert.ok(error instanceof StartRefusal)
      assert.equal(result, undefined)
      assert.equal(resolutions, 0)
    }
  }
  const skill = read('skills/lane-brief/SKILL.md')
  const rule = /^- `shape`:[^\S\r\n]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/m.exec(skill)?.[1]
  assert.ok(rule)
  const offered = [...flat(rule).split(/\.(?:\s|$)/)[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
  assert.deepEqual(offered, accepted)
  const examples = [...skill.matchAll(/^shape:\s*(\S+)/gm)].map((m) => m[1])
  assert.ok(examples.length)
  assert.ok(examples.every((shape) => accepted.includes(shape)))
})

// MUTATION: advertise stepped in the finish refusal.
test('SC7: finish refusal names only standard and has no effects', async () => {
  const { result, error, effects, resolutions } = await probe('finish')
  assert.equal(result, undefined)
  assert.ok(error instanceof StartRefusal)
  assert.equal(error.message, 'shape finish starts from an escalated lane, not a new brief; crew start runs standard only')
  assert.deepEqual(effects, [])
  assert.equal(resolutions, 0)
})
