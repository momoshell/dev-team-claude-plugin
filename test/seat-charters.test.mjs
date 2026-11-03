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

const boilerplate = charter => {
  assert.doesNotMatch(charter, /Return exactly one P2 JSON envelope|^Envelope keys:|^Statuses:/m)
  has(charter, "Give the envelope a nonempty `summary` and no top-level field beyond the example's.")
  assert.match(charter, /^Details keys:/m)
}
const insufficient = '`insufficient` means a named gap in the plan: say what is wrong or missing, and where. Size or effort is never a reason to return `insufficient`.'
const types = 'The type is one of `chore`, `ci`, `crew`, `docs`, `feat`, `fix`, `merge`, `perf`, `refactor`, `revert`, `spike`, `test`, `wip`, `workflow`.'

// MUTATION: drop the planner's narrow-or-drop sentence.
test('LD2: a builder insufficient goes to the lead, and a planner revision narrows or drops an unmeetable criterion', () => {
  has(body('crew/agents/lead.md'), 'A builder `insufficient` comes to you with its envelope: bounce it to `builder` for unfinished work, which continues on the same plan, or to `planner` for a real gap in the plan; escalate only for a §12 case. A consult whose feedback carries `last: true` is your last on this lane: route the held envelope to a seat that can finish it, or escalate naming the unresolved point. If that seat comes back unresolved, the lane stops for the operator.')
  const builder = body('crew/agents/builder.md')
  has(builder, 'A builder `insufficient` goes to the lead with your envelope: unfinished work comes back to you on the same plan, and a real gap in the plan goes to the planner, whose revised plan you continue on.')
  assert.doesNotMatch(builder, /A builder `insufficient` goes to the planner, which revises the plan/)
  has(body('crew/agents/planner.md'), 'When a revision answers a builder finding that a criterion cannot be met, narrow or drop that criterion rather than add mechanism to keep it.')
})

// MUTATION: restore return boilerplate or remove a builder loop rule.
test('CH1: the builder charter keeps the rules the loop depends on', () => {
  const charter = body('crew/agents/builder.md')
  boilerplate(charter)
  for (const text of [insufficient, types, 'Read every skill granted for the lane before working.', 'Finish every place the change reaches: callers, tests, fixtures, config and exports it breaks.', 'Be lazy about the solution, never about the change itself.', 'Return `tests` (each a file and test title) and `notes` (paths not tested, guards relied on, checks run, and what was verified as against assumed) in `details`.', 'A mechanical lane has no plan: the brief is the plan, and the prompt carries no plan path.', 'Name a test only when you wrote one; a mechanical lane requires none.', 'Add `details.subject`, the conventional-commit subject for the commit and the PR: `type(scope): summary`, at most 72 characters.', 'On a mechanical lane, `insufficient` means the brief cannot be done as a mechanical change: say why. The lane restarts as build and your build is discarded.', 'Name that decision in `details.question`', "The plan's file list is context, not a fence", 'Details keys: `summary`, `tests`, `notes`, and on a mechanical lane `subject`.']) has(charter, text)
  assert.doesNotMatch(charter, /files_in_scope|validation_lane/)
})

// MUTATION: restore return boilerplate or remove a planner loop rule.
test('CH2: the planner charter keeps the rules the loop depends on', () => {
  const charter = body('crew/agents/planner.md')
  boilerplate(charter)
  for (const text of [insufficient, types, '`files_in_scope` must list every file the build touches, including files to delete. It fences skeleton retrieval, not edits; scope is context, not an edit fence (ADR-045).', 'skeletonread', 'advisor', 'failing validation runs', 'refused without `files_in_scope`', '## Criteria', '## Properties', '## Not machine-checked', '## Tasks']) has(charter, text)
  assert.doesNotMatch(charter, /scout|The builder's context arms read them|validation_lane[^.]*the `node --test` command|refused without `validation_lane`/i)
  has(charter, '`plan_path` is a bare file path without a line-range suffix; cite plan lines as `file:start-end` in the plan text.')
  assert.doesNotMatch(charter, /inside `plan_path`/)
  const tail = charter.split('Details keys:')[1]
  const anchors = ['The `subject` is the conventional-commit subject', '`plan_path` is a bare file path', 'Give `tests` as the test of each property', 'Give `files_in_scope` (the repo-relative files', '`validation_lane` (the repository-appropriate command that checks the change)', 'Optionally give `judge`']
  let previous = -1
  for (const anchor of anchors) { const at = tail.indexOf(anchor); assert.ok(at > previous, anchor); previous = at }
})

// MUTATION: restore return boilerplate or remove a reviewer loop rule.
test('CH3: the reviewer charter keeps the rules the loop depends on', () => {
  const charter = body('crew/agents/reviewer.md')
  boilerplate(charter)
  for (const text of ['Read every skill granted for the lane before reviewing.', 'read every listed untracked file directly', "Restate the brief's ask as `requirements`", 'A pass carries no unmet requirement.', 'A must-fix carries `trigger`', 'A pass cannot contain a must-fix finding.', 'An incomplete review is never a pass.', 'carry each under its id in `findings` or close it in `closed`', 'Read the `## Builder report`', 'Flag a test the plan does not name']) has(charter, text)
  assert.doesNotMatch(charter, /files_in_scope|validation_lane/)
})

// MUTATION: restore the duplicated reviewer charter in the tech-lead.
test('CH4: the tech-lead charter is a delta over the reviewer charter', () => {
  const charter = body('crew/agents/tech-lead.md')
  boilerplate(charter)
  for (const text of ['](./reviewer.md)', 'after the reviewer passes and the suite is green', 'Read every skill granted for the lane before reviewing.', 'scout']) has(charter, text)
  assert.ok(flat(charter).length < flat(body('crew/agents/reviewer.md')).length / 2)
  assert.doesNotMatch(charter, /Restate the brief's ask as `requirements`/)
})

// MUTATION: restore a gate bypass or remove a lead decision rule.
test('CH5: the lead charter keeps the rules the loop depends on', () => {
  const charter = body('crew/agents/lead.md')
  boilerplate(charter)
  for (const text of ["When the held seat's bound is spent with no envelope, there is nothing to accept: an `accept` is a bounce to that seat.", 'No decision bypasses the per-test proof or the suite.', 'details.question', 'details.target', '`builder`', '`planner`', 'status: "done"', 'details.decision']) has(charter, text)
  assert.doesNotMatch(charter, /bypasses a gate/)
})

// MUTATION: remove dev-team attribution from the examples heading (PS4).
test('PS4 code-less attributes all worked examples', () => {
  const skill = read('skills/code-less/SKILL.md')
  assert.match(skill, /^## Examples \(from the dev-team repository\)$/m)
  const examples = skill.split('## Examples (from the dev-team repository)')[1]?.split('\n\nWhen ')[0] ?? ''
  for (const text of ['Standard library:', 'Closed enum:', 'Existing helper:', 'Honest absence:', 'crew/checks.mjs', 'test/helpers.mjs', 'crew/pi/extensions/subagent.ts']) has(examples, text)
})

// MUTATION: remove a ladder rung or restore the obsolete shared-charter reference.
test('SC4: the delivered skill owns the ladder and its references', () => {
  const skill = read('skills/code-less/SKILL.md')
  const ladder = body('skills/code-less/SKILL.md').split('## The ladder (before any new code)')[1]?.split('\n## ')[0]
  assert.ok(ladder)
  assert.deepEqual([...ladder.matchAll(/^\d+\.\s+[^\r\n]+/gm)].map((m) => flat(m[0])), rungs)
  for (const text of ['Read the task and the code it touches.', 'callers, tests, fixtures, config and exports.', 'Bug fix = root cause, not symptom: grep every caller, fix the shared function once.']) has(ladder, text)
  assert.doesNotMatch(skill, /_shared\.md|ladder is in your shared charter/i)
  for (const path of ['skills/pr-review/SKILL.md', 'skills/pr-review/references/falsification.md']) {
    assert.doesNotMatch(read(path), /_shared\.md|ladder is in your shared charter/i)
    has(read(path), 'skills/code-less/SKILL.md')
  }
  has(skill, 'Derived from ponytail v5 by Dietrich Gebert (MIT)')
  const notice = read('THIRD-PARTY-NOTICES.md').split('## ponytail (MIT)')[1]?.split('\n## ')[0]
  assert.ok(notice)
  for (const text of ['skills/code-less/SKILL.md', 'crew/agents/builder.md', 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156', '01cbf81', 'df9e89941d50419fd5bcf1de41e28097f1db49b2', 'skills/pr-review/SKILL.md', 'docs/licenses/ponytail-MIT.txt', 'Copyright (c) 2026 DietrichGebert', 'THE SOFTWARE IS PROVIDED "AS IS"']) has(notice, text)
  assert.doesNotMatch(notice, /_shared\.md|compiled into every role prompt/)
})

// MUTATION: remove prose-plain from the builder base skills list.
test('PP1: lean builder and reviewer deliver their skills through the ACP launch and prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-delivery-'))
  try {
    for (const role of ['builder', 'reviewer']) {
      const { fields, body: prompt, defects } = parseAgent(read(`crew/agents/${role}.md`))
      assert.deepEqual(defects, [])
      const skills = role === 'builder' ? ['code-less', 'prose-plain'] : ['code-less']
      assert.deepEqual(fields.skills, skills)
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
      const skillArgs = ['--no-skills', ...skills.flatMap((skill) => ['--skill', fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url))])]
      assert.deepEqual(launch.args.slice(-skillArgs.length), skillArgs)
      assert.deepEqual(sent, [{ type: 'text', text: prompt }])
      has(readFileSync(path, 'utf8'), 'Code you move or merge keeps its error handling and validation.')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// MUTATION: drop error handling or validation from the preservation rule.
test('SC5: moved or merged code retains protections', () => {
  const skill = body('skills/code-less/SKILL.md')
  has(skill, 'Code you move or merge keeps its error handling and validation.')
  has(skill, '// shortcut:')
  assert.doesNotMatch(skill, /\/\/ lean:/)
})

async function probe(shape) {
  const briefPath = `/virtual/shape-${shape}.md`
  const brief = `---
source: operator request
closes: null
shape: ${shape}
out_of_scope: everything else
---
## The ask

> Check shape support.

## Context

- \`crew/start.mjs\`
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
test('SH1: brief shape offerings and examples match public start behaviour', async () => {
  assert.deepEqual(SHAPES, ['standard', 'finish'])
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
test('SH2: finish refusal names only standard and has no effects', async () => {
  const { result, error, effects, resolutions } = await probe('finish')
  assert.equal(result, undefined)
  assert.ok(error instanceof StartRefusal)
  assert.equal(error.message, 'shape finish starts from an escalated lane, not a new brief; crew start runs standard only')
  assert.deepEqual(effects, [])
  assert.equal(resolutions, 0)
})
