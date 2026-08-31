// This module is the forked child's entry point; it exists so the long-lived
// server process never loads drive.mjs/seat-io.mjs, and runner imports belong
// here and nowhere else.
import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  renameSync as fsRenameSync,
} from 'node:fs'
import { execSync as cpExecSync } from 'node:child_process'
import { basename, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { driveTask as defaultDriveTask, LIMITS, VARIANTS, validateScopeEntries } from './drive.mjs'
import { limitsCtx, limitsRecord, resolveLimits } from './limits.mjs'
import { seatIo as defaultSeatIo, settleSeatTeardown } from './seat-io.mjs'
import { openRun } from '../scripts/factory/emit.mjs'
import { checkoutProtectedPaths } from '../scripts/factory/probe-repo.mjs'
import { paneSeat, isObject } from './daemon.mjs'
import { slugOrNull } from './slug.mjs'

const SELF_PATH = fileURLToPath(import.meta.url)
// The duplication is the read, never the value. The import firewall below is
// why child.mjs deliberately does not route through crew.mjs; both entrypoints
// read the same package owner from their module paths. This deliberately does
// NOT route through runChild's injected readFileSync seam: that seam carries
// run state, while the owner is part of the checkout this module was loaded
// from, and several existing tests inject a readFileSync that only answers
// crew.json.
export const SUITE_OWNER_PATH = resolvePath(SELF_PATH, '..', '..', 'package.json')
export const SUITE_REFUSAL = 'suite-unreadable'

export function packageSuite({ path = SUITE_OWNER_PATH, readFile = fsReadFileSync } = {}) {
  let parsed
  try { parsed = JSON.parse(String(readFile(path, 'utf8'))) } catch (err) {
    throw Object.assign(new Error(`cannot read the suite command from ${path}: ${err.message} [${SUITE_REFUSAL}]`), { reason: SUITE_REFUSAL })
  }
  const suite = parsed?.scripts?.test
  if (typeof suite !== 'string' || suite.trim() === '') {
    throw Object.assign(new Error(`${path} declares no scripts.test — the suite command has one owner and it is missing [${SUITE_REFUSAL}]`), { reason: SUITE_REFUSAL })
  }
  return suite.trim()
}

function childArguments(argv) {
  if (isObject(argv) && !Array.isArray(argv)) return argv
  const values = Array.isArray(argv) ? argv : process.argv.slice(2)
  const index = values.indexOf('--run-child')
  const raw = index >= 0 ? values[index + 1] : values[0]
  if (!raw) throw new Error('run child requires a JSON run specification')
  try { return JSON.parse(raw) }
  catch (err) { throw new Error(`invalid run-child specification: ${err.message}`) }
}

function ledgerDbPath(env) {
  return env.DEVTEAM_LEDGER_DB
    || join(env.DEVTEAM_LEDGER_DIR || join(homedir(), '.dev-team', 'factory'), 'ledger.db')
}

function declaredScope(value, variant) {
  const inherited = VARIANTS[variant]?.sources?.scope === 'inherited'
  if (value === undefined) {
    if (inherited) throw new Error(`a ${variant} child spec inherits the failing run's files_in_scope; the spec declares none — the scope gate is never relaxed to let a child run without a declared scope`)
    return null
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`files_in_scope in the ${variant || 'child'} spec must be a non-empty array — an empty scope is never a scope`)
  }
  const defects = validateScopeEntries(value)
  if (defects.length) {
    const listed = defects.map(({ entry, why }) => `${JSON.stringify(entry)} (${why})`).join(', ')
    throw new Error(`files_in_scope in the child spec contains unsupported entries: ${listed}`)
  }
  return [...value]
}

// Deliberate duplicate of the execution-shape seam: the child cannot import
// crew.mjs, and this check keeps its legacy variant projection aligned with
// the daemon's run_configuration. crew/crew.test.mjs pins the two spellings.
export function specExecution(spec = {}) {
  const declared = spec.run_configuration?.execution?.effective
  if (declared === undefined || declared === null) return spec.variant ?? null
  if (spec.variant !== undefined && spec.variant !== declared) {
    throw new Error(`this child spec carries variant ${JSON.stringify(spec.variant)} and run_configuration.execution.effective ${JSON.stringify(declared)} — boot and run may never disagree about the shape a lane ran under`)
  }
  return declared
}

// An identical copy of crew/crew.mjs's resolver: the two run entrypoints must
// agree on what the round validation lane is, and child.mjs deliberately never
// imports crew.mjs. crew/crew.test.mjs runs both against one shared table.
// `validation_lane` is the spelling with no second meaning; `lane` is what the
// daemon normalises to null when absent (crew/daemon.mjs:1091) and forwards
// unconditionally (:948), and what a factoryctl `run --lane` supplies (crew/factoryctl.mjs:192).
export const VALIDATION_LANE_REFUSAL = 'invalid-validation-lane'

export function resolveValidationLane({ validationLane, lane, fences } = {}) {
  // An omitted input and an explicit null are the SAME absence. The daemon
  // normalises a missing lane to null (crew/daemon.mjs:1091) and childSpecFor
  // forwards it unconditionally (:948), so a resolver that only knows
  // `undefined` turns every daemon or factoryctl run booted without --lane into
  // a child-preflight escalation. Same shape as crew/limits.mjs:30. `fences`
  // deliberately keeps its `=== undefined` test: it is not a lane value but the
  // PAIRING SIGNAL asking whether --fences was given at all.
  const absent = (raw) => raw === undefined || raw === null
  const clean = (raw, flag) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw Object.assign(
        new Error(`--${flag} needs the shell command to run as the round validation lane, got ${JSON.stringify(raw)} [${VALIDATION_LANE_REFUSAL}]`),
        { reason: VALIDATION_LANE_REFUSAL },
      )
    }
    return raw.trim()
  }
  if (!absent(validationLane)) return { lane: clean(validationLane, 'validation-lane'), source: 'validation-lane' }
  if (!absent(lane) && fences === undefined) return { lane: clean(lane, 'lane'), source: 'lane' }
  return { lane: null, source: 'none' }
}

function ledgerSidecarDbPath(crewDir, exists, read) {
  const path = join(crewDir, 'ledger', 'run.json')
  if (!exists(path)) return null
  try {
    const sidecar = JSON.parse(String(read(path, 'utf8')))
    return typeof sidecar?.db_path === 'string' ? sidecar.db_path : null
  } catch { return null }
}

export function runChild(argv, injected = {}) {
  const spec = childArguments(argv)
  const read = injected.readFileSync || fsReadFileSync
  const write = injected.writeFileSync || fsWriteFileSync
  const existsChild = injected.existsSync || fsExistsSync
  const mkdir = injected.mkdirSync || fsMkdirSync
  const rename = injected.renameSync || fsRenameSync
  const exec = injected.execSync || cpExecSync
  // Same seam as read/write/exec: the protected-paths probe is the first thing
  // the run does after seatIo, and a test that cannot get inside it cannot prove
  // what a signal does there. Production always uses the imported probe.
  const probeProtectedPaths = injected.checkoutProtectedPaths || checkoutProtectedPaths
  // `harness` decides how a preflight failure is REPORTED — rethrown for a
  // test driving runChild directly, or written as an escalation envelope in
  // production. It deliberately no longer decides WHETHER preflight runs.
  const harness = !!(injected.driveTask || injected.seatIo)
  // Preflight runs UNLESS a caller opts out explicitly. Deriving this from
  // `harness` meant "I supplied a fake io" silently also meant "skip the seat,
  // brief, checkout-identity and dirty-tree guards" — and DI is the crew's
  // universal seam. Only tests inject today, so nothing shipped weaker; the
  // switch was wrong-way-round for the first caller who injects in production.
  const strictPreflight = injected.preflight !== false
  const crewDir = resolvePath(spec.crew_dir)
  const crewPath = join(crewDir, 'crew.json')
  let crew
  try { crew = JSON.parse(String(read(crewPath, 'utf8'))) } catch (err) { throw new Error(`cannot read crew.json at ${crewPath}: ${err.message}`) }
  const roles = crew.roles || Object.keys(crew.members || {})
  const taskDir = join(crewDir, 'task')
  const returnsDir = join(crewDir, 'returns')
  const taskReturn = resolvePath(crewDir, spec.task_return || crew.task_return || join('returns', 'task.json'))
  const checkout = resolvePath(spec.checkout || crew.checkout || process.cwd())
  const briefFile = spec.brief_file || spec.briefFile
  const ctx = {
    task: spec.task || crew.task, briefFile: briefFile ? resolvePath(briefFile) : null,
    taskDir, checkout, journal: join(crewDir, 'journal.jsonl'),
    roles: roles.filter((role) => role !== 'lead'),
    continuation: spec.continuation === true,
    seatedRoles: [...roles],
    // The suite is read from package.json's scripts.test owner; reasoning lives
    // in crew/crew.mjs's ctx block, and crew/crew.test.mjs pins the agreement.
    // lane and suite are both RESOLVED below, inside the try, so an unreadable
    // one becomes this run's child-preflight escalation rather than a throw out of fork.
    lane: null, suite: null,
  }
  const failure = (err) => ({
    status: 'escalation', summary: `Task ${ctx.task} needs a human: the driver crashed (${err.message})`,
    artifacts: [ctx.journal], details: { stages: null, commit: null, dissents: [], escalation: { where: err.stage || 'child-preflight', why: err.message } },
  })
  let result
  let emitter = null
  let io = null
  let settled = false
  // ONE settlement path for both exits, and the FIRST settlement wins: a
  // worker that refuses to die must never change the run's recorded outcome.
  // Teardown runs AFTER the envelope and the mirror on purpose, on the signal
  // path exactly as on the return path.
  // The envelope is the one file carrying the run's OUTCOME and the daemon reads it
  // from another process: publish it the way saveCrew publishes crew.json — write a
  // sibling, then rename — so a reader can never see a prefix (#540). The `.tmp`
  // sibling is per-path and lives for one rename.
  const publish = (path, text) => {
    const tmp = `${path}.tmp`
    write(tmp, text)
    rename(tmp, path)
  }

  const settle = (value) => {
    if (settled) return result
    settled = true
    result = value
    publish(taskReturn, JSON.stringify(result, null, 2))
    const mirror = join(returnsDir, 'task.json')
    if (taskReturn !== mirror) {
      try { publish(mirror, JSON.stringify(result, null, 2)) } catch { /* the run's own envelope is the record; the mirror is a convenience for wait/status/visualizer */ }
    }
    settleSeatTeardown(io)
    try { emitter?.endRun({ status: result.status === 'done' ? 'ok' : 'aborted' }) } catch { /* never load-bearing */ }
    return result
  }
  // NOTHING is armed here, in any window. runChild is synchronous from entry to
  // return — no await, no worker, no event-loop turn — so a listener registered
  // anywhere in this function can never dispatch, while registering it DOES
  // suppress Node's default terminate-on-signal disposition and make a
  // daemon-reaped child survive its reap. Measured on this checkout
  // (docs/conventions.md 2026-08-21, the second sighting of the 2026-08-11
  // entry): with the two former windows armed, a real SIGTERM delivered in the
  // post-seatIo preflight stretch or during settlement left the child deaf for
  // the full 3019ms block and it exited 0; with nothing armed the same signal
  // killed it in 1-2ms, exactly as the pre-arm preflight stretch and the drive
  // already did. A reap therefore exits by default disposition in every window.
  // The residual is deliberate, not papered over: a child reaped before settle()
  // writes no envelope of its own, and the daemon's settleSignalled
  // (crew/daemon.mjs) writes the run's escalation record instead — the only
  // mechanism that can also cover SIGKILL and OOM (#423). Cooperative
  // child-side cleanup needs the async/worker shape tracked in #419; arming a
  // handler in a turn-free function is not a step towards it.
  try {
    const execution = specExecution(spec)
    if (execution) ctx.variant = execution
    const pane = paneSeat(crew)
    if (pane) throw new Error(`daemon run refuses pane transport for seat ${pane}`)
    // Resolve inside this try so an invalid scope becomes this run's
    // escalation envelope (`child-preflight`), not a stack trace out of fork.
    const filesInScope = declaredScope(spec.files_in_scope, execution)
    if (filesInScope) ctx.files_in_scope = filesInScope
    // The same validation the attended entrypoint runs, from the same leaf: an
    // invalid budget refuses here as a child-preflight escalation rather than
    // silently defaulting. Absent leaves ctx without a `limits` key at all.
    const limits = resolveLimits({ plan_rounds: spec.plan_rounds, build_rounds: spec.build_rounds, review_rounds: spec.review_rounds })
    const limitsOverlay = limitsCtx(limits)
    if (limitsOverlay) ctx.limits = limitsOverlay
    // The round validation lane, resolved exactly as the attended entrypoint
    // resolves --validation-lane/--lane.
    const validationLane = resolveValidationLane({ validationLane: spec.validation_lane, lane: spec.lane })
    ctx.lane = validationLane.lane
    ctx.suite = spec.suite || packageSuite()
    if (strictPreflight) {
      // The shape's DECLARED seats, not the tier three: an envelope shape runs
      // exactly the seats crew/variants.mjs declares (crew/crew.mjs:assertSeats
      // is the same rule at the attended entrypoint).
      const declaredSeats = VARIANTS[execution]?.required_seats
      for (const role of Array.isArray(declaredSeats) ? declaredSeats : ['planner', 'builder', 'reviewer']) if (!crew.members?.[role]) throw new Error(`v3 run requires a ${role} seat (booted roles: ${roles.join(', ')})`)
      if (roles.includes('lead') && !crew.members?.lead) throw new Error(`v3 run requires a lead seat (booted roles: ${roles.join(', ')})`)
      if (!briefFile) throw new Error('run requires --brief-file <path to the task brief>')
      if (!existsChild(ctx.briefFile)) throw new Error(`brief file not found: ${ctx.briefFile}`)
      if (crew.checkout && resolvePath(crew.checkout) !== checkout) throw new Error(`this crew was booted for ${resolvePath(crew.checkout)}, not ${checkout} — same directory name, different checkout`)
      if (spec.continuation !== true) {
        // The daemon's regrant hook is the sole caller that sets continuation:
        // it resumes ON TOP OF the escalated round's uncommitted work.
        const dirty = String(exec('git status --porcelain', { cwd: checkout, encoding: 'utf8' }) || '').trim()
        if (dirty) throw new Error(`checkout is dirty — commit or stash before a crew run:\n${dirty.split('\n').slice(0, 10).join('\n')}`)
      }
    }
    mkdir(taskDir, { recursive: true }); mkdir(returnsDir, { recursive: true })
    const seatIo = injected.seatIo || defaultSeatIo
    const driveTask = injected.driveTask || defaultDriveTask
    const noCmux = injected.seatIoDeps || {
      cmux: () => ({ ok: true }), tree: () => ({ windows: [] }), locate: () => null,
      sendLine: () => {}, closeSurface: () => {},
    }
    // Keep daemon-forked runs in the factory ledger too. openRun deliberately
    // adopts a crew-local ledger/run.json's db_path. That identity is
    // load-bearing only for a configured ceiling: feature-off instrumentation
    // must keep adopting its sidecar and must never become an admission refusal.
    // nodeVersion is deliberately not passed: openRun's own default is
    // process.versions.node.
    // Pass the resolved brief so bootProposal reads its optional compiler
    // proposal block; the daemon path held it in ctx even when crew.json lacked
    // brief_file, and a missing or blockless brief still records null fields.
    const dbPath = spec.ledger_db || ledgerDbPath(injected.env || process.env)
    const enforceBudgetLedger = spec.budget_enabled === true
    let sidecarDbPath = ledgerSidecarDbPath(crewDir, existsChild, read)
    if (!enforceBudgetLedger || sidecarDbPath == null || sidecarDbPath === dbPath) {
      try {
        emitter = openRun({
          stateDir: crewDir,
          repoSlug: slugOrNull(basename(checkout)) || 'repo',
          taskSlug: slugOrNull(ctx.task) || 'task',
          dbPath,
          briefPath: ctx.briefFile,
        })
        // Re-read after openRun's own locked adopt/create decision so a sidecar
        // changed between the first read and the open cannot redirect budgeted
        // work away from the ledger the daemon reads.
        sidecarDbPath = emitter?.sidecar?.()?.db_path ?? null
        if (!enforceBudgetLedger || sidecarDbPath == null || sidecarDbPath === dbPath) {
          emitter.startRun()
          emitter.linkRun(spec.run_id, { crewDir })
        }
      } catch { emitter = null }
    }
    if (enforceBudgetLedger && sidecarDbPath && sidecarDbPath !== dbPath) {
      emitter = null
      const err = new Error(`ledger sidecar at ${join(crewDir, 'ledger', 'run.json')} targets ${sidecarDbPath}, not the daemon ledger ${dbPath} — refusing to run with a mismatched budget ledger; boot a fresh crew or repair the stale sidecar`)
      err.stage = 'ledger-sidecar'
      result = failure(err)
    } else {
      io = seatIo(crew, { dir: crewDir, taskDir, returnsDir }, checkout, emitter, injected.adapters || null, spec, noCmux)
      const protectedFloor = probeProtectedPaths({ checkout })
      ctx.protectedPaths = protectedFloor.paths
      ctx.protectedPathsBasis = protectedFloor.basis
      try {
        io.log?.({ at: new Date().toISOString(), event: 'protected-paths',
          basis: protectedFloor.basis, count: protectedFloor.paths.length })
      } catch { /* instrumentation is never load-bearing */ }
      // Record the EFFECTIVE plan-round budget on every run, flagged or not:
      // an escalation at round N reads differently against a budget of N.
      try {
        io.log?.({ at: new Date().toISOString(), event: 'limits', ...limitsRecord(limits, LIMITS) })
      } catch { /* instrumentation is never load-bearing */ }
      try {
        io.log?.({ at: new Date().toISOString(), event: 'validation-lane', lane: validationLane.lane, source: validationLane.source })
      } catch { /* instrumentation is never load-bearing */ }
      try {
        io.log?.({ at: new Date().toISOString(), event: 'run-configuration', run_configuration: spec.run_configuration ?? null })
      } catch { /* instrumentation is never load-bearing */ }
      // The lane fence rides the same seam as the protected paths: crew.mjs's
      // run verb resolves it out of crew.json (crew/crew.mjs:1190) and the
      // daemon-forked entrypoint must enforce the identical fence, or half the
      // run entrypoints are unfenced. Read the PERSISTED result — never import
      // resolveLaneFence from crew.mjs; the import firewall is deliberate.
      // Deliberately not ctx.lane: that is the test suite lane (:98).
      const laneFence = Array.isArray(crew.lane_fence) ? crew.lane_fence : null
      if (laneFence) {
        ctx.laneFence = laneFence
        ctx.laneName = crew.lane_name ?? null
        try {
          io.log?.({ at: new Date().toISOString(), event: 'lane-fence',
            lane_name: crew.lane_name ?? null, lanes: laneFence.length,
            files: laneFence.reduce((n, record) => n + (record.files?.length ?? 0), 0) })
        } catch { /* instrumentation is never load-bearing */ }
      }
      try { result = driveTask(ctx, io) }
      catch (err) { result = failure(err) }
    }
  } catch (err) {
    if (harness) throw err
    result = failure(err)
  }
  return settle(result)
}

const invokedDirectly = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(SELF_PATH)
if (invokedDirectly && process.argv.includes('--run-child')) {
  try { runChild(process.argv.slice(2)) }
  catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1 }
}
