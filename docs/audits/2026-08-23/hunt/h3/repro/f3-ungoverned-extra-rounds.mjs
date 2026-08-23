// F3 — the LANE and GATE exhaustion consults grant extra build rounds without
// consulting `canGrant()` and without recording a grant. `limits.extra_rounds`
// is therefore not the bound on lead-granted rounds it is documented to be
// (crew/drive.mjs:26 "extra_rounds: 1 // lead-granted rounds at REVIEW /
// PLAN-CHECK exhaustion"), and `details.extra_rounds_granted` — the field
// crew/escalation-policy.mjs:161-166 reads as `grant-spent` — stays EMPTY for
// a run that actually spent several.
//
//   crew/drive.mjs:3006-3012  lane exhaustion:  `extraRounds += 1`   (no canGrant, no grant())
//   crew/drive.mjs:3082-3091  gate exhaustion:  `extraRounds += 1`   (no canGrant, no grant())
//   crew/drive.mjs:2968       builder-failure:  `extraRounds += 1`   (no canGrant, no grant())
//   crew/drive.mjs:3119-3121  review exhaustion: grant() + canGrant()  <- the governed one
//
// Run:  node f3-ungoverned-extra-rounds.mjs
import { load, fakeIo, CTX, TD } from './harness.mjs'

const drive = await load()
const { driveTask, LIMITS } = drive

const io = fakeIo(drive, {
  changed: ['a/b.mjs'],
  runs: {
    'lane-cmd': { ok: false, output: 'lane is red, forever' },   // never goes green
    'suite-cmd': { ok: true, output: '' },
  },
  envelopes: {
    'planner:1': {
      status: 'done', summary: 'plan', artifacts: [`${TD}/plan.md`],
      details: { plan_path: `${TD}/plan.md`, files_in_scope: ['a/b.mjs'], validation_lane: 'lane-cmd' },
    },
    // every builder round succeeds as an envelope; only the lane stays red
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`builder:${n}`, { status: 'done', summary: `b${n}`, artifacts: [] }])),
    // the lead always says "bounce once more"
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`lead:${n}`, { status: 'done', summary: 'again', details: { decision: 'bounce', reason: 'one more', guidance: 'fix the lane' } }])),
  },
})

const limits = { build_rounds: 1, extra_rounds: 1, lead_consults: 4 }
const res = driveTask({ ...CTX, limits }, io)

const builderRounds = io.calls.assign.filter((a) => a.role === 'builder').length
const leadConsults = io.calls.assign.filter((a) => a.role === 'lead').length

console.log('--- OBSERVED ---')
console.log('limits                     :', JSON.stringify(limits))
console.log('documented round budget    :', limits.build_rounds + limits.extra_rounds, '(build_rounds + extra_rounds)')
console.log('builder dispatches actually made:', builderRounds)
console.log('lead consults               :', leadConsults)
console.log('details.extra_rounds_granted:', JSON.stringify(res.details?.extra_rounds_granted))
console.log('status / where              :', res.status, '/', res.details?.escalation?.where)
console.log('why                         :', res.details?.escalation?.why)
console.log('stages                      :', res.details?.stages.filter((s) => /^build:/.test(s)).join(' '))
console.log('journal extra_round_granted rows:',
  io.calls.logs.filter((l) => l.extra_round_granted).length)

console.log('')
console.log('--- EXPECTED ---')
console.log(`At most ${limits.build_rounds + limits.extra_rounds} builder rounds (extra_rounds = ${limits.extra_rounds}),`)
console.log('and every lead-granted round recorded in details.extra_rounds_granted so')
console.log('crew/escalation-policy.mjs regrantVerdict can see the grant was spent.')
console.log(`OBSERVED: ${builderRounds} builder rounds and an EMPTY extra_rounds_granted.`)
console.log('The only real bound is lead_consults =', limits.lead_consults, '(default', LIMITS.lead_consults + ').')
