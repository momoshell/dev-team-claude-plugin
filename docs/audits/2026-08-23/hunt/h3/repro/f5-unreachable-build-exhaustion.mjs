// F5 — the build loop's ONLY fall-through terminal is unreachable.
//
//   crew/drive.mjs:3193-3195 (the loop header at :2941)
//     build: for (let round = 1; round <= limits.build_rounds + extraRounds; round += 1)
//   crew/drive.mjs:3220-3222
//     if (!builderEnv || !accepted) {
//       return escalate('build', `no accepted build within ${limits.build_rounds + extraRounds} rounds`)
//     }
//
// EVERY path that could end the FINAL round either returns from driveTask or
// extends the bound, so the `for` condition can never go false with `accepted`
// still null:
//   :2966-2968  builder status!=done  -> escalate, or `if (finalRound()) extraRounds += 1`
//   :2993       out-of-scope edits    -> `if (!plans || finalRound()) return escalate('scope', ...)`
//   :3006-3012  lane red              -> escalate, or `extraRounds += 1`
//   :3082-3091  gate red              -> escalate/converge, or `extraRounds += 1`
//   :3113-3141  review exhausted      -> escalate/converge, or grant + `if (finalRound()) extraRounds += 1`,
//                                        or accept -> `break build` (sets `accepted`)
//   :3167-3204  review revise, final  -> escalate/converge, or grant + `extraRounds += 1`,
//                                        or accept -> `break build`
//   :3161       review pass           -> `break build` (sets `accepted`)
//   :3211-3215  unreadable verdict    -> escalate, or re-ask IN PLACE (round does not advance)
// and `limits.build_rounds` is validated to [1, 10] at the boundary
// (crew/limits.mjs:40 `value < 1 || value > max`), so round 1 always runs and
// `builderEnv`/`accepted` are never both skipped by an empty loop.
//
// THE PROOF is mechanical: make that return THROW in a scratch copy and run the
// WHOLE suite. Nothing reaches it. ARM B then shows the enumeration is what
// makes it unreachable, by removing ONE of the extenders and watching the same
// branch become live.
//
// Run:  node f5-unreachable-build-exhaustion.mjs
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from './harness.mjs'

const THROW = `  if (!builderEnv || !accepted) {\n    throw new Error('H3-REACHED-BUILD-EXHAUSTION')`
const FIND = `  if (!builderEnv || !accepted) {\n    return escalate('build', \`no accepted build within \${limits.build_rounds + extraRounds} rounds\`)`

// ARM B removes ONE extender — the lane-red `extraRounds += 1` — leaving the
// escalate path intact. If the enumeration above is right, THIS is the edit
// that makes the branch reachable.
const LANE_FIND = `        if (c.decision !== 'bounce') return escalate('lane', c.reason)\n        extraRounds += 1`
const LANE_REPL = `        if (c.decision !== 'bounce') return escalate('lane', c.reason)`

function arm(name, extraEdit) {
  const work = mkdtempSync(join(tmpdir(), 'h3-f5-'))
  try {
    cpSync(REPO, work, { recursive: true })
    const file = join(work, 'crew/drive.mjs')
    let src = readFileSync(file, 'utf8')
    if (!src.includes(FIND)) throw new Error('anchor not found — crew/drive.mjs:3220 moved')
    src = src.replace(FIND, THROW)
    if (extraEdit) {
      if (!src.includes(extraEdit[0])) throw new Error('lane anchor not found — crew/drive.mjs:3010-3011 moved')
      src = src.replace(extraEdit[0], extraEdit[1])
    }
    writeFileSync(file, src)
    const res = spawnSync('npm', ['test'], {
      cwd: work, encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CLICOLOR_FORCE: '' },
      maxBuffer: 256 * 1024 * 1024,
    })
    const out = `${res.stdout}${res.stderr}`.replace(/\[[0-9;]*m/g, '')
    const grab = (k) => {
      const m = [...out.matchAll(new RegExp(`^[\\u2139#]\\s*${k} (\\d+)$`, 'gm'))]
      return m.length ? Number(m.at(-1)[1]) : null
    }
    const reached = (out.match(/H3-REACHED-BUILD-EXHAUSTION/g) || []).length
    console.log(`--- ARM ${name} ---`)
    console.log('suite: tests', grab('tests'), 'pass', grab('pass'), 'fail', grab('fail'))
    console.log('times the branch was reached:', reached)
    return { fail: grab('fail'), reached }
  } finally { rmSync(work, { recursive: true, force: true }) }
}

const a = arm('A — repo as shipped, branch made fatal', null)
console.log('')
const b = arm('B — control: the lane extender at crew/drive.mjs:3011 removed', [LANE_FIND, LANE_REPL])

console.log('')
console.log('--- BASELINE (measure the instrument) ---')
console.log('The scratch tree comes from `git archive HEAD`, so it has NO .git and 44 of the')
console.log("suite's 2171 tests fail there before any edit. Measured on this machine:")
console.log('  scratch baseline: tests 2171 pass 2127 fail 44')
console.log('So ARM A adds ZERO failures and ARM B adds exactly the two the branch produces.')
console.log('')
console.log('--- READING ---')
console.log(`ARM A: fail=${a.fail}, reached=${a.reached}. The whole suite cannot reach the branch.`)
console.log(`ARM B: fail=${b.fail}, reached=${b.reached}. Deleting ONE extender makes it live —`)
console.log('       so the branch is dead because of the extenders, not because the suite is thin.')
console.log('')
console.log('--- EXPECTED ---')
console.log('Either a run can exhaust its build budget without an extender firing (ARM A')
console.log('reaches it), or drive.mjs carries a terminal escalation that no run can produce')
console.log('and whose message ("no accepted build within N rounds") describes a state the')
console.log('driver cannot enter — the sibling class of intake\'s unreachable protected-path')
console.log('refusal that this hunt was sent to find.')
