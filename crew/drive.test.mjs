// crew/drive.test.mjs — the mechanical loop as TESTED CODE (the point of v3).
// Every path through driveTask is exercised with a fake io: happy path,
// red-lane bounce, scope bounce, review bounce, insufficient->lead consult,
// bounce exhaustion->accept/escalate, out-of-set lead answers, commit gating.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'; import { ROOT as REPO_ROOT, scratchDir, treeDigest } from '../test/helpers.mjs'
import { spawnSync } from 'node:child_process'
import { cpus as osCpus, tmpdir } from 'node:os'

import { join } from 'node:path'
import { regrantVerdict } from './escalation-policy.mjs'
import { checkAnchors } from '../skills/qa-test-writing/anchor-pin.mjs'

import { assertSeats, runCmd } from './crew.mjs'
import { runChild } from './child.mjs'
import { SEAT_REFUSAL_STAGE } from './seat-io.mjs'

import {
  driveTask, LIMITS, WAITS_S, WAIT_ROLES, WAIT_FLAGS, WAIT_REFUSALS, WAIT_SECONDS_MIN, WAIT_SECONDS_MAX,
  refuseWait, resolveWaits, waitsCtx, waitsRecord, DECISIONS, SECOND_OPINION, PERSPECTIVE_TARGETS,
  FAILURE_UPGRADE, SENSITIVITY_FLOOR, JUDGE_TIER, PROTECTED_PATHS, resolveProtectedPaths, MODIFIER_OUTCOMES, JOURNAL_CHANNELS, JOURNAL_CHANNEL_NAMES, recordRow, operationalRow,
  validateScopeEntries, scopeMatcher, protectedHits, laneFenceHits, composeCommitMessage,
  RUN_START_EVENT, PUBLISH_BASE, PUBLISH_REFUSALS, PUBLISH_REFUSAL_NAMES,
  NARRATOR_PROVIDER, NARRATION_HEADING, NARRATION_MAX_CHARS, NARRATION_REFUSALS, NARRATION_REFUSAL_NAMES,
  bounceSeatOf, collapseStages, stageShape, relativizeCommand, commitIntent, issueTrailers,
  SHAPE_MAJOR_PHASES, SHAPE_ROUNDED_STAGES, COMMIT_TRAILER, applyNarration, bounceDetail,
  NARRATION_STAGE_VOCABULARY, narrationStageDefect,
  narratorConfig, narratorApiRoot, narratorModelsCommand, narratorModelId, narrationPrompt, narratorCommand,
  narrationFromResponse, narrationIsRawJson, trimPathToken, recordFacts, narrationDefect, narrateRecord,
  shellArg, journalRowsSinceRunStart, prAnomalies, parseSuiteCounts, refsFromCommitMessage, composePrBody,
  parseGateSummary, baselineGateDefect, GATE_SUMMARY_PREFIX, GATE_CUSTODIAN, roundCursor,
  gateReapCommand, gateReapSweepCommand, gateReapOriginal, gateReapVerdict, gateReapFresh, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER,
  validateMutations, checkFailureLine, MUTATION_OUTCOMES, MUTATION_BINDING_FAILURES, MUTATIONS_MAX, CHECK_FAIL_PREFIX,
  bindMutationAnchor, applyMutationAnchor, bindMutationDeclarations, bindMutationCorrection, validateMutationCorrections, correctedMutations, finalizeCorrections, anchorAbsentWhy, MUTATION_BIND_STATUSES, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS,
  FINDING_SEVERITIES, FINDING_DISPOSITIONS, FINDING_ID_SHAPE, RESIDUAL_TYPES, reviewFindings, reviewOutcome,
  HARDENING_MARKS, HARDENING_REFUSALS, HARDENING_OUTCOMES, NAME_VERDICTS, nameVerdict, hardeningOf, hardeningDebt, hardenCommand, hardenWitnessCommand, scopedPath, mutationChangesTokens, validateHardened, hardeningBounceLines, hardeningBriefLines,
  verdictFindingsDefect, findingIdDefect, reviewShapeDefect, guardedWrite, acceptedRawById, patchTargets, dispositionOf, dispositionPlan, askUserLines,
  validateAcceptDecision, validatePlanResiduals, acceptContractLines, planAcceptContractLines, acceptedViaLabel, REFUTATION_EVIDENCE_MAX, ACCEPT_REFUSALS, ACCEPT_REASKS, acceptBounceLines,
  CARVE_VERDICTS, validateCarve, GROWTH_DIVERGENCE_FACTOR, growthRecord, growthLines, divergenceConsultLines,
  PANEL_PARTNERS, PANEL_ADJUDICATORS, panelSeats,
  MAX_QUESTIONS, parseQuestions, matchAnswers, questionConsultLines, answerBounceLines, applyPrescriptionLines,
  VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT, EXECUTIONS, WRITE_SURFACES, ENVELOPE_FIELD_KINDS,
  UNIVERSAL_STAGE_HEADS, SHAPE_SOURCES, REVIEWED_CORE_STAGES, TRIAGE_STAGE_HEAD, TRIAGE_SOURCES, TRIAGE_STAGES,
  DIRECTED_STAGE_HEAD, DIRECTED_SOURCES, DIRECTED_SEATS, DIRECTED_STAGES, PARTIAL_REVIEWED, parseDirectedBrief,
  stageEnabled, undeclaredStage, shapeDefect, sourcesDefect, outOfScopeFiles, envelopeDefect, envelopeFieldsPresent,
  ENVELOPE_REFUSAL_REASONS, bounceTargetOf, staleVerdictLines,
  PLAN_SCOPE, PLAN_SCOPE_VERDICTS, planScopeVerdict,
  SCOPE_REFUSALS, ENVELOPE_DEBRIS, scopeRefusal, scopeBounceBrief,
  SUITE_SLOT_PHASES, SUITE_SLOT_PHASE_NAMES, PHASE_SLOT_WAIT_EVENT, slotAdmission, withPhaseSlot,
} from './drive.mjs'

// Ledger sandbox (#824). crew/drive.mjs#driveTask is a registered home-default door
// (test/factory-env.test.mjs:113), because slotAdmission resolves the suite-slot root
// from DEVTEAM_LEDGER_DIR. This module-scope assignment — set before any test runs — is
// what keeps the operator's ~/.dev-team/factory/slots out of reach of the one call that
// takes production's absent-env default (crew/drive.test.mjs:7214). tmpdir() is
// intentional; this converted file must add no raw temp primitive call — it is in
// TEMP_CONVERTED (test/factory-env.test.mjs:761) and the raw-temp detector (:694) counts
// those call sites, while the sandbox detector's TEMP_MARKERS (:358) accepts tmpdir( too.
const LEDGER_SANDBOX = join(tmpdir(), `b384-drive-ledger-${process.pid}`)
const LEDGER_SANDBOX_PREVIOUS = process.env.DEVTEAM_LEDGER_DIR
process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX
after(() => {
  if (LEDGER_SANDBOX_PREVIOUS === undefined) delete process.env.DEVTEAM_LEDGER_DIR
  else process.env.DEVTEAM_LEDGER_DIR = LEDGER_SANDBOX_PREVIOUS
  rmSync(LEDGER_SANDBOX, { recursive: true, force: true })
})

const TD = '/tmp/fake-task'
const CTX = Object.freeze({
  task: 't1', briefFile: '/tmp/brief.md', taskDir: TD, checkout: '/tmp/repo',
  roles: ['lead', 'planner', 'builder', 'reviewer'], lane: null, suite: 'suite-cmd', env: { CREW_SUITE_SLOTS: '0' },
})

// Scripted fake io: `script` maps `${role}:${n-th call}` -> envelope; runs and
// git are scripted per call. Everything is recorded for assertions.
function fakeIo({ envelopes = {}, runs = {}, changed = [], cleanRuns = null, cleanThrows = false, cold = 'green', showDoc = false, emit = false, files = {}, reseat = null, gh = null, writeThrough = false, throwOn = null, throwWrites = [], seqIds = false, now = () => 0, slots = null } = {}) {
  const calls = { order: [], trace: [], assign: [], run: [], runClean: [], runCold: [], wrapped: [], sweeps: [], reseat: [], commits: [], writes: {}, writeLog: [], checkoutLog: [], logs: [], showDoc: [], emits: [], gh: [], waits: [], sleeps: [], slotFactories: [], files }
  const counts = {}; let seq = 0

  const writeCounts = {}
  const changedQueue = Array.isArray(changed[0]) ? [...changed] : [changed]
  const io = {
    calls,
    assign({ role, briefFile, note }) {
      counts[role] = (counts[role] || 0) + 1; seq += 1
      calls.assign.push({ role, briefFile, note, n: counts[role] })
      return { id: seqIds ? `d${seq}` : `${role}${counts[role]}`, returnPath: `${role}:${counts[role]}` }
    },
    wait(returnPath, timeoutS) {
      calls.waits.push({ returnPath, timeoutS })
      const env = envelopes[returnPath]
      return typeof env === 'function' ? env() : env ?? null
    },
    writeFile(path, content) {
      if (throwWrites.includes(path)) throw new Error('writeFile: report truncation failed')
      if (path.startsWith(`${CTX.checkout}/`)) {
        calls.checkoutLog.push({ op: 'write', path })
        writeCounts[path] = (writeCounts[path] || 0) + 1
        if (throwOn === 'apply' && writeCounts[path] % 2 === 1) throw new Error('writeFile: read-only filesystem')
        if (throwOn === 'restore' && writeCounts[path] % 2 === 0) throw new Error('writeFile: the restore write failed')
      }
      calls.writes[path] = content
      calls.writeLog.push({ path, content })
      if (writeThrough) files[path] = content
    },
    readFile(p) {
      if (p.startsWith(`${CTX.checkout}/`)) calls.checkoutLog.push({ op: 'read', path: p })
      if (throwOn === 'read' && p.startsWith(`${CTX.checkout}/`)) throw new Error('readFile: permission denied')
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p]
      if (/gate-reap\.\d+\.json$/.test(p)) return '{"pgid":"4242","outcome":"already-dead","reason":"probe-dead","signals":0,"survivors":""}'
      return null
    },
    run(cmd) {
      if (String(cmd).includes(GATE_REAP_SWEEP_MARKER)) { calls.sweeps.push(cmd); return { ok: true, output: '' } }
      calls.order.push('run')
      const original = gateReapOriginal(cmd)
      counts[original] = (counts[original] || 0) + 1
      calls.run.push({ cmd: original, n: counts[original] })
      calls.trace.push(`run:${original}`)
      calls.wrapped.push({ cmd: original, wrapped: cmd, clean: false })
      const r = runs[`${original}:${counts[original]}`] ?? runs[original] ?? { ok: true, output: '' }
      return r
    },
    changedFiles() { return changedQueue.length > 1 ? changedQueue.shift() : changedQueue[0] },
    commit(files, message) { calls.order.push('commit'); calls.commits.push({ files, message }); return 'abc1234' },
    status(label) { (calls.status ||= []).push(label) },
    log(obj) { calls.logs.push(obj) },
    now() { return now() },
  }
  if (cold !== null) {
    io.runCold = (cmd, names) => {
      calls.order.push('runCold')
      calls.runCold.push({ cmd, names })
      calls.trace.push(`runCold:${cmd}`)
      if (cold === 'throw') throw new Error('injected cold runner failure')
      if (cold === 'green') return { ok: true, output: '', path: '/zz/aa11bb', kept: null }
      return cold
    }
  }
  if (cleanRuns || cleanThrows) {
    io.runClean = (cmd) => {
      const original = gateReapOriginal(cmd)
      counts[`clean:${original}`] = (counts[`clean:${original}`] || 0) + 1
      calls.runClean.push({ cmd: original, n: counts[`clean:${original}`] })
      calls.trace.push(`runClean:${original}`)
      calls.wrapped.push({ cmd: original, wrapped: cmd, clean: true })
      if (cleanThrows) throw new Error("runClean: git stash pop FAILED — the checkout is half-restored and the builder's work is in the stash")
      return cleanRuns[`${original}:${counts[`clean:${original}`]}`] ?? cleanRuns[original] ?? { ok: false, output: '' }
    }
  }
  if (showDoc) io.showDoc = (p) => { calls.showDoc.push(p) }
  if (emit) io.emit = emit === true ? (event) => { calls.emits.push(event) } : emit
  if (reseat) io.reseat = (role, options) => {
    calls.reseat.push({ role, options })
    return reseat(role, options)
  }
  if (typeof slots === 'function') {
    io.slots = (spec) => {
      calls.slotFactories.push({ ...spec })
      return slots(spec, calls)
    }
    io.sleep = (ms) => { calls.sleeps.push(ms) }
  }
  if (gh) {
    const spec = gh === true ? {} : gh
    const scripted = (kind, index, args) => {
      const value = spec[`${kind}Results`] ?? spec[kind]
      if (typeof value === 'function') return value(args, index)
      if (Array.isArray(value)) return value[index - 1]
      return value
    }
    io.createIssue = (args) => {
      const index = calls.gh.filter((call) => call.method === 'createIssue').length + 1
      calls.gh.push({ method: 'createIssue', args })
      if (spec.issueThrows) throw new Error(spec.issueThrows === true ? 'createIssue failed' : spec.issueThrows)
      return scripted('createIssue', index, args) ?? { number: 700 + index, url: `https://example.invalid/issues/${700 + index}` }
    }
    io.createDraftPr = (args) => {
      const index = calls.gh.filter((call) => call.method === 'createDraftPr').length + 1
      calls.gh.push({ method: 'createDraftPr', args })
      if (spec.prThrows) throw new Error(spec.prThrows === true ? 'createDraftPr failed' : spec.prThrows)
      return scripted('createDraftPr', index, args) ?? { number: 42, url: 'https://example.invalid/pr/42' }
    }
  }
  return io
}

function fakePool({ calls, refusals = [], throwOnAcquire = null } = {}) {
  const pending = [...refusals]
  let serial = 0
  return {
    kind: 'suite', capacity: 4,
    acquire({ owner }) {
      const phase = String(owner).split(':').at(-1)
      const event = { op: 'acquire', label: `acquire:${phase}`, owner, handle: null }
      calls.trace.push(event)
      if (throwOnAcquire) {
        if (throwOnAcquire instanceof Error) throw throwOnAcquire
        throw new Error(String(throwOnAcquire))
      }
      if (pending.length > 0) {
        const depth = pending.shift()
        event.depth = depth
        return { waiting: true, depth }
      }
      const slot = `suite-${serial++}`
      const handle = { kind: 'suite', slot, token: `token-${serial}`, owner }
      event.handle = handle
      return { slot, handle }
    },
    release(handle) {
      calls.trace.push({ op: 'release', label: `release:${handle?.slot}`, owner: handle?.owner, handle })
      return true
    },
  }
}

const traceLabels = (calls) => calls.trace.map((entry) => typeof entry === 'string' ? entry : entry.label)
const traceSubsequence = (calls, expected) => {
  const labels = traceLabels(calls)
  let index = 0
  for (const label of expected) {
    index = labels.indexOf(label, index)
    assert.notEqual(index, -1, `missing ordered trace event ${label}: ${JSON.stringify(labels)}`)
    index += 1
  }
}

function closeoutIo(options = {}) {
  return fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    ...options,
  })
}

// Drive `crew.mjs run` for real without a booted workspace: a throwaway HOME, a
// throwaway git checkout and a hand-written crew.json. `drive` is stubbed, so
// the ctx handed to the driver and the journal rows beside it are observable.
function runCmdFixture(flags = {}, driveOverride = null) {
  const home = scratchDir('crew-waits-run-home-')
  const checkoutRoot = scratchDir('crew-waits-run-checkout-')
  const checkout = join(checkoutRoot, 'checkout')
  const task = 'waits-run'
  const previousHome = process.env.HOME
  const previousWrite = process.stdout.write
  try {
    mkdirSync(checkout)
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'crew-tests@example.invalid'],
      ['config', 'user.name', 'crew tests'],
      ['commit', '-q', '--allow-empty', '-m', 'init'],
    ]) {
      const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
    }
    process.env.HOME = home
    const dir = join(home, '.crew', 'checkout', task)
    const returnsDir = join(dir, 'returns')
    mkdirSync(join(dir, 'task'), { recursive: true })
    mkdirSync(returnsDir, { recursive: true })
    const roles = ['lead', 'planner', 'builder', 'reviewer']
    const taskReturn = join(returnsDir, 'task.json')
    writeFileSync(join(dir, 'crew.json'), JSON.stringify({
      schema_version: 3, task, checkout, roles, task_return: taskReturn,
      members: Object.fromEntries(roles.map((role) => [role, { transport: 'headless-json' }])),
    }))
    writeFileSync(taskReturn, JSON.stringify({ status: 'done' }))
    const brief = join(home, 'brief.md')
    writeFileSync(brief, '# wait budget fixture\n')
    let ctx = null
    process.stdout.write = () => true
    try {
      runCmd({ task, checkout, 'brief-file': brief, keep: true, ...flags }, {
        drive: (seen) => {
          ctx = seen; if (driveOverride) return driveOverride(seen)
          return { status: 'done', summary: '', artifacts: [], details: { commit: null, stages: [] } }
        },
      })
    } finally { process.stdout.write = previousWrite }
    const rows = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); const envelope = JSON.parse(readFileSync(taskReturn, 'utf8')); return { ctx, rows, envelope }
  } finally {
    process.stdout.write = previousWrite
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(checkoutRoot, { recursive: true, force: true })
  }
}

const CTX_REPAIR = Object.freeze({ ...CTX, variant: 'repair', lane: 'lane-cmd', files_in_scope: ['a.mjs', 'a.test.mjs'] })
const DIRECTED_BRIEF_PATH = `${TD}/directed-brief.md`
const DIRECTED_BRIEF_TEXT = [
  '# Directed task', '',
  '```directed',
  JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['a.mjs', 'a.test.mjs'] }),
  '```', '',
].join('\n')
const DIRECTED_FILES = { [DIRECTED_BRIEF_PATH]: DIRECTED_BRIEF_TEXT }
const CTX_DIRECTED = Object.freeze({
  ...CTX, variant: 'directed', briefFile: DIRECTED_BRIEF_PATH,
  roles: ['lead', 'builder', 'reviewer'], seatedRoles: ['lead', 'builder', 'reviewer'], lane: 'lane-cmd',
})
const TRIAGE_NOTE = `${TD}/triage.md`
const TRIAGE_FILES = { [TRIAGE_NOTE]: '# Triage\n\nfix the off-by-one in a.mjs\n' }
const SKILL_NAMES = ['review-procedure', 'ast-grep-codemod']
const triageEnv = (over = {}) => ({
  status: 'done', role: 'planner', summary: 'triaged', artifacts: [TRIAGE_NOTE], details: { plan_path: TRIAGE_NOTE }, ...over,
})

const planEnv = (over = {}) => ({
  status: 'done', role: 'planner', summary: 'planned',
  artifacts: [`${TD}/plan.md`],
  details: { plan_path: `${TD}/plan.md`, files_in_scope: ['a.mjs', 'a.test.mjs'], validation_lane: 'lane-cmd', consult_questions: [], carve_verdict: 'proceed' },
  ...over,
})
const buildEnv = (over = {}) => ({
  status: 'done', role: 'builder', summary: 'built',
  details: { files_changed: ['a.mjs', 'a.test.mjs'], commit_message: 'feat: the change' }, ...over,
})
const reviewEnv = (verdict, findings) => ({
  status: 'done', role: 'reviewer', summary: 'reviewed',
  details: {
    verdict, review_path: `${TD}/review.md`, must_fix: verdict === 'pass' ? 0 : 1,
    ...(findings === undefined ? {} : { findings }),
  },
})
const legacyReviewerExemptions = (findings) => Array.isArray(findings)
  ? findings.map((finding) => finding?.severity === 'must-fix' && finding.hardening === undefined
    ? { ...finding, hardening: 'ungateable', hardening_why: 'legacy fixture has no guard declaration' }
    : finding)
  : findings
const reconEnv = (over = {}) => ({
  status: 'done', role: 'planner', summary: 'recon complete',
  artifacts: [`${TD}/scout.md`],
  details: { findings: [{ summary: 'the loop is code-owned', evidence: 'crew/drive.mjs:720' }] },
  ...over,
})
const checkEnv = (verdict) => ({
  status: 'done', role: 'tech-lead', summary: 'checked',
  details: { verdict, check_path: `${TD}/plan-check.md` },
})
const CTX_TL = Object.freeze({ ...CTX, roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'] })
const leadEnv = (decision, guidance = 'do X then Y in a.mjs', details = {}) => ({
  status: 'done', role: 'lead', details: { decision, reason: 'because', guidance, ...details },
})

const PLAN_RESIDUAL = { id: 'plan-gap', type: 'cosmetic', summary: 'the plan lacks one acceptance check' }
const PLAN_CHECK_FINDINGS = [
  { id: 'RV-plan-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'the review follow-up remains' },
]

function planCheckAcceptIo(details = {}, options = {}) {
  const { leadAnswers = [], ...rest } = options
  const followUps = Object.fromEntries(leadAnswers.map((answer, index) => (
    [`lead:${index + 2}`, leadEnv(answer.decision || 'accept', 'because', answer)]
  )))
  return fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'),
      'lead:1': leadEnv('accept', 'because the latest plan is usable', details),
      ...followUps,
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    ...rest,
  })
}

test('a plan-check accept records the residual the lead named', () => {
  const io = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].where, 'plan-check')
  assert.equal(rows[0].outcome, 'accepted')
  assert.deepEqual(rows[0].residuals, [PLAN_RESIDUAL])
  assert.deepEqual(result.details.accept_decision, rows[0])
})

test('a plan-check accept naming no residual records an empty accept', () => {
  const io = planCheckAcceptIo()
  const result = driveTask(CTX_TL, io)
  const row = io.calls.logs.find((entry) => entry.accept_decision)?.accept_decision
  assert.equal(result.status, 'done')
  assert.equal(row.outcome, 'accepted')
  assert.deepEqual(row.residuals, [])
  assert.deepEqual(result.details.accept_decision.residuals, [])
})

test('an accepted decision records refusal null and reasked 0', () => {
  const io = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const result = driveTask(CTX_TL, io)
  const row = result.details.accept_decision
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(row.outcome, 'accepted')
  assert.equal(row.refusal, null)
  assert.equal(row.reasked, 0)
})

test('a correctness-unverified plan-check residual still escalates', () => {
  const io = planCheckAcceptIo({ residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(result.details.accept_decision.outcome, 'escalated')
  assert.deepEqual(result.details.accept_decision.unverified, ['plan-gap'])
  assert.equal(io.calls.commits.length, 0)
})

test('a malformed plan-check residual refuses the accept with keyed errors', () => {
  const malformed = { residuals: [
    { id: 'bad-type', type: 'not-a-residual-type', summary: 'named gap' },
    { id: 'no-summary', type: 'cosmetic' },
  ] }
  const io = planCheckAcceptIo(malformed, { leadAnswers: [malformed] })
  const result = driveTask(CTX_TL, io)
  const row = io.calls.logs.find((entry) => entry.accept_decision)?.accept_decision
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(io.calls.commits.length, 0)
  assert.ok(row.errors.some((error) => error.id === 'bad-type' && error.why === 'unknown residual type'))
  assert.ok(row.errors.some((error) => error.id === 'no-summary' && error.why === 'empty residual summary'))
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('the plan-check consult names residuals, types, and its unchanged options', () => {
  const io = planCheckAcceptIo()
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /details\.residuals/)
  for (const type of RESIDUAL_TYPES) assert.match(brief, new RegExp(type))
  const optionsBlock = brief.match(/## Your options[\s\S]*?\n\n## Context files/)[0]
  const options = [...optionsBlock.matchAll(/^- ([^\n]+)/gm)]
    .map(([, option]) => option.replace(/\s+\(.*$/, ''))
  assert.deepEqual(options, ['bounce', 'accept', 'escalate', 'second-opinion'])
  for (const type of RESIDUAL_TYPES) assert.match(planAcceptContractLines().join('\n'), new RegExp(type))
})

test('the measured b287 refuted-only accept bounces once and a corrected answer accepts', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { outcome: rows[0].outcome, refusal: rows[0].refusal, reasked: rows[0].reasked, residuals: rows[0].residuals },
    { outcome: 'accepted', refusal: null, reasked: 1, residuals: [PLAN_RESIDUAL] },
  )
})

test('the accept re-ask brief carries the validator refusal and the contract this stage offers', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-1-reask1.md`]
  assert.ok(brief)
  assert.match(brief, /refuted is not supported at a plan-check accept/)
  for (const line of planAcceptContractLines()) {
    if (line !== '') assert.ok(brief.includes(line), `missing contract line: ${line}`)
  }
})

test('a second malformed accept escalates once and carries the original refusal', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [{ id: 'no-summary', type: 'cosmetic' }] }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.match(result.details.escalation.why, /empty residual summary/)
  assert.match(result.details.escalation.why, /refuted is not supported/)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('a lead that answers escalate at the accept re-ask escalates with both reasons', () => {
  const io = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ decision: 'escalate', reason: 'a human should read this' }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.match(result.details.escalation.why, /refuted is not supported/)
  assert.match(result.details.escalation.why, /a human should read this/)
  assert.equal(io.calls.commits.length, 0)
})

test('a form refusal is typed malformed and a correctness-unverified one judgment', () => {
  const formIo = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'not a plan residual' }] },
    { leadAnswers: [{ refuted: [{ id: 'C1', evidence: 'not a plan residual' }] }] },
  )
  const form = driveTask(CTX_TL, formIo)
  const formRow = form.details.accept_decision

  const judgmentIo = planCheckAcceptIo({ residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] })
  const judgment = driveTask(CTX_TL, judgmentIo)
  const judgmentRow = judgment.details.accept_decision

  assert.equal(form.status, 'escalation')
  assert.equal(judgment.status, 'escalation')
  assert.equal(formRow.outcome, 'escalated')
  assert.equal(judgmentRow.outcome, 'escalated')
  assert.equal(formRow.refusal, 'malformed')
  assert.equal(judgmentRow.refusal, 'judgment')
  assert.ok(ACCEPT_REFUSALS.includes(formRow.refusal))
  assert.ok(ACCEPT_REFUSALS.includes(judgmentRow.refusal))
})

test('a judgement refusal is never re-asked', () => {
  const io = planCheckAcceptIo(
    { residuals: [{ ...PLAN_RESIDUAL, type: 'correctness-unverified' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'escalation')
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 0)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 1)
})

function planThenReviewIo(laterDetails, correction = laterDetails) {
  return fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'),
      'lead:1': leadEnv('accept', 'record the plan gap', { residuals: [PLAN_RESIDUAL] }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', legacyReviewerExemptions(PLAN_CHECK_FINDINGS)),
      'reviewer:2': reviewEnv('changes-needed', legacyReviewerExemptions(PLAN_CHECK_FINDINGS)),
      'lead:2': leadEnv('accept', 'record the review decision', laterDetails),
      'lead:3': leadEnv('accept', 'correct the review decision', correction),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
}

test('a later refused review accept supersedes the plan-check decision on escalation', () => {
  const io = planThenReviewIo({ residuals: [{ id: 'unknown-review', type: 'cosmetic' }] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.equal(io.calls.commits.length, 0)
})

test('a later valid review accept supersedes the plan-check decision on done', () => {
  const io = planThenReviewIo({ residuals: [{ id: 'RV-plan-1', type: 'cosmetic' }], refuted: [] })
  const result = driveTask(CTX_TL, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'done')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.deepEqual(result.details.accept_decision, rows.at(-1))
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.equal(result.details.accept_decision.outcome, 'accepted')
  assert.notDeepEqual(result.details.accept_decision, rows[0])
})

test('a malformed review-exhaustion accept is re-asked with the keyed contract', () => {
  const io = planThenReviewIo(
    { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] },
    { residuals: [{ id: 'RV-plan-1', type: 'cosmetic' }], refuted: [] },
  )
  const result = driveTask(CTX_TL, io)
  const brief = io.calls.writes[`${TD}/decision-2-reask1.md`]
  assert.ok(brief)
  for (const line of acceptContractLines(PLAN_CHECK_FINDINGS)) {
    if (line !== '') assert.ok(brief.includes(line), `missing contract line: ${line}`)
  }
  assert.equal(result.status, 'done')
  assert.equal(result.details.accept_decision.where, 'review-exhausted')
  assert.equal(result.details.accept_decision.outcome, 'accepted')
})

test('a later refused review accept supersedes the plan-check decision on converge', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': CONVERGE_PLAN(), 'tech-lead:1': checkEnv('revise'),
      'lead:1': leadEnv('accept', 'record the plan gap', { residuals: [PLAN_RESIDUAL] }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', legacyReviewerExemptions(REVIEW_FINDINGS)),
      'lead:2': leadEnv('accept', 'record the refused review claim', { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] }),
      'lead:3': leadEnv('accept', 'record the refused review claim', { residuals: [{ id: 'unknown-review', type: 'cosmetic' }] }),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: CONVERGE_GATE },
      'gate-cmd': { ok: true, output: REVIEW_GATE_PASS },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'], gh: true,
  })
  const result = driveTask({ ...CTX_TL, limits: { plan_rounds: 1, build_rounds: 2, review_rounds: 1 } }, io)
  const rows = io.calls.logs.filter((entry) => entry.accept_decision).map((entry) => entry.accept_decision)
  assert.equal(result.status, 'converge')
  assert.deepEqual(rows.map(({ where }) => where), ['plan-check', 'review-exhausted'])
  assert.deepEqual(result.details.accept_decision, rows.at(-1))
  assert.equal(result.details.accept_decision.outcome, 'escalated')
})

test('a supplied wait budget reaches io.wait and names the seat overdue at that budget', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask({ ...CTX, waits: { planner: 42 } }, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope .* within 42s/)
  assert.deepEqual(io.calls.waits[0], { returnPath: 'planner:1', timeoutS: 42 })
})

test('an absent wait budget resolves to the recorded WAITS_S value', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope .* within 1800s/)
  assert.equal(io.calls.waits[0].timeoutS, WAITS_S.planner)
})

test('a malformed wait budget refuses at the boundary instead of defaulting', () => {
  for (const raw of [0, '0', -1, '2.5', 'abc', '1e3', 21601, true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveWaits({ planner: raw }),
      (err) => err.reason === 'invalid-wait-planner',
    )
  }
  assert.throws(() => resolveWaits(true), (err) => err.reason === WAIT_REFUSALS[0])
  assert.throws(() => resolveWaits([]), (err) => err.reason === WAIT_REFUSALS[0])
  assert.deepEqual(resolveWaits({}), Object.fromEntries(WAIT_ROLES.map((role) => [role, null])))
  assert.equal(resolveWaits({ planner: '   ' }).planner, null)
})

test('the wait flag, refusal and record surfaces are derived from WAITS_S', () => {
  assert.deepEqual(WAIT_ROLES, Object.keys(WAITS_S))
  assert.deepEqual(WAIT_FLAGS, ['wait-planner', 'wait-tech-lead', 'wait-builder', 'wait-reviewer', 'wait-lead'])
  assert.deepEqual(WAIT_REFUSALS, ['invalid-wait-planner', 'invalid-wait-tech-lead', 'invalid-wait-builder', 'invalid-wait-reviewer', 'invalid-wait-lead'])
  assert.throws(() => refuseWait('nope', 'x'), /unknown wait refusal reason/)
  assert.equal(WAIT_SECONDS_MIN, 1)
  assert.equal(WAIT_SECONDS_MAX, 21600)
  assert.equal(waitsCtx(resolveWaits({})), null)
  assert.deepEqual(waitsCtx(resolveWaits({ reviewer: '600' })), { reviewer: 600 })
  assert.deepEqual(waitsRecord(resolveWaits({ planner: '2400' }), WAITS_S), {
    planner: 2400, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
    source: { planner: 'flag', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'default' },
  })
})

test('run refuses an invalid wait budget before reading crew state', () => {
  const home = scratchDir('crew-waits-refusal-home-')
  const previousHome = process.env.HOME
  let drove = 0
  process.env.HOME = home
  try {
    for (const role of ['planner', 'tech-lead', 'builder', 'reviewer', 'lead']) {
      const flag = `wait-${role}`
      assert.throws(
        () => runCmd({ task: 'invalid-wait-run', checkout: process.cwd(), 'brief-file': join(home, 'missing.md'), [flag]: '2.5' }, { drive: () => { drove += 1 } }),
        (err) => err.reason === `invalid-wait-${role}`,
      )
    }
    assert.equal(drove, 0)
    assert.equal(existsSync(join(home, '.crew')), false)
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('run plumbs flagged wait budgets to the driver and records defaults when absent', () => {
  const flagged = runCmdFixture({ 'wait-planner': '2700', 'wait-lead': '1200' })
  assert.deepEqual(flagged.ctx.waits, { planner: 2700, lead: 1200 })
  const flaggedRow = flagged.rows.find((row) => row.event === 'waits')
  assert.ok(flaggedRow)
  assert.equal(flaggedRow.planner, 2700)
  assert.equal(flaggedRow.lead, 1200)
  assert.deepEqual(flaggedRow.source, {
    planner: 'flag', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'flag',
  })

  const absent = runCmdFixture()
  assert.equal(Object.hasOwn(absent.ctx, 'waits'), false)
  const absentRow = absent.rows.find((row) => row.event === 'waits')
  assert.ok(absentRow)
  assert.deepEqual(absentRow.source, {
    planner: 'default', 'tech-lead': 'default', builder: 'default', reviewer: 'default', lead: 'default',
  })
})

test('crew CLI usage documents the per-role seat wait budget flags', () => {
  const source = readFileSync(new URL('./crew.mjs', import.meta.url), 'utf8')
  assert.match(source, /--wait-planner/)
  assert.match(source, /--wait-tech-lead/)
  assert.match(source, /--wait-builder/)
  assert.match(source, /--wait-reviewer/)
  assert.match(source, /--wait-lead/)
})

test('parseQuestions normalizes survivors, reports malformed entries, and is total', () => {
  assert.equal(parseQuestions(null), null)
  assert.equal(parseQuestions(undefined), null)
  assert.equal(parseQuestions('not details'), null)
  assert.equal(parseQuestions({ questions: 'not an array' }), null)

  const parsed = parseQuestions({
    questions: [
      { id: ' q1 ', question: ' first? ' },
      { question: 'missing id' },
      { id: 'q2' },
      'not an object',
      ['nested array'],
      { id: ' q1 ', question: 'duplicate' },
      { id: 'q3', question: ' third? ' },
    ],
  })
  assert.deepEqual(parsed.questions, [
    { id: 'q1', question: 'first?' },
    { id: 'q3', question: 'third?' },
  ])
  assert.ok(parsed.rejected.some(({ why }) => why === 'missing id'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'missing question'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'not a plain object'))
  assert.ok(parsed.rejected.some(({ why }) => why === 'duplicate id'))
  assert.ok(parsed.rejected.every(({ index, why }) => Number.isInteger(index) && typeof why === 'string' && why.length > 0))

  const overCap = parseQuestions({
    questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => ({ id: `q${index}`, question: `question ${index}` })),
  })
  assert.equal(overCap.questions.length, MAX_QUESTIONS)
  assert.deepEqual(overCap.rejected.at(-1), { index: MAX_QUESTIONS, why: `over the ${MAX_QUESTIONS}-question cap` })
  for (const garbage of [null, 'string', 42, [[]]]) assert.doesNotThrow(() => parseQuestions(garbage))

  const hostileLength = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return { [Symbol.toPrimitive]() { throw new Error('hostile length') } }
      return Reflect.get(target, property, receiver)
    },
  })
  assert.doesNotThrow(() => parseQuestions({ questions: hostileLength }))
  assert.doesNotThrow(() => matchAnswers(hostileLength, hostileLength))
  assert.doesNotThrow(() => questionConsultLines('planner', hostileLength))
  assert.doesNotThrow(() => answerBounceLines(hostileLength, { answered: hostileLength, rejected: hostileLength }))
})

test('matchAnswers matches keyed answers and never reads silence as assent', () => {
  const questions = [{ id: 'q1', question: 'one?' }, { id: 'q2', question: 'two?' }, { id: 'q3', question: 'three?' }]
  const matched = matchAnswers(questions, [
    { id: ' q1 ', answer: ' answer one ' },
    { id: 'q1', answer: 'duplicate' },
    { id: 'unknown', answer: 'not asked' },
    { id: 'q3', answer: '   ' },
  ])
  assert.deepEqual(matched.answered, [{ id: 'q1', answer: 'answer one' }])
  assert.deepEqual(matched.unanswered, ['q2', 'q3'])
  assert.deepEqual(matched.rejected, [
    { id: 'q1', why: 'duplicate id' },
    { id: 'unknown', why: 'unknown id' },
    { id: 'q3', why: 'empty answer' },
  ])
  assert.deepEqual(matchAnswers(questions.slice(0, 1), [
    { id: 'q1', answer: '   ' }, { id: 'q1', answer: ' usable ' },
  ]), {
    answered: [{ id: 'q1', answer: 'usable' }], unanswered: [],
    rejected: [{ id: 'q1', why: 'empty answer' }],
  })

  assert.deepEqual(matchAnswers(questions, undefined), {
    answered: [], unanswered: ['q1', 'q2', 'q3'],
    rejected: [{ id: null, why: 'answers must be an array' }],
  })
  assert.deepEqual(matchAnswers(questions, null), {
    answered: [], unanswered: ['q1', 'q2', 'q3'],
    rejected: [{ id: null, why: 'answers must be an array' }],
  })
})

test('question and answer composers are empty for an empty question set', () => {
  assert.deepEqual(questionConsultLines('planner', []), [])
  assert.deepEqual(answerBounceLines([], { answered: [], unanswered: [], rejected: [] }), [])
  const consult = questionConsultLines('planner', [{ id: 'q1', question: 'Which path?' }]).join('\n')
  assert.ok(consult.includes('## The planner returned 1 numbered question(s) — answer ALL of them'))
  assert.ok(consult.includes('details.answers: [{"id": "<question id>", "answer": "..."}]'))
  assert.match(consult, /id you leave out.*UNANSWERED/)
  const bounce = answerBounceLines(
    [{ id: 'q1', question: 'Which path?' }, { id: 'q2', question: 'Which test?' }],
    { answered: [{ id: 'q1', answer: 'crew/drive.mjs' }], rejected: [{ id: 'q9', why: 'unknown id' }] },
  ).join('\n')
  assert.ok(bounce.includes('q1: Which path?\n  ANSWER: crew/drive.mjs'))
  assert.ok(bounce.includes('q2: Which test?\n  UNANSWERED'))
  assert.match(bounce, /Dropped answer entries.*q9.*unknown id/)
})

test('reviewOutcome normalizes reviewer verdicts and count fields', () => {
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'revise', must_fix: 3, should_fix: 2, consider: 1 },
  }), { verdict: 'changes-needed', must_fix: 3, should_fix: 2, consider: 1 })
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'approve', must_fix: -1, should_fix: 1.5, consider: '0' },
  }), { verdict: 'pass', must_fix: null, should_fix: null, consider: null })
  assert.equal(reviewOutcome('planner', { status: 'done', details: { verdict: 'pass' } }), null)
  assert.equal(reviewOutcome('reviewer', { status: 'done', details: { defect: 'gate' } }), null)
})

test('reviewOutcome carries reviewer findings verbatim and stable', () => {
  const envelope = {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 1, should_fix: 1, consider: 0,
      findings: [
        { id: 'RV1-2', severity: 'should-fix', location: ' a.mjs:12 ', summary: ' second ' },
        { id: 'RV1-1', severity: 'must-fix', location: 'b.mjs:3', summary: 'first' },
      ],
    },
  }
  const first = reviewOutcome('reviewer', envelope)
  const second = reviewOutcome('reviewer', envelope)
  assert.deepEqual(first.findings, [
    { id: 'RV1-2', severity: 'should-fix', location: 'a.mjs:12', summary: 'second', disposition: null },
    { id: 'RV1-1', severity: 'must-fix', location: 'b.mjs:3', summary: 'first', disposition: null },
  ])
  assert.deepEqual(second.findings, first.findings)
  assert.deepEqual(first.findings_report, {
    total: 2,
    tally: { must_fix: 1, should_fix: 1, consider: 0 },
    rejected: [], count_mismatch: [],
  })
})

test('malformed findings are dropped and reported, never thrown', () => {
  const out = reviewOutcome('reviewer', {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 1,
      findings: [
        { id: 'ok-1', severity: 'must-fix' },
        { id: 'ok-1', severity: 'consider' },
        { severity: 'consider' },
        { id: 'bad-sev', severity: 'blocker' },
        'not-an-object',
      ],
    },
  })
  assert.deepEqual(out.findings, [{ id: 'ok-1', severity: 'must-fix', location: null, summary: null, disposition: null }])
  assert.deepEqual(out.findings_report.rejected, [
    { index: 1, why: 'duplicate id' },
    { index: 2, why: 'missing id' },
    { index: 3, why: 'severity outside the closed set' },
    { index: 4, why: 'missing id' },
  ])
  assert.deepEqual(reviewFindings({ findings: 'not-an-array' }), null)
})

test('an envelope without findings yields exactly today\'s outcome object', () => {
  const expected = { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 }
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0 },
  }), expected)
  assert.deepEqual(reviewOutcome('reviewer', {
    status: 'done', details: { verdict: 'changes-needed', must_fix: 2, should_fix: 1, consider: 0, findings: 'nonsense' },
  }), expected)
})

test('counts that disagree with findings are recorded, not corrected', () => {
  const out = reviewOutcome('reviewer', {
    status: 'done', details: {
      verdict: 'changes-needed', must_fix: 3, should_fix: 2, consider: 0,
      findings: [{ id: 'f1', severity: 'must-fix' }],
    },
  })
  assert.equal(out.must_fix, 3)
  assert.equal(out.should_fix, 2)
  assert.equal(out.consider, 0)
  assert.deepEqual(out.findings_report.count_mismatch, ['must_fix', 'should_fix'])
})

test('a drive with findings produces the same result as one without', () => {
  const reviewer = (findings) => {
    const base = reviewEnv('pass')
    return {
      ...base,
      details: {
        ...base.details, must_fix: 0, should_fix: 0, consider: 0,
        ...(findings === undefined ? {} : { findings }),
      },
    }
  }
  const run = (review) => {
    const io = fakeIo({
      envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': review },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    return { result: driveTask(CTX, io), io }
  }
  const without = run(reviewer())
  const withFindings = run(reviewer([
    { id: 'RV1-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'failure scenario', patch: '@@ not a diff the driver may read @@' },
  ]))
  assert.deepEqual(withFindings.result, without.result)
  assert.equal(withFindings.io.calls.run.filter((r) => /^git apply /.test(r.cmd)).length, 0)
  assert.equal(withFindings.io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  assert.ok(withFindings.io.calls.logs.some((line) => line.review_outcome?.findings?.some((f) => f.id === 'RV1-1')))
  const note = withFindings.io.calls.logs.find((line) => line.review_findings_note)?.review_findings_note
  assert.deepEqual(note?.count_mismatch, ['should_fix'])
})

test('validateAcceptDecision collects each typed residual error without throwing', () => {
  const cases = [
    ['residuals must be an array', { findings: [], residuals: {} }],
    ['refuted must be an array', { findings: [], refuted: {} }],
    ['missing id', { findings: [], residuals: [{}] }],
    ['invalid type', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], residuals: [{ id: 'RV1-1', type: 'other' }] }],
    ['empty refutation evidence', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], refuted: [{ id: 'RV1-1', evidence: '  ' }] }],
    ['unknown id', { findings: [], residuals: [{ id: 'RV1-9', type: 'cosmetic' }] }],
    ['duplicate id', { findings: [{ id: 'RV1-1', severity: 'should-fix' }], residuals: [{ id: 'RV1-1', type: 'cosmetic' }], refuted: [{ id: 'RV1-1', evidence: 'not real' }] }],
    ['must-fix may not be typed cosmetic', { findings: [{ id: 'RV1-1', severity: 'must-fix' }], residuals: [{ id: 'RV1-1', type: 'cosmetic' }] }],
    ['omitted id', { findings: [{ id: 'RV1-1', severity: 'must-fix' }] }],
  ]
  for (const [why, input] of cases) {
    const result = validateAcceptDecision(input)
    assert.equal(result.ok, false, why)
    assert.ok(result.errors.some((error) => error.why === why), why)
  }
})

test('validateAcceptDecision accepts empty findings with an empty decision', () => {
  assert.deepEqual(validateAcceptDecision({ findings: [], residuals: [], refuted: [] }), {
    ok: true, residuals: [], refuted: [], unverified: [], refuted_must_fix: [],
  })
})

test('validatePlanResiduals normalizes valid entries and fails closed on malformed input', () => {
  const long = `  ${'x'.repeat(REFUTATION_EVIDENCE_MAX)}TAIL  `
  const valid = validatePlanResiduals([{ id: '  gap-1  ', type: 'cosmetic', summary: long }])
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.residuals[0].id, 'gap-1')
  assert.equal(valid.residuals[0].summary.length, REFUTATION_EVIDENCE_MAX)
  assert.equal(valid.residuals[0].summary.endsWith('…'), true)
  assert.deepEqual(valid.unverified, [])
  assert.deepEqual(valid.refuted, [])
  assert.deepEqual(valid.refuted_must_fix, [])

  const malformed = [
    ['missing id', [{ type: 'cosmetic', summary: 'named gap' }]],
    ['unknown residual type', [{ id: 'bad-type', type: 'other', summary: 'named gap' }]],
    ['empty residual summary', [{ id: 'empty-summary', type: 'cosmetic', summary: '  ' }]],
    ['duplicate id', [{ id: 'same', type: 'cosmetic', summary: 'first' }, { id: 'same', type: 'cosmetic', summary: 'second' }]],
    ['residuals must be an array', {}],
  ]
  for (const [why, residuals] of malformed) {
    const result = validatePlanResiduals(residuals)
    assert.equal(result.ok, false, why)
    assert.ok(result.errors.some((error) => error.why === why), why)
  }

  for (const refuted of [undefined, null, []]) {
    const result = validatePlanResiduals([], refuted)
    assert.equal(result.ok, true)
    assert.deepEqual(result.refuted, [])
  }
  for (const refuted of [{}, [{ id: 'RV1-1' }]]) {
    const result = validatePlanResiduals([], refuted)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.why.includes('refuted')))
  }
})

test('planAcceptContractLines names the existing residual field and vocabulary', () => {
  const text = planAcceptContractLines().join('\n')
  assert.match(text, /details\.residuals/)
  for (const type of RESIDUAL_TYPES) assert.match(text, new RegExp(type))
})

test('acceptContractLines lists findings and the typed residual/refutation instructions', () => {
  const findings = [
    { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'close this' },
    { id: 'RV1-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'consider this' },
  ]
  const lines = acceptContractLines(findings)
  const text = lines.join('\n')
  assert.ok(text.includes('- RV1-1 (must-fix) a.mjs:1 — close this'))
  assert.match(text, /residuals/)
  assert.match(text, /refuted/)
  assert.ok(lines.some((line) => /Refuting a must-fix[\s\S]*escalates to a human every time/i.test(line)))
  assert.ok(lines.some((line) => /refuted should-fix still accepts/i.test(line)))
  for (const finding of findings) assert.equal(text.split(finding.id).length - 1, 1)
  assert.deepEqual(acceptContractLines(null), [])
})

test('acceptBounceLines renders hostile entries without throwing and appends the contract', () => {
  let rendered
  assert.doesNotThrow(() => {
    acceptBounceLines(null, null)
    rendered = acceptBounceLines([{}, { id: 1 }, null], planAcceptContractLines()).join('\n')
  })
  for (const line of planAcceptContractLines()) {
    if (line !== '') assert.ok(rendered.includes(line), `missing contract line: ${line}`)
  }
  assert.match(rendered, new RegExp(`ACCEPT_REASKS = ${ACCEPT_REASKS}`))
})

test('the shared charter and validator agree on the findings contract', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = charter.indexOf('## Envelope details fields')
  const end = charter.indexOf('## Perspective assignments', start)
  assert.ok(start >= 0 && end > start)
  const block = charter.slice(start, end)
  for (const token of ['"findings"', '"id"', '"severity"']) assert.ok(block.includes(token))
  // #457: this slice used to stop AT '## Gate triage', so the gate-repair
  // custody sentence under that heading was pinned by nothing and survived
  // custody moving to the lead (#334/PR #348). The slice now covers it.
  assert.ok(block.includes('## Gate triage'), 'the charter slice must cover the gate-triage section')
  assert.ok(block.includes(`grants the **${GATE_CUSTODIAN}**`), 'the gate verdict must grant the repair to the gate custodian')
  assert.doesNotMatch(block, /grants the (\*\*)?planner\b/)
  const severityField = block.match(/"severity":\s*([^\n]+)/)?.[1]
  assert.ok(severityField)
  const documented = [...severityField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(documented, [...FINDING_SEVERITIES])
  const dispositionField = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(dispositionField)
  const dispositions = [...dispositionField.matchAll(/"([^\"]+)"/g)].map((match) => match[1])
  assert.deepEqual(dispositions, [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})

test("the reviewer guidelines carry a defended 'Do not flag' list", () => {
  const guidelines = readFileSync(new URL('./guidelines/review-do-not-flag.md', import.meta.url), 'utf8')
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const start = guidelines.search(/^## Do not flag$/m)
  assert.ok(start >= 0, 'the reviewer charter must carry a "Do not flag" section')
  const rest = guidelines.slice(start + '## Do not flag'.length)
  const end = rest.indexOf('\n## ')
  const section = end < 0 ? rest : rest.slice(0, end)
  const entries = section.split('\n').reduce((acc, line) => {
    if (/^[-*]\s+\*\*/.test(line)) acc.push([line])
    else if (acc.length) acc[acc.length - 1].push(line)
    return acc
  }, []).map((block) => block.join('\n'))
  assert.ok(entries.length >= 4, `expected at least 4 entries, found ${entries.length}`)
  // Every entry names the defense that makes its class safe not to flag, and
  // that defense points at something that exists — an ignore rule without one
  // is how a real finding gets suppressed.
  for (const entry of entries) {
    assert.match(entry, /Defense:/)
    assert.match(entry.slice(entry.indexOf('Defense:')), /crew\/[\w.-]+|files_in_scope|\.crew\/|#\d{2,}/)
  }
  assert.doesNotMatch(charter, /^## Do not flag$/m)
  assert.ok(charter.includes('crew/guidelines/review-do-not-flag.md'))
})

test('the lead charter documents the typed exhaustion accept contract', () => {
  const charter = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  for (const token of ['residuals', 'refuted', ...RESIDUAL_TYPES]) assert.ok(charter.includes(token), token)
  assert.match(charter, /code-refused/)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /the plan is a contract/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /not a statement about which stage/)
  assert.match(collapsed, /summary is REQUIRED there and is omitted from a keyed review-exhaustion claim/)
})

test('the planner charter documents how to discover files_in_scope', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  for (const token of [
    'every test that pins it',
    'crew/daemon.test.mjs',
    'crew/factoryctl.test.mjs',
    'crew/adapter-*.test.mjs',
    '#193',
    '#199',
    'dispatched surface is a CEILING',
    '`details.questions` entry rather than a wider `files_in_scope`',
  ]) assert.ok(charter.includes(token), token)
  assert.match(charter, /grep/i)
})

test('the planner charter tells the planner to grep the changed file’s own path', () => {
  const charter = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const discovery = charter.slice(charter.indexOf('Discover that list'), charter.indexOf('`gate_path` is required'))
  assert.ok(discovery.length > 0)
  assert.match(discovery, /own repo-relative path/)
  assert.match(discovery, /\.github\/workflows\/test\.yml/)
  assert.match(discovery, /test\/factory-ledger-floor\.test\.mjs/)
  assert.doesNotMatch(discovery, /production/)
})

// The file nobody pinned is the file that rotted: tech-lead.md carried the whole
// plan-check doctrine and no test read a byte of it (#698).
test('the tech-lead charter documents envelope custody and the residual it cannot type', () => {
  const charter = readFileSync(new URL('./roles/tech-lead.md', import.meta.url), 'utf8')
  for (const token of [
    'details.mutations', 'files_in_scope', 'details.residuals',
    'correctness-unverified', 'verdictOf', 'applyPrescriptionLines',
  ]) assert.ok(charter.includes(token), token)
  const collapsed = charter.replace(/\s+/g, ' ')
  assert.match(collapsed, /frozen at acceptance/)
  assert.match(collapsed, /not amendable after acceptance/)
  assert.match(collapsed, /VERDICT: revise[^.]*PRESCRIBES/)
  assert.match(collapsed, /correctness-unverified[^.]*code-refused/)
  assert.match(collapsed, /cannot type a residual/)
})

// Prose file:line citations are invisible to skills/*/anchors.json, so crew/roles/anchors.json
// pins the CONTENT each cited line of crew/drive.mjs must carry. A shape-only check could not
// tell a right line from a wrong one, and twice a build kept it green by deleting a blank line
// elsewhere to compensate for one it inserted (#743, #748, #747). The manifest and the prose are
// held to a bijection in both directions, so a citation added to one side alone fails here.
test('every crew/drive.mjs anchor the tech-lead charter cites resolves to the code it names', () => {
  const charterPath = join(REPO_ROOT, 'crew', 'roles', 'tech-lead.md')
  const charter = readFileSync(charterPath, 'utf8')
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'crew', 'roles', 'anchors.json'), 'utf8'))
  // Every charter in crew/roles, not only the tech-lead's: the manifest is directory-wide
  // and anchor-pin.mjs --repair crew/roles scans the same set, so a pin cited only by
  // planner.md or reviewer.md is a citation here, never an orphan.
  const rolesDir = join(REPO_ROOT, 'crew', 'roles')
  const docs = readdirSync(rolesDir).filter((name) => name.endsWith('.md')).sort().map((name) => join(rolesDir, name))
  const result = checkAnchors({ root: REPO_ROOT, docs, manifest })
  assert.ok(result.anchors >= 12, `expected at least 12 anchors, found ${result.anchors}`)
  assert.deepEqual(result.failures, [])
  const drifted = result.shifted.map((shift) => `${shift.key}: pinned ${JSON.stringify(manifest[shift.key])} is now at line ${shift.to}`)
  assert.deepEqual(drifted, [])
  // Both citation forms of the four anchors #698 found stale: the qualified
  // `crew/drive.mjs:2299` and the bare `:2226` continuation the file also used.
  for (const retired of [':2299', ':2226', ':2319', ':2217']) {
    assert.equal(charter.includes(retired), false, `retired anchor ${retired}`)
  }
})

test('skills are self-contained and verifiable on both vendors', () => {
  for (const name of SKILL_NAMES) {
    const dir = join(REPO_ROOT, '.agents', 'skills', name)
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(frontmatter, `${name} must have parseable frontmatter`)
    const fields = frontmatter[1]
    assert.equal(fields.match(/^name:\s*(\S+)\s*$/m)?.[1], name)
    const description = fields.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    assert.ok(description)
    assert.doesNotMatch(description, /\n/)
    const body = text.slice(frontmatter[0].length)
    const scripts = [...body.matchAll(/`[^`]*?([\w./-]*scripts\/[\w.-]+\.mjs)[^`]*`/g)].map((match) => match[1])
    assert.ok(scripts.length, `${name} must name a shipped scripts/*.mjs file`)
    for (const script of scripts) {
      const candidate = script.startsWith('.agents/') ? script : `.agents/skills/${name}/${script.replace(/^\.\//, '')}`
      assert.ok(existsSync(join(REPO_ROOT, candidate)), `missing ${candidate}`)
    }
    assert.ok(existsSync(join(dir, 'scripts')))
    const seat = body.slice(body.indexOf('## Verifying on a seat'))
    assert.match(seat, /\bpi\b/)
    assert.match(seat, /\bclaude\b/)
  }
})

test('the codemod stages before it applies and fails loudly without ast-grep', () => {
  const script = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/scripts/codemod.mjs')
  const fake = join(REPO_ROOT, '.agents/skills/ast-grep-codemod/test-fixtures/fake-ast-grep.mjs')
  const log = join(scratchDir('b19-drive-'), 'invocations.log')
  const stage = join(scratchDir('b19-stage-'), 'proposal.json')
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env },
  })
  const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const refused = run(['apply'], { AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage })
  assert.notEqual(refused.status, 0)
  assert.match(`${refused.stdout || ''}${refused.stderr || ''}`, /--resolve/)
  assert.equal(invocations(), 0)
  const proposed = run([
    'propose', '--pattern', 'driveProbe($A)', '--rewrite', 'driveProbed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n',
  })
  assert.equal(proposed.status, 0)
  assert.ok(invocations() >= 1)
  const failedProbeStage = join(scratchDir('b19-probe-failure-'), 'proposal.json')
  const failedProbe = run([
    'propose', '--pattern', 'probeFailure($A)', '--rewrite', 'probeFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProbeStage,
    FAKE_AST_GREP_VERSION_EXIT: '7',
  })
  assert.equal(failedProbe.status, 3)
  assert.equal(existsSync(failedProbeStage), false)
  const failedProposeStage = join(scratchDir('b19-propose-failure-'), 'proposal.json')
  const failedPropose = run([
    'propose', '--pattern', 'runFailure($A)', '--rewrite', 'runFailed($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: failedProposeStage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedPropose.status, 3)
  assert.equal(existsSync(failedProposeStage), false)
  const applyLog = `${stage}.log`
  const failedCheck = run(['apply', '--resolve', 'the check must still match'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_RUN_EXIT: '7',
  })
  assert.equal(failedCheck.status, 3)
  assert.equal(existsSync(applyLog), false)
  const failedUpdate = run(['apply', '--resolve', 'the update is approved'], {
    AST_GREP_BIN: fake, FAKE_AST_GREP_LOG: log, CODEMOD_STAGE: stage,
    FAKE_AST_GREP_DIFF: '@@ -1 +1 @@\n-old\n+new\n', FAKE_AST_GREP_UPDATE_EXIT: '7',
  })
  assert.equal(failedUpdate.status, 3)
  assert.equal(existsSync(applyLog), false)
  const missing = run([
    'propose', '--pattern', 'a($A)', '--rewrite', 'b($A)', '--lang', 'js', 'crew/roles/planner.md',
  ], { AST_GREP_BIN: '/nonexistent', CODEMOD_STAGE: join(scratchDir('b19-missing-'), 'proposal.json') })
  assert.equal(missing.status, 3)
  const missingOutput = `${missing.stdout || ''}${missing.stderr || ''}`
  assert.match(missingOutput, /ast-grep/)
  assert.match(missingOutput, /install/i)
})

test('the review-procedure loader prints repo guidelines without inlining judgment', () => {
  const loader = join(REPO_ROOT, '.agents/skills/review-procedure/scripts/load-guidelines.mjs')
  const guidelines = join(REPO_ROOT, 'crew/guidelines/review-do-not-flag.md')
  const result = spawnSync(process.execPath, [loader], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, readFileSync(guidelines, 'utf8'))
  const skill = readFileSync(join(REPO_ROOT, '.agents/skills/review-procedure/SKILL.md'), 'utf8')
  for (const smell of ['Defense:', 'Task-dir drift', 'Seeded from 49 archived runs']) assert.doesNotMatch(skill, new RegExp(smell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('implementation-file sections name existing files in both docs', () => {
  const docs = [
    ['docs/park-lease-protocol.md', ['crew/reclaim.mjs']],
    ['docs/conventions.md', ['crew/crew.mjs', 'crew/drive.mjs', 'crew/daemon.mjs']],
  ]
  for (const [rel, required] of docs) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8')
    const start = text.indexOf('## Implementation files')
    assert.ok(start >= 0, `${rel} must have an Implementation files section`)
    const rest = text.slice(start + '## Implementation files'.length)
    const end = rest.indexOf('\n## ')
    const section = end < 0 ? rest : rest.slice(0, end)
    const paths = [...section.matchAll(/`([\w./-]+\.(?:mjs|js|json|md|yml))`/g)].map((match) => match[1])
    assert.ok(paths.length)
    for (const path of paths) assert.ok(existsSync(join(REPO_ROOT, path)), `${path} must exist`)
    for (const path of required) assert.ok(paths.includes(path), `${rel} must name ${path}`)
  }
})

test('conventions disambiguates agent and seat as runtime under crew, not the model', () => {
  const text = readFileSync(join(REPO_ROOT, 'docs/conventions.md'), 'utf8')
  const line = text.split('\n').find((entry) => /\bagent\b/.test(entry) && /\bseat\b/.test(entry) && /crew\//.test(entry) && /not the model/i.test(entry))
  assert.ok(line)
})

test('happy path: plan -> build -> gates -> review pass -> suite -> commit, zero consults', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'] }, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.commit, 'abc1234')
  assert.equal(res.details.consults, 0)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'a.test.mjs'])
  assert.equal(io.calls.commits[0].message, 'crew(t1): planned\n\nfeat: the change')
  // suite ran exactly once, AFTER the lane
  assert.deepEqual(io.calls.run.map((r) => r.cmd), ['lane-cmd', 'suite-cmd'])
})

test('a red cold run escalates with its commit, paths, and cleanup diagnosis', () => {
  const io = closeoutIo({
    cold: { ok: false, output: 'cold failure\n', path: '/zz/coldpath', kept: '/zz/coldpath' },
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.match(result.details.escalation.why, /\/tmp\/repo/)
  assert.match(result.details.escalation.why, /\/zz\/coldpath/)
  assert.match(result.details.escalation.why, /git worktree remove --force/)
  assert.match(result.details.escalation.why, /which directory the suite ran in/)
})

test('a throwing cold runner escalates as unproven and preserves its reason', () => {
  const result = driveTask(CTX, closeoutIo({ cold: 'throw' }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.equal(result.details.cold_suite.verdict, 'unproven')
  assert.match(result.details.cold_suite.why, /injected cold runner failure/)
})

test('an io without a cold runner cannot reach done', () => {
  const result = driveTask(CTX, closeoutIo({ cold: null }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'cold-suite')
  assert.equal(result.details.commit, 'abc1234')
  assert.deepEqual(result.details.cold_suite, {
    verdict: 'unavailable', why: 'this io provides no runCold, so no cold checkout could be cut',
  })
})

test('a green cold run is reported separately and named in the done summary', () => {
  const result = driveTask(CTX, closeoutIo())
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.cold_suite, { verdict: 'green', path: '/zz/aa11bb', counts: null })
  assert.match(result.summary, /cold-verified from \/zz\/aa11bb/)
})

test('the cold runner receives lane first and task names exactly once', () => {
  const ctx = { ...CTX, task: 'zqtask7', laneName: 'zqlane5' }
  const io = closeoutIo()
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.runCold, [{ cmd: ctx.suite, names: ['zqlane5', 'zqtask7'] }])

  const noLane = closeoutIo()
  driveTask({ ...CTX, laneName: undefined }, noLane)
  assert.deepEqual(noLane.calls.runCold, [{ cmd: CTX.suite, names: [CTX.task] }])
})

test('the cold run follows commit and records suite:cold between commit and done', () => {
  const io = closeoutIo()
  const { calls } = io
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(calls.order.indexOf('commit') < calls.order.indexOf('runCold'))
  assert.deepEqual(result.details.stages.slice(-3), ['suite', 'suite:cold', 'done'])
})

test('scope helpers match directory prefixes and validate only supported entries', () => {
  const match = scopeMatcher(['tasks/x/captures/', 'crew/drive.mjs'])
  assert.equal(match('tasks/x/captures/1.md'), true)
  assert.equal(match('tasks/x/captures/deep/2.md'), true)
  assert.equal(match('crew/drive.mjs'), true)
  assert.equal(match('crew/crew.mjs'), false)
  assert.equal(match('tasks/x/other.md'), false)
  assert.deepEqual(validateScopeEntries(['tasks/x/captures/', 'crew/drive.mjs']), [])
  for (const entry of ['crew/', 'tasks/', '.', './', '/', '', 'crew/*.mjs', '*', '../x.mjs', '/abs/x.mjs']) {
    const [error] = validateScopeEntries([entry])
    assert.equal(error.entry, entry)
    assert.ok(error.why)
  }
})

test('protectedHits matches the ratified protected paths in both directions', () => {
  assert.deepEqual([...PROTECTED_PATHS].sort(), [
    '.github/workflows/', 'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/drive.mjs', 'crew/escalation-policy.mjs', 'crew/model-ladder.json',
    'crew/protected-paths.mjs', 'crew/reclaim.mjs', 'crew/variants.mjs',
    'crew/roster.json', 'crew/roster.schema.json', 'docs/adr/',
  ].sort())
  assert.equal(PROTECTED_PATHS.includes('crew/roles/'), false)
  assert.deepEqual(protectedHits([
    'docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/roles/planner.md', 'crew/crew.mjs', 'a.mjs', 'docs/adr/031.md',
    'crew/drive.mjs.bak', 'crew/roster.json.tmp',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json',
    'crew/model-ladder.json.bak',
  ]), ['docs/adr/031.md', '.github/workflows/test.yml', 'crew/drive.mjs', 'docs/adr/',
    'crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json'])
})

test('laneFenceHits names the owning lane and never inverts into an allow-list', () => {
  const fence = [{ lane: 'intake-loop', files: ['scripts/factory/', 'dir/owned.mjs'] }]
  assert.deepEqual(laneFenceHits([
    'scripts/factory/intake.mjs', 'dir/', 'dir/', 'unowned.mjs',
  ], fence), [
    { entry: 'scripts/factory/intake.mjs', lane: 'intake-loop' },
    { entry: 'dir/', lane: 'intake-loop' },
  ])
  assert.deepEqual(laneFenceHits(['unowned.mjs'], [{ lane: 'ignored', files: [] }]), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], undefined), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], []), [])
  assert.deepEqual(laneFenceHits(['scripts/factory/intake.mjs'], [{ lane: 'ignored' }]), [])
})

test("a plan whose files_in_scope crosses a live lane fence is a refusal at plan acceptance", () => {
  const file = 'scripts/factory/intake.mjs'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [file] } }),
    },
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: [file] }] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, new RegExp(file.replaceAll('/', '\\/')))
  assert.match(result.details.escalation.why, /intake-loop/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('the scope-gate catches a build that crossed another lane fence', () => {
  const file = 'scripts/factory/intake.mjs'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() },
    changed: [file],
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: [file] }] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /intake-loop/)
  assert.equal(io.calls.run.some(({ cmd }) => cmd === 'lane-cmd' || cmd === 'suite-cmd'), false)
  assert.equal(io.calls.commits.length, 0)
})

test('a path no lane owns crosses no fence', () => {
  const file = 'crew/roster-ladder.mjs'
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [file] } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [file],
  })
  const result = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }] }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(io.calls.commits[0].files, [file])
})

test('an unfenced ctx.laneFence leaves the run exactly as today', () => {
  const input = {
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  }
  const fencedIo = fakeIo(input)
  const plainIo = fakeIo(input)
  const fenced = driveTask({ ...CTX, laneFence: [{ lane: 'intake-loop', files: ['scripts/factory/intake.mjs'] }] }, fencedIo)
  const plain = driveTask(CTX, plainIo)
  assert.equal(fenced.status, plain.status)
  assert.deepEqual(fencedIo.calls.run, plainIo.calls.run)
  assert.deepEqual(fencedIo.calls.commits, plainIo.calls.commits)
})

test('the closed variant set lives in the import-free leaf and drive re-exports it', () => {
  const driveSource = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const variantsSource = readFileSync(new URL('./variants.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(driveSource, /export const VARIANTS/)
  assert.match(driveSource, /export \{ VARIANTS, VARIANT_NAMES, DEFAULT_VARIANT \} from '\.\/variants\.mjs'/)
  assert.doesNotMatch(variantsSource, /^\s*import[\s(]/m)
  assert.deepEqual(Object.keys(VARIANTS), [...VARIANT_NAMES])
})

test('the protected-path floor lives in the import-free leaf and drive re-exports it', async () => {
  const driveSource = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const leafSource = readFileSync(new URL('./protected-paths.mjs', import.meta.url), 'utf8')
  const leaf = await import('./protected-paths.mjs')
  assert.doesNotMatch(leafSource, /^\s*import[\s(]/m)
  assert.doesNotMatch(driveSource, /export const PROTECTED_PATHS/)
  assert.match(driveSource, /export \{ PROTECTED_PATHS, resolveProtectedPaths \} from '\.\/protected-paths\.mjs'/)
  assert.equal(PROTECTED_PATHS, leaf.PROTECTED_PATHS)
})

test('a per-repo protected-path list adds to the floor and can never shrink it', () => {
  const additions = resolveProtectedPaths(['./db\\migrations\\', 'db/migrations/'])
  assert.ok(additions.includes('db/migrations/'))
  for (const path of PROTECTED_PATHS) assert.ok(additions.includes(path), `${path} was removed`)
  assert.equal(resolveProtectedPaths(), PROTECTED_PATHS)
  assert.throws(() => resolveProtectedPaths('db/migrations/'))
  assert.throws(() => resolveProtectedPaths(['  ']))
})

test('ctx.protectedPaths extends the sensitivity floor without replacing it', () => {
  const extraIo = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(['db/migrations/']), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['db/migrations/001.sql'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const extra = driveTask({ ...CTX, protectedPaths: ['db/migrations/'] }, extraIo)
  assert.equal(extra.status, 'done')
  assert.equal(extraIo.calls.reseat.length, 1)

  const floorIo = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const floor = driveTask({ ...CTX, protectedPaths: ['.github/workflows/', 'docs/adr/', 'package-lock.json'] }, floorIo)
  assert.equal(floor.status, 'done')
  assert.equal(floorIo.calls.reseat.length, 1)
})

test('the crew policy artifacts escalate at plan acceptance exactly like the roster', () => {
  for (const path of ['crew/capabilities.json', 'crew/capabilities.schema.json', 'crew/model-ladder.json', 'crew/roster.json']) {
    const refusingIo = fakeIo({
      envelopes: { 'planner:1': protectedPlanEnv([path]) },
      reseat: protectedReseatRefusal,
    })
    const refusal = driveTask(CTX, refusingIo)
    assert.equal(refusal.status, 'escalation')
    assert.equal(refusal.details.escalation.where, 'sensitivity-floor')
    assert.ok(refusal.details.escalation.why.includes(path))
    assert.equal(refusingIo.calls.assign.filter(({ role }) => role === 'builder').length, 0)

    const applyingIo = fakeIo({
      envelopes: { 'planner:1': protectedPlanEnv([path]), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: [path],
      reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
    })
    const applied = driveTask(CTX, applyingIo)
    assert.equal(applied.status, 'done')
    assert.equal(applyingIo.calls.reseat.length, 1)
  }
})

test('directory-prefix scope commits concrete changed paths without a scope bounce', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['tasks/x/captures/', 'a.mjs'] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'tasks/x/captures/1.md', 'tasks/x/captures/2.md'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'tasks/x/captures/1.md', 'tasks/x/captures/2.md'])
  assert.deepEqual(res.details.files_committed, io.calls.commits[0].files)
})

test('unsupported scope entries escalate before assigning a builder', () => {
  for (const entry of ['crew/', 'crew/*.mjs']) {
    const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: [entry, 'a.mjs'] } }) } })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'escalation')
    assert.ok(res.details.escalation.why.includes(entry))
    assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0)
  }
})

const protectedPlanEnv = (files = ['crew/drive.mjs']) => planEnv({
  details: { ...planEnv().details, files_in_scope: files },
})

const protectedReseatRefusal = () => ({ applied: false, reason: 'transport', why: 'pane seat refuses a targeted reseat', from: null })

test('protected scope plus a refusing reseat escalates before assigning a builder', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv() },
    reseat: protectedReseatRefusal,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'sensitivity-floor')
  assert.match(res.details.escalation.why, /crew\/drive\.mjs/)
  assert.match(res.details.escalation.why, /sensitivity floor/i)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
  assert.equal(res.details.stages.some((label) => label.startsWith('review')), false)
})

test('every refusing sensitivity floor firing records and emits one closed modifier attempt', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': protectedPlanEnv() },
    reseat: protectedReseatRefusal,
  })
  const res = driveTask(CTX, io)
  const rows = res.details.modifiers.filter(({ modifier }) => modifier === SENSITIVITY_FLOOR)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'reviewer')
  assert.ok(MODIFIER_OUTCOMES.includes(rows[0].outcome))
  assert.notEqual(rows[0].outcome, 'applied')
  assert.deepEqual(io.calls.emits.filter(({ kind, modifier }) => kind === 'modifier' && modifier === SENSITIVITY_FLOOR).length, 1)
})

test('protected scope plus an applied sensitivity floor proceeds with one judge request', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.reseat, [{ role: 'reviewer', options: { reason: SENSITIVITY_FLOOR, tier: JUDGE_TIER } }])
  assert.deepEqual(res.details.modifiers.filter(({ modifier }) => modifier === SENSITIVITY_FLOOR).map(({ outcome }) => outcome), ['applied'])
})

test('an already seated judge reviewer satisfies the sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => ({ applied: true, already: true, from: { id: 'judge' }, to: { id: 'judge' }, rung: 'judge→judge' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = res.details.modifiers.find(({ modifier }) => modifier === SENSITIVITY_FLOOR)
  assert.equal(row.outcome, 'applied')
  assert.match(row.why, /already the judge tier cell/)
})

test('clean scope does not fire the sensitivity floor or alter the happy-path stages', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.equal(io.calls.reseat.length, 0)
  assert.deepEqual(res.details.modifiers, [])
  assert.deepEqual(io.calls.emits.filter(({ kind }) => kind === 'modifier'), [])
  assert.equal(res.details.stages.some((label) => label.startsWith('escalate')), false)
})

test('sensitivity-floor recording remains non-load-bearing when modifier log and emit fail', () => {
  const input = {
    envelopes: { 'planner:1': protectedPlanEnv() },
    reseat: protectedReseatRefusal,
  }
  const quietIo = fakeIo(input)
  const noisyIo = fakeIo(input)
  const quietLog = noisyIo.log
  noisyIo.log = (entry) => {
    if (entry.modifier) throw new Error('journal unavailable')
    quietLog(entry)
  }
  noisyIo.emit = () => { throw new Error('ledger unavailable') }
  const quiet = driveTask(CTX, quietIo)
  const noisy = driveTask(CTX, noisyIo)
  assert.deepEqual({ status: noisy.status, stages: noisy.details.stages, why: noisy.details.escalation.why }, {
    status: quiet.status, stages: quiet.details.stages, why: quiet.details.escalation.why,
  })
})

test('the sensitivity floor has its own budget and does not spend failure-upgrade', () => {
  const outcomes = [
    { applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' },
    { applied: true, from: { id: 'old' }, to: { id: 'new' }, rung: 'mechanical→build' },
  ]
  const io = fakeIo({
    envelopes: { 'planner:1': protectedPlanEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['crew/drive.mjs'],
    reseat: () => outcomes.shift(),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ modifier, outcome }) => ({ modifier, outcome })), [
    { modifier: SENSITIVITY_FLOOR, outcome: 'applied' },
    { modifier: FAILURE_UPGRADE, outcome: 'applied' },
  ])
  assert.equal(io.calls.reseat.length, 2)
  assert.equal(io.calls.reseat[1].options.reason, 'lane-bounce')
})

test('composeCommitMessage uses the plan subject, builder body, and ordered issue refs', () => {
  const msg = composeCommitMessage({
    task: 'hygiene',
    planEnv: { summary: 'whole change', details: { commit_subject: 'fix(crew): runtime', issues: [112, '114', '#117', 'bad', '#112'] } },
    builderEnv: { summary: 'ignored', details: { commit_message: 'test: repair the lane assertion' } },
  })
  assert.equal(msg, 'fix(crew): runtime\n\ntest: repair the lane assertion\n\nRefs: #112, #114, #117')
  assert.equal(composeCommitMessage({ task: 'x', planEnv: { summary: 'plan', details: {} }, builderEnv: { details: { commit_message: 'crew(x): plan' } } }), 'crew(x): plan')
  assert.doesNotMatch(composeCommitMessage({ task: 'x', planEnv: { summary: 'plan', details: {} }, builderEnv: { details: { commit_message: 'body' } } }), /Refs:/)
})

test('red lane bounces the builder with the failure output, then green -> done', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'reviewer:1': reviewEnv('pass'),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
    },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL x' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const builderAssigns = io.calls.assign.filter((a) => a.role === 'builder')
  assert.equal(builderAssigns.length, 2)
  const bounceBrief = io.calls.writes[builderAssigns[1].briefFile]
  assert.match(bounceBrief, /RED/)
  assert.match(bounceBrief, /FAIL x/)
  assert.equal(res.details.consults, 0) // mechanical bounce, no lead needed
})

test('a lane bounce records an applied failure-upgrade on the envelope and journal', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    emit: true,
    reseat: () => ({ applied: true, from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers, [{
    modifier: FAILURE_UPGRADE, kind: 'lane', role: 'builder', outcome: 'applied',
    from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build',
  }])
  assert.equal(io.calls.reseat.length, 1)
  assert.ok(io.calls.logs.some((line) => line.modifier?.modifier === FAILURE_UPGRADE))
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [{
    kind: 'modifier', modifier: FAILURE_UPGRADE, bounce: 'lane', role: 'builder', outcome: 'applied',
    why: null, from: { id: 'old', effort: 'medium' }, to: { id: 'new', effort: 'max' }, rung: 'mechanical→build',
  }])
})

test('a refused reseat emits one transport modifier attempt without a to cell', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'transport', why: 'headless seat cannot re-seat', from: { id: 'old', effort: 'max' } }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [{
    kind: 'modifier', modifier: FAILURE_UPGRADE, bounce: 'lane', role: 'builder', outcome: 'transport',
    why: 'headless seat cannot re-seat', from: { id: 'old', effort: 'max' }, to: null, rung: null,
  }])
})

test('a run without a bounce emits no modifier attempts', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'modifier'), [])
})

test('throwing on modifier emission leaves stages, commit, and status unchanged', () => {
  const input = {
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL lane' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'transport', why: 'refused' }),
  }
  const plain = driveTask(CTX, fakeIo(input))
  const noisy = driveTask(CTX, fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } }))
  assert.deepEqual({ stages: noisy.details.stages, commit: noisy.details.commit, status: noisy.status }, {
    stages: plain.details.stages, commit: plain.details.commit, status: plain.status,
  })
})

test('a second bounce records spent and never calls reseat again', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['applied', 'spent'])
  assert.equal(io.calls.reseat.length, 1)
})

// The budget is spent by an APPLIED upgrade, never by a refused attempt. The
// mutation this kills: moving `upgradeSpent = true` back above the io.reseat
// call, which is what the factory's own boot shape would have hit — builder and
// reviewer are headless-rpc seats that refuse, so a refused builder bounce would
// have burned the budget the planner's headless-json seat could still have used.
test('a refused reseat does not spend the budget, and a later bounce can still apply', () => {
  const outcomes = [
    { applied: false, reason: 'transport', why: 'a headless-rpc seat reads its cell once at worker spawn' },
    { applied: true, from: { id: 'old', effort: 'medium' }, to: { id: 'old', effort: 'max' }, rung: 'mechanical→build' },
  ]
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => outcomes.shift(),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['transport', 'applied'])
  assert.equal(io.calls.reseat.length, 2)
})

// An io with no reseat method cannot grow one mid-run, so that fact is recorded
// once rather than once per bounce. Mutation killed: dropping the spend on the
// no-method branch, which would repeat the same entry for every later bounce.
test('an io with no reseat records the fact once, not once per bounce', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'lane-cmd:1': { ok: false, output: 'FAIL one' }, 'lane-cmd:2': { ok: false, output: 'FAIL two' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  delete io.reseat
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers.map(({ outcome }) => outcome), ['transport', 'spent'])
})

test('a plan bounce spends the failure upgrade for the planner', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous' }),
      'lead:1': leadEnv('bounce'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: false, reason: 'exhausted', why: 'top rung', from: null }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.modifiers[0], {
    modifier: FAILURE_UPGRADE, kind: 'plan', role: 'planner', outcome: 'exhausted', why: 'top rung', from: null,
  })
  assert.deepEqual(io.calls.reseat[0].role, 'planner')
})

test('an io without reseat records transport without changing the bounce loop', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.modifiers.length, 1)
  assert.equal(res.details.modifiers[0].outcome, 'transport')
  assert.match(res.details.modifiers[0].why, /no reseat/)
})

test('a throwing reseat is recorded as transport and never escapes driveTask', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => { throw new Error('reseat exploded') },
  })
  let res
  assert.doesNotThrow(() => { res = driveTask(CTX, io) })
  assert.equal(res.status, 'done')
  assert.equal(res.details.modifiers[0].outcome, 'transport')
  assert.match(res.details.modifiers[0].why, /reseat exploded/)
})

test('failure-upgrade refusals preserve closed reasons and normalize unknown reasons', () => {
  const run = (result) => driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], reseat: () => result,
  }))
  for (const reason of ['exhausted', 'no-tier', 'agent-change']) {
    const res = run({ applied: false, reason, why: `${reason} refusal`, from: null })
    assert.equal(res.details.modifiers[0].outcome, reason)
  }
  const normalized = run({ applied: false, reason: 'banana', why: 'unknown', from: null })
  assert.equal(normalized.details.modifiers[0].outcome, 'transport')
  assert.ok(MODIFIER_OUTCOMES.includes(normalized.details.modifiers[0].outcome))
})

test('failure-upgrade is neutral to the task envelope apart from its record', () => {
  const run = (reseat) => driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd:1': { ok: false, output: 'FAIL' }, 'lane-cmd:2': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], ...(reseat ? { reseat } : {}),
  }))
  const strip = (result) => {
    const out = JSON.parse(JSON.stringify(result))
    delete out.details.modifiers
    return out
  }
  const plain = run(null)
  const throwing = run(() => { throw new Error('boom') })
  const applying = run(() => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }))
  assert.deepEqual(strip(throwing), strip(plain))
  assert.deepEqual(strip(applying), strip(plain))
})

test('an escalation carries failure-upgrade modifiers', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'lead:1': leadEnv('escalate') },
    runs: { 'lane-cmd': { ok: false, output: 'FAIL forever' } },
    changed: ['a.mjs', 'a.test.mjs'],
    reseat: () => ({ applied: true, from: {}, to: {}, rung: 'mechanical→build' }),
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.ok(res.details.modifiers.length >= 1)
  assert.equal(res.details.modifiers[0].modifier, FAILURE_UPGRADE)
})

test('bounced lane run commits the planner subject, round-2 builder body, and issue refs', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, commit_subject: 'fix(crew): three crew-runtime defects', issues: [112, 114, 117] } }),
      'builder:1': buildEnv({ details: { ...buildEnv().details, commit_message: 'wip: initial attempt' } }),
      'builder:2': buildEnv({ details: { ...buildEnv().details, commit_message: 'test: repair the lane assertion' } }),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'RED' }, 'lane-cmd:2': { ok: true, output: '' },
      'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  const message = io.calls.commits[0].message
  assert.equal(message.split('\n')[0], 'fix(crew): three crew-runtime defects')
  assert.match(message, /test: repair the lane assertion/)
  assert.match(message, /#112/)
  assert.doesNotMatch(message, /wip: initial attempt/)
})

test('out-of-scope edits bounce mechanically naming the offending files', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'reviewer:1': reviewEnv('pass'),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['a.mjs', 'rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /OUTSIDE the plan/.test(w))
  assert.ok(bounce, 'expected a scope bounce brief')
  assert.match(bounce, /rogue\.mjs/)
})

test('review changes-needed bounces the builder, second review passes', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.match(Object.values(io.calls.writes).find((w) => /Review bounce/.test(w)), /review\.md/)
})

test('a passing verify round is free while the changes-needed round is charged', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(
    io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round),
    [
      { n: 1, verdict: 'changes-needed', accounting: 'counted', charged: 1 },
      { n: 2, verdict: 'pass', accounting: 'free', charged: 1 },
    ],
  )
})

test('a re-review that surfaces NEW must-fixes is charged like any other', () => {
  const firstFindings = [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'the original defect', hardening: 'ungateable', hardening_why: 'legacy charging fixture' }]
  const secondFindings = [{ id: 'RV2-1', severity: 'must-fix', location: 'a.mjs:9', summary: 'a NEW defect the fix introduced', hardening: 'ungateable', hardening_why: 'legacy charging fixture' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', firstFindings),
      'reviewer:2': reviewEnv('changes-needed', secondFindings),
      'lead:1': leadEnv('accept'),
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const rounds = io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].accounting, 'counted')
  assert.equal(rounds[0].charged, 1)
  assert.equal(rounds[1].accounting, 'counted')
  assert.equal(rounds[1].charged, 2)
})

test('review exhaustion on a revise-revise sequence is unchanged', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  const want = 'Review rounds are exhausted (2) and the last verdict was revise. Grant one more review/build round, accept with residuals, or escalate?'
  assert.ok(io.calls.writes[`${TD}/decision-1.md`].includes(want))
  assert.equal(res.details.consults, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

test('an unreadable verdict is charged nothing and reuses its round number', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'unknown-shape', review_path: `${TD}/review.md` } },
      'lead:1': leadEnv('bounce'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.deepEqual(
    io.calls.logs.filter((r) => r.review_round).map((r) => r.review_round),
    [
      { n: 1, verdict: 'unknown-shape', accounting: 'free', charged: 0 },
      { n: 1, verdict: 'pass', accounting: 'free', charged: 0 },
    ],
  )
})

test('the plan-revision brief names the check and says to apply it verbatim', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': planEnv(), 'tech-lead:2': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  const brief = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(brief.startsWith('# Plan revision (round 1)'))
  assert.ok(brief.includes('plan-check.md'))
  assert.match(brief, /verbatim/)
  assert.match(brief, /do not re-derive/)
})

test('the granted plan-revision bounce carries the same instruction', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('approve'),
      'lead:1': leadEnv('bounce'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.match(io.calls.writes[`${TD}/plan-bounce-r2.md`], /do not re-derive/)
})

test('the review bounce brief tells the builder to apply the review verbatim', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const brief = io.calls.writes[`${TD}/build-bounce-r1.md`]
  assert.ok(brief.startsWith('# Review bounce (round 1)'))
  assert.match(brief, /review\.md/)
  assert.match(brief, /Plan:/)
  assert.match(brief, /do not re-derive/)
  assert.equal(applyPrescriptionLines('the review')[0], '')
  assert.match(applyPrescriptionLines('the review').join('\n'), /the review PRESCRIBED, verbatim/)
})

test('planner insufficient -> lead consult; bounce with guidance lands in the bounce brief', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }),
      'lead:1': leadEnv('bounce', 'the brief means X not Y; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  const bounce = Object.values(io.calls.writes).find((w) => /Plan bounce/.test(w))
  assert.match(bounce, /plan for X/)
})

test('planner questions make one consult and carry keyed answers into one bounce', () => {
  const questions = [
    { id: 'q1', question: 'Does X mean A or B?' },
    { id: 'q2', question: 'Where does Y live?' },
    { id: 'q3', question: 'Is Z in scope?' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps in the brief', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer the planner', { answers: [
        { id: 'q1', answer: 'X means A' }, { id: 'q3', answer: 'Z is out' },
      ] }),
      'planner:2': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  for (const question of questions) {
    assert.ok(decision.includes(question.id))
    assert.ok(decision.includes(question.question))
  }
  assert.ok(decision.includes('details.answers'))
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(bounce.includes('q1: Does X mean A or B?'))
  assert.ok(bounce.includes('ANSWER: X means A'))
  assert.ok(bounce.includes('q3: Is Z in scope?'))
  assert.ok(bounce.includes('ANSWER: Z is out'))
  assert.ok(bounce.includes('q2: Where does Y live?'))
  assert.ok(bounce.includes('UNANSWERED'))
  assert.ok(io.calls.logs.some((entry) => entry.member_questions?.role === 'planner' && entry.member_questions.total === 3))
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['q2'])
})

test('builder questions make one consult and carry keyed answers into one build bounce', () => {
  const questions = [
    { id: 'b1', question: 'Which helper should change?' },
    { id: 'b2', question: 'Which test should cover it?' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'plan gap', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer the builder', { answers: [{ id: 'b2', answer: 'crew/drive.test.mjs' }] }),
      'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  for (const question of questions) {
    assert.ok(decision.includes(question.id))
    assert.ok(decision.includes(question.question))
  }
  const bounce = io.calls.writes[`${TD}/build-bounce-r1.md`]
  assert.ok(bounce.includes('b2: Which test should cover it?'))
  assert.ok(bounce.includes('ANSWER: crew/drive.test.mjs'))
  assert.ok(bounce.includes('b1: Which helper should change?'))
  assert.ok(bounce.includes('UNANSWERED'))
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['b1'])
})

test('questionless planner and builder bounces remain byte-identical', () => {
  const plannerIo = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'planner stuck', details: {} }),
      'lead:1': leadEnv('bounce', 'steer'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, plannerIo).status, 'done')
  assert.equal(plannerIo.calls.writes[`${TD}/plan-bounce-r1.md`], `# Plan bounce (round 1)\n\nsteer\n\nOriginal brief: ${CTX.briefFile}\nPlanner said: planner stuck`)
  assert.doesNotMatch(plannerIo.calls.writes[`${TD}/decision-1.md`], /## The planner returned/)

  const builderIo = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv({ status: 'insufficient', summary: 'builder stuck', details: {} }),
      'lead:1': leadEnv('bounce', 'steer'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, builderIo).status, 'done')
  assert.equal(builderIo.calls.writes[`${TD}/build-bounce-r1.md`], `# Build bounce (round 1)\n\nsteer\n\nPlan: ${TD}/plan.md`)
})

test('malformed-only questions preserve the bounce and journal rejections', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps in the brief', details: { questions: [{ question: 'no id' }, 'garbage', { id: '  ' }] } }),
      'lead:1': leadEnv('bounce', 'steer'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.writes[`${TD}/plan-bounce-r1.md`], `# Plan bounce (round 1)\n\nsteer\n\nOriginal brief: ${CTX.briefFile}\nPlanner said: gaps in the brief`)
  assert.ok(io.calls.logs.some((entry) => entry.member_questions?.rejected?.length === 3))
})

test('omitted answers keep the bounce outcome and mark every id UNANSWERED', () => {
  const questions = [{ id: 'q1', question: 'first?' }, { id: 'q2', question: 'second?' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'gaps', details: { questions } }),
      'lead:1': leadEnv('bounce', 'steer', { answers: [] }), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.ok(bounce.includes('q1: first?'))
  assert.ok(bounce.slice(bounce.indexOf('q1: first?')).includes('UNANSWERED'))
  assert.ok(bounce.includes('q2: second?'))
  assert.ok(bounce.slice(bounce.indexOf('q2: second?')).includes('UNANSWERED'))
  assert.doesNotMatch(bounce, /ANSWER:/)
  assert.deepEqual(io.calls.logs.find((entry) => entry.question_answers)?.question_answers.unanswered, ['q1', 'q2'])
})

test('charters pin the batched question and keyed answer conventions', () => {
  const shared = readFileSync(new URL('./roles/_shared.md', import.meta.url), 'utf8')
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  const builder = readFileSync(new URL('./roles/builder.md', import.meta.url), 'utf8')
  for (const token of ['"questions"', '"id"', '"question"']) assert.ok(shared.includes(token))
  assert.match(shared, /one round instead of one round per gap/i)
  const cap = shared.match(/at most ([0-9]+) questions/)
  assert.equal(Number(cap?.[1]), MAX_QUESTIONS)
  for (const token of ['"answers"', '"answer"', 'UNANSWERED']) assert.ok(lead.includes(token))
  assert.ok(planner.includes('status: insufficient') && planner.includes('details.questions'))
  assert.ok(builder.includes('insufficient') && builder.includes('details.questions'))
})

test('lead answering outside the offered options is treated as escalate', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': leadEnv('proceed-anyway'), // not an offered option
    },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /treating as escalate/)
})

test('lead timeout (no envelope) on a consult throws toward escalation, never silent progress', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': null },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /lead: no valid envelope/)
})

test('an arrived but invalid envelope emits unusable-envelope before the driver escalates', () => {
  const io = fakeIo({ emit: true, envelopes: { 'planner:1': { status: 'done', role: 'not-planner' } } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope/)
  assert.ok(io.calls.emits.some((event) => event.kind === 'cell-failure' && event.failure === 'unusable-envelope'))
})

test('a null envelope is not double-counted by the driver', () => {
  const io = fakeIo({ emit: true, envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope/)
  assert.equal(io.calls.emits.filter((event) => event.kind === 'cell-failure').length, 0)
})

test('review rounds exhausted + lead accepts -> commit proceeds with residuals', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1)
  assert.equal(io.calls.commits.length, 1)
})

test('review rounds exhausted + lead escalates -> escalation envelope, NO commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

const ACCEPT_FINDINGS = [
  { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'load-bearing defect', hardening: 'ungateable', hardening_why: 'legacy accept fixture' },
  { id: 'RV1-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'cosmetic follow-up' },
]
const ACCEPT_FINDINGS_SOFT = [
  { id: 'RV1-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'cosmetic follow-up' },
]
const MUST_FIX_REFUTATION_FINDINGS = [
  { id: 'RV2-1', severity: 'must-fix', location: 'src/panel.svelte:41', summary: 'duplicate key in a keyed each', hardening: 'ungateable', hardening_why: 'legacy refutation fixture' },
]
const REFUTATION_CLAIM = 'the reviewer is wrong: row.reason is unique within a group, so the keyed each cannot collide at render'
const REFUTATION_CONVERGE_PLAN = () => planEnv({
  details: { ...planEnv().details, gate_cmd: 'gate-cmd', commit_subject: 'feat: converge' },
})
const REFUTATION_CONVERGE_RUNS = {
  'gate-cmd:1': { ok: false, output: `baseline red\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":0}` },
  'gate-cmd': { ok: true, output: `all checks passed\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
  'lane-cmd': { ok: true, output: '' },
  'suite-cmd': { ok: true, output: '' },
}

function exhaustionAcceptIo(details = {}, options = {}, findings = ACCEPT_FINDINGS, plan = planEnv()) {
  return fakeIo({
    envelopes: {
      'planner:1': plan,
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', findings),
      'reviewer:2': reviewEnv('changes-needed', findings),
      'lead:1': leadEnv('accept', 'because these are bounded residuals', details),
      'lead:2': leadEnv('accept', 'because these are bounded residuals', details),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    ...options,
  })
}

const CLOBBER_R2 = [{ id: 'RV9-1', severity: 'should-fix', location: 'c.mjs:3', summary: 'a different set entirely' }]

// r1 always raises ACCEPT_FINDINGS; r2 is whatever the direction under test needs.
function twoRoundReviewIo(round2Findings, accept, options = {}) {
  return fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'reviewer:2': reviewEnv('changes-needed', round2Findings),
      'lead:1': leadEnv('accept', 'because', accept),
      'lead:2': leadEnv('accept', 'because', accept),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    ...options,
  })
}

test('a findings-less later round leaves the canonical accept contract intact', () => {
  const io = twoRoundReviewIo(undefined, {})
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  assert.ok(res.details.accepted_via == null)
  const record = res.details.accept_decision
  assert.equal(record.findings_total, 2)
  for (const id of ['RV1-1', 'RV1-2']) {
    assert.ok(record.errors.some((error) => error.id === id && error.why === 'omitted id'))
  }
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /RV1-1 \(must-fix\)/)
  assert.match(brief, /For an accept, name every listed finding exactly once/)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 1)
  assert.equal(io.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
})

test('a findings-carrying later round replaces the canonical accept contract', () => {
  const io = twoRoundReviewIo(CLOBBER_R2, { residuals: [{ id: 'RV9-1', type: 'cosmetic' }], refuted: [] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  const record = io.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(record.findings_total, 1)
  assert.equal(record.outcome, 'accepted')
})

test('the superseded round-1 findings are not shown in the round-2 contract', () => {
  const io = twoRoundReviewIo(CLOBBER_R2, { residuals: [{ id: 'RV9-1', type: 'cosmetic' }], refuted: [] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(brief, /RV9-1 \(should-fix\)/)
  assert.doesNotMatch(brief, /RV1-1/)
  assert.doesNotMatch(brief, /RV1-2/)
})

test('an empty findings array is a report and replaces the set; an absent key is not', () => {
  const absentIo = twoRoundReviewIo(undefined, {})
  const absent = driveTask(CTX, absentIo)
  const emptyIo = twoRoundReviewIo([], { residuals: [], refuted: [] })
  const empty = driveTask(CTX, emptyIo)
  assert.equal(absent.status, 'escalation')
  assert.equal(absentIo.calls.commits.length, 0)
  assert.equal(empty.status, 'done')
  assert.equal(emptyIo.calls.commits.length, 1)
  const record = emptyIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(record.findings_total, 0)
  assert.equal(record.outcome, 'accepted')
})

test('reviewOutcome distinguishes an absent findings key from an empty array', () => {
  const withoutFindings = reviewOutcome('reviewer', reviewEnv('changes-needed'))
  assert.equal('findings' in withoutFindings, false)
  const withFindings = reviewOutcome('reviewer', reviewEnv('changes-needed', []))
  assert.deepEqual(withFindings.findings, [])
  assert.equal(withFindings.findings_report.total, 0)
})

test('the same rule holds at build exhaustion', () => {
  const io = twoRoundReviewIo(undefined, {})
  const res = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 3 } }, io)
  assert.equal(res.details.accept_decision.where, 'build-exhausted')
  assert.equal(res.details.accept_decision.findings_total, 2)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

test('valid typed accept at review exhaustion commits with a should-fix refutation', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'the reviewer mistook a test fixture for runtime code' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.match(res.details.accepted_via, /residuals/)
  assert.equal(io.calls.commits.length, 1)
})

test('the viz-intake incident replays as an escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true }, MUST_FIX_REFUTATION_FINDINGS)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.match(res.details.escalation.why, /RV2-1/)
  assert.match(res.details.escalation.why, /row\.reason is unique within a group/)
  assert.equal(io.calls.commits.length, 0)
})

test('the build-exhaustion must-fix refusal bypasses convergence', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true, runs: REFUTATION_CONVERGE_RUNS }, MUST_FIX_REFUTATION_FINDINGS, REFUTATION_CONVERGE_PLAN())
  const res = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.match(res.details.escalation.why, /RV2-1/)
  assert.match(res.details.escalation.why, /row\.reason is unique within a group/)
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('the refused decision is recorded valid, not malformed', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, {}, MUST_FIX_REFUTATION_FINDINGS)
  const res = driveTask(CTX, io)
  const record = res.details.accept_decision
  assert.deepEqual(record.errors, [])
  assert.equal(record.outcome, 'escalated')
  assert.deepEqual(record.refuted_must_fix, ['RV2-1'])
  assert.equal(record.refuted[0].evidence, REFUTATION_CLAIM)
})

test('a refuted must-fix is a judgement and is never re-asked', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: 'the must-fix is not a real defect' }],
  }, {}, MUST_FIX_REFUTATION_FINDINGS)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'refuted-must-fix')
  assert.equal(result.details.accept_decision.refusal, 'judgment')
  assert.equal(result.details.accept_decision.reasked, 0)
  assert.equal(Object.keys(io.calls.writes).filter((path) => /\/decision-\d+-reask\d+\.md$/.test(path)).length, 0)
})

test('refutation evidence is bounded', () => {
  const findings = [{ id: 'RV2-1', severity: 'should-fix' }]
  const long = `${'x'.repeat(REFUTATION_EVIDENCE_MAX)}TAIL`
  const bounded = validateAcceptDecision({
    findings, residuals: [], refuted: [{ id: 'RV2-1', evidence: long }],
  })
  assert.equal(bounded.refuted[0].evidence.length, REFUTATION_EVIDENCE_MAX)
  assert.equal(bounded.refuted[0].evidence.endsWith('…'), true)
  const short = validateAcceptDecision({
    findings, residuals: [], refuted: [{ id: 'RV2-1', evidence: '  a short claim  ' }],
  })
  assert.equal(short.refuted[0].evidence, 'a short claim')
})

test('a refuted should-fix still accepts', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'the reviewer mistook a test fixture for runtime code' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
})

test('accepted_via states what the record contains', () => {
  const shouldFixIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const shouldFix = driveTask(CTX, shouldFixIo)
  assert.match(shouldFix.details.accepted_via, /0 residuals and 1 refutation/)

  const mixedFindings = [
    { id: 'RV2-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'first' },
    { id: 'RV2-2', severity: 'should-fix', location: 'b.mjs:2', summary: 'second' },
  ]
  const mixedIo = exhaustionAcceptIo({
    residuals: [{ id: 'RV2-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV2-2', evidence: 'not real' }],
  }, {}, mixedFindings)
  const mixed = driveTask(CTX, mixedIo)
  assert.match(mixed.details.accepted_via, /1 residual and 1 refutation/)

  const buildIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, {}, ACCEPT_FINDINGS_SOFT)
  const build = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, buildIo)
  assert.match(build.details.accepted_via, /\(build rounds exhausted\)$/)
})

test('the accept re-ask does not spend a lead consult', () => {
  const bouncingIo = planCheckAcceptIo(
    { refuted: [{ id: 'C1', evidence: 'verified the anchors myself; the compact comparison cannot produce a readable locator' }] },
    { leadAnswers: [{ residuals: [PLAN_RESIDUAL] }] },
  )
  const bouncing = driveTask(CTX_TL, bouncingIo)
  const directIo = planCheckAcceptIo({ residuals: [PLAN_RESIDUAL] })
  const direct = driveTask(CTX_TL, directIo)

  assert.equal(bouncing.status, 'done')
  assert.equal(direct.status, 'done')
  assert.equal(bouncing.details.consults, 1)
  assert.equal(direct.details.consults, 1)
  assert.equal(bouncingIo.calls.assign.filter((entry) => entry.role === 'lead').length, 2)
  assert.equal(directIo.calls.assign.filter((entry) => entry.role === 'lead').length, 1)
})

test('the converge seam does not swallow a refuted must-fix', () => {
  const io = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV2-1', evidence: REFUTATION_CLAIM }],
  }, { gh: true, runs: REFUTATION_CONVERGE_RUNS }, MUST_FIX_REFUTATION_FINDINGS, REFUTATION_CONVERGE_PLAN())
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'refuted-must-fix')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('must-fix typed cosmetic accept fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*must-fix may not be typed cosmetic/)
})

test('correctness-unverified residual fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'correctness-unverified' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*correctness-unverified/)
})

test('omitted finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({ refuted: [{ id: 'RV1-1', evidence: '   ' }] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-2.*omitted id/)
})

test('duplicate finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [
      { id: 'RV1-2', evidence: 'not real' },
      { id: 'RV1-1', evidence: '   ' },
    ],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-2.*duplicate id/)
})

test('unknown finding id fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [
      { id: 'RV1-2', type: 'cosmetic' },
      { id: 'RV1-9', type: 'cosmetic' },
    ],
    refuted: [{ id: 'RV1-1', evidence: '   ' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-9.*unknown id/)
})

test('empty refutation evidence fails closed to review escalation', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-1', evidence: '   ' }],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.match(res.details.escalation.why, /RV1-1.*empty refutation evidence/)
})

test('no-lead tier remains a mechanical escalation with zero lead assigns', () => {
  const mechanical = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'reviewer:2': reviewEnv('changes-needed', ACCEPT_FINDINGS),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, roles: ['planner', 'builder', 'reviewer'] }, mechanical)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'review')
  assert.ok(mechanical.calls.assign.every((a) => a.role !== 'lead'))
  assert.equal(mechanical.calls.assign.filter((a) => a.role === 'lead').length, 0)
})

test('exhaustion accept brief lists every finding and the typed fields', () => {
  const io = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-2', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-1', evidence: 'not real' }],
  })
  driveTask(CTX, io)
  const brief = io.calls.writes[`${TD}/decision-1.md`]
  assert.ok(brief)
  for (const finding of ACCEPT_FINDINGS) assert.match(brief, new RegExp(finding.id))
  assert.match(brief, /residuals/)
  assert.match(brief, /refuted/)
})

test('accept decision records accepted and refused outcomes in the journal and emit stream', () => {
  const acceptedIo = exhaustionAcceptIo({
    residuals: [],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, { emit: true }, ACCEPT_FINDINGS_SOFT)
  driveTask(CTX, acceptedIo)
  const acceptedLog = acceptedIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(acceptedLog.outcome, 'accepted')
  assert.ok(acceptedIo.calls.emits.some((event) => event.kind === 'accept-decision' && event.outcome === 'accepted'))

  const refusedIo = exhaustionAcceptIo({
    residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
    refuted: [{ id: 'RV1-2', evidence: 'not real' }],
  }, { emit: true })
  driveTask(CTX, refusedIo)
  const refusedLog = refusedIo.calls.logs.find((line) => line.accept_decision)?.accept_decision
  assert.equal(refusedLog.outcome, 'escalated')
  assert.ok(refusedLog.errors.some((error) => error.id === 'RV1-1'))
})

test('fail-closed accept escalation composes with the regrant policy shape', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'reviewer:2': reviewEnv('changes-needed', ACCEPT_FINDINGS),
      'lead:1': leadEnv('bounce'),
      'lead:2': leadEnv('accept', 'invalid typed decision', {
        residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
        refuted: [{ id: 'RV1-2', evidence: 'not real' }],
      }),
      'lead:3': leadEnv('accept', 'invalid typed decision', {
        residuals: [{ id: 'RV1-1', type: 'cosmetic' }],
        refuted: [{ id: 'RV1-2', evidence: 'not real' }],
      }),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  const verdict = regrantVerdict(result, [{ must_fix: 2 }, { must_fix: 1 }])
  assert.equal(verdict.reasons.find((reason) => reason.condition === 'where-review').ok, true)
  assert.equal(verdict.reasons.find((reason) => reason.condition === 'grant-spent').ok, true)
})

test('red full suite after review pass escalates and preserves its commit', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'boom' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.commit, 'abc1234')
  assert.match(res.details.escalation.why, /suite red/i)
})

test('planner envelope without files_in_scope escalates — the scope gate cannot be skipped', () => {
  const env = planEnv(); delete env.details.files_in_scope
  const io = fakeIo({ envelopes: { 'planner:1': env } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /files_in_scope/)
})

test('tech-lead seated: revise verdict bounces the plan, approve on r2 proceeds', () => {
  const ctx = { ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer', 'tech-lead'] }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': { status: 'done', details: { verdict: 'revise', check_path: `${TD}/plan-check.md` } },
      'planner:2': planEnv(), 'tech-lead:2': { status: 'done', details: { verdict: 'approve' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'tech-lead').length, 2)
  assert.match(Object.values(io.calls.writes).find((w) => /Plan revision/.test(w)), /plan-check\.md/)
})

test('consult limit exhausts to escalation (a looping lead cannot loop the driver)', () => {
  const envs = { }
  for (let i = 1; i <= 10; i += 1) envs[`planner:${i}`] = planEnv({ status: 'insufficient' })
  for (let i = 1; i <= 10; i += 1) envs[`lead:${i}`] = leadEnv('bounce')
  const io = fakeIo({ envelopes: envs })
  const res = driveTask({ ...CTX, limits: { plan_rounds: 10 } }, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /consult limit/)
})

test('second-opinion valve: lead requests reviewer perspective, code gathers it unseeded, lead decides on re-ask', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous brief' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'the brief means X; plan for X', recommendation: 'bounce', confidence: 'high' } },
      'lead:2': leadEnv('bounce', 'plan for X per the reviewer perspective'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 1) // the compounded exchange is ONE consult
  // the perspective brief went to the reviewer and does NOT leak the lead's leaning
  const pBrief = Object.entries(io.calls.writes).find(([k]) => /perspective-1\.md/.test(k))[1]
  assert.match(pBrief, /advising a decision/)
  // Unseeded means the lead's LEANING is structurally absent (it never
  // exists in any artifact); the decision vocabulary IS shared so the
  // recommendation comes back machine-comparable.
  assert.match(pBrief, /own view is deliberately not shared/)
  assert.match(pBrief, /recommendation/)
  // the second decision brief carries the perspective, and no valve
  const b2 = Object.entries(io.calls.writes).find(([k]) => /decision-1b\.md/.test(k))[1]
  assert.match(b2, /Independent perspective from reviewer/)
  assert.match(b2, /plan for X/)
  assert.doesNotMatch(b2, /second-opinion \(set details\.from/)
})

test('a second second-opinion answer escalates — one hop is the bound', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'unclear', confidence: 'low' } },
      'lead:2': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'planner' } },
    },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /one hop is the bound/)
})

test('second-opinion naming an unseated member escalates', () => {
  const ctx = { ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'] } // no tech-lead seated
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'blocked' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'tech-lead' } },
    },
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /not a seated judgment member/)
})

test('compounding policy: lead accept over advisor escalate -> binding escalation naming the dissent', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:3': { status: 'done', role: 'reviewer', details: { perspective: 'these residuals are load-bearing', recommendation: 'escalate', confidence: 'high' } },
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /independently recommended escalate/)
  assert.equal(res.details.dissents.length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('compounding policy: lead bounce over advisor escalate -> lead prevails (safe direction), dissent recorded, task completes', () => {
  // planner-insufficient consult: options are bounce|escalate. Advisor says
  // escalate, lead says bounce — the split is recorded but a SAFE-direction
  // lead decision is never overridden.
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'ambiguous' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'seems unresolvable to me', recommendation: 'escalate', confidence: 'low' } },
      'lead:2': leadEnv('bounce', 'the brief means X; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents[0], { from: 'reviewer', recommendation: 'escalate', lead_decision: 'bounce', consult: 1 })
  assert.equal(io.calls.commits.length, 1)
})

test('compounding policy: a now-on-menu advisor recommendation records dissent without binding', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:3': { status: 'done', role: 'reviewer', details: { perspective: 'one more round would do it', recommendation: 'bounce', confidence: 'medium' } },
      'lead:2': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents[0], { from: 'reviewer', recommendation: 'bounce-builder', lead_decision: 'accept', consult: 1 })
  assert.equal(io.calls.commits.length, 1)
})

test('compounding policy: agreement leaves no dissent recorded', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'bounce with X', recommendation: 'bounce', confidence: 'high' } },
      'lead:2': leadEnv('bounce', 'do X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.dissents, [])
})

const b127GatePaths = (dir) => ({
  cmdFile: join(dir, 'gate.cmd.sh'),
  launchFile: join(dir, 'gate.launch.sh'),
  pgidFile: join(dir, 'gate.pgid'),
  report: join(dir, 'gate.reap.json'),
})
const b127Spy = (dir, name, body) => {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
const b127InvokeGate = ({ cmd, dir = scratchDir('b127-gate-test-'), overrides = {} }) => {
  const paths = b127GatePaths(dir)
  const wrapped = gateReapCommand({ cmd, ...paths, ...overrides })
  const result = spawnSync('/bin/sh', ['-c', wrapped], { encoding: 'utf8', timeout: 120_000 })
  const reportText = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : null
  return {
    dir, paths, wrapped, status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || ''),
    reportText, verdict: gateReapVerdict(reportText),
  }
}
const b127Lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0)
const b127PidAlive = (pid) => spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' }).status === 0
const b127GroupCommand = (pgidCopy) => `ps -o pgid= -p $$ | tr -d ' ' > '${pgidCopy}'\nexit 0`

test('a gate reap kills the process GROUP, and a leaked descendant is proven dead', { timeout: 20_000 }, () => {
  const run = b127InvokeGate({ cmd: ['nohup sleep 25 >/dev/null 2>&1 &', 'echo "leaked $!"', 'exit 0'].join('\n') })
  const pid = /leaked (\d+)/.exec(run.stdout)?.[1]
  try {
    assert.ok(pid, `expected the fixture to report its leaked descendant pid, found ${JSON.stringify(run.stdout)}`)
    assert.equal(run.status, 0)
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    const deadline = Date.now() + 10_000
    while (b127PidAlive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.05'])
    assert.equal(b127PidAlive(pid), false, `leaked descendant ${pid} remained alive after the group reap`)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    rmSync(run.dir, { recursive: true, force: true })
  }
})

test('a timed-out gate runner is bounded and the sweep reaps its leaked descendant', { timeout: 90_000 }, () => {
  const dir = scratchDir('b127-gate-timeout-')
  const paths = b127GatePaths(dir)
  const cmd = `nohup sleep 40 >/dev/null 2>&1 & echo "leaked $!"; sleep 60`
  const wrapped = gateReapCommand({ cmd, ...paths })
  const started = Date.now()
  const result = spawnSync('/bin/sh', ['-c', wrapped], { encoding: 'utf8', timeout: 4_000 })
  const elapsed = Date.now() - started
  const pid = /leaked (\d+)/.exec(String(result.stdout || ''))?.[1]
  try {
    assert.ok(pid, `expected the fixture to report its leaked descendant pid, found ${JSON.stringify(result.stdout)}`)
    assert.ok(elapsed < 15_000, `expected the runner timeout to bound the invocation, elapsed ${elapsed}ms`)
    assert.equal(result.error?.code, 'ETIMEDOUT')
    const sweep = spawnSync('/bin/sh', ['-c', gateReapSweepCommand(paths)], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(sweep.status, 0)
    const report = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : null
    const verdict = gateReapVerdict(report)
    assert.equal(verdict.outcome, 'proven')
    assert.equal(verdict.signals, 1)
    const deadline = Date.now() + 10_000
    while (b127PidAlive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.05'])
    assert.equal(b127PidAlive(pid), false, `leaked descendant ${pid} remained alive after the timeout sweep`)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    const pgid = existsSync(paths.pgidFile) ? readFileSync(paths.pgidFile, 'utf8').trim() : ''
    const ownPgid = String(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout || '').trim()
    if (/^\d+$/.test(pgid) && Number(pgid) > 1 && pgid !== ownPgid) spawnSync('kill', ['-9', `-${pgid}`])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a normal gate reap is idempotent when its report is already proven', () => {
  const run = b127InvokeGate({ cmd: ['nohup sleep 25 >/dev/null 2>&1 &', 'echo "leaked $!"', 'exit 0'].join('\n') })
  const pid = /leaked (\d+)/.exec(run.stdout)?.[1]
  try {
    assert.ok(pid)
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    const before = readFileSync(run.paths.report, 'utf8')
    const sweep = spawnSync('/bin/sh', ['-c', gateReapSweepCommand(run.paths)], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(sweep.status, 0)
    const after = readFileSync(run.paths.report, 'utf8')
    assert.equal(after, before)
    assert.deepEqual(gateReapVerdict(after), run.verdict)
  } finally {
    if (pid && b127PidAlive(pid)) spawnSync('kill', ['-9', String(pid)])
    rmSync(run.dir, { recursive: true, force: true })
  }
})

test('runGate sweeps each wrapped invocation without adding a sweep to calls.run', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.sweeps.length, 2)
  assert.ok(io.calls.sweeps.every((cmd) => String(cmd).includes(GATE_REAP_SWEEP_MARKER)))
  assert.ok(io.calls.run.every(({ cmd }) => !String(cmd).includes(GATE_REAP_SWEEP_MARKER)))
})

test('a composed gate wrapper installs no signal trap', () => {
  const dir = scratchDir('b127-gate-signal-free-')
  try {
    const wrapped = gateReapCommand({ cmd: 'true', ...b127GatePaths(dir) })
    assert.doesNotMatch(wrapped, /\btrap\b/)
    assert.doesNotMatch(wrapped, /__crew_forward_signal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a gate that exits cleanly is never signalled', () => {
  const dir = scratchDir('b127-gate-clean-')
  const sleepLog = join(dir, 'sleep.log')
  try {
    const run = b127InvokeGate({ dir, cmd: 'echo clean\nexit 0', overrides: {
      sleepCmd: b127Spy(dir, 'sleep-spy', `#!/bin/sh\necho x >> '${sleepLog}'\nexit 0\n`),
    } })
    assert.equal(run.status, 0)
    assert.equal(run.stdout, 'clean\n')
    assert.equal(run.stderr, '')
    assert.equal(run.verdict.outcome, 'already-dead')
    assert.equal(run.verdict.signals, 0)
    assert.equal(b127Lines(sleepLog), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a gate reap that cannot be measured is reported unproven, never assumed dead', () => {
  for (const report of [null, '', '{"pgid":"7","outc', '{"outcome":"assumed"}']) {
    assert.equal(gateReapVerdict(report).outcome, 'unproven')
    assert.equal(gateReapVerdict(report).signals, 0)
  }
  const gate = `gate-cmd\n${GATE_REAP_CMD_EOF}`
  const reportPath = `${TD}/gate-reap.1.json`
  const io = fakeIo({
    emit: true, writeThrough: true,
    files: { [reportPath]: '{"pgid":"9","outcome":"proven","reason":"probe-dead","signals":1,"survivors":"9"}' },
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { [`${gate}:1`]: { ok: false, output: RED(3) }, [`${gate}:2`]: { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'gate')
  assert.equal(result.status, 'done')
  assert.equal(event.reap.outcome, 'unproven')
  assert.ok(io.calls.logs.some((entry) => entry.gate_reap?.outcome === 'unproven'))
})

test('the wrapped gate command sees the same shell contract as the bare runner', () => {
  const probe = 'echo "0=$0 #=$# 1=${1-UNSET}"'
  const bare = spawnSync('/bin/sh', ['-c', probe], { encoding: 'utf8' })
  for (const shell of ['/bin/bash', '/path/that/does/not/exist']) {
    const run = b127InvokeGate({ cmd: probe, overrides: { shell } })
    assert.equal(run.stdout, String(bare.stdout))
    assert.equal(run.status, bare.status)
    const bareReturn = spawnSync('/bin/sh', ['-c', 'return 0'], { encoding: 'utf8' })
    const wrappedReturn = b127InvokeGate({ cmd: 'return 0', overrides: { shell } })
    assert.equal(wrappedReturn.status, bareReturn.status)
  }
})

test('a gate reap report that could not be cleared is never read', () => {
  const stale = '{"pgid":"999","outcome":"proven","reason":"probe-dead","signals":1,"survivors":"1"}'
  assert.equal(gateReapFresh(false, stale), null)
  assert.equal(gateReapFresh(true, stale), stale)
  const gate = `gate-cmd\n${GATE_REAP_CMD_EOF}`
  const reportPath = `${TD}/gate-reap.1.json`
  const io = fakeIo({
    emit: true, writeThrough: true, throwWrites: [reportPath],
    files: { [reportPath]: stale },
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { [`${gate}:1`]: { ok: false, output: RED(3) }, [`${gate}:2`]: { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'gate')
  assert.equal(result.status, 'done')
  assert.equal(event.reap.outcome, 'unproven')
  assert.ok(io.calls.logs.some((entry) => entry.gate_reap?.outcome === 'unproven'))
})

test('a refused KILL after a delivered TERM is unproven, never failed', () => {
  const dir = scratchDir('b127-gate-mixed-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const run = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-spy', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nprintf '%s 4242 S\\n' "$p"\n`),
      sleepCmd: b127Spy(dir, 'sleep-spy', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(dir, 'kill-spy', '#!/bin/sh\ncase "$1" in -TERM) exit 0 ;; *) exit 1 ;; esac\n'),
    } })
    assert.equal(run.verdict.outcome, 'unproven')
    assert.equal(run.verdict.signals, 1)
    assert.notEqual(run.verdict.outcome, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused first signal is unproven with zero signals, while a dead-after-refusal group is proven', () => {
  const dir = scratchDir('b127-gate-refused-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const alive = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-alive', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nprintf '%s 4242 S\\n' "$p"\n`),
      sleepCmd: b127Spy(dir, 'sleep-alive', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(dir, 'kill-refused', '#!/bin/sh\nexit 1\n'),
    } })
    assert.equal(alive.verdict.outcome, 'unproven')
    assert.equal(alive.verdict.signals, 0)
    assert.notEqual(alive.verdict.outcome, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const deadDir = scratchDir('b127-gate-dead-')
  try {
    const pgidCopy = join(deadDir, 'pgid.copy')
    const deadFlag = join(deadDir, 'dead.flag')
    const dead = b127InvokeGate({ dir: deadDir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(deadDir, 'ps-dead', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nif [ -f '${deadFlag}' ]; then printf '1 1 S\\n'; else printf '%s 4242 S\\n' "$p"; fi\n`),
      sleepCmd: b127Spy(deadDir, 'sleep-dead', '#!/bin/sh\nexit 0\n'),
      killCmd: b127Spy(deadDir, 'kill-dead', `#!/bin/sh\n: > '${deadFlag}'\nexit 1\n`),
    } })
    assert.equal(dead.verdict.outcome, 'proven')
    assert.equal(dead.verdict.signals, 0)
  } finally {
    rmSync(deadDir, { recursive: true, force: true })
  }
})

test('a gate reap observes a group dying during the fourth settle round', () => {
  const dir = scratchDir('b127-gate-boundary-')
  try {
    const pgidCopy = join(dir, 'pgid.copy')
    const sleepLog = join(dir, 'sleep.log')
    const deadFlag = join(dir, 'dead.flag')
    const run = b127InvokeGate({ dir, cmd: b127GroupCommand(pgidCopy), overrides: {
      psCmd: b127Spy(dir, 'ps-spy', `#!/bin/sh\np=$(cat '${pgidCopy}' 2>/dev/null || echo 0)\nif [ -f '${deadFlag}' ]; then printf '1 1 S\\n'; else printf '%s 4242 S\\n' "$p"; fi\n`),
      sleepCmd: b127Spy(dir, 'sleep-spy', `#!/bin/sh\necho x >> '${sleepLog}'\nn=$(wc -l < '${sleepLog}' | tr -d ' ')\nif [ "$n" -ge 4 ]; then : > '${deadFlag}'; fi\nexit 0\n`),
      killCmd: b127Spy(dir, 'kill-spy', '#!/bin/sh\nexit 0\n'),
    } })
    assert.equal(run.verdict.outcome, 'proven')
    assert.equal(run.verdict.signals, 1)
    assert.equal(b127Lines(sleepLog), 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate reap wrappers round-trip shell text and refuse a delimiter-bearing command', () => {
  const dir = scratchDir('b127-gate-text-')
  try {
    const paths = b127GatePaths(dir)
    const command = `printf "a'b\\\" $VAR"\n# newline\necho done`
    const wrapped = gateReapCommand({ cmd: command, ...paths })
    assert.equal(gateReapOriginal(wrapped), command)
    const bypass = `echo before\n${GATE_REAP_CMD_EOF}\necho after`
    assert.equal(gateReapCommand({ cmd: bypass, ...paths }), bypass)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate reap guards the driver group before any signal', () => {
  const dir = scratchDir('b127-gate-guard-')
  try {
    const lines = gateReapCommand({ cmd: 'true', ...b127GatePaths(dir) }).split('\n')
    const guardAt = lines.findIndex((line) => line.includes('"$__crew_self"') && line.includes(')'))
    const killAt = lines.findIndex((line) => /(^|\s)\$__crew_kill\s/.test(line))
    assert.ok(guardAt >= 0)
    assert.ok(killAt >= 0)
    assert.ok(guardAt < killAt)
    assert.match(lines[guardAt], /unproven/)
    assert.match(lines[guardAt], /root-unidentified/)
    assert.doesNotMatch(lines[guardAt], /\$__crew_kill\s/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate invocations tally already-dead reaps and do not journal clean outcomes', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.deepEqual(result.details.gate.reap, { invocations: 2, 'already-dead': 2, proven: 0, failed: 0, unproven: 0 })
  assert.equal(io.calls.logs.filter((entry) => entry.gate_reap).length, 0)
  const wrappedGates = io.calls.wrapped.filter(({ wrapped, cmd }) => wrapped !== cmd)
  assert.deepEqual(wrappedGates.map(({ cmd }) => cmd), ['gate-cmd', 'gate-cmd'])
  assert.ok(wrappedGates.every(({ clean }) => clean === false))
})

test('gate-first: green baseline bounces the lead; repaired gate red at baseline proceeds; gate green after build -> done', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-v1' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-v2' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-v1': { ok: true, output: 'vacuously green' },        // baseline GREEN -> bounce
      'gate-v2:1': { ok: false, output: 'red at baseline\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },     // repaired gate properly red
      'gate-v2:2': { ok: true, output: '' },                     // green after build
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /baseline ran GREEN/.test(w))
  assert.ok(bounce, 'expected the vacuous-gate bounce brief')
  assert.equal(res.details.gate.cmd, 'gate-v2')
})

test('gate-first: repaired gate STILL green at baseline escalates — vacuous acceptance cannot be built against', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-v1' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-v2' } },
    },
    runs: { 'gate-v1': { ok: true, output: '' }, 'gate-v2': { ok: true, output: '' } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /STILL green at baseline/)
})

test('gate red after build feeds back verbatim and bounces without a lead consult', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: false, output: 'expected exportX, found nothing, at a.mjs:12' },
      'gate-cmd:3': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.consults, 0)
  const bounce = Object.values(io.calls.writes).find((w) => /ACCEPTANCE GATE is red/.test(w))
  assert.match(bounce, /expected exportX, found nothing/)
  assert.match(bounce, /immutable to you/)
})

test('gate invocations emit distinct verdicts and ordinary red-then-green raises no attention', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) },
      'gate-cmd:2': { ok: false, output: 'still red' },
      'gate-cmd:3': { ok: true, output: 'green' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  const gates = io.calls.emits.filter((event) => event.kind === 'gate')
  assert.equal(res.status, 'done')
  assert.deepEqual(gates.map(({ name }) => name), ['gate-baseline', 'gate:r1', 'gate:r2'])
  assert.deepEqual(gates.map(({ attempt }) => attempt), [1, 2, 3])
  assert.deepEqual(gates.map(({ ok }) => ok), [false, false, true])
  assert.ok(gates.every(({ cmd }) => cmd === 'gate-cmd'))
  assert.equal(io.calls.emits.filter((event) => event.kind === 'attention').length, 0)
})

test('gate exhaustion emits exactly one gate attention with an explicit null park_id', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'lead:1': leadEnv('escalate'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) },
      'gate-cmd:2': { ok: false, output: 'still red' },
      'lane-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  const attention = io.calls.emits.filter((event) => event.kind === 'attention')
  assert.equal(res.status, 'escalation')
  assert.equal(attention.length, 1)
  assert.equal(attention[0].moment, 'gate')
  assert.ok(Object.hasOwn(attention[0], 'park_id'))
  assert.equal(attention[0].park_id, null)
})

test('repeated gate failures trigger reviewer triage; gate-defect diagnosis lets the lead repair once and re-runs without a builder round', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },   // baseline
      'gate-bad:2': { ok: false, output: 'bogus fail A' },   // build r1 -> bounce
      'gate-bad:3': { ok: false, output: 'bogus fail B' },   // build r2 -> triage fires (round >= 2)
      'gate-fixed': { ok: true, output: '' },                // repaired gate green immediately
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.repairs, 1)
  // builder ran exactly twice — the repair re-run consumed NO builder round
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  const gateNames = io.calls.emits.filter((event) => event.kind === 'gate').map((event) => event.name)
  assert.ok(gateNames.includes('gate-repair:1'))
  assert.ok(gateNames.includes('gate-reverify:1') === false)
  assert.equal(io.calls.emits.filter((event) => event.kind === 'attention').length, 1)
  const repair = Object.values(io.calls.writes).find((w) => /GATE DEFECT/.test(w))
  assert.match(repair, /may NOT weaken any legitimate check/)
})

test('a repaired gate proven red on the pristine tree proceeds — and the proof costs no builder round', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: 'red on pristine\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.reverified, true)
  assert.deepEqual(io.calls.runClean, [{ cmd: 'gate-fixed', n: 1 }])
  const gateNames = io.calls.emits.filter((event) => event.kind === 'gate').map((event) => event.name)
  assert.ok(gateNames.includes('gate-reverify:1'))
  assert.ok(gateNames.includes('gate-repair:1'))
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

// REGRESSION: seatIo.runClean is a shorthand METHOD that calls `this.run(cmd)`
// (crew/seat-io.mjs:241,245). #130 routed the reverify call through
// runGate(..., io.runClean), detaching it, and every real gate-reverify
// crashed with "Cannot read properties of undefined (reading 'run')" — caught
// only by a live run. The fakes above cannot catch it: their runClean is an
// arrow that never reads `this`. This one models the shipped shape.
test('an io whose runClean is a this-using method survives gate-reverify', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  // Exactly seatIo's shape: a method that reaches its sibling through `this`.
  const pristine = { ok: false, output: 'red on pristine\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' }
  let sawThis = false
  io.runClean = function runClean(cmd) {
    sawThis = true
    this.run(cmd) // the line that threw when the method was passed detached
    return pristine
  }
  const res = driveTask(CTX, io)
  assert.equal(sawThis, true, 'runClean must actually have been reached')
  assert.notEqual(res.details?.escalation?.where, 'driver', 'a detached runClean crashes the driver')
  assert.equal(res.details.gate.reverified, true)
})

test('a repaired gate GREEN on the pristine tree is vacuous — escalate, never commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /STILL green/)
  assert.equal(io.calls.commits.length, 0)
})

test('an io without runClean keeps the repair path exactly as it was', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate checks a file the brief never named' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'bogus fail A' },
      'gate-bad:3': { ok: false, output: 'bogus fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.reverified, false)
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(io.calls.run.map((r) => r.cmd), ['gate-bad', 'lane-cmd', 'gate-bad', 'lane-cmd', 'gate-bad', 'gate-fixed', 'suite-cmd'])
})

test('first green records discrimination without adding a reverified field', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.reverified, undefined)
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 1)
  const gates = io.calls.emits.filter((event) => event.kind === 'gate')
  assert.ok(gates.every((event) => event.generation === 1 && typeof event.pristine === 'boolean'))
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'discrimination'), [{
    kind: 'discrimination', generation: 1, verdict: 'proven',
    summary: { total: 3, failed: 3, errored: 0 }, note: null,
  }])
})

test("a failed first-green proof bounces the LEAD for a gate repair, never the builder", () => {
  const pristineOutput = 'green pristine output — the gate did not inspect the work'
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: pristineOutput },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.generation, 2)
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.ok(io.calls.writes[`${TD}/gate-discrimination-bounce.md`].includes(pristineOutput))
})

test('pristine red with every check failed records proven discrimination', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
})

test('a no-summary failed proof routes through the lead repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: false, output: 'red but no summary' },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /printed no GATE-SUMMARY/)
})

test('a THREW failed proof routes through the lead repair with its diagnosis', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: false, output: THREW },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.runClean.length, 2)
  assert.match(io.calls.writes[`${TD}/gate-discrimination-bounce.md`], /THREW/)
})

test('a second failed proof escalates after the single gate repair is spent', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: 'green first pristine run' },
      'gate-fixed': { ok: true, output: 'green replacement pristine run' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /spent/)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.runClean.length, 2)
})

test('a triage repair with a failed no-summary re-proof escalates without a second lead repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'gate is defective' } },
    },
    runs: {
      'gate-bad:1': { ok: false, output: RED(3) },
      'gate-bad:2': { ok: false, output: RED(3) },
      'gate-bad:3': { ok: false, output: RED(3) },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: 'red but no summary' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /gate-fixed/)
  assert.match(res.details.escalation.why, /printed no GATE-SUMMARY/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('a failed proof repaired to a red built-tree gate bounces the builder, then proceeds', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:1': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: {
      'gate-cmd': { ok: true, output: 'green first pristine run' },
      'gate-fixed': { ok: false, output: RED(3) },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.generation, 2)
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 2)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
  assert.equal(io.calls.commits.length, 1)
})

test('a failed proof whose lead repair omits gate_cmd escalates without a commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', summary: 'no gate returned', details: {} },
      'builder:1': buildEnv(),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green pristine run' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /could not be repaired/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('missing runClean records unproven without adding a proof stage or changing the run', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.discrimination, 'unproven')
  assert.equal(io.calls.runClean.length, 0)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.stages.includes('gate-proof:1'), false)
  assert.equal(res.details.stages.filter((stage) => /bounce|escalate:/.test(stage)).length, 0)
  assert.deepEqual(io.calls.emits.filter((event) => event.kind === 'discrimination'), [{
    kind: 'discrimination', generation: 1, verdict: 'unproven', summary: null, note: null,
  }])
})

test('a throwing runClean records unproven and preserves its stash message in the journal', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanThrows: true,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(res.details.gate.discrimination, 'unproven')
  assert.match(res.details.gate.discrimination_note, /stash/)
  const journal = io.calls.logs.find((line) => line.gate_proof_unproven)
  assert.ok(journal)
  assert.equal(journal.gate_proof_unproven, res.details.gate.discrimination_note)
  const discrimination = io.calls.emits.find((event) => event.kind === 'discrimination')
  assert.deepEqual(discrimination, {
    kind: 'discrimination', generation: 1, verdict: 'unproven', summary: null,
    note: res.details.gate.discrimination_note,
  })
})

test('a review bounce does not repeat the first-green proof for one generation', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'gate-cmd:3': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 2)
})

test('a byte-identical repair starts generation two and records its own proof', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong target' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: false, output: 'first build fail' },
      'gate-cmd:3': { ok: false, output: 'second build fail' }, 'gate-cmd:4': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 2)
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(io.calls.runClean.length, 1)
})

test('a baseline defect replacement stays generation one and keeps its audit trail', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-bad': { ok: false, output: 'no summary' },
      'gate-fixed:1': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-fixed': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 1)
  assert.equal(res.details.gate.repairs, 0)
  assert.deepEqual(res.details.gate.replaced, ['gate-bad'])
})

test('a happy path without a gate does not measure runClean', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate, null)
  assert.equal(io.calls.runClean.length, 0)
})

// --- #153: baseline-red must mean the gate RAN, not merely that it exited ----
const RED = (n = 3) => `some failure\n${GATE_SUMMARY_PREFIX} {"total":${n},"failed":${n},"errored":0}`
const THREW = `FAIL x: expected the check to run, found it threw: linkSync is not defined\n${GATE_SUMMARY_PREFIX} {"total":47,"failed":1,"errored":1}`

const CHECK_FILE = `${CTX.checkout}/a.mjs`
const CHECK_BUILT = 'export const guard = true\n'
const CHECK_MUTATION = { check: 'check-one', file: 'a.mjs', find: 'true', replace: 'false' }
const CHECK_PLAN = (mutations) => planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd', mutations } })
const CHECK_RUNS = (mutationOutput = `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`) => ({
  'gate-cmd:1': { ok: false, output: RED(3) },
  'gate-cmd:2': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
  'gate-cmd:3': { ok: false, output: mutationOutput },
  'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
})
const CHECK_CLEAN = { 'gate-cmd': { ok: false, output: RED(3) } }
const B384_CORRECTED_FIND = 'try { recordWait(); return run() } finally { pool.release(handle) }'
const B384_CORRECTED_REPLACE = 'recordWait(); try { return run() } finally { pool.release(handle) }'
const B384_BUILT = [
  'export function withSlot(pool, run) {',
  '  const handle = pool.acquire()',
  '  // the wait is recorded before the body runs, so a queue that never drains still shows its',
  '  // depth; #822 measured 3 of 4 slots held for the whole run.',
  `  ${B384_CORRECTED_FIND}`,
  '}',
].join('\n')
const B384_MUTATION = {
  check: 'B2', file: 'crew/drive.mjs',
  find: 'const handle = pool.acquire()\ntry { recordWait(); return run() } finally { pool.release(handle) }',
  replace: 'const handle = null',
}
const B384_PLAN = (mutations = [B384_MUTATION], files_in_scope = ['crew/drive.mjs']) => planEnv({
  details: { ...planEnv().details, files_in_scope, gate_cmd: 'gate-cmd', mutations },
})
const B384_FILE = `${CTX.checkout}/crew/drive.mjs`
const B384_GREEN = `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`
const B384_RED = `FAIL B2: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`
function b384Io({ mutations = [B384_MUTATION], scope = ['crew/drive.mjs'], builder = buildEnv(), files = {}, runs = {}, throwMutation = false } = {}) {
  const io = fakeIo({
    files: { [B384_FILE]: B384_BUILT, ...files }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: { 'planner:1': B384_PLAN(mutations, scope), 'builder:1': builder, 'reviewer:1': reviewEnv('pass') },
    runs: { ...CHECK_RUNS(), ...runs }, changed: scope, emit: true,
    reseat: () => ({ applied: true, already: true }),
  })
  if (throwMutation) {
    const originalRun = io.run
    let gateCalls = 0
    io.run = function (cmd) {
      const original = gateReapOriginal(cmd)
      if (!String(cmd).includes(GATE_REAP_SWEEP_MARKER) && original === 'gate-cmd') {
        gateCalls += 1
        if (gateCalls === 3) throw new Error('mutation gate exploded')
      }
      return originalRun.call(this, cmd)
    }
  }
  return io
}
const CHECK_ENVELOPES = (mutations, extra = {}) => ({
  'planner:1': CHECK_PLAN(mutations), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'), ...extra,
})

test('mutation anchors bind exact or whitespace-normalized token spans', () => {
  const original = 'const one = true\nconst two = true\n'
  assert.deepEqual(bindMutationAnchor(original, 'true'), { mode: 'exact', spans: [] })
  assert.deepEqual(applyMutationAnchor(original, 'true', 'false'), {
    mode: 'exact', text: 'const one = false\nconst two = false\n',
  })

  const wrapped = 'const value = call(first,\n  second)\n'
  const bound = bindMutationAnchor(wrapped, 'call(first, second)')
  assert.equal(bound.mode, 'normalized')
  assert.equal(bound.spans.length, 1)
  assert.equal(wrapped.slice(bound.spans[0].start, bound.spans[0].end), 'call(first,\n  second)')

  const replacement = 'alpha(\n    "beta",   "gamma"\n)'
  const applied = applyMutationAnchor(wrapped, 'call(first, second)', replacement)
  assert.equal(applied.mode, 'normalized')
  assert.equal(applied.text, `const value = ${replacement}\n`)

  const commentCrossing = '// load-bearing\nexport const GUARD = true\n'
  const commentFind = '// load-bearing export const GUARD = true'
  assert.equal(bindMutationAnchor(commentCrossing, commentFind).mode, 'unsafe')
  assert.deepEqual(applyMutationAnchor(commentCrossing, commentFind, 'export const GUARD = false'), { mode: 'unsafe', text: null })
  assert.equal(bindMutationAnchor('export const GUARD =\ntrue // trailing\n', 'export const GUARD = true // trailing').mode, 'normalized')
  assert.equal(bindMutationAnchor('// before\nexport const GUARD = true\n', 'export const GUARD =\ntrue').mode, 'normalized')
  assert.equal(bindMutationAnchor('if (ready) {\n  try {', 'if (ready) { try {').mode, 'normalized')

  const standaloneCr = '// load-bearing\rexport const GUARD = true\n'
  assert.equal(bindMutationAnchor(standaloneCr, commentFind).mode, 'unsafe')
  assert.deepEqual(applyMutationAnchor(standaloneCr, commentFind, 'export const GUARD = false'), { mode: 'unsafe', text: null })

  assert.deepEqual(bindMutationAnchor('export const guard = true\n', 'export const guards = true'), { mode: 'absent', spans: [] })
  const twice = 'const a = pick(one,\n  two)\nconst b = pick(one, two)\n'
  const ambiguous = bindMutationAnchor(twice, 'pick(one, \n two)')
  assert.equal(ambiguous.mode, 'ambiguous')
  assert.equal(ambiguous.spans.length, 2)
  assert.deepEqual(applyMutationAnchor(twice, 'pick(one, \n two)', 'pick(one)'), { mode: 'ambiguous', text: null })

  for (const [originalInput, findInput] of [[null, 'x'], ['x', null], ['x', '']]) {
    assert.doesNotThrow(() => bindMutationAnchor(originalInput, findInput))
    assert.equal(bindMutationAnchor(originalInput, findInput).mode, 'absent')
  }
  assert.equal(applyMutationAnchor(null, 'x', 'y').mode, 'absent')
})

test('a re-wrapped built anchor binds and the per-check proof kills the check', () => {
  const built = 'export const laneId = (task) =>\n  slug(task.name,\n    task.id)\n'
  const mutation = { check: 'wrapped', file: 'a.mjs', find: 'slug(task.name, task.id)', replace: 'slug(task.id)' }
  const mutated = 'export const laneId = (task) =>\n  slug(task.id)\n'
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([mutation]),
    runs: CHECK_RUNS(`FAIL wrapped: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'killed')
  assert.deepEqual(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).map(({ content }) => content), [mutated, built])
})

test('b385 A1 the bind check reads every declaration before the first checkout write and journals their statuses', () => {
  const mutations = [
    { check: 'check-one', file: 'a.mjs', find: 'true', replace: 'false' },
    { check: 'ghost', file: 'a.mjs', find: 'true\nexport const other = false', replace: 'false\nexport const other = true' },
  ]
  const built = 'export const guard = true\n// interposed comment block\nexport const other = false\n'
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const firstWrite = io.calls.checkoutLog.findIndex(({ op }) => op === 'write')
  assert.ok(firstWrite >= 0)
  const declarationReads = io.calls.checkoutLog.slice(0, firstWrite).filter(({ op, path }) => op === 'read' && path === CHECK_FILE)
  assert.ok(declarationReads.length >= 2)
  assert.ok(io.calls.writeLog.some(({ path }) => path === CHECK_FILE))
  const bind = io.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  assert.deepEqual(bind?.checks, [
    { check: 'check-one', file: 'a.mjs', status: 'exact' },
    { check: 'ghost', file: 'a.mjs', status: 'absent' },
  ])
  assert.deepEqual({ declared: bind?.declared, exact: bind?.exact, normalized: bind?.normalized, absent: bind?.absent, corrected: bind?.corrected }, {
    declared: 2, exact: 1, normalized: 0, absent: 1, corrected: 0,
  })
})

test('a token-different anchor is absent and writes nothing', () => {
  const mutation = { ...CHECK_MUTATION, check: 'token-different', find: 'guards', replace: 'false' }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'anchor-absent')
  assert.match(row.why, /exactly or whitespace-normalized/)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('a two-span anchor is ambiguous and writes nothing', () => {
  const built = 'const a = pick(one,\n  two)\nconst b = pick(one, two)\n'
  const mutation = { check: 'two-spans', file: 'a.mjs', find: 'pick(one, \n two)', replace: 'pick(one)' }
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.equal(row.outcome, 'anchor-ambiguous')
  assert.match(row.why, /more than one whitespace-normalized span/)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('a comment-crossing span is anchor-unsafe and writes nothing', () => {
  const built = '// load-bearing\nexport const GUARD = true\n'
  const mutation = {
    check: 'anchor-unsafe', file: 'a.mjs',
    find: '// load-bearing export const GUARD = true', replace: 'export const GUARD = false',
  }
  const io = fakeIo({
    files: { [CHECK_FILE]: built }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  const row = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks[0]
  assert.deepEqual({ outcome: row.outcome, file: row.file, summary: row.summary }, { outcome: 'anchor-unsafe', file: 'a.mjs', summary: null })
  assert.equal(row.why, "the declared find's normalized match crosses a line that carries a // comment inside the span, so a verbatim replacement would land in the comment; declare a find that starts after the comment")
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.match(res.details.escalation.why, /did not BIND/)
  assert.doesNotMatch(res.details.escalation.why, /did not kill/)
})

test('a missing file and an unbindable find keep unapplied on the missing file only', () => {
  const mutations = [
    { check: 'missing-file', file: 'missing.mjs', find: 'anything', replace: 'other' },
    { check: 'unbindable', file: 'a.mjs', find: 'guards', replace: 'false' },
  ]
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'a.test.mjs', 'missing.mjs'], gate_cmd: 'gate-cmd', mutations } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'gate-fixed:1': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs'], emit: true,
  })
  driveTask(CTX, io)
  const rows = io.calls.emits.find((event) => event.kind === 'check-discrimination').checks
  assert.deepEqual(rows.map(({ check, outcome }) => ({ check, outcome })), [
    { check: 'missing-file', outcome: 'unapplied' }, { check: 'unbindable', outcome: 'anchor-absent' },
  ])
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('binding-failure escalation says BIND while survived keeps did-not-kill wording', () => {
  const run = (mutation, files, mutationRun) => {
    const io = fakeIo({
      files, writeThrough: true,
      cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
      runs: { ...CHECK_RUNS(), 'gate-cmd:3': mutationRun, 'gate-fixed:1': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    return driveTask(CTX, io)
  }
  const binding = run({ ...CHECK_MUTATION, check: 'nobind', find: 'guards', replace: 'false' }, { [CHECK_FILE]: CHECK_BUILT }, { ok: true, output: '' })
  assert.match(binding.details.escalation.why, /did not BIND/)
  const survived = run(CHECK_MUTATION, { [CHECK_FILE]: CHECK_BUILT }, { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` })
  assert.match(survived.details.escalation.why, /did not kill/)
  assert.doesNotMatch(survived.details.escalation.why, /did not BIND/)
})

test('mutation binding failures are frozen and exclude gate outcomes', () => {
  assert.equal(Object.isFrozen(MUTATION_BINDING_FAILURES), true)
  assert.deepEqual([...MUTATION_BINDING_FAILURES].sort(), ['anchor-absent', 'anchor-ambiguous', 'anchor-unsafe', 'unapplied'])
  assert.ok(MUTATION_BINDING_FAILURES.length < MUTATION_OUTCOMES.length)
  for (const outcome of MUTATION_BINDING_FAILURES) assert.ok(MUTATION_OUTCOMES.includes(outcome))
  for (const outcome of ['killed', 'exempt', 'survived']) assert.equal(MUTATION_BINDING_FAILURES.includes(outcome), false)
  assert.deepEqual(MUTATION_OUTCOMES.filter((outcome) => !['killed', 'exempt'].includes(outcome) && !MUTATION_BINDING_FAILURES.includes(outcome)), ['survived'])
})

// --- b37: per-check gate discrimination -------------------------------------
test('validateMutations accepts a mutation and exemption and rejects malformed declarations', () => {
  const inScope = scopeMatcher(['a.mjs', 'a.test.mjs'])
  assert.deepEqual(validateMutations([CHECK_MUTATION, { check: 'skip', exempt: 'not applicable' }], inScope), [])
  const cases = [
    null, 42, [{ file: 'a.mjs', find: 'a', replace: 'b' }], [CHECK_MUTATION, CHECK_MUTATION],
    [{ ...CHECK_MUTATION, file: 'crew/drive.mjs' }], [{ ...CHECK_MUTATION, file: 'a/' }],
    [{ ...CHECK_MUTATION, file: '/tmp/a.mjs' }], [{ ...CHECK_MUTATION, find: '' }],
    [{ ...CHECK_MUTATION, find: 'true', replace: 'true' }],
    [{ check: 'x', exempt: 'why', file: 'a.mjs' }], [{ check: 'x', exempt: '' }],
    [{ ...CHECK_MUTATION, check: '' }], [{ ...CHECK_MUTATION, check: 'bad\nlabel' }],
    [{ ...CHECK_MUTATION, check: 'bad\rlabel' }], [{ ...CHECK_MUTATION, check: '   ' }],
    [{ ...CHECK_MUTATION, check: ' check-one ' }], [{ ...CHECK_MUTATION, check: '-cache' }],
    [{ ...CHECK_MUTATION, check: 'cache/v2' }], [{ ...CHECK_MUTATION, check: 'bad label' }], [{ ...CHECK_MUTATION, check: 'bad:label' }],
    Array.from({ length: MUTATIONS_MAX + 1 }, (_, i) => ({ ...CHECK_MUTATION, check: `c${i}` })),
  ]
  for (const entries of cases) {
    const errors = validateMutations(entries, inScope)
    assert.ok(errors.length > 0, JSON.stringify(entries))
    assert.ok(errors.every((error) => error.why), JSON.stringify(entries))
  }

  const whitespaceReason = 'find and replace differ only in whitespace — that mutates no token'
  const whitespaceOnly = { ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,\tb)' }
  assert.deepEqual(validateMutations([whitespaceOnly], inScope), [{ entry: whitespaceOnly, why: whitespaceReason }])
  const identical = { ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,  b)' }
  assert.deepEqual(validateMutations([identical], inScope), [{ entry: identical, why: 'find and replace are identical — that mutates nothing' }])
  assert.deepEqual(validateMutations([{ ...CHECK_MUTATION, find: 'fn(a,  b)', replace: 'fn(a,  c)' }], inScope), [])

  const normalizedPairs = [
    { find: 'fn(a,  b)', replace: 'fn(a,\tb)', built: 'prefix fn(a,\t b) suffix' },
    { find: 'fn(a,\r\n b)', replace: 'fn(a, b)', built: 'prefix fn(a,\n  b) suffix' },
    { find: 'fn(a, \r\n\tb)', replace: 'fn(a,\tb)', built: 'prefix fn(a,\r\n b) suffix' },
  ]
  for (const pair of normalizedPairs) {
    assert.equal(bindMutationAnchor(pair.built, pair.find).mode, 'normalized')
    assert.equal(validateMutations([{ ...CHECK_MUTATION, find: pair.find, replace: pair.replace }], inScope).length, 1)
  }
  for (const [find, replace] of [['fn(a,\fb)', 'fn(a, b)'], ['fn(a, b)', 'fn(a, b)']]) {
    assert.deepEqual(validateMutations([{ ...CHECK_MUTATION, find, replace }], inScope), [])
  }
})

test('checkFailureLine requires the intended failure line and a strict delimiter', () => {
  assert.equal(checkFailureLine(`FAIL check-one: why\n${RED()}`, 'check-one'), true)
  assert.equal(checkFailureLine('  FAIL check-one', 'check-one'), true)
  assert.equal(checkFailureLine('FAIL check-one:', 'check-one'), true)
  assert.equal(checkFailureLine('FAIL cache:v2: why', 'cache'), false)
  assert.equal(checkFailureLine('FAIL cache:v2: why', 'cache:v2'), true)
  for (const output of ['FAIL check-one extra words', 'FAIL check-one — why', 'FAIL check-one why', 'FAIL check-one warm: reason', 'FAIL check-one:v2: reason', 'FAIL check-one-two: why', 'PASS check-one', 'prose check-one', '']) {
    assert.equal(checkFailureLine(output, 'check-one'), false, output)
  }
})

test('a present-but-misdelimited FAIL label is diagnosed as a delimiter, not an absent print', () => {
  for (const [label, output] of [['C1', 'FAIL C1 — why'], ['check-one', 'FAIL check-one why']]) {
    const mutation = { ...CHECK_MUTATION, check: label }
    const io = fakeIo({
      files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
      cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
      runs: {
        ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
        'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
        'gate-fixed:2': { ok: false, output: `FAIL ${label}: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'done')
    const event = io.calls.emits.find((entry) => entry.kind === 'check-discrimination')
    const row = event.checks[0]
    assert.equal(row.outcome, 'survived')
    assert.match(row.why, new RegExp(`DID print "FAIL ${label}"`))
    assert.match(row.why, /must END THE LINE or be followed by a colon/)
    assert.doesNotMatch(row.why, new RegExp(`printed no "FAIL ${label}" line`))
    assert.equal(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0].why, row.why)
  }
})

test('a genuinely absent FAIL label keeps the absent-line diagnosis', () => {
  const label = 'check-one'
  const output = 'PASS check-one'
  const mutation = { ...CHECK_MUTATION, check: label }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: {
      ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
      'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:2': { ok: false, output: `FAIL ${label}: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
    },
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const journal = io.calls.logs.find((line) => line.gate_check_discriminations)
  const row = journal.gate_check_discriminations[0]
  assert.match(row.why, /printed no "FAIL check-one" line/)
  assert.match(row.why, /not the one under proof/)
  assert.doesNotMatch(row.why, /DID print/)
})

test('the delimiter diagnosis reaches the escalation record', () => {
  const label = 'C1'
  const output = 'FAIL C1 — why'
  const mutation = { ...CHECK_MUTATION, check: label }
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { ...CHECK_CLEAN, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: {
      ...CHECK_RUNS(`${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}`),
      'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:2': { ok: false, output: `${output}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
    },
    changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.match(res.details.escalation.why, /DID print "FAIL C1"/)
})

test('per-check mutation records an additive killed row and event', () => {
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'check-one', outcome: 'killed', file: 'a.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null })
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination').length, 1)
  assert.equal(io.calls.runClean.length, 1)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 3)
})

test('per-check mutations restore each file byte-identically', () => {
  const mutations = [CHECK_MUTATION, { check: 'check-two', file: 'a.mjs', find: 'guard', replace: 'fence' }]
  const runs = { ...CHECK_RUNS('FAIL check-one: caught\nGATE-SUMMARY {"total":3,"failed":1,"errored":0}'),
    'gate-cmd:4': { ok: false, output: 'FAIL check-two: caught\nGATE-SUMMARY {"total":3,"failed":1,"errored":0}' } }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const writes = io.calls.writeLog.filter(({ path }) => path === CHECK_FILE)
  assert.deepEqual(writes.map(({ content }) => content), [
    'export const guard = false\n', CHECK_BUILT, 'export const fence = true\n', CHECK_BUILT,
  ])
  assert.equal(io.calls.files[CHECK_FILE], CHECK_BUILT)
})

test('an exemption is recorded with its reason and runs no mutation gate', () => {
  const mutations = [{ check: 'skip', exempt: 'not applicable' }, CHECK_MUTATION]
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'skip', outcome: 'exempt', why: 'not applicable', file: null, summary: null })
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 3)
})

test('no mutation declaration leaves whole-gate proof output unchanged', () => {
  const io = fakeIo({ cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(undefined), runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(Object.hasOwn(res.details.gate, 'check_discrimination'), false)
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination').length, 0)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length, 2)
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.equal(res.details.stages.some((stage) => stage.endsWith(':checks')), false)
})

test('a malformed mutation declaration escalates at plan before assigning a builder', () => {
  const io = fakeIo({ envelopes: { 'planner:1': CHECK_PLAN([{ check: 'missing-file' }]) } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('an anchor-absent mutation is not accepted as proof', () => {
  const mutation = { ...CHECK_MUTATION, check: 'ghost', find: 'missing text' }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    envelopes: CHECK_ENVELOPES([mutation], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    runs: { ...CHECK_RUNS(), 'gate-fixed:1': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'anchor-absent')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(res.details.gate.repairs, 0)
  assert.equal(res.details.escalation.why.includes('ghost'), true)
  assert.deepEqual(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0], { check: 'ghost', outcome: 'anchor-absent', file: 'a.mjs', summary: null, why: 'the declared find text is nowhere in the built a.mjs, exactly or whitespace-normalized' })
  assert.equal(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).length, 0)
})

test('an interrupted read records unproven per-check evidence without losing the build', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, throwOn: 'read', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.equal(res.details.gate.check_discriminations.length, 0)
  assert.equal(io.calls.commits.length, 1)
  assert.ok(io.calls.logs.some((line) => line.gate_check_proof_unproven))
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_bind).length, 0)
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})

test('a failed restore escalates rather than committing the driver mutation', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, throwOn: 'restore', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'gate')
  assert.equal(io.calls.commits.length, 0)
  assert.match(res.details.escalation.why, /a\.mjs/)
})

test('a thrown mutation gate with a successful restore remains contained', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const run = io.run
  io.run = function (cmd) {
    const original = gateReapOriginal(cmd)
    if (original === 'gate-cmd' && this.calls.run.filter(({ cmd: name }) => name === original).length >= 2) throw new Error('mutation gate exploded')
    return run.call(this, cmd)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.equal(io.calls.files[CHECK_FILE], CHECK_BUILT)
  assert.equal(io.calls.commits.length, 1)
})

test('an apply failure before landing is unproven and leaves no checkout write', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, throwOn: 'apply', cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.deepEqual(io.calls.writeLog.filter(({ path }) => path === CHECK_FILE).map(({ content }) => content), [CHECK_BUILT])
  assert.equal(io.calls.emits.filter((event) => event.kind === 'check-discrimination')[0].verdict, 'unproven')
})

test('a surviving mutation enters the existing lead gate repair path', () => {
  const fixedRuns = {
    ...CHECK_RUNS(),
    'gate-cmd:3': { ok: true, output: `still green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
    'gate-fixed:1': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
    'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
  }
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } } }),
    runs: fixedRuns, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.repairs, 1)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(io.calls.logs.find((line) => line.gate_check_discriminations).gate_check_discriminations[0].why, 'the gate stayed GREEN under the mutation')
})

test('b385 B1 an unresolved anchor escalates at anchor-absent and never reaches gate custody', () => {
  const first = b384Io()
  const firstRes = driveTask(CTX, first)
  assert.equal(firstRes.status, 'escalation')
  assert.equal(firstRes.details.escalation.where, 'anchor-absent')
  assert.match(firstRes.details.escalation.why, /\banchor-absent\b/)
  assert.equal(first.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
  assert.equal(firstRes.details.gate.repairs, 0)

  const interrupted = b384Io({
    mutations: [CHECK_MUTATION, B384_MUTATION], scope: ['a.mjs', 'crew/drive.mjs'],
    files: { [CHECK_FILE]: CHECK_BUILT }, throwMutation: true,
  })
  const interruptedRes = driveTask(CTX, interrupted)
  assert.equal(interruptedRes.status, 'escalation')
  assert.equal(interruptedRes.details.escalation.where, 'anchor-absent')
  assert.match(interruptedRes.details.escalation.why, /B2/)
  assert.equal(interruptedRes.details.gate.repairs, 0)
  assert.equal(interrupted.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)

  const mixed = b384Io({
    mutations: [CHECK_MUTATION, B384_MUTATION], scope: ['a.mjs', 'crew/drive.mjs'],
    files: { [CHECK_FILE]: CHECK_BUILT }, runs: { 'gate-cmd:3': { ok: true, output: B384_GREEN } },
  })
  const mixedRes = driveTask(CTX, mixed)
  assert.equal(mixedRes.status, 'escalation')
  assert.equal(mixedRes.details.escalation.where, 'anchor-absent')
  assert.equal(mixedRes.details.gate.repairs, 0)
  assert.equal(mixed.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
  assert.equal(mixedRes.details.gate.check_discrimination, 'failed')
})

test('b385 B2 an unresolved anchor leaves the whole-gate proof proven and the check verdict unbound', () => {
  const io = b384Io()
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.gate.discrimination, 'proven')
  assert.equal(res.details.gate.check_discrimination, 'unbound')
  assert.equal(res.details.gate.mutation_bind.absent, 1)
  assert.match(res.details.escalation.why, /not a gate defect/)
})

test('b385 C1 a builder correction that binds once and leaves its check failing is accepted', () => {
  const builder = buildEnv({ details: {
    ...buildEnv().details,
    mutation_corrections: [{ check: 'B2', find: B384_CORRECTED_FIND, replace: B384_CORRECTED_REPLACE }],
  } })
  const io = b384Io({ builder, runs: { 'gate-cmd:3': { ok: false, output: B384_RED } } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  const proof = io.calls.emits.find((event) => event.kind === 'check-discrimination')?.checks?.[0]
  assert.deepEqual(proof, { check: 'B2', outcome: 'killed', file: 'crew/drive.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null, correction: 'accepted' })
  const bind = io.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  assert.equal(bind.corrected, 1)
  const absence = io.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: absence.correction, refusal: absence.refusal }, { correction: 'accepted', refusal: null })
})

test('b385 D3 a correction that survives or never adjudicates is refused and escalates', () => {
  const correction = { mutation_corrections: [{ check: 'B2', find: B384_CORRECTED_FIND, replace: B384_CORRECTED_REPLACE }] }
  const greenBuilder = buildEnv({ details: { ...buildEnv().details, ...correction } })
  const greenIo = b384Io({ builder: greenBuilder, runs: { 'gate-cmd:3': { ok: true, output: B384_GREEN } } })
  const green = driveTask(CTX, greenIo)
  assert.equal(green.status, 'escalation')
  assert.equal(green.details.escalation.where, 'anchor-absent')
  assert.match(green.details.escalation.why, /correction-green/)
  assert.equal(green.details.gate.mutation_bind.corrected, 0)
  const greenBind = greenIo.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  const greenAbsence = greenIo.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: green.details.gate.mutation_binds[0].correction, refusal: green.details.gate.mutation_binds[0].correction_refusal }, { correction: 'refused', refusal: 'correction-green' })
  assert.deepEqual({ correction: greenAbsence.correction, refusal: greenAbsence.refusal }, { correction: 'refused', refusal: 'correction-green' })
  assert.equal(greenBind.corrected, 0)
  assert.equal(green.details.gate.repairs, 0)
  assert.equal(greenIo.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)

  const throwBuilder = buildEnv({ details: { ...buildEnv().details, ...correction } })
  const throwIo = b384Io({ builder: throwBuilder, throwMutation: true })
  const thrown = driveTask(CTX, throwIo)
  assert.equal(thrown.status, 'escalation')
  assert.equal(thrown.details.escalation.where, 'anchor-absent')
  assert.match(thrown.details.escalation.why, /correction-unproven/)
  assert.equal(thrown.details.gate.mutation_bind.corrected, 0)
  const throwBind = throwIo.calls.logs.find((line) => line.mutation_anchor_bind)?.mutation_anchor_bind
  const throwAbsence = throwIo.calls.logs.find((line) => line.mutation_anchor_absent)?.mutation_anchor_absent
  assert.deepEqual({ correction: thrown.details.gate.mutation_binds[0].correction, refusal: thrown.details.gate.mutation_binds[0].correction_refusal }, { correction: 'refused', refusal: 'correction-unproven' })
  assert.deepEqual({ correction: throwAbsence.correction, refusal: throwAbsence.refusal }, { correction: 'refused', refusal: 'correction-unproven' })
  assert.equal(throwBind.corrected, 0)
  assert.equal(thrown.details.gate.repairs, 0)
  assert.equal(throwIo.calls.assign.filter(({ role, note }) => role === 'lead' && ['gate-repair', 'gate-fix'].includes(note)).length, 0)
})

test('b385 G1 an all-bind lane pins its legacy proof row byte-identically beside one additive bind row', () => {
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations[0], { check: 'check-one', outcome: 'killed', file: 'a.mjs', summary: { total: 3, failed: 1, errored: 0 }, why: null })
  assert.equal(Object.hasOwn(res.details.gate, 'mutation_bind'), false)
  const binds = io.calls.logs.filter((line) => line.mutation_anchor_bind).map((line) => line.mutation_anchor_bind)
  assert.deepEqual(binds, [{ generation: 1, declared: 1, exact: 1, normalized: 0, absent: 0, corrected: 0, checks: [{ check: 'check-one', file: 'a.mjs', status: 'exact' }] }])
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})

test('a known survivor outranks a later interrupted mutation pass', () => {
  const mutations = [
    CHECK_MUTATION,
    { check: 'second-check', file: 'b.mjs', find: 'true', replace: 'false' },
  ]
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'b.mjs'], gate_cmd: 'gate-cmd', mutations } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT, [`${CTX.checkout}/b.mjs`]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-cmd:3': { ok: true, output: `still green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` },
      'gate-fixed:1': { ok: true, output: '' },
      'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'b.mjs'], emit: true,
  })
  const originalRead = io.readFile
  let bReads = 0
  io.readFile = function (path) {
    // #874 — the FIRST read of b.mjs is the bind preflight and must succeed, so this fixture
    // still reaches the proof loop with both anchors bound. Every read AFTER it throws, exactly
    // as before: generation 1 interrupts on the proof-loop read, after check-one has already
    // survived, and generation 2's own preflight interrupts the same way, leaving it `unproven`
    // with no survivor — which is what generation 2 recorded before this change too.
    if (path === `${CTX.checkout}/b.mjs`) {
      bReads += 1
      if (bReads > 1) throw new Error('second read failed')
    }
    return originalRead.call(this, path)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.generation, 2)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
  assert.equal(first.generation, 1)
  assert.equal(first.verdict, 'failed')
  assert.equal(first.checks[0].outcome, 'survived')
})

test('a mutated gate that errors or omits its summary survives instead of claiming a kill', () => {
  for (const output of [THREW, 'FAIL check-one: red without a summary']) {
    const io = fakeIo({
      files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
      cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: {
        'planner:1': CHECK_PLAN([CHECK_MUTATION]),
        'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
        'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      },
      runs: {
        ...CHECK_RUNS(output),
        'gate-fixed:1': { ok: true, output: '' },
        'gate-fixed:2': { ok: false, output: `FAIL check-one: caught\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":1,"errored":0}` },
      },
      changed: ['a.mjs', 'a.test.mjs'], emit: true,
    })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'done')
    const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
    assert.equal(first.checks[0].outcome, 'survived')
    assert.match(first.checks[0].why, output === THREW ? /THREW/ : /GATE-SUMMARY/)
  }
})

test('the missing-file unapplied branch records its distinct reason and writes nothing', () => {
  const mutation = { ...CHECK_MUTATION, check: 'missing-file', file: 'missing.mjs' }
  const plan = planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'missing.mjs'], gate_cmd: 'gate-cmd', mutations: [mutation] } })
  const io = fakeIo({
    files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true,
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': plan, 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:1': { ok: true, output: '' }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'], emit: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const first = io.calls.emits.find((event) => event.kind === 'check-discrimination')
  assert.equal(first.checks[0].outcome, 'unapplied')
  assert.match(first.checks[0].why, /does not exist/)
  assert.deepEqual(first.checks[0], { check: 'missing-file', outcome: 'unapplied', file: 'missing.mjs', summary: null, why: 'missing.mjs does not exist in the built tree' })
  assert.equal(io.calls.writeLog.filter(({ path }) => path.startsWith(`${CTX.checkout}/`)).length, 0)
})

test('the two pre-build replacement briefs carry fixed identifiers, but an undeclared plan does not', () => {
  const mutations = [CHECK_MUTATION]
  const runBrief = (gate, baseline, declared) => {
    const io = fakeIo({
      cleanRuns: { 'gate-fixed': { ok: false, output: RED(3) } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: gate, ...(declared ? { mutations } : {}) } }),
        'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
        'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      },
      runs: {
        [gate]: baseline, 'gate-fixed': { ok: false, output: RED(3) }, 'gate-fixed:2': { ok: true, output: '' },
        'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
      },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    try { driveTask(CTX, io) } catch { /* the brief is the assertion */ }
    return io.calls.writes[`${TD}/${gate === 'gate-cmd' ? 'gate-vacuous-bounce' : 'gate-defect-bounce'}.md`]
  }
  const vacuous = runBrief('gate-cmd', { ok: true, output: 'green' }, true)
  const defective = runBrief('gate-bad', { ok: false, output: 'no summary' }, true)
  const plain = runBrief('gate-cmd', { ok: true, output: 'green' }, false)
  assert.match(vacuous, /CHECK IDENTIFIERS STABLE/)
  assert.match(vacuous, /check-one/)
  assert.match(defective, /CHECK IDENTIFIERS STABLE/)
  assert.match(defective, /check-one/)
  assert.doesNotMatch(plain, /CHECK IDENTIFIERS STABLE/)
})

test('a null io failure is still an unproven per-check pass, never a proven one', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  io.readFile = () => { throw null }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'unproven')
  assert.match(res.details.gate.check_proof_note, /null/)
})

test('a whole-proof repair brief stays byte-stable when no mutations are declared', () => {
  const io = fakeIo({
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green pristine' }, 'gate-fixed': { ok: false, output: RED(3) } },
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const brief = io.calls.writes[`${TD}/gate-discrimination-bounce.md`]
  assert.equal(typeof brief, 'string')
  assert.doesNotMatch(brief, /CHECK IDENTIFIERS STABLE/)
  assert.doesNotMatch(brief, /Per-check rows:/)
})

test('a longer sibling failure is not the intended check failure', () => {
  const output = `PASS cache\nFAIL cache:v2: reason\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":2,"errored":0}`
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([{ ...CHECK_MUTATION, check: 'cache' }], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }),
    runs: { ...CHECK_RUNS(output), 'gate-cmd:3': { ok: false, output } }, changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'check-discrimination')
  assert.equal(event?.checks?.[0]?.outcome, 'survived')
  assert.match(event?.checks?.[0]?.why, /printed no "FAIL cache" line/)
  assert.equal(res.status, 'escalation')
})

test('mutation outcomes are frozen and every observed row uses the closed vocabulary', () => {
  assert.equal(Object.isFrozen(MUTATION_OUTCOMES), true)
  assert.deepEqual([...MUTATION_OUTCOMES].sort(), ['anchor-absent', 'anchor-ambiguous', 'anchor-unsafe', 'exempt', 'killed', 'survived', 'unapplied'])
})

test('the per-check proof stage is declared by the full variant', () => {
  assert.equal(undeclaredStage(VARIANTS.full, 'gate-proof:1:checks'), null)
  assert.deepEqual(VARIANTS.full.stages, ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review', 'commit', 'rebase', 'suite', 'publish', 'converge'])
})

test('the whole-gate discrimination event retains its five-field shape beside per-check evidence', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  driveTask(CTX, io)
  const event = io.calls.emits.find((entry) => entry.kind === 'discrimination')
  assert.equal(Object.keys(event).sort().join(','), 'generation,kind,note,summary,verdict')
})

test('a per-check pass is only owed after the generation has a whole-gate proof', () => {
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION]), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  const stages = res.details.stages
  assert.ok(stages.indexOf('gate-proof:1') < stages.indexOf('gate-proof:1:checks'))
})

test('the per-check repair brief names the surviving check and keeps identifiers stable', () => {
  const output = `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`
  const io = fakeIo({ files: { [CHECK_FILE]: CHECK_BUILT }, writeThrough: true, cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES([CHECK_MUTATION], { 'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-cmd' } } }),
    runs: { 'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: output }, 'gate-cmd:3': { ok: true, output }, 'gate-cmd:4': { ok: true, output }, 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'] })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  const brief = io.calls.writes[`${TD}/gate-discrimination-bounce.md`]
  assert.match(brief, /CHECK IDENTIFIERS STABLE/)
  assert.match(brief, /check-one/)
})

test('a declared gate without a gate command is a plan defect', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, mutations: [CHECK_MUTATION] } }) } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(res.details.escalation.where, 'plan')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('parseGateSummary: last line wins, and anything malformed reads as ABSENT', () => {
  assert.deepEqual(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":0}`), { total: 3, failed: 3, errored: 0 })
  // A gate that prints twice (an internal re-run): the final line describes the run.
  assert.deepEqual(
    parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":1,"failed":1,"errored":0}\n${GATE_SUMMARY_PREFIX} {"total":9,"failed":2,"errored":1}`),
    { total: 9, failed: 2, errored: 1 },
  )
  assert.equal(parseGateSummary('nothing here'), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} not-json`), null)
  // Absent, NEVER a zero-errored pass: an unparseable summary is not evidence.
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3}`), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":-1}`), null)
  assert.equal(parseGateSummary(`${GATE_SUMMARY_PREFIX} {"total":1.5,"failed":1,"errored":0}`), null)
})

test('baselineGateDefect: names the three ways a non-zero exit is not proof of red', () => {
  assert.equal(baselineGateDefect(RED()), null)
  assert.match(baselineGateDefect('red, no summary'), /printed no GATE-SUMMARY/)
  assert.match(baselineGateDefect(THREW), /1 of 47 checks THREW/)
  assert.match(baselineGateDefect(`${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`), /contradicts the non-zero exit/)
})

test('#153: a baseline whose checks THREW bounces the lead and does NOT spend the gate repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-broken': { ok: false, output: THREW },        // red, but it never RAN
      'gate-fixed:1': { ok: false, output: RED(47) },     // repaired: honestly red
      'gate-fixed:2': { ok: true, output: '' },           // green after the build
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const bounce = Object.values(io.calls.writes).find((w) => /the gate did not RUN/.test(w))
  assert.ok(bounce, 'expected the defective-gate bounce brief')
  assert.match(bounce, /THREW instead of adjudicating/)
  assert.match(bounce, /must be FIXED, not deleted/)
  assert.equal(res.details.gate.cmd, 'gate-fixed')
  assert.deepEqual(res.details.gate.replaced, ['gate-broken'])
  // Pre-build hygiene, not a mid-run gate change: the ONE repair is still unspent.
  assert.equal(res.details.gate.repairs, 0)
})

test('#153: a baseline with no summary line at all is treated as a defective gate', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-silent' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-silent': { ok: false, output: 'red at baseline' },
      'gate-fixed:1': { ok: false, output: RED() }, 'gate-fixed:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.ok(Object.values(io.calls.writes).find((w) => /cannot tell a red gate from a broken one/.test(w)))
})

test('#153: a repaired gate that STILL does not run escalates rather than building against it', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-still-broken' } },
    },
    runs: { 'gate-broken': { ok: false, output: THREW }, 'gate-still-broken': { ok: false, output: THREW } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /STILL does not run at baseline/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0, 'never build against a gate that cannot run')
})

test('#153: a repaired gate that comes back GREEN at baseline escalates as vacuous', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-broken' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-vacuous' } },
    },
    runs: { 'gate-broken': { ok: false, output: THREW }, 'gate-vacuous': { ok: true, output: '' } },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /GREEN at baseline/)
})

test('#440: a vacuous-green baseline repaired into a DEFECTIVE red escalates — a repair may not trade green for broken', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-vacuous-440' } }),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-broken-440' } },
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-vacuous-440': { ok: true, output: '' },
      'gate-broken-440': { ok: false, output: THREW },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation?.why ?? '', /THREW instead of adjudicating/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 0, 'never build against a repaired gate that cannot run')
})

test('#153: an honestly-red baseline is untouched — no bounce, no extra planner round', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-ok' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'gate-ok:1': { ok: false, output: RED() }, 'gate-ok:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 1, 'exactly one planner round')
  assert.equal(Object.values(io.calls.writes).filter((w) => /did not RUN|ran GREEN/.test(w)).length, 0)
})

test('no gate_cmd in the plan -> the loop runs exactly as before (gate stage never appears)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate, null)
  assert.ok(!res.details.stages.some((s) => /^gate/.test(s)))
})

test('every stage transition reaches io.status in order (the live pill feed)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.status, res.details.stages)
})

// --- plan viewer (io.showDoc) -------------------------------------------------

test('the accepted plan is mounted once in the live viewer, on the plan path', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.showDoc, [`${TD}/plan.md`])
})

test("the viewer mounts on the planner's plan_path, not a hardcoded default", () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, plan_path: `${TD}/custom-plan.md` } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(io.calls.showDoc, [`${TD}/custom-plan.md`])
})

test('a bounced plan mounts the viewer once — after acceptance, never twice', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }),
      'lead:1': leadEnv('bounce', 'the brief means X not Y; plan for X'),
      'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc: true,
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.showDoc.length, 1)
  assert.deepEqual(io.calls.showDoc, [`${TD}/plan.md`])
})

test('an io without showDoc drives an identical loop (the additive pin)', () => {
  const mk = (showDoc) => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
    showDoc,
  })
  const withoutDoc = driveTask(CTX, mk(false))
  const withDoc = driveTask(CTX, mk(true))
  assert.equal(withoutDoc.status, 'done')
  assert.equal(withDoc.status, 'done')
  assert.deepEqual(withoutDoc.details.stages, withDoc.details.stages)
})

// --- loop-boundary regressions (the "final-round bounce commits" class) ------
// A granted bounce must always land in a REAL round; the finish block runs
// only via review:pass or an explicit lead accept. These pin the fix for the
// class where lane-red/gate-red/builder-insufficient work reached commit.

test('final-round lane red + lead grants bounce -> a REAL extra round runs; commit only after review pass', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'lead:1': leadEnv('bounce', 'the lane fails on X; fix X'),
      'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'red' }, 'lane-cmd:2': { ok: false, output: 'red' },
      'lane-cmd:3': { ok: false, output: 'red' }, 'lane-cmd:4': { ok: true, output: '' },
      'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4) // the granted bounce GOT its round
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 1) // and review still happened
  assert.equal(res.details.accepted_via, 'review pass')
})

test('final-round lane red, granted bounce STILL red, lead then escalates -> escalation, NO commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: false, output: 'red forever' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
})

test('builder insufficient on the FINAL round + granted bounce -> re-assigned, never a stale-envelope commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), // good round 1
      'builder:2': buildEnv({ status: 'insufficient' }), 'builder:3': buildEnv({ status: 'insufficient' }),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'), 'lead:3': leadEnv('bounce'),
      'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  // round 1 built+reviewed(changes-needed) -> r2/r3 insufficient (r3 is final: bounce extends) -> r4 builds -> review pass
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(res.details.accepted_via, 'review pass')
})

test('unreadable reviewer verdict + granted bounce re-asks the REVIEWER in place — the builder is NOT re-run', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { verdict: 'maybe?' } },
      'lead:1': leadEnv('bounce'),
      'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 1)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
})

test('an envelope with a MISMATCHED assignment_id is rejected (stale-file replay guard)', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ assignment_id: 'd9-from-a-previous-run' }) },
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope/)
})

test('an envelope carrying its OWN assignment_id is accepted', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ assignment_id: 'planner1' }), // fakeIo ids are `${role}${n}`
      'builder:1': buildEnv({ assignment_id: 'builder1' }),
      'reviewer:1': { ...reviewEnv('pass'), assignment_id: 'reviewer1' },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX, io).status, 'done')
})

test('accepted_via records a lead accept-with-residuals distinctly from a review pass', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'lead:1': leadEnv('accept'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.match(res.details.accepted_via, /residuals/)
  assert.match(res.summary, /residuals/)
  assert.doesNotMatch(res.summary, /review pass/) // the envelope never asserts a review that did not happen
})

test('escalation artifacts and exhaustion briefs cite the REAL journal path from ctx', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': leadEnv('escalate') },
  })
  const res = driveTask({ ...CTX, journal: '/real/crew/journal.jsonl' }, io)
  assert.equal(res.status, 'escalation')
  assert.ok(res.artifacts.includes('/real/crew/journal.jsonl'))
  assert.ok(!res.artifacts.some((a) => a === `${TD}/journal.jsonl`))
})

test('a gate repair records the replaced command in the gate audit trail', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong target' } },
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
      'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: 'baseline red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}' },
      'gate-bad:2': { ok: false, output: 'fail A' }, 'gate-bad:3': { ok: false, output: 'fail B' },
      'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.deepEqual(res.details.gate.replaced, ['gate-bad'])
})

// --- lead-optional driver (mechanical tier) -----------------------------------

test('lead-less: a planner insufficient escalates naming "no lead seated" and the original question, with zero lead assigns', () => {
  const ctx = { ...CTX, roles: ['planner', 'builder', 'reviewer'] }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ status: 'insufficient', summary: 'brief ambiguous' }) },
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /no lead seated/)
  assert.match(res.details.escalation.why, /brief ambiguous/)
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  // an escalation envelope carries no consult count by design (drive.mjs:204-212)
  assert.equal(res.details.consults, undefined)
})

test('lead-less happy path: plan -> build -> gates -> review pass -> suite -> commit, zero lead assigns, consults === 0', () => {
  const ctx = { ...CTX, roles: ['planner', 'builder', 'reviewer'] }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(ctx, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'lead').length, 0)
  assert.equal(res.details.consults, 0)
  assert.equal(io.calls.commits.length, 1)
})

test('DECISIONS and LIMITS are the frozen public contract', () => {
  assert.ok(Object.isFrozen(DECISIONS) && Object.isFrozen(LIMITS))
  assert.deepEqual([...DECISIONS], ['bounce', 'bounce-builder', 'bounce-reviewer', 'accept', 'escalate'])
  assert.equal(SECOND_OPINION, 'second-opinion')
  assert.ok(Object.isFrozen(PERSPECTIVE_TARGETS))
})

test('emit mirrors every stage transition in order', () => {
  const io = fakeIo({
    emit: true,
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.deepEqual(io.calls.emits.filter((e) => e.kind === 'stage').map((e) => e.label), res.details.stages)
})

test('emit mirrors assignments and envelope returns, including insufficient returns', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }), 'lead:1': leadEnv('bounce'), 'planner:2': planEnv(),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const assigns = io.calls.emits.filter((e) => e.kind === 'assign')
  const envelopes = io.calls.emits.filter((e) => e.kind === 'envelope')
  assert.equal(assigns.length, envelopes.length)
  assert.ok(assigns.some((e) => e.role === 'planner' && e.id === 'planner1'))
  assert.ok(envelopes.some((e) => e.role === 'planner' && e.status === 'insufficient'))
  for (const e of [...assigns, ...envelopes]) assert.ok(e.id && e.role)
})

test('reviewer envelope events carry normalized outcomes while planner and builder events do not', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  const envelopes = io.calls.emits.filter((event) => event.kind === 'envelope')
  const reviewer = envelopes.find((event) => event.role === 'reviewer')
  assert.deepEqual(reviewer.review, { verdict: 'changes-needed', must_fix: 1, should_fix: null, consider: null })
  assert.ok(envelopes.filter((event) => event.role !== 'reviewer').every((event) => !('review' in event)))
  assert.deepEqual(io.calls.logs.find((line) => line.review_outcome).review_outcome, {
    dispatch: 'reviewer1', verdict: 'changes-needed', must_fix: 1, should_fix: null, consider: null,
  })
})

test('emit mirrors lead decisions and dissents', () => {
  const io = fakeIo({
    emit: true,
    envelopes: {
      'planner:1': planEnv({ status: 'insufficient' }),
      'lead:1': { status: 'done', role: 'lead', details: { decision: SECOND_OPINION, from: 'reviewer' } },
      'reviewer:1': { status: 'done', role: 'reviewer', details: { perspective: 'residuals matter', recommendation: 'escalate', confidence: 'high' } },
      'lead:2': leadEnv('bounce'), 'planner:2': planEnv(), 'builder:1': buildEnv(),
      'reviewer:2': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  driveTask(CTX, io)
  assert.ok(io.calls.emits.some((e) => e.kind === 'decision' && e.decided === 'bounce'))
  assert.ok(io.calls.emits.some((e) => e.kind === 'dissent' && e.from === 'reviewer' && e.recommendation === 'escalate' && e.lead_decision === 'bounce'))
})

test('a throwing io.emit changes nothing', () => {
  const input = {
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  }
  const plainIo = fakeIo(input)
  const plain = driveTask(CTX, plainIo)
  const noisyIo = fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } })
  const noisy = driveTask(CTX, noisyIo)
  assert.deepEqual(noisy, plain)
  assert.deepEqual(noisyIo.calls.run, plainIo.calls.run)
  assert.deepEqual(noisyIo.calls.runClean, plainIo.calls.runClean)
})

test('an absent emitter leaves the envelope and gate proof calls unchanged', () => {
  const input = {
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: false, output: RED(3) } },
    changed: ['a.mjs', 'a.test.mjs'],
  }
  const absentIo = fakeIo(input)
  const throwingIo = fakeIo({ ...input, emit: () => { throw new Error('ledger unavailable') } })
  const absent = driveTask(CTX, absentIo)
  const throwing = driveTask(CTX, throwingIo)
  assert.deepEqual(absent, throwing)
  assert.deepEqual(absentIo.calls.run, throwingIo.calls.run)
  assert.deepEqual(absentIo.calls.runClean, throwingIo.calls.runClean)
})

test('review exhaustion at a non-final build round grants a real round and review', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX, limits: { build_rounds: 4 } }, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 3)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'review', round: 3 }])
})

test('review grant bounce brief is code-composed from the review path', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('pass'),
      'lead:1': leadEnv('bounce', 'misleading guidance that must not become the brief'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  const brief = Object.entries(io.calls.writes).find(([path]) => /build-bounce-r3\.md$/.test(path))?.[1]
  assert.match(brief, new RegExp(`${TD}/review\\.md`))
  assert.doesNotMatch(brief, /misleading guidance/)
})

test('final build-round review revise can buy one round and its review decides', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: {
      'lane-cmd:1': { ok: false, output: 'red' }, 'lane-cmd:2': { ok: false, output: 'red' },
      'lane-cmd:3': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'builder').length, 4)
  assert.equal(io.calls.assign.filter((a) => a.role === 'reviewer').length, 2)
  assert.equal(res.details.accepted_via, 'review pass')
})

test('review grant cap refuses a second bounce and escalates without commit', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'), 'reviewer:3': reviewEnv('changes-needed'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  const decisions = Object.entries(io.calls.writes).filter(([path]) => /decision-\d+b?\.md$/.test(path)).map(([, body]) => body)
  assert.equal(decisions.filter((body) => /^- bounce-builder$/m.test(body)).length, 1)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'review', round: 3 }])
})

test('plan-check exhaustion can buy one plan round and re-check it', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('approve'),
      'lead:1': leadEnv('bounce'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.assign.filter((a) => a.role === 'planner').length, 3)
  assert.equal(io.calls.assign.filter((a) => a.role === 'tech-lead').length, 3)
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'plan-check', round: 2 }])
})

test('plan-check grant cap refuses a second bounce and escalates', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('revise'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'escalation')
  assert.deepEqual(res.details.extra_rounds_granted, [{ where: 'plan-check', round: 2 }])
  const decisions = Object.entries(io.calls.writes).filter(([path]) => /decision-\d+b?\.md$/.test(path)).map(([, body]) => body)
  assert.equal(decisions.filter((body) => /^- bounce$/m.test(body)).length, 1)
})

test('done and escalation envelopes always record the grant list, including empty happy paths', () => {
  const done = driveTask(CTX, fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs', 'a.test.mjs'],
  }))
  assert.deepEqual(done.details.extra_rounds_granted, [])
  const escalated = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv({ status: 'blocked' }), 'lead:1': leadEnv('escalate') } }))
  assert.deepEqual(escalated.details.extra_rounds_granted, [])
})

test('growthRecord and growthLines use the cumulative two-times threshold and null evidence', () => {
  assert.equal(GROWTH_DIVERGENCE_FACTOR, 2)
  const first = growthRecord(null, null, { round: 1, plan_bytes: 100, gate_bytes: 100, files_in_scope_count: 2 })
  assert.deepEqual(first, {
    round: 1, plan_bytes: 100, gate_bytes: 100, plan_delta: null, gate_delta: null,
    combined_bytes: 200, round1_combined_bytes: null, files_in_scope_count: 2,
    ratio: null, divergent: false,
  })
  const doubled = growthRecord(first, first, { round: 2, plan_bytes: 200, gate_bytes: 200, files_in_scope_count: 2 })
  assert.equal(doubled.plan_delta, 100)
  assert.equal(doubled.gate_delta, 100)
  assert.equal(doubled.round1_combined_bytes, 200)
  assert.equal(doubled.ratio, 2)
  assert.equal(doubled.divergent, true)
  const under = growthRecord(first, first, { round: 2, plan_bytes: 199, gate_bytes: 199, files_in_scope_count: 2 })
  assert.equal(under.ratio, 1.99)
  assert.equal(under.divergent, false)
  const nulls = growthRecord(null, null, { round: 1, plan_bytes: null, gate_bytes: null, files_in_scope_count: null })
  assert.equal(nulls.combined_bytes, null)
  assert.match(growthLines(nulls).join('\n'), /plan_bytes=null.*gate_bytes=null.*combined_bytes=null.*ratio=null.*divergent=false/)
})

const divergentPlanScenario = (leadDecision) => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }),
      'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(20)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:3': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv(leadDecision),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  return { io, result: driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io) }
}

test('a diverging plan round reaches the deciding seat one round early', () => {
  const { io, result } = divergentPlanScenario('escalate')
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-check')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 2)
})

test('the divergence consult names the measured ratio, not merely the fact', () => {
  const { io } = divergentPlanScenario('escalate')
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  assert.match(decision, /DIVERGENCE/)
  assert.match(decision, /round 1's 20/)
  assert.match(decision, /40 bytes/)
  assert.match(decision, /ratio 2/)
})

test('a diverging round leaves bounce, accept and escalate all open', () => {
  const { io } = divergentPlanScenario('escalate')
  const decision = io.calls.writes[`${TD}/decision-1.md`]
  for (const option of ['bounce', 'accept', 'escalate']) assert.match(decision, new RegExp(`^- ${option}$`, 'm'))
})

test('a bounce at a diverging round is funded by the rounds that remain, not by a grant', () => {
  const { io, result } = divergentPlanScenario('bounce')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 3)
  assert.deepEqual(result.details.extra_rounds_granted, [])
})

const divergeThenExhaustPlanScenario = () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }),
      'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(20)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(10)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(10)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:3': checkEnv('revise'),
      'planner:4': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:4': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  return { io, result: driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io) }
}

test('an early divergence consult precedes the exhaustion consult, it does not replace it', () => {
  const { io, result } = divergeThenExhaustPlanScenario()
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.deepEqual(result.details.extra_rounds_granted, [{ where: 'plan-check', round: 3 }])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 4)
})

test('a round below the ratified factor surfaces nothing', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(19)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:3': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(Object.keys(io.calls.writes).some((path) => /decision-\d+b?\.md$/.test(path)), false)
})

const persistentDivergenceScenario = () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  const growingPlan = () => {
    io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
    io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(20)
    return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
  }
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('revise'),
      'planner:2': growingPlan, 'tech-lead:2': checkEnv('revise'),
      'planner:3': growingPlan, 'tech-lead:3': checkEnv('revise'),
      'planner:4': growingPlan, 'tech-lead:4': checkEnv('revise'),
      'planner:5': growingPlan, 'tech-lead:5': checkEnv('revise'),
      'planner:6': growingPlan, 'tech-lead:6': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  return { io, result: driveTask({ ...CTX_TL, limits: { plan_rounds: 5 } }, io) }
}

test('a persistent divergence consults once before exhaustion and preserves its grant', () => {
  const { io, result } = persistentDivergenceScenario()
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.deepEqual(result.details.extra_rounds_granted, [{ where: 'plan-check', round: 5 }])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 6)
})

const bothExhaustionPointsScenario = (secondReviewLead = null) => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'planner:2': planEnv(), 'planner:3': planEnv(),
      'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('revise'), 'tech-lead:3': checkEnv('approve'),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('changes-needed'),
      'reviewer:3': reviewEnv(secondReviewLead ? 'changes-needed' : 'pass'),
      'lead:1': leadEnv('bounce'), 'lead:2': leadEnv('bounce'), 'lead:3': leadEnv(secondReviewLead || 'bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  return { io, result: driveTask(CTX_TL, io) }
}

test('a plan-check grant leaves a review-exhaustion grant available', () => {
  const { result } = bothExhaustionPointsScenario()
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.extra_rounds_granted, [
    { where: 'plan-check', round: 2 }, { where: 'review', round: 3 },
  ])
})

test('the per-point bound still holds at each point', () => {
  const { io, result } = bothExhaustionPointsScenario('bounce')
  assert.equal(result.status, 'escalation')
  assert.deepEqual(result.details.extra_rounds_granted, [
    { where: 'plan-check', round: 2 }, { where: 'review', round: 3 },
  ])
  assert.doesNotMatch(io.calls.writes[`${TD}/decision-3.md`], /^- bounce$/m)
})

const HEALTHY_RESULT = {
  status: 'done',
  summary: 'Task t1 complete: committed abc1234 (2 files), suite green, cold-verified from /zz/aa11bb, review pass. Stages: plan:r1 | check:r1 | build:r1 | scope-gate:r1 | lane:r1 | review:r1 | review:pass | commit | suite | suite:cold | done',
  artifacts: [`${TD}/plan.md`, `${TD}/review.md`, `${TD}/journal.jsonl`],
  details: {
    commit: 'abc1234',
    stages: ['plan:r1', 'check:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'],
    files_committed: ['a.mjs', 'a.test.mjs'],
    consults: 0,
    dissents: [],
    accepted_via: 'review pass',
    escalation: null,
    cold_suite: { verdict: 'green', path: '/zz/aa11bb', counts: null },
    extra_rounds_granted: [],
    growth: [{
      round: 1, plan_bytes: null, gate_bytes: null, plan_delta: null, gate_delta: null,
      combined_bytes: null, round1_combined_bytes: null, files_in_scope_count: 2,
      ratio: null, divergent: false,
    }],
    modifiers: [],
    gate: null,
  },
}

test('a run that exhausts nothing and diverges on nothing is unchanged', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.deepEqual(result, HEALTHY_RESULT)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(io.calls.commits.length, 1)
})

test('the unexhausted plan path keeps its diagnostics unchanged', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.deepEqual(Object.keys(result.details).sort(), [
    'accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'escalation', 'extra_rounds_granted',
    'files_committed', 'gate', 'growth', 'modifiers', 'stages',
  ])
  assert.deepEqual(result.details.stages, ['plan:r1', 'check:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.equal(io.calls.logs.filter((entry) => entry.accept_decision).length, 0)
  assert.equal(io.calls.assign.some(({ role }) => role === 'lead'), false)
  assert.equal(Object.keys(io.calls.writes).some((path) => /decision-\d+b?\.md$/.test(path)), false)
})

test('divergenceConsultLines only describes a measured divergent record', () => {
  assert.deepEqual(divergenceConsultLines(null), [])
  assert.deepEqual(divergenceConsultLines({ divergent: false }), [])
  assert.deepEqual(divergenceConsultLines(42), [])
  const lines = divergenceConsultLines({ divergent: true, round: 2, combined_bytes: 40, round1_combined_bytes: 20, ratio: 2 })
  assert.match(lines.join('\n'), /round 2/)
  assert.match(lines.join('\n'), /40 bytes/)
  assert.match(lines.join('\n'), /20/)
  assert.match(lines.join('\n'), /ratio 2/)
})

test('divergent growth is evidence in both the round-2 check and revision briefs, never a verdict', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }),
      'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(30)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(30)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('revise'),
      'planner:3': planEnv({ details: { ...details, carve_verdict: 'proceed' } }),
      'tech-lead:3': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': leadEnv('bounce'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask({ ...CTX_TL, limits: { plan_rounds: 3 } }, io)
  assert.equal(res.status, 'done')
  const check = io.calls.writes[`${TD}/check-brief-r2.md`]
  const bounce = io.calls.writes[`${TD}/plan-bounce-r2.md`]
  for (const brief of [check, bounce]) {
    assert.match(brief, /divergent=true/)
    assert.match(brief, /plan_bytes=30/)
    assert.match(brief, /gate_bytes=30/)
    assert.match(brief, /files_in_scope=2/)
  }
  assert.deepEqual(res.details.growth.map((record) => record.round), [1, 2, 3])
})

test('round-2 growth below two-times cumulative remains non-divergent', () => {
  const files = { [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) }
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(20)
        return planEnv({ details: { ...details, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.match(io.calls.writes[`${TD}/check-brief-r2.md`], /combined_bytes=30/)
  assert.match(io.calls.writes[`${TD}/check-brief-r2.md`], /divergent=false/)
})

test('missing plan and unreadable gate are null evidence with the same run outcome', () => {
  const details = { ...planEnv().details, gate_path: `${TD}/gate.mjs` }
  const scenario = (files) => {
    const io = fakeIo({
      files,
      envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
      runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
      changed: ['a.mjs', 'a.test.mjs'],
    })
    return { io, result: driveTask(CTX_TL, io) }
  }
  const missing = scenario({})
  const present = scenario({ [`${TD}/plan.md`]: 'x'.repeat(10), [`${TD}/gate.mjs`]: 'x'.repeat(10) })
  assert.equal(missing.result.status, 'done')
  assert.equal(present.result.status, 'done')
  assert.deepEqual(missing.result.details.stages, present.result.details.stages)
  assert.match(missing.io.calls.writes[`${TD}/check-brief-r1.md`], /plan_bytes=null.*gate_bytes=null/s)
})

test('a gate path outside the task dir is rejected and cannot alter the run', () => {
  const outside = '/tmp/outside-growth-gate.mjs'
  const details = { ...planEnv().details, gate_path: outside }
  const io = fakeIo({
    files: { [`${TD}/plan.md`]: 'x'.repeat(10), [outside]: 'x'.repeat(500) },
    envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.growth[0].gate_bytes, null)
  assert.ok(io.calls.logs.some((line) => line.gate_path_rejected === outside))
})

test('an omitted gate_path journals an explicit null rejection value', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  assert.equal(driveTask(CTX_TL, io).status, 'done')
  const rejection = io.calls.logs.find((line) => Object.hasOwn(line, 'gate_path_rejected'))
  assert.ok(rejection)
  assert.equal(rejection.gate_path_rejected, null)
  assert.deepEqual(JSON.parse(JSON.stringify(rejection)), { at: 0, gate_path_rejected: null, channel: 'record' })
})

test('a wildly divergent run still reaches commit', () => {
  const files = { [`${TD}/plan.md`]: 'x', [`${TD}/gate.mjs`]: 'x' }
  let io
  io = fakeIo({
    files,
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': () => {
        io.calls.files[`${TD}/plan.md`] = 'x'.repeat(1000)
        io.calls.files[`${TD}/gate.mjs`] = 'x'.repeat(1000)
        return planEnv({ details: { ...planEnv().details, gate_path: `${TD}/gate.mjs`, carve_verdict: 'proceed' } })
      },
      'tech-lead:2': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const res = driveTask(CTX_TL, io)
  assert.equal(res.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(res.details.growth[1].divergent, true)
})

test('validateCarve enforces the closed verdict and first-slice scope contract', () => {
  for (const verdict of [undefined, null, 'PROCEED', 'split']) {
    const result = validateCarve({ carve_verdict: verdict })
    assert.equal(result.verdict, null)
    assert.equal(result.slices.length, 0)
    assert.ok(result.why)
  }
  assert.deepEqual(validateCarve({ carve_verdict: 'proceed' }), { verdict: 'proceed', slices: [], defect: null, why: null })
  const good = validateCarve({
    carve_verdict: 'carve',
    carve_slices: [
      { summary: ' first ', files_in_scope: ['a.mjs'], extra: 'drop me' },
      { summary: 'second', files_in_scope: ['b.mjs'] },
    ],
  })
  assert.deepEqual(good, {
    verdict: 'carve', slices: [
      { summary: 'first', files_in_scope: ['a.mjs'] },
      { summary: 'second', files_in_scope: ['b.mjs'] },
    ], defect: null, why: null,
  })
  for (const carve_slices of [[], null, {}, [{ summary: 'bad', files_in_scope: ['../bad'] }]]) {
    const result = validateCarve({ carve_verdict: 'carve', carve_slices })
    assert.equal(result.verdict, 'carve')
    assert.ok(result.defect)
  }
})

const planRevisionRun = (revision, over = {}) => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('revise'),
      'planner:2': revision, 'tech-lead:2': checkEnv('approve'),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], ...over,
  })
  return { io, result: driveTask(CTX_TL, io) }
}

test('a plan revision without carve_verdict escalates before check:r2', () => {
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: undefined } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.ok(!result.details.stages.includes('check:r2'))
})

test('a proceed verdict continues to check:r2', () => {
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'proceed' } }))
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('check:r2'))
})

test('a valid carve escalates with its sanitized slices and no lead consult', () => {
  const slices = [
    { summary: 'slice one', files_in_scope: ['a.mjs'] },
    { summary: 'slice two', files_in_scope: ['b.mjs'] },
  ]
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'carve', carve_slices: slices } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.deepEqual(result.details.carve.slices, slices)
  assert.equal(result.details.consults, undefined)
})

test('a malformed carve list escalates carrying a defect', () => {
  const { result } = planRevisionRun(planEnv({ details: { ...planEnv().details, carve_verdict: 'carve', carve_slices: [] } }))
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-carve')
  assert.ok(result.details.carve.defect)
})

test('round 1 does not require a carve verdict', () => {
  const details = { ...planEnv().details }
  delete details.carve_verdict
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details }), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_TL, io)
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('build:r1'))
})

test('a gate-repair lead dispatch is not mistaken for a plan revision carve check', () => {
  const repaired = planEnv({ role: 'lead', details: { ...planEnv().details, gate_cmd: 'gate-fixed' } })
  delete repaired.details.carve_verdict
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'wrong gate' } },
      'lead:1': repaired, 'reviewer:2': reviewEnv('pass'),
    },
    runs: {
      'gate-bad:1': { ok: false, output: RED(3) }, 'gate-bad:2': { ok: false, output: 'fail one' },
      'gate-bad:3': { ok: false, output: 'fail two' }, 'gate-fixed': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(!result.details.stages.includes('escalate:plan-carve'))
})

// --- converge terminal (#207) ---
const CONVERGE_CTX = Object.freeze({
  ...CTX,
  limits: { plan_rounds: 1, build_rounds: 1, review_rounds: 1 },
})
const CONVERGE_PLAN = () => planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd', commit_subject: 'feat: converge' } })
const CONVERGE_GATE = RED(3)

function convergeIo({ seam = true, suite = { ok: true, output: '' }, issueThrows = false, prThrows = false, findings = null, slots = null, now = null } = {}) {
  return fakeIo({
    envelopes: {
      'planner:1': CONVERGE_PLAN(),
      'builder:1': buildEnv(),
      'lead:1': leadEnv('escalate', 'the gate names its red checks'),
    },
    runs: {
      'gate-cmd': { ok: false, output: CONVERGE_GATE },
      'lane-cmd': { ok: true, output: '' },
      'suite-cmd': suite,
    },
    changed: ['a.mjs'],
    ...(typeof slots === 'function' ? { slots } : {}),
    ...(typeof now === 'function' ? { now } : {}),
    ...(findings ? {
      envelopes: {
        'planner:1': CONVERGE_PLAN(),
        'builder:1': buildEnv(),
        'reviewer:1': {
          status: 'done', role: 'reviewer',
          details: { verdict: 'changes-needed', defect: 'build', findings, must_fix: 1, should_fix: 1, consider: 0 },
        },
        'lead:1': leadEnv('escalate', 'the gate names its red checks'),
      },
    } : {}),
    ...(seam ? { gh: { issueThrows, prThrows } } : {}),
  })
}

function convergeRun(options = {}) {
  const { ctx = CONVERGE_CTX, ...ioOptions } = options
  const io = convergeIo(ioOptions)
  return { io, result: driveTask(ctx, io) }
}

const slotCtx = (over = {}) => ({ ...CTX, env: { CREW_SUITE_SLOTS: '4' }, ...over })
const slotFactory = ({ refusals = [], throwOnAcquire = null } = {}) => (_spec, calls) => (
  fakePool({ calls, refusals, throwOnAcquire })
)
const phaseTrace = (calls, phase, runner) => {
  const labels = traceLabels(calls)
  const acquireIndex = calls.trace.findIndex((entry) => entry?.label === `acquire:${phase}` && entry.handle)
  assert.notEqual(acquireIndex, -1, `missing successful ${phase} acquire: ${JSON.stringify(labels)}`)
  const acquire = calls.trace[acquireIndex]
  const runIndex = labels.findIndex((label, index) => index > acquireIndex && label === runner)
  assert.notEqual(runIndex, -1, `missing ${runner} after ${phase} acquire: ${JSON.stringify(labels)}`)
  const releaseLabel = `release:${acquire.handle.slot}`
  const releaseIndex = labels.findIndex((label, index) => index > runIndex && label === releaseLabel)
  assert.notEqual(releaseIndex, -1, `missing ${releaseLabel}: ${JSON.stringify(labels)}`)
  assert.ok(acquireIndex < runIndex && runIndex < releaseIndex)
  return { acquire, acquireIndex, runIndex, releaseIndex }
}

const directSlotRun = ({ phase, refusals = [], now = () => 0, emit = () => {} } = {}) => {
  const calls = { trace: [] }
  const rows = []
  const result = withPhaseSlot({
    pool: fakePool({ calls, refusals }), phase, owner: `slot-test:${phase}`, now,
    sleep: () => {}, log: (row) => rows.push(row), emit,
  }, () => 'phase-result')
  return { calls, rows, result }
}

test('b382 A1 an acceptance gate run takes and gives back a suite slot', () => {
  const io = closeoutIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED(3) }, 'gate-cmd:2': { ok: true, output: '' },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    slots: slotFactory(),
  })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'gate', 'run:gate-cmd')
})

test('b382 A2 the release-gate full suite takes and gives back a suite slot', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'suite-warm', 'run:suite-cmd')
})

test('b382 A3 the cold verification suite takes and gives back a suite slot', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'done')
  phaseTrace(io.calls, 'suite-cold', 'runCold:suite-cmd')
})

test('b382 A4 the converge full suite takes and gives back a suite slot', () => {
  const { io, result } = convergeRun({
    ctx: slotCtx({ ...CONVERGE_CTX, env: { CREW_SUITE_SLOTS: '4' } }),
    slots: slotFactory(),
  })
  assert.equal(result.status, 'converge')
  phaseTrace(io.calls, 'suite-warm', 'run:suite-cmd')
})

test('b382 B1 a cold suite that throws releases its slot before escalating', () => {
  const io = closeoutIo({ cold: 'throw', slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.details.escalation.where, 'cold-suite')
  const event = phaseTrace(io.calls, 'suite-cold', 'runCold:suite-cmd')
  assert.ok(event.releaseIndex < io.calls.trace.length)
})

test('b382 B2 a wait-row failure releases the acquired slot before the driver escalates', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const originalLog = io.log
  let rowFailure = false
  io.log = function (row) {
    if (!rowFailure && row?.event === PHASE_SLOT_WAIT_EVENT) {
      rowFailure = true
      throw new Error('phase-slot wait journal write failed')
    }
    return originalLog.call(this, row)
  }
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'driver')
  assert.match(result.details.escalation.why, /phase-slot wait journal write failed/)
  const acquire = io.calls.trace.find((entry) => entry?.label === 'acquire:suite-warm' && entry.handle)
  assert.ok(acquire)
  assert.ok(io.calls.trace.some((entry) => entry?.label === `release:${acquire.handle.slot}`))
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('b382 C1 the admission row names the phase that waited', () => {
  for (const phase of SUITE_SLOT_PHASE_NAMES) {
    const { rows } = directSlotRun({ phase })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, phase)
  }
})

test('b382 C2 the admission row carries the occupancy the last scan measured', () => {
  const measured = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [3] })
  assert.equal(measured.rows[0].queue_depth, 3)
  const unknown = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [null] })
  assert.equal(unknown.rows[0].queue_depth, null)
  assert.notEqual(unknown.rows[0].queue_depth, 0)
})

test('b382 C3 the admission row carries the measured waited_ms', () => {
  let clock = 0
  const { rows } = directSlotRun({
    phase: SUITE_SLOT_PHASES.warm, refusals: [3],
    now: () => { clock += 2000; return clock },
  })
  assert.equal(rows[0].waited_ms, 8000)
})

test('b382 D1 a queued phase keeps emitting liveness heartbeats while it waits', () => {
  const beats = []
  const { rows } = directSlotRun({ phase: SUITE_SLOT_PHASES.warm, refusals: [1, 2], emit: (event) => beats.push(event) })
  assert.equal(rows.length, 1)
  assert.equal(beats.length, 2)
  assert.ok(beats.every((event) => event.kind === 'heartbeat' && Number.isFinite(event.at)))
})

test('b382 E1 an unconfigured capacity still queues at the core-derived capacity', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: {} }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 1)
  assert.equal(io.calls.slotFactories[0].capacity, Math.max(2, Math.floor(osCpus().length / 6)))
  assert.equal(io.calls.slotFactories[0].kind, 'suite')
  assert.ok(io.calls.trace.some((entry) => entry?.label?.startsWith('acquire:')))
})

const ZERO_CAPACITY_RESULT = Object.freeze({
  status: 'done',
  summary: 'Task t1 complete: committed abc1234 (2 files), suite green, cold-verified from /zz/aa11bb, review pass. Stages: plan:r1 | build:r1 | scope-gate:r1 | lane:r1 | review:r1 | review:pass | commit | suite | suite:cold | done',
  artifacts: ['/tmp/fake-task/plan.md', '/tmp/fake-task/review.md', '/tmp/fake-task/journal.jsonl'],
  details: {
    commit: 'abc1234',
    stages: ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'],
    files_committed: ['a.mjs', 'a.test.mjs'],
    consults: 0,
    dissents: [],
    accepted_via: 'review pass',
    escalation: null,
    cold_suite: { verdict: 'green', path: '/zz/aa11bb', counts: null },
    extra_rounds_granted: [],
    growth: [{
      round: 1, plan_bytes: null, gate_bytes: null, plan_delta: null, gate_delta: null,
      combined_bytes: null, round1_combined_bytes: null, files_in_scope_count: 2, ratio: null, divergent: false,
    }],
    modifiers: [],
    gate: null,
  },
})
const ZERO_CAPACITY_LOGS = Object.freeze([
  { stage: 'plan:r1', channel: 'record' },
  { assign: 'planner1', role: 'planner', brief: '/tmp/brief.md', channel: 'record' },
  { envelope: 'planner1', role: 'planner', status: 'done', channel: 'record' },
  { plan_scope: { round: 1, verdict: 'plan-scope-undispatched', added: [], dropped: [], dispatched: null, planned: 2 }, channel: 'record' },
  { gate_path_rejected: null, channel: 'record' },
  { plan_growth: { round: 1, plan_bytes: null, gate_bytes: null, plan_delta: null, gate_delta: null, combined_bytes: null, round1_combined_bytes: null, files_in_scope_count: 2, ratio: null, divergent: false }, channel: 'record' },
  { stage_done: 'plan:r1', channel: 'record' },
  { stage: 'build:r1', channel: 'record' },
  { assign: 'builder1', role: 'builder', brief: '/tmp/fake-task/plan.md', channel: 'record' },
  { envelope: 'builder1', role: 'builder', status: 'done', channel: 'record' },
  { stage_done: 'build:r1', channel: 'record' },
  { stage: 'scope-gate:r1', channel: 'record' },
  { stage_done: 'scope-gate:r1', channel: 'record' },
  { stage: 'lane:r1', channel: 'record' },
  { stage_done: 'lane:r1', channel: 'record' },
  { stage: 'review:r1', channel: 'record' },
  { assign: 'reviewer1', role: 'reviewer', brief: '/tmp/fake-task/review-brief-1.md', channel: 'record' },
  { review_outcome: { dispatch: 'reviewer1', verdict: 'pass', must_fix: 0, should_fix: null, consider: null }, channel: 'record' },
  { envelope: 'reviewer1', role: 'reviewer', status: 'done', channel: 'record' },
  { review_round: { n: 1, verdict: 'pass', accounting: 'free', charged: 0 }, channel: 'record' },
  { stage_done: 'review:r1', channel: 'record' },
  { stage: 'review:pass', channel: 'record' },
  { stage_done: 'review:pass', channel: 'record' },
  { stage: 'commit', channel: 'record' },
  { commit_subject: 'fallback-from-plan-summary', channel: 'record' },
  { stage_done: 'commit', channel: 'record' },
  { stage: 'suite', channel: 'record' },
  { stage_done: 'suite', channel: 'record' },
  { stage: 'suite:cold', channel: 'record' },
  { cold_suite: { verdict: 'green', path: '/zz/aa11bb', counts: null }, channel: 'record' },
  { stage_done: 'suite:cold', channel: 'record' },
  { stage: 'done', channel: 'record' },
  { stage_done: 'done', channel: 'record' },
])
const normaliseJournalTimes = (rows) => rows.map(({ at: _at, ...row }) => row)

test('b382 E2 a zero capacity run behaves exactly as the pre-feature driver', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: '0' } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 0)
  assert.equal(io.calls.logs.some((row) => row.event === PHASE_SLOT_WAIT_EVENT), false)
  assert.deepEqual(result, ZERO_CAPACITY_RESULT)
  assert.deepEqual(normaliseJournalTimes(io.calls.logs), ZERO_CAPACITY_LOGS)
  assert.deepEqual(io.calls.trace, ['run:lane-cmd', 'run:suite-cmd', 'runCold:suite-cmd'])
})

test('b382 R1 the driver leases from the dispatcher\'s relocated factory root', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: '4', DEVTEAM_LEDGER_DIR: '/tmp/b382-relocated-factory' } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.slotFactories.length, 1)
  assert.equal(io.calls.slotFactories[0].dir, '/tmp/b382-relocated-factory')
})

test('b382 S1 an acquire that cannot answer never runs the phase', () => {
  const failure = Object.assign(new Error('slot claim unavailable'), { stage: 'slot-claim-unresolvable' })
  const io = closeoutIo({ slots: slotFactory({ throwOnAcquire: failure }) })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'slot-claim-unresolvable')
  assert.match(result.details.escalation.why, /slot claim unavailable/)
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('b382 F1 a run that only takes model turns acquires no suite slot', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null }, slots: slotFactory() })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.slotFactories.length, 0)
  assert.equal(io.calls.trace.filter((entry) => entry?.label?.startsWith('acquire:')).length, 0)
})

test('slot pool construction that throws never runs the phase', () => {
  const failure = new Error('slot pool construction failed')
  const io = closeoutIo({ slots: () => { throw failure } })
  const result = driveTask(slotCtx(), io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /slot pool construction failed/)
  assert.equal(traceLabels(io.calls).some((label) => label === 'run:suite-cmd' || label === 'runCold:suite-cmd'), false)
})

test('a malformed CREW_SUITE_SLOTS becomes the driver\'s own escalation', () => {
  const io = closeoutIo({ slots: slotFactory() })
  const result = driveTask({ ...CTX, env: { CREW_SUITE_SLOTS: 'abc' } }, io)
  assert.equal(result.status, 'escalation')
  assert.match(result.details.escalation.why, /CREW_SUITE_SLOTS/)
  assert.equal(io.calls.slotFactories.length, 0)
})

test('converge happy path files must-fix residuals, commits once, and opens one draft PR', () => {
  const { io, result } = convergeRun()
  assert.equal(result.status, 'converge')
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(result.details.converge.draft, true)
  assert.equal(result.details.converge.issues.length, 1)
  assert.ok(io.calls.gh.find((call) => call.method === 'createDraftPr').args.body.includes(String(result.details.converge.issues[0].number)))
})

test('converge PR title and body are byte-stable through two identical seams', () => {
  const first = convergeRun()
  const second = convergeRun()
  const pr1 = first.io.calls.gh.find((call) => call.method === 'createDraftPr').args
  const pr2 = second.io.calls.gh.find((call) => call.method === 'createDraftPr').args
  assert.equal(pr1.title, pr2.title)
  assert.equal(pr1.body, pr2.body)
})

test('a red suite parks before any issue, PR, or commit side effect', () => {
  const { io, result } = convergeRun({ suite: { ok: false, output: 'suite red' } })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('without the seam the old gate escalation is byte-identical and never runs the suite', () => {
  const { io, result } = convergeRun({ seam: false })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
  assert.deepEqual(io.calls.run.map((run) => run.cmd), ['gate-cmd', 'lane-cmd', 'gate-cmd'])
})

test('a final gate with no summary parks before the seam', () => {
  const io = convergeIo()
  io.run = (cmd) => {
    const count = (io.calls.run.filter((run) => run.cmd === cmd).length || 0) + 1
    io.calls.run.push({ cmd, n: count })
    if (cmd === 'gate-cmd' && count === 2) return { ok: false, output: 'Error: gate crashed' }
    if (cmd === 'gate-cmd') return { ok: false, output: CONVERGE_GATE }
    return cmd === 'lane-cmd' ? { ok: true, output: '' } : { ok: true, output: '' }
  }
  const result = driveTask(CONVERGE_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
})

test('issue filing failure parks before commit', () => {
  const { io, result } = convergeRun({ issueThrows: 'issue filing failed' })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 0)
})

test('PR creation failure escalates while retaining the commit hash', () => {
  const { io, result } = convergeRun({ prThrows: 'draft PR failed' })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(result.details.commit, 'abc1234')
  assert.match(result.details.escalation.why, /abc1234/)
  assert.deepEqual(result.details.converge.pr, null)
})

test('reviewer findings become stable residuals and only must-fix findings file issues', () => {
  const findings = [
    { id: 'RV-2', severity: 'should-fix', location: 'a.mjs:2', summary: 'follow-up wording' },
    { id: 'RV-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'close the defect' },
  ]
  const io = fakeIo({
    envelopes: {
      'planner:1': CONVERGE_PLAN(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': {
        status: 'done', role: 'reviewer',
        details: { verdict: 'changes-needed', defect: 'build', findings, must_fix: 1, should_fix: 1, consider: 0 },
      },
      'lead:1': leadEnv('escalate', 'the gate names its red checks'),
    },
    runs: {
      'gate-cmd': { ok: false, output: CONVERGE_GATE },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    changed: ['a.mjs'],
    gh: true,
  })
  const result = driveTask({ ...CONVERGE_CTX, limits: { plan_rounds: 1, build_rounds: 3, review_rounds: 1 } }, io)
  assert.equal(result.status, 'converge')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['gate-red', 'RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 2)
  const body = io.calls.gh.find((call) => call.method === 'createDraftPr').args.body
  assert.ok(body.indexOf('RV-1') < body.indexOf('RV-2'))
  assert.match(body, /follow-up: #/)
})

const REVIEW_GATE_PASS = `all checks passed\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`
const REVIEW_FINDINGS = [
  { id: 'RV-2', severity: 'should-fix', location: 'a.mjs:2', summary: 'follow-up wording' },
  { id: 'RV-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'close the defect', hardening: 'ungateable', hardening_why: 'legacy converge fixture' },
]

function reviewConvergeIo({ suite = { ok: true, output: '' }, seam = true, gateless = false } = {}) {
  const plan = gateless
    ? planEnv({ details: { ...CONVERGE_PLAN().details, gate_cmd: undefined } })
    : CONVERGE_PLAN()
  return fakeIo({
    envelopes: {
      'planner:1': plan,
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', legacyReviewerExemptions(REVIEW_FINDINGS)),
      'lead:1': leadEnv('escalate', 'the reviewer names unresolved findings'),
    },
    runs: {
      'gate-cmd:1': { ok: false, output: CONVERGE_GATE },
      'gate-cmd': { ok: true, output: REVIEW_GATE_PASS },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': suite,
    },
    changed: ['a.mjs'],
    ...(seam ? { gh: true } : {}),
  })
}

function reviewConvergeRun({ buildRounds, ...options }) {
  const io = reviewConvergeIo(options)
  const result = driveTask({ ...CONVERGE_CTX, limits: { plan_rounds: 1, build_rounds: buildRounds, review_rounds: 1 } }, io)
  return { io, result }
}

test('review-round exhaustion converges with review residuals and no gate-red entry', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 2 })
  assert.equal(result.status, 'converge')
  assert.equal(result.details.escalation.where, 'review')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.commits.length, 1)
})

test('build-round exhaustion with a revise verdict converges with review residuals', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1 })
  assert.equal(result.status, 'converge')
  assert.equal(result.details.escalation.where, 'review')
  assert.deepEqual(result.details.converge.residuals.map((entry) => entry.id), ['RV-1', 'RV-2'])
  assert.equal(io.calls.gh.filter((call) => call.method === 'createIssue').length, 1)
  assert.equal(io.calls.gh.filter((call) => call.method === 'createDraftPr').length, 1)
  assert.equal(io.calls.commits.length, 1)
  const body = io.calls.gh.find((call) => call.method === 'createDraftPr').args.body
  assert.doesNotMatch(body, /gate is red/)
  assert.match(body, /RV-1/)
})

test('a red suite at build-round review exhaustion still parks without side effects', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, suite: { ok: false, output: 'suite red' } })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
})

test('review convergence without the gh seam remains a review escalation', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, seam: false })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
  assert.ok(io.calls.assign.every(({ role }) => role !== 'converge'))
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
})

test('gateless review convergence parks instead of claiming a green acceptance gate', () => {
  const { io, result } = reviewConvergeRun({ buildRounds: 1, gateless: true })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.gh.length, 0)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(io.calls.run.some((run) => run.cmd === 'suite-cmd'), false)
  assert.ok(result.details.stages.every((label) => !label.startsWith('converge')))
})

test('the converge seam exposes only issue creation and draft PR creation', () => {
  const { io } = convergeRun()
  assert.deepEqual(io.calls.gh.map((call) => call.method).sort(), ['createDraftPr', 'createIssue'])
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  for (const banned of [/ready-for-review/, /ready_for_review/, /['\"]gh (pr|issue)/, /node:child_process/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/]) {
    assert.equal(banned.test(source), false, `unexpected direct seam path ${banned}`)
  }
})

test('panelSeats chooses the first available partner and distinct adjudicator', () => {
  assert.deepEqual(PANEL_PARTNERS, ['tech-lead'])
  assert.deepEqual(PANEL_ADJUDICATORS, ['lead', 'tech-lead'])
  assert.equal(panelSeats(['reviewer', 'planner', 'lead']), null)
  assert.deepEqual(panelSeats(['reviewer', 'tech-lead', 'lead', 'planner']), { partner: 'tech-lead', adjudicator: 'lead' })
  assert.deepEqual(panelSeats(['reviewer', 'tech-lead']), null)
  assert.deepEqual(panelSeats(['reviewer', 'lead']), null)
  assert.deepEqual(panelSeats(null), null)
})

test('non-continuation keeps the ordinary assignment and review brief write set byte-identical', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []) },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, continuation: false }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.map(({ role, briefFile }) => ({ role, briefFile })), [
    { role: 'planner', briefFile: '/tmp/brief.md' },
    { role: 'builder', briefFile: `${TD}/plan.md` },
    { role: 'reviewer', briefFile: `${TD}/review-brief-1.md` },
  ])
  assert.deepEqual(Object.keys(io.calls.writes), [`${TD}/review-brief-1.md`])
  assert.equal(io.calls.writes[`${TD}/review-brief-1.md`], [
    '# Review (round 1)', '',
    `Plan of record: ${TD}/plan.md. Changes are uncommitted in /tmp/repo — read the diff with git.`,
    'Re-run the validation lane yourself: lane-cmd',
    'Write review.md in the task dir. details.verdict must be pass or changes-needed.',
  ].join('\n'))
})

test('continuation panel assigns reviewer, partner, and adjudicator with blind briefs', () => {
  const findingsA = [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:10-20', summary: 'only A', hardening: 'ungateable', hardening_why: 'legacy panel fixture' }]
  const findingsB = [{ id: 'B1', severity: 'must-fix', location: 'a.mjs:12-18', summary: 'only B' }]
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', findingsA),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: findingsB } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true } },
      'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass', []),
      'tech-lead:3': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:2': { status: 'done', role: 'lead', details: { adjudications: [], closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.slice(0, 6).map(({ role }) => role), ['planner', 'tech-lead', 'builder', 'reviewer', 'tech-lead', 'lead'])
  const panelRow = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(panelRow.findings[0].reviewer, 'both')
  assert.equal(io.calls.writes[`${TD}/panel-a-brief-1.md`].includes('only B'), false)
  assert.equal(io.calls.writes[`${TD}/panel-b-brief-1.md`].includes('only A'), false)
})

test('panel degradation falls back to reviewer A without escalating', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
      // tech-lead:1 is the plan check; tech-lead:2 (the panel partner) is deliberately absent.
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.some((line) => line.panel_degraded === 'tech-lead'))
  assert.equal(io.calls.logs.some((line) => line.review_outcome?.panel), false)
})

test('panel dismissals become panel dissents and are removed from the fused verdict', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A only' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [{ id: 'A1', disposition: 'dismiss', reason: 'not a defect' }], closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true }, io)
  assert.equal(result.status, 'done')
  const dissent = result.details.dissents.find((entry) => entry.kind === 'panel-divergence')
  assert.deepEqual(dissent, {
    kind: 'panel-divergence', from: 'reviewer', finding_id: 'A1', severity: 'must-fix',
    location: 'a.mjs:1', summary: 'A only', disposition: 'dismissed', reason: 'not a defect', round: 1,
  })
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.deepEqual(outcome.findings, [])
})

test('an unclosed panel class adds a synthetic must-fix and preserves a review bounce without findings', () => {
  const classGuard = { ...B376_HARDENED, finding: 'panel-class-1', name: 'panel class guard' }
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('pass', []),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:1': { status: 'done', role: 'lead', details: { closes_class: false, class_invariant: 'class remains open' } },
      'builder:2': buildEnv({ details: { ...buildEnv().details, hardened: [classGuard] } }), 'reviewer:2': reviewEnv('pass', []),
      'tech-lead:3': { status: 'done', role: 'tech-lead', details: { verdict: 'pass', findings: [] } },
      'lead:2': { status: 'done', role: 'lead', details: { closes_class: true } },
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], files: B376_FILES, writeThrough: true,
  })
  const baseRun = io.run
  io.run = function (cmd) {
    const result = baseRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
    if (cmd === hardenCommand(B376_TEST_FILE, 'panel class guard')) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      const output = [B376_GREEN, B376_PRE_RED, B376_MUT_RED][count - 1] || B376_MUT_RED
      return { ...output, output: output.output.replaceAll('F1 guard', 'panel class guard') }
    }
    return result
  }
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 2, review_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(outcome.verdict, 'changes-needed')
  assert.deepEqual(outcome.findings[0], {
    id: 'panel-class-1', severity: 'must-fix', location: null,
    summary: 'class remains open', reviewer: 'adjudicator',
  })
  assert.match(Object.values(io.calls.writes).find((value) => /Review bounce/.test(value)) || '', /panel-class-1/)
})

test('a changes-needed reviewer without typed findings cannot be upgraded by an empty panel', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'B1', severity: 'should-fix', location: 'a.mjs:2', summary: 'partner note' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { closes_class: true } },
      'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.commits.length, 0)
  const outcome = io.calls.logs.map((line) => line.review_outcome).find((row) => row?.panel)
  assert.equal(outcome.verdict, 'changes-needed')
  assert.equal(outcome.must_fix, 1)
  assert.equal(outcome.findings[0].id, 'B1')
})

test('full is trace-identical and keeps the eleven legacy detail keys', () => {
  const make = (variant) => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const omittedIo = make()
  const explicitIo = make()
  const omitted = driveTask(CTX, omittedIo)
  const explicit = driveTask({ ...CTX, variant: 'full' }, explicitIo)
  assert.deepEqual(omitted.details.stages, ['plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.deepEqual(Object.keys(omitted.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.deepEqual(omitted, explicit)
  assert.deepEqual(omittedIo.calls, explicitIo.calls)
})

test('repair uses one bounded triage round and keeps the reviewed finish path', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['repair:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass', 'commit', 'suite', 'suite:cold', 'done'])
  assert.equal(result.details.commit, 'abc1234')
  assert.equal(result.details.gate, null)
  assert.deepEqual(io.calls.commits[0].files, ['a.mjs', 'a.test.mjs'])
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 1)
  assert.deepEqual(Object.keys(result.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.equal(io.calls.assign.find(({ role }) => role === 'builder').briefFile, TRIAGE_NOTE)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /Failure brief \(verbatim\)/)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /files_in_scope/)
  assert.match(io.calls.writes[`${TD}/repair-brief.md`], /\n- a\.mjs\n/)
  assert.doesNotMatch(JSON.stringify(io.calls.logs), /\"stage\":\"(?:plan|check|gate)/)
})

test('repair treats inherited scope as its scope gate', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv(), 'builder:1': buildEnv() },
    changed: ['a.mjs', 'other.mjs'], files: TRIAGE_FILES,
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.equal(io.calls.commits.length, 0)
})

test('repair refuses absent declared sources before assigning a seat', () => {
  const cases = [
    { files_in_scope: undefined },
    { files_in_scope: [] },
    { lane: null },
  ]
  for (const over of cases) {
    const io = fakeIo()
    const result = driveTask({ ...CTX_REPAIR, ...over }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'triage')
    assert.match(result.details.escalation.why, over.lane === null ? /lane/ : /files_in_scope/)
    assert.equal(io.calls.assign.length, 0)
    assert.deepEqual(result.details.stages, ['escalate:triage'])
  }
})

test('repair refuses an unusable inherited scope before assigning a seat', () => {
  const io = fakeIo()
  const result = driveTask({ ...CTX_REPAIR, files_in_scope: ['../x', 'src/*'] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /\.\.\/x/)
  assert.match(result.details.escalation.why, /src\/\*/)
  assert.equal(io.calls.assign.length, 0)
})

test('repair validates the triage product before assigning a builder', () => {
  const cases = [
    triageEnv({ details: {} }),
    triageEnv({ artifacts: ['/tmp/elsewhere/triage.md'], details: { plan_path: '/tmp/elsewhere/triage.md' } }),
    triageEnv({ artifacts: [], details: { plan_path: TRIAGE_NOTE } }),
    triageEnv({ artifacts: [`${TD}/missing.md`], details: { plan_path: `${TD}/missing.md` } }),
    triageEnv({ summary: '   ' }),
    triageEnv({ artifacts: 'not-an-array' }),
  ]
  for (const planner of cases) {
    const io = fakeIo({ envelopes: { 'planner:1': planner }, changed: ['a.mjs'], files: TRIAGE_FILES })
    const result = driveTask(CTX_REPAIR, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'triage')
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 0)
  }
})

test('repair honors a narrowed triage scope and escalates a widened one', () => {
  const narrowIo = fakeIo({
    envelopes: {
      'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['a.mjs'] } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
    }, changed: ['a.mjs'], files: TRIAGE_FILES,
  })
  const narrow = driveTask(CTX_REPAIR, narrowIo)
  assert.equal(narrow.status, 'done')
  assert.deepEqual(narrowIo.calls.commits[0].files, ['a.mjs'])

  const narrowedChangedIo = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['a.mjs'] } }), 'builder:1': buildEnv() },
    changed: ['a.mjs', 'a.test.mjs'], files: TRIAGE_FILES,
  })
  const narrowedChanged = driveTask(CTX_REPAIR, narrowedChangedIo)
  assert.equal(narrowedChanged.status, 'escalation')
  assert.equal(narrowedChanged.details.escalation.where, 'scope')
  assert.equal(narrowedChangedIo.calls.commits.length, 0)

  const wideIo = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, files_in_scope: ['b.mjs'] } }) },
    changed: ['a.mjs'], files: TRIAGE_FILES,
  })
  const wide = driveTask(CTX_REPAIR, wideIo)
  assert.equal(wide.status, 'escalation')
  assert.equal(wide.details.escalation.where, 'triage-scope')
  assert.match(wide.details.escalation.why, /widen/)
  assert.equal(wideIo.calls.assign.filter(({ role }) => role === 'builder').length, 0)
})

test('repair refuses a self-authored acceptance gate', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: TRIAGE_NOTE, gate_cmd: 'node gate.mjs' } }) },
    files: TRIAGE_FILES, changed: ['a.mjs'],
  })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.match(result.details.escalation.why, /gate/)
  assert.deepEqual(io.calls.run, [])
  assert.equal(result.details.stages.some((label) => label.startsWith('gate')), false)
})

test('repair triage is bounded to one planner assignment', () => {
  const io = fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'need more', artifacts: [], details: {} } }, files: TRIAGE_FILES })
  const result = driveTask(CTX_REPAIR, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'triage')
  assert.deepEqual(io.calls.assign.map(({ role }) => role), ['planner'])
})

test('repair never reaches gate or converge stages on review exhaustion', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': triageEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('changes-needed'),
      'lead:1': leadEnv('escalate'),
    },
    changed: ['a.mjs'], files: TRIAGE_FILES, gh: true,
  })
  const result = driveTask({ ...CTX_REPAIR, limits: { build_rounds: 1, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.stages.some((label) => label.startsWith('gate') || label.startsWith('converge')), false)
})

test('repair protected scope still fires the sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv() }, files: { [TRIAGE_NOTE]: '# Triage\n' },
    changed: [], reseat: () => ({ reason: 'no-tier' }),
  })
  const result = driveTask({ ...CTX_REPAIR, files_in_scope: ['crew/drive.mjs'] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'sensitivity-floor')
})

test('directed declaration is pinned and honourable', () => {
  const DIRECTED_SNAPSHOT = {
    execution: 'reviewed', required_seats: ['builder', 'reviewer'],
    stages: ['directed', 'build', 'scope-gate', 'lane', 'gate', 'gate-baseline', 'gate-proof',
      'review', 'commit', 'rebase', 'suite', 'publish', 'converge'],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [], assignment: null,
    sources: { scope: 'brief', lane: 'ctx', gate: 'brief' },
  }
  assert.deepEqual(VARIANTS.directed, DIRECTED_SNAPSHOT)
  assert.equal(shapeDefect(VARIANTS.directed, 'directed'), null)
  assert.ok(shapeDefect(VARIANTS.directed, 'quality'))
  assert.deepEqual(Object.keys(PARTIAL_REVIEWED), ['repair', 'directed'])
})

test('directed declares no plan, check, gate-repair or gate-reverify stage', () => {
  for (const label of ['plan:r1', 'check:r1', 'gate-repair:1', 'gate-reverify:1']) {
    assert.match(undeclaredStage(VARIANTS.directed, label), /not declared/)
  }
  for (const label of ['directed:r1', 'gate-baseline', 'gate:r1', 'gate-proof:1', 'converge:suite', 'done']) {
    assert.equal(undeclaredStage(VARIANTS.directed, label), null, label)
  }
})

test('a directed run seats no planner, opens with directed:r1, and proves its gate discriminates', () => {
  const red = `red\n${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'directed-gate:1': { ok: false, output: red }, 'directed-gate': { ok: true, output: green },
      'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'directed-gate': { ok: false, output: red } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 0)
  assert.equal(result.details.stages[0], 'directed:r1')
  assert.equal(result.details.stages.some((label) => label.startsWith('plan') || label.startsWith('check')), false)
  assert.ok(io.calls.run.some(({ cmd }) => cmd === 'directed-gate'))
  assert.equal(io.calls.runClean.length, 1)
  assert.ok(result.details.stages.some((label) => label.startsWith('gate-proof')))
  assert.equal(result.details.gate.discrimination, 'proven')
  assert.equal(result.details.variant, 'directed')
  assert.equal(result.details.commit, 'abc1234')
})

test("the brief's files_in_scope is authoritative over a conflicting ctx scope", () => {
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv() },
    runs: { 'directed-gate:1': { ok: false, output: red } },
    changed: ['a.mjs', 'a.test.mjs', 'rogue.mjs'],
  })
  const result = driveTask({ ...CTX_DIRECTED, files_in_scope: ['a.mjs', 'a.test.mjs', 'rogue.mjs'] }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.match(result.details.escalation.why, /rogue\.mjs/)
  const directed = io.calls.logs.find((line) => line.directed)?.directed
  assert.equal(directed.scope_source, 'brief')
  assert.equal(directed.gate_source, 'brief')
})

test('a directed brief that is not a plan escalates before any seat', () => {
  const block = (value) => ['```directed', value, '```'].join('\n')
  const valid = JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['a.mjs'] })
  const cases = [
    '# no block',
    `${block(valid)}\n${block(valid)}`,
    '```directed\n' + valid,
    block('{ not json'),
    block('[]'),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['a.mjs'], extra: true })),
    block(JSON.stringify({ files_in_scope: ['a.mjs'] })),
    block(JSON.stringify({ gate_cmd: '   ', files_in_scope: ['a.mjs'] })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: [] })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: 'a.mjs' })),
    block(JSON.stringify({ gate_cmd: 'directed-gate', files_in_scope: ['src/*.mjs'] })),
  ]
  for (const text of cases) {
    assert.ok(parseDirectedBrief(text).defect, text)
    const io = fakeIo({ files: { [DIRECTED_BRIEF_PATH]: text } })
    const result = driveTask(CTX_DIRECTED, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'directed')
    assert.equal(io.calls.assign.length, 0)
  }
})

test('a directed run with no validation lane escalates', () => {
  const io = fakeIo({ files: DIRECTED_FILES })
  const result = driveTask({ ...CTX_DIRECTED, lane: undefined }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'directed')
  assert.equal(io.calls.assign.length, 0)
})

test("a green-at-baseline directed gate escalates and assigns nobody to repair it", () => {
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({ files: DIRECTED_FILES, runs: { 'directed-gate': { ok: true, output: green } } })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.includes('gate-baseline:green-bounce'), false)
  assert.match(result.details.escalation.why, /authored outside the crew by the orchestrator/)
})

test('a directed gate that did not RUN at baseline escalates', () => {
  const io = fakeIo({ files: DIRECTED_FILES, runs: { 'directed-gate': { ok: false, output: 'Error: boom\n' } } })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.includes('gate-baseline:defect-bounce'), false)
})

test('a directed gate that fails its discrimination proof escalates', () => {
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const io = fakeIo({
    files: DIRECTED_FILES,
    envelopes: { 'builder:1': buildEnv() },
    runs: {
      'directed-gate:1': { ok: false, output: red }, 'directed-gate': { ok: true, output: green },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'directed-gate': { ok: true, output: green } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX_DIRECTED, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(result.details.stages.some((label) => label.startsWith('gate-repair') || label.startsWith('gate-reverify')), false)
})

test('a lead-seated full run still repairs its gate', () => {
  const full = Object.freeze({ ...CTX, roles: ['lead', 'planner', 'builder', 'reviewer'], seatedRoles: ['lead', 'planner', 'builder', 'reviewer'] })
  const red = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}`
  const green = `${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}`
  const cases = [
    {
      runs: { 'gate-cmd': { ok: true, output: green } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'lead:1': leadEnv('accept'),
      },
    },
    {
      runs: { 'gate-cmd': { ok: false, output: 'Error: boom\n' } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'lead:1': leadEnv('accept'),
      },
    },
    {
      runs: {
        'gate-cmd:1': { ok: false, output: red }, 'gate-cmd': { ok: true, output: green },
        'lane-cmd': { ok: true, output: '' },
      },
      cleanRuns: { 'gate-cmd': { ok: true, output: green } },
      envelopes: {
        'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
        'builder:1': buildEnv(), 'lead:1': leadEnv('accept'),
      },
      changed: ['a.mjs', 'a.test.mjs'],
    },
  ]
  for (const spec of cases) {
    const io = fakeIo(spec)
    driveTask(full, io)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  }
})


test('the variant-aware attended seat guard accepts a planner-less directed crew', () => {
  assert.deepEqual(VARIANTS.directed.required_seats, ['builder', 'reviewer'])
  assert.doesNotThrow(() => assertSeats({ roles: ['builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'directed'))
  assert.throws(
    () => assertSeats({ roles: ['builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'full'),
    /requires a planner seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['reviewer'], members: { reviewer: {} } }, 'directed'),
    /requires a builder seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['builder'], members: { builder: {} } }, 'directed'),
    /requires a reviewer seat/,
  )
  assert.throws(
    () => assertSeats({ roles: ['lead', 'builder', 'reviewer'], members: { builder: {}, reviewer: {} } }, 'directed'),
    /requires a lead seat/,
  )
})

test('the daemon child preflight accepts the same planner-less directed crew', () => {
  const makeFixture = (roles) => {
    const dir = scratchDir('directed-child-')
    const crewDir = join(dir, 'crew')
    const taskDir = join(crewDir, 'task')
    const returnsDir = join(crewDir, 'returns')
    mkdirSync(taskDir, { recursive: true })
    mkdirSync(returnsDir, { recursive: true })
    const taskReturn = join(returnsDir, 'task.json')
    const briefFile = join(dir, 'brief.md')
    const members = Object.fromEntries(roles.map((role) => [role, { model: 'x', transport: 'headless-json' }]))
    writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({
      task: 'x', checkout: dir, roles, members, task_return: taskReturn,
    }))
    writeFileSync(join(crewDir, 'journal.jsonl'), '')
    writeFileSync(briefFile, DIRECTED_BRIEF_TEXT)
    return { dir, crewDir, briefFile, taskReturn }
  }
  const run = (fixture) => runChild({
    crew_dir: fixture.crewDir, task: 'x', brief_file: fixture.briefFile,
    variant: 'directed', validation_lane: 'lane-cmd',
  }, {
    execSync: () => '',
    env: { DEVTEAM_LEDGER_DB: join(fixture.dir, 'ledger.db') },
    seatIo: () => ({ log() {} }),
    driveTask: () => ({ status: 'done', summary: 'ok', artifacts: [], details: { stages: [] } }),
  })

  const complete = makeFixture(['builder', 'reviewer'])
  try {
    const result = run(complete)
    assert.equal(result.status, 'done')
    assert.equal(JSON.parse(readFileSync(complete.taskReturn, 'utf8')).status, 'done')
  } finally {
    rmSync(complete.dir, { recursive: true, force: true })
  }

  for (const missing of [['reviewer'], ['builder']]) {
    const fixture = makeFixture(missing)
    try {
      assert.throws(() => run(fixture), /requires a (builder|reviewer) seat/)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  }
})

test('shape sources and the repair declaration are pinned', () => {
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
  assert.equal(sourcesDefect(undefined) !== null, true)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, scope: 'bad' }), /scope/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, lane: 'bad' }), /lane/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, gate: 'bad' }), /gate/)
  assert.match(sourcesDefect({ ...TRIAGE_SOURCES, proof: 'self' }), /proof/)
  assert.equal(sourcesDefect(VARIANTS.repair.sources), null)
  assert.deepEqual(SHAPE_SOURCES.scope, ['plan', 'inherited', 'brief'])
  assert.deepEqual(SHAPE_SOURCES.lane, ['plan', 'ctx'])
  assert.deepEqual(SHAPE_SOURCES.gate, ['plan', 'none', 'brief'])
  assert.deepEqual(REVIEWED_CORE_STAGES, ['build', 'scope-gate', 'lane', 'review', 'commit', 'rebase', 'suite', 'publish'])
  assert.equal(TRIAGE_STAGE_HEAD, 'repair')
  assert.deepEqual(TRIAGE_STAGES, ['repair', ...REVIEWED_CORE_STAGES])
})

test('shapeDefect admits only the implemented partial topology under repair', () => {
  const withSources = (stages, sources) => ({ ...VARIANTS.full, stages, sources })
  const planSources = { scope: 'plan', lane: 'plan', gate: 'plan' }
  const cases = [
    [VARIANTS.full.stages.filter((head) => head !== 'check'), planSources, 'full'],
    [VARIANTS.full.stages.filter((head) => head !== 'gate-baseline'), planSources, 'full'],
    [VARIANTS.full.stages.filter((head) => head !== 'converge'), planSources, 'full'],
    [VARIANTS.repair.stages, VARIANTS.repair.sources, 'quality'],
    [[...VARIANTS.repair.stages], { ...TRIAGE_SOURCES, proof: 'self' }, 'repair'],
    [[...VARIANTS.repair.stages, 'gate'], TRIAGE_SOURCES, 'repair'],
    [VARIANTS.repair.stages.filter((head) => head !== 'lane'), TRIAGE_SOURCES, 'repair'],
    [['plan', ...VARIANTS.repair.stages], TRIAGE_SOURCES, 'repair'],
  ]
  for (const [stages, sources, name] of cases) assert.ok(shapeDefect(withSources(stages, sources), name))
  assert.match(shapeDefect(VARIANTS.repair, 'quality'), /quality/)
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
})

test('undeclaredStage still bounds repair heads', () => {
  for (const label of ['plan:r1', 'check:r1', 'gate:r1', 'gate-baseline', 'converge:suite']) {
    assert.match(undeclaredStage(VARIANTS.repair, label), /not declared/)
  }
  for (const label of ['repair:r1', 'escalate:triage', 'done']) assert.equal(undeclaredStage(VARIANTS.repair, label), null)
})

test('full, scout and repair declarations remain byte-identical snapshots', () => {
  const FULL_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['plan', 'check', 'build', 'scope-gate', 'lane', 'gate',
      'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'review',
      'commit', 'rebase', 'suite', 'publish', 'converge'],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [], assignment: null,
  }
  const SCOUT_SNAPSHOT = {
    execution: 'envelope', required_seats: ['planner'],
    stages: ['scout', 'scope-gate', 'envelope-accept'], writes: 'none',
    accepted_by: 'envelope shape',
    envelope_fields: [{ name: 'findings', kind: 'records', item_fields: ['summary', 'evidence'] }],
    assignment: 'Read-only recon. Answer the brief from the code and the checkout, write your notes into the task dir, and change nothing.',
  }
  const REPAIR_SNAPSHOT = {
    execution: 'reviewed', required_seats: 'tier',
    stages: ['repair', 'build', 'scope-gate', 'lane', 'review', 'commit', 'rebase', 'suite', 'publish'],
    writes: 'planned',
    accepted_by: 'a review verdict of pass, or a lead accept at review or build exhaustion',
    envelope_fields: [],
    assignment: 'Bounded triage. Read the failure the task brief carries verbatim, then write the smallest fix the builder can execute inside the scope this run inherits. This is NOT a plan round: there is no revision, no plan-check, no second attempt, and no acceptance gate.',
    sources: { scope: 'inherited', lane: 'ctx', gate: 'none' },
  }
  assert.deepEqual(VARIANTS.full, FULL_SNAPSHOT)
  assert.deepEqual(VARIANTS.scout, SCOUT_SNAPSHOT)
  assert.deepEqual(VARIANTS.repair, REPAIR_SNAPSHOT)
})

test('omitting the variant is equivalent to explicitly selecting full', () => {
  const make = () => fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const a = make(); const b = make()
  assert.deepEqual(driveTask(CTX, a), driveTask({ ...CTX, variant: DEFAULT_VARIANT }, b))
  assert.deepEqual(a.calls, b.calls)
})

test('an unknown variant refuses before assignments or journal lines', () => {
  const io = fakeIo()
  assert.throws(() => driveTask({ ...CTX, variant: 'unknown-shape' }, io), (err) => {
    assert.equal(err.stage, 'variant')
    assert.match(err.message, /full/)
    assert.match(err.message, /scout/)
    return true
  })
  assert.equal(io.calls.assign.length, 0)
  assert.equal(io.calls.logs.length, 0)
})

test('shapeDefect refuses declarations the driver cannot honour', () => {
  assert.equal(shapeDefect(VARIANTS.full), null)
  assert.equal(shapeDefect(VARIANTS.scout), null)
  const subset = { ...VARIANTS.full, stages: ['build', 'review', 'commit', 'rebase', 'suite', 'publish'] }
  assert.match(shapeDefect(subset), /plan/)
  assert.match(shapeDefect(subset), /declared sources/)
  assert.match(shapeDefect({ ...VARIANTS.scout, stages: ['scout', 'envelope-accept'] }), /scope-gate/)
  assert.match(shapeDefect({ ...VARIANTS.full, required_seats: ['planner'] }), /required_seats/)
  assert.match(shapeDefect({ ...VARIANTS.full, execution: 'unknown' }), /execution/)
  assert.match(shapeDefect({ ...VARIANTS.full, writes: 'unknown' }), /writes/)
  assert.match(shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'unknown' }] }), /kind/)
})

test('stageEnabled answers synthetic and shipped declarations from their stages', () => {
  const subset = { stages: ['build', 'quality'] }
  const envelope = { stages: ['prompt', 'envelope-accept'] }
  assert.equal(stageEnabled(subset, 'build'), true)
  assert.equal(stageEnabled(subset, 'plan'), false)
  assert.equal(stageEnabled(envelope, 'prompt'), true)
  assert.equal(stageEnabled(envelope, 'scope-gate'), false)
  assert.equal(stageEnabled(VARIANTS.full, 'plan'), true)
  assert.equal(stageEnabled(VARIANTS.scout, 'plan'), false)
  assert.equal(stageEnabled(VARIANTS.scout, 'scout'), true)
})

test('undeclaredStage bounds declared heads while exempting universal terminals', () => {
  for (const label of ['plan:r1', 'gate-baseline:green-bounce', 'gate-proof:1', 'converge:pr', 'review:panel-r2', 'escalate:lane', 'done']) {
    assert.equal(undeclaredStage(VARIANTS.full, label), null, label)
  }
  assert.equal(undeclaredStage(VARIANTS.scout, 'escalate:scope'), null)
  assert.equal(undeclaredStage(VARIANTS.scout, 'done'), null)
  assert.match(undeclaredStage(VARIANTS.scout, 'commit'), /not declared/)
})

test('scout runs only recon, scope proof, envelope acceptance, and done', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['scout:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.deepEqual(io.calls.run, [])
})

test('scout seats its declared planner only and never commits', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.deepEqual(io.calls.assign.map(({ role }) => role), [VARIANTS.scout.required_seats[0]])
  assert.equal(io.calls.commits.length, 0)
  assert.equal(result.details.commit, null)
  assert.deepEqual(result.details.files_committed, [])
})

test('scout dispatches a written brief containing its complete envelope contract', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  driveTask({ ...CTX, variant: 'scout' }, io)
  const briefPath = `${TD}/scout-brief.md`
  assert.equal(io.calls.assign[0].briefFile, briefPath)
  const brief = io.calls.writes[briefPath]
  assert.ok(brief.startsWith('# scout assignment\n'))
  assert.doesNotMatch(brief, /\\n/)
  for (const needle of [CTX.briefFile, CTX.taskDir, 'changed zero files', 'details.findings', 'summary', 'evidence', 'artifacts']) assert.ok(brief.includes(needle), needle)
  assert.doesNotMatch(brief, /plan\.md/)
  assert.doesNotMatch(brief, /review/i)
})

test('scout rejects envelopes that do not match its declared shape', () => {
  const cases = [
    { details: {} }, { details: { findings: [] } }, { details: { findings: [null] } },
    { details: { findings: [{ summary: 's' }] } },
    { details: { findings: [{ summary: '  ', evidence: 'e' }] } },
    { summary: '' }, { artifacts: null }, { artifacts: [7] },
    { artifacts: ['/etc/passwd'] }, { artifacts: [`${TD}/../escape.md`] }, { details: null },
  ]
  for (const over of cases) {
    const io = fakeIo({ envelopes: { 'planner:1': reconEnv(over) }, changed: [] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
  }
  assert.equal(envelopeDefect(reconEnv(), VARIANTS.scout, { taskDir: TD }), null)
  assert.equal(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).reason, 'no-envelope')
  assert.match(envelopeDefect(null, VARIANTS.scout, { taskDir: TD }).why, /no envelope/)
})

test('the envelope refusal reason set is closed and frozen', () => {
  assert.equal(Object.isFrozen(ENVELOPE_REFUSAL_REASONS), true)
  assert.deepEqual([...ENVELOPE_REFUSAL_REASONS], ['no-envelope', 'summary', 'artifacts', 'details', 'field-missing', 'field-kind', 'field-item', 'verdict-findings', 'finding-id'])
  const malformed = [
    null,
    'not an object',
    { ...reconEnv(), summary: '' },
    { ...reconEnv(), artifacts: null },
    { ...reconEnv(), artifacts: [7] },
    { ...reconEnv(), artifacts: ['/etc/passwd'] },
    { ...reconEnv(), artifacts: [`${TD}/../escape.md`] },
    { ...reconEnv(), details: null },
    { ...reconEnv(), details: {} },
    { ...reconEnv(), details: { findings: 'not an array' } },
    { ...reconEnv(), details: { findings: [null] } },
    { ...reconEnv(), details: { findings: [{ summary: 's' }] } },
  ]
  for (const env of malformed) {
    const defect = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
    assert.ok(defect && typeof defect === 'object' && !Array.isArray(defect))
    assert.ok(ENVELOPE_REFUSAL_REASONS.includes(defect.reason))
    assert.equal(typeof defect.why, 'string')
    assert.ok(defect.why.trim())
  }
})

test('an envelope that omits a declared field is refused, per declared field', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const envelope = (details) => ({
    status: 'done', role: 'planner', summary: 'recon complete', artifacts: [`${TD}/scout.md`], details,
  })
  const complete = { alpha: 'a sentence', beta: [{ summary: 's', evidence: 'e' }] }
  for (const field of shape.envelope_fields) {
    const details = { ...complete }
    delete details[field.name]
    const defect = envelopeDefect(envelope(details), shape, { taskDir: TD })
    assert.equal(defect.reason, 'field-missing')
    assert.ok(defect.why.includes(field.name))
  }
  for (const field of VARIANTS.scout.envelope_fields) {
    const defect = envelopeDefect(reconEnv({ details: {} }), VARIANTS.scout, { taskDir: TD })
    assert.equal(defect.reason, 'field-missing')
    assert.ok(defect.why.includes(field.name))
  }
  const undefinedValue = envelopeDefect(reconEnv({ details: { findings: undefined } }), VARIANTS.scout, { taskDir: TD })
  assert.equal(undefinedValue.reason, 'field-missing')
  assert.ok(undefinedValue.why.includes('findings'))
})

test('a declared field of the wrong kind is refused, and the reason says which kind of wrong', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const envelope = (details) => ({
    status: 'done', role: 'planner', summary: 'recon complete', artifacts: [`${TD}/scout.md`], details,
  })
  const record = { summary: 's', evidence: 'e' }
  const cases = [
    [{ alpha: 'a', beta: 'not an array' }, 'field-kind'],
    [{ alpha: 'a', beta: { ...record } }, 'field-kind'],
    [{ alpha: 'a', beta: [] }, 'field-kind'],
    [{ alpha: 7, beta: [record] }, 'field-kind'],
    [{ alpha: '   ', beta: [record] }, 'field-kind'],
    [{ alpha: 'a', beta: [null] }, 'field-item'],
    [{ alpha: 'a', beta: [[]] }, 'field-item'],
    [{ alpha: 'a', beta: [{ summary: 's' }] }, 'field-item'],
    [{ alpha: 'a', beta: [{ summary: ' ', evidence: 'e' }] }, 'field-item'],
  ]
  for (const [details, reason] of cases) {
    const defect = envelopeDefect(envelope(details), shape, { taskDir: TD })
    assert.equal(defect.reason, reason)
    assert.ok(defect.why)
  }
})

test('a well-formed envelope is still accepted, and extra material never over-refuses', () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const record = { summary: 's', evidence: 'e', extra: 'ignored' }
  const twoField = {
    status: 'done', role: 'planner', summary: 'recon complete',
    artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
    details: { alpha: 'a sentence', beta: [record], unrelated: 7 },
  }
  assert.equal(envelopeDefect(twoField, shape, { taskDir: TD }), null)
  assert.equal(envelopeDefect(reconEnv({
    artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
    details: { findings: [record], unrelated: 7 },
  }), VARIANTS.scout, { taskDir: TD }), null)

  const io = fakeIo({
    envelopes: { 'planner:1': reconEnv({
      artifacts: [`${TD}/scout.md`, `${TD}/extra.md`],
      details: { findings: [record], unrelated: 7 },
    }) },
    changed: [],
  })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, ['scout:r1', 'scope-gate:r1', 'envelope-accept', 'done'])
  assert.equal(result.details.accepted_via, VARIANTS.scout.accepted_by)
  assert.equal(io.calls.commits.length, 0)
})

test("envelopeFieldsPresent reports the envelope's fields, not the declaration's", () => {
  const shape = {
    ...VARIANTS.scout,
    envelope_fields: [
      { name: 'alpha', kind: 'text' },
      { name: 'beta', kind: 'records', item_fields: ['summary', 'evidence'] },
    ],
  }
  const observed = (details) => envelopeFieldsPresent({ details }, shape)
  assert.deepEqual(observed({ beta: [{ summary: 's', evidence: 'e' }] }), ['beta'])
  assert.deepEqual(observed({ alpha: 'a sentence' }), ['alpha'])
  assert.deepEqual(observed({}), [])
  assert.deepEqual(observed({ alpha: 'a sentence', beta: [{ summary: 's', evidence: 'e' }] }), ['alpha', 'beta'])
  assert.deepEqual(observed({ alpha: undefined, beta: [{ summary: 's', evidence: 'e' }] }), ['beta'])
  assert.deepEqual(envelopeFieldsPresent({ details: null }, shape), [])
  assert.deepEqual(envelopeFieldsPresent({ details: [] }, shape), [])
})

test('an accepted envelope run READS the envelope to report its fields', () => {
  const source = reconEnv()
  let presenceReads = 0
  const env = {
    ...source,
    details: new Proxy(source.details, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'findings') presenceReads += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    }),
  }
  const io = fakeIo({ envelopes: { 'planner:1': env }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  const expected = envelopeFieldsPresent(reconEnv(), VARIANTS.scout)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.envelope.fields, expected)
  const line = io.calls.logs.find((entry) => entry.envelope_accepted)
  assert.ok(line)
  assert.deepEqual(line.envelope_accepted.fields, expected)
  assert.equal(line.envelope_accepted.files_changed, 0)
  assert.equal(line.envelope_accepted.seat, 'planner')
  assert.equal(presenceReads, 2)
})

test('an envelope refusal escalates naming the reason the validator produced', () => {
  const cases = [
    ['summary', reconEnv({ summary: '' })],
    ['artifacts', reconEnv({ artifacts: ['/etc/passwd'] })],
    ['details', reconEnv({ details: null })],
    ['field-missing', reconEnv({ details: {} })],
    ['field-kind', reconEnv({ details: { findings: 'not an array' } })],
    ['field-item', reconEnv({ details: { findings: [{ summary: 's' }] } })],
  ]
  for (const [expectedReason, env] of cases) {
    const direct = envelopeDefect(env, VARIANTS.scout, { taskDir: TD })
    assert.equal(direct.reason, expectedReason)
    const io = fakeIo({ envelopes: { 'planner:1': env }, changed: [] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'envelope')
    assert.ok(result.details.escalation.why.includes(`[${direct.reason}]`))
    assert.equal(result.details.stages.includes('envelope-accept'), false)
    assert.equal(io.calls.commits.length, 0)
  }
})

test('shapeDefect still judges the DECLARATION alone, unchanged', () => {
  for (const [name, shape] of Object.entries(VARIANTS)) assert.equal(shapeDefect(shape, name), null)
  const unknown = shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings', kind: 'unknown' }] }, 'scout')
  assert.equal(typeof unknown, 'string')
  assert.match(unknown, /kind/)
  const kindless = shapeDefect({ ...VARIANTS.scout, envelope_fields: [{ name: 'findings' }] }, 'scout')
  assert.equal(typeof kindless, 'string')
  assert.match(kindless, /kind/)
})

test("a reviewed shape's acceptance is untouched by the envelope contract", () => {
  const planEnvelope = planEnv()
  for (const name of ['full', 'repair', 'directed']) {
    assert.equal(VARIANTS[name].envelope_fields.length, 0)
    assert.equal(envelopeDefect(planEnvelope, VARIANTS[name], { taskDir: TD }), null)
  }
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, variant: 'full' }, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(Object.keys(result.details).sort(), ['accepted_via', 'cold_suite', 'commit', 'consults', 'dissents', 'escalation', 'extra_rounds_granted', 'files_committed', 'gate', 'growth', 'modifiers', 'stages'])
  assert.equal(io.calls.logs.some((line) => line.envelope_accepted), false)

  const triageIo = fakeIo({ envelopes: { 'planner:1': triageEnv({ summary: '' }) }, changed: [] })
  const triageResult = driveTask(CTX_REPAIR, triageIo)
  assert.equal(triageResult.status, 'escalation')
  assert.equal(triageResult.details.escalation.where, 'triage')
  assert.equal(triageResult.details.escalation.why, 'the triage envelope is not one the driver can build from: summary must be a non-empty string')
})

test('scout write proof escalates at scope, including a files_in_scope claim', () => {
  for (const env of [reconEnv(), reconEnv({ details: { findings: [{ summary: 's', evidence: 'e' }], files_in_scope: ['a.mjs'] } })]) {
    const io = fakeIo({ envelopes: { 'planner:1': env }, changed: ['a.mjs'] })
    const result = driveTask({ ...CTX, variant: 'scout' }, io)
    assert.equal(result.details.escalation.where, 'scope')
    assert.equal(result.details.stages.at(-1), 'escalate:scope')
    assert.equal(io.calls.commits.length, 0)
  }
})

test('scout still proves a clean tree after a dead or unusable seat', () => {
  const dead = fakeIo({ envelopes: { 'planner:1': null }, changed: [] })
  const deadResult = driveTask({ ...CTX, variant: 'scout' }, dead)
  assert.deepEqual(deadResult.details.stages, ['scout:r1', 'scope-gate:r1', 'escalate:scout'])
  assert.match(deadResult.details.escalation.why, /no valid envelope/)
  const dirty = fakeIo({ envelopes: { 'planner:1': null }, changed: ['a.mjs'] })
  const dirtyResult = driveTask({ ...CTX, variant: 'scout' }, dirty)
  assert.equal(dirtyResult.details.escalation.where, 'scope')
  const malformed = fakeIo({ envelopes: { 'planner:1': {} }, changed: [] })
  const malformedResult = driveTask({ ...CTX, variant: 'scout' }, malformed)
  assert.equal(malformedResult.details.escalation.where, 'scout')
})

test('scout reports a non-done but well-formed envelope as a seat escalation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv({ status: 'insufficient', summary: 'need more checkout evidence' }) }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.details.escalation.where, 'scout')
  assert.match(result.details.escalation.why, /need more checkout evidence/)
})

test('scout acceptance uses its own contract and journals envelope acceptance', () => {
  const io = fakeIo({ envelopes: { 'planner:1': reconEnv() }, changed: [] })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.details.accepted_via, VARIANTS.scout.accepted_by)
  assert.doesNotMatch(JSON.stringify(result), /review pass|review:pass|review_outcome/i)
  assert.doesNotMatch(JSON.stringify(io.calls.logs), /review pass|review:pass|review_outcome/i)
  assert.ok(io.calls.logs.some((line) => line.envelope_accepted))
})

test('read-only scout shapes do not fire the protected-path sensitivity floor', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': reconEnv({ details: { findings: [{ summary: 's', evidence: 'crew/drive.mjs:50' }], files_in_scope: ['crew/drive.mjs'] } }) },
    changed: [], reseat: () => ({ applied: true }),
  })
  const result = driveTask({ ...CTX, variant: 'scout' }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.reseat.length, 0)
  assert.deepEqual(result.details.modifiers, [])
})

test('declarations remain frozen and observed behaviour stays within their closed vocabulary', () => {
  assert.equal(Object.isFrozen(VARIANTS), true)
  assert.deepEqual(VARIANT_NAMES, ['full', 'scout', 'repair', 'directed'])
  assert.equal(VARIANTS.full.required_seats, 'tier')
  assert.match(VARIANTS.full.accepted_by, /review.*pass/)
  assert.match(VARIANTS.full.accepted_by, /lead accept/)
  for (const shape of Object.values(VARIANTS)) {
    assert.ok(EXECUTIONS.includes(shape.execution))
    assert.ok(WRITE_SURFACES.includes(shape.writes))
    for (const field of shape.envelope_fields) assert.ok(ENVELOPE_FIELD_KINDS.includes(field.kind))
  }
  assert.deepEqual(UNIVERSAL_STAGE_HEADS, ['escalate', 'done'])
  assert.equal(shapeDefect(VARIANTS.repair, 'repair'), null)
  assert.deepEqual(outOfScopeFiles(['a.mjs', 'b.mjs'], scopeMatcher([])), ['a.mjs', 'b.mjs'])
  assert.deepEqual(outOfScopeFiles('not-an-array', scopeMatcher(['a.mjs'])), [])
})

const B44_LEADLESS_CTX = Object.freeze({
  ...CTX,
  roles: ['planner', 'builder', 'reviewer'],
  seatedRoles: ['planner', 'builder', 'reviewer'],
})
const b44GatePlan = (gate = 'gate-cmd') => planEnv({ details: { ...planEnv().details, gate_cmd: gate } })
const b44AssertLeadlessGate = (result, io, diagnosis) => {
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'gate')
  assert.match(result.details.escalation.why, /no lead seated \(mechanical tier\)/)
  assert.match(result.details.escalation.why, diagnosis)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 0)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 1)
}
const b44GateFixIo = () => fakeIo({
  envelopes: {
    'planner:1': b44GatePlan(),
    'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
    'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  },
  runs: {
    'gate-cmd': { ok: true, output: 'green at baseline' },
    'gate-fixed:1': { ok: false, output: RED() }, 'gate-fixed:2': { ok: true, output: '' },
    'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
  },
  changed: ['a.mjs', 'a.test.mjs'],
})
const b44MidRunRepairIo = () => fakeIo({
  emit: true,
  envelopes: {
    'planner:1': b44GatePlan(),
    'builder:1': buildEnv(), 'builder:2': buildEnv(),
    'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'repeated acceptance failure' } },
    'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
    'reviewer:2': reviewEnv('pass'),
  },
  runs: {
    'gate-cmd:1': { ok: false, output: RED() },
    'gate-cmd:2': { ok: false, output: 'build gate failure A' },
    'gate-cmd:3': { ok: false, output: 'build gate failure B' },
    'gate-fixed': { ok: true, output: '' },
    'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' },
  },
  cleanRuns: { 'gate-fixed': { ok: false, output: RED() } },
  changed: ['a.mjs', 'a.test.mjs'],
})

test('the planner is confined to its own stages — no post-acceptance path assigns it', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const hits = source.split('\n').filter((line) => /assignAndWait\(\s*'planner'\s*,/.test(line))
  assert.equal(hits.length, 2)
  assert.match(hits[0], /'triage'/)
  assert.match(hits[1], /round === 1 \? 'plan' : 'plan-revision'/)
  // #843: the widening bounce carries its own note, so the site reads a consumed-once
  // override in FRONT of the ternary — the two ordinary notes are still the fallback.
  assert.match(hits[1], /planNote \?\? \(round === 1/)
  assert.equal(hits.some((line) => /gate-(repair|fix)/.test(line)), false)
  const io = b44MidRunRepairIo()
  driveTask(CTX, io)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'planner').length, 1)
})

test('every gate site assigns the lead, and the repaired gate is still re-proven', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const sites = [...source.matchAll(/assignAndWait\(\s*([^,]+?)\s*,[^,]+,\s*'(gate-repair|gate-fix)'\s*\)/g)]
  assert.equal(sites.length, 4)
  assert.ok(sites.every(([, role]) => role === 'GATE_CUSTODIAN'))
  const io = b44MidRunRepairIo()
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.filter(({ role, note }) => role === 'lead' && note === 'gate-repair').map(({ role, note }) => ({ role, note })), [{ role: 'lead', note: 'gate-repair' }])
  assert.equal(result.details.gate.reverified, true)
  assert.ok(result.details.stages.includes('gate-reverify:1'))
})

test('lead-less: a baseline-green gate escalates with its diagnosis, assigning nobody', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan() },
    runs: { 'gate-cmd': { ok: true, output: 'GREEN at baseline' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /GREEN at baseline/)
})

test('lead-less: a gate that did not RUN at baseline escalates with its diagnosis', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan() },
    runs: { 'gate-cmd': { ok: false, output: 'gate crashed before running' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /the gate did not RUN at baseline.*printed no GATE-SUMMARY/)
})

test('lead-less: a failed discrimination proof escalates with its diagnosis', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': b44GatePlan(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: {
      'gate-cmd:1': { ok: false, output: RED() }, 'gate-cmd:2': { ok: true, output: 'green on built tree' },
      'lane-cmd': { ok: true, output: '' },
    },
    cleanRuns: { 'gate-cmd': { ok: true, output: 'green on pristine tree' } },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /acceptance gate|discriminat/i)
})

test('lead-less: a reviewer-triaged gate defect escalates with the diagnosis attached', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': b44GatePlan(), 'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': { status: 'done', role: 'reviewer', details: { defect: 'gate', reason: 'the gate checks the wrong acceptance target' } },
    },
    runs: {
      'gate-cmd:1': { ok: false, output: RED() },
      'gate-cmd:2': { ok: false, output: 'build failure A' }, 'gate-cmd:3': { ok: false, output: 'build failure B' },
      'lane-cmd': { ok: true, output: '' },
    },
  })
  const result = driveTask(B44_LEADLESS_CTX, io)
  b44AssertLeadlessGate(result, io, /the reviewer triaged.*the gate checks the wrong acceptance target/)
  assert.equal(result.details.stages.some((stage) => stage.startsWith('gate-repair')), false)
})

test('a child-shaped ctx (lead only in seatedRoles) takes the gate repair on the lead', () => {
  const childCtx = { ...CTX, roles: ['planner', 'builder', 'reviewer'], seatedRoles: ['lead', 'planner', 'builder', 'reviewer'] }
  const io = b44GateFixIo()
  const result = driveTask(childCtx, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(io.calls.assign.filter(({ role, note }) => note === 'gate-fix').map(({ role, note }) => ({ role, note })), [{ role: 'lead', note: 'gate-fix' }])
  assert.equal(result.details.escalation, null)

  const attendedIo = b44GateFixIo()
  const attended = driveTask(CTX, attendedIo)
  assert.equal(attended.status, 'done')
  assert.equal(attendedIo.calls.assign.filter(({ role, note }) => role === 'lead' && note === 'gate-fix').length, 1)
})

test('the panel is skipped without a tech-lead, and this drive hands the seated planner no panel assignment', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', []) },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, continuation: true }, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.some((line) => line.panel_skipped === 'seats'))
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 1)
  assert.deepEqual(io.calls.assign.filter(({ role }) => role === 'planner').map(({ note }) => note), ['plan'], 'the seated planner is assigned for the plan round only, never a panel seat')
  assert.deepEqual(PANEL_PARTNERS, ['tech-lead'])
  assert.deepEqual(PERSPECTIVE_TARGETS, ['reviewer', 'tech-lead'])
})

test('both charters state where the planner stops and the lead takes over', () => {
  const lead = readFileSync(new URL('./roles/lead.md', import.meta.url), 'utf8')
  const planner = readFileSync(new URL('./roles/planner.md', import.meta.url), 'utf8')
  assert.match(lead, /## Gate custody \(post-acceptance\)/)
  assert.match(lead, /gate_cmd/)
  assert.match(lead, /spends no budget/)
  assert.match(planner, /domain ends when your plan is accepted/)
  assert.match(planner.slice(planner.indexOf('domain ends when your plan is accepted')), /lead/)
  assert.doesNotMatch(planner, /## Perspective assignments/)
})

test('a missing envelope escalation carries stale, refused and working diagnoses', () => {
  for (const text of [
    'the seat is STALE: planner produced its last transcript frame 5000s ago',
    'the seat REFUSED: planner — the provider says: Overloaded (transient)',
    'the seat is WORKING: planner produced a transcript frame 3s ago and simply exceeded its 1800s budget',
  ]) {
    const io = fakeIo({ envelopes: { 'planner:1': null } })
    io.waitDiagnosis = () => ({ state: text.includes('STALE') ? 'stale' : text.includes('REFUSED') ? 'refused' : 'working', text })
    const res = driveTask(CTX, io)
    assert.equal(res.status, 'escalation')
    assert.match(res.details.escalation.why, new RegExp(`planner: no valid envelope at planner:1 within 1800s — ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

test('an io without waitDiagnosis preserves the plain missing-envelope escalation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': null } })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope at planner:1 within 1800s$/)
})

test('waitDiagnosis is not consulted when an envelope is present but shape-invalid', () => {
  const io = fakeIo({ envelopes: { 'planner:1': {} } })
  let consulted = 0
  io.waitDiagnosis = () => { consulted += 1; return { state: 'stale', text: 'should not appear' } }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /planner: no valid envelope at planner:1 within 1800s$/)
  assert.equal(consulted, 0)
})

const resumeRed = () => ({ ok: false, output: RED() })
const resumeGreen = () => ({ ok: true, output: `${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}` })
const resumeStageRows = (io) => io.calls.logs.filter((row) => typeof row?.stage === 'string').map((row) => row.stage)
const resumeDoneRows = (io) => io.calls.logs.filter((row) => typeof row?.stage_done === 'string').map((row) => row.stage_done)
const replayResumeStages = (io) => {
  const stack = []
  for (const row of io.calls.logs) {
    if (typeof row?.stage === 'string') stack.push(row.stage)
    if (typeof row?.stage_done === 'string') assert.equal(stack.pop(), row.stage_done)
  }
  return stack
}
const resumeKeys = ['stages', 'escalation', 'commit', 'dissents', 'extra_rounds_granted', 'growth', 'modifiers', 'gate', 'seq_high_water', 'gate_attempt_high_water', 'cursor', 'consults_spent', 'accept_findings', 'head']
const CRASH_WHY = 'builder: no valid envelope at builder:3 within 2400s'
const CRASH_STAGES = [
  'plan:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'build:r2', 'scope-gate:r2',
  'lane:r2', 'gate:r2', 'gate-proof:1', 'review:r1', 'build:r3',
]
const CRASH_FINDINGS = [{ id: 'B263-1', severity: 'must-fix', location: 'a.mjs:7', summary: 'the distinctive finding', disposition: null }]
const crashIo = () => fakeIo({
  envelopes: {
    'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }),
    'builder:1': { status: 'insufficient', role: 'builder', summary: 'the plan leaves a gap', artifacts: [], details: {} },
    'lead:1': leadEnv('bounce'),
    'builder:2': buildEnv(),
    'reviewer:1': reviewEnv('changes-needed', CRASH_FINDINGS),
    'builder:3': null,
  },
  cleanRuns: { 'gate-cmd': resumeRed() },
  runs: {
    'gate-cmd:1': resumeRed(), 'gate-cmd:2': resumeGreen(),
    'gate-cmd:3': resumeGreen(), 'gate-cmd:4': resumeGreen(),
    'lane-cmd': { ok: true, output: '' },
    'suite-cmd': { ok: true, output: '' },
  },
  changed: ['a.mjs', 'a.test.mjs'], seqIds: true,
})
const crashRun = (ctx = { ...CTX, head: 'deadbeefcafe' }) => {
  const io = crashIo()
  return { envelope: driveTask(ctx, io), io }
}
const deliberateRun = () => {
  const envelopes = {}
  for (let n = 1; n <= 8; n += 1) {
    envelopes[`planner:${n}`] = { status: 'insufficient', role: 'planner', summary: 'the brief leaves a gap', artifacts: [], details: {} }
    envelopes[`lead:${n}`] = leadEnv('bounce')
  }
  const io = fakeIo({ envelopes, seqIds: true })
  return { envelope: driveTask({ ...CTX, head: 'deadbeefcafe' }, io), io }
}
const carveRun = () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [], details: {} },
      'lead:1': leadEnv('bounce'),
      'planner:2': planEnv({ details: { ...planEnv().details, carve_verdict: 'carve', carve_slices: [{ summary: 'slice one', files_in_scope: ['a.mjs'] }] } }),
    }, seqIds: true,
  })
  return { envelope: driveTask({ ...CTX, head: 'deadbeefcafe' }, io), io }
}
const postCommitCrashRun = () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'], seqIds: true,
  })
  let boom = false
  const originalLog = io.log
  io.log = (row) => {
    if (!boom && row && row.stage_done === 'commit') { boom = true; throw new Error('journal write failed after commit') }
    originalLog(row)
  }
  let envelope = null
  let thrown = null
  try { envelope = driveTask({ ...CTX, head: 'deadbeefcafe' }, io) } catch (err) { thrown = err }
  return { envelope, thrown, io, committed: boom }
}
const throwingWaitRun = (error) => {
  const io = fakeIo({ seqIds: true })
  io.wait = () => { throw error }
  let envelope = null
  let thrown = null
  try { envelope = driveTask({ ...CTX, head: 'deadbeefcafe' }, io) } catch (err) { thrown = err }
  return { envelope, thrown, io }
}
const escalationStageRows = (io) => io.calls.logs
  .filter((row) => String(row?.stage ?? row?.stage_done ?? '').startsWith('escalate'))
  .map((row) => row.stage ? `stage:${row.stage}` : `stage_done:${row.stage_done}`)

test('T1 — one shape, both exits', () => {
  const crash = crashRun().envelope
  const deliberate = deliberateRun().envelope
  assert.equal(crash.status, 'escalation')
  assert.deepEqual(Object.keys(crash.details).sort(), Object.keys(deliberate.details).sort())
  assert.deepEqual(Object.keys(crash.details).sort(), resumeKeys.slice().sort())
})

test('T2 — gate payload and attempt count', () => {
  const { envelope } = crashRun()
  assert.equal(envelope.details.gate.cmd, 'gate-cmd')
  assert.equal(envelope.details.gate_attempt_high_water, 3)
})

test('T3 — the resume counters are measured', () => {
  const { envelope } = crashRun()
  assert.deepEqual(envelope.details.stages, CRASH_STAGES)
  assert.deepEqual(envelope.details.cursor, { plan_round: 1, build_round: 3, review_round: 1 })
  assert.equal(envelope.details.seq_high_water, 6)
  assert.equal(envelope.details.consults_spent, 1)
  assert.deepEqual(envelope.details.accept_findings, CRASH_FINDINGS)
})

test('T4 — the preserved crash values', () => {
  const { envelope } = crashRun()
  assert.deepEqual(envelope.details.escalation, { where: 'builder', why: CRASH_WHY })
  assert.equal(envelope.summary, `Task t1 needs a human: the driver crashed (${CRASH_WHY})`)
})

test('T5 — the empty-message edge', () => {
  const { envelope, thrown } = throwingWaitRun(new Error(''))
  assert.equal(thrown, null)
  assert.equal(envelope.details.escalation.why, '')
  assert.equal(envelope.summary, 'Task t1 needs a human: the driver crashed ()')
})

test('T6 — a post-commit crash retains the measured commit', () => {
  const run = postCommitCrashRun()
  assert.equal(run.committed, true)
  assert.equal(run.thrown, null)
  assert.equal(run.envelope.details.commit, 'abc1234')
  assert.deepEqual(Object.keys(run.envelope.details).sort(), resumeKeys.slice().sort())
})

test('T7 — head is acquired, not injected', () => {
  const previousExitCode = process.exitCode
  let expectedHead = null
  try {
    const run = runCmdFixture({}, (ctx) => {
      expectedHead = String(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ctx.checkout, encoding: 'utf8' }).stdout).trim()
      return driveTask(ctx, crashIo())
    })
    assert.match(run.ctx.head, /^[0-9a-f]{40}$/)
    assert.equal(run.ctx.head, expectedHead)
    assert.equal(run.envelope.details.head, expectedHead)
  } finally { process.exitCode = previousExitCode }
})

test('T8 — journal stage rows', () => {
  const crash = crashRun()
  assert.deepEqual(escalationStageRows(crash.io), [])
  const deliberate = deliberateRun()
  assert.deepEqual(escalationStageRows(deliberate.io), ['stage:escalate:plan', 'stage_done:escalate:plan'])
})

test('T9 — the deliberate exit is unchanged', () => {
  const { envelope, io } = deliberateRun()
  assert.deepEqual(envelope.details.escalation, { where: 'plan', why: 'no accepted plan within 2 rounds' })
  assert.equal(envelope.summary, 'Task t1 needs a human: no accepted plan within 2 rounds')
  assert.deepEqual(Object.keys(envelope.details).sort(), resumeKeys.slice().sort())
  assert.deepEqual(envelope.details.stages, ['plan:r1', 'plan:r2', 'escalate:plan'])
  assert.deepEqual(envelope.details.cursor, { plan_round: 2, build_round: null, review_round: null })
  assert.equal(envelope.details.seq_high_water, 4)
  assert.equal(envelope.details.consults_spent, 2)
  assert.equal(envelope.details.commit, null)
  assert.equal(envelope.details.gate, null)
  assert.equal(envelope.details.head, 'deadbeefcafe')
  assert.deepEqual(io.calls.run, [])
})

test('T10 — extraDetails still reach the envelope and still land last', () => {
  const { envelope } = carveRun()
  assert.equal(envelope.details.escalation.where, 'plan-carve')
  assert.deepEqual(envelope.details.carve, { verdict: 'carve', slices: [{ summary: 'slice one', files_in_scope: ['a.mjs'] }], defect: null })
})

test('T11 — a pre-arming throw still throws', () => {
  const unknownIo = fakeIo()
  assert.throws(() => driveTask({ ...CTX, variant: 'unknown-shape' }, unknownIo))
  assert.equal(unknownIo.calls.assign.length, 0)
  assert.equal(unknownIo.calls.logs.length, 0)
  const badCtx = new Proxy({ ...CTX, variant: 'full' }, {
    get(target, property, receiver) {
      if (property === 'limits') return new Proxy({}, { ownKeys() { throw new Error('unexecutable shape') } })
      return Reflect.get(target, property, receiver)
    },
  })
  const badIo = fakeIo()
  assert.throws(() => driveTask(badCtx, badIo), /unexecutable shape/)
  assert.equal(badIo.calls.assign.length, 0)
  assert.equal(badIo.calls.logs.length, 0)
})

test('T12 — the escape is exactly the seat-refusal class', () => {
  const refusal = Object.assign(new Error('the provider says: not supported on this model'), { stage: SEAT_REFUSAL_STAGE, role: 'builder' })
  const escaped = throwingWaitRun(refusal)
  assert.equal(escaped.envelope, null)
  assert.equal(escaped.thrown, refusal)
  const builderError = Object.assign(new Error('builder failed'), { stage: 'builder' })
  const converted = throwingWaitRun(builderError)
  assert.equal(converted.thrown, null)
  assert.equal(converted.envelope.status, 'escalation')
  assert.equal(converted.envelope.details.escalation.where, 'builder')
})

test('every escalation exit carries the full resume key set', () => {
  const exits = [
    driveTask(CTX, fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': leadEnv('escalate') } })),
    driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() }, changed: ['a.mjs', 'outside.mjs'] })),
    driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'lane-cmd': { ok: false, output: 'red lane' } }, changed: ['a.mjs'] })),
    driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red suite' } }, changed: ['a.mjs'] })),
  ]
  assert.deepEqual(exits.map((result) => result.status), ['escalation', 'escalation', 'escalation', 'escalation'])
  for (const result of exits) for (const key of resumeKeys) assert.ok(Object.hasOwn(result.details, key), `missing details.${key}`)
  assert.deepEqual(exits.map((result) => result.details.escalation.where), ['plan', 'scope', 'lane', 'suite'])
})

test('there is exactly one escalation composer', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  assert.equal((source.match(/status: 'escalation'/g) || []).length, 1)
})

test('the escalation gate block is the done block', () => {
  const escalationIo = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') },
    runs: { 'gate-cmd': resumeRed(), 'lane-cmd': { ok: false, output: 'red lane' } }, changed: ['a.mjs'],
  })
  const escalated = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalationIo)
  const doneIo = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'gate-cmd:1': resumeRed(), 'gate-cmd:2': resumeGreen(), 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const done = driveTask(CTX, doneIo)
  assert.equal(escalated.details.gate.cmd, 'gate-cmd')
  for (const key of Object.keys(done.details.gate)) assert.ok(Object.hasOwn(escalated.details.gate, key), `missing gate key ${key}`)
})

test('the escalation gate block survives a repair', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-bad' } }),
      'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'gate-fixed' } },
    },
    cleanRuns: { 'gate-bad': resumeGreen(), 'gate-fixed': resumeRed() },
    runs: { 'gate-bad:1': resumeRed(), 'gate-bad:2': resumeGreen(), 'gate-fixed': resumeGreen(), 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'suite red' } },
    changed: ['a.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.gate.cmd, 'gate-fixed')
  assert.equal(result.details.gate.repairs, 1)
  assert.deepEqual(result.details.gate.replaced, ['gate-bad'])
})

test('a pre-gate escalation reads gate null and does not throw', () => {
  const result = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': leadEnv('escalate') } }))
  assert.equal(result.details.gate, null)
  assert.equal(result.details.escalation.where, 'plan')
})

test('roundCursor reads the last round of each loop and a live escalation', () => {
  assert.deepEqual(roundCursor(['plan:r1', 'plan:r2', 'build:r1', 'review:r1', 'build:r2']), { plan_round: 2, build_round: 2, review_round: 1 })
  assert.deepEqual(roundCursor([]), { plan_round: null, build_round: null, review_round: null })
  assert.deepEqual(roundCursor(null), { plan_round: null, build_round: null, review_round: null })
  assert.deepEqual(roundCursor(['plan:r1', null, 4, 'other']), { plan_round: 1, build_round: null, review_round: null })
  const result = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.deepEqual(result.details.cursor, { plan_round: 1, build_round: 1, review_round: 1 })
})

test('review pass, review panel and check labels are not round cursors', () => {
  assert.deepEqual(roundCursor(['plan:r1', 'check:r2', 'review:r1', 'review:panel-r2', 'review:pass']), { plan_round: 1, build_round: null, review_round: 1 })
})

test('seq high water records d ids and ignores legacy fake ids', () => {
  const options = { envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }
  const seqIo = fakeIo({ ...options, seqIds: true })
  const legacyIo = fakeIo(options)
  assert.equal(driveTask(CTX, seqIo).details.seq_high_water, seqIo.calls.assign.length)
  assert.equal(driveTask(CTX, legacyIo).details.seq_high_water, 0)
})

test('gate attempt high water counts every gate invocation', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'gate-cmd': resumeRed(), 'lane-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  const invocations = io.calls.run.filter(({ cmd }) => cmd === 'gate-cmd').length
  assert.equal(result.details.gate_attempt_high_water, invocations)
})

test('consults and reviewer findings carry into an escalation', () => {
  const consulted = driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'lead:1': leadEnv('escalate') }, runs: { 'lane-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.equal(consulted.details.consults_spent, 1)
  const noConsult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv() }, changed: ['a.mjs', 'outside.mjs'] }))
  assert.equal(noConsult.details.consults_spent, 0)
  const findings = [{ id: 'RV1', severity: 'should-fix', location: 'a.mjs:1', summary: 'open' }]
  const normalizedFindings = [{ ...findings[0], disposition: null }]
  const carried = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass', findings) }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.deepEqual(carried.details.accept_findings, normalizedFindings)
  const absent = driveTask(CTX, fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] }))
  assert.equal(absent.details.accept_findings, null)
})

test('panel fused findings are the canonical accept findings', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true } },
      'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1 } }, io)
  const panel = io.calls.logs.map((row) => row.review_outcome).find((row) => row?.panel)
  assert.equal(result.status, 'escalation')
  assert.deepEqual(result.details.accept_findings, panel.findings)
  assert.ok(result.details.accept_findings.some((finding) => finding.reviewer === 'both'))
})

test('normal terminal journals replay as a balanced nested stack', () => {
  const io = fakeIo({ envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'] })
  const result = driveTask(CTX, io)
  assert.deepEqual(resumeStageRows(io), result.details.stages)
  assert.deepEqual(replayResumeStages(io), [])
  assert.equal(new Set(resumeDoneRows(io)).size, resumeDoneRows(io).length)
})

test('stage records entry only and opens nested occurrences', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const stage = (label) => {')
  const rest = source.slice(start)
  const end = rest.indexOf('\n  }\n')
  const body = rest.slice(0, end)
  assert.doesNotMatch(body, /stageComplete\(\)|stage_done/)
  assert.match(body, /openStages\.push\(label\)/)
})

test('a stage that outlives its first blocker is not completed early', () => {
  const run = (lead) => {
    const io = fakeIo({ envelopes: { 'planner:1': { status: 'insufficient', role: 'planner', summary: 'thin', artifacts: [] }, 'lead:1': lead, 'planner:2': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: false, output: 'red' } }, changed: ['a.mjs'] })
    return { io, result: (() => { try { return driveTask(CTX, io) } catch (err) { return err } })() }
  }
  const control = run(leadEnv('bounce'))
  assert.ok(control.io.calls.logs.some((row) => row.stage_done === 'plan:r1'))
  const subject = run(null)
  assert.equal(subject.result.status, 'escalation')
  assert.equal(subject.io.calls.assign.filter(({ role }) => role === 'lead').length, 1)
  assert.equal(subject.io.calls.logs.some((row) => row.stage_done === 'plan:r1'), false)
})

test('nested panel child completes while unfinished review parent does not', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed', [{ id: 'A1', severity: 'must-fix', location: 'a.mjs:1', summary: 'A' }]),
      'tech-lead:2': { status: 'done', role: 'tech-lead', details: { verdict: 'changes-needed', findings: [{ id: 'B1', severity: 'must-fix', location: 'a.mjs:2', summary: 'B' }] } },
      'lead:1': { status: 'done', role: 'lead', details: { adjudications: [], closes_class: true } }, 'lead:2': null,
    }, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const result = driveTask({ ...CTX_TL, continuation: true, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'lead').length, 2)
  assert.ok(io.calls.logs.some((row) => row.stage_done === 'review:panel-r1'))
  assert.equal(io.calls.logs.some((row) => row.stage_done === 'review:r1'), false)
})

test('T13 — entered vs journal-recorded: a failed stage entry row is never completed', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    cleanRuns: { 'gate-cmd': resumeRed() }, runs: { 'gate-cmd:1': resumeRed(), 'gate-cmd:2': resumeGreen(), 'lane-cmd': { ok: true, output: '' } }, changed: ['a.mjs'],
  })
  const originalLog = io.log
  let failed = false
  io.log = (row) => {
    if (!failed && row?.stage === 'gate-proof:1') { failed = true; throw new Error('journal write failed') }
    originalLog(row)
  }
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'escalation')
  assert.match(res.details.escalation.why, /journal write failed/)
  assert.equal(res.details.stages.at(-1), 'gate-proof:1')
  assert.equal(io.calls.logs.some((row) => row.stage === 'gate-proof:1'), false)
  assert.equal(io.calls.logs.some((row) => row.stage_done === 'gate-proof:1'), false)
})

test('runCmd carries the start HEAD and fills a crashed run stage list', () => {
  const previousExitCode = process.exitCode
  try {
    const run = runCmdFixture({}, (ctx) => {
      writeFileSync(ctx.journal, `${JSON.stringify({ at: new Date().toISOString(), stage: 'plan:r1' })}\n`, { flag: 'a' })
      writeFileSync(ctx.journal, `${JSON.stringify({ at: new Date().toISOString(), stage: 'build:r1' })}\n`, { flag: 'a' })
      throw new Error('driver boom')
    })
    assert.ok(run.ctx.head)
    assert.equal(run.rows[0].event, 'run-start')
    assert.equal(run.rows[0].head, run.ctx.head)
    assert.deepEqual(run.envelope.details.stages, ['plan:r1', 'build:r1'])
    assert.equal(run.envelope.details.escalation.where, 'driver')
  } finally { process.exitCode = previousExitCode }
})

// The source inventory deliberately mirrors the acceptance gate's two projections:
// event discriminators and top-level payload keys are independently pinned.
const DRIVE_SINK = /(?:io\?\.log\?\.\(|io\.log\(|(?<![.\w])log\?\.\(|logLine\(join\(paths\.dir, 'journal\.jsonl'\), )/g
function drivePayloadElements(text, from) {
  let i = from
  while (i < text.length && text[i] !== '{') i += 1
  if (text[i] !== '{') return null
  i += 1
  const parts = []
  let buf = ''
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    const two = text.slice(i, i + 2)
    if (two === '//') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (two === '/*') { i = text.indexOf('*/', i); if (i < 0) return null; i += 2; continue }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      let j = i + 1
      while (j < text.length) { if (text[j] === '\\') { j += 2; continue } if (text[j] === q) break; j += 1 }
      buf += text.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '{' || c === '[' || c === '(') { depth += 1; buf += c; i += 1; continue }
    if (c === ']' || c === ')') { depth -= 1; buf += c; i += 1; continue }
    if (c === '}') { if (depth === 0) { parts.push(buf); break } depth -= 1; buf += c; i += 1; continue }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; i += 1; continue }
    buf += c; i += 1
  }
  const collapse = (s) => s.trim().replace(/\s+/g, ' ')
  const events = []
  const keys = []
  for (const raw of parts.map(collapse).filter((s) => s.length > 0)) {
    let m = raw.match(/^event\s*:\s*'([^']*)'/); if (m) { events.push(`event='${m[1]}'`); continue }
    if (raw.startsWith('...')) { keys.push(`...${collapse(raw.slice(3))}`); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)\s*:/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^([A-Za-z_$][\w$]*)$/); if (m) { keys.push(m[1]); continue }
    m = raw.match(/^'([^']*)'\s*:/); if (m) { keys.push(m[1]); continue }
    keys.push(raw)
  }
  return { events: events.join(' '), keys: keys.join(' ') }
}
function driveJournalSites(text) {
  DRIVE_SINK.lastIndex = 0
  const out = []
  let hit
  while ((hit = DRIVE_SINK.exec(text)) !== null) {
    const line = text.slice(0, hit.index).split('\n').length
    const after = text.slice(hit.index + hit[0].length)
    const payload = drivePayloadElements(text, hit.index + hit[0].length)
    out.push({
      line,
      wrapper: after.startsWith('recordRow(') ? 'recordRow' : after.startsWith('operationalRow(') ? 'operationalRow' : null,
      events: payload?.events ?? null,
      keys: payload?.keys ?? null,
    })
  }
  return out
}
const DRIVE_JOURNAL_EXPECTED = Object.freeze([
  ['recordRow', '', 'at modifier'],
  ['recordRow', '', 'at modifier'],
  ['recordRow', '', 'at stage_done'],
  ['recordRow', '', 'at stage'],
  ['operationalRow', '', 'at gate_reap'],
  ['recordRow', '', 'at no_lead_escalation'],
  ['recordRow', '', 'at converge_declined'],
  ['recordRow', '', 'at converge_declined'],
  ['recordRow', '', 'at converge_declined residual why'],
  ['recordRow', '', 'at converge_declined residual why'],
  ['recordRow', '', 'at commit_subject'],
  ['recordRow', '', 'at assign role brief'],
  ['recordRow', '', 'at review_outcome'],
  ['recordRow', '', 'at review_findings_note'],
  ['recordRow', '', 'at envelope role status'],
  ['recordRow', '', 'at no_lead_escalation'],
  ['recordRow', '', 'at perspective_from recommendation consult'],
  ['recordRow', '', 'at dissent'],
  ['recordRow', '', 'at bounce_target_mapped'],
  ['recordRow', '', 'at decision consult round reason'],
  ['recordRow', '', 'at extra_round_granted'],
  ['recordRow', '', 'at accept_reask'],
  ['recordRow', '', 'at accept_decision'],
  ['recordRow', '', 'at envelope_accepted'],
  ['recordRow', '', 'at triage'],
  ['recordRow', '', 'at directed'],
  ['recordRow', '', 'at member_questions'],
  ['recordRow', '', 'at question_answers'],
  ['recordRow', '', 'at plan_scope'],
  ['recordRow', '', 'at gate_path_rejected'],
  ['recordRow', '', 'at plan_growth'],
  ['recordRow', '', 'at carve_verdict'],
  ['recordRow', '', 'at gate_discrimination gate_generation gate_summary gate_proof_note'],
  ['recordRow', '', 'at gate_proof_unproven gate_generation'],
  ['recordRow', '', 'at gate_check_proof_unproven gate_generation'],
  ['recordRow', '', 'at mutation_anchor_bind'],
  ['recordRow', '', 'at mutation_anchor_absent'],
  ['recordRow', '', 'at gate_check_discrimination gate_generation gate_check_discriminations ...(checkProofNote ? { gate_check_proof_note: checkProofNote } : {})'],
  ['recordRow', '', 'at finding_hardened'],
  ['recordRow', '', 'at ...entry'],
  ['recordRow', '', 'at auto_fix'],
  ['recordRow', '', 'at auto_fix_revalidation'],
  ['recordRow', '', 'at scope_gate'],
  ['recordRow', '', 'at member_questions'],
  ['recordRow', '', 'at question_answers'],
  ['recordRow', '', 'at review_round'],
  ['recordRow', '', 'at auto_fix'],
  ['recordRow', '', 'at commit_subject'],
  ['recordRow', '', 'at cold_suite'],
  ['recordRow', '', 'at narration'],
  ['recordRow', '', 'at published'],
  ['operationalRow', '', 'at event kind queue_depth waited_ms slotted'],
])

test('the journal channel vocabulary is closed, exported and additive', () => {
  assert.equal(Object.isFrozen(JOURNAL_CHANNELS), true)
  assert.deepEqual(JOURNAL_CHANNELS, { record: 'record', operational: 'operational' })
  assert.deepEqual([...JOURNAL_CHANNEL_NAMES], ['record', 'operational'])
  assert.equal(Object.isFrozen(JOURNAL_CHANNEL_NAMES), true)
  assert.deepEqual(recordRow({ at: 't', stage: 'plan' }), { at: 't', stage: 'plan', channel: 'record' })
  assert.deepEqual(operationalRow({ at: 't', event: 'descendant-capture', records: 3 }), {
    at: 't', event: 'descendant-capture', records: 3, channel: 'operational',
  })
  assert.equal(operationalRow({ channel: 'record' }).channel, 'operational')
})

test('every journal emit site in the driver is inventoried, wrapped and on the right channel', () => {
  const text = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const sites = driveJournalSites(text)
  assert.equal(sites.length, 52)
  assert.deepEqual(sites.map(({ wrapper, events, keys }) => [wrapper, events, keys]), DRIVE_JOURNAL_EXPECTED)
  assert.ok(sites.every(({ wrapper }) => wrapper === 'recordRow' || wrapper === 'operationalRow'))
  assert.equal(sites.filter(({ wrapper }) => wrapper === 'operationalRow').length, 2)
  assert.deepEqual(sites.filter(({ wrapper }) => wrapper === 'operationalRow').map(({ events, keys }) => [events, keys]), [
    ['', 'at gate_reap'], ['', 'at event kind queue_depth waited_ms slotted'],
  ])
})

test('a full drive writes no journal row without a channel', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.ok(io.calls.logs.length > 0)
  for (const row of io.calls.logs) {
    assert.ok(JOURNAL_CHANNEL_NAMES.includes(row.channel), `${JSON.stringify(row)} carries no channel`)
  }
})


// ---------------------------------------------------------------------------
// #751 — a lead's bounce at a review exhaustion has TWO recipients.
// Both site fixtures configure a real gate_cmd (RED at baseline, green after)
// so "the acceptance gate is skipped for a reviewer bounce and re-run for a
// builder bounce" is a claim the recorded stages can actually carry.
const B318_GATED_RUNS = {
  'gate-cmd:1': { ok: false, output: `baseline red\n${GATE_SUMMARY_PREFIX} {"total":2,"failed":2,"errored":0}` },
  'gate-cmd': { ok: true, output: `green\n${GATE_SUMMARY_PREFIX} {"total":2,"failed":0,"errored":0}` },
  'lane-cmd': { ok: true, output: '' },
  'suite-cmd': { ok: true, output: '' },
}
const b318GatedPlan = () => planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } })

// Site A: the exhaustion consult at the TOP of the review loop (review budget
// spent). Round 2 runs its own gate:r2 before the consult is reached.
function b318SiteA(decision, { secondReview = 'pass', secondLead = null, reseat = null } = {}) {
  const envelopes = {
    'planner:1': b318GatedPlan(),
    'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(), 'builder:4': buildEnv(),
    'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv(secondReview), 'reviewer:3': reviewEnv('pass'),
    'lead:1': leadEnv(decision),
  }
  if (secondLead) envelopes['lead:2'] = leadEnv(secondLead)
  const io = fakeIo({ envelopes, runs: B318_GATED_RUNS, changed: ['a.mjs', 'a.test.mjs'], ...(reseat ? { reseat } : {}) })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 1 } }, io)
  return { io, result }
}

// Site B: the consult reached when the BUILD budget is spent and the standing
// verdict is changes-needed.
function b318SiteB(decision, { secondReview = 'pass' } = {}) {
  const io = fakeIo({
    envelopes: {
      'planner:1': b318GatedPlan(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(), 'builder:3': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv(secondReview), 'reviewer:3': reviewEnv('pass'),
      'lead:1': leadEnv(decision),
    },
    runs: B318_GATED_RUNS,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1, review_rounds: 2 } }, io)
  return { io, result }
}

const b318Options = (brief) => [...(String(brief).match(/## Your options[^\n]*\n([\s\S]*?)\n\n/)?.[1] ?? '')
  .matchAll(/^- ([^\n]+)$/gm)].map(([, option]) => option.replace(/\s+\(.*$/, ''))
const b318ReviewGrants = (res) => (res.details.extra_rounds_granted ?? []).filter(({ where }) => where === 'review')
const b318Builders = (io) => io.calls.assign.filter(({ role }) => role === 'builder')

test('bounce-reviewer at review exhaustion re-reviews the same tree', () => {
  const { io, result } = b318SiteA('bounce-reviewer', {
    reseat: (role) => role === 'reviewer' ? { applied: true } : { applied: false, reason: 'transport' },
  })
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1',
    'build:r2', 'scope-gate:r2', 'lane:r2', 'gate:r2', 'review:r2', 'review:pass',
    'commit', 'suite', 'suite:cold', 'done',
  ])
  assert.equal(b318Builders(io).length, 2)
  const roles = io.calls.assign.map(({ role }) => role)
  assert.equal(roles[roles.indexOf('lead') + 1], 'reviewer')
  assert.deepEqual(io.calls.reseat, [
    { role: 'builder', options: { reason: 'review-bounce' } },
    { role: 'reviewer', options: { reason: 'review-bounce' } },
  ])
})

test("bounce-builder at review exhaustion is today's bounce", () => {
  const { io, result } = b318SiteA('bounce-builder')
  assert.equal(result.status, 'done')
  for (const label of ['build:r3', 'scope-gate:r3', 'lane:r3', 'gate:r3']) {
    assert.ok(result.details.stages.includes(label), `expected stage ${label}`)
  }
  const builders = b318Builders(io)
  assert.equal(builders.length, 3)
  assert.equal(builders[2].note, 'review-fix')
  assert.match(io.calls.writes[`${TD}/build-bounce-r2.md`], /Close every must-fix/)
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('bounce-builder at build exhaustion also spends exactly one review grant', () => {
  const { result } = b318SiteB('bounce-builder')
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('the two review-exhaustion consults offer both recipients', () => {
  const want = ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate', 'second-opinion']
  for (const { io } of [b318SiteA('bounce-reviewer'), b318SiteB('bounce-reviewer')]) {
    assert.deepEqual(b318Options(io.calls.writes[`${TD}/decision-1.md`]), want)
  }
})

test('either target spends the one review grant', () => {
  const { io, result } = b318SiteA('bounce-reviewer', { secondReview: 'changes-needed', secondLead: 'escalate' })
  assert.equal(result.status, 'escalation')
  // The valve is offered on the FIRST round of every consult, so it rides along.
  assert.deepEqual(b318Options(io.calls.writes[`${TD}/decision-2.md`]), ['accept', 'escalate', 'second-opinion'])
  assert.equal(b318ReviewGrants(result).length, 1)
})

test('a bare bounce at a review exhaustion is read as bounce-builder and journalled', () => {
  const { io, result } = b318SiteA('bounce')
  assert.equal(result.status, 'done')
  assert.ok(result.details.stages.includes('build:r3'))
  assert.equal(io.calls.logs.find((row) => typeof row.decision === 'string').decision, 'bounce-builder')
  assert.deepEqual(
    io.calls.logs.find((row) => row.bounce_target_mapped).bounce_target_mapped,
    { answered: 'bounce', treated_as: 'bounce-builder', consult: 1, round: 1 },
  )
})

test('bounce-reviewer at build exhaustion re-reviews without a build', () => {
  const { io, result } = b318SiteB('bounce-reviewer')
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1',
    'review:r2', 'review:pass', 'commit', 'suite', 'suite:cold', 'done',
  ])
  assert.equal(b318Builders(io).length, 1)
})

test('the re-review brief states only what holds at both exhaustion sites', () => {
  for (const [label, { io }] of [['site A', b318SiteA('bounce-reviewer')], ['site B', b318SiteB('bounce-reviewer')]]) {
    const brief = io.calls.writes[`${TD}/review-brief-2.md`]
    const flat = brief.replace(/\s+/g, ' ')
    assert.ok(flat.includes('STALE'), `${label}: no STALE`)
    const where = label === 'site A' ? 'review-exhausted' : 'build-exhausted'
    assert.ok(flat.includes(`STALE (${where})`), `${label}: wrong exhaustion label`)
    assert.ok(flat.includes(`${TD}/review.md`), `${label}: no review path`)
    assert.ok(flat.includes('against the CURRENT tree'), `${label}: no CURRENT tree`)
    assert.ok(flat.includes('reviewer bounce itself built nothing'), `${label}: no built-nothing clause`)
    assert.ok(flat.includes('every configured acceptance gate'), `${label}: no configured-gate clause`)
    // One helper serves both sites, so neither chronology may be asserted: the
    // site-A path builds after the standing verdict, while the site-B consult
    // follows its verdict directly.
    assert.equal(flat.includes('nothing has been built since it was written'), false, `${label}: false chronology`)
    assert.equal(flat.includes('the tree moved after'), false, `${label}: unconditional chronology`)
    assert.equal(io.calls.writes[`${TD}/review-brief-1.md`].includes('STALE'), false, `${label}: first brief contaminated`)
  }
})

test('bounceTargetOf maps only where the bare name is off the menu', () => {
  const targets = ['bounce-builder', 'bounce-reviewer', 'accept', 'escalate']
  assert.equal(bounceTargetOf('bounce', ['bounce', 'accept', 'escalate']), 'bounce')
  assert.equal(bounceTargetOf('bounce', targets), 'bounce-builder')
  assert.equal(bounceTargetOf('accept', targets), 'accept')
  assert.equal(bounceTargetOf('bounce', ['accept', 'escalate']), 'bounce')
  assert.equal(bounceTargetOf('bounce', null), 'bounce')
  assert.equal(bounceTargetOf(undefined, targets), undefined)
})

test('staleVerdictLines is empty for an ordinary review round', () => {
  for (const input of [null, undefined, {}, { path: 7 }, { where: 'review-exhausted' }]) {
    assert.deepEqual(staleVerdictLines(input), [])
  }
})

test('staleVerdictLines states only what holds at both sites', () => {
  const flat = staleVerdictLines({ path: '/t/review.md', where: 'build-exhausted' }).join('\n').replace(/\s+/g, ' ')
  for (const token of ['/t/review.md', 'STALE', 'build-exhausted', 'against the CURRENT tree',
    'reviewer bounce itself built nothing', 'every configured acceptance gate']) {
    assert.ok(flat.includes(token), `stale note must say ${token}`)
  }
  assert.equal(flat.includes('nothing has been built since it was written'), false)
  assert.equal(flat.includes('the tree moved after'), false)
})

test('a stale re-review brief survives an unreadable in-place re-ask', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': b318GatedPlan(),
      'builder:1': buildEnv(), 'builder:2': buildEnv(),
      'reviewer:1': reviewEnv('changes-needed'),
      'reviewer:2': { status: 'done', role: 'reviewer', details: { verdict: 'unknown-shape' } },
      'reviewer:3': reviewEnv('changes-needed'),
      'lead:1': leadEnv('bounce-reviewer'), 'lead:2': leadEnv('bounce'), 'lead:3': leadEnv('escalate'),
    },
    runs: B318_GATED_RUNS,
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 3)
  const briefs = io.calls.writeLog
    .filter(({ path }) => path === `${TD}/review-brief-2.md`)
    .map(({ content }) => content)
  assert.equal(briefs.length, 2)
  assert.match(briefs[1], /STALE/)
})

// #679 publication seam fixtures. Unlike the historical fakeIo, these retain a
// mutable HEAD so the warm and cold observations can prove which commit they saw.
const PUBLISH_WARM_OUTPUT = '# pass 1\n# fail 0\n# skipped 1\n'
const PUBLISH_COLD_OUTPUT = '# pass 2\n# fail 0\n# skipped 2\n'
function publicationIo(options = {}) {
  const {
    commands: commandOverrides = {}, envelopes: envelopeOverrides = {}, changed = ['a.mjs', 'a.test.mjs'],
    warm = PUBLISH_WARM_OUTPUT, coldOutput = PUBLISH_COLD_OUTPUT, coldResult, journal = `${TD}/journal.jsonl`,
    journalText: initialJournal = JSON.stringify({ event: RUN_START_EVENT }) + '\n', readFileThrows = false,
    capabilities = null,
  } = options
  const calls = { run: [], runCold: [], commits: [], logs: [], writes: {}, order: [], suiteHead: null, coldHead: null }
  const state = { pre: 'pre1111', head: 'pre1111', post: 'post2222' }
  let journalText = initialJournal
  let clock = 0
  const roleCounts = {}
  const defaults = {
    'lane-cmd': { ok: true, output: '' },
    'suite-cmd': () => ({ ok: true, output: warm }),
    'git fetch origin main': { ok: true, output: '' },
    'git rev-parse origin/main': { ok: true, output: 'base1111\n' },
    'git merge-base HEAD origin/main': { ok: true, output: 'older000\n' },
    'git rebase origin/main': (s) => { s.head = s.post; return { ok: true, output: '' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: '' },
    'git rebase --abort': (s) => { s.head = s.pre; return { ok: true, output: '' } },
    'git rev-parse HEAD': (s) => ({ ok: true, output: `${s.head}\n` }),
    'command -v gh': { ok: true, output: '/usr/bin/gh\n' },
    'gh auth status': { ok: true, output: 'logged in\n' },
    'gh pr view': { ok: false, output: 'no pull requests found for this branch\n' },
    'git push -u origin': { ok: true, output: '' },
    'gh pr create': { ok: true, output: 'https://github.com/o/r/pull/42\n' },
  }
  const commands = { ...defaults, ...commandOverrides }
  const envelopes = {
    'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'), ...envelopeOverrides,
  }
  const findCommand = (command) => Object.keys(commands).find((key) => command === key || command.startsWith(key))
  const response = (command) => {
    const key = findCommand(command)
    if (!key) return { ok: true, output: '' }
    const value = commands[key]
    return typeof value === 'function' ? value(state, command) : value
  }
  const io = {
    calls, state,
    assign({ role }) {
      roleCounts[role] = (roleCounts[role] || 0) + 1
      const n = roleCounts[role]
      return { id: `${role}${n}`, returnPath: `${role}:${n}` }
    },
    wait(path) {
      const value = envelopes[path]
      return typeof value === 'function' ? value() : value ?? null
    },
    writeFile(path, content) { calls.writes[path] = content },
    readFile(path) {
      if (readFileThrows) throw new Error('journal read denied')
      if (path === journal) return journalText
      if (capabilities !== null && path === `${CTX.checkout}/crew/capabilities.json`) return capabilities
      return null
    },
    run(command) {
      const text = String(command)
      calls.run.push(text); calls.order.push(`run:${text}`)
      if (text === 'suite-cmd') calls.suiteHead = state.head
      return response(text)
    },
    runCold(command, names) {
      calls.runCold.push({ cmd: command, names }); calls.order.push('runCold'); calls.coldHead = state.head
      if (typeof coldResult === 'function') return coldResult(state, command, names)
      if (coldResult !== undefined) return coldResult
      return { ok: true, output: coldOutput, path: '/cold/checkout', kept: null }
    },
    changedFiles() { return [...changed] },
    commit(files, message) { calls.commits.push({ files, message }); calls.order.push('commit'); state.head = state.pre; return state.pre },
    log(row) { calls.logs.push(row); journalText += `${JSON.stringify(row)}\n` },
    now() { clock += 10; return clock },
  }
  return io
}
function runPublished(options = {}) {
  const branch = options.branch === undefined ? 'feature/ship' : options.branch
  const ctx = {
    ...CTX, task: options.task || 'published-task', taskDir: options.taskDir || TD,
    journal: options.journal || `${options.taskDir || TD}/journal.jsonl`,
    ...(options.ctx || {}), publish: options.publish === undefined ? { branch } : options.publish,
  }
  const io = publicationIo(options)
  let result
  try { result = driveTask(ctx, io) } catch (error) { return { ctx, io, error } }
  return { ctx, io, result }
}

test('armed happy path records commit, rebase, warm/cold suites, publish, and done in order', () => {
  const { result, io } = runPublished({})
  assert.equal(result.status, 'done')
  const at = result.details.stages.indexOf('commit')
  assert.deepEqual(result.details.stages.slice(at), ['commit', 'rebase', 'suite', 'suite:cold', 'publish', 'done'])
  assert.equal(io.calls.suiteHead, io.state.post)
  assert.equal(io.calls.coldHead, io.state.post)
  assert.equal(result.details.commit, io.state.post)
  assert.deepEqual(result.details.pr, { url: 'https://github.com/o/r/pull/42', number: 42, head: 'feature/ship', base_sha: 'base1111' })
  const row = io.calls.logs.find((entry) => entry.published)
  assert.ok(row)
  for (const key of ['rebase', 'push', 'pr_create']) assert.equal(Number.isFinite(row.published.durations_ms[key]), true)
})

test('stateful moved and unmoved bases prove the exact rebase policy', () => {
  const moved = runPublished({})
  assert.equal(moved.result.status, 'done')
  assert.equal(moved.io.calls.run.includes('git rebase origin/main'), true)
  assert.equal(moved.io.calls.suiteHead, moved.io.state.post)
  const unmoved = runPublished({
    commands: {
      'git rev-parse origin/main': { ok: true, output: 'same1111\n' },
      'git merge-base HEAD origin/main': { ok: true, output: 'same1111\n' },
    },
  })
  assert.equal(unmoved.result.status, 'done')
  assert.equal(unmoved.io.calls.run.includes('git rebase origin/main'), false)
  assert.equal(unmoved.io.calls.logs.find((entry) => entry.published).published.rebased, false)
  assert.equal(unmoved.result.details.commit, unmoved.io.state.pre)
})

test('shellArg round-trips through a real /bin/sh without executing payload metacharacters', () => {
  const sentinel = join(tmpdir(), `crew-shellarg-${process.pid}-${Date.now()}`)
  const payload = [`a'b; touch`, sentinel, '; $HOME `printf injected` with whitespace'].join(' ')
  try {
    const script = `set -- ${shellArg(payload)}; printf '%s\n' "$#"; printf '%s' "$1"`
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const [argc, value] = result.stdout.split('\n')
    assert.equal(argc, '1')
    assert.equal(value, payload)
    assert.equal(existsSync(sentinel), false)
  } finally { rmSync(sentinel, { force: true }) }
})

test('post-commit fetch, push, and warm-suite failures are deliberate escalations with the real commit', () => {
  const failedFetch = runPublished({ commands: { 'git fetch origin main': { ok: false, output: 'network down' } } })
  assert.equal(failedFetch.result.status, 'escalation')
  assert.equal(failedFetch.result.details.escalation.where, 'rebase')
  assert.equal(failedFetch.result.details.commit, failedFetch.io.state.pre)
  const failedPush = runPublished({ commands: { 'git push -u origin': { ok: false, output: 'rejected' } } })
  assert.equal(failedPush.result.status, 'escalation')
  assert.equal(failedPush.result.details.escalation.where, 'publish')
  assert.equal(failedPush.result.details.commit, failedPush.io.state.post)
  const redWarm = runPublished({ commands: { 'suite-cmd': { ok: false, output: 'boom' } } })
  assert.equal(redWarm.result.status, 'escalation')
  assert.equal(redWarm.result.details.escalation.where, 'suite')
  assert.equal(redWarm.result.details.commit, redWarm.io.state.post)
  for (const run of [failedFetch, failedPush, redWarm]) assert.notEqual(run.result.details.escalation.where, 'driver')
})

test('failed and blank rebase probes, post-head probes, empty conflicts, and restoration failures fail closed', () => {
  const probes = [
    { commands: { 'git rev-parse origin/main': { ok: false, output: 'missing' } } },
    { commands: { 'git rev-parse origin/main': { ok: true, output: '' } } },
    { commands: { 'git merge-base HEAD origin/main': { ok: false, output: 'missing' } } },
    { commands: { 'git merge-base HEAD origin/main': { ok: true, output: '' } } },
    { commands: { 'git rev-parse HEAD': { ok: false, output: 'missing' } } },
    { commands: { 'git rev-parse HEAD': { ok: true, output: '' } } },
  ]
  for (const options of probes) {
    const run = runPublished(options)
    assert.equal(run.result.status, 'escalation')
    assert.equal(run.result.details.escalation.where, 'rebase')
    assert.equal(run.io.calls.run.some((command) => command.startsWith('git push')), false)
  }
  const emptyConflict = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: '' },
    'git rebase --abort': (state) => { state.head = state.pre; return { ok: true, output: '' } },
  } })
  assert.equal(emptyConflict.result.status, 'escalation')
  assert.doesNotMatch(emptyConflict.result.details.escalation.why, /conflict/i)
  const failedAbort = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: false, output: 'abort failed' },
    'git rev-parse HEAD': (state) => ({ ok: true, output: `${state.head}\n` }),
  } })
  assert.equal(failedAbort.result.status, 'escalation')
  assert.match(failedAbort.result.details.escalation.why, /UNPROVEN/)
  assert.match(failedAbort.result.details.escalation.why, /mid3333/)
  const wrongHead = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: true, output: '' },
    'git rev-parse HEAD': { ok: true, output: 'other4444\n' },
  } })
  assert.equal(wrongHead.result.status, 'escalation')
  assert.match(wrongHead.result.details.escalation.why, /UNPROVEN/)
  assert.match(wrongHead.result.details.escalation.why, /other4444/)
})

test('each closed publish refusal is named and never creates a pull request', () => {
  const cases = [
    ['branch-unresolved', { branch: '' }],
    ['branch-main', { branch: 'main' }],
    ['gh-missing', { commands: { 'command -v gh': { ok: false, output: '' } } }],
    ['gh-auth', { commands: { 'gh auth status': { ok: false, output: 'not logged in' } } }],
    ['pr-exists', { commands: { 'gh pr view': { ok: true, output: 'not json' } } }],
    ['pr-check', { commands: { 'gh pr view': { ok: false, output: 'permission denied' } } }],
    ['push-rejected', { commands: { 'git push -u origin': { ok: false, output: 'rejected' } } }],
    ['pr-create', { commands: { 'gh pr create': { ok: true, output: 'created but URL omitted' } } }],
  ]
  assert.deepEqual(new Set(cases.map(([reason]) => reason)), new Set(PUBLISH_REFUSAL_NAMES))
  for (const [reason, options] of cases) {
    const run = runPublished(options)
    assert.equal(run.result.status, 'escalation', reason)
    assert.equal(run.result.details.escalation.where, 'publish', reason)
    assert.match(run.result.details.escalation.why, new RegExp(reason), reason)
    assert.equal(run.result.details.publish.refused, reason)
    assert.equal(run.result.details.pr, undefined, reason)
    if (reason !== 'pr-create') assert.equal(run.io.calls.run.some((command) => command.startsWith('gh pr create')), false, reason)
  }
})

test('all branch and task paths are shellArg quoted in publication commands', () => {
  const branch = "feat/'$HOME; echo pwn `x` with spaces"
  const taskDir = "/tmp/task/'$HOME; echo pwn with spaces"
  const run = runPublished({ branch, taskDir })
  assert.equal(run.result.status, 'done')
  const commands = run.io.calls.run
  const quotedBranch = shellArg(branch)
  assert.ok(commands.some((command) => command.includes(`git push -u origin ${quotedBranch}`)))
  assert.ok(commands.some((command) => command.includes(`gh pr view ${quotedBranch}`)))
  const body = shellArg(`${taskDir}/pr-body.md`)
  assert.ok(commands.some((command) => command.includes(`--body-file ${body}`)))
})

test('an exit-zero malformed PR probe, indeterminate probe, and throwing journal read all fail or publish safely', () => {
  const malformed = runPublished({ commands: { 'gh pr view': { ok: true, output: '{not-json}' } } })
  assert.equal(malformed.result.details.publish.refused, 'pr-exists')
  const indeterminate = runPublished({ commands: { 'gh pr view': { ok: false, output: 'gh service unavailable' } } })
  assert.equal(indeterminate.result.details.publish.refused, 'pr-check')
  const throwingRead = runPublished({ readFileThrows: true })
  assert.equal(throwingRead.result.status, 'done')
  assert.ok(throwingRead.io.calls.writes[`${TD}/pr-body.md`])
})

test('composePrBody is pure and renders every populated section with its own values', () => {
  const record = {
    issues: ['#679', '#758'], stages: ['commit', 'rebase', 'suite', 'publish', 'done'],
    cursor: { plan_round: 4, build_round: 5, review_round: 6 },
    gate: { cmd: 'gate-cmd', summary: { total: 2, failed: 0, errored: 0 }, discrimination: 'proven', repairs: 1 },
    review: { verdict: 'changes-needed', residuals: [{ id: 'R1', type: 'cosmetic', summary: 'leave this note' }] },
    suite: { warm: { pass: 11, fail: 2, skipped: 3 }, cold: { pass: 13, fail: 4, skipped: 5 }, cold_verified: true },
    intent: 'why the lane existed', closes: ['#806'], files: ['crew/drive.mjs'],
    anomalies: [{ kind: 'bounce', detail: 'retry' }],
  }
  const first = composePrBody(record)
  const second = composePrBody(JSON.parse(JSON.stringify(record)))
  assert.equal(first, second)
  assert.equal(first, [
    'why the lane existed',
    'Closes #806\nRefs #679, #758',
    '**2 gate checks, 0 failed, 0 errored, discrimination proven** (gate-cmd), repaired 1 time.',
    'Suite warm 11 pass / 2 fail / 3 skip; cold 13 pass / 4 fail / 5 skip, cold-verified from a fresh checkout.',
    'Review: changes-needed, 1 residual:\n- R1 (cosmetic): leave this note',
    'Changed: crew/drive.mjs',
    'Shape: commit → rebase → suite → publish',
    '- bounce: retry',
  ].join('\n\n'))
  assert.doesNotMatch(first, /\n{3,}/)
  const sparse = composePrBody({ closes: ['#806'] })
  assert.equal(sparse, [
    'Closes #806',
    'No acceptance gate ran.',
    'Suite counts: not measured.',
    'Review: not recorded, no residuals',
  ].join('\n\n'))
  for (const token of ['why the lane existed', 'Closes #806', 'Refs #679, #758',
    '2 gate checks, 0 failed, 0 errored, discrimination proven', '(gate-cmd)', 'repaired 1 time',
    'warm 11 pass / 2 fail / 3 skip', 'cold 13 pass / 4 fail / 5 skip', 'cold-verified from a fresh checkout',
    'Review: changes-needed, 1 residual:', 'R1 (cosmetic): leave this note', 'Changed: crew/drive.mjs',
    'Shape: commit → rebase → suite → publish', '- bounce: retry']) assert.ok(first.includes(token), token)
  assert.equal(first.split('\n')[0], 'why the lane existed')
  assert.ok(!/\{\s*"/.test(first))
})

// ---------------------------------------------------------------------------
// #806 — the published body leads with meaning, and record-only narration.
// ---------------------------------------------------------------------------
const NARRATOR_REGISTER = (base_url) => JSON.stringify({ local_providers: {
  narrator: { settings: 'crew/pi/settings.json', pi_provider: 'local-pi', base_url },
} })
const HONEST_NARRATION = 'The lane took 2 build rounds and 11 gate checks, changing crew/drive.mjs at stage review:r1.'
const NARRATION_RECORD = Object.freeze({
  intent: 'why the lane existed', closes: ['#806'], issues: ['#799'],
  stages: ['plan:r1', 'check:r1', 'gate-baseline', 'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1',
    'review:r1', 'review:r1', 'build:r2', 'review:r2', 'commit', 'rebase', 'suite', 'publish'],
  cursor: { plan_round: 1, build_round: 2, review_round: 2 },
  files: ['crew/drive.mjs'],
  gate: { cmd: 'node task/gate.mjs', summary: { total: 11, failed: 0, errored: 0 }, discrimination: 'proven', repairs: 0 },
  review: { verdict: 'pass', residuals: [] },
  suite: { warm: { pass: 3098, fail: 0, skipped: 0 }, cold: { pass: 3098, fail: 0, skipped: 0 }, cold_verified: true },
  anomalies: [],
})
// One io.run for the model list and one for the chat completion; both injected, so no
// test here contacts a real endpoint or reaches a binary-resolution seam.
const narratorIo = ({ models, chat, collect = [] } = {}) => ({ run: (command) => {
  collect.push(command)
  return /\/models(\b|$)/.test(command)
    ? (models ?? { ok: true, output: JSON.stringify({ data: [{ id: 'qwen3-coder' }] }) })
    : (chat ?? { ok: true, output: JSON.stringify({ choices: [{ message: { content: HONEST_NARRATION } }] }) })
} })

test('commitIntent removes only the final trailer block and keeps an internal one verbatim', () => {
  const internal = 'fix(crew): subject\n\nRefs: are explained below\nand here they are.\n\nCloses: #806\nRefs: #799'
  assert.equal(commitIntent(internal), 'Refs: are explained below\nand here they are.')
  assert.equal(commitIntent('subject\n\nbody text\n\nCloses: #806\nRefs: #799'), 'body text')
  assert.equal(commitIntent('subject\n\nbody text'), 'body text')
  assert.equal(commitIntent('subject\n\nCloses: #1'), '')
  assert.equal(commitIntent('subject'), '')
  assert.equal(commitIntent(undefined), '')
  // the blank separator between two trailers is crossed; the paragraph above is not
  assert.equal(commitIntent('s\n\nfirst\n\nsecond\n\nCloses: #1\n\nRefs: #2'), 'first\n\nsecond')
  // "verbatim" covers the body's LAST line: trailer-shaped PROSE is not a trailer, and
  // COMMIT_TRAILER recognises only what the driver itself composes.
  for (const tail of ['Refs: are explained below', 'Fixes: are explained below', 'Closes: see the issue']) {
    assert.equal(commitIntent('subject\n\nbody\n' + tail), 'body\n' + tail, tail)
    assert.doesNotMatch(tail, COMMIT_TRAILER)
  }
  for (const trailer of ['Refs: #799', 'Closes: #806', 'Refs: #799, #806', 'Fixes: #12']) {
    assert.equal(commitIntent('subject\n\nbody\n' + trailer), 'body', trailer)
    assert.match(trailer, COMMIT_TRAILER)
  }
})

test('stageShape keeps only major phases and counts distinct rounds', () => {
  // A faithful judge-run publish-time list: the instrumentation a judge run really
  // journals, both rounds, suite + suite:cold, publish — and no `done`, because the
  // body record is built during publish and stage('done') happens afterwards.
  const stages = ['plan:r1', 'check:r1', 'gate-baseline', 'gate-proof:1', 'gate-proof:1:checks',
    'build:r1', 'scope-gate:r1', 'lane:r1', 'gate:r1', 'review:r1', 'review:r1',
    'build:r2', 'scope-gate:r2', 'lane:r2', 'gate:r2', 'review:r2', 'review:pass',
    'commit', 'rebase', 'suite', 'suite:cold', 'publish']
  assert.equal(stageShape(stages), 'plan → build ×2 → review ×2 → commit → rebase → suite → publish')
  for (const noisy of ['check', 'gate-baseline', 'gate-repair', 'gate-reverify', 'gate-proof', 'scope-gate', 'lane', 'gate', 'done']) {
    assert.equal(stageShape(stages).includes(noisy), false, noisy)
    assert.equal(SHAPE_MAJOR_PHASES.includes(noisy), false, noisy)
  }
  // the allow-list is closed and every full-variant head is either a phase or omitted
  assert.deepEqual([...SHAPE_MAJOR_PHASES], ['plan', 'build', 'review', 'commit', 'rebase', 'suite', 'publish'])
  assert.equal(Object.isFrozen(SHAPE_MAJOR_PHASES), true)
  // suite:cold folds into suite because its head does
  assert.equal(stageShape(['suite', 'suite:cold']), 'suite')
  // review:pass is a verdict, never a round
  assert.equal(stageShape(['review:r1', 'review:pass']), 'review')
  assert.deepEqual([...SHAPE_ROUNDED_STAGES], ['plan', 'build', 'review'])
  assert.equal(stageShape([]), '')
  assert.equal(stageShape('not-an-array'), '')
  // the exact adjacent repetition stays collapseStages' business
  assert.deepEqual(collapseStages(['review:r1', 'review:r1', 'commit']), [{ token: 'review:r1', count: 2 }, { token: 'commit', count: 1 }])
})

test('issueTrailers separates closing keywords from references and an undeclared closes changes no commit message', () => {
  assert.deepEqual(issueTrailers('subject\n\nbody\n\nCloses: #806\nRefs: #806, #799'), { closes: ['#806'], refs: ['#799'] })
  assert.deepEqual(issueTrailers('subject\n\nbody\n\nFixes #12\n\nRefs: #13'), { closes: ['#12'], refs: ['#13'] })
  assert.deepEqual(issueTrailers('subject\n\nbody'), { closes: [], refs: [] })
  const today = composeCommitMessage({
    task: 'x', planEnv: { summary: 'plan', details: { commit_subject: 'fix(crew): subject', issues: [679, '#758', 679] } },
    builderEnv: { details: { commit_message: 'body text' } },
  })
  assert.equal(today, 'fix(crew): subject\n\nbody text\n\nRefs: #679, #758')
  const closing = composeCommitMessage({
    task: 'x', planEnv: { summary: 'plan', details: { commit_subject: 'fix(crew): subject', issues: [679, 806], closes: [806] } },
    builderEnv: { details: { commit_message: 'body text' } },
  })
  assert.equal(closing, 'fix(crew): subject\n\nbody text\n\nCloses: #806\n\nRefs: #679')
})

test('narratorApiRoot normalises every base_url spelling to exactly one API root', () => {
  assert.equal(narratorApiRoot('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.equal(narratorApiRoot('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1')
  assert.equal(narratorApiRoot('http://desk.lan:1234'), 'http://desk.lan:1234/v1')
  assert.equal(narratorApiRoot('http://desk.lan:1234/'), 'http://desk.lan:1234/v1')
  for (const spelling of ['http://127.0.0.1:11434/v1', 'http://desk.lan:1234']) {
    const collect = []
    narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER(spelling), io: narratorIo({ collect }) })
    assert.equal(collect.length, 2, spelling)
    assert.equal(collect.some((command) => command.includes('/v1/v1')), false, spelling)
    assert.equal(collect.filter((command) => /\/v1\/models/.test(command)).length, 1, spelling)
    assert.equal(collect.filter((command) => /\/v1\/chat\/completions/.test(command)).length, 1, spelling)
  }
  assert.ok(narratorModelsCommand('http://desk.lan:1234/v1').includes('http://desk.lan:1234/v1/models'))
})

test('narratorModelId accepts exactly one id and names zero and several differently', () => {
  assert.deepEqual(narratorModelId(JSON.stringify({ data: [{ id: 'qwen3-coder' }] })), { id: 'qwen3-coder' })
  assert.deepEqual(narratorModelId(JSON.stringify({ data: [{ id: 'q' }, { id: 'q' }] })), { id: 'q' })
  assert.equal(narratorModelId(JSON.stringify({ data: [] })).refused, NARRATION_REFUSALS.modelAbsent)
  assert.equal(narratorModelId(JSON.stringify({ data: [{ id: '  ' }] })).refused, NARRATION_REFUSALS.modelAbsent)
  assert.equal(narratorModelId(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })).refused, NARRATION_REFUSALS.modelAmbiguous)
  assert.equal(narratorModelId('not json').refused, NARRATION_REFUSALS.modelsUnreadable)
  assert.equal(narratorModelId(JSON.stringify({ data: 'nope' })).refused, NARRATION_REFUSALS.modelsUnreadable)
  assert.notEqual(NARRATION_REFUSALS.modelAbsent, NARRATION_REFUSALS.modelAmbiguous)
  for (const name of Object.values(NARRATION_REFUSALS)) assert.ok(NARRATION_REFUSAL_NAMES.includes(name), name)
})

test('narrateRecord narrates from an honest endpoint and never sends pi_provider as the model', () => {
  const collect = []
  const accepted = narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://127.0.0.1:11434/v1'), io: narratorIo({ collect }) })
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.text, HONEST_NARRATION)
  assert.equal(accepted.model, 'qwen3-coder')
  const chat = collect.find((command) => command.includes('/chat/completions'))
  assert.ok(chat.includes('qwen3-coder'))
  assert.equal(/"model":"local-pi"/.test(chat), false)
  assert.ok(chat.startsWith('curl -sS --max-time 30 -X POST'))
  // the prompt is the record and nothing else
  const prompt = narrationPrompt(NARRATION_RECORD)
  assert.ok(prompt.includes(JSON.stringify(NARRATION_RECORD)))
  assert.ok(prompt.includes('you have not seen the diff or the checkout'))
})

test('every narration failure is a named refusal and never a throw', () => {
  const ask = (options) => narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://desk.lan:1234'), io: narratorIo(options) })
  const cases = [
    [{ models: { ok: false, output: 'connection refused' } }, NARRATION_REFUSALS.unreachable],
    [{ models: { ok: true, output: 'not json' } }, NARRATION_REFUSALS.modelsUnreadable],
    [{ models: { ok: true, output: JSON.stringify({ data: [] }) } }, NARRATION_REFUSALS.modelAbsent],
    [{ models: { ok: true, output: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) } }, NARRATION_REFUSALS.modelAmbiguous],
    [{ chat: { ok: false, output: 'gone' } }, NARRATION_REFUSALS.unreachable],
    [{ chat: { ok: true, output: '{}' } }, NARRATION_REFUSALS.unreadable],
    [{ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content: '{"total":11}' } }] }) } }, NARRATION_REFUSALS.rawJson],
    [{ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content: 'It rewrote src/vendor/blob.' } }] }) } }, NARRATION_REFUSALS.unknownFact],
  ]
  for (const [options, reason] of cases) {
    let out
    assert.doesNotThrow(() => { out = ask(options) }, JSON.stringify(options))
    assert.equal(out.text, undefined, reason)
    assert.equal(out.refused, reason)
  }
  let threw
  assert.doesNotThrow(() => { threw = narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://desk.lan:1234'), io: { run: () => { throw new Error('EPERM') } } }) })
  assert.equal(threw.refused, NARRATION_REFUSALS.unreachable)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: '{"local_providers":{}}', io: narratorIo() }).refused, NARRATION_REFUSALS.unconfigured)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: 'not json', io: narratorIo() }).refused, NARRATION_REFUSALS.unconfigured)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('file:///etc/passwd'), io: narratorIo() }).refused, NARRATION_REFUSALS.endpointUnsafe)
  assert.equal(narrateRecord({ record: NARRATION_RECORD, registerText: NARRATOR_REGISTER('http://u:p@desk.lan:1234'), io: narratorIo() }).refused, NARRATION_REFUSALS.endpointUnsafe)
})

test('the narration stage guard refuses an unknown token and an absent plain stage head', () => {
  const record = { stages: ['plan:r1', 'build:r1', 'lane:r1', 'review:r1', 'commit', 'publish'] }
  // (a) an unknown colon-shaped token
  assert.equal(narrationStageDefect('The lane ran audit:r2 before commit.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('The lane ran review:r2 before commit.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('The lane ran review:r1 before commit.', record), null)
  // (b) a KNOWN plain stage head the record never ran — the hole a colon-only scan left
  for (const absent of ['converge', 'rebase', 'suite', 'scope-gate', 'gate-proof', 'check', 'done']) {
    assert.equal(narrationStageDefect('The lane ran ' + absent + '.', record), NARRATION_REFUSALS.unknownFact, absent)
    assert.ok(NARRATION_STAGE_VOCABULARY.includes(absent), absent)
  }
  for (const present of ['plan', 'build', 'review', 'commit', 'publish', 'lane']) {
    assert.equal(narrationStageDefect('The lane ran ' + present + '.', record), null, present)
  }
  // The vocabulary is the driver's, not English: `lane` IS a stage head, so a narration
  // saying "the lane" against a record that never journaled one is refused. Strictness
  // costs nothing — a refusal drops the narration and publishes the code-composed body.
  assert.equal(narrationStageDefect('The lane did well.', { stages: ['plan:r1'] }), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationStageDefect('It went well.', { stages: ['plan:r1'] }), null)
  // a head embedded in a longer word is not a stage name
  assert.equal(narrationStageDefect('It ran 11 gate checks and rebased cleanly.', { stages: ['plan:r1', 'gate:r1'] }), null)
  // the vocabulary is the driver's own declarations, closed and sorted
  assert.equal(Object.isFrozen(NARRATION_STAGE_VOCABULARY), true)
  for (const head of VARIANTS.full.stages) assert.ok(NARRATION_STAGE_VOCABULARY.includes(head), head)
  assert.ok(NARRATION_STAGE_VOCABULARY.includes('done'))
  assert.ok(NARRATION_STAGE_VOCABULARY.includes('escalate'))
  // narrationDefect routes through the one shared predicate
  assert.equal(narrationDefect('The lane ran converge.', record), NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationDefect('The lane ran publish.', record), null)
})

test('raw-JSON narration is refused by its own name even when every number is a record fact', () => {
  assert.equal(narrationIsRawJson('{"gate":{"total":11},"build_round":2}'), true)
  assert.equal(narrationIsRawJson('The lane took 2 build rounds.'), false)
  const refused = narrationDefect('{"gate":{"total":11},"build_round":2}', NARRATION_RECORD)
  assert.equal(refused, NARRATION_REFUSALS.rawJson)
  assert.notEqual(refused, NARRATION_REFUSALS.unknownFact)
  assert.equal(narrationDefect(HONEST_NARRATION, NARRATION_RECORD), null)
})

test('applyNarration transfers accepted narration only, and never mutates its input', () => {
  const record = { ...NARRATION_RECORD }
  assert.equal(applyNarration(record, { text: HONEST_NARRATION }).narrative, HONEST_NARRATION)
  assert.equal('narrative' in record, false)
  for (const narrated of [undefined, null, {}, { refused: NARRATION_REFUSALS.unreachable }, { text: '' }, { text: '   ' }]) {
    assert.equal('narrative' in applyNarration(record, narrated), false, JSON.stringify(narrated))
  }
  assert.equal(applyNarration(record, { text: '  ' + HONEST_NARRATION + '  ' }).narrative, HONEST_NARRATION)
})

test('a published run prepends the local narrative and leaves the code-composed facts byte-identical', () => {
  const narratorCommands = {
    'curl -sS --max-time 15': { ok: true, output: JSON.stringify({ data: [{ id: 'qwen3-coder' }] }) },
    'curl -sS --max-time 30 -X POST': { ok: true, output: JSON.stringify({ choices: [{ message: { content: 'The lane ran 2 build rounds.' } }] }) },
  }
  const register = NARRATOR_REGISTER('http://127.0.0.1:11434/v1')
  const narrated = runPublished({ capabilities: register, commands: narratorCommands })
  assert.equal(narrated.result.status, 'done')
  const narratedBody = narrated.io.calls.writes[TD + '/pr-body.md']
  assert.ok(narratedBody.startsWith(NARRATION_HEADING + '\nThe lane ran 2 build rounds.\n\n'), JSON.stringify(narratedBody.slice(0, 140)))
  const row = narrated.io.calls.logs.find((entry) => entry.narration)
  assert.deepEqual(row.narration, { outcome: 'accepted', chars: 'The lane ran 2 build rounds.'.length, model: 'qwen3-coder' })

  // a dead endpoint publishes exactly the no-narrator body — byte for byte
  const dead = runPublished({ capabilities: register, commands: { 'curl -sS --max-time 15': { ok: false, output: 'connection refused' } } })
  const none = runPublished({})
  const deadBody = dead.io.calls.writes[TD + '/pr-body.md']
  const noneBody = none.io.calls.writes[TD + '/pr-body.md']
  assert.equal(deadBody, noneBody)
  assert.ok(narratedBody.endsWith(deadBody))
  assert.equal(dead.result.status, 'done')
  assert.equal(dead.io.calls.logs.find((entry) => entry.narration).narration.outcome, 'refused')
  assert.equal(noneBody.includes(NARRATION_HEADING), false)
  assert.equal(none.io.calls.logs.find((entry) => entry.narration).narration.reason, NARRATION_REFUSALS.unconfigured)
})

test('journal boundaries and anomaly extraction are deterministic and tolerate malformed arrays', () => {
  const text = [
    JSON.stringify({ event: RUN_START_EVENT }), JSON.stringify({ event: 'wait-extended', id: 'old' }),
    JSON.stringify({ event: RUN_START_EVENT }), JSON.stringify({ event: 'wait-extended', role: 'builder', id: 'd7', idle_s: 2, extension_s: 3 }),
  ].join('\n')
  assert.deepEqual(journalRowsSinceRunStart(text).map((row) => row.id), ['d7'])
  const rows = [
    { event: 'wait-extended', role: 'builder', id: 'd7', idle_s: 2, extension_s: 3 },
    { stage: 'gate-repair:1' }, { decision: 'bounce-builder', reason: 'try again' },
    { event: 'tree-witness', outcome: 'modified', modified: ['a.mjs'], removed: [], added: [] },
    { event: 'tree-witness', outcome: 'unknown', modified: 'not-an-array', removed: null, added: {} },
  ]
  const anomalies = prAnomalies(rows)
  assert.equal(anomalies.length, 5)
  assert.match(anomalies[0].detail, /builder d7 idle 2s, extended 3s/)
  assert.equal(anomalies[1].detail, 'gate-repair:1')
  assert.match(anomalies[2].detail, /^builder — try again$/)
  // the BARE `bounce` a consult offering ['bounce','escalate'] records names no seat,
  // so the row must carry no dangling separator either
  assert.equal(bounceSeatOf('bounce'), '')
  assert.equal(bounceSeatOf('bounce-reviewer'), 'reviewer')
  assert.equal(bounceDetail('bounce', 'try again'), 'try again')
  assert.equal(bounceDetail('bounce-builder', 'try again'), 'builder — try again')
  assert.equal(bounceDetail('bounce', ''), '')
  assert.equal(prAnomalies([{ decision: 'bounce', reason: 'try again' }])[0].detail, 'try again')
  const bare = composePrBody({ anomalies: prAnomalies([{ decision: 'bounce', reason: 'try again' }]) })
  assert.equal(bare.split('\n').find((line) => line.startsWith('- bounce')), '- bounce: try again')
  assert.match(anomalies[3].detail, /modified a.mjs/)
  assert.doesNotThrow(() => prAnomalies(rows))
  assert.deepEqual(prAnomalies({}), [])
})

test('parseSuiteCounts handles TAP, default reporter, ANSI, and last-summary precedence', () => {
  assert.deepEqual(parseSuiteCounts('# pass 2\n# fail 1\n# skipped 3\n'), { pass: 2, fail: 1, skipped: 3 })
  assert.deepEqual(parseSuiteCounts('ℹ pass 4\nℹ fail 0\nℹ skipped 1\n'), { pass: 4, fail: 0, skipped: 1 })
  assert.deepEqual(parseSuiteCounts('\x1b[32m# pass 5\x1b[0m\n\x1b[31m# fail 0\x1b[0m\n'), { pass: 5, fail: 0, skipped: 0 })
  assert.deepEqual(parseSuiteCounts('# pass 1\n# fail 9\n# pass 2910\n# fail 0\n# skipped 4\n'), { pass: 2910, fail: 0, skipped: 4 })
  assert.equal(parseSuiteCounts('# pass 1\n'), null)
})

test('an armed run refuses green suites whose publication counts are unmeasured', () => {
  const warm = runPublished({ warm: '' })
  assert.equal(warm.result.status, 'escalation')
  assert.equal(warm.result.details.escalation.where, 'suite')
  const cold = runPublished({ coldOutput: '' })
  assert.equal(cold.result.status, 'escalation')
  assert.equal(cold.result.details.escalation.where, 'cold-suite')
  assert.equal(cold.result.details.commit, cold.io.state.post)
})

test('plan-check accept residuals survive into the single driver-written publication body', () => {
  const residual = { id: 'PC1-9', type: 'cosmetic', summary: 'phase table remains for the sibling lane' }
  const io = publicationIo({ envelopes: {
    'planner:1': planEnv(),
    'tech-lead:1': checkEnv('revise'),
    'lead:1': leadEnv('accept', '', { residuals: [residual] }),
    'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass'),
  } })
  const ctx = {
    ...CTX, roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'],
    task: 'plan-accept', journal: `${TD}/journal.jsonl`, limits: { plan_rounds: 1 },
    publish: { branch: 'feature/plan-accept' },
  }
  const result = driveTask(ctx, io)
  assert.equal(result.status, 'done')
  assert.match(io.calls.writes[`${TD}/pr-body.md`], /PC1-9 \(cosmetic\): phase table remains for the sibling lane/)
})

test('refsFromCommitMessage reads the trailer in order, de-duplicates, and stays empty without one', () => {
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody\n\nRefs: #679, #758, #679'), ['#679', '#758'])
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody'), [])
})

test('an unarmed context retains the legacy local finish without rebase or publication stages', () => {
  const io = closeoutIo()
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.stages.includes('rebase'), false)
  assert.equal(result.details.stages.includes('publish'), false)
  assert.deepEqual(io.calls.run.map(({ cmd }) => cmd), ['lane-cmd', 'suite-cmd'])
})

// #800 §7b — permanent regression coverage for reviewer finding dispositions.
// The acceptance gate exercises these paths once; these tests keep their evidence in
// the checkout that every future `npm test` run actually executes.
const D_HUNK = (path) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  '-const x = 1',
  '+const x = 2',
]
const D_PATCH_A = [...D_HUNK('a.mjs'), ''].join('\n')
const D_PATCH_B = [...D_HUNK('b.mjs'), ''].join('\n')
const D_PATCH_MIXED_MODE = [...D_HUNK('a.mjs'), 'diff --git a/b.mjs b/b.mjs', 'old mode 100644', 'new mode 100755', ''].join('\n')
const D_PATCH_MIXED_RENAME = [
  ...D_HUNK('a.mjs'),
  'diff --git a/a.test.mjs b/b.mjs',
  'similarity index 96%',
  'rename from a.test.mjs',
  'rename to b.mjs',
  '--- a/a.test.mjs',
  '+++ b/b.mjs',
  '@@ -1 +1 @@',
  '-const y = 1',
  '+const y = 2',
  '',
].join('\n')
const D_PATCH_EMPTY_PATH = ['diff --git a/ b/', '--- a/', '+++ b/', '@@ -1 +1 @@', '-const x = 1', '+const x = 2', ''].join('\n')
const D_GREEN_GATE = `green\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":0,"errored":0}`
const D_RED_GATE = (marker) => `${marker}\n${GATE_SUMMARY_PREFIX} {"total":3,"failed":3,"errored":0}`
const D_AUTO = { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'a dead import survives', disposition: 'auto-fix', patch: D_PATCH_A, hardening: 'ungateable', hardening_why: 'legacy disposition fixture' }
const D_ASK = { id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'the change narrows the public contract', disposition: 'ask-user', hardening: 'ungateable', hardening_why: 'legacy disposition fixture' }
const D_PANEL_CTX = Object.freeze({ ...CTX_TL, continuation: true })

const dPlanEnv = (details = {}) => planEnv({ details: { ...planEnv().details, ...details } })
const dReviewEnv = (verdict, findings, counts = {}) => {
  const normalized = findings === undefined ? undefined : (Array.isArray(findings) ? findings : [findings])
  const base = reviewEnv(verdict, normalized)
  return { ...base, details: { ...base.details, ...counts } }
}
const dPartnerEnv = (verdict, findings) => ({ status: 'done', role: 'tech-lead', details: { verdict, findings } })
const dAdjEnv = (details = {}) => ({ status: 'done', role: 'lead', details: { adjudications: [], class_invariant: 'class', closes_class: true, ...details } })
const dGitApplies = (io) => io.calls.run.filter(({ cmd }) => /^git apply /.test(cmd))
const dBuilders = (io) => io.calls.assign.filter(({ role }) => role === 'builder')
const dLeads = (io) => io.calls.assign.filter(({ role }) => role === 'lead')
const dAutoRows = (io) => io.calls.logs.map((row) => row.auto_fix).filter(Boolean)
const dDecisionBrief = (io) => Object.entries(io.calls.writes).find(([path]) => /\/decision-\d+\.md$/.test(path))?.[1] || ''
const dOffers = (brief, option) => brief.split('\n').some((line) => line.trim() === `- ${option}`)
const dPatchWrite = (io) => Object.entries(io.calls.writes).find(([path]) => /\/auto-fix-r\d+-.*\.patch$/.test(path))
const dApplyCommand = (id, round = 1) => `git apply --whitespace=nowarn ${shellArg(`${TD}/auto-fix-r${round}-${id}.patch`)}`

function dispositionIo(findings, {
  verdict = 'changes-needed', plan = {}, runs = {}, changed = ['a.mjs', 'a.test.mjs'],
  leadDecision = 'escalate', reviewer2 = dReviewEnv('pass', []), reviewer3 = dReviewEnv('pass', []),
  builder1 = buildEnv(), builder2 = buildEnv(), builder3 = buildEnv(), files = {}, writeThrough = false,
} = {}) {
  return fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(plan),
      'builder:1': builder1, 'builder:2': builder2, 'builder:3': builder3,
      'reviewer:1': dReviewEnv(verdict, findings), 'reviewer:2': reviewer2, 'reviewer:3': reviewer3,
      'lead:1': leadEnv(leadDecision), 'lead:2': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' }, ...runs },
    changed, files, writeThrough,
  })
}

function dispositionPanelIo({
  reviewer1, partner1, adjudication1 = dAdjEnv(), reviewer2 = dReviewEnv('pass', []),
  partner2 = dPartnerEnv('pass', []), adjudication2 = dAdjEnv(), lead3 = leadEnv('escalate'),
  builder1 = buildEnv(), builder2 = buildEnv(), builder3 = buildEnv(),
  runs = {}, changed = ['a.mjs', 'a.test.mjs'], files = {}, writeThrough = false, throwOn = null,
} = {}) {
  return fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(), 'tech-lead:1': checkEnv('approve'),
      'builder:1': builder1, 'builder:2': builder2, 'builder:3': builder3,
      'reviewer:1': reviewer1, 'tech-lead:2': partner1, 'lead:1': adjudication1,
      'reviewer:2': reviewer2, 'tech-lead:3': partner2, 'lead:2': adjudication2,
      'reviewer:3': dReviewEnv('pass', []), 'tech-lead:4': dPartnerEnv('pass', []), 'lead:3': lead3,
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' }, ...runs },
    changed, files, writeThrough, throwOn,
  })
}

test('#800 §7b 1 — verdictFindingsDefect refuses raw pass must-fixes', () => {
  const mustFix = { id: 'RV1-1', severity: 'must-fix' }
  assert.equal(verdictFindingsDefect({ verdict: 'pass', findings: [mustFix] })?.reason, 'verdict-findings')
  assert.equal(verdictFindingsDefect({ verdict: 'approve', must_fix: 2 })?.reason, 'verdict-findings')
  assert.equal(verdictFindingsDefect({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }] }), null)
  assert.equal(verdictFindingsDefect({ verdict: 'changes-needed', findings: [mustFix] }), null)
  const duplicate = { verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }, mustFix] }
  assert.deepEqual(reviewFindings(duplicate).findings.map(({ severity }) => severity), ['should-fix'])
  assert.equal(verdictFindingsDefect(duplicate)?.reason, 'verdict-findings')
})

test('#800 §7b 2 — reviewer envelope refusals are closed and shape-owned', () => {
  assert.ok(ENVELOPE_REFUSAL_REASONS.includes('verdict-findings'))
  assert.ok(ENVELOPE_REFUSAL_REASONS.includes('finding-id'))
  const envelope = (details) => ({ status: 'done', role: 'reviewer', summary: 'reviewed', artifacts: [], details })
  assert.equal(envelopeDefect(envelope({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'must-fix' }] }), VARIANTS.full, { taskDir: TD })?.reason, 'verdict-findings')
  assert.equal(envelopeDefect(envelope({ verdict: 'changes-needed', findings: [{ id: '../../escape', severity: 'must-fix' }] }), VARIANTS.full, { taskDir: TD })?.reason, 'finding-id')
})

test('#800 §7b 3 — a refused pass must-fix re-asks the reviewer at the free round', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
      'lead:1': leadEnv('bounce'), 'reviewer:2': dReviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('review')), ['review:r1', 'review:r1', 'review:pass'])
  assert.equal(io.calls.logs.find((row) => row.review_round?.refused)?.review_round.refused, 'verdict-findings')
})

test('#800 §7b 4 — a refused pass must-fix escalates at review when the lead declines a re-ask', () => {
  const io = dispositionIo([{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 5 — a refused pass must-fix never becomes canonical accept findings', () => {
  const io = dispositionIo([{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.details.accept_findings, null)
})

test('#800 §7b 6 — a refused ask-user finding reaches only the reviewer-refusal consult', () => {
  const io = dispositionIo([{ ...D_ASK, verdict: undefined }], { verdict: 'pass', leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'done')
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'escalate'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
  assert.equal(io.calls.writes[`${TD}/build-bounce-r1.md`], undefined)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
})

test('#800 §7b 7 — a continuation panel refuses pass must-fix before assigning panel seats', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': dPlanEnv(), 'tech-lead:1': checkEnv('approve'), 'builder:1': buildEnv(),
      'reviewer:1': dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
      'lead:1': leadEnv('escalate'),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(D_PANEL_CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.commits.length, 0)
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
})

test('#800 §7b 8 — an unreadable verdict cannot execute ask-user routing', () => {
  const io = dispositionIo([D_ASK], { verdict: 'not-a-verdict' })
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review')
  assert.equal(dOffers(brief, 'bounce'), true)
  assert.equal(dOffers(brief, 'bounce-builder'), false)
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 9 — disposition parsing routes only accepted declared values', () => {
  for (const declared of FINDING_DISPOSITIONS) assert.equal(dispositionOf({ disposition: declared }), declared)
  assert.equal(dispositionOf({ disposition: 'surprise' }), null)
  const routed = dispositionPlan({
    findings: [
      { id: 'auto', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'seat', severity: 'must-fix', disposition: 'auto-fix' },
      { id: 'ask', severity: 'should-fix', location: 'a.mjs:2', summary: 'human choice', disposition: 'ask-user' },
      { id: 'noop', severity: 'must-fix', disposition: 'no-op' },
    ],
  })
  assert.deepEqual(routed.autoFix, [{ id: 'auto', severity: 'must-fix', patch: D_PATCH_A }])
  assert.deepEqual(routed.askUser, [{ id: 'ask', severity: 'should-fix', location: 'a.mjs:2', summary: 'human choice' }])
  assert.deepEqual(routed.needsSeat, ['seat'])
  const hostile = dispositionPlan({
    findings: [
      { id: 'same', severity: 'blocker', disposition: 'auto-fix', patch: D_PATCH_B },
      { id: 'same', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'duplicate', severity: 'must-fix', disposition: 'auto-fix', patch: D_PATCH_A },
      { id: 'duplicate', severity: 'must-fix', disposition: 'ask-user', patch: D_PATCH_B },
    ],
  })
  assert.deepEqual(hostile.autoFix.map(({ id, patch }) => ({ id, patch })), [{ id: 'same', patch: D_PATCH_A }, { id: 'duplicate', patch: D_PATCH_A }])
  assert.deepEqual(hostile.askUser, [])
})

test('#800 §7b 10 — acceptedRawById mirrors reviewFindings acceptance order', () => {
  const details = {
    findings: [
      { id: 'second', severity: 'blocker', patch: 'rejected' },
      { id: 'second', severity: 'must-fix', patch: 'accepted-second' },
      { id: 'first', severity: 'must-fix', patch: 'accepted-first' },
      { id: 'first', severity: 'should-fix', patch: 'duplicate' },
      { severity: 'must-fix', patch: 'missing-id' },
    ],
  }
  const accepted = acceptedRawById(details)
  assert.equal(accepted.get('second').patch, 'accepted-second')
  assert.equal(accepted.get('first').patch, 'accepted-first')
  assert.equal(accepted.has(undefined), false)
  assert.deepEqual([...accepted.keys()], reviewFindings(details).findings.map(({ id }) => id))
})

test('#800 §7b 11 — ordinary confused-deputy findings apply only accepted patch bytes', () => {
  const io = dispositionIo([
    { id: 'RV1-1', severity: 'blocker', location: 'b.mjs:1', summary: 'rejected', disposition: 'auto-fix', patch: D_PATCH_B },
    { ...D_AUTO, summary: 'accepted' },
  ])
  const result = driveTask(CTX, io)
  const written = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(written.includes('a/a.mjs'), true)
  assert.equal(written.includes('a/b.mjs'), false)
})

test('#800 §7b 12 — panel confused-deputy findings apply only accepted patch bytes', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [
      { id: 'RV1-1', severity: 'blocker', location: 'b.mjs:1', summary: 'rejected', disposition: 'auto-fix', patch: D_PATCH_B },
      { ...D_AUTO, summary: 'accepted' },
    ]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'accepted' }]),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const written = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(written.includes('a/a.mjs'), true)
  assert.equal(written.includes('a/b.mjs'), false)
})

test('#800 §7b 13 — patchTargets fails closed for every unreadable section form', () => {
  assert.deepEqual(patchTargets(D_PATCH_A), { targets: ['a.mjs'], refusal: null })
  const created = patchTargets(['diff --git a/new.mjs b/new.mjs', '--- /dev/null', '+++ b/new.mjs', '@@ -0,0 +1 @@', '+x', ''].join('\n'))
  assert.deepEqual(created, { targets: ['new.mjs'], refusal: null })
  const deleted = patchTargets(['diff --git a/old.mjs b/old.mjs', '--- a/old.mjs', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n'))
  assert.deepEqual(deleted, { targets: ['old.mjs'], refusal: null })
  const cases = [
    'diff --git a/x b/x\n--- /dev/null\n+++ /dev/null\n',
    `diff --git a/x b/y\nrename from x\nrename to y\n--- a/x\n+++ b/y\n`,
    `diff --git a/x b/y\ncopy from x\ncopy to y\n--- a/x\n+++ b/y\n`,
    'diff --git a/x b/x\nGIT binary patch\n',
    'diff --git a/x b/x\n--- "a/x"\n+++ "b/x"\n',
    'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n',
    D_PATCH_EMPTY_PATH,
    D_PATCH_MIXED_MODE,
    `noise before diff\n${D_PATCH_A}`,
  ]
  for (const patch of cases) {
    const parsed = patchTargets(patch)
    assert.ok(parsed.refusal, patch)
    assert.deepEqual(parsed.targets, [], patch)
  }
})

test('#800 §7b 14 — one safe auto-fix applies with no second builder seat', () => {
  const io = dispositionIo(D_AUTO)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(dBuilders(io).length, 1)
  assert.equal(io.calls.assign.length, 4)
  assert.equal(io.calls.commits.length, 1)
  assert.deepEqual(dAutoRows(io)[0], { round: 1, total: 1, applied: ['RV1-1'], refused: [] })
})

test('#800 §7b 15 — an out-of-scope auto-fix is refused and reaches a builder', () => {
  const io = dispositionIo({ ...D_AUTO, location: 'b.mjs:1', patch: D_PATCH_B })
  const result = driveTask(CTX, io)
  const refused = dAutoRows(io)[0]?.refused || []
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 0)
  assert.match(refused.find(({ id }) => id === 'RV1-1')?.why || '', /b\.mjs/)
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 16 — one unreadable section refuses a mixed patch as a whole', () => {
  for (const patch of [D_PATCH_MIXED_RENAME, D_PATCH_MIXED_MODE]) {
    const io = dispositionIo({ ...D_AUTO, patch })
    const result = driveTask(CTX, io)
    assert.equal(result.status, 'done')
    assert.equal(dGitApplies(io).length, 0)
    assert.equal(dAutoRows(io)[0]?.applied.length, 0)
    assert.equal(dAutoRows(io)[0]?.refused.length, 1)
  }
})

test('#800 §7b 17 — git apply refusal is journalled and falls back to a builder', () => {
  const io = dispositionIo(D_AUTO, { runs: { [dApplyCommand('RV1-1')]: { ok: false, output: 'APPLY-RED-MARKER' } } })
  const result = driveTask(CTX, io)
  const refused = dAutoRows(io)[0]?.refused.find(({ id }) => id === 'RV1-1')
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.match(refused?.why || '', /APPLY-RED-MARKER/)
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 18 — post-apply lane red is re-run verbatim and cannot commit that round', () => {
  const io = dispositionIo(D_AUTO, {
    runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } },
    reviewer2: dReviewEnv('changes-needed'),
  })
  const result = driveTask(CTX, io)
  const laneCalls = io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd')
  assert.equal(result.status, 'escalation')
  assert.ok(laneCalls.length >= 2)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /LANE-RED-MARKER/)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 19 — post-apply acceptance-gate red bounces without re-proving pristine discrimination', () => {
  const gate = 'disposition-gate-cmd'
  const io = dispositionIo(D_AUTO, {
    plan: { gate_cmd: gate },
    runs: {
      [`${gate}:1`]: { ok: false, output: D_RED_GATE('baseline red') },
      [gate]: { ok: true, output: D_GREEN_GATE },
      [`${gate}:3`]: { ok: false, output: D_RED_GATE('GATE-RED-MARKER') },
    },
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 1, gate_fails_to_triage: 9 } }, io)
  assert.equal(result.status, 'escalation')
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /GATE-RED-MARKER/)
  assert.equal(io.calls.commits.length, 0)
  // baseline, built tree, post-apply revalidation, then the rebound build: no
  // extra pristine/discrimination invocation is introduced after the patch.
  assert.deepEqual(io.calls.run.filter(({ cmd }) => cmd === gate).map(({ n }) => n), [1, 2, 3, 4])
})

test('#800 §7b 20 — post-apply scope red bounces without a commit', () => {
  const io = dispositionIo(D_AUTO, {
    changed: [['a.mjs', 'a.test.mjs'], ['a.mjs', 'b.mjs'], ['a.mjs', 'a.test.mjs']],
    reviewer2: dReviewEnv('changes-needed'),
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', /b\.mjs/)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 21 — green scope, lane, and gate revalidation commits with one builder', () => {
  const gate = 'disposition-green-gate'
  const io = dispositionIo(D_AUTO, {
    plan: { gate_cmd: gate },
    runs: {
      [`${gate}:1`]: { ok: false, output: D_RED_GATE('baseline red') },
      [gate]: { ok: true, output: D_GREEN_GATE },
    },
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2, gate_fails_to_triage: 9 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(dBuilders(io).length, 1)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd').length, 2)
})

test('#800 §7b 22 — final post-apply failures either fund one real builder round or escalate by failed check', () => {
  const bounced = dispositionIo(D_AUTO, {
    runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } },
    leadDecision: 'bounce-builder',
  })
  const bouncedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, bounced)
  assert.equal(bouncedResult.status, 'done')
  assert.deepEqual(bouncedResult.details.extra_rounds_granted, [{ where: 'review', round: 1 }])
  assert.equal(dBuilders(bounced).length, 2)

  const escalated = dispositionIo(D_AUTO, { runs: { 'lane-cmd:2': { ok: false, output: 'LANE-RED-MARKER' } } })
  const escalatedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalated)
  assert.equal(escalatedResult.status, 'escalation')
  assert.equal(escalatedResult.details.escalation.where, 'lane')
  assert.equal(dLeads(escalated).length, 1)
  assert.equal(dBuilders(escalated).length, 1)
  assert.equal(escalated.calls.commits.length, 0)
})

test('#800 §7b 23 — changes-needed ask-user findings go to the lead or review-unresolved', () => {
  const io = dispositionIo(D_ASK)
  const result = driveTask(CTX, io)
  const brief = dDecisionBrief(io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.deepEqual(result.details.ask_user, ['RV1-1'])
  assert.equal(dOffers(brief, 'bounce-builder'), true)
  assert.equal(dOffers(brief, 'escalate'), true)
})

test('#800 §7b 24 — pass ask-user findings pause acceptance for the lead', () => {
  const io = dispositionIo({ ...D_ASK, severity: 'should-fix' }, { verdict: 'pass' })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(io).length, 1)
  assert.equal(io.calls.commits.length, 0)
})

test('#800 §7b 25 — a lead bounce carries ask-user guidance verbatim', () => {
  const guidance = 'keep the observable default and update its docs'
  const io = dispositionIo(D_ASK, { leadDecision: 'bounce-builder' })
  io.wait = ((wait) => (path, timeout) => {
    const env = wait(path, timeout)
    if (path === 'lead:1') return leadEnv('bounce-builder', guidance)
    return env
  })(io.wait)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dLeads(io).length, 1)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', new RegExp(guidance))
})

test('#800 §7b 26 — mixed dispositions apply the safe patch and send guidance to a builder', () => {
  const guidance = 'preserve compatibility for the observable option'
  const io = dispositionIo([D_AUTO, { ...D_ASK, id: 'RV1-2' }], { leadDecision: 'bounce-builder' })
  io.wait = ((wait) => (path, timeout) => {
    const env = wait(path, timeout)
    if (path === 'lead:1') return leadEnv('bounce-builder', guidance)
    return env
  })(io.wait)
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(dLeads(io).length, 1)
  assert.match(io.calls.writes[`${TD}/build-bounce-r1.md`] || '', new RegExp(guidance))
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 27 — a mixed-disposition lead escalation applies nothing', () => {
  const io = dispositionIo([D_AUTO, { ...D_ASK, id: 'RV1-2' }])
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'review-unresolved')
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 28 — a final ask-user round has one funded bounce or one unresolved escalation', () => {
  const bounced = dispositionIo(D_ASK, { leadDecision: 'bounce-builder' })
  const bouncedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, bounced)
  assert.equal(bouncedResult.status, 'done')
  assert.deepEqual(bouncedResult.details.extra_rounds_granted, [{ where: 'review', round: 1 }])
  assert.equal(dLeads(bounced).length, 1)
  assert.equal(dBuilders(bounced).length, 2)

  const escalated = dispositionIo(D_ASK)
  const escalatedResult = driveTask({ ...CTX, limits: { build_rounds: 1 } }, escalated)
  assert.equal(escalatedResult.status, 'escalation')
  assert.equal(escalatedResult.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(escalated).length, 1)
  assert.equal(dBuilders(escalated).length, 1)
})

test('#800 §7b 29 — a panel pass must-fix refusal re-asks reviewer A before any panel work', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('bounce'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const firstLead = io.calls.assign.findIndex(({ role }) => role === 'lead')
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.slice(0, firstLead).some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'verdict-findings'), true)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('review')), ['review:r1', 'review:panel-r1', 'review:r1', 'review:panel-r1', 'review:pass'])
})

test('#800 §7b 30 — upheld panel reviewer findings retain auto-fix and ask-user routing', () => {
  const auto = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_AUTO]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: D_AUTO.summary }]),
  })
  const autoResult = driveTask(D_PANEL_CTX, auto)
  assert.equal(autoResult.status, 'done')
  assert.equal(dGitApplies(auto).length, 1)

  const ask = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_ASK]),
    partner1: dPartnerEnv('changes-needed', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: D_ASK.summary }]),
    adjudication2: leadEnv('escalate'),
  })
  const askResult = driveTask(D_PANEL_CTX, ask)
  assert.equal(askResult.status, 'escalation')
  assert.equal(askResult.details.escalation.where, 'review-unresolved')
  assert.equal(dLeads(ask).length, 2)
})

test('#800 §7b 31 — dismissed panel auto-fixes never execute', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_AUTO]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: dAdjEnv({ adjudications: [{ id: 'RV1-1', disposition: 'dismiss', reason: 'not a defect' }] }),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'done')
  assert.equal(dGitApplies(io).length, 0)
})

test('#800 §7b 32 — panel canonical findings are patch-free and match their journal outcome', () => {
  const auto = { ...D_AUTO, id: 'RV1-1', severity: 'should-fix' }
  const ask = { ...D_ASK, id: 'RV1-2' }
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [auto, ask]),
    partner1: dPartnerEnv('changes-needed', [
      { id: 'TL-1', severity: 'should-fix', location: 'a.mjs:1', summary: auto.summary },
      { id: 'TL-2', severity: 'must-fix', location: 'a.mjs:1', summary: ask.summary },
    ]),
    adjudication2: leadEnv('escalate'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  const outcome = io.calls.logs.map((row) => row.review_outcome).find((row) => row?.panel)
  assert.equal(result.status, 'escalation')
  assert.ok(outcome)
  assert.ok(result.details.accept_findings.every((finding) => !Object.hasOwn(finding, 'patch')))
  assert.deepEqual(result.details.accept_findings, outcome.findings)
})

test('#800 §7b 33 — a patch without a disposition preserves legacy pass behavior', () => {
  const without = dispositionIo([], { verdict: 'pass' })
  const withPatch = dispositionIo([{ id: 'RV1-1', severity: 'should-fix', location: 'a.mjs:1', summary: 'legacy', patch: D_PATCH_A }], { verdict: 'pass' })
  const plain = driveTask(CTX, without)
  const legacy = driveTask(CTX, withPatch)
  assert.deepEqual(legacy, plain)
  assert.equal(dGitApplies(withPatch).length, 0)
  assert.equal(dLeads(withPatch).length, 0)
})

test('#800 §7b 34 — the shared charter pin includes disposition and its compatibility window', () => {
  const charter = readFileSync(new URL('./roles/reviewer.md', import.meta.url), 'utf8')
  const block = charter.slice(charter.indexOf('## Envelope details fields'), charter.indexOf('## Perspective assignments'))
  const line = block.match(/"disposition":\s*([^\n]+)/)?.[1]
  assert.ok(line)
  assert.deepEqual([...line.matchAll(/"([^\"]+)"/g)].map((match) => match[1]), [...FINDING_DISPOSITIONS])
  assert.ok(block.includes('`disposition` is OPTIONAL in this release and REQUIRED from the next'))
})

test('#800 §7b 35 — findingIdDefect admits bounded tokens and refuses unsafe raw ids', () => {
  for (const id of ['RV1-1', 'panel-class-3', 'a', 'x'.repeat(64), 'A_b-9']) {
    assert.equal(findingIdDefect({ findings: [{ id, severity: 'must-fix' }] }), null, id)
  }
  for (const id of ['../../escape', 'a/b', 'a.b', '  RV1-1  ', 'a b', 'x'.repeat(65), 'x'.repeat(1000)]) {
    assert.equal(findingIdDefect({ findings: [{ id, severity: 'must-fix' }] })?.reason, 'finding-id', id)
  }
  for (const entry of [{ severity: 'must-fix' }, { id: 1, severity: 'must-fix' }, { id: '  ', severity: 'must-fix' }]) {
    assert.equal(findingIdDefect({ findings: [entry] }), null)
  }
  const long = findingIdDefect({ findings: [{ id: 'x'.repeat(1000), severity: 'must-fix' }] })
  assert.ok(long.why.length < 300)
  assert.match(long.why, /…/)
})

test('#800 §7b 36 — reviewShapeDefect has a stable refusal precedence', () => {
  assert.equal(reviewShapeDefect({ verdict: 'pass', findings: [{ id: '../../escape', severity: 'must-fix' }] })?.reason, 'verdict-findings')
  assert.equal(reviewShapeDefect({ verdict: 'changes-needed', findings: [{ id: '../../escape', severity: 'must-fix' }] })?.reason, 'finding-id')
  assert.equal(reviewShapeDefect({ verdict: 'pass', findings: [{ id: 'RV1-1', severity: 'should-fix' }] }), null)
})

function assertDriverIdRefusal(io, result, id) {
  const firstRound = io.calls.logs.find((row) => row.review_round?.refused)?.review_round
  assert.equal(firstRound?.refused, 'finding-id')
  assert.match(dDecisionBrief(io), /finding-id/)
  assert.equal(dGitApplies(io).length, 0)
  assert.equal(Object.keys(io.calls.writes).some((path) => /\/auto-fix-/.test(path)), false)
  assert.equal(Object.keys(io.calls.writes).some((path) => path.split('/').some((part) => part === '.' || part === '..')), false)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'reviewer').length, 2)
  assert.equal(id.length > 64 || !FINDING_ID_SHAPE.test(id), true)
}

test('#800 §7b 37 — traversal finding ids are refused by name before any artifact path', () => {
  const id = '../../escape'
  const io = dispositionIo({ ...D_AUTO, id }, { leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  assertDriverIdRefusal(io, result, id)
})

test('#800 §7b 38 — thousand-character finding ids are refused before filesystem limits', () => {
  const id = 'x'.repeat(1000)
  const io = dispositionIo({ ...D_AUTO, id }, { leadDecision: 'bounce' })
  const result = driveTask(CTX, io)
  assertDriverIdRefusal(io, result, id)
  assert.equal(Object.keys(io.calls.writes).some((path) => path.split('/').some((part) => Buffer.byteLength(part) > 255)), false)
})

test('#800 §7b 39 — a panel refuses an out-of-shape reviewer-A id before panel assignments', () => {
  const io = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [{ ...D_AUTO, id: '../../escape' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const result = driveTask(D_PANEL_CTX, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.assign.some(({ note }) => note === 'panel-b' || note === 'panel-adjudication'), false)
  assert.equal(io.calls.logs.some((row) => row.panel_skipped === 'finding-id'), true)
  assert.equal(Object.keys(io.calls.writes).some((path) => /\/auto-fix-/.test(path)), false)
})

test('#800 §7b 40 — guardedWrite returns write failures and preserves successful bytes', () => {
  const denied = { writeFile() { throw new Error('EPERM: read-only') } }
  assert.equal(guardedWrite(denied, '/x', 'y'), 'EPERM: read-only')
  const blank = { writeFile() { throw new Error('') } }
  assert.equal(guardedWrite(blank, '/x', 'y'), 'the write threw with no message')
  let received = null
  const ok = { writeFile(path, contents) { received = { path, contents } } }
  assert.equal(guardedWrite(ok, '/x', 'exact bytes'), null)
  assert.deepEqual(received, { path: '/x', contents: 'exact bytes' })
})

function throwAutoFixWrites(io, message = 'ENAMETOOLONG: name too long') {
  const write = io.writeFile
  io.writeFile = (path, contents) => {
    if (/\/auto-fix-.*\.patch$/.test(String(path))) throw new Error(message)
    return write(path, contents)
  }
  return io
}

test('#800 §7b 41 — a failed patch-artifact write is refused and the driver continues', () => {
  const io = throwAutoFixWrites(dispositionIo(D_AUTO))
  let result
  assert.doesNotThrow(() => { result = driveTask(CTX, io) })
  const row = dAutoRows(io)[0]
  assert.ok(result?.status)
  assert.equal(dGitApplies(io).length, 0)
  assert.deepEqual(row.applied, [])
  assert.match(row.refused.find(({ id }) => id === 'RV1-1')?.why || '', /could not be written/)
  assert.equal(dBuilders(io).length, 2)
})

test('#800 §7b 42 — a failed artifact write cannot take the seat-free revalidation shortcut', () => {
  const io = throwAutoFixWrites(dispositionIo(D_AUTO))
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === 'lane-cmd').length, 1)
  assert.equal(io.calls.logs.some((row) => row.auto_fix_revalidation), false)
  assert.equal(dBuilders(io).length, 1)
})

const D_CLASS_COLLIDING = {
  id: 'panel-class-1', severity: 'should-fix', location: 'a.mjs:1',
  summary: 'a dead import survives', disposition: 'auto-fix', patch: D_PATCH_A,
}
const D_CLASS_PARTNER = { id: 'TL-1', severity: 'should-fix', location: 'a.mjs:1', summary: D_CLASS_COLLIDING.summary }
const D_DIVERGENT_A = { ...D_AUTO, summary: 'reviewer A patch' }
const D_DIVERGENT_PARTNER = { id: 'RV1-1', severity: 'must-fix', location: 'a.test.mjs:1', summary: 'partner finding' }
const D_COLLISION_CTX = Object.freeze({ ...D_PANEL_CTX, limits: { build_rounds: 2, review_rounds: 2 } })
const dPanelOutcomes = (io) => io.calls.logs.map((row) => row.review_outcome).filter((row) => row?.panel)
const dRemintRows = (io) => io.calls.logs.map((row) => row.panel_id_reminted).filter(Boolean)

function legacyPanelProof(io, name) {
  const baseRun = io.run
  io.run = function (cmd) {
    const result = baseRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
    if (cmd === hardenCommand(B376_TEST_FILE, name)) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      const output = [B376_GREEN, B376_PRE_RED, B376_MUT_RED][count - 1] || B376_MUT_RED
      return { ...output, output: output.output.replaceAll('F1 guard', name) }
    }
    return result
  }
  return io
}

function classCollisionIo() {
  return legacyPanelProof(dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_CLASS_COLLIDING]),
    partner1: dPartnerEnv('changes-needed', [D_CLASS_PARTNER]),
    adjudication1: dAdjEnv({ closes_class: false, class_invariant: 'the class is not closed' }),
    builder2: buildEnv({ details: { ...buildEnv().details, hardened: [{ ...B376_HARDENED, finding: 'panel-remint-1', name: 'panel class guard' }] } }),
    files: B376_FILES, writeThrough: true,
  }), 'panel class guard')
}

function divergentCollisionIo() {
  return legacyPanelProof(dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [D_DIVERGENT_A]),
    partner1: dPartnerEnv('changes-needed', [D_DIVERGENT_PARTNER]),
    builder2: buildEnv({ details: { ...buildEnv().details, hardened: [{ ...B376_HARDENED, finding: 'panel-remint-1', name: 'divergent guard' }] } }),
    files: B376_FILES, writeThrough: true,
  }), 'divergent guard')
}

test('#800 §7b 43 — panel class findings remint around a reviewer-origin collision', () => {
  const io = classCollisionIo()
  const result = driveTask(D_COLLISION_CTX, io)
  const first = dPanelOutcomes(io)[0]
  const ids = first.findings.map(({ id }) => id)
  const klass = first.findings.filter(({ severity, reviewer }) => severity === 'must-fix' && reviewer === 'adjudicator')
  assert.equal(result.status, 'done')
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(klass.map(({ id }) => id), ['panel-remint-1'])
  assert.deepEqual(dRemintRows(io), [{ source: 'adjudicator', from: 'panel-class-1', to: 'panel-remint-1' }])
  assert.equal(dBuilders(io).length, 2)
  assert.equal(dGitApplies(io).length, 1)
})

test('#800 §7b 44 — divergent collisions preserve reviewer A ids and route its patch', () => {
  const io = divergentCollisionIo()
  const result = driveTask(D_COLLISION_CTX, io)
  const first = dPanelOutcomes(io)[0]
  const adjudication = io.calls.writes[`${TD}/panel-adjudication-1.md`] || ''
  const patch = dPatchWrite(io)?.[1] || ''
  assert.equal(result.status, 'done')
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'RV1-1' && reviewer === 'reviewer'))
  assert.ok(first.findings.some(({ id, reviewer }) => id === 'panel-remint-1' && reviewer === 'tech-lead'))
  assert.match(adjudication, /panel-remint-1/)
  assert.equal(dGitApplies(io).length, 1)
  assert.equal(patch.includes('a/a.mjs'), true)
})

test('#800 §7b 45 — each reminted final id has one auditable remint join', () => {
  const cases = [
    [classCollisionIo(), 'panel-class-1'],
    [divergentCollisionIo(), 'RV1-1'],
  ]
  for (const [io, original] of cases) {
    const result = driveTask(D_COLLISION_CTX, io)
    assert.equal(result.status, 'done')
    const reminted = dPanelOutcomes(io)[0].findings.filter(({ id }) => id.startsWith('panel-remint-')).map(({ id }) => id)
    const rows = dRemintRows(io)
    assert.deepEqual(reminted, ['panel-remint-1'])
    assert.deepEqual(rows, [{ source: original === 'panel-class-1' ? 'adjudicator' : 'tech-lead', from: original, to: 'panel-remint-1' }])
    assert.equal(rows.every(({ to }) => reminted.includes(to)), true)
  }
})

test('#800 §7b 46 — a pass carrying ask-user and auto-fix records the skipped patch', () => {
  const auto = { ...D_AUTO, severity: 'should-fix' }
  const ask = { ...D_ASK, id: 'RV1-2', severity: 'should-fix' }
  const io = dispositionIo([auto, ask], { verdict: 'pass' })
  const result = driveTask(CTX, io)
  const rows = dAutoRows(io)
  assert.equal(result.status, 'escalation')
  assert.equal(dLeads(io).length, 1)
  assert.equal(dGitApplies(io).length, 0)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].applied, [])
  assert.deepEqual(rows[0].refused, [{ id: 'RV1-1', why: 'a pass verdict is not a fix path — the driver applies a patch only on changes-needed' }])
})

test('#800 §7b 47 — guardedWrite empty-message errors never stringify as Error', () => {
  const blank = { writeFile() { throw new Error('') } }
  assert.equal(guardedWrite(blank, '/x', 'y'), 'the write threw with no message')
})

test('#800 §7b 48 — continuation panels journal the exact shape refusal they saw', () => {
  const idIo = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [{ ...D_AUTO, id: '../../escape' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const idResult = driveTask(D_PANEL_CTX, idIo)
  assert.equal(idResult.status, 'escalation')
  assert.equal(idIo.calls.logs.some((row) => row.panel_skipped === 'finding-id'), true)

  const verdictIo = dispositionPanelIo({
    reviewer1: dReviewEnv('pass', [{ id: 'RV1-1', severity: 'must-fix', location: 'a.mjs:1', summary: 'open' }]),
    partner1: dPartnerEnv('pass', []),
    adjudication1: leadEnv('escalate'),
  })
  const verdictResult = driveTask(D_PANEL_CTX, verdictIo)
  assert.equal(verdictResult.status, 'escalation')
  assert.equal(verdictIo.calls.logs.some((row) => row.panel_skipped === 'verdict-findings'), true)
})


// ─── #843 — a replan may NARROW its dispatched write surface, never WIDEN it ───
// The fixture is the real b359-slotdriver round-2 replan: an 8-path dispatch, and a
// d2 planner envelope that ADDED crew/child.mjs and crew/crew.mjs while shedding the
// two anchor manifests it was fenced to repair. Still 8 entries, which is exactly why
// plan_growth stayed blind to it.
const S843_DISPATCHED = Object.freeze([
  'crew/drive.mjs', 'crew/drive.test.mjs', 'crew/crew.test.mjs', 'crew/daemon.test.mjs',
  'crew/io-contract.test.mjs', 'crew/seat-io-runclean.test.mjs',
  'skills/backend-node/anchors.json', 'skills/crew-recovery/anchors.json',
])
const S843_D2 = Object.freeze([
  'crew/drive.mjs', 'crew/drive.test.mjs', 'crew/crew.test.mjs', 'crew/daemon.test.mjs',
  'crew/io-contract.test.mjs', 'crew/seat-io-runclean.test.mjs',
  'crew/child.mjs', 'crew/crew.mjs',
])
const S843_ADDED = Object.freeze(['crew/child.mjs', 'crew/crew.mjs'])
const S843_DROPPED = Object.freeze(['skills/backend-node/anchors.json', 'skills/crew-recovery/anchors.json'])
const S843_NARROWED = Object.freeze(S843_DISPATCHED.filter((f) => !S843_DROPPED.includes(f)))
const S843_RUNS = { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }
// The dispatch names crew/drive.mjs, a protected path, so the sensitivity floor runs on
// every case here. Satisfy it — a floor refusal would confound every escalation read below.
const s843Reseat = () => ({ applied: true, from: { id: 'build' }, to: { id: 'judge' }, rung: 'mechanical→judge' })
const s843PlanEnv = (files) => planEnv({
  details: {
    plan_path: `${TD}/plan.md`, files_in_scope: Array.isArray(files) ? [...files] : files,
    validation_lane: 'lane-cmd', consult_questions: [], carve_verdict: 'proceed',
  },
})
const s843Io = (envelopes, changed = ['crew/io-contract.test.mjs']) =>
  fakeIo({ envelopes, runs: S843_RUNS, changed, reseat: s843Reseat })
const s843Ctx = (over = {}) => ({
  ...CTX, files_in_scope: [...S843_DISPATCHED],
  limits: { plan_rounds: 1, build_rounds: 2, review_rounds: 2 }, ...over,
})
const s843Rows = (io) => io.calls.logs.filter((row) => row && row.plan_scope).map((row) => row.plan_scope)
const s843PathsIn = (text) => {
  const seen = []
  for (const hit of String(text).match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:mjs|json|md|js|ts)/g) || []) {
    if (!seen.includes(hit)) seen.push(hit)
  }
  return seen
}
// The bullet block under a heading, up to the first blank line. Reading the SECTION and
// not the document is what keeps the two bounce-brief assertions narrow: the refusal
// sentence above the lists also names the added paths.
const s843Bullets = (text, heading) => {
  const lines = String(text).split('\n')
  const at = lines.findIndex((line) => line.includes(heading))
  if (at < 0) return null
  const out = []
  for (let i = at + 1; i < lines.length && lines[i].trim() !== ''; i += 1) {
    if (lines[i].startsWith('- ')) out.push(lines[i].slice(2))
  }
  return out
}

test('planScopeVerdict is pure and names all four states', () => {
  assert.equal(Object.isFrozen(PLAN_SCOPE), true)
  assert.deepEqual(PLAN_SCOPE_VERDICTS, [
    'plan-scope-undispatched', 'plan-scope-same', 'plan-scope-narrowed', 'plan-scope-widened',
  ])
  assert.equal(Object.isFrozen(PLAN_SCOPE_VERDICTS), true)

  // Never compared is a STATE, not a zero: dispatched is null, never 0.
  for (const absent of [undefined, null, [], 'a.mjs']) {
    const v = planScopeVerdict(absent, ['a.mjs'])
    assert.equal(v.verdict, PLAN_SCOPE.undispatched)
    assert.equal(v.dispatched, null)
    assert.deepEqual([v.added, v.dropped], [[], []])
  }

  const same = planScopeVerdict(['a.mjs', 'b.mjs'], ['b.mjs', 'a.mjs'])
  assert.equal(same.verdict, PLAN_SCOPE.same)
  assert.deepEqual([same.added, same.dropped], [[], []])
  assert.deepEqual([same.dispatched, same.planned], [2, 2])

  // A LEGAL directory prefix — crew/ alone is rejected by validateScopeEntries, so the
  // fixture uses a two-segment prefix.
  assert.deepEqual(validateScopeEntries(['crew/roles/']), [])
  const prefix = planScopeVerdict(['crew/roles/'], ['crew/roles/anchors.json'])
  assert.equal(prefix.verdict, PLAN_SCOPE.narrowed)
  assert.deepEqual(prefix.added, [])
  assert.deepEqual(prefix.dropped, ['crew/roles/'])

  const narrowed = planScopeVerdict(S843_DISPATCHED, S843_NARROWED)
  assert.equal(narrowed.verdict, PLAN_SCOPE.narrowed)
  assert.deepEqual(narrowed.dropped, [...S843_DROPPED])
  assert.deepEqual(narrowed.added, [])

  // Widening DOMINATES a simultaneous drop — b359 did both, and the refusal must name
  // the additions.
  const both = planScopeVerdict(S843_DISPATCHED, S843_D2)
  assert.equal(both.verdict, PLAN_SCOPE.widened)
  assert.deepEqual(both.added, [...S843_ADDED])
  assert.deepEqual(both.dropped, [...S843_DROPPED])

  // A non-array planned scope reads as [], never as a throw.
  const none = planScopeVerdict(['a.mjs'], undefined)
  assert.equal(none.verdict, PLAN_SCOPE.narrowed)
  assert.equal(none.planned, 0)
})

test('the b359 round-2 replan is refused at plan acceptance', () => {
  const io = s843Io({ 'planner:1': s843PlanEnv(S843_D2) }, [...S843_D2])
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan-scope-widened')
  assert.equal(result.details.stages.includes('escalate:plan-scope-widened'), true)
  // The planner is never allowed to reach a builder on a widened surface.
  assert.deepEqual(io.calls.assign.map((a) => a.role), ['planner'])
})

test('the widening refusal names exactly the paths that were added', () => {
  const io = s843Io({ 'planner:1': s843PlanEnv(S843_D2) }, [...S843_D2])
  const result = driveTask(s843Ctx(), io)
  const why = result.details.escalation.why
  assert.deepEqual(s843PathsIn(why), [...S843_ADDED])
  assert.match(why, /never widen it/)
  assert.match(why, /on the final plan round there is no revision left to bounce it to/)
})

test('a widening bounces the planner while a plan round remains', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  assert.equal(result.status, 'done')
  const planners = io.calls.assign.filter((a) => a.role === 'planner')
  assert.equal(planners.length, 2)
  assert.equal(planners[1].briefFile, `${TD}/plan-bounce-r1.md`)
})

test('the widening bounce reasons its own assignment', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  assert.deepEqual(io.calls.assign.filter((a) => a.role === 'planner').map((a) => a.note),
    ['plan', 'plan-scope-widened'])
})

test('the scope note is spent on one assignment and does not leak', () => {
  // Three planner rounds: r1 widens and scope-bounces, r2 conforms but the tech-lead
  // says revise, r3 comes from that ORDINARY plan-check bounce and must read
  // plan-revision again. The source-text pin cannot see this — it only proves the
  // override exists, not that it is cleared.
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2),
    'planner:2': s843PlanEnv(S843_NARROWED),
    'planner:3': s843PlanEnv(S843_NARROWED),
    'tech-lead:1': checkEnv('revise'), 'tech-lead:2': checkEnv('approve'),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const ctx = s843Ctx({
    roles: ['lead', 'planner', 'tech-lead', 'builder', 'reviewer'],
    limits: { plan_rounds: 3, build_rounds: 2, review_rounds: 2 },
  })
  driveTask(ctx, io)
  assert.deepEqual(io.calls.assign.filter((a) => a.role === 'planner').map((a) => a.note),
    ['plan', 'plan-scope-widened', 'plan-revision'])
})

test('the widening bounce brief lists the dispatched surface and the additions', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  const bounce = io.calls.writes[`${TD}/plan-bounce-r1.md`]
  assert.equal(typeof bounce, 'string')
  assert.deepEqual(s843Bullets(bounce, 'The dispatched write surface'), [...S843_DISPATCHED])
  assert.deepEqual(s843Bullets(bounce, 'Your files_in_scope added'), [...S843_ADDED])
  assert.match(bounce, /Narrowing it is legal and is recorded, not refused/)
})

test('a widening bounce is accounted as a planner failure upgrade', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  driveTask(s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } }), io)
  const upgrades = io.calls.logs
    .filter((row) => row && row.modifier && row.modifier.modifier === 'failure-upgrade')
    .map((row) => row.modifier.role)
  assert.deepEqual(upgrades, ['planner'])
})

test('a bounce never moves the dispatched baseline', () => {
  // Round 2 is measured against the DISPATCH, not against the plan just refused —
  // otherwise one bounce launders the swap the round exists to correct.
  const io = s843Io({ 'planner:1': s843PlanEnv(S843_D2), 'planner:2': s843PlanEnv(S843_D2) }, [...S843_D2])
  const ctx = s843Ctx({ limits: { plan_rounds: 2, build_rounds: 2, review_rounds: 2 } })
  const result = driveTask(ctx, io)
  assert.equal(result.details.escalation.where, 'plan-scope-widened')
  assert.deepEqual(ctx.files_in_scope, [...S843_DISPATCHED])
})

test('a narrowed plan is accepted and journals what it shed', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_NARROWED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'done')
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.narrowed)
  assert.equal(rows[0].round, 1)
  assert.deepEqual([...rows[0].dropped].sort(), [...S843_DROPPED].sort())
  assert.deepEqual(rows[0].added, [])
  assert.deepEqual([rows[0].dispatched, rows[0].planned], [8, 6])
})

test('a matching plan is accepted and journals its identical scope', () => {
  const io = s843Io({
    'planner:1': s843PlanEnv(S843_DISPATCHED),
    'builder:1': buildEnv({ details: { files_changed: ['crew/io-contract.test.mjs'], commit_message: 'feat: the change' } }),
    'reviewer:1': reviewEnv('pass'),
  })
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass',
    'commit', 'suite', 'suite:cold', 'done',
  ])
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.same)
  assert.deepEqual([rows[0].added, rows[0].dropped], [[], []])
})

test('a lane with no dispatched scope is unchanged and says so', () => {
  const io = fakeIo({
    envelopes: { 'planner:1': planEnv(), 'builder:1': buildEnv(), 'reviewer:1': reviewEnv('pass') },
    runs: S843_RUNS, changed: ['a.mjs', 'a.test.mjs'],
  })
  const result = driveTask(CTX, io)
  assert.equal(result.status, 'done')
  assert.deepEqual(result.details.stages, [
    'plan:r1', 'build:r1', 'scope-gate:r1', 'lane:r1', 'review:r1', 'review:pass',
    'commit', 'suite', 'suite:cold', 'done',
  ])
  const rows = s843Rows(io)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verdict, PLAN_SCOPE.undispatched)
  assert.equal(rows[0].dispatched, null)
  assert.deepEqual([rows[0].added, rows[0].dropped], [[], []])
})

test('a malformed planner scope reaches the existing refusal, not a crash', () => {
  // The DISPATCHED side is validated by every dispatch path before driveTask sees it;
  // the planner envelope is not validated until after the plan loop. scopeMatcher
  // dereferences both sides unconditionally, so an unguarded comparison would throw on
  // files_in_scope: [null] and never reach the typed escalate('plan', …) below.
  assert.throws(() => outOfScopeFiles(['crew/drive.mjs'], scopeMatcher([null])), TypeError)
  const io = s843Io({ 'planner:1': s843PlanEnv([null]) }, [])
  const result = driveTask(s843Ctx(), io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'plan')
  assert.match(result.details.escalation.why, /null \(empty or non-string entry\)/)
  // Never classified: a scope that was never compared gets no verdict at all.
  assert.deepEqual(s843Rows(io), [])
})

test("the repair shape's own scope rule is untouched", () => {
  const io = fakeIo({
    envelopes: { 'planner:1': triageEnv({ details: { plan_path: `${TD}/triage.md`, files_in_scope: ['b.mjs'] } }) },
    runs: S843_RUNS, changed: ['a.mjs'],
    files: { [`${TD}/triage.md`]: '# Triage\n\nfix the off-by-one in a.mjs\n' },
  })
  const result = driveTask({ ...CTX, variant: 'repair', lane: 'lane-cmd', files_in_scope: ['a.mjs', 'a.test.mjs'] }, io)
  assert.equal(result.details.escalation.where, 'triage-scope')
  assert.match(result.details.escalation.why,
    /a triage that needs a wider surface is an escalation, not a re-plan/)
})

// ---------------------------------------------------------------------------
// #846 + #839 — b376 loop gates. The fixtures below keep the driver harness fake,
// except for B5f's explicit child-process witness check.
const B376_TEST_FILE = 'a.test.mjs'
const B376_IMPL_FILE = 'a.mjs'
const B376_FINDING = { id: 'F1', severity: 'must-fix', location: 'a.mjs:1', summary: 'the implementation defect' }
const B376_HARDENED = { finding: 'F1', test: B376_TEST_FILE, name: 'F1 guard', file: B376_IMPL_FILE, find: 'const guard = false', replace: 'const guard = true' }
const B376_FILES = {
  [`${CTX.checkout}/${B376_TEST_FILE}`]: 'export const repaired = true\n',
  [`${CTX.checkout}/${B376_IMPL_FILE}`]: 'const guard = false\n',
}
const B376_GREEN = { ok: true, output: `ok 1 - F1 guard\n# pass 1\n# fail 0` }
const B376_PRE_RED = { ok: false, output: `not ok 1 - F1 guard\n# pass 0\n# fail 1` }
const B376_MUT_RED = { ok: false, output: `not ok 1 - F1 guard\n# pass 0\n# fail 1` }
const b376Build = (hardened) => buildEnv({ details: { ...buildEnv().details, ...(hardened === undefined ? {} : { hardened }) } })
const b376Review = (verdict, findings = []) => reviewEnv(verdict, findings)

function b376ProofIo({ hardened = [B376_HARDENED], reviewer1 = b376Review('changes-needed', [B376_FINDING]), reviewer2 = b376Review('pass', []), reviewer3 = b376Review('pass', []), builder2 = b376Build(hardened), builder3 = b376Build(hardened), limits = { build_rounds: 2 }, files = B376_FILES, witnessOutput = { ok: true, output: `ok 1 - a.test.mjs\n# pass 1\n# fail 0` }, proofOutputs = [B376_GREEN, B376_PRE_RED, B376_MUT_RED], plan = {}, runs = {}, changed = ['a.mjs', 'a.test.mjs'], cleanRuns = null, throwOn = null } = {}) {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, ...plan } }),
      'builder:1': buildEnv(), 'builder:2': builder2, 'builder:3': builder3,
      'reviewer:1': reviewer1, 'reviewer:2': reviewer2, 'reviewer:3': reviewer3,
    },
    files, writeThrough: true, runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' }, ...runs },
    changed, cleanRuns, throwOn,
  })
  const baseRun = io.run
  io.run = function (cmd) {
    const result = baseRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return witnessOutput
    if (cmd === hardenCommand(B376_TEST_FILE, 'F1 guard')) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      return proofOutputs[count - 1] ?? proofOutputs.at(-1)
    }
    return result
  }
  return io
}

function b376DiskProofIo({ throwAtProofRun = null } = {}) {
  const checkout = scratchDir('b376-restore-')
  const testPath = join(checkout, B376_TEST_FILE)
  const implementationPath = join(checkout, B376_IMPL_FILE)
  const witnessedTest = 'export const reviewTime = true\n'
  const witnessedImplementation = 'const guard = false\n'
  const repairedTest = 'export const permanentGuard = true\n'
  const repairedImplementation = 'const guard = true\n'
  const hardened = { ...B376_HARDENED, find: 'const guard = true', replace: 'const guard = false' }
  writeFileSync(testPath, witnessedTest)
  writeFileSync(implementationPath, witnessedImplementation)
  const io = b376ProofIo({ hardened: [hardened] })
  const baseWait = io.wait
  let builtDigest = null
  io.wait = function (returnPath, timeoutS) {
    const env = baseWait.call(this, returnPath, timeoutS)
    if (returnPath === 'builder:2') {
      writeFileSync(testPath, repairedTest)
      writeFileSync(implementationPath, repairedImplementation)
      builtDigest = treeDigest(checkout)
    }
    return env
  }
  const baseRead = io.readFile
  io.readFile = function (path) {
    if (path === testPath || path === implementationPath) return existsSync(path) ? readFileSync(path, 'utf8') : null
    return baseRead.call(this, path)
  }
  const baseWrite = io.writeFile
  io.writeFile = function (path, content) {
    if (path === testPath || path === implementationPath) {
      this.calls.writes[path] = content
      this.calls.writeLog.push({ path, content })
      writeFileSync(path, content)
      return
    }
    return baseWrite.call(this, path, content)
  }
  const baseRun = io.run
  let proofRuns = 0
  io.run = function (cmd) {
    const result = baseRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE) || cmd === hardenCommand(B376_TEST_FILE, 'F1 guard')) {
      proofRuns += 1
      if (proofRuns === throwAtProofRun) throw new Error(`injected hardening run ${proofRuns}`)
    }
    return result
  }
  return {
    io, checkout, testPath, implementationPath, witnessedTest, witnessedImplementation,
    repairedTest, repairedImplementation, builtDigest: () => builtDigest,
  }
}

const b376StageStack = (io) => {
  const stack = []
  for (const row of io.calls.logs) {
    if (typeof row.stage === 'string') stack.push(row.stage)
    if (typeof row.stage_done === 'string') assert.equal(stack.pop(), row.stage_done)
  }
  return stack
}

test('b376 A1 a bounced build round runs its scope gate with rounds remaining', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(),
      'builder:1': { status: 'insufficient', role: 'builder', summary: 'steer', artifacts: [], details: {} },
      'lead:1': leadEnv('bounce'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['returns/d2.builder.json', 'rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'scope-fix').length, 1)
  assert.deepEqual(io.calls.logs.filter((row) => row.scope_gate).map((row) => row.scope_gate.reason), ['envelope-and-edits'])
  assert.equal(io.calls.logs.some((row) => row.member_questions), false)
  assert.equal(io.calls.logs.some((row) => row.decision), false)
  assert.deepEqual(b376StageStack(io), [])
})

test('b376 A2 a returns json in the checkout is named a misdirected envelope', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: ['a.mjs', 'a.test.mjs', 'returns/d1.builder.json'] } }),
      'builder:1': buildEnv(),
    },
    changed: ['returns/d1.builder.json'],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'scope')
  assert.equal(result.details.escalation.why, "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json")
  assert.doesNotMatch(result.details.escalation.why, /out-of-scope edits persisted/)
  const row = io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate
  assert.deepEqual(row, { round: 1, reason: 'envelope-in-checkout', envelopes: ['returns/d1.builder.json'], edits: [] })
})

test('b376 A3 a genuine out-of-scope source edit reports exactly as today', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': buildEnv(), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } },
    changed: [['rogue.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const scopeBrief = Object.entries(io.calls.writes).find(([path]) => path.endsWith('build-bounce-r1.md'))?.[1] || ''
  assert.equal(io.calls.logs.find((entry) => entry.scope_gate)?.scope_gate.reason, 'out-of-scope-edits')
  assert.match(scopeBrief, /OUTSIDE the plan's scope/)
  assert.deepEqual(result.details.stages.filter((stage) => stage.startsWith('scope-gate')), ['scope-gate:r1', 'scope-gate:r2'])
})

test('b376 A4 an in-scope bounced round keeps its byte-identical build bounce', () => {
  const io = fakeIo({
    envelopes: {
      'planner:1': planEnv(), 'builder:1': { status: 'insufficient', role: 'builder', summary: 'thin', artifacts: [], details: {} },
      'lead:1': leadEnv('bounce', 'steer'), 'builder:2': buildEnv(), 'reviewer:1': reviewEnv('pass', []),
    },
    runs: { 'lane-cmd': { ok: true, output: '' }, 'suite-cmd': { ok: true, output: '' } }, changed: [['a.mjs', 'a.test.mjs'], ['a.mjs', 'a.test.mjs']],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 1 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.writes[`${TD}/build-bounce-r1.md`], `# Build bounce (round 1)\n\nsteer\n\nPlan: ${TD}/plan.md`)
  assert.equal(io.calls.logs.some((row) => row.scope_gate), false)
  assert.equal(io.calls.logs.filter((row) => row.modifier?.kind === 'build').length, 1)
})

test('b376 B5a a proven hardening is accepted and clears the debt', () => {
  const io = b376ProofIo()
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'harden-fix').length, 0)
  assert.equal(result.details.stages.includes('lane:harden:r2'), true)
  assert.equal(result.details.stages.includes('review:r2'), true)
})

test('b376 B5b the finding-hardened row carries the finding id and the check name', () => {
  const io = b376ProofIo()
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.deepEqual(row, { round: 2, finding: 'F1', test: 'a.test.mjs', check: 'F1 guard', outcome: 'killed', why: null })
})

test('b376 B5c an existing named test is not gate growth', () => {
  const nestedSkipped = [
    "const label = 'F1'",
    "test('outer', async (t) => { await t.test(`${label} guard`, { skip: true }, () => {}) })",
  ].join('\n')
  const files = { ...B376_FILES, [`${CTX.checkout}/${B376_TEST_FILE}`]: nestedSkipped }
  const witnessOutput = { ok: true, output: 'ok 1 - outer\n    ok 1 - F1 guard # SKIP\n# pass 1\n# fail 0\n# skipped 1' }
  const io = b376ProofIo({ files, witnessOutput, limits: { build_rounds: 2 } })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(row.outcome, 'name-not-new')
  assert.match(row.why, /skipped/)

  const unprovenIo = b376ProofIo({
    witnessOutput: { ok: false, output: 'not ok 1 - unrelated\n# pass 0\n# fail 1' },
    limits: { build_rounds: 2 },
  })
  const unprovenResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, unprovenIo)
  const unproven = unprovenIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(unprovenResult.status, 'escalation')
  assert.equal(unproven.outcome, 'unproven')
})

test('b376 B5f the witnessed run executes nested checks without filtering their parents', () => {
  const root = scratchDir('b376-witness-')
  const testFile = join(root, 'nested.test.mjs')
  const source = [
    "import { test } from 'node:test'",
    "const label = 'F1'",
    "test('outer', async (t) => { await t.test(`${label} guard`, { skip: true }, () => {}) })",
  ].join('\n') + '\n'
  try {
    writeFileSync(testFile, source)
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    const full = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { encoding: 'utf8', env: childEnv })
    const filtered = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=F1 guard', testFile], { encoding: 'utf8', env: childEnv })
    assert.equal(full.status, 0)
    assert.equal(nameVerdict(full.stdout, 'F1 guard'), 'skipped')
    assert.equal(nameVerdict(filtered.stdout, 'F1 guard'), 'absent')

    const io = b376ProofIo()
    driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    const witnessCalls = io.calls.run.filter(({ cmd }) => cmd === "node --test --test-reporter=tap 'a.test.mjs'")
    assert.equal(witnessCalls.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('b376 B5d hardening must fail on the witnessed pre-repair surface', () => {
  const io = b376ProofIo({ proofOutputs: [B376_GREEN, B376_GREEN, B376_MUT_RED] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(row.outcome, 'pre-repair-green')
  assert.match(row.why, /witnessed pre-repair/)
})

test('b376 B5e must-fix debt survives auto-fix and ask-user routing', () => {
  const dGuard = { ...B376_HARDENED, finding: 'RV1-1', name: 'RV1 guard' }
  const dFiles = { ...B376_FILES, [`${CTX.checkout}/${B376_IMPL_FILE}`]: 'const guard = false\n' }
  const dProof = (findings, leadDecision = 'escalate') => {
    const io = dispositionIo(findings, {
      leadDecision,
      builder2: buildEnv({ details: { ...buildEnv().details, hardened: [dGuard] } }),
      files: dFiles, writeThrough: true,
    })
    const baseRun = io.run
    io.run = function (cmd) {
      const result = baseRun.call(this, cmd)
      if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
      if (cmd === hardenCommand(B376_TEST_FILE, 'RV1 guard')) {
        const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
        const output = [B376_GREEN, B376_PRE_RED, B376_MUT_RED][count - 1] || B376_MUT_RED
        return { ...output, output: output.output.replaceAll('F1 guard', 'RV1 guard') }
      }
      return result
    }
    return io
  }
  assert.equal(hardeningDebt({ findings: [{ ...D_AUTO, hardening: undefined, hardening_why: undefined }] }).owed.length, 1)
  assert.equal(hardeningDebt({ findings: [{ ...D_ASK, hardening: undefined, hardening_why: undefined }] }).owed.length, 1)
  for (const [finding, leadDecision] of [[D_AUTO, 'escalate'], [D_ASK, 'bounce']]) {
    const unmarked = { ...finding, hardening: undefined, hardening_why: undefined }
    const io = dProof(unmarked, leadDecision)
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'done')
    assert.equal(io.calls.logs.some((entry) => entry.finding_hardened?.finding === 'RV1-1' && entry.finding_hardened.outcome === 'killed'), true)
    assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  }
})

test('b376 B6 an unhardened must-fix repair bounces naming the finding', () => {
  const io = b376ProofIo({ hardened: [] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /F1/)
  assert.match(result.details.escalation.why, /no-declaration/)
  assert.doesNotMatch(result.details.escalation.why, /insufficient\\b/)
  assert.equal(io.calls.logs.some((entry) => entry.finding_hardened), false)
})

test('b376 B7a a reviewer ungateable mark exempts the finding', () => {
  const marked = { ...B376_FINDING, hardening: 'ungateable', hardening_why: 'the reviewer supplied no safe anchor' }
  const io = b376ProofIo({
    reviewer1: b376Review('changes-needed', [marked]),
    reviewer2: b376Review('pass', []),
    hardened: [],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'done')
  const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.deepEqual(row, { round: 1, finding: 'F1', test: null, check: null, outcome: 'ungateable', why: 'the reviewer supplied no safe anchor' })

  const repeated = b376ProofIo({
    reviewer1: b376Review('changes-needed', [marked]), reviewer2: b376Review('changes-needed', [marked]), reviewer3: b376Review('pass', []),
    hardened: [], limits: { build_rounds: 3 },
  })
  const repeatedResult = driveTask({ ...CTX, limits: { build_rounds: 3, review_rounds: 3 } }, repeated)
  assert.equal(repeatedResult.status, 'done')
  assert.equal(repeated.calls.logs.filter((entry) => entry.finding_hardened?.outcome === 'ungateable').length, 2)
})

test('b376 B7b a builder-claimed exemption is refused', () => {
  for (const exemption of [
    { exempt: 'the builder cannot waive a reviewer obligation' },
    { ungateable: true },
  ]) {
    const io = b376ProofIo({ hardened: [{ ...B376_HARDENED, ...exemption }] })
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'harden')
    assert.match(result.details.escalation.why, /builder-exemption|only the reviewer may/)
    assert.equal(io.calls.logs.some((entry) => entry.finding_hardened?.outcome === 'killed'), false)
  }
})

test('b376 B7c only reviewer-origin ungateable survives a continuation panel', () => {
  const partnerFinding = { id: 'F2', severity: 'must-fix', location: 'a.mjs:1', summary: 'the partner guard', hardening: 'ungateable', hardening_why: 'the partner cannot waive this' }
  const reviewerFinding = { ...B376_FINDING, hardening: 'ungateable', hardening_why: 'reviewer cannot name a safe guard' }
  const f2 = { ...B376_HARDENED, finding: 'F2', name: 'F2 guard', find: 'const guard = false', replace: 'const guard = true' }
  const panel = dispositionPanelIo({
    reviewer1: dReviewEnv('changes-needed', [reviewerFinding]),
    partner1: dPartnerEnv('changes-needed', [B376_FINDING, partnerFinding]), adjudication1: dAdjEnv(),
    reviewer2: dReviewEnv('pass', []), partner2: dPartnerEnv('pass', []), adjudication2: dAdjEnv(),
    builder2: buildEnv({ details: { ...buildEnv().details, hardened: [f2] } }),
    files: B376_FILES, writeThrough: true,
  })
  const f2Outputs = [B376_GREEN, B376_PRE_RED, B376_MUT_RED].map((entry) => ({ ...entry, output: entry.output.replaceAll('F1 guard', 'F2 guard') }))
  const oldRun = panel.run
  panel.run = function (cmd) {
    const result = oldRun.call(this, cmd)
    if (cmd === hardenWitnessCommand(B376_TEST_FILE)) return { ok: true, output: 'ok 1 - a.test.mjs\n# pass 1\n# fail 0' }
    if (cmd === hardenCommand(B376_TEST_FILE, 'F2 guard')) {
      const count = this.calls.run.filter(({ cmd: seen }) => seen === cmd).length
      return f2Outputs[count - 1] || f2Outputs.at(-1)
    }
    return result
  }
  const result = driveTask({ ...D_PANEL_CTX, limits: { build_rounds: 2 } }, panel)
  assert.equal(result.status, 'done')
  const rows = panel.calls.logs.filter((entry) => entry.finding_hardened).map((entry) => entry.finding_hardened)
  assert.equal(rows.some((row) => row.finding === 'F1' && row.outcome === 'ungateable'), true)
  assert.equal(rows.some((row) => row.finding === 'F2' && row.outcome === 'killed'), true)
})

test('b376 B8 the hardening proof adds no gate result', () => {
  const markedReviewer2 = b376Review('changes-needed', [B376_FINDING])
  const io = b376ProofIo({
    reviewer2: markedReviewer2, reviewer3: b376Review('pass', []), limits: { build_rounds: 3 },
    proofOutputs: [B376_GREEN, B376_PRE_RED, B376_MUT_RED, B376_GREEN, B376_PRE_RED, B376_MUT_RED],
  })
  const result = driveTask({ ...CTX, limits: { build_rounds: 3, review_rounds: 3 } }, io)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === hardenWitnessCommand(B376_TEST_FILE)).length, 2)
  assert.equal(io.calls.run.filter(({ cmd }) => cmd === hardenCommand(B376_TEST_FILE, 'F1 guard')).length, 6)
  const hardeningCommands = new Set([hardenWitnessCommand(B376_TEST_FILE), hardenCommand(B376_TEST_FILE, 'F1 guard')])
  assert.equal(io.calls.emits.some(({ kind, cmd }) => kind === 'gate' && hardeningCommands.has(cmd)), false)
})

test('b376 B9 a surviving hardening mutation is refused', () => {
  for (const mutant of [
    { ok: false, output: 'not ok 1 - unrelated\n# pass 0\n# fail 1' },
    { ok: true, output: 'ok 1 - unrelated\n# pass 1\n# fail 0' },
  ]) {
    const io = b376ProofIo({ proofOutputs: [B376_GREEN, B376_PRE_RED, mutant] })
    const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'harden')
    const row = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
    assert.equal(row.outcome, 'survived')
    assert.match(row.why, /unrelated|absent/)
  }
})

test('b376 B10 hardening paths cannot escape a directory scope', () => {
  const proveRefusal = (entry, escaped, reason) => {
    const io = b376ProofIo({
      hardened: [entry], changed: [], limits: { build_rounds: 3 },
      plan: { files_in_scope: ['crew/tests/'] },
    })
    const baseRead = io.readFile
    io.calls.read = []
    io.readFile = function (path) {
      this.calls.read.push(path)
      return baseRead.call(this, path)
    }
    const result = driveTask({ ...CTX, limits: { build_rounds: 3 } }, io)
    const bounce = io.calls.writes[`${TD}/build-bounce-r2.md`]
    const escapedAbsolute = `${CTX.checkout}/${escaped}`
    assert.equal(result.status, 'escalation')
    assert.match(bounce, new RegExp(`F1: ${reason}`))
    assert.equal(io.calls.assign.filter(({ role, note }) => role === 'builder' && note === 'harden-fix').length, 1)
    assert.equal(io.calls.read.includes(escapedAbsolute), false)
    assert.equal(io.calls.writeLog.some(({ path }) => path === escapedAbsolute), false)
    assert.equal(io.calls.run.some(({ cmd }) => cmd.includes(escaped)), false)
  }
  const escapedTest = 'crew/tests/../../outside.test.mjs'
  proveRefusal({ ...B376_HARDENED, test: escapedTest, file: 'crew/tests/inside.mjs' }, escapedTest, 'test-not-in-scope')
  const escapedFile = 'crew/tests/../../outside.mjs'
  proveRefusal({ ...B376_HARDENED, test: 'crew/tests/inside.test.mjs', file: escapedFile }, escapedFile, 'file-not-in-scope')
})

test('b376 B11 a hardening restore failure stops the run with the mutation in flight', () => {
  const io = b376ProofIo({ builder3: b376Build([]) })
  const baseRead = io.readFile
  let implementationReads = 0
  io.readFile = function (path) {
    if (path === `${CTX.checkout}/${B376_IMPL_FILE}` && implementationReads++ === 0) return 'const guard = true\n'
    return baseRead.call(this, path)
  }
  const baseWrite = io.writeFile
  let implementationWrites = 0
  io.writeFile = function (path, content) {
    if (path === `${CTX.checkout}/${B376_IMPL_FILE}`) {
      implementationWrites += 1
      if (implementationWrites === 2) throw new Error('writeFile: the restore write failed')
    }
    return baseWrite.call(this, path, content)
  }
  const result = driveTask({ ...CTX, limits: { build_rounds: 3 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /could not restore|run stops/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  const hardenRow = io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(hardenRow.outcome, 'unproven')
})

test('b376 B12 a test-file wrapper cannot satisfy a named hardening check', () => {
  const entry = { ...B376_HARDENED, name: B376_TEST_FILE }
  const io = b376ProofIo({ hardened: [entry] })
  const result = driveTask({ ...CTX, limits: { build_rounds: 2 } }, io)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'harden')
  assert.match(result.details.escalation.why, /name-file-wrapper/)
  assert.equal(io.calls.run.some(({ cmd }) => cmd.includes('--test-name-pattern')), false)
})

test('b376 B13 hardening refuses a mutation that changes only whitespace', () => {
  const entry = { ...B376_HARDENED, find: 'const guard = false', replace: 'const  guard = false' }
  const hardening = validateHardened({ hardened: [entry] }, [{ id: 'F1' }], scopeMatcher(['a.mjs', 'a.test.mjs']))
  assert.equal(mutationChangesTokens(entry.find, entry.replace), false)
  assert.equal(hardening.entries.length, 0)
  assert.equal(hardening.refusals[0].reason, 'replace-identical')
  const plan = validateMutations([{ check: 'F1', file: 'a.mjs', find: entry.find, replace: entry.replace }], scopeMatcher(['a.mjs', 'a.test.mjs']))
  assert.equal(plan[0]?.why, 'find and replace differ only in whitespace — that mutates no token')
})

test('#846 scope refusals distinguish envelope debris from ordinary edits', () => {
  assert.deepEqual(SCOPE_REFUSALS, ['out-of-scope-edits', 'envelope-in-checkout', 'envelope-and-edits'])
  const cases = [
    [[], { reason: null, envelopes: [], edits: [], why: null }],
    [['rogue.mjs'], { reason: 'out-of-scope-edits', envelopes: [], edits: ['rogue.mjs'], why: 'out-of-scope edits persisted: rogue.mjs' }],
    [['returns/d1.builder.json'], { reason: 'envelope-in-checkout', envelopes: ['returns/d1.builder.json'], edits: [], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json" }],
    [['returns/d1.builder.json', 'rogue.mjs'], { reason: 'envelope-and-edits', envelopes: ['returns/d1.builder.json'], edits: ['rogue.mjs'], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: returns/d1.builder.json; out-of-scope edits persisted: rogue.mjs" }],
    [['x/returns/d1.builder.json'], { reason: 'envelope-in-checkout', envelopes: ['x/returns/d1.builder.json'], edits: [], why: "an envelope was written to the checkout instead of the assignment's absolute returnPath: x/returns/d1.builder.json" }],
    [['returns/notes.md'], { reason: 'out-of-scope-edits', envelopes: [], edits: ['returns/notes.md'], why: 'out-of-scope edits persisted: returns/notes.md' }],
  ]
  for (const [files, expected] of cases) assert.deepEqual(scopeRefusal(files), expected)
  assert.equal(ENVELOPE_DEBRIS.test('x/returns/d1.builder.json'), true)
  assert.equal(ENVELOPE_DEBRIS.test('returns/notes.md'), false)
  const mixed = scopeRefusal(['returns/d1.builder.json', 'rogue.mjs'])
  const brief = scopeBounceBrief(2, mixed, ['a.mjs'], `${TD}/plan.md`)
  assert.match(brief, /ENVELOPE was written into the CHECKOUT/)
  assert.match(brief, /OUTSIDE the plan's scope/)
})

test('#839 hardening commands escape exact names and keep witnesses unfiltered', () => {
  const file = "o'hare.test.mjs"
  const name = 'guard (.$)'
  const quotedFile = `'o'"'"'hare.test.mjs'`
  assert.equal(hardenCommand(file, name), `node --test --test-reporter=tap --test-name-pattern='guard \\(\\.\\$\\)' ${quotedFile}`)
  assert.equal(hardenWitnessCommand(file), `node --test --test-reporter=tap ${quotedFile}`)
  assert.doesNotMatch(hardenWitnessCommand(file), /--test-name-pattern/)
  assert.match(hardenCommand(file, name), /--test-name-pattern=/)
})

test('#839 reviewer hardening marks preserve the five-key finding shape unless valid', () => {
  const base = { id: 'F1', severity: 'must-fix', location: 'a.mjs:1', summary: 'guard the defect' }
  const fiveKeys = { ...base, disposition: null }
  assert.deepEqual(HARDENING_MARKS, ['ungateable'])
  assert.deepEqual(HARDENING_REFUSALS, [
    'no-declaration', 'not-an-array', 'unknown-finding', 'duplicate-finding',
    'test-not-in-scope', 'file-not-in-scope', 'name-missing', 'name-file-wrapper', 'find-missing',
    'replace-identical', 'builder-exemption',
  ])
  assert.deepEqual(HARDENING_OUTCOMES, [
    'killed', 'survived', 'ungateable',
    'name-not-new', 'name-absent', 'name-ambiguous', 'control-red', 'control-skipped',
    'pre-repair-green', 'witness-missing', 'witness-absent', 'witness-unreadable',
    'unproven', 'unapplied', 'anchor-absent', 'anchor-ambiguous', 'anchor-unsafe',
  ])
  const marked = { ...base, hardening: 'ungateable', hardening_why: ' documented exception ' }
  assert.equal(hardeningOf(marked), 'ungateable')
  assert.deepEqual(reviewFindings({ findings: [marked] }).findings, [{ ...fiveKeys, hardening: 'ungateable', hardening_why: 'documented exception' }])
  assert.deepEqual(hardeningDebt({ findings: [marked] }), { owed: [], exempt: [{ id: 'F1', why: 'documented exception' }] })
  for (const [label, candidate] of [
    ['unknown mark', { ...base, hardening: 'ungatable', hardening_why: 'typo' }],
    ['missing why', { ...base, hardening: 'ungateable' }],
    ['empty why', { ...base, hardening: 'ungateable', hardening_why: '   ' }],
  ]) {
    assert.equal(hardeningOf(candidate), null, label)
    assert.deepEqual(reviewFindings({ findings: [candidate] }).findings, [fiveKeys], label)
    assert.deepEqual(hardeningDebt({ findings: [candidate] }), { owed: [{ id: 'F1', location: 'a.mjs:1', summary: 'guard the defect' }], exempt: [] }, label)
  }
})

test('#839 name verdicts classify recorded Node TAP outcomes', () => {
  const root = scratchDir('b376-name-verdict-')
  const testFile = join(root, 'name-verdict.test.mjs')
  const source = [
    "import { test } from 'node:test'",
    "test('passed', () => {})",
    "test('failed', () => { throw new Error('expected failure') })",
    "test('duplicate', () => {})",
    "test('duplicate', () => {})",
    "test('skipped', { skip: true }, () => {})",
    "test('todo', { todo: true }, () => {})",
    "test('outer', async (t) => {",
    "  await t.test('nested passed', () => {})",
    "  await t.test('nested failed', () => { throw new Error('expected failure') })",
    '})',
  ].join('\n')
  try {
    writeFileSync(testFile, `${source}\n`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const recorded = spawnSync(process.execPath, ['--test', '--test-reporter=tap', testFile], { encoding: 'utf8', env })
    const noMatch = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=no-such-check', testFile], { encoding: 'utf8', env })
    assert.equal(recorded.status, 1)
    assert.equal(noMatch.status, 0)
    assert.deepEqual(NAME_VERDICTS, ['passed', 'failed', 'skipped', 'absent', 'ambiguous'])
    assert.equal(nameVerdict(recorded.stdout, 'passed'), 'passed')
    assert.equal(nameVerdict(recorded.stdout, 'failed'), 'failed')
    assert.equal(nameVerdict(recorded.stdout, 'duplicate'), 'ambiguous')
    assert.equal(nameVerdict(recorded.stdout, 'skipped'), 'skipped')
    assert.equal(nameVerdict(recorded.stdout, 'todo'), 'skipped')
    assert.equal(nameVerdict(recorded.stdout, 'nested passed'), 'passed')
    assert.equal(nameVerdict(recorded.stdout, 'nested failed'), 'failed')
    assert.equal(nameVerdict(noMatch.stdout, 'passed'), 'absent')
    assert.equal(nameVerdict(recorded.stdout, 'not present'), 'absent')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('#839 scoped hardening paths reject traversal, directories, and non-strings', () => {
  const directoryScope = scopeMatcher(['crew/tests/'])
  assert.equal(scopedPath('crew/tests/a.test.mjs', directoryScope), true)
  assert.equal(scopedPath('crew/tests/../../outside.mjs', directoryScope), false)
  assert.equal(scopedPath('crew/tests/', directoryScope), false)
  assert.equal(scopedPath(null, directoryScope), false)
  assert.equal(scopedPath('crew/drive.mjs', scopeMatcher(['crew/drive.mjs'])), true)
})

test('#839 witness cells distinguish read, absent, and unreadable review-time paths', () => {
  const freshFiles = () => ({
    [`${CTX.checkout}/${B376_TEST_FILE}`]: 'export const repaired = true\n',
    [`${CTX.checkout}/${B376_IMPL_FILE}`]: 'const guard = false\n',
  })
  const readIo = b376ProofIo({ files: freshFiles() })
  const readResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, readIo)
  assert.equal(readResult.status, 'done')
  assert.equal(readIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened.outcome, 'killed')

  const absentFiles = freshFiles()
  delete absentFiles[`${CTX.checkout}/${B376_IMPL_FILE}`]
  const absentIo = b376ProofIo({ files: absentFiles })
  const absentResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, absentIo)
  const absentRow = absentIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(absentResult.details.escalation.where, 'harden')
  assert.equal(absentRow.outcome, 'witness-absent')
  assert.match(absentRow.why, /did not exist/)

  const unreadableIo = b376ProofIo({ files: freshFiles() })
  const baseRead = unreadableIo.readFile
  let denied = false
  unreadableIo.readFile = function (path) {
    if (!denied && path === `${CTX.checkout}/${B376_IMPL_FILE}`) {
      denied = true
      throw new Error('EACCES: witness read denied')
    }
    return baseRead.call(this, path)
  }
  const unreadableResult = driveTask({ ...CTX, limits: { build_rounds: 2 } }, unreadableIo)
  const unreadableRow = unreadableIo.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
  assert.equal(unreadableResult.details.escalation.where, 'harden')
  assert.equal(unreadableRow.outcome, 'witness-unreadable')
  assert.match(unreadableRow.why, /EACCES/)
  assert.doesNotMatch(unreadableRow.why, /did not exist/)
})

test('#839 hardening briefs and bounces retain specific findings', () => {
  const brief = hardeningBriefLines([{ id: 'F1', location: 'a.mjs:1', summary: 'guard it' }], [{ id: 'F2' }])
  assert.match(brief.join('\n'), /F1 \(a\.mjs:1\) — guard it/)
  assert.match(brief.join('\n'), /Reviewer exemption recorded for F2/)
  assert.deepEqual(hardeningBriefLines([], []), [])
  const bounce = hardeningBounceLines(2, [{ finding: 'F1', reason: 'no-declaration', why: 'missing declaration' }], [
    { finding: 'F2', outcome: 'survived', why: 'the mutation passed' },
    { finding: 'F3', outcome: 'killed', why: null },
  ])
  assert.match(bounce.join('\n'), /F1: no-declaration — missing declaration/)
  assert.match(bounce.join('\n'), /F2: survived — the mutation passed/)
  assert.doesNotMatch(bounce.join('\n'), /F3: killed/)
})

test('#839 hardening proof restores the dirty built tree after success and each contained run failure', () => {
  for (const [label, throwAtProofRun, outcome] of [
    ['success', null, 'killed'],
    ['witness', 1, 'unproven'],
    ['control', 2, 'unproven'],
    ['pre-repair', 3, 'unproven'],
    ['mutation', 4, 'unproven'],
  ]) {
    const fixture = b376DiskProofIo({ throwAtProofRun })
    const result = driveTask({ ...CTX, checkout: fixture.checkout, limits: { build_rounds: 2 } }, fixture.io)
    const row = fixture.io.calls.logs.find((entry) => entry.finding_hardened)?.finding_hardened
    assert.equal(typeof fixture.builtDigest(), 'string', label)
    assert.equal(treeDigest(fixture.checkout), fixture.builtDigest(), label)
    assert.equal(readFileSync(fixture.testPath, 'utf8'), fixture.repairedTest, label)
    assert.equal(readFileSync(fixture.implementationPath, 'utf8'), fixture.repairedImplementation, label)
    assert.notEqual(readFileSync(fixture.testPath, 'utf8'), fixture.witnessedTest, label)
    assert.notEqual(readFileSync(fixture.implementationPath, 'utf8'), fixture.witnessedImplementation, label)
    assert.equal(row.outcome, outcome, label)
    if (throwAtProofRun === null) {
      assert.equal(result.status, 'done', label)
    } else {
      assert.equal(result.details.escalation.where, 'harden', label)
      assert.doesNotMatch(result.details.escalation.why, /could not restore the built tree/, label)
    }
  }
})

test('RV1-1 an all-exempt declaration set journals a completed bind check', () => {
  const mutations = [{ check: 'all-exempt', exempt: 'no source anchor is required' }]
  const io = fakeIo({ cleanRuns: CHECK_CLEAN,
    envelopes: CHECK_ENVELOPES(mutations), runs: CHECK_RUNS(), changed: ['a.mjs', 'a.test.mjs'], emit: true })
  const res = driveTask(CTX, io)
  assert.equal(res.status, 'done')
  assert.equal(res.details.gate.check_discrimination, 'proven')
  assert.deepEqual(res.details.gate.check_discriminations, [
    { check: 'all-exempt', outcome: 'exempt', why: 'no source anchor is required', file: null, summary: null },
  ])
  assert.deepEqual(io.calls.logs.filter((line) => line.mutation_anchor_bind).map((line) => line.mutation_anchor_bind), [
    { generation: 1, declared: 0, exact: 0, normalized: 0, absent: 0, corrected: 0, checks: [] },
  ])
  assert.equal(io.calls.logs.filter((line) => line.mutation_anchor_absent).length, 0)
})
