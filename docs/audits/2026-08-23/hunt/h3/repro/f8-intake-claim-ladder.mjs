// F8 — the intake claim ladder. Runs against the SCRATCH copy of the repo
// (git archive HEAD) with injected board/boot/run deps. No network, no writes
// into the checkout.
//
// Run:  node f8-intake-claim-ladder.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from './harness.mjs'
// NOTE (measure the instrument): proposeTier shells out to `git ls-files`, so a
// bare `git archive` tree refuses every brief with `brief-uncompilable:
// not-a-git-repo` and every finding below reads as "no defect". The scratch copy
// is `git init`-ed and committed once before this script runs.

const I = await import(`${REPO}/scripts/factory/intake.mjs`)
const PP = await import(`${REPO}/crew/protected-paths.mjs`)
const { DEFAULT_INTAKE_CONFIG, intakeSweep, intakeRun, intakeLoop, verifyPremise, dispatchPicked, observeDispatches } = I

const NOW = Date.parse('2026-01-02T00:00:00.000Z')
const line = (t) => console.log(`\n===== ${t}`)
const scratch = mkdtempSync(join(tmpdir(), 'h3-intake-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const fieldOf = (name, value) => ({ name: value, field: { name } })
const issue = ({ number, body = null, status = 'Ready', priority = 'P1', createdAt = `2025-12-0${number}T00:00:00Z` }) => ({
  id: `ITEM-${number}`,
  content: { number, title: `Issue ${number}`, url: `https://example.test/issues/${number}`, body, createdAt },
  fieldValues: { nodes: [fieldOf('Status', status), fieldOf('Priority', priority)] },
})
const page = (nodes, { hasNextPage = false, endCursor = null, remaining = 900 } = {}) => ({
  data: { user: { projectV2: { items: { nodes, pageInfo: { hasNextPage, endCursor } } } } },
  rateLimit: { remaining, resetAt: '2026-01-02T01:00:00Z' },
})
const bodyFor = (where) => `ask: do the thing\nwhere: ${where}\ndone-means: recorded\nout-of-scope: nothing`
const baseConfig = { ...DEFAULT_INTAKE_CONFIG, windowCap: 99, protectedPaths: [] }

// ===========================================================================
line('F8a — CORRECTION TO THE BRIEF: intake\'s protected-path refusal is REACHABLE')
// The brief states "the audit proved intake's protected-path refusal is
// unreachable". It is not, with the shipped default config.
//   scripts/factory/intake.mjs:56   protectedPaths: Object.freeze([])
//   scripts/factory/intake.mjs:983  protectedPaths: Array.isArray(...) ? ... : []
//   crew/protected-paths.mjs:24-35  resolveProtectedPaths(extra):
//                                     extra == null -> the floor
//                                     an array      -> [...PROTECTED_PATHS, ...additions]
// So `[]` yields the FULL 12-entry authored floor, not an empty set.
console.log('resolveProtectedPaths(null).length =', PP.resolveProtectedPaths(null).length)
console.log('resolveProtectedPaths([]).length   =', PP.resolveProtectedPaths([]).length)
console.log('identical MEMBERS?                  ',
  JSON.stringify([...PP.resolveProtectedPaths([])].sort()) === JSON.stringify([...PP.resolveProtectedPaths(null)].sort()))
{
  const nodes = [issue({ number: 1, body: bodyFor('docs/adr') })]
  const r = intakeSweep({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: null,
    config: baseConfig,
    deps: { now: () => NOW, existsSync: () => false, runsInWindow: () => 0, github: () => page(nodes) },
  })
  console.log('sweep on a docs/adr `where`: outcome =', r.outcome,
    '| refusals =', JSON.stringify(r.refusals))
}
console.log('WHAT IS ACTUALLY DEAD: the CONFIGURED ADDITION. sweepCommand ->')
console.log('scripts/factory/intake.mjs:1729 passes config:{} and nothing on the shipped')
console.log('CLI route can set protectedPaths to anything but []. The knob is inert; the')
console.log('refusal fires from the floor.')

// ===========================================================================
line('F8b — a candidate whose tier is ABSENT survives the ladder, wins the pick, and starves every other issue')
// scripts/factory/intake.mjs:994  if (proposal.signals?.protectedHits?.length > 0) ... continue
// scripts/factory/intake.mjs:999  if (proposal.tier === 'judge') ... continue
// scripts/factory/intake.mjs:1002 survivors.push({ ..., tier: proposal.tier })   <- tier may be null
// scripts/factory/make-brief.mjs absentProposal sets tier:null AND protectedHits:[],
// so NEITHER guard above can fire for it. It then sorts first, every other issue
// is refused `not-first-in-order`, and dispatchPicked refuses at
// scripts/factory/intake.mjs:1214 `if (picked.tier == null)` -> 'tier-unproposed',
// BEFORE the board write. The card never leaves Ready and the next sweep repeats.
{
  const nodes = [
    issue({ number: 1, body: bodyFor('.git'), priority: 'P0', createdAt: '2025-12-01T00:00:00Z' }),
    issue({ number: 2, body: bodyFor('scripts/factory/intake.mjs'), priority: 'P1', createdAt: '2025-12-02T00:00:00Z' }),
  ]
  const r = intakeSweep({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: null,
    config: baseConfig,
    deps: { now: () => NOW, existsSync: () => false, runsInWindow: () => 0, github: () => page(nodes) },
  })
  console.log('outcome        :', r.outcome)
  console.log('picked issue   :', r.picked?.issue, '| picked tier:', JSON.stringify(r.picked?.tier))
  console.log('refusals       :', JSON.stringify(r.refusals))
  console.log('EXPECTED : an unproposable candidate is refused at the sweep, so issue 2 is picked.')
  console.log('OBSERVED : issue 1 wins with tier null; issue 2 is starved not-first-in-order,')
  console.log('           and a real dispatch would refuse tier-unproposed and move nothing.')
}

// ===========================================================================
line('F8c — a REFUSED dispatch is later promoted to In review by observeDispatches')
// scripts/factory/intake.mjs:1257  the `claimed` row is written BEFORE boot
// scripts/factory/intake.mjs:1276  boot-failed -> outcome 'refused', card left in the work column
// scripts/factory/intake.mjs:1336-1339  the ONLY disqualifier for a claim is a LATER
//                                       `promoted` row. Nothing consults `refused`.
// scripts/factory/intake.mjs:1230  claim.branch is branchFor({checkout: workCheckout}) —
//                                  the HOST checkout's branch, identical for every issue
// scripts/factory/intake.mjs:528   defaultPullRequestFor ignores `issue` entirely
{
  const db = join(mkdtempSync(join(scratch, 'db-')), 'ledger.db')
  const crewDir = mkdtempSync(join(scratch, 'crew-'))
  mkdirSync(join(crewDir, 'returns'), { recursive: true })
  const moves = []
  const nodes = [issue({ number: 5, body: bodyFor('scripts/factory/intake.mjs') })]
  const deps = {
    now: () => NOW, existsSync, readFileSync, writeFileSync, mkdirSync,
    runsInWindow: () => 0, github: () => page(nodes),
    branchFor: () => 'shared/host-branch',
    boardMove: (req) => { moves.push(`${req.from}->${req.to}`); return { ok: true, status: req.to, reason: null } },
    crewBoot: () => ({ exit: 127, stdout: '', stderr: 'crew: command not found' }),
    crewRun: () => { throw new Error('crewRun must never be called after a failed boot') },
    pullRequestFor: () => ({ number: 777, url: 'https://example.test/pr/777' }),
  }
  const run = intakeRun({ board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: db, config: baseConfig, deps })
  console.log('dispatch outcome :', run.dispatch?.outcome, '/', run.dispatch?.reason)
  console.log('board moves      :', JSON.stringify(moves))
  const observed = observeDispatches({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: db, config: baseConfig, deps,
    boardItems: [{ issue: 5, item_id: 'ITEM-5', status: baseConfig.workColumn }],
  })
  console.log('promotions       :', JSON.stringify(observed.map((p) => ({ issue: p.issue, pr: p.pr, outcome: p.outcome }))))
  console.log('board moves after:', JSON.stringify(moves))
  console.log('EXPECTED : a claim whose dispatch recorded `refused` is never promoted.')
  console.log('OBSERVED : the card whose crew never booted is moved to In review and')
  console.log('           attributed to a PR it did not create.')
}

// ===========================================================================
line('F8d — one PR on the host branch promotes EVERY in-flight claim')
// Same anchors: claim.branch is per-CHECKOUT, not per-issue, and
// defaultPullRequestFor (scripts/factory/intake.mjs:528) queries only --head <branch>.
{
  const db = join(mkdtempSync(join(scratch, 'db2-')), 'ledger.db')
  const crewDir = mkdtempSync(join(scratch, 'crew2-'))
  const returns = join(crewDir, 'returns'); mkdirSync(returns, { recursive: true })
  const taskReturn = join(returns, 'task.json')
  writeFileSync(taskReturn, JSON.stringify({ status: 'done', summary: 'ok', artifacts: [], details: {} }))
  const moves = []
  const mk = (n) => ({
    now: () => NOW, existsSync, readFileSync, writeFileSync, mkdirSync,
    runsInWindow: () => 0, github: () => page([issue({ number: n, body: bodyFor('scripts/factory/intake.mjs') })]),
    branchFor: () => 'shared/host-branch',
    boardMove: (req) => { moves.push({ issue: n, move: `${req.from}->${req.to}` }); return { ok: true, status: req.to, reason: null } },
    crewBoot: () => ({ exit: 0, stdout: `${JSON.stringify({ task_dir: join(crewDir, 'task'), workspace_id: 'ws', members: {}, crew_json: join(crewDir, 'crew.json') })}\n`, stderr: '' }),
    crewRun: () => ({ exit: 0, stdout: `${JSON.stringify({ status: 'done', task_return: taskReturn, commit: 'c' })}\n`, stderr: '' }),
    pullRequestFor: () => ({ number: 901, url: 'https://example.test/pr/901' }),
  })
  for (const n of [1, 2]) {
    intakeRun({ board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: db, config: baseConfig, deps: mk(n) })
  }
  const observed = observeDispatches({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: db, config: baseConfig, deps: mk(1),
    boardItems: [1, 2].map((n) => ({ issue: n, item_id: `ITEM-${n}`, status: baseConfig.workColumn })),
  })
  console.log('claim branches:', JSON.stringify(observed.map((p) => ({ issue: p.issue, branch: p.branch }))))
  console.log('promotions    :', JSON.stringify(observed.map((p) => ({ issue: p.issue, pr: p.pr.number }))))
  console.log('EXPECTED : at most the issue that PR 901 actually belongs to.')
}

// ===========================================================================
line('F8e — intakeLoop stubs existsSync, blinding the premise probe on the whole shipped CLI route')
// scripts/factory/intake.mjs:1489  deps: { ...d, existsSync: () => false }
//   — the stub exists to suppress the INNER stop-switch re-check, but the same
//   seam serves verifyPremise's path/anchor probe:
// scripts/factory/intake.mjs:220   exists = d.existsSync(absolute)
// scripts/factory/intake.mjs:225   if (!exists) unresolvedReference(reference, 'missing-path')
// sweepCommand -> intakeLoop (scripts/factory/intake.mjs:1479) is the only shipped CLI route.
{
  const body = [
    'ask: x', 'where: scripts/factory/intake.mjs', 'done-means: y', 'out-of-scope: z', '',
    'See scripts/factory/intake.mjs:1 and scripts/factory/ledger.mjs and intakeSweep.',
  ].join('\n')
  const real = verifyPremise({ checkout: REPO, body, deps: I.normalDeps })
  const stubbed = verifyPremise({ checkout: REPO, body, deps: { ...I.normalDeps, existsSync: () => false } })
  console.log('with the real existsSync   :', real.verdict, '|', real.notes)
  console.log('with intakeLoop\'s stub     :', stubbed.verdict, '|', stubbed.notes)
  console.log('EXPECTED : the same verdict either way — the stop-switch stub must not')
  console.log('           reach the premise probe.')
}

// ===========================================================================
line('F8f — anchorResolves is off by one at BOTH ends')
// scripts/factory/intake.mjs:137  function anchorResolves(lineCount, line) { return line <= lineCount }
// scripts/factory/intake.mjs:236  lineCount = contents.split(/\r?\n/).length
// For any file ending in a newline that is realLines + 1; and nothing rejects line 0,
// which PREMISE_ANCHOR_PATTERN's (\d+) matches.
{
  const target = `${REPO}/scripts/factory/intake.mjs`
  const text = readFileSync(target, 'utf8')
  const realLast = text.replace(/\n$/, '').split('\n').length
  console.log(`scripts/factory/intake.mjs: real last line = ${realLast}, split length = ${text.split(/\r?\n/).length}`)
  for (const n of [0, realLast, realLast + 1, realLast + 2]) {
    const body = `ask: x\nwhere: scripts/factory/intake.mjs\ndone-means: y\nout-of-scope: z\n\nSee scripts/factory/intake.mjs:${n}.`
    const v = verifyPremise({ checkout: REPO, body, deps: I.normalDeps })
    console.log(`  anchor :${String(n).padEnd(5)} -> ${v.verdict}`, v.verdict === 'clean' ? '' : `(${v.notes})`)
  }
  console.log('EXPECTED : :0 and :' + (realLast + 1) + ' are dead anchors. OBSERVED: both read clean.')
}

// ===========================================================================
line('F8g — a truncated board (hasNextPage with a null cursor) reports ok:true, degraded:false')
// scripts/factory/intake.mjs:734  if (nextPage.hasNextPage && cursor == null) break
// scripts/factory/intake.mjs:737  if (nextPage.hasNextPage && pages >= maxPages) -> page-limit
// The `break` is the ONE exit that leaves hasNextPage true while pages < maxPages,
// so the post-loop guard cannot fire and control falls to the success return at :740.
{
  const truncated = page([], { hasNextPage: true, endCursor: null })
  const r = I.fetchBoard({ board: { owner: 'o', projectNumber: 7 }, config: baseConfig, deps: { github: () => truncated } })
  console.log('OBSERVED :', JSON.stringify({ ok: r.ok, reason: r.reason, degraded: r.degraded, pages: r.pages, items: r.items.length }))
  console.log('EXPECTED : ok:false / degraded:true / reason "page-limit" (or a distinct truncation reason)')
}

// ===========================================================================
line('F8h — `concurrency` is validated, interpolated into a refusal, and used nowhere else')
// scripts/factory/intake.mjs:1012  const pickedCandidate = ordered.length > 0 ? byIssue.get(...ordered[0]...) : null
// scripts/factory/intake.mjs:1014  refusalFor(candidate, 'not-first-in-order', `concurrency=${concurrency}`)
// The pick is unconditionally ordered[0]; concurrency appears at exactly
// scripts/factory/intake.mjs:45, :1009-1011 and :1014 and nowhere else.
{
  const nodes = [1, 2, 3].map((n) => issue({ number: n, body: bodyFor('scripts/factory/intake.mjs'), createdAt: `2025-12-0${n}T00:00:00Z` }))
  const r = intakeSweep({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: null,
    config: { ...baseConfig, concurrency: 3 },
    deps: { now: () => NOW, existsSync: () => false, runsInWindow: () => 0, github: () => page(nodes) },
  })
  console.log('concurrency: 3 -> picked', r.picked?.issue, '| refusals:', JSON.stringify(r.refusals))
  console.log('EXPECTED : three slots pick three issues, or the detail does not claim three slots.')
}

// ===========================================================================
line('F8i — maxTicks that is not a positive integer silently becomes Infinity')
// scripts/factory/intake.mjs:1422
//   const limit = Number.isInteger(maxTicks) && maxTicks > 0 ? maxTicks : Infinity
// `null` (the documented default) shares its branch with 0, negatives, floats and
// numeric strings. `maxTicks: 0` — the natural spelling of "do not sweep" — is an
// UNBOUNDED daemon. The shipped CLI is safe (sweepTicks at :1663 coerces to 1..24),
// so this bites library callers of the exported intakeLoop only.
// A brake is injected at tick 12 purely to bound this experiment.
for (const maxTicks of [1, 2, 0, -1, 1.5, '2', null]) {
  let ticks = 0
  let brake = false
  let clock = NOW
  const r = intakeLoop({
    board: { owner: 'o', projectNumber: 7 }, checkout: REPO, dbPath: null,
    config: baseConfig, maxTicks, recordOnly: true,
    deps: {
      now: () => clock,
      sleep: (ms) => { clock += ms },
      existsSync: () => brake,
      runsInWindow: () => 0,
      github: () => { ticks += 1; if (ticks >= 12) brake = true; return page([]) },
    },
  })
  const bounded = ticks < 12
  console.log(`maxTicks ${JSON.stringify(maxTicks).padEnd(6)} -> board fetches ${String(ticks).padStart(2)}`,
    `| ticks recorded ${r.ticks?.length ?? '?'}`, bounded ? '' : '<= UNBOUNDED (only the injected brake stopped it)')
}
console.log('EXPECTED : 0 and negatives mean "no sweep"; a float or a numeric string refuses.')
