import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  REGRANT_CONDITIONS, regrantVerdict, continuationBrief,
  parseLocation, fuseFindings, adjudicatePanel,
  ESCALATION_QUESTION_TYPES, ESCALATION_QUESTIONS, ESCALATION_WHERE,
  validateEscalationQuestions, escalationQuestion, resolutionDefect,
} from './escalation-policy.mjs'

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

const finding = (id, severity = 'must-fix', location = 'a.mjs:1', summary = id) => ({
  id, severity, location, summary,
})

test('panel locations parse the supported forms and reject malformed values', () => {
  const cases = [
    ['a/b.mjs', { file: 'a/b.mjs', start: null, end: null }],
    [' a/b.mjs:12 ', { file: 'a/b.mjs', start: 12, end: 12 }],
    ['a/b.mjs:12-30', { file: 'a/b.mjs', start: 12, end: 30 }],
    ['a/b.mjs:12:5', { file: 'a/b.mjs', start: 12, end: 12 }],
    ['', { file: null, start: null, end: null }],
    ['a/b.mjs:bad', { file: null, start: null, end: null }],
    [null, { file: null, start: null, end: null }],
    [{ toString: () => 'a/b.mjs:1' }, { file: null, start: null, end: null }],
  ]
  for (const [input, expected] of cases) assert.deepEqual(parseLocation(input), expected, JSON.stringify(input))
})

test('fuseFindings matches ranges greedily and leaves ordered divergences', () => {
  const a = [
    finding('a1', 'must-fix', 'a.mjs:10-20'),
    finding('a2', 'should-fix', 'a.mjs:40-42'),
  ]
  const b = [
    finding('b1', 'must-fix', 'a.mjs:15-25'),
    finding('b2', 'must-fix', 'a.mjs:18-19'),
    finding('b3', 'should-fix', 'a.mjs:60'),
  ]
  const out = fuseFindings(a, b, { sourceA: 'reviewer', sourceB: 'planner' })
  assert.deepEqual(out.consensus.map(({ id, matched }) => [id, matched]), [['a1', { reviewer: 'a1', planner: 'b1' }]])
  assert.deepEqual(out.divergent.map(({ id, source }) => [id, source]), [
    ['a2', 'reviewer'], ['b2', 'planner'], ['b3', 'planner'],
  ])
})

test('fuseFindings treats file-level findings as whole-file and skips malformed entries', () => {
  const a = [null, finding('a1', 'must-fix', 'a.mjs'), finding('', 'must-fix', 'a.mjs'), finding('a2', 'must-fix', null)]
  const b = [finding('b1', 'must-fix', 'a.mjs:99'), finding('b2', 'must-fix', 'a.mjs:1-2')]
  const before = clone({ a, b })
  const first = fuseFindings(a, b)
  const second = fuseFindings(a, b)
  assert.equal(first.consensus.length, 1)
  assert.deepEqual(first.divergent.map(({ id }) => id), ['a2', 'b2'])
  assert.deepEqual(a, before.a)
  assert.deepEqual(b, before.b)
  assert.deepEqual(second, first)
  assert.deepEqual(fuseFindings([finding('x', 'must-fix', 'a.mjs:1')], [finding('y', 'should-fix', 'a.mjs:1')]).divergent.map(({ id }) => id), ['x', 'y'])
})

test('adjudicatePanel dismisses only explicit dismiss decisions and fails closed', () => {
  const divergent = [
    { ...finding('a1'), source: 'reviewer' },
    { ...finding('b1'), source: 'planner' },
    { ...finding('c1'), source: 'planner' },
  ]
  const out = adjudicatePanel(divergent, {
    adjudications: [
      { id: 'a1', disposition: 'dismiss', reason: 'not a defect' },
      { id: 'b1', disposition: 'unknown' },
      { id: 'missing', disposition: 'dismiss' },
    ],
    class_invariant: 'the class remains open', closes_class: true,
  })
  assert.deepEqual(out.dismissed.map(({ id, reason }) => [id, reason]), [['a1', 'not a defect']])
  assert.deepEqual(out.upheld.map(({ id }) => id), ['b1', 'c1'])
  assert.equal(out.classInvariant, 'the class remains open')
  assert.equal(out.closesClass, true)
  assert.deepEqual(adjudicatePanel(divergent, null).upheld.map(({ id }) => id), ['a1', 'b1', 'c1'])
  assert.equal(adjudicatePanel(divergent, { closes_class: 'true' }).closesClass, false)
})

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

test('a harden escalation is never eligible for the review regrant', () => {
  const harden = clone(escalation)
  harden.details.escalation.where = 'harden'
  const verdict = regrantVerdict(harden, rows, { regranted: false })
  const reason = verdict.reasons.find((entry) => entry.condition === 'where-review')
  assert.equal(verdict.eligible, false)
  assert.equal(reason?.ok, false)
  assert.match(reason?.detail || '', /harden, not review/)
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

test('A1', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const reachable = []
  const dynamic = []
  const boundary = source.indexOf('  const driveTriageRound = () => {')
  const directedBoundary = source.indexOf('  const driveDirectedRound = () => {')
  for (const match of source.matchAll(/\bescalate\s*\(/g)) {
    const before = source.slice(Math.max(0, match.index - 80), match.index)
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    if (source.slice(lineStart, match.index).includes('//')) continue
    if (/function\s+$/.test(before) || /escalationResult/.test(before)) continue
    let cursor = match.index + match[0].length
    while (/\s/.test(source[cursor] || '')) cursor += 1
    if (source[cursor] === "'") {
      const end = source.indexOf("'", cursor + 1)
      reachable.push(source.slice(cursor + 1, end))
      continue
    }
    const newline = source.indexOf('\n', cursor)
    const line = source.slice(cursor, newline < 0 ? source.length : newline).trim()
    if (line.startsWith('variant')) {
      dynamic.push('variant')
      reachable.push(match.index < boundary ? 'scout' : match.index >= directedBoundary ? 'directed' : 'unknown-dynamic')
    } else if (line.startsWith('PLAN_SCOPE.malformed')) {
      dynamic.push('PLAN_SCOPE.malformed')
      reachable.push('plan-scope-malformed')
    } else if (line.startsWith('PLAN_SCOPE.widened')) {
      dynamic.push('PLAN_SCOPE.widened')
      reachable.push('plan-scope-widened')
    } else if (line.startsWith('revalidated.kind')) {
      dynamic.push('revalidated.kind')
      reachable.push(...['scope', 'lane', 'gate'])
    } else {
      assert.fail(`unrecognized dynamic escalation where: ${line}`)
    }
  }
  assert.deepEqual([...new Set(reachable)].sort(), Object.keys(ESCALATION_QUESTIONS).sort())
  assert.deepEqual(dynamic.sort(), ['PLAN_SCOPE.malformed', 'PLAN_SCOPE.widened', 'revalidated.kind', 'variant', 'variant', 'variant', 'variant'].sort())
  for (const forbidden of ['full', 'repair', 'plan-scope-undispatched', 'plan-scope-same', 'plan-scope-narrowed']) {
    assert.equal(Object.hasOwn(ESCALATION_QUESTIONS, forbidden), false)
  }
  const missing = { ...ESCALATION_QUESTIONS }
  delete missing.scope
  assert.ok(validateEscalationQuestions(missing).some((defect) => defect.includes('scope') && defect.includes('missing')))
})

test('B1', () => {
  assert.deepEqual(ESCALATION_QUESTION_TYPES, ['single-choice', 'free-text'])
  assert.equal(Object.isFrozen(ESCALATION_QUESTION_TYPES), true)
  assert.equal(Object.isFrozen(ESCALATION_QUESTIONS), true)
  assert.equal(Object.isFrozen(ESCALATION_WHERE), true)
  for (const where of ESCALATION_WHERE) {
    const question = ESCALATION_QUESTIONS[where]
    assert.equal(Object.isFrozen(question), true)
    if (question.options !== undefined) assert.equal(Object.isFrozen(question.options), true)
    if (question.slots !== undefined) assert.equal(Object.isFrozen(question.slots), true)
    assert.ok(ESCALATION_QUESTION_TYPES.includes(question.type))
  }
  assert.deepEqual(ESCALATION_QUESTIONS.scope.options, ['widen-fence-to', 'split-lane', 'park'])
  assert.deepEqual(ESCALATION_QUESTIONS['plan-check'].options, ['adopt-and-continue', 're-dispatch', 'park'])
  assert.deepEqual(ESCALATION_QUESTIONS['review-unresolved'].options, ['adopt-and-continue', 're-dispatch', 'park'])
  assert.deepEqual(ESCALATION_QUESTIONS.rebase.options, ['resolve-and-continue', 'park'])
  for (const answer of [null, [], {}, { type: 'single-choice', value: 'park', extra: true }]) {
    assert.notEqual(resolutionDefect('scope', answer), null)
  }
  assert.notEqual(resolutionDefect('scope', { type: 'free-text', value: 'park' }), null)
  assert.notEqual(resolutionDefect('scope', { type: 'single-choice', value: 'not-declared' }), null)
  assert.notEqual(resolutionDefect('scope', { type: 'single-choice', value: '' }), null)
  assert.notEqual(resolutionDefect('missing', { type: 'free-text', value: 'answer' }), null)
  assert.equal(resolutionDefect('scope', { type: 'single-choice', value: 'park' }), null)
  assert.equal(resolutionDefect('plan', { type: 'free-text', value: 'continue after review' }), null)
})

test('D1', () => {
  for (const [where, question] of Object.entries(ESCALATION_QUESTIONS)) {
    if (question.type !== 'free-text') continue
    assert.equal(typeof question.reason, 'string')
    assert.ok(question.reason.trim())
    assert.equal(Object.hasOwn(question, 'options'), false)
    const materialized = escalationQuestion(where)
    assert.equal(materialized.options, undefined)
    assert.equal(resolutionDefect(where, { type: 'free-text', value: 'human guidance' }), null)
  }
})
