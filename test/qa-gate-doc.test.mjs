// Owner of references/qa-gate.md's Review ladder / Reviewer verdicts /
// consolidation sections. Three sections of the same file are owned elsewhere
// and must NOT be re-asserted here:
//   - '## Noise filtering'  -> test/noise-globs.test.mjs (incl. the `:!`
//     placement guard at :135-144, which already covers THIS section by
//     asserting the token appears nowhere outside the noise section).
//   - '## Scope compliance is verified by git, not the coder's self-report'
//     -> test/noise-globs.test.mjs (SCOPE_HEADING; the noise-suppression
//     negative and the issue #19 test-file-classification content pin both
//     live there).
//   - '## An optional gate adjunct: browser-verify evidence'
//     -> test/cmux-dispatch-doc.test.mjs:206-231.
// Add qa-gate.md assertions here or to those three files — never to a fourth.

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
  let inFence = false
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) {
      inFence = !inFence
      continue
    }
    // A frozen worked-example table can embed a literal "## " heading line
    // inside a fenced block (qa-13-a3's carry-forward shape) — that is
    // fixture content, not a real section boundary, so it must not end the
    // slice early.
    if (!inFence && lines[i].startsWith('## ')) {
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

// qa-13-a3: gate memory (carry-forward, no new ledger) + the consolidation pass
// -------------------------------------------------------------------------

const GATE_MEMORY_HEADING = '## Gate memory — re-review awareness with no new persisted ledger'
const CONSOLIDATION_HEADING = '## The consolidation pass — after all panel members return, before you act'

// --- 20. gate-memory: frozen carry-forward table shape + worked examples ---
test('qa-gate.md: gate-memory section carries the frozen Prior findings table with its three worked example rows', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /## Prior findings \(dispositioned — do not re-litigate\)/)
  assert.match(section, /\| finding \| prior severity \| disposition \| note \|/)
  assert.match(section, /fixed \(<short-sha>\)/)
  assert.match(section, /critical/)
  assert.match(section, /wont-fix \(user\)/)
  assert.match(section, /suggestion/)
  assert.match(section, /\| open \|/)
  assert.match(section, /warning/)
})

// --- 21. disposition enum closed at five members ---
test('qa-gate.md: the disposition enum is stated as closed at exactly five members', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /closed at exactly five members/)
  for (const token of ['`fixed`', '`open`', '`wont-fix (user)`', '`disagreed (user)`', '`deferred (issue #N)`']) {
    assert.ok(section.includes(token), `gate-memory section missing disposition token: ${token}`)
  }
})

// --- 22. per-disposition rules ---
test('qa-gate.md: each disposition rule is stated (fixed/open/settled/deferred)', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /verify the fix/i)
  assert.match(section, /a fix that turns out wrong is a NEW finding/i)
  assert.match(section, /re-emit if the underlying condition is still present|re-report if still present/i)
  assert.match(section, /[Nn]ever re-raised without genuinely new evidence/)
  assert.match(section, /the finding must say what's new/)
})

// --- 23. only-the-user-authors-(user) rule ---
test('qa-gate.md: only the user may author a (user) disposition, with the suppression-safety reason', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /[Oo]nly the user may author a `\(user\)` disposition/)
  assert.match(section, /must never write `wont-fix \(user\)` or `disagreed \(user\)` yourself/)
  assert.match(section, /[Cc]onsent cannot be manufactured/)
  assert.match(section, /silence any finding/)
})

// --- 24. three carriers documented, no-new-storage rationale ---
test('qa-gate.md: the three gate-memory carriers are documented with the no-new-storage rationale', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /No new storage exists for this/)
  assert.match(section, /[Ii]n-loop re-review/)
  assert.match(section, /[Aa]cross windows, in respond mode/)
  assert.match(section, /GitHub itself is the store/)
  assert.match(section, /reviewThreads\.comments/)
  assert.match(section, /conventions\.md.*qa-notes\.md|qa-notes\.md.*conventions\.md/)
})

// --- 25. gate-report file path + never-parsed statement ---
test('qa-gate.md: the gate-report path is documented and stated as plain markdown, never a parsed contract', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /\.claude\/dev-team\/tasks\/issue-<N>\/gate-report-r<k>\.md/)
  assert.match(section, /gate-report-r<k>\.md/)
  assert.match(section, /plain markdown, human-readable, and never a parsed contract/)
  assert.match(section, /mid-task `\/clear`|mid-task \/clear/)
})

// --- 26. consolidation: six-step ordering ---
test('qa-gate.md: consolidation pass states six steps in strictly increasing order', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  const markers = [
    '**0. Freeze the verdict arithmetic first**',
    '**1. Normalize.**',
    '**2. Dedup.**',
    '**3. Re-categorize.**',
    '**4. Reasonableness filter for drops.**',
    '**5. Report',
  ]
  const indices = markers.map((m) => {
    const i = section.indexOf(m)
    assert.notEqual(i, -1, `consolidation section missing step marker: ${m}`)
    return i
  })
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], `step markers out of order at index ${i}: ${markers[i]}`)
  }
})

// --- 27. dedup rule exact statement ---
test('qa-gate.md: dedup rule states same-file+non-null-line+same-defect, highest severity, agreement preserved, null-line never merged', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /same normalized `file`/)
  assert.match(section, /same non-null `line`/)
  assert.match(section, /same defect/)
  assert.match(section, /highest\*\* severity/)
  assert.match(section, /agreement count is preserved, never collapsed away/)
  assert.match(section, /never\*\* merged/)
  assert.match(section, /under-merges in practice/)
  assert.match(section, /accepted v1 limitation/)
})

// --- 28. stricter-never-looser phrasing, no surviving never-changes absolute ---
test('qa-gate.md: the governing invariant is stricter/looser, not an arithmetic-never-changes absolute', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /stricter, never looser/)
  assert.equal(/never changes the arithmetic/i.test(qaGateMd), false)
})

// --- 29. three drop conditions + critical-never-dropped absolute ---
test('qa-gate.md: the three drop conditions each require a citation, and a critical is never dropped', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /a `critical` is never dropped/)
  assert.match(section, /escalated to the user instead, always/)
  assert.match(section, /[Qq]uote the entry's text, not just its name/)
  assert.match(section, /[Cc]ite the concrete artifact/)
  assert.match(section, /this condition does not apply/)
  assert.match(section, /[Nn]ame the specific line that disproves it/)
})

// --- 30. mandatory audit line shape ---
test('qa-gate.md: the audit line is mandatory and includes the P of M denominator and the floor-promotion flag', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /absence is itself an escalation to the user/)
  assert.match(section, /consolidated N findings from M members \(P of M supplied structured findings\) -> K \(X merged, Y dropped, Z re-categorized\); drops cited below/)
  assert.match(section, /mechanical size floor/)
  assert.match(section, /size-promoted findings from risk-driven ones/)
})

// --- 31. both escalation directions ---
test('qa-gate.md: escalation runs in both directions', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /said \*\*block\*\*, the gate still blocks even if every one of the blocking findings was later dropped/)
  assert.match(section, /upgrades a finding into `critical`, the gate blocks even though step 0's raw count said pass/)
})

// --- 32. two drop vocabularies reconciled ---
test('qa-gate.md: the two drop vocabularies (pr-review speculative-drop vs. consolidation step-4) are explicitly reconciled', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /pr-review\.md/)
  assert.match(section, /speculative/)
  assert.match(section, /independently-scoped rules for two different situations/)
  assert.match(section, /must not be merged/)
})

// --- 33. drift: agents/qa-lead.md carries the invariant + absolute + authorship rule ---
test('agents/qa-lead.md carries the stricter-never-looser invariant, the critical-never-dropped absolute, and the (user)-authorship rule, without contradicting qa-gate.md', () => {
  assert.match(qaLeadMd, /consolidation may only make the gate stricter, never looser/i)
  assert.match(qaLeadMd, /a `critical` is never dropped, only escalated to the user/)
  assert.match(qaLeadMd, /[Oo]nly the user may author a `\(user\)` disposition/)
  assert.match(qaLeadMd, /never `wont-fix \(user\)`\/`disagreed \(user\)` on the user's behalf/)
})

// --- 34. drift: qa-lead.md's dedup restatement says "normalized" too ---
test('agents/qa-lead.md restates the dedup key as "normalized `file`", matching qa-gate.md', () => {
  assert.match(qaGateMd, /same normalized `file`/)
  assert.match(qaLeadMd, /same normalized `file`/)
})

// --- 35. drift: the mandatory audit-line shape is verbatim-identical ---
test('qa-gate.md and agents/qa-lead.md carry the identical mandatory audit-line shape', () => {
  const AUDIT_LINE = 'consolidated N findings from M members (P of M supplied structured findings) -> K (X merged, Y dropped, Z re-categorized); drops cited below'
  assert.ok(qaGateMd.includes(AUDIT_LINE), 'qa-gate.md missing the frozen audit-line shape')
  assert.ok(qaLeadMd.includes(AUDIT_LINE), 'qa-lead.md missing the frozen audit-line shape')
})

// --- 36. drift: the five-member disposition enum is verbatim-identical ---
test('qa-gate.md and agents/qa-lead.md carry the identical five-member disposition enum', () => {
  const ENUM_TOKENS = ['`fixed`', '`open`', '`wont-fix (user)`', '`disagreed (user)`', '`deferred (issue #N)`']
  for (const token of ENUM_TOKENS) {
    assert.ok(qaGateMd.includes(token), `qa-gate.md missing disposition enum token: ${token}`)
    assert.ok(qaLeadMd.includes(token), `qa-lead.md missing disposition enum token: ${token}`)
  }
})

// qa-13-a3 round-3 panel fix-round: test-pin every new safety rule
// -------------------------------------------------------------------------

// --- 37. step 0's restored qualifiers ---
test('qa-gate.md: step 0 states strict majority and the still-inconclusive-after-bounded-re-runs qualifier', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*0\. Freeze the verdict arithmetic first\*\*/)
  assert.match(section, /\*\*strict majority\*\* count of the literal token `pass`/)
  assert.match(section, /\(still inconclusive after its bounded re-runs\)/)
  assert.match(section, /re-run loop.*must complete BEFORE step 0 freezes anything/)
})

// --- 38. critical-row deferral authorship bar ---
test('qa-gate.md: gate-memory forbids the orchestrator from authoring deferred on a critical row', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /A `critical`-severity row may only carry `deferred \(issue #N\)` if the USER authored the deferral/)
  assert.match(section, /the orchestrator may never author `deferred` on a critical row/)
})

// --- 39. critical-row restatement duty ---
test('qa-gate.md: every critical-severity carry-forward row must be restated each round, never silently rolled forward', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /Every `critical`-severity row in a carry-forward table must be RESTATED, not silently rolled forward/)
})

// --- 40. deferred-is-not-a-don't-re-raise carve-out ---
test('qa-gate.md: deferred is not a dont-re-raise instruction for the reviewer, unlike wont-fix/disagreed', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /A `deferred` row is not a "don't re-raise" instruction for the reviewer, unlike `wont-fix \(user\)`\/`disagreed \(user\)`/)
  assert.match(section, /SHOULD still report it, since deferral is scheduling, not dismissal/)
})

// --- 41. unstructured-member prose-critical MUST BLOCK rule, never weakened ---
test('qa-gate.md: an unstructured members prose-critical MUST BLOCK PENDING ESCALATION, never weakened to "may block"', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /it MUST BLOCK PENDING ESCALATION exactly as a structured `critical` finding would — never weakened to "may block"/)
})

// --- 42. dedup content-preserving clause, per-finding wording ---
test('qa-gate.md: dedup is content-preserving and retains every merged findings summary text, per-finding not per-member', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*A merge is content-preserving:\*\* the merged entry retains every \*\*merged finding's\*\* `summary` text as a list, none discarded/)
  assert.match(section, /a member may appear more than once in the list if it raised multiple distinct findings that all merged into this group/)
  assert.match(section, /this is per-finding, not per-member/)
})

// --- 43. under-merging-is-safe clause ---
test('qa-gate.md: when same-defect is uncertain, do not merge — under-merging is the safe direction', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*When "same defect" is uncertain, do not merge\*\* — under-merging \(an extra finding surfaces\) is the safe direction, over-merging \(content lost\) is not/)
})

// --- 44. per-member-severity retention clause ---
test('qa-gate.md: dedup records the severity each member individually assigned it', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /the severity \*\*each of those members individually assigned it\*\*/)
})

// --- 45. normalized-file definition ---
test('qa-gate.md: normalized file is a repo-relative POSIX path, and a non-normalizable basename never merges', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*Normalized `file`, for this key:\*\* a repo-relative POSIX path, stripping a leading `\.\/`/)
  assert.match(section, /a bare basename that cannot be resolved to a unique tracked path is not normalizable and never merges with anything/)
})

// --- 46. worktree-anchor stripping (S2) ---
test('qa-gate.md: file normalization strips both the repo-root prefix and a per-agent worktree segment', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /strip any leading `<repo-root>\/` and, for a dispatch running inside this repo's own per-agent worktree layout, any leading `\.claude\/worktrees\/<id>\/` segment too/)
  assert.match(section, /relative to the reviewer's own repo\/worktree root/)
})

// --- 47. clique construction, not connected-component over-merging (S1) ---
test('qa-gate.md: a merged group must be a clique of the pairwise relation, not a connected component that over-merges under certainty', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*A merged group must be a CLIQUE of that pairwise relation, not merely a connected component:\*\*/)
  assert.match(section, /never merges all three into one group \(that would be over-merging under certainty, directly contradicting the under-merging-is-safe rule below\)/)
})

// --- 48. drop condition (a) pre-dating + (b) actual-words tightening ---
test('qa-gate.md: drop condition (a) requires the cited entry pre-date the round, and (b) requires quoting the users actual words', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /The cited entry must PRE-DATE this gate round \(cite its date\)/)
  assert.match(section, /quote the USER'S ACTUAL WORDS and say where they said them/)
})

// --- 49. step 5 counting-units clarification + coverage-declaration gap ---
test('qa-gate.md: step 5 states counting units explicitly and flags a shared coverage-declaration gap', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*Counting units, made explicit:\*\* `X` \(merged\) counts findings ABSORBED by a merge/)
  assert.match(section, /\*\*Coverage-declaration gap\.\*\* If every panel member's coverage declaration/)
})

// --- 50. drop-vocabulary sequencing softening, reciprocal in both files ---
test('qa-gate.md and pr-review.md both state the speculative-drop rule runs second, not first, on the panel path', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /pr-review\.md`'s speculative-drop rule runs second, not first/)
  const prReviewMd = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8')
  assert.match(prReviewMd, /this drop rule runs second, not first/)
})

// --- 51. M1: prior-severity-is-not-independently-chosen rule ---
test('qa-gate.md: prior severity in the carry-forward table must reproduce the actual severity, never independently chosen or lowered', () => {
  const section = extractSection(qaGateMd, GATE_MEMORY_HEADING)
  assert.match(section, /\*\*`prior severity` reproduces the finding's actual severity from the round it was raised — it is NEVER independently chosen or lowered when composing the table\.\*\*/)
  assert.match(section, /sidesteps the bar entirely, since it never triggers/)
  assert.match(section, /legitimate only via the consolidation pass's own step-3 re-categorization/)
})

// --- 52: S4 merged entry is report-only, never a fenced verdict json block ---
test('qa-gate.md: a merged entry is a gate-report/audit-line construct only, never emitted into a fenced verdict json block', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /\*\*A merged entry is a gate-report\/audit-line construct only, never emitted into a fenced verdict JSON block\*\*/)
  assert.match(section, /additionalProperties.*false/)
})

// --- 53: S5 four-keys-plus-member off-by-one fix ---
test('qa-gate.md: normalize step states four keys (not five) plus the member', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /the same four keys as the frozen `findings\[\]` entry, plus the member/)
  assert.equal(/the same five keys as the frozen `findings\[\]` entry plus the member/.test(qaGateMd), false)
})

// --- 54: S8 landing point — critical row forces a gate-report file even on a clean pass ---
test('qa-gate.md: a critical carry-forward row forces the gate-report file to be written even on a clean pass', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /if the carry-forward table contains any `critical`-severity row, write the gate-report file even when this round's gate PASSES clean/)
})

// --- 55: S9 landing point — unstructured-member prose-critical in step 6's escalation paths ---
test('qa-gate.md: step 6 names the unstructured-member prose-critical case as a third escalation path', () => {
  const section = extractSection(qaGateMd, CONSOLIDATION_HEADING)
  assert.match(section, /A third path lands here too: step 1's unstructured-member prose-critical case/)
})

// --- 56: S6 reviewer role files carry the deferred-not-settled carve-out ---
test('agents/code-reviewer.md and code-reviewer-deep.md state that a deferred row is not settled', () => {
  for (const [name, body] of [['code-reviewer.md', codeReviewerMd], ['code-reviewer-deep.md', codeReviewerDeepMd]]) {
    assert.match(body, /A `deferred \(issue #N\)` row is NOT settled — deferral is scheduling, not dismissal — so report the defect again if you re-encounter it\./, `${name}: missing deferred-not-settled carve-out`)
  }
})

// ---------------------------------------------------------------------------
// be-41-06 (issue #41, epic #39) — mirroring a gate result into the ledger
// ---------------------------------------------------------------------------

const GATE_LEDGER_HEADING = '## Mirroring a gate result into the ledger (#40, issue #41)'

test('qa-gate.md: the gate-ledger section is found and states how emit.mjs gate mirrors a chain-check report', () => {
  const section = extractSection(qaGateMd, GATE_LEDGER_HEADING)
  assert.match(section, /node scripts\/factory\/emit\.mjs gate --report <path> --state-dir <stateDir>/)
  assert.match(section, /adw_id`\/`phase_id` from the run's sidecar, a slice-qualified `gate_name`/)
  assert.match(section, /never re-shaped or summarized/)
})

test('qa-gate.md: the gate-ledger section states a mirror failure can never alter the gate\'s own verdict', () => {
  const section = extractSection(qaGateMd, GATE_LEDGER_HEADING)
  assert.match(section, /can never alter the gate's own verdict/)
  assert.match(section, /never in the gate's exit code or its parsed `\{verdict, findings\}`/)
})

test('qa-gate.md: run-level acceptance requires every emit.mjs stats drop counter to read zero', () => {
  const section = extractSection(qaGateMd, GATE_LEDGER_HEADING)
  assert.match(section, /\*\*Run-level acceptance requires every one of `emit\.mjs stats`'s drop counters to read zero\*\*/)
  for (const key of ['emitted', 'dropped', 'lock_giveups', 'resolution_ambiguous', 'resolution_missing', 'payload_keys_dropped']) {
    assert.match(section, new RegExp(key))
  }
})
