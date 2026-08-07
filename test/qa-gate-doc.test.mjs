// Owner of references/qa-gate.md's Review ladder / Reviewer verdicts /
// consolidation sections. Two sections of the same file are owned elsewhere
// and must NOT be re-asserted here:
//   - '## Noise filtering'  -> test/noise-globs.test.mjs (incl. the `:!`
//     placement guard at :135-144, which already covers THIS section by
//     asserting the token appears nowhere outside the noise section).
//   - '## An optional gate adjunct: browser-verify evidence'
//     -> test/cmux-dispatch-doc.test.mjs:206-231.
// Add qa-gate.md assertions here or to those two files — never to a third.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const qaGateMd = readFileSync(join(ROOT, 'references', 'qa-gate.md'), 'utf8')
const qaLeadMd = readFileSync(join(ROOT, 'agents', 'qa-lead.md'), 'utf8')
const codeReviewerMd = readFileSync(join(ROOT, 'agents', 'code-reviewer.md'), 'utf8')
const codeReviewerDeepMd = readFileSync(join(ROOT, 'agents', 'code-reviewer-deep.md'), 'utf8')
const buildValidatorMd = readFileSync(join(ROOT, 'agents', 'build-validator.md'), 'utf8')
const returnContractMd = readFileSync(join(ROOT, 'scripts', 'cmux', 'prompts', 'return-contract.markdown.md'), 'utf8')

const LADDER_HEADING = '## Review ladder (owned by `dev-team:qa-lead`)'

// Local copy of the same-shaped extractor test/noise-globs.test.mjs already
// uses — an independent oracle is the point here (see test/roster.test.mjs
// :58-61), not shared production code, since the "production" under test is
// prose, not a function.
function extractSection(markdown, headingLine) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l === headingLine)
  if (start === -1) {
    throw new Error(`heading not found: ${JSON.stringify(headingLine)}`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// agents/qa-lead.md's ladder is a numbered step, not a `##` section — slice
// between the step-3 opener and the step-4 opener instead.
function extractQaLeadStep3(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.startsWith('3. **Decide review depth'))
  if (start === -1) {
    throw new Error('qa-lead.md step 3 opener not found')
  }
  const end = lines.findIndex((l, i) => i > start && l.startsWith('4. **Size the gate bundle'))
  if (end === -1) {
    throw new Error('qa-lead.md step 4 opener not found')
  }
  return lines.slice(start, end).join('\n')
}

// --- 1. control ---
test('qa-gate.md: Review ladder section is found and still carries its pre-existing positive marker', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /Adversarial panel/)
  assert.throws(() => extractSection(qaGateMd, '## Does not exist, bogus heading'))
})

// --- 2. composition + raise-only ---
test('qa-gate.md: ladder states depth = max(semantic_row, mechanical_floor_row) and that the floor only raises', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /depth = max\(semantic_row, mechanical_floor_row\)/)
  assert.match(section, /only ever RAISE|never lower|only raise/i)
})

// --- 3. threshold ---
test('qa-gate.md: ladder states the single 100-changed-lines threshold', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /100 changed lines/)
  assert.match(section, /insertions \+ deletions/)
})

// --- 4. measurement instruction ---
test('qa-gate.md: ladder names the measurement (--shortstat in place of --name-only, against the noise section)', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /--shortstat/)
  assert.match(section, /--name-only/)
  assert.match(section, /[Nn]oise filtering/)
})

// --- 5. suppression-blind ---
test('qa-gate.md: ladder states the floor measurement is suppression-blind, deliberately', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /suppression-blind/)
  assert.match(section, /files_in_scope/)
  assert.match(section, /different diffs|divergence|two different/)
})

// --- 6. reviewer-lane-only ---
test('qa-gate.md: ladder states the floor moves the reviewer lane only, never test-engineer', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /reviewer lane/i)
  assert.match(section, /test-engineer/)
  assert.match(section, /own trigger/)
})

// --- 7. doc-prose clarification ---
test('qa-gate.md: ladder clarifies test-engineer\'s "behavior" trigger includes doc-prose behavior', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /doc-prose behavior/)
  assert.match(section, /test-engineer/)
})

// --- 8. both rejections recorded ---
test('qa-gate.md: ladder records both rejected options with their reasons', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  assert.match(section, /rejected/i)
  assert.match(section, /panel/)
  assert.match(section, /stacked/)
  assert.match(section, /50 changed files/)
  assert.match(section, /rename/)
})

// --- 9. negative, guarded: no second active "50 changed files" arm ---
test('qa-gate.md: "50 changed files" appears exactly once, inside the rejection sentence, never as a second active arm', () => {
  const section = extractSection(qaGateMd, LADDER_HEADING)
  // Re-assert the positive first so this negative can never run vacuously.
  assert.match(section, /depth = max\(semantic_row, mechanical_floor_row\)/)

  const needle = '50 changed files'
  const firstIndex = section.indexOf(needle)
  assert.notEqual(firstIndex, -1, 'expected "50 changed files" to appear at least once')
  const secondIndex = section.indexOf(needle, firstIndex + needle.length)
  assert.equal(secondIndex, -1, '"50 changed files" must appear exactly once in the ladder section')

  const preceding = section.slice(Math.max(0, firstIndex - 200), firstIndex)
  assert.match(preceding, /reject/i)
})

// --- 10. drift guard between qa-gate.md and qa-lead.md ---
test('qa-gate.md and agents/qa-lead.md state the floor rule identically on every pinned token, after normalization', () => {
  const gateSection = extractSection(qaGateMd, LADDER_HEADING)
  const leadSection = extractQaLeadStep3(qaLeadMd)

  const normalize = (s) => s.replace(/\*/g, '').replace(/\s+/g, ' ')
  const normGate = normalize(gateSection)
  const normLead = normalize(leadSection)

  // Positive markers re-asserted after normalization, before the drift check.
  assert.match(normGate, /Adversarial panel/)
  assert.match(normLead, /Deep triggers \(any\):/)

  const tokens = [
    'more than 100 changed lines',
    'max(semantic_row',
    'suppression-blind',
    'reviewer lane',
    'test-engineer',
  ]
  for (const token of tokens) {
    assert.ok(normGate.includes(token), `qa-gate.md ladder section missing drift-pinned token: ${token}`)
    assert.ok(normLead.includes(token), `qa-lead.md step-3 block missing drift-pinned token: ${token}`)
  }

  // The raise-only clause must hold on both sides, not just qa-gate.md (test 2
  // only asserts it there) — a future edit that drops "raises, never lowers"
  // from qa-lead.md's copy would otherwise go undetected.
  const raiseOnly = /only ever raise|never lower|only raise/i
  assert.match(normGate, raiseOnly, 'qa-gate.md ladder section missing the raise-only clause')
  assert.match(normLead, raiseOnly, 'qa-lead.md step-3 block missing the raise-only clause')
})

// qa-13-a2: verdict-block authoring across the three verdict-carrying roles,
// panel lens documentation, and the severity-vocabulary mapping tables.
// -------------------------------------------------------------------------

// Extracts all fenced ```json ... ``` block bodies from a markdown string.
function extractJsonBlocks(markdown) {
  const re = /```json\r?\n([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1])
  }
  return blocks
}

// --- 11. byte-identity across the four sites ---
//
// MAINTENANCE TRAP, BY DESIGN: this test deliberately spans
// scripts/cmux/prompts/return-contract.markdown.md, a file under a standing
// do-not-touch instruction (ADR-009 Am.1;
// .claude/dev-team/tasks/issue-8/be-08-01.spec.json:30 — editing it
// invalidates every judgment role's cached prefix). A future LEGITIMATE edit
// to that file WILL fail this test BY DESIGN. The correct response is to
// update all four sites (this test's three role files plus
// return-contract.markdown.md) together in the same change — never to
// delete or weaken this test to make the failure go away.
test('verdict json schema is byte-identical across code-reviewer.md, code-reviewer-deep.md, build-validator.md and return-contract.markdown.md', () => {
  const reviewerBlocks = extractJsonBlocks(codeReviewerMd)
  const deepBlocks = extractJsonBlocks(codeReviewerDeepMd)
  const validatorBlocks = extractJsonBlocks(buildValidatorMd)
  const contractBlocks = extractJsonBlocks(returnContractMd)

  assert.equal(reviewerBlocks.length, 1, 'code-reviewer.md must carry exactly one fenced json block')
  assert.equal(deepBlocks.length, 1, 'code-reviewer-deep.md must carry exactly one fenced json block')
  assert.equal(validatorBlocks.length, 1, 'build-validator.md must carry exactly one fenced json block')
  assert.ok(contractBlocks.length >= 1, 'return-contract.markdown.md must carry the frozen schema block')

  const canonical = contractBlocks[0].trimEnd()
  assert.equal(reviewerBlocks[0].trimEnd(), canonical, 'code-reviewer.md verdict schema diverges from return-contract.markdown.md')
  assert.equal(deepBlocks[0].trimEnd(), canonical, 'code-reviewer-deep.md verdict schema diverges from return-contract.markdown.md')
  assert.equal(validatorBlocks[0].trimEnd(), canonical, 'build-validator.md verdict schema diverges from return-contract.markdown.md')
})

// --- 12. ordering: VERDICT line -> ### Verdict -> json block -> ### Must-fix -> ### Notes ---
test('code-reviewer.md and code-reviewer-deep.md order VERDICT line, ### Verdict (with the json block), ### Must-fix, ### Notes', () => {
  for (const [name, body] of [['code-reviewer.md', codeReviewerMd], ['code-reviewer-deep.md', codeReviewerDeepMd]]) {
    const verdictLineIdx = body.indexOf('Lead with the verdict on the very first line')
    const verdictHeadingIdx = body.search(/^### Verdict$/m)
    const jsonBlockIdx = body.indexOf('```json')
    const mustFixIdx = body.search(/^### Must-fix$/m)
    const notesIdx = body.search(/^### Notes$/m)

    assert.ok(verdictLineIdx !== -1, `${name}: missing the verdict-first marker`)
    assert.ok(verdictHeadingIdx !== -1, `${name}: missing ### Verdict heading`)
    assert.ok(jsonBlockIdx !== -1, `${name}: missing fenced json block`)
    assert.ok(mustFixIdx !== -1, `${name}: missing ### Must-fix heading`)
    assert.ok(notesIdx !== -1, `${name}: missing ### Notes heading`)

    assert.ok(verdictLineIdx < verdictHeadingIdx, `${name}: VERDICT line must precede ### Verdict`)
    assert.ok(verdictHeadingIdx < jsonBlockIdx, `${name}: ### Verdict must precede the json block`)
    assert.ok(jsonBlockIdx < mustFixIdx, `${name}: json block must precede ### Must-fix (findings prose)`)
    assert.ok(mustFixIdx < notesIdx, `${name}: ### Must-fix must precede ### Notes`)
  }
})

// --- 13. exactly one fenced json block per role file ---
test('each of the three verdict-carrying role files has exactly one fenced json block', () => {
  assert.equal(extractJsonBlocks(codeReviewerMd).length, 1)
  assert.equal(extractJsonBlocks(codeReviewerDeepMd).length, 1)
  assert.equal(extractJsonBlocks(buildValidatorMd).length, 1)
})

// --- 14. build-validator VERDICT token + no-steps-is-a-pass mapping ---
test('build-validator.md carries a VERDICT: token instruction and states the no-steps case as a pass with empty findings', () => {
  assert.match(buildValidatorMd, /VERDICT: pass \| changes-needed/)
  assert.match(buildValidatorMd, /"verdict":\s*"pass"/)
  assert.match(buildValidatorMd, /findings.*\[\]|"findings": \[\]/)
  assert.match(buildValidatorMd, /not inconclusive/)
})

// --- 15. severity mapping tables ---
test('code-reviewer-deep.md carries all 7 severity mapping rows; code-reviewer.md carries the 3 prose rows', () => {
  for (const row of ['Critical', 'High', 'Medium', 'Low', 'Must fix', 'Should fix', 'Consider']) {
    assert.match(codeReviewerDeepMd, new RegExp(`\\| ${row} \\|`), `code-reviewer-deep.md missing mapping row: ${row}`)
  }
  assert.match(codeReviewerDeepMd, /High folds INTO `critical`/)

  assert.match(codeReviewerMd, /Must fix -> `critical`/)
  assert.match(codeReviewerMd, /Should fix -> `warning`/)
  assert.match(codeReviewerMd, /Consider -> `suggestion`/)
})

// --- 16. standing do-not-flag list, both reviewer files ---
test('the 5-item do-not-flag list is present in both code-reviewer.md and code-reviewer-deep.md', () => {
  for (const [name, body] of [['code-reviewer.md', codeReviewerMd], ['code-reviewer-deep.md', codeReviewerDeepMd]]) {
    assert.match(body, /unverified:/, `${name}: missing item 1 (unverified: prefix)`)
    assert.match(body, /one finding per root cause/i, `${name}: missing item 2`)
    assert.match(body, /outside the diff/i, `${name}: missing item 3`)
    assert.match(body, /suggestion.*severity/i, `${name}: missing item 4 (style caps at suggestion)`)
    assert.match(body, /no such tool exists|config\.md:36/, `${name}: missing item 4's no-linter grounding`)
    assert.match(body, /wont-fix \(user\)/, `${name}: missing item 5`)
  }
})

// --- 17. file:line anchor requirement on code-reviewer.md ---
test('code-reviewer.md requires a file:line anchor on every finding', () => {
  assert.match(codeReviewerMd, /file:line/)
})

// --- 18. panel lens rules in qa-gate.md ---
test('qa-gate.md documents panel lens rules: not-frozen default trio, priority-ordering-not-scope, coverage declaration, rejected checklist, dedup limitation', () => {
  assert.match(qaGateMd, /correctness \/ security \/ rollback-safety/)
  assert.match(qaGateMd, /not frozen/)
  assert.match(qaGateMd, /priority ordering plus a mandatory full sweep, never a scope restriction/)
  assert.match(qaGateMd, /swept: <axes> · went shallow: <axis> \(<reason>\)/)
  assert.match(qaGateMd, /[Rr]ejected alternative: a per-lens checklist/)
  assert.match(qaGateMd, /role-fork problem/)
  assert.match(qaGateMd, /under-merge/)
})

// --- 19. degrade guard (negative, positives-first) ---
// The pre-existing :69 first-line-token fallback and the :73 inconclusive
// handling must survive unchanged by this task's additions.
test('qa-gate.md still states the agent-tool-mode literal-token-match fallback, unweakened', () => {
  assert.match(qaGateMd, /VERDICT: pass \| changes-needed/)
  assert.match(qaGateMd, /literal token match/)
  assert.match(qaGateMd, /inconclusive is never a pass/)
})
