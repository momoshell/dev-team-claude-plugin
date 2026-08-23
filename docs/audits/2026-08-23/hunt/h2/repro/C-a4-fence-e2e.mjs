// A4: END-TO-END. A live sibling lane owns scripts/factory/. The register spells
// that surface WITHOUT the trailing slash. crew.mjs boot accepts it; driveTask
// then runs GREEN and COMMITS the sibling lane's file.
// Mirrors crew/drive.test.mjs:852 'the scope-gate catches a build that crossed
// another lane fence', changing ONLY the register spelling.
import { writeFileSync, mkdirSync } from 'node:fs'
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const { driveTask } = await import(`${ROOT}/repo/crew/drive.mjs`)
const { resolveLaneFence } = await import(`${ROOT}/repo/crew/crew.mjs`)

const TD = '/tmp/fake-task'
const VICTIM = 'scripts/factory/intake.mjs'   // owned by lane "intake-loop"

function fakeIo({ envelopes = {}, runs = {}, changed = [] } = {}) {
  const calls = { assign: [], run: [], commits: [], logs: [] }
  const counts = {}
  return {
    calls,
    assign({ role, briefFile, note }) {
      counts[role] = (counts[role] || 0) + 1
      calls.assign.push({ role, n: counts[role] })
      return { id: `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
    },
    wait(returnPath) { return envelopes[returnPath] ?? null },
    writeFile() {},
    readFile() { return null },
    run(cmd) { calls.run.push(cmd); return runs[cmd] ?? { ok: true, output: '' } },
    changedFiles() { return changed },
    commit(files, message) { calls.commits.push({ files, message }); return 'abc1234' },
    log(o) { calls.logs.push(o) },
    now() { return 0 },
  }
}
const planEnv = (over = {}) => ({
  status: 'done', role: 'planner', summary: 'planned', artifacts: [`${TD}/plan.md`],
  details: { plan_path: `${TD}/plan.md`, files_in_scope: [VICTIM], validation_lane: 'lane-cmd', consult_questions: [], carve_verdict: 'proceed' },
  ...over,
})
const buildEnv = () => ({ status: 'done', role: 'builder', summary: 'built', details: { files_changed: [VICTIM], commit_message: 'feat: the change' } })
const reviewEnv = () => ({ status: 'done', role: 'reviewer', summary: 'reviewed', details: { verdict: 'pass', review_path: `${TD}/review.md`, must_fix: 0 } })
const CTX = { task: 't1', briefFile: '/tmp/brief.md', taskDir: TD, checkout: '/tmp/repo', roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd' }

mkdirSync(`${ROOT}/lensC/fx`, { recursive: true })

for (const [label, siblingFiles] of [
  ['CONTROL  "scripts/factory/"', ['scripts/factory/']],
  ['ATTACK   "scripts/factory"', ['scripts/factory']],
]) {
  const p = `${ROOT}/lensC/fx/e2e-${label.includes('ATTACK') ? 'attack' : 'control'}.json`
  writeFileSync(p, JSON.stringify({ lanes: [{ lane: 'mine', files: ['crew/mine.mjs'] }, { lane: 'intake-loop', files: siblingFiles }] }, null, 2))
  // 1. what `crew.mjs boot --fences p --lane mine` computes:
  const resolved = resolveLaneFence({ fences: p, lane: 'mine' })
  // 2. hand that to the driver exactly as crew.mjs:1797 does:
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv() },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [VICTIM],
  })
  const result = driveTask({ ...CTX, laneFence: resolved.fence }, io)
  console.log('\n### ' + label)
  console.log('  boot-resolved fence :', JSON.stringify(resolved.fence))
  console.log('  driveTask status    :', result.status)
  console.log('  escalation.where    :', result.details?.escalation?.where ?? null)
  console.log('  COMMITTED FILES     :', JSON.stringify(io.calls.commits.map((c) => c.files)))
  console.log('  lane/suite ran      :', JSON.stringify(io.calls.run))
}
