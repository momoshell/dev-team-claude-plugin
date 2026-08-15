// crew/converge.test.mjs — pure, byte-stable renderers for #207.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GATE_OUTPUT_TAIL, GATE_RESIDUAL_ID, SEVERITY_RANK,
  draftPrBody, draftPrTitle, followUpIssueBody, followUpIssueTitle,
  gateSummaryLine, residualList,
} from './converge.mjs'

const GATE_OUT = [
  'check 1: expected converge terminal, found none, at crew/drive.mjs',
  'check 2: expected draftPrBody, found none, at crew/converge.mjs',
  'GATE-SUMMARY {"total":3,"failed":2,"errored":0}',
].join('\n')
const GATE_LINE = 'GATE-SUMMARY {"total":3,"failed":2,"errored":0}'
const GATE_SUMMARY = Object.freeze({ line: GATE_LINE, output: GATE_OUT, total: 3, failed: 2, errored: 0 })
const ESCALATION = Object.freeze({ where: 'gate', why: 'the gate is red on two named checks\nand the builder is out of rounds' })
const HISTORY = Object.freeze(['plan:r1', 'gate-baseline', 'build:r1', 'lane:r1', 'gate:r1'])
const FINDINGS = [
  { id: 'F-2', severity: 'should-fix', location: 'crew/drive.mjs:10', summary: 'tighten the wording' },
  { id: 'F-1', severity: 'must-fix', location: 'crew/converge.mjs:4', summary: 'residual not voiced', issue: { number: 501, url: 'https://example.invalid/501' } },
]

const fixtureResiduals = () => residualList({ findings: FINDINGS, gateSummary: GATE_SUMMARY })
const fixtureBody = (findings = fixtureResiduals()) => draftPrBody({
  gateSummary: GATE_SUMMARY, findings, escalation: ESCALATION, roundHistory: HISTORY,
})

const EXPECTED_BODY = `This is a DRAFT PR: the work is committed, the full suite is green, and the acceptance gate is red. Merge authority is human; nothing here marks this PR ready.

## Residuals (unresolved — read these first)
- **must-fix** \`gate-red\` — the acceptance gate is red on 2 of 3 checks
- **must-fix** \`F-1\` — residual not voiced (at crew/converge.mjs:4) (follow-up: #501)
- **should-fix** \`F-2\` — tighten the wording (at crew/drive.mjs:10)

## Gate summary (verbatim)
\`\`\`
GATE-SUMMARY {"total":3,"failed":2,"errored":0}
\`\`\`

## Gate output (last 4000 chars, verbatim)
\`\`\`
check 1: expected converge terminal, found none, at crew/drive.mjs
check 2: expected draftPrBody, found none, at crew/converge.mjs
GATE-SUMMARY {"total":3,"failed":2,"errored":0}
\`\`\`

## Why this settled here
the gate is red on two named checks
and the builder is out of rounds

(escalated at: gate)

## Round history
1. plan:r1
2. gate-baseline
3. build:r1
4. lane:r1
5. gate:r1
`

test('draftPrBody renders the complete fixture byte-for-byte', () => {
  assert.equal(fixtureBody(), EXPECTED_BODY)
})

test('draftPrBody is deterministic and stable under finding reordering', () => {
  const first = fixtureBody()
  const second = fixtureBody()
  const reordered = fixtureBody(residualList({ findings: [...FINDINGS].reverse(), gateSummary: GATE_SUMMARY }))
  assert.equal(first, second)
  assert.equal(first, reordered)
})

test('residuals render before the verbatim gate summary and every round appears in order', () => {
  const body = fixtureBody()
  assert.ok(body.indexOf(GATE_RESIDUAL_ID) < body.indexOf(GATE_LINE))
  assert.ok(body.indexOf('F-1') < body.indexOf(GATE_LINE))
  assert.ok(body.indexOf('F-2') < body.indexOf(GATE_LINE))
  assert.ok(body.includes(ESCALATION.why))
  let previous = -1
  for (const entry of HISTORY) {
    const at = body.indexOf(entry)
    assert.ok(at > previous)
    previous = at
  }
  assert.match(body, /\(follow-up: #501\)/)
})

test('no findings leaves exactly the synthetic gate residual and tail-quotes long output', () => {
  const output = `${'x'.repeat(GATE_OUTPUT_TAIL + 17)}\n${GATE_LINE}`
  const summary = { ...GATE_SUMMARY, output }
  assert.deepEqual(residualList({ gateSummary: summary }), [{
    id: GATE_RESIDUAL_ID, severity: 'must-fix', location: null,
    summary: 'the acceptance gate is red on 2 of 3 checks',
  }])
  const body = draftPrBody({
    gateSummary: summary,
    findings: residualList({ gateSummary: summary }),
    escalation: ESCALATION,
    roundHistory: HISTORY,
  })
  assert.equal(body.includes('x'.repeat(GATE_OUTPUT_TAIL + 1)), false)
  assert.ok(body.includes(output.slice(-GATE_OUTPUT_TAIL)))
  assert.ok(body.includes(GATE_LINE))
})

test('gateSummaryLine returns the last raw summary line or null', () => {
  assert.equal(gateSummaryLine(`GATE-SUMMARY first\n  ${GATE_LINE}  `), GATE_LINE)
  assert.equal(gateSummaryLine('no summary here\nnot a summary'), null)
})

test('residualList drops malformed entries and sorts severity stably', () => {
  const findings = [
    { id: 'c1', severity: 'consider', summary: 'c1' },
    null,
    { id: 'bad', severity: 'nope', summary: 'drop' },
    { id: 's1', severity: 'should-fix', summary: 's1' },
    { id: 'm1', severity: 'must-fix', summary: 'm1' },
    { id: 'm2', severity: 'must-fix', summary: 'm2' },
    'not an object',
    { id: 's2', severity: 'should-fix', summary: 's2' },
    { id: 'c2', severity: 'consider', summary: 'c2' },
  ]
  const out = residualList({ findings, gateSummary: { total: 4, failed: 1 } })
  assert.deepEqual(out.map(({ id }) => id), ['gate-red', 'm1', 'm2', 's1', 's2', 'c1', 'c2'])
  assert.deepEqual(SEVERITY_RANK, { 'must-fix': 0, 'should-fix': 1, consider: 2 })
})

test('residualList omits the synthetic gate residual for a green gate', () => {
  const findings = [
    { id: 'c1', severity: 'consider', summary: 'c1' },
    { id: 's1', severity: 'should-fix', summary: 's1' },
    { id: 'm1', severity: 'must-fix', summary: 'm1' },
  ]
  assert.deepEqual(residualList({ findings, gateSummary: { total: 3, failed: 0 }, gateRed: false }).map(({ id }) => id), ['m1', 's1', 'c1'])
  assert.deepEqual(residualList({ gateSummary: { total: 3, failed: 0 }, gateRed: false }), [])
})

test('residualList defaults to the existing gate-red shape', () => {
  const args = { findings: FINDINGS, gateSummary: GATE_SUMMARY }
  assert.deepEqual(residualList(args), residualList({ ...args, gateRed: true }))
})

test('follow-up title truncates at 120 characters and PR title is fixed', () => {
  const title = followUpIssueTitle({ task: 't207', residual: { id: 'F', summary: 'z'.repeat(200) } })
  assert.equal(title.length, 120)
  assert.equal(title.endsWith('…'), true)
  assert.equal(draftPrTitle({ task: 't207' }), 'crew(t207): converged with residuals — DRAFT, not mergeable')
})

test('followUpIssueBody is exact and retains verbatim gate and escalation text', () => {
  const residual = { id: 'F-1', severity: 'must-fix', location: 'crew/converge.mjs:4', summary: 'residual not voiced' }
  const expected = `# Residual follow-up for t207

## What is unresolved
- **id:** \`F-1\`
- **severity:** must-fix
- **location:** crew/converge.mjs:4
- **summary:** residual not voiced

## Gate summary (verbatim)
\`\`\`
${GATE_LINE}
\`\`\`

## Escalation reasoning (verbatim)
line one
line two

(escalated at: gate)

The work shipped as a DRAFT PR; this issue is its residual record.
`
  assert.equal(followUpIssueBody({ task: 't207', residual, gateSummary: GATE_SUMMARY, escalation: { where: 'gate', why: 'line one\nline two' } }), expected)
})

test('draftPrBody changes the opening only for a green gate', () => {
  const body = draftPrBody({
    gateSummary: { ...GATE_SUMMARY, line: 'GATE-SUMMARY {"total":3,"failed":0,"errored":0}' },
    findings: FINDINGS,
    escalation: { where: 'review', why: 'review findings remain' },
    roundHistory: HISTORY,
    gateRed: false,
  })
  assert.equal(body.includes('gate is red'), false)
  assert.match(body, /acceptance gate is green — but unresolved review findings remain/)
  assert.match(fixtureBody(), /gate is red/)
})
