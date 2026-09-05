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

import { checkAnchors, laneFence, partitionShifts } from '../skills/qa-test-writing/anchor-pin.mjs'

import { assertSeats, runCmd } from './crew.mjs'

import { ADOPT_BLOCK } from '../scripts/factory/dispatch-batch.mjs'

import { runChild } from './child.mjs'

import { SEAT_REFUSAL_STAGE } from './seat-io.mjs'

import {
  driveTask, LIMITS, WAITS_S, WAIT_ROLES, WAIT_FLAGS, WAIT_REFUSALS, WAIT_SECONDS_MIN, WAIT_SECONDS_MAX,
  NO_TURN_CEILING, TURN_CEILING_ROLES, TURN_CEILING_REFUSALS, resolveTurnCeilings, turnCeilingsRecord,
  adoptionSignal, planRoundCap, ADOPTED_PLAN_HEADING, PLAN_CHECK_ABSENT, PLAN_CHECK_INVALID,
  PLAN_CHECK_SEVERITIES, PLAN_CONVERGENCE_REASONS, planCheckFindings, planCheckFindingsFromText, planConvergence,
  carriedPreambleLines, carriedResolution, carriedSilenceDefect, carriedPrLines,
  PREDECESSOR_FINDINGS_CLOSED, PLAN_CLOSED_MARKER, predecessorFindingsClosed, lineageFromJournal,
  enforcementPreamble, observeTurnCensus, turnCeilingBreached, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE, CENSUS_ABSENT_REASONS,
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
  VALIDATION_LANE_UNLOADABLE, VALIDATION_LANE_EVENT, LOADABLE_LANE_EXTENSIONS, LANE_PROBE_KINDS,
  LANE_INPUT_VERDICTS, LANE_COMMAND_SHAPES, LANE_VALUE_OPTIONS, LANE_PATH_OPTIONS, shellWords,
  laneCommandShape, laneCommandInputs, laneProbeCommand, laneProbeKinds, laneInputExtension,
  resolveValidationLane, validationLaneWhy, validationLaneBounceLines,
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
    assign(spec) {
      const { role, briefFile, note } = spec
      counts[role] = (counts[role] || 0) + 1; seq += 1
      calls.assign.push({ role, briefFile, note, policy: spec.policy ?? null, n: counts[role] })
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

const suiteRefusalEnv = (id = 'planner1', role = 'planner') => ({
  assignment_id: id, role, status: 'insufficient', summary: `${role} stopped after an unowned suite run`, artifacts: [],
  details: {
    suite_refusal: {
      role, transport: 'headless-json', command: 'npm test', kind: 'suite', gate_path: `${TD}/gate.mjs`,
      reason: `suite-run-not-owned: the driver's gate-proof stage carries this evidence at ${TD}/gate.mjs`,
    },
  },
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

const protectedPlanEnv = (files = ['crew/drive.mjs']) => planEnv({
  details: { ...planEnv().details, files_in_scope: files },
})

const protectedReseatRefusal = () => ({ applied: false, reason: 'transport', why: 'pane seat refuses a targeted reseat', from: null })

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
    enforcements: [],
    growth: [{
      round: 1, plan_bytes: null, gate_bytes: null, plan_delta: null, gate_delta: null,
      combined_bytes: null, round1_combined_bytes: null, files_in_scope_count: 2,
      ratio: null, divergent: false,
    }],
    modifiers: [],
    gate: null,
  },
}

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
    enforcements: [],
    growth: [{
      round: 1, plan_bytes: null, gate_bytes: null, plan_delta: null, gate_delta: null,
      combined_bytes: null, round1_combined_bytes: null, files_in_scope_count: 2, ratio: null, divergent: false,
    }],
    modifiers: [],
    gate: null,
  },
})

const ZERO_CAPACITY_LOGS = Object.freeze([
  { plan_round_cap: { adopted: false, cap: 2, predecessor_checked: null, reason: 'not-adopted' }, channel: 'record' },
  { stage: 'plan:r1', channel: 'record' },
  { assign: 'planner1', role: 'planner', brief: '/tmp/brief.md', channel: 'record' },
  { envelope: 'planner1', role: 'planner', status: 'done', channel: 'record' },
  { plan_scope: { round: 1, verdict: 'plan-scope-undispatched', added: [], dropped: [], dispatched: null, planned: 2 }, channel: 'record' },
  { event: 'validation-lane-resolved', validation_lane_resolved: { round: 1, shape: 'opaque', loadable: 0, missing: 0, unreadable: 0, 'unsupported-type': 0, 'unsupported-extension': 0, 'glob-unresolved': 0, refused: [], total: 0 }, channel: 'record' },
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

const resumeKeys = ['stages', 'escalation', 'commit', 'dissents', 'extra_rounds_granted', 'growth', 'modifiers', 'enforcements', 'gate', 'seq_high_water', 'gate_attempt_high_water', 'cursor', 'consults_spent', 'accept_findings', 'head']

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
  ['recordRow', '', 'at seat_turn_ceiling'],
  ['recordRow', '', 'at seat_enforcement'],
  ['recordRow', '', 'at assign role brief'],
  ['recordRow', '', 'at seat_enforcement'],
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
  ['recordRow', '', 'at plan_round_cap'],
  ['recordRow', '', 'at plan_lineage'],
  ['recordRow', '', 'at member_questions'],
  ['recordRow', '', 'at question_answers'],
  ['recordRow', '', 'at plan_scope'],
  ['recordRow', '', 'at event validation_lane_resolved'],
  ['recordRow', '', 'at gate_path_rejected'],
  ['recordRow', '', 'at plan_growth'],
  ['recordRow', '', 'at plan_round_cap'],
  ['recordRow', '', 'at carve_verdict'],
  ['recordRow', '', 'at plan_converged'],
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

function throwAutoFixWrites(io, message = 'ENAMETOOLONG: name too long') {
  const write = io.writeFile
  io.writeFile = (path, contents) => {
    if (/\/auto-fix-.*\.patch$/.test(String(path))) throw new Error(message)
    return write(path, contents)
  }
  return io
}

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

// ---------------------------------------------------------------------------
// #915 — planner validation_lane resolution. The probe is scripted through fakeIo's
// command map: no scratch tree or temp primitive belongs in these tests.
const validationPlan = (lane) => planEnv({ details: { ...planEnv().details, validation_lane: lane } })

const validationProbeOutput = (kinds) => {
  const entries = kinds instanceof Map ? [...kinds.entries()] : Object.entries(kinds)
  return entries.map(([input, kind]) => `${kind} ${input}`).join('\n') + (entries.length > 0 ? '\n' : '')
}

const validationProbeRun = (lane, kinds) => {
  const { inputs } = laneCommandInputs(lane)
  return { [laneProbeCommand(inputs)]: { ok: true, output: validationProbeOutput(kinds) } }
}

const validationRows = (io) => io.calls.logs.filter((row) => row && row.event === VALIDATION_LANE_EVENT)

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

// Every top-level binding, re-exported so each split file imports exactly what
// it uses. Importing this module also installs the ledger sandbox and its
// after() cleanup, which are per-process and therefore needed in every file.
export {
  ACCEPT_FINDINGS, ACCEPT_FINDINGS_SOFT, ACCEPT_REASKS, ACCEPT_REFUSALS, ADOPTED_PLAN_HEADING, ADOPT_BLOCK, B318_GATED_RUNS, B376_FILES, B376_FINDING, B376_GREEN, B376_HARDENED, B376_IMPL_FILE, B376_MUT_RED, B376_PRE_RED, B376_TEST_FILE, B384_BUILT, B384_CORRECTED_FIND, B384_CORRECTED_REPLACE, B384_FILE, B384_GREEN, B384_MUTATION, B384_PLAN, B384_RED, B44_LEADLESS_CTX, CARVE_VERDICTS, CENSUS_ABSENT_REASONS, CENSUS_ROW_ABSENT, CENSUS_TURNS_ABSENT, CENSUS_UNREADABLE, CHECK_BUILT, CHECK_CLEAN, CHECK_ENVELOPES, CHECK_FAIL_PREFIX, CHECK_FILE, CHECK_MUTATION, CHECK_PLAN, CHECK_RUNS, CLOBBER_R2, COMMIT_TRAILER, CONVERGE_CTX, CONVERGE_GATE, CONVERGE_PLAN, CRASH_FINDINGS, CRASH_STAGES, CRASH_WHY, CTX, CTX_DIRECTED, CTX_REPAIR, CTX_TL, DECISIONS, DEFAULT_VARIANT, DIRECTED_BRIEF_PATH, DIRECTED_BRIEF_TEXT, DIRECTED_FILES, DIRECTED_SEATS, DIRECTED_SOURCES, DIRECTED_STAGES, DIRECTED_STAGE_HEAD, DRIVE_JOURNAL_EXPECTED, DRIVE_SINK, D_ASK, D_AUTO, D_CLASS_COLLIDING, D_CLASS_PARTNER, D_COLLISION_CTX, D_DIVERGENT_A, D_DIVERGENT_PARTNER, D_GREEN_GATE, D_HUNK, D_PANEL_CTX, D_PATCH_A, D_PATCH_B, D_PATCH_EMPTY_PATH, D_PATCH_MIXED_MODE, D_PATCH_MIXED_RENAME, D_RED_GATE, ENVELOPE_DEBRIS, ENVELOPE_FIELD_KINDS, ENVELOPE_REFUSAL_REASONS, EXECUTIONS, FAILURE_UPGRADE, FINDING_DISPOSITIONS, FINDING_ID_SHAPE, FINDING_SEVERITIES, GATE_CUSTODIAN, GATE_REAP_CMD_EOF, GATE_REAP_SWEEP_MARKER, GATE_SUMMARY_PREFIX, GROWTH_DIVERGENCE_FACTOR, HARDENING_MARKS, HARDENING_OUTCOMES, HARDENING_REFUSALS, HEALTHY_RESULT, HONEST_NARRATION, JOURNAL_CHANNELS, JOURNAL_CHANNEL_NAMES, JUDGE_TIER, LANE_COMMAND_SHAPES, LANE_INPUT_VERDICTS, LANE_PATH_OPTIONS, LANE_PROBE_KINDS, LANE_VALUE_OPTIONS, LEDGER_SANDBOX, LEDGER_SANDBOX_PREVIOUS, LIMITS, LOADABLE_LANE_EXTENSIONS, MAX_QUESTIONS, MODIFIER_OUTCOMES, MUST_FIX_REFUTATION_FINDINGS, MUTATIONS_MAX, MUTATION_BINDING_FAILURES, MUTATION_BIND_STATUSES, MUTATION_CORRECTION_OUTCOMES, MUTATION_CORRECTION_REFUSALS, MUTATION_OUTCOMES, NAME_VERDICTS, NARRATION_HEADING, NARRATION_MAX_CHARS, NARRATION_RECORD, NARRATION_REFUSALS, NARRATION_REFUSAL_NAMES, NARRATION_STAGE_VOCABULARY, NARRATOR_PROVIDER, NARRATOR_REGISTER, NO_TURN_CEILING, PANEL_ADJUDICATORS, PANEL_PARTNERS, PARTIAL_REVIEWED, PERSPECTIVE_TARGETS, PHASE_SLOT_WAIT_EVENT, PLAN_CHECK_ABSENT, PLAN_CHECK_FINDINGS, PLAN_CHECK_INVALID, PLAN_CHECK_SEVERITIES, PLAN_CLOSED_MARKER, PLAN_CONVERGENCE_REASONS, PLAN_RESIDUAL, PLAN_SCOPE, PLAN_SCOPE_VERDICTS, PREDECESSOR_FINDINGS_CLOSED, PROTECTED_PATHS, PUBLISH_BASE, PUBLISH_COLD_OUTPUT, PUBLISH_REFUSALS, PUBLISH_REFUSAL_NAMES, PUBLISH_WARM_OUTPUT, RED, REFUTATION_CLAIM, REFUTATION_CONVERGE_PLAN, REFUTATION_CONVERGE_RUNS, REFUTATION_EVIDENCE_MAX, REPO_ROOT, RESIDUAL_TYPES, REVIEWED_CORE_STAGES, REVIEW_FINDINGS, REVIEW_GATE_PASS, RUN_START_EVENT, S843_ADDED, S843_D2, S843_DISPATCHED, S843_DROPPED, S843_NARROWED, S843_RUNS, SCOPE_REFUSALS, SEAT_REFUSAL_STAGE, SECOND_OPINION, SENSITIVITY_FLOOR, SHAPE_MAJOR_PHASES, SHAPE_ROUNDED_STAGES, SHAPE_SOURCES, SKILL_NAMES, SUITE_SLOT_PHASES, SUITE_SLOT_PHASE_NAMES, TD, THREW, TRIAGE_FILES, TRIAGE_NOTE, TRIAGE_SOURCES, TRIAGE_STAGES, TRIAGE_STAGE_HEAD, TURN_CEILING_REFUSALS, TURN_CEILING_ROLES, UNIVERSAL_STAGE_HEADS, VALIDATION_LANE_EVENT, VALIDATION_LANE_UNLOADABLE, VARIANTS, VARIANT_NAMES, WAITS_S, WAIT_FLAGS, WAIT_REFUSALS, WAIT_ROLES, WAIT_SECONDS_MAX, WAIT_SECONDS_MIN, WRITE_SURFACES, ZERO_CAPACITY_LOGS, ZERO_CAPACITY_RESULT, acceptBounceLines, acceptContractLines, acceptedRawById, acceptedViaLabel, adoptionSignal, anchorAbsentWhy, answerBounceLines, applyMutationAnchor, applyNarration, applyPrescriptionLines, askUserLines, assertDriverIdRefusal, assertSeats, b127GatePaths, b127GroupCommand, b127InvokeGate, b127Lines, b127PidAlive, b127Spy, b318Builders, b318GatedPlan, b318Options, b318ReviewGrants, b318SiteA, b318SiteB, b376Build, b376DiskProofIo, b376ProofIo, b376Review, b376StageStack, b384Io, b44AssertLeadlessGate, b44GateFixIo, b44GatePlan, b44MidRunRepairIo, baselineGateDefect, bindMutationAnchor, bindMutationCorrection, bindMutationDeclarations, bothExhaustionPointsScenario, bounceDetail, bounceSeatOf, bounceTargetOf, buildEnv, carriedPrLines, carriedPreambleLines, carriedResolution, carriedSilenceDefect, carveRun, checkAnchors, checkEnv, checkFailureLine, chmodSync, classCollisionIo, closeoutIo, collapseStages, commitIntent, composeCommitMessage, composePrBody, convergeIo, convergeRun, correctedMutations, crashIo, crashRun, dAdjEnv, dApplyCommand, dAutoRows, dBuilders, dDecisionBrief, dGitApplies, dLeads, dOffers, dPanelOutcomes, dPartnerEnv, dPatchWrite, dPlanEnv, dRemintRows, dReviewEnv, deliberateRun, directSlotRun, dispositionIo, dispositionOf, dispositionPanelIo, dispositionPlan, divergeThenExhaustPlanScenario, divergenceConsultLines, divergentCollisionIo, divergentPlanScenario, driveJournalSites, drivePayloadElements, driveTask, enforcementPreamble, envelopeDefect, envelopeFieldsPresent, escalationStageRows, exhaustionAcceptIo, existsSync, fakeIo, fakePool, finalizeCorrections, findingIdDefect, gateReapCommand, gateReapFresh, gateReapOriginal, gateReapSweepCommand, gateReapVerdict, growthLines, growthRecord, guardedWrite, hardenCommand, hardenWitnessCommand, hardeningBounceLines, hardeningBriefLines, hardeningDebt, hardeningOf, issueTrailers, join, journalRowsSinceRunStart, laneCommandInputs, laneCommandShape, laneFence, laneFenceHits, laneInputExtension, laneProbeCommand, laneProbeKinds, leadEnv, legacyPanelProof, legacyReviewerExemptions, lineageFromJournal, matchAnswers, mkdirSync, mutationChangesTokens, nameVerdict, narrateRecord, narrationDefect, narrationFromResponse, narrationIsRawJson, narrationPrompt, narrationStageDefect, narratorApiRoot, narratorCommand, narratorConfig, narratorIo, narratorModelId, narratorModelsCommand, normaliseJournalTimes, observeTurnCensus, operationalRow, osCpus, outOfScopeFiles, panelSeats, parseDirectedBrief, parseGateSummary, parseQuestions, parseSuiteCounts, partitionShifts, patchTargets, persistentDivergenceScenario, phaseTrace, planAcceptContractLines, planCheckAcceptIo, planCheckFindings, planCheckFindingsFromText, planConvergence, planEnv, planRevisionRun, planRoundCap, planScopeVerdict, planThenReviewIo, postCommitCrashRun, prAnomalies, predecessorFindingsClosed, protectedHits, protectedPlanEnv, protectedReseatRefusal, publicationIo, questionConsultLines, readFileSync, readdirSync, reconEnv, recordFacts, recordRow, refsFromCommitMessage, refuseWait, regrantVerdict, relativizeCommand, replayResumeStages, resolveProtectedPaths, resolveTurnCeilings, resolveValidationLane, resolveWaits, resumeDoneRows, resumeGreen, resumeKeys, resumeRed, resumeStageRows, reviewConvergeIo, reviewConvergeRun, reviewEnv, reviewFindings, reviewOutcome, reviewShapeDefect, rmSync, roundCursor, runChild, runCmd, runCmdFixture, runPublished, s843Bullets, s843Ctx, s843Io, s843PathsIn, s843PlanEnv, s843Reseat, s843Rows, scopeBounceBrief, scopeMatcher, scopeRefusal, scopedPath, scratchDir, shapeDefect, shellArg, shellWords, slotAdmission, slotCtx, slotFactory, sourcesDefect, spawnSync, stageEnabled, stageShape, staleVerdictLines, suiteRefusalEnv, throwAutoFixWrites, throwingWaitRun, tmpdir, traceLabels, traceSubsequence, treeDigest, triageEnv, trimPathToken, turnCeilingBreached, turnCeilingsRecord, twoRoundReviewIo, undeclaredStage, validateAcceptDecision, validateCarve, validateHardened, validateMutationCorrections, validateMutations, validatePlanResiduals, validateScopeEntries, validationLaneBounceLines, validationLaneWhy, validationPlan, validationProbeOutput, validationProbeRun, validationRows, verdictFindingsDefect, waitsCtx, waitsRecord, withPhaseSlot, writeFileSync,
}
