// F2 — a LATER reviewer envelope that carries no typed findings CLOBBERS the
// canonical finding set, and the exhaustion-time accept contract silently
// disappears: the lead accepts with no residual/refutation accounting at all
// and the run COMMITS.
//
// crew/drive.mjs:1798  `if (review) S.acceptFindings = review.findings ?? null`
//                      (unconditional — a verdict without findings writes null)
// crew/drive.mjs:1799  `if (review?.findings) S.lastReview = review`
//                      (conditional — the SAME two lines disagree)
// crew/drive.mjs:1122-1123 documents the intended contract: "the normalized
//                      array from the LAST reviewer envelope THAT CARRIED ONE".
//
// Run:  node f2-acceptfindings-clobber.mjs
import { load, fakeIo, CTX, TD } from './harness.mjs'

const drive = await load()
const { driveTask } = drive

const r1Findings = [
  { id: 'F1', severity: 'must-fix', location: 'a/b.mjs:10', summary: 'unhandled null deref' },
  { id: 'F2', severity: 'must-fix', location: 'a/b.mjs:20', summary: 'race on the ready column' },
  { id: 'F3', severity: 'should-fix', location: 'a/b.mjs:30', summary: 'duplicated constant' },
]

function run({ degradeRound2 }) {
  const io = fakeIo(drive, {
    changed: ['a/b.mjs'],
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    envelopes: {
      'planner:1': {
        status: 'done', summary: 'plan', artifacts: [`${TD}/plan.md`],
        details: { plan_path: `${TD}/plan.md`, files_in_scope: ['a/b.mjs'], validation_lane: 'lane-cmd' },
      },
      'builder:1': { status: 'done', summary: 'b1', artifacts: [] },
      'builder:2': { status: 'done', summary: 'b2', artifacts: [] },
      'builder:3': { status: 'done', summary: 'b3', artifacts: [] },
      // round 1: the reviewer reports three typed findings, two of them must-fix
      'reviewer:1': {
        status: 'done', summary: 'r1', artifacts: [],
        details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0, findings: r1Findings },
      },
      // round 2: still changes-needed. WITH findings vs WITHOUT findings is the
      // only difference between the two runs below.
      'reviewer:2': degradeRound2
        ? { status: 'done', summary: 'r2 (no typed findings)', artifacts: [], details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 } }
        : { status: 'done', summary: 'r2', artifacts: [], details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0, findings: r1Findings } },
      // the lead accepts at review exhaustion, naming NOTHING
      'lead:1': { status: 'done', summary: 'accept', details: { decision: 'accept', reason: 'ship it' } },
    },
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 3, review_rounds: 2 } }, io)
  const decision = io.calls.logs.find((l) => l.accept_decision)?.accept_decision ?? null
  const leadBrief = Object.entries(io.calls.writes).find(([p]) => /decision-\d+\.md$/.test(p))?.[1] ?? ''
  return { res, io, decision, leadBrief }
}

for (const degradeRound2 of [false, true]) {
  const { res, io, decision, leadBrief } = run({ degradeRound2 })
  console.log(`===== reviewer round 2 ${degradeRound2 ? 'WITHOUT' : 'WITH'} details.findings =====`)
  console.log('status                 :', res.status)
  console.log('commit                 :', res.details?.commit ?? null)
  console.log('accepted_via           :', res.details?.accepted_via ?? null)
  console.log('accept_decision.outcome:', decision?.outcome ?? '(none)')
  console.log('accept_decision.findings_total:', decision?.findings_total)
  console.log('lead brief showed the accept contract:',
    /For an accept, name every listed finding exactly once/.test(leadBrief))
  console.log('lead brief listed F1/F2:', /F1 \(must-fix\)/.test(leadBrief) && /F2 \(must-fix\)/.test(leadBrief))
  console.log('files committed        :', io.calls.commits.map((c) => c.files))
  console.log('')
}

console.log('--- EXPECTED ---')
console.log('Both runs behave identically: the canonical set is "the LAST reviewer envelope')
console.log('THAT CARRIED ONE" (crew/drive.mjs:1122-1123), so F1/F2/F3 stand in both, the')
console.log('lead is shown the accept contract in both, and an accept naming nothing is')
console.log('REJECTED in both (3 x "omitted id") into an escalation.')
console.log('OBSERVED: the degraded run skips the contract entirely and COMMITS.')
