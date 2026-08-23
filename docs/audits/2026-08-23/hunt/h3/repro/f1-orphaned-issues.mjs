// F1 — convergeSettle leaks already-filed GitHub issues when a LATER issue
// filing fails: the loop returns null ("declined"), the caller escalates, and
// the issues already created on GitHub are never recorded anywhere in the
// escalation envelope, never closed, and never retried.
//
// crew/drive.mjs:1690-1712 (the residual loop inside convergeSettle).
//
// Run:  node f1-orphaned-issues.mjs
import { load, fakeIo, CTX, TD, GS } from './harness.mjs'

const drive = await load()
const { driveTask } = drive

const findings = [
  { id: 'R1', severity: 'must-fix', location: 'a/b.mjs:10', summary: 'first must-fix' },
  { id: 'R2', severity: 'must-fix', location: 'a/b.mjs:20', summary: 'second must-fix' },
]

const io = fakeIo(drive, {
  changed: ['a/b.mjs'],
  gh: {
    // The SECOND createIssue fails — a rate limit, a 502, a revoked token.
    createIssue: (args, index) => {
      if (index === 2) throw new Error('HTTP 502 from the GitHub API')
      return { number: 700 + index, url: `https://example.invalid/issues/${700 + index}` }
    },
  },
  runs: {
    'gate-cmd:1': { ok: false, output: GS(3, 3, 0) },   // baseline: red, well-formed
    'gate-cmd:2': { ok: true, output: GS(3, 0, 0) },    // build round 1: green
    'lane-cmd': { ok: true, output: '' },
    'suite-cmd': { ok: true, output: '' },
  },
  envelopes: {
    'planner:1': {
      status: 'done', summary: 'plan', artifacts: [`${TD}/plan.md`],
      details: { plan_path: `${TD}/plan.md`, files_in_scope: ['a/b.mjs'], validation_lane: 'lane-cmd', gate_cmd: 'gate-cmd' },
    },
    'builder:1': { status: 'done', summary: 'built', artifacts: [] },
    'reviewer:1': {
      status: 'done', summary: 'review', artifacts: [],
      details: { verdict: 'changes-needed', must_fix: 2, should_fix: 0, consider: 0, findings },
    },
    // Build rounds are exhausted at round 1 -> the lead is consulted -> escalate
    'lead:1': { status: 'done', summary: 'escalate', details: { decision: 'escalate', reason: 'two must-fixes stand' } },
  },
})

const res = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 2 } }, io)

const filed = io.calls.gh.filter((c) => c.method === 'createIssue')
const created = filed.filter((c) => c.index === 1)

console.log('--- OBSERVED ---')
console.log('status              :', res.status)
console.log('escalation.where    :', res.details?.escalation?.where)
console.log('createIssue attempts:', filed.length)
console.log('issues ACTUALLY created on GitHub:', created.length,
  created.map((c) => c.args.title))
console.log('details.converge in the returned envelope:', JSON.stringify(res.details?.converge ?? null))
console.log('any issue number anywhere in the envelope:',
  /issues\/70\d/.test(JSON.stringify(res)) || /\b70\d\b/.test(JSON.stringify(res)))
console.log('draft PR opened     :', io.calls.gh.some((c) => c.method === 'createDraftPr'))
console.log('commit made         :', io.calls.commits.length)
console.log('journal line naming the orphan:',
  io.calls.logs.filter((l) => l.converge_declined).map((l) => JSON.stringify(l)))

console.log('')
console.log('--- EXPECTED ---')
console.log('An escalation that names, in details, the issue(s) already created')
console.log('(e.g. converge: { pr: null, issues: [{number:701,...}] }) — exactly as the')
console.log('converge-pr failure path at crew/drive.mjs:1755-1769 already does — so a')
console.log('human can find and close them. Observed: the numbers exist only on GitHub.')
