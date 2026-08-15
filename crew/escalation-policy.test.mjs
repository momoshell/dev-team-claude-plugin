import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REGRANT_CONDITIONS, regrantVerdict, continuationBrief } from './escalation-policy.mjs'

const LEAD_WHY = 'I cannot accept this as a livable residual. The whole point of the slice is a gate that refuses when spend is unknown (plan decision 3); RV3-1 is that gate quietly reading zero forever on Node 22 — a user who configures a ceiling believes it is on when it is not, which is precisely the unbounded-burn failure #39 exists to prevent. So it is must-fix-now, not should-fix-later, and \'accept\' is the wrong instrument. Nor can I bounce: build rounds are exhausted, and this is the third round in a row surfacing the same class of defect (r1: interactive-only measurement; r2: Node 20 absent-db reads zero; r3: Node 22 requireable-but-below-floor reads zero) — the crew keeps closing the instance and missing the class, which is the escalation trigger. The call to spend beyond the allotted rounds, or to ship a knowingly non-enforcing ceiling, belongs to the orchestrator.'
const escalation = {
  status: 'escalation',
  summary: `Task 193-budget needs a human: ${LEAD_WHY}`,
  details: {
    escalation: { where: 'review', why: LEAD_WHY },
    commit: null,
    extra_rounds_granted: [{ where: 'review', round: 3 }],
    gate: { cmd: 'node /Users/x/.crew/dev-team-claude-plugin/193-budget/task/gate.mjs', repairs: 0, generation: 1, discrimination: 'proven' },
  },
}
const rows = [
  {
    dispatch: 'd3', verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0,
    findings: [
      { id: 'RV1-1', severity: 'must-fix', location: 'crew/child.mjs:99', summary: 'An existing emitter sidecar can redirect daemon child usage to an old DB, leaving the configured budget ledger blind.' },
      { id: 'RV1-2', severity: 'must-fix', location: 'crew/daemon.test.mjs:671', summary: 'The Node 20 CI lane fails the new SQLite tests (including :1028) because node:sqlite is unavailable below the ledger floor.' },
      { id: 'RV1-3', severity: 'should-fix', location: 'crew/daemon.mjs:794', summary: 'A giant but accepted integer window_ms throws a raw RangeError at enqueue instead of producing a readable budget outcome.' },
    ],
  },
  {
    dispatch: 'd5', verdict: 'changes-needed', must_fix: 2, should_fix: 0, consider: 0,
    findings: [
      { id: 'RV2-1', severity: 'must-fix', location: 'crew/daemon.mjs:188', summary: 'On Node 20, a fresh configured ledger stays absent after JSONL-only emitter degradation, so every budget admission is incorrectly measured as zero.' },
      { id: 'RV2-2', severity: 'must-fix', location: 'crew/child.mjs:126', summary: 'A stale sidecar mismatch escalates and suppresses driveTask even when the daemon has no budget, making optional instrumentation load-bearing.' },
    ],
  },
  {
    dispatch: 'd8', verdict: 'changes-needed', must_fix: 1, should_fix: 0, consider: 0,
    findings: [
      { id: 'RV3-1', severity: 'must-fix', location: 'crew/daemon.mjs:191', summary: 'Node 22 can require node:sqlite but is below the emitter’s Node 24 floor, so fresh budgeted work writes no DB while usageWindow repeatedly admits it as zero.' },
    ],
  },
]
const clone = (value) => JSON.parse(JSON.stringify(value))

test('the replay shape is eligible and reasons stay ordered', () => {
  const verdict = regrantVerdict(escalation, rows, { regranted: false })
  assert.equal(verdict.eligible, true)
  assert.deepEqual(verdict.reasons.map((reason) => reason.condition), REGRANT_CONDITIONS)
  assert.deepEqual(verdict.reasons.map((reason) => reason.ok), [true, true, true, true, true])
})

test('each condition can independently make a verdict ineligible', () => {
  const cases = [
    ['where-review', () => { const value = clone(escalation); value.details.escalation.where = 'plan'; return [value, rows, { regranted: false }] }],
    ['grant-spent', () => { const value = clone(escalation); value.details.extra_rounds_granted = []; return [value, rows, { regranted: false }] }],
    ['must-fix-converging', () => [escalation, [rows[2], rows[1], rows[0]], { regranted: false }]],
    ['gate-proven', () => { const value = clone(escalation); value.details.gate.discrimination = 'unproven'; return [value, rows, { regranted: false }] }],
    ['regrant-budget', () => [escalation, rows, { regranted: true }]],
  ]
  for (const [condition, build] of cases) {
    const verdict = regrantVerdict(...build())
    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reasons.find((reason) => reason.condition === condition)?.ok, false)
  }
})

test('must-fix counts converge at one but not above one, and ledger rows are accepted', () => {
  assert.equal(regrantVerdict(escalation, [{ dispatch_id: 'd3', must_fix: 2 }, { dispatch_id: 'd8', must_fix: 1 }], {}).eligible, true)
  const above = clone(rows); above.at(-1).must_fix = 2
  assert.equal(regrantVerdict(escalation, above, {}).eligible, false)
  assert.equal(regrantVerdict(escalation, [{ must_fix: 1 }, { must_fix: 2 }], {}).eligible, false)
})

test('malformed envelopes and absent review rows fail closed without throwing', () => {
  for (const value of [null, {}, { details: null }]) {
    assert.doesNotThrow(() => regrantVerdict(value, [], {}))
    const verdict = regrantVerdict(value, [], {})
    assert.equal(verdict.eligible, false)
    assert.equal(verdict.reasons.length, 5)
  }
  assert.equal(regrantVerdict(escalation, [{ must_fix: '1' }], {}).eligible, false)
})

test('continuation briefs are byte-stable and preserve the full markdown contract', () => {
  const input = {
    findings: [{ id: 'RV3-1', severity: 'must-fix', location: 'crew/daemon.mjs:191', summary: 'new defect class' }],
    guidance: 'Lead guidance is verbatim.\nKeep this line.',
    branch: 'feat/193-budget',
    commit: 'abc123',
  }
  const expected = '# Continuation round (regranted)\n\nThis is a delta-briefed continuation of an escalated run, granted once and never again for this task.\n\n## Why this run exists\n\nLead guidance is verbatim.\nKeep this line.\n\n## Remaining findings — close every one\n\n- **RV3-1** (must-fix) — crew/daemon.mjs:191 — new defect class\n\n## Where the work is\n\nThe prior round\'s changes are UNCOMMITTED in the crew\'s checkout.\nBranch: feat/193-budget\nBase commit: abc123\n\n## Standing instruction — extend the acceptance gate\n\nThe acceptance gate must grow a check for the NEW defect class so it is RED at baseline. A continuation whose gate already covers the fix trips crew/drive.mjs\'s gate-baseline:green-bounce.\n\n## Bounds\n\nDo not widen scope beyond the findings above; the plan of record stands; there is no second regrant.\n'
  assert.equal(continuationBrief(input), expected)
  assert.equal(continuationBrief(input), continuationBrief(clone(input)))
})

test('empty findings and null branch/commit are rendered deterministically', () => {
  const brief = continuationBrief({ findings: [], guidance: 'why', branch: null, commit: null })
  assert.match(brief, /- \(none recorded — read the last review\.md in the task dir\)/)
  assert.doesNotMatch(brief, /^Branch:/m)
  assert.doesNotMatch(brief, /^Base commit:/m)
  assert.equal(brief.endsWith('\n'), true)
  assert.equal(brief.endsWith('\n\n'), false)
})
