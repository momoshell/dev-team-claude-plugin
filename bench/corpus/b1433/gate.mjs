import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// All code/corpus under test is resolved from cwd, including in mutation copies.
const root = process.cwd()
const lanes = [
  ['b1380', 'b1380-lean-suite-rerun', '1d282ec7', ['SR1', 'SR2']],
  ['b1381', 'b1381-lean-provider-retry', '1d282ec7', ['PR1', 'PR2', 'PR3']],
  ['b1402', 'b1402-lean-reaim-unbound-mutations', '2966b484', ['RA1', 'RA2', 'RA3', 'RA4', 'RA5']],
  ['b1408', 'b1408-lean-reaim-per-build', 'fbc9ad2a', ['RB1', 'RB2', 'RB3', 'RB4', 'RB5']],
  ['b1416', 'b1416-loop-checks-after-rebase', 'abe2d073', ['RB1', 'RB2', 'RB3']],
  ['b1417', 'b1417-lanes-show-finish-pr', 'abe2d073', ['LP1', 'LP2']],
]
const text = (p) => readFileSync(p, 'utf8')
const json = (p) => JSON.parse(text(p))
const put = (p, value) => { mkdirSync(resolve(p, '..'), { recursive: true }); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const load = (file) => import(pathToFileURL(join(root, 'bench', file)).href)
let failures = 0
async function check(id, fn) {
  try { await fn() } catch (error) {
    failures++
    const reason = String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 400)
    console.log(`FAIL ${id}: ${reason}`)
  }
}

await check('SB1', () => {
  for (const [lane, full, base, acceptance] of lanes) {
    const dir = join(root, 'bench', 'corpus', lane)
    const names = ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json', 'brief.md', 'planner-prompt.txt', 'builder-prompt.txt', 'manifest.json']
    for (const name of names) {
      const file = join(dir, name)
      assert(lstatSync(file).isFile(), `${lane}/${name} must be a regular file`)
      assert(text(file).trim().length > 0, `${lane}/${name} is empty`)
    }
    const manifest = json(join(dir, 'manifest.json'))
    const lean = json(join(dir, 'lean.json'))
    const planner = json(join(dir, 'planner-1.json'))
    assert.equal(manifest.lane, lane)
    assert.equal(manifest.base, base, `${lane}: wrong replay base`)
    assert.equal(lean.id, full)
    assert.equal(manifest.originalTask, `/Users/momoshell/.crew/dt-${full}/${full}/task`)
    assert.equal(manifest.originalTree, `/Users/momoshell/Dev/dt-${full}`)
    assert.equal(manifest.originalTask, lean.taskDir)
    assert.equal(manifest.originalTree, lean.cwd)
    assert.deepEqual(lean.acceptance, acceptance)
    assert.equal(planner.role, 'planner')
    assert.equal(planner.id, `${full}.planner.1`)
    assert.equal(planner.status, 'done')
    assert.deepEqual(planner.details.acceptance, acceptance)
    assert.equal(planner.details.plan_path.split(':')[0], join(manifest.originalTask, 'plan.md'))
    assert.equal(planner.details.gate_path, join(manifest.originalTask, 'gate.mjs'))
    const brief = text(join(dir, 'brief.md')).trim()
    assert.equal(brief, lean.brief.trim(), `${lane}: brief differs from recorded lean input`)
    assert(text(join(dir, 'plan.md')).trim().length > 100, `${lane}: missing plan body`)
    assert(text(join(dir, 'gate.mjs')).includes('FAIL'), `${lane}: missing recorded gate`)
    for (const role of ['planner', 'builder']) {
      const prompt = text(join(dir, `${role}-prompt.txt`))
      assert(prompt.startsWith(`You are the lean ${role}.`), `${lane}: not extracted first ${role} prompt text`)
      assert(prompt.includes(brief), `${lane}: incomplete ${role} brief`)
      assert(prompt.includes(`Task directory: ${manifest.originalTask}`), `${lane}: ${role} prompt lost original task`)
      assert(prompt.includes(`Envelope id: ${full}.${role}.`), `${lane}: wrong ${role} prompt`)
      assert(prompt.includes(`Return path: ${manifest.originalTask}/${role}-`), `${lane}: missing ${role} return`)
      if (role === 'builder') {
        assert(prompt.includes(`Plan path: ${manifest.originalTask}/plan.md`))
        assert(prompt.includes(`Gate path: ${manifest.originalTask}/gate.mjs`))
      }
    }
  }
})

async function replayValidation(file, exported) {
  const mod = await load(file)
  assert.equal(typeof mod[exported], 'function', `missing ${exported}`)
  const scratch = mkdtempSync(join(tmpdir(), 'seat-bench-gate-'))
  try {
    const cases = [
      { arms: ['not-a-real-arm'], bad: 'not-a-real-arm' },
      { arms: ['fff', 'not-a-real-arm'], bad: 'not-a-real-arm' },
      { arms: ['constructor'], bad: 'constructor' },
      { arms: ['__proto__'], bad: '__proto__' },
      { arms: [], bad: null },
      { arms: ['fff'], bad: null },
    ]
    for (const [index, { arms, bad }] of cases.entries()) {
      const out = join(scratch, `case-${index}`)
      let prepared = 0, seats = 0
      const deps = {
        prepareRun() { prepared++; throw new Error('GATE_PREPARATION_REACHED') },
        runAcpSeat() { seats++; throw new Error('GATE_SEAT_MUST_NOT_START') },
      }
      // The real entry must own the validation and error-recording boundary.
      await mod[exported]({ lane: 'b1380', cell: { agent: 'pi', model: 'openai/gpt-6.1-sol', effort: 'high' }, arms, out }, deps)
      const result = json(join(out, 'result.json'))
      assert.equal(typeof result.error, 'string', 'failure was not recorded')
      assert.equal(seats, 0, 'seat started before validation/setup finished')
      if (bad) {
        assert.equal(prepared, 0, `unknown arm ${bad} reached setup`)
        assert.match(result.error, /unknown arm/i)
        assert(result.error.includes(bad), 'refusal does not identify the unknown arm')
        assert(!existsSync(join(out, 'tree')), 'unknown arm created a worktree')
      } else {
        assert.equal(prepared, 1, 'known/empty arms did not reach preparation')
        assert(result.error.includes('GATE_PREPARATION_REACHED'), 'preparation failure was hidden')
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
await check('SB2', () => replayValidation('replay-builder.mjs', 'runBuilder'))
await check('SB3', () => replayValidation('replay-planner.mjs', 'runPlanner'))

function regularFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name), stat = lstatSync(file)
    assert(!stat.isSymbolicLink(), 'review outputs must not alias the private key/source')
    return stat.isDirectory() ? regularFiles(file) : [file]
  })
}
await check('SB4', async () => {
  const mod = await load('blind-review.mjs')
  assert.equal(typeof mod.prepareReviews, 'function', 'missing prepareReviews')
  const scratch = mkdtempSync(join(tmpdir(), 'seat-review-gate-'))
  try {
    const runs = ['private-cell-ALPHA', 'private-cell-BETA'].map((id, i) => {
      const run = join(scratch, id), label = i ? 'B' : 'A'
      put(join(run, 'result.json'), { id, lane: 'b1380', cell: { model: 'secret-model-identity' }, error: null })
      put(join(run, 'diff.patch'), `diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old\n+// artifact-diff-${label} ${run}/task\n`)
      put(join(run, 'task', 'plan.md'), `# artifact-plan-${label}\nPlan input at ${run}/task; tree ${run}/tree\n`)
      put(join(run, 'task', 'gate.mjs'), `// artifact-gate-${label}\n// ${run}/task\nprocess.exitCode = 1\n`)
      put(join(run, 'task', 'brief.md'), '# Brief\nReview this task.\n')
      put(join(run, 'task', 'lean.json'), { cwd: join(run, 'tree'), taskDir: join(run, 'task'), brief: '# Brief\nReview this task.\n' })
      return run
    })
    for (const kind of ['diff', 'plan']) {
      const out = join(scratch, `reviews-${kind}`), keyPath = join(scratch, 'private-keys', `${kind}.json`)
      const jobs = await mod.prepareReviews({ runs, kind, out, keyPath })
      assert(Array.isArray(jobs) && jobs.length === runs.length, 'input review silently omitted')
      const key = json(keyPath)
      assert.deepEqual(Object.values(key).sort(), [...runs].sort(), 'separate key does not map all runs')
      const codes = jobs.map((job) => job.code)
      assert.equal(new Set(codes).size, runs.length, 'duplicate review codes')
      assert.deepEqual([...codes].sort(), Object.keys(key).sort())
      for (const code of codes) assert.equal(typeof code, 'string')
      const files = regularFiles(out)
      assert(files.length > 0, 'no coded review inputs')
      const contents = files.map(text).join('\n')
      const published = files.join('\n') + '\n' + contents
      for (const secret of [...runs, 'private-cell-ALPHA', 'private-cell-BETA', 'secret-model-identity']) {
        assert(!published.includes(secret), `identity leaked into ${kind} review files: ${secret}`)
      }
      for (const code of codes) assert(published.includes(code), 'review is not coded')
      for (const label of ['A', 'B']) {
        if (kind === 'diff') assert(contents.includes(`artifact-diff-${label}`), 'missing coded diff')
        else {
          assert(contents.includes(`artifact-plan-${label}`), 'missing coded plan')
          assert(contents.includes(`artifact-gate-${label}`), 'missing coded gate')
        }
      }
      assert(!existsSync(join(out, 'key.json')), 'private key is in review output dir')
    }
    const out = join(scratch, 'unsafe-reviews')
    let rejected = false
    try { await mod.prepareReviews({ runs, kind: 'diff', out, keyPath: join(out, 'key.json') }) } catch (error) {
      rejected = /key|outside|separate/i.test(String(error.message))
    }
    assert(rejected, 'key destination inside reviews was not rejected')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
process.exitCode = failures ? 1 : 0
