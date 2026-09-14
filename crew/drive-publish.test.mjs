// Split from crew/drive.test.mjs (#918 follow-up): one subject per file so a
// lane fencing one driver concern no longer locks every driver test.
// Shared fixtures, and the ledger sandbox side effect, live in ./drive-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import {
  COMMIT_TRAILER, CTX, HONEST_NARRATION, NARRATION_HEADING, NARRATION_RECORD, NARRATION_REFUSALS, NARRATION_REFUSAL_NAMES, NARRATION_STAGE_VOCABULARY, NARRATOR_REGISTER, PUBLISH_REFUSALS, PUBLISH_REFUSAL_NAMES, RUN_START_EVENT, TD, VARIANTS, applyNarration, bounceDetail, bounceSeatOf, buildEnv, commitIntent, composeCommitMessage, composePrBody, convergeRun, driveTask, existsSync, fakeIo, issueTrailers, join, journalRowsSinceRunStart, narrateRecord, narrationDefect, narrationFromResponse, narrationIsRawJson, narrationPrompt, narrationStageDefect, narratorApiRoot, narratorCommand, narratorConfig, narratorIo, narratorModelId, narratorModelsCommand, planEnv, prAnomalies, publicationIo, readFileSync, readdirSync, refsFromCommitMessage, reviewEnv, scratchDir, shellArg, spawnSync, writeFileSync,
} from './drive-fixtures.mjs'
import { anchorConflictMechanical, canonicalAnchorManifest, canonicalCitationDoc, lineNumberOnlyAnchorResolution, promptMeasurementDefect, rebaseConflictRoute, resumeTask, resumeWorktreeSha256 } from './drive.mjs'
import { git, gitResult } from '../test/helpers.mjs'

const REVIEW_ENVELOPE_SCHEMA = `{
  "assignment_id": "string (exact current dispatch id)",
  "run_id": "string (exact current run id)",
  "role": "reviewer",
  "status": "done",
  "summary": "string (non-empty)",
  "artifacts": ["absolute task-directory path", "..."],
  "details": {
    "base": "string (non-empty)",
    "head": "string (non-empty)",
    "outcome": "findings | no-findings",
    "findings": [
      {
        "id": "string matching ^[A-Za-z0-9_-]{1,64}$",
        "severity": "must-fix | should-fix | consider",
        "location": "string (non-empty)",
        "summary": "string (non-empty)",
        "evidence": "string (non-empty)",
        "disposition": "auto-fix | ask-user | no-op"
      }
    ]
  }
}`
const REVIEW_ENVELOPE_INTENT = ['Envelope schema proposed for ADR', '', '```json', REVIEW_ENVELOPE_SCHEMA, '```'].join('\n')

test('H1 PR body preserves the proposed review envelope schema verbatim', () => {
  const body = composePrBody({ intent: REVIEW_ENVELOPE_INTENT })
  assert.equal(body.slice(0, REVIEW_ENVELOPE_INTENT.length), REVIEW_ENVELOPE_INTENT)
  assert.equal(body.includes(REVIEW_ENVELOPE_SCHEMA), true)
})

function resumeCheckpointFixture(overrides = {}) {
  const file = { path: 'a.mjs', state: 'present', bytes: 'file:-:' + 'a'.repeat(64) }
  const returns = {
    planner: { status: 'done', role: 'planner', artifacts: [], details: {} },
    builder: { status: 'done', role: 'builder', artifacts: [], details: {} },
    reviewer: { status: 'done', role: 'reviewer', artifacts: [], details: {} },
  }
  const base = {
    version: 1, kind: 'rebase', frozen_where: 'rebase', head_oid: 'pre1111',
    tree: { index_oid: 'tree1111', files: [file], worktree_sha256: resumeWorktreeSha256([file]) },
    accepted_scope: ['a.mjs'], returns,
    decision: { accepted_via: 'review pass', verdict: 'pass', residuals: [], carried_findings: [], accept_findings: [], accept_decision: { where: 'review', outcome: 'accepted', residuals: [] }, panel_contributors: ['reviewer'] },
    commit: { oid: 'pre1111', pending: false, files: ['a.mjs'], message: 'feat: resume\n\nCloses #42', subject: 'feat: resume' },
    proof: { gate_cmd: 'gate-cmd', gate_path: `${TD}/gate.mjs`, summary: { total: 3, failed: 0, errored: 0 }, discrimination: 'proven', generation: 1, repairs: 0 },
    suite: { cmd: 'suite-cmd', warm: null, cold: null }, publish: { branch: null, base: 'main' }, prior_stages: ['review:r1', 'commit', 'rebase'],
  }
  return { ...base, ...overrides, tree: { ...base.tree, ...(overrides.tree || {}) }, decision: { ...base.decision, ...(overrides.decision || {}) }, commit: { ...base.commit, ...(overrides.commit || {}) }, proof: { ...base.proof, ...(overrides.proof || {}) }, suite: { ...base.suite, ...(overrides.suite || {}) }, publish: { ...base.publish, ...(overrides.publish || {}) } }
}

test('A1 resume retries frozen rebase without restarting plan or build and reaches done', () => {
  const checkpoint = resumeCheckpointFixture()
  const io = fakeIo({ runs: {
    'git fetch origin main': { ok: true, output: '' },
    'git rev-parse origin/main': { ok: true, output: 'base1111\n' },
    'git merge-base HEAD origin/main': { ok: true, output: 'base1111\n' },
    'git rev-parse HEAD': { ok: true, output: 'pre1111\n' },
    'suite-cmd': { ok: true, output: '# pass 1\\n# fail 0\\n' },
  } })
  const result = resumeTask({ ...CTX, task: 'resume-rebase', publish: { branch: null }, files_in_scope: ['a.mjs'] }, io, checkpoint)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.length, 0)
  assert.equal(io.calls.runCold.length, 1)
})

test('RVR1-2 gate resume preserves typed gate escalation when pending commit fails', () => {
  const gateCheckpoint = (commit) => resumeCheckpointFixture({
    kind: 'gate', frozen_where: 'gate', publish: { branch: null, base: null }, prior_stages: ['review:r1', 'gate'],
    commit: { oid: null, pending: true, files: ['a.mjs'], message: 'feat: pending resume', subject: 'feat: pending resume' },
    ...commit,
  })
  const assertTypedGate = (checkpoint, commit, why) => {
    const io = fakeIo()
    io.commit = commit
    const result = resumeTask({ ...CTX, task: 'resume-commit-fail', publish: { branch: null }, files_in_scope: ['a.mjs'] }, io, checkpoint)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'gate')
    assert.match(result.details.escalation.why, why)
    assert.equal(result.details.resume_checkpoint, checkpoint)
    assert.equal(io.calls.assign.length, 0)
  }
  assertTypedGate(gateCheckpoint(), () => { throw new Error('pre-commit hook rejected') }, /resumed commit failed: pre-commit hook rejected/)
  assertTypedGate(gateCheckpoint(), () => '', /resumed commit returned no readable oid/)
  assertTypedGate(gateCheckpoint({ commit: { oid: null, pending: false, files: ['a.mjs'], message: 'feat: pending resume', subject: 'feat: pending resume' } }), () => { throw new Error('must not commit') }, /resumed path has no committed oid/)
  assertTypedGate({ version: 0 }, () => { throw new Error('must not commit') }, /resume checkpoint is unusable/)
})

test('E1 resume remeasures gate before commit suite and publish', () => {
  const checkpoint = resumeCheckpointFixture({ kind: 'publish', frozen_where: 'publish', publish: { branch: 'feature/ship', base: 'main' } })
  const io = publicationIo()
  const result = resumeTask({ ...CTX, task: 'resume-publish', publish: { branch: 'feature/ship' }, files_in_scope: ['a.mjs'] }, io, checkpoint)
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign?.length || 0, 0)
  assert.ok(io.calls.run.some((command) => command.includes('gate-cmd')), 'resume must invoke the canonical gate')
  const gateIndex = io.calls.order.findIndex((entry) => entry.includes('gate-cmd'))
  const suiteIndex = io.calls.order.findIndex((entry) => entry === 'run:suite-cmd')
  const coldIndex = io.calls.order.indexOf('runCold')
  const pushIndex = io.calls.order.findIndex((entry) => entry.includes('git push -u origin'))
  assert.ok(gateIndex >= 0 && gateIndex < suiteIndex && suiteIndex < coldIndex && coldIndex < pushIndex)
  assert.match(io.calls.writes[`${TD}/pr-body.md`], /Closes #42/)
})

function installParentProbe(io, parent = { ok: true, output: 'base1111\n' }) {
  const baseRun = io.run
  io.run = function (command) {
    if (String(command) === 'git rev-parse HEAD^') {
      baseRun.call(this, command)
      return typeof parent === 'function' ? parent(this.state, command) : parent
    }
    return baseRun.call(this, command)
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
  const io = installParentProbe(publicationIo({ ...options, branch }), options.commands?.['git rev-parse HEAD^'])
  let result
  try { result = driveTask(ctx, io) } catch (error) { return { ctx, io, error } }
  return { ctx, io, result }
}

const PROMPT_SCOPE = ['crew/roles/planner.md']
const promptPublicationOptions = (body = '') => ({
  changed: PROMPT_SCOPE,
  envelopes: {
    'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: PROMPT_SCOPE } }),
    'builder:1': buildEnv({ details: { files_changed: PROMPT_SCOPE, commit_message: body } }),
    'reviewer:1': reviewEnv('pass'),
  },
})
function runPromptPublished(body = '', options = {}) {
  const defaults = promptPublicationOptions(body)
  return runPublished({
    ...options, ...defaults,
    ...(options.changed ? { changed: options.changed } : {}),
    envelopes: { ...defaults.envelopes, ...(options.envelopes || {}) },
  })
}

const REBASE_PARENT = 'base1111'
const REBASE_RED = 'red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}'
const REBASE_GREEN = 'green\nGATE-SUMMARY {"total":3,"failed":0,"errored":0}'
const REBASE_MUTATIONS = [
  { check: 'M1', file: 'a.mjs', find: 'TASK-A', replace: 'MUT-A' },
  { check: 'M2', file: 'a.test.mjs', find: 'TASK-B', replace: 'MUT-B' },
]

function rebaseIo(options = {}) {
  const moved = options.moved !== false
  const postHead = options.postHead || 'rebased3333'
  const parent = options.parent === undefined ? REBASE_PARENT : options.parent
  const mutations = options.mutations || REBASE_MUTATIONS
  const changed = options.changed || ['a.mjs', 'a.test.mjs']
  const scope = options.scope || changed
  const io = publicationIo({
    changed,
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd', mutations, files_in_scope: scope, commit_subject: 'feat: rebase proof' } }),
      'builder:1': options.builderEnv || buildEnv(), 'reviewer:1': reviewEnv('pass'),
    },
    commands: {
      'git rev-parse origin/main': { ok: true, output: `${REBASE_PARENT}\n` },
      // Stateful: a real rebase MOVES the merge base. Before it, a moved base shares an
      // older ancestor (that gap is what `rebased` is derived from); after it, the base
      // IS the merge base. A static value here is what let `HEAD^` pass as the parent
      // check while only ever being correct for a one-commit lane.
      'git merge-base HEAD origin/main': (s) => ({
        ok: true,
        output: `${moved && s.head !== postHead ? 'older000' : REBASE_PARENT}\n`,
      }),
      // A caller's overrides win, so a case can inject a wrong POST-rebase merge base.
      ...(options.commands || {}),
    },
  })
  io.state.phase = 'initial'
  io.state.commitCount = 0
  io.state.resetCommand = null
  io.state.rebaseHead = postHead
  const taskA = `${CTX.checkout}/a.mjs`
  const taskB = `${CTX.checkout}/a.test.mjs`
  const initialBytes = { [taskA]: 'TASK-A\n', [taskB]: 'TASK-B\n' }
  const postRebaseBytes = { [taskA]: 'POST-REBASE TASK-A\n', [taskB]: 'POST-REBASE TASK-B\n' }
  io.state.worktreeBytes = { ...initialBytes }
  io.state.indexBytes = { ...initialBytes }
  io.state.recoveryCommit = options.recoveryCommit || 'recovery4444'
  io.state.recommit = options.recommit || 'recommitted5555'
  io.state.runCleanCalls = []
  io.calls.runClean = io.state.runCleanCalls
  const parentProbe = options.parentResult === undefined
    ? (typeof parent === 'object' ? () => parent : () => ({ ok: true, output: `${parent}\n` }))
    : options.parentResult
  installParentProbe(io, parentProbe)
  const baseRun = io.run
  let phaseGateRuns = 0
  const mutationRed = (index) => {
    const mutation = mutations[Math.max(0, Math.min(index, mutations.length - 1))]
    return { ok: false, output: `FAIL ${mutation?.check || 'M1'}: caught\n${REBASE_RED}` }
  }
  io.run = function (command) {
    const text = String(command)
    if (text === 'git rebase origin/main') {
      const result = baseRun.call(this, command)
      this.state.phase = 'rebased'
      this.state.head = postHead
      this.state.worktreeBytes = { ...postRebaseBytes }
      this.state.indexBytes = { ...postRebaseBytes }
      phaseGateRuns = 0
      return result
    }
    if (text.startsWith('git reset --')) {
      baseRun.call(this, command)
      this.state.resetCommand = text
      if (options.reset === 'throw') throw new Error('reset denied')
      if (options.reset === 'return') return { ok: false, output: 'reset denied' }
      if (text.includes('--hard')) {
        this.state.phase = 'hard-reset'
        this.state.indexBytes = {}
        this.state.worktreeBytes = {}
        return { ok: true, output: '' }
      }
      this.state.phase = 'reset'
      this.state.head = REBASE_PARENT
      phaseGateRuns = 0
      return { ok: true, output: '' }
    }
    if (text.includes('gate-cmd')) {
      baseRun.call(this, command)
      phaseGateRuns += 1
      if (this.state.phase === 'initial') {
        if (phaseGateRuns === 1) return { ok: false, output: REBASE_RED }
        if (phaseGateRuns === 2) return { ok: true, output: REBASE_GREEN }
        return mutationRed(phaseGateRuns - 3)
      }
      if (this.state.phase === 'reset') {
        if (phaseGateRuns === 1) return options.postProof === 'red' ? { ok: false, output: REBASE_RED } : { ok: true, output: REBASE_GREEN }
        return mutationRed(phaseGateRuns - 2)
      }
      if (this.state.phase === 'rebased') return options.postProof === 'red' ? { ok: false, output: REBASE_RED } : { ok: true, output: REBASE_GREEN }
    }
    return baseRun.call(this, command)
  }
  const baseRead = io.readFile
  io.readFile = function (path) {
    if (Object.prototype.hasOwnProperty.call(this.state.worktreeBytes, path)) return this.state.worktreeBytes[path]
    return baseRead.call(this, path)
  }
  const baseWrite = io.writeFile
  io.writeFile = function (path, content) {
    if (Object.prototype.hasOwnProperty.call(this.state.worktreeBytes, path)) {
      this.state.worktreeBytes[path] = content
      this.calls.writes[path] = content
      this.calls.order.push(`write:${path}`)
      return
    }
    return baseWrite.call(this, path, content)
  }
  io.commit = function (files, message) {
    this.state.commitCount += 1
    this.calls.order.push('commit')
    this.calls.commits.push({ files, message })
    if (this.state.commitCount === 1) {
      this.state.head = this.state.recoveryCommit
      return this.state.recoveryCommit
    }
    if (options.recommit === 'throw') throw new Error('recommit denied')
    if (options.recommit === 'blank') return ''
    this.state.head = this.state.recommit
    return this.state.recommit
  }
  io.runClean = function (command) {
    this.state.runCleanCalls.push({ command, phase: this.state.phase, index: { ...this.state.indexBytes }, worktree: { ...this.state.worktreeBytes } })
    if (options.postProof === 'unproven' && this.state.phase === 'reset') return { ok: true, output: REBASE_GREEN }
    if (this.state.phase === 'rebased') return { ok: true, output: REBASE_GREEN }
    return { ok: false, output: REBASE_RED }
  }
  const baseLog = io.log
  io.log = function (row) {
    if (options.proofThrow && this.state.phase === 'reset' && row?.gate_discrimination !== undefined) throw new Error('post-rebase proof exploded')
    if (Array.isArray(row?.gate_check_discriminations) && row.gate_check_discriminations.some((entry) => entry?.proof === 'fresh')) this.calls.order.push('fresh-proof-row')
    if (row?.gate_proof_parent) this.calls.order.push('proof-parent-row')
    return baseLog.call(this, row)
  }
  return io
}

function runRebase(options = {}) {
  const io = rebaseIo(options)
  const result = driveTask({ ...CTX, publish: { branch: 'feature/ship' } }, io)
  return { io, result }
}

const ANCHOR_MANIFEST = 'crew/roles/anchors.json'
const ANCHOR_SKILL = 'crew/roles/SKILL.md'
const ANCHOR_SOURCE = 'crew/source.mjs'
const anchorManifest = (entries) => `${JSON.stringify(entries, null, 2)}\n`
const anchorHunk = (paths) => paths.map((path) => [
  `diff --cc ${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  '-base-side',
  '+lane-side',
].join('\n')).join('\n') + '\n'

// Publication-only rebase seam. The shared publicationIo remains unchanged: this local
// adapter models the index stages and carrier filesystem needed by A1-H1.
function anchorPublicationIo({ specs = [], scope, limits = {}, gate = null, envelopes = {}, carriers = {}, tracked, ordinary = [], ignored = [], reset = null } = {}) {
  const first = specs[0] || {
    paths: [ANCHOR_MANIFEST],
    stage2: { [ANCHOR_MANIFEST]: anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'anchor-value' }) },
    stage3: { [ANCHOR_MANIFEST]: anchorManifest({ [`${ANCHOR_SOURCE}:12`]: 'anchor-value' }) },
    hunk: anchorHunk([ANCHOR_MANIFEST]),
  }
  const effectiveScope = scope || [...new Set(specs.flatMap((spec) => spec?.paths || []))]
  const allCarriers = { ...carriers }
  for (const spec of specs) for (const path of spec?.paths || []) {
    if (path.endsWith('/anchors.json') && allCarriers[path] === undefined) allCarriers[path] = spec.stage2?.[path] || ''
  }
  const baseTracked = tracked || Object.keys(allCarriers)
  const initialBytes = { ...allCarriers }
  const promptMeasurement = 'unmeasured — n insufficient; reason: anchor publication fixture; re-measure after 1 seats.'
  const anchorEnvelopes = {
    'planner:1': planEnv({ details: { ...planEnv().details, files_in_scope: effectiveScope, ...(gate?.details || {}) } }),
    'builder:1': buildEnv({ details: { files_changed: effectiveScope, commit_message: promptMeasurement } }),
    'reviewer:1': reviewEnv('pass'), ...envelopes,
  }
  const publicationEnvelopes = Object.fromEntries(Object.entries(anchorEnvelopes).map(([key, value]) => [
    key,
    key.startsWith('builder:') && value && typeof value === 'object'
      ? { ...value, details: { ...(value.details || {}), files_changed: value.details?.files_changed || effectiveScope, commit_message: promptMeasurement } }
      : value,
  ]))
  const io = publicationIo({ changed: effectiveScope, envelopes: publicationEnvelopes })
  io.calls.assign = []
  const baseAssign = io.assign
  io.assign = function (spec) {
    const assigned = baseAssign.call(this, spec)
    this.calls.assign.push({ ...spec, id: assigned.id, returnPath: assigned.returnPath })
    return assigned
  }
  io.state.rebaseCount = 0
  io.state.abortCount = 0
  io.state.resetCommand = null
  io.state.resolverCalls = []
  io.state.addCommands = []
  io.state.continueCount = 0
  io.state.checkoutBytes = null
  const absoluteBytes = (bytes) => Object.fromEntries(Object.entries(bytes).map(([path, value]) => [`${CTX.checkout}/${path}`, value]))
  io.state.worktreeBytes = absoluteBytes(initialBytes)
  io.state.indexBytes = absoluteBytes(initialBytes)
  io.state.initialBytes = absoluteBytes(initialBytes)
  io.state.currentSpec = null
  const baseRun = io.run
  const response = (value, fallback = { ok: true, output: '' }) => typeof value === 'function' ? value(io.state) : (value === undefined ? fallback : value)
  const pathsFromStageCommand = (text) => {
    const match = text.match(/^git show ':(2|3):(.+)'$/)
    return match ? { stage: Number(match[1]), path: match[2] } : null
  }
  io.run = function (command) {
    const text = String(command)
    const record = (value) => { baseRun.call(this, command); return value }
    if (text === 'git rebase origin/main') {
      baseRun.call(this, command)
      const spec = specs[this.state.rebaseCount] || null
      this.state.rebaseCount += 1
      this.state.currentSpec = spec
      if (spec) {
        this.state.phase = 'conflicted'
        this.state.head = `mid${this.state.rebaseCount}3333`
        this.state.worktreeBytes = { ...absoluteBytes(initialBytes), ...absoluteBytes(spec.worktree || {}) }
        this.state.indexBytes = { ...this.state.worktreeBytes }
        return { ok: false, output: spec.rebaseOutput || 'rebase failed' }
      }
      this.state.phase = 'rebased'
      this.state.head = this.state.post
      return { ok: true, output: '' }
    }
    if (text === 'git diff --name-only --diff-filter=U') {
      const paths = this.state.phase === 'initial' ? [] : (this.state.currentSpec?.paths || [])
      return record({ ok: true, output: paths.join('\n') + (paths.length ? '\n' : '') })
    }
    const stage = pathsFromStageCommand(text)
    if (stage) {
      const value = this.state.currentSpec?.[stage.stage === 2 ? 'stage2' : 'stage3']?.[stage.path]
      return record(typeof value === 'string' ? { ok: true, output: value } : { ok: false, output: '' })
    }
    if (text.startsWith('git diff --cc -- ')) return record({ ok: true, output: this.state.currentSpec?.hunk || '' })
    if (text.startsWith('git ls-files -z --cached --')) return record({ ok: true, output: [...new Set(baseTracked)].join('\0') + (baseTracked.length ? '\0' : '') })
    if (text.startsWith('git ls-files -z --others --ignored --')) return record({ ok: true, output: ignored.join('\0') + (ignored.length ? '\0' : '') })
    if (text.startsWith('git ls-files -z --others --exclude-standard --')) return record({ ok: true, output: ordinary.join('\0') + (ordinary.length ? '\0' : '') })
    if (text.startsWith('git checkout --ours -- ')) {
      const spec = this.state.currentSpec || first
      this.state.checkoutBytes = {}
      for (const path of spec.paths || []) {
        const bytes = spec.stage2?.[path]
        if (typeof bytes === 'string') { this.state.worktreeBytes[`${CTX.checkout}/${path}`] = bytes; this.state.checkoutBytes[path] = bytes }
      }
      return record(response(spec.checkoutResult))
    }
    if (text.startsWith('node skills/qa-test-writing/anchor-pin.mjs --repair-all ')) {
      this.state.resolverCalls.push(text)
      const spec = this.state.currentSpec || first
      const result = record(response(spec.resolverResult))
      if (typeof spec.resolver === 'function') spec.resolver(this.state)
      return result
    }
    if (text.startsWith('git add -- ')) {
      this.state.addCommands.push(text)
      return record(response(this.state.currentSpec?.addResult))
    }
    if (text === 'git -c core.editor=true rebase --continue') {
      this.state.continueCount += 1
      const result = record(response(this.state.currentSpec?.continueResult))
      if (result?.ok) { this.state.phase = 'rebased'; this.state.head = this.state.post }
      return result
    }
    if (text === 'git rebase --abort') {
      this.state.abortCount += 1
      const result = record(response(this.state.currentSpec?.abortResult))
      if (result?.ok) {
        this.state.phase = 'initial'; this.state.head = this.state.pre
        this.state.worktreeBytes = { ...this.state.initialBytes }
        this.state.indexBytes = { ...this.state.initialBytes }
      }
      return result
    }
    if (text.startsWith('git reset --soft ')) {
      this.state.resetCommand = text
      const result = record(response(reset || this.state.currentSpec?.resetResult))
      if (result?.ok) { this.state.phase = 'reset'; this.state.head = text.slice('git reset --soft '.length) }
      return result
    }
    return baseRun.call(this, command)
  }
  const baseRead = io.readFile
  io.readFile = function (path) {
    if (Object.prototype.hasOwnProperty.call(this.state.worktreeBytes, path)) return this.state.worktreeBytes[path]
    return baseRead.call(this, path)
  }
  return io
}

function runAnchorPublication(options = {}) {
  const io = anchorPublicationIo(options)
  const ctx = {
    ...CTX,
    limits: options.limits || {},
    ...(options.ctx || {}),
    publish: { branch: 'feature/ship' },
  }
  let result
  try { result = driveTask(ctx, io) } catch (error) { return { io, ctx, error } }
  return { io, ctx, result }
}

function realCleanAbortFacts() {
  const checkout = scratchDir('b665-restoreproof-')
  git(checkout, 'init', '--quiet')
  git(checkout, 'config', 'user.email', 'crew@example.test')
  git(checkout, 'config', 'user.name', 'Crew Test')
  writeFileSync(join(checkout, 'a.mjs'), 'export const lane = true\n')
  git(checkout, 'add', 'a.mjs')
  git(checkout, 'commit', '--quiet', '-m', 'lane')
  git(checkout, 'branch', '-M', 'feature/ship')
  const head = git(checkout, 'rev-parse', 'HEAD').trim()
  const branch = git(checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD').trim()
  const rawPaths = {
    'rebase-merge': git(checkout, 'rev-parse', '--git-path', 'rebase-merge').trim(),
    'rebase-apply': git(checkout, 'rev-parse', '--git-path', 'rebase-apply').trim(),
  }
  const paths = Object.fromEntries(Object.entries(rawPaths).map(([name, path]) => [
    name, path.startsWith('/') ? path : join(checkout, path),
  ]))
  for (const path of Object.values(paths)) {
    assert.equal(existsSync(path), false)
    assert.doesNotThrow(() => readdirSync(join(path, '..')))
  }
  const abort = gitResult(checkout, 'rebase', '--abort')
  assert.equal(abort.status, 128)
  assert.equal(git(checkout, 'rev-parse', 'HEAD').trim(), head)
  assert.equal(git(checkout, 'status', '--porcelain', '-uall'), '')
  return { checkout, head, branch, paths, abortStatus: abort.status, status: '' }
}

function conflictCommands({ abortResult = { ok: true, output: '' }, restoredHead = null, statusResult = { ok: true, output: '' }, unmergedAfterAbort = '', headResult = null, unmergedResult = null } = {}) {
  let attempts = 0
  return {
    'git rebase origin/main': (state) => {
      attempts += 1
      if (attempts === 1) {
        state.head = 'mid3333'
        state.phase = 'conflicted'
        return { ok: false, output: 'rebase failed' }
      }
      state.head = state.post
      state.phase = 'rebased'
      return { ok: true, output: '' }
    },
    'git diff --name-only --diff-filter=U': (state) => {
      const result = state.restored && unmergedResult !== null
        ? (typeof unmergedResult === 'function' ? unmergedResult(state) : unmergedResult)
        : { ok: true, output: state.restored ? unmergedAfterAbort : 'a.mjs\n' }
      state.lastUnmergedProbe = result
      return result
    },
    "git show ':2:a.mjs'": { ok: true, output: 'base\n' },
    "git show ':3:a.mjs'": { ok: true, output: 'lane\n' },
    "git diff --cc -- 'a.mjs'": { ok: true, output: 'diff --cc a.mjs\n' },
    'git rebase --abort': (state) => {
      state.restored = true
      state.head = state.pre
      const result = typeof abortResult === 'function' ? abortResult(state) : abortResult
      state.abortObserved = result
      return result
    },
    'git rev-parse HEAD': (state) => {
      if (headResult !== null) {
        const result = typeof headResult === 'function' ? headResult(state) : headResult
        state.lastHeadProbe = result?.ok === true && typeof result.output === 'string' ? result.output.trim() : null
        return result
      }
      const output = restoredHead || state.head
      state.lastHeadProbe = output
      return { ok: true, output: `${output}\n` }
    },
    'git status --porcelain -uall': (state) => {
      const result = typeof statusResult === 'function' ? statusResult(state) : statusResult
      state.lastStatusProbe = result
      return result
    },
  }
}

function recordedRebaseStateRun(facts) {
  return runPublished({
    branch: facts.branch,
    initialHead: facts.head,
    ctx: { limits: { build_rounds: 1 } },
    gitPaths: facts.paths,
    rebasePathProbes: {
      'rebase-merge': { ok: true, output: '' },
      'rebase-apply': { ok: true, output: '' },
    },
    commands: conflictCommands({ abortResult: { ok: false, status: facts.abortStatus, output: 'no rebase in progress' }, restoredHead: facts.head }),
  })
}

function assertRecordedRebaseStateFailures(run, facts) {
  const commands = Object.entries(facts.paths).map(([name, path]) => {
    const command = run.io.calls.run.find((entry) => entry.startsWith(`${shellArg(process.execPath)} -e `)
      && entry.endsWith(` ${shellArg(path)}`))
    assert.ok(command, `a recorded command must target ${name}`)
    return { name, path, command }
  })
  const replay = (command) => spawnSync('/bin/sh', ['-c', command], { cwd: facts.checkout, encoding: 'utf8' })
  for (const { name, path, command } of commands) {
    const absent = replay(command)
    assert.equal(absent.status, 0, `${name} absence must prove an absent path with a readable parent`)
    assert.equal(absent.stdout, '', `${name} absence must print no stdout`)
    assert.equal(absent.stderr, '', `${name} absence must print no stderr`)

    try {
      mkdirSync(path, { recursive: true })
      const present = replay(command)
      assert.ok(Number.isInteger(present.status) && present.status !== 0, `${name} directory must fail the recorded probe`)
    } finally {
      rmSync(path, { recursive: true, force: true })
    }

    try {
      symlinkSync(join(facts.checkout, 'missing-target'), path)
      const dangling = replay(command)
      assert.ok(Number.isInteger(dangling.status) && dangling.status !== 0, `${name} dangling symlink must fail the recorded probe`)
    } finally {
      rmSync(path, { force: true })
    }

    const parent = join(path, '..')
    const backup = join(facts.checkout, `.b665-rebase-parent-backup-${name}`)
    let moved = false
    rmSync(backup, { recursive: true, force: true })
    try {
      renameSync(parent, backup)
      moved = true
      writeFileSync(parent, 'not a directory\\n')
      const nonDirectoryParent = replay(command)
      assert.ok(Number.isInteger(nonDirectoryParent.status) && nonDirectoryParent.status !== 0, `${name} non-directory parent must fail the recorded probe`)
    } finally {
      if (moved) {
        rmSync(parent, { recursive: true, force: true })
        renameSync(backup, parent)
      }
    }

    if (process.getuid?.() === 0) {
      // Root bypasses directory permission bits; this unreadable-parent witness is unmeasured.
      console.log(`F1 ${name} unreadable-parent witness was not measured on this run: uid 0 bypasses directory permission bits`)
    } else {
      const originalMode = statSync(parent).mode
      try {
        assert.equal(existsSync(path), false, `${name} target must stay absent for the execute-only parent witness`)
        chmodSync(parent, 0o111)
        const executeOnlyParent = replay(command)
        assert.ok(Number.isInteger(executeOnlyParent.status) && executeOnlyParent.status !== 0, `${name} execute-only parent must fail the recorded probe`)
      } finally {
        chmodSync(parent, originalMode)
      }
    }
    assert.doesNotThrow(() => readdirSync(parent))
  }
}

function mechanicalProofRun() {
  const stage2 = anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'anchor-value' })
  const stage3 = anchorManifest({ [`${ANCHOR_SOURCE}:12`]: 'anchor-value' })
  const io = rebaseIo({
    changed: ['a.mjs', 'a.test.mjs', ANCHOR_MANIFEST], scope: ['a.mjs', 'a.test.mjs', ANCHOR_MANIFEST],
    builderEnv: buildEnv({ details: {
      files_changed: ['a.mjs', 'a.test.mjs', ANCHOR_MANIFEST],
      commit_message: 'unmeasured — n insufficient; reason: mechanical anchor fixture; re-measure after 1 seats.',
    } }),
  })
  const anchorPath = `${CTX.checkout}/${ANCHOR_MANIFEST}`
  io.state.worktreeBytes[anchorPath] = stage3
  io.state.indexBytes[anchorPath] = stage3
  io.state.resolverCalls = []
  io.state.addCommands = []
  io.state.continueCount = 0
  let conflicted = false
  const baseRun = io.run
  io.run = function (command) {
    const text = String(command)
    const record = (value) => { baseRun.call(this, command); return value }
    if (text === 'git diff --name-only --diff-filter=U') return record({ ok: true, output: conflicted ? `${ANCHOR_MANIFEST}\n` : '' })
    const stageMatch = text.match(/^git show ':(2|3):(.+)'$/)
    if (stageMatch && stageMatch[2] === ANCHOR_MANIFEST) return record({ ok: true, output: stageMatch[1] === '2' ? stage2 : stage3 })
    if (text.startsWith('git diff --cc -- ')) return record({ ok: true, output: anchorHunk([ANCHOR_MANIFEST]) })
    if (text.startsWith('git ls-files -z --cached --')) return record({ ok: true, output: `${ANCHOR_MANIFEST}\0` })
    if (text.startsWith('git ls-files -z --others --')) return record({ ok: true, output: '' })
    if (text.startsWith('git checkout --ours -- ')) {
      this.state.checkoutBytes = stage2
      this.state.worktreeBytes[anchorPath] = stage2
      return record({ ok: true, output: '' })
    }
    if (text.startsWith('node skills/qa-test-writing/anchor-pin.mjs --repair-all ')) {
      this.state.resolverCalls.push(text)
      this.state.worktreeBytes[anchorPath] = stage2
      return record({ ok: true, output: '' })
    }
    if (text.startsWith('git add -- ')) { this.state.addCommands.push(text); return record({ ok: true, output: '' }) }
    if (text === 'git -c core.editor=true rebase --continue') {
      this.state.continueCount += 1
      const result = record({ ok: true, output: '' })
      this.state.phase = 'rebased'; this.state.head = this.state.rebaseHead
      return result
    }
    if (text === 'git rebase origin/main' && !conflicted) {
      const result = baseRun.call(this, command)
      conflicted = true
      this.state.phase = 'rebased'
      this.state.head = this.state.rebaseHead
      this.state.worktreeBytes[anchorPath] = stage2
      this.state.indexBytes[anchorPath] = stage2
      return { ok: false, output: 'rebase failed' }
    }
    return baseRun.call(this, command)
  }
  const result = driveTask({ ...CTX, publish: { branch: 'feature/ship' } }, io)
  return { io, result }
}

test('RV1-0 anchor conflict predicates preserve duplicate keys and only line citations', () => {
  assert.equal(anchorConflictMechanical([ANCHOR_MANIFEST, 'crew/roles/references/a.md']), true)
  assert.equal(anchorConflictMechanical([ANCHOR_MANIFEST, 'crew/other.mjs']), false)
  assert.equal(anchorConflictMechanical([ANCHOR_MANIFEST, 'crew/roles/references/a.md', 'crew/roles/README.md']), false)
  assert.deepEqual(canonicalAnchorManifest('{"note:12":"keep","crew/source.jsx:20":"b","crew/source.jsx:10":"a"}'), [
    ['crew/source.jsx', 'a'], ['crew/source.jsx', 'b'], ['note:12', 'keep'],
  ])
  assert.deepEqual(canonicalAnchorManifest('{"crew/source.mjs:20":"b","crew/source.mjs:10":"a"}'), [
    ['crew/source.mjs', 'a'], ['crew/source.mjs', 'b'],
  ])
  assert.equal(canonicalCitationDoc('crew/source.mjs:20-22 value 20'), 'crew/source.mjs:<line>-<line> value 20')
  assert.equal(lineNumberOnlyAnchorResolution([{ path: ANCHOR_MANIFEST,
    stage2: anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'anchor-value' }),
    stage3: anchorManifest({ [`${ANCHOR_SOURCE}:12`]: 'anchor-value' }),
    repaired: anchorManifest({ [`${ANCHOR_SOURCE}:11`]: 'anchor-value' }),
  }]), true)
  assert.equal(rebaseConflictRoute({ mechanical: true, bounces: 99, buildRounds: 1 }), 'mechanical')
  assert.equal(rebaseConflictRoute({ mechanical: false, bounces: 0, buildRounds: 2 }), 'bounce')
  assert.equal(rebaseConflictRoute({ mechanical: false, bounces: 1, buildRounds: 2 }), 'escalate')
})

test('A1 mechanical anchor conflict resolves and continues', () => {
  const stage2 = anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'anchor-value' })
  const stage3 = anchorManifest({ [`${ANCHOR_SOURCE}:12`]: 'anchor-value' })
  const { io, result } = runAnchorPublication({ specs: [{
    paths: [ANCHOR_MANIFEST], stage2: { [ANCHOR_MANIFEST]: stage2 }, stage3: { [ANCHOR_MANIFEST]: stage3 },
    hunk: anchorHunk([ANCHOR_MANIFEST]), resolver: (state) => { state.worktreeBytes[`${CTX.checkout}/${ANCHOR_MANIFEST}`] = stage2 },
  }], scope: [ANCHOR_MANIFEST] })
  assert.equal(result.status, 'done')
  assert.equal(io.state.checkoutBytes[ANCHOR_MANIFEST], stage2)
  assert.equal(io.state.resolverCalls.length, 1)
  assert.equal(io.state.abortCount, 0)
  assert.equal(io.state.continueCount, 1)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 1)
  const stageRead = io.calls.order.findIndex((entry) => entry === `run:git show ':2:${ANCHOR_MANIFEST}'`)
  const resolverRun = io.calls.order.findIndex((entry) => entry.startsWith('run:node skills/qa-test-writing/anchor-pin.mjs --repair-all'))
  assert.ok(stageRead >= 0 && resolverRun > stageRead)
  assert.equal(io.state.addCommands.length, 1)
  assert.match(io.state.addCommands[0], /git add -- 'crew\/roles\/anchors\.json'/)
  assert.doesNotMatch(io.state.addCommands[0], /'crew\/roles'\s*$/)
})

test('B1 semantic rebase conflict bounces to builder', () => {
  const path = 'src/semantic.mjs'
  const spec = { paths: [path], stage2: { [path]: 'base\n' }, stage3: { [path]: 'lane\n' }, hunk: anchorHunk([path]) }
  const { io, result } = runAnchorPublication({ specs: [spec], scope: [path], limits: { build_rounds: 2 }, envelopes: {
    'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass'),
  } })
  assert.equal(result.status, 'done')
  const bounce = io.calls.writes[`${TD}/rebase-conflict-bounce-r1.md`]
  assert.match(bounce, new RegExp(path.replaceAll('.', '\\.') ))
  assert.match(bounce, /diff --cc src\/semantic\.mjs/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder')[1].note, 'rebase-conflict-fix')
  assert.equal(io.state.resetCommand, 'git reset --soft base1111')
  assert.equal(io.state.abortCount, 1)
})

test('C1 exhausted rebase bounce budget escalates with paths', () => {
  const firstPath = 'src/first.mjs'
  const secondPath = 'src/second.mjs'
  const make = (path) => ({ paths: [path], stage2: { [path]: 'base\n' }, stage3: { [path]: 'lane\n' }, hunk: anchorHunk([path]) })
  const second = { paths: [firstPath, secondPath], stage2: { [firstPath]: 'base-first\n', [secondPath]: 'base-second\n' }, stage3: { [firstPath]: 'lane-first\n', [secondPath]: 'lane-second\n' }, hunk: anchorHunk([firstPath, secondPath]) }
  const { io, result } = runAnchorPublication({ specs: [make(firstPath), second], scope: [firstPath, secondPath], limits: { build_rounds: 2 }, envelopes: {
    'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass'),
  } })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'rebase')
  assert.match(result.details.escalation.why, new RegExp(firstPath.replaceAll('.', '\\.') ))
  assert.match(result.details.escalation.why, new RegExp(secondPath.replaceAll('.', '\\.') ))
  assert.match(result.details.escalation.why, /limits\.build_rounds budget is exhausted/)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.equal(io.state.abortCount, 2)
  assert.equal(io.state.resetCommand, 'git reset --soft base1111')
})

const RESTORE_DIAGNOSIS = 'aborted.ok was false while HEAD, branch, cleanliness, rebase-state absence, and conflict absence proved restoration'

// #1199 — restoration is a worktree fact, not the status of a no-op abort.
test('A1 restored clean lane bypasses unproven escalation', () => {
  const facts = realCleanAbortFacts()
  const run = runPublished({
    branch: facts.branch,
    initialHead: facts.head,
    ctx: { limits: { build_rounds: 1 } },
    gitPaths: facts.paths,
    rebasePathProbes: {
      'rebase-merge': { ok: true, output: '' },
      'rebase-apply': { ok: true, output: '' },
    },
    commands: conflictCommands({
      abortResult: { ok: false, status: facts.abortStatus, output: 'no rebase in progress' },
      restoredHead: facts.head,
    }),
  })
  assert.equal(run.result.status, 'escalation')
  assert.doesNotMatch(run.result.details.escalation.why, /UNPROVEN/)
  assert.match(run.result.details.escalation.why, new RegExp(`restoration proven at HEAD ${facts.head}`))
  const capturedCommitSha = run.io.calls.commits[0].sha
  assert.equal(capturedCommitSha, facts.head)
  assert.equal(capturedCommitSha, run.io.state.lastHeadProbe)
  assert.equal(run.io.state.abortObserved.ok, false)
  assert.equal(run.io.state.abortObserved.status, 128)
  assert.equal(facts.abortStatus, 128)
  assert.equal(facts.status, '')
  assert.equal(run.io.state.lastStatusProbe.output, facts.status)
  assert.equal(run.io.state.lastUnmergedProbe.output, '')
  assert.ok(run.io.calls.run.includes('git symbolic-ref --quiet --short HEAD'))
  assert.ok(run.io.calls.run.includes('git status --porcelain -uall'))
  assert.ok(run.io.calls.run.includes('git rev-parse --git-path rebase-merge'))
  assert.ok(run.io.calls.run.includes('git rev-parse --git-path rebase-apply'))
  assert.ok(run.io.calls.run.some((command) => command.startsWith(`${shellArg(process.execPath)} -e `)))
})

test('B1 restored lane reaches conflict builder bounce', () => {
  const path = 'src/restore.mjs'
  const { io, result } = runAnchorPublication({ specs: [{
    paths: [path], stage2: { [path]: 'base\n' }, stage3: { [path]: 'lane\n' }, hunk: anchorHunk([path]),
  }], scope: [path], limits: { build_rounds: 2 }, envelopes: {
    'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass'),
  } })
  assert.equal(result.status, 'done')
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder')[1].note, 'rebase-conflict-fix')
  assert.match(io.calls.writes[`${TD}/rebase-conflict-bounce-r1.md`], /Restoration was proven/)
})

test('C1 failed restoration preserves exact unproven escalation', () => {
  const expected = 'the rebase onto origin/main failed with conflicts in a.mjs; restoration is UNPROVEN — HEAD found after abort: mid3333'
  const cases = [
    ['dirty status', { statusResult: { ok: true, output: ' M a.mjs\n' } }],
    // F1 executes filesystem states; these model their common non-ok io.run refusal.
    ['present rebase state', { rebasePathProbes: { 'rebase-merge': { ok: false, output: 'present' } } }],
    ['symlink rebase state', { rebasePathProbes: { 'rebase-merge': { ok: false, output: 'symlink' } } }],
    ['non-ENOENT rebase error', { rebasePathProbes: { 'rebase-merge': { ok: false, output: 'ENOTDIR' } } }],
    ['unreadable rebase parent', { rebasePathProbes: { 'rebase-merge': { ok: false, output: 'EACCES' } } }],
    ['thrown absence command', { rebasePathProbes: { 'rebase-merge': () => { throw new Error('probe interrupted') } } }],
    ['non-ok absence command', { rebasePathProbes: { 'rebase-merge': { ok: false, output: '' } } }],
    ['non-string absence command', { rebasePathProbes: { 'rebase-merge': { ok: true, output: 42 } } }],
    ['detached branch', { branchResult: { ok: true, output: '' } }],
    ['wrong branch', { branchResult: { ok: true, output: 'other\n' } }],
    ['non-ok status', { statusResult: { ok: false, output: '' } }],
    ['non-string status', { statusResult: { ok: true, output: 42 } }],
    ['thrown status', { statusResult: () => { throw new Error('status interrupted') } }],
    ['remaining unmerged paths', { unmergedAfterAbort: 'a.mjs\n' }],
    ['non-ok conflict probe', { unmergedResult: { ok: false, output: '' } }],
    ['non-string conflict probe', { unmergedResult: { ok: true, output: 42 } }],
    ['thrown conflict probe', { unmergedResult: () => { throw new Error('conflict probe interrupted') } }],
    ['thrown Git-path probe', { commands: { 'git rev-parse --git-path rebase-merge': () => { throw new Error('path interrupted') } } }],
    ['non-ok Git-path probe', { commands: { 'git rev-parse --git-path rebase-merge': { ok: false, output: '' } } }],
    ['non-string Git-path probe', { commands: { 'git rev-parse --git-path rebase-merge': { ok: true, output: 42 } } }],
  ]
  for (const [label, options] of cases) {
    const run = runPublished({
      ctx: { limits: { build_rounds: 2 } },
      envelopes: { 'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass') },
      rebasePathProbes: {
        'rebase-merge': { ok: true, output: '' },
        'rebase-apply': { ok: true, output: '' },
        ...(options.rebasePathProbes || {}),
      },
      branchResult: options.branchResult,
      commands: {
        ...conflictCommands({
          abortResult: { ok: true, output: '' },
          restoredHead: 'mid3333',
          statusResult: options.statusResult || { ok: true, output: '' },
          unmergedAfterAbort: options.unmergedAfterAbort || '',
          unmergedResult: options.unmergedResult,
        }),
        ...(options.commands || {}),
      },
    })
    assert.equal(run.result.status, 'escalation', label)
    assert.equal(run.result.details.escalation.why, expected, label)
    assert.equal(Object.keys(run.io.calls.writes).some((path) => path.includes('rebase-conflict-bounce')), false, label)
  }
})

test('D1 multi commit lane proves restoration', () => {
  const commands = {
    ...conflictCommands({ abortResult: { ok: true, output: '' } }),
    // This is the lane's own earlier commit, not the merge base used for replay.
    'git rev-parse HEAD^': { ok: true, output: 'lanecommit1\n' },
  }
  const run = runPublished({
    ctx: { limits: { build_rounds: 2 } },
    envelopes: { 'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass') },
    commands,
  })
  assert.equal(run.result.status, 'done')
  assert.ok(run.io.calls.run.includes('git reset --soft lanecommit1'))
  assert.doesNotMatch(run.io.calls.logs.map((row) => JSON.stringify(row)).join('\n'), /UNPROVEN/)
})

test('E1 abort status diagnosis is recorded', () => {
  const run = runPublished({
    ctx: { limits: { build_rounds: 2 } },
    envelopes: { 'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass') },
    commands: conflictCommands({ abortResult: { ok: false, output: 'no rebase in progress' } }),
  })
  assert.equal(run.result.status, 'done')
  const rows = run.io.calls.logs.filter((row) => row.rebase_restore_diagnosis)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rebase_restore_diagnosis, RESTORE_DIAGNOSIS)
  const bounce = run.io.calls.writes[`${TD}/rebase-conflict-bounce-r1.md`]
  assert.ok(bounce.includes(`Diagnosis: ${RESTORE_DIAGNOSIS}.`))
})

test('F1 replays recorded rebase-state probe against filesystem states', () => {
  const facts = realCleanAbortFacts()
  const run = recordedRebaseStateRun(facts)
  assert.ok(run.io.calls.run.some((command) => command.startsWith(`${shellArg(process.execPath)} -e `)))
  assertRecordedRebaseStateFailures(run, facts)
})

test('RV1-1 execute-only parent rejects the recorded rebase-state probe', () => {
  const facts = realCleanAbortFacts()
  assertRecordedRebaseStateFailures(recordedRebaseStateRun(facts), facts)
})

test('D1 unproven abort restoration keeps exact escalation', () => {
  const run = runPublished({ ctx: { limits: { build_rounds: 2 } }, commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: false, output: 'abort failed' },
    'git rev-parse HEAD': { ok: true, output: 'mid3333\n' },
  } })
  assert.equal(run.result.status, 'escalation')
  assert.equal(run.result.details.escalation.why, 'the rebase onto origin/main failed with conflicts in a.mjs; restoration is UNPROVEN — HEAD found after abort: mid3333')
  assert.equal(Object.keys(run.io.calls.writes).some((path) => path.includes('rebase-conflict-bounce')), false)
})

test('E1 resolved conflict enters existing post-rebase proof', () => {
  const { io, result } = mechanicalProofRun()
  assert.equal(result.status, 'done')
  assert.equal(io.state.resolverCalls.length, 1)
  const freshRows = io.calls.logs.flatMap((row) => row.gate_check_discriminations || [])
    .filter((row) => row.proof === 'fresh')
  assert.equal(freshRows.length, REBASE_MUTATIONS.length)
  assert.ok(freshRows.every((row) => row.measured_generation > 1))
  const suiteIndex = io.calls.order.indexOf('run:suite-cmd')
  const freshIndexes = io.calls.order.map((entry, index) => entry === 'fresh-proof-row' ? index : -1).filter((index) => index >= 0)
  assert.ok(freshIndexes.length > 0)
  assert.ok(freshIndexes.every((index) => index < suiteIndex))
})

test('F1 clean rebase adds neither bounce nor proof', () => {
  const { io, result } = runRebase({ moved: false })
  assert.equal(result.status, 'done')
  assert.equal(io.calls.run.some((command) => command === 'git rebase origin/main'), false)
  assert.equal(io.calls.run.some((command) => command.includes('anchor-pin.mjs --repair-all')), false)
  assert.equal(io.calls.run.some((command) => command === 'git rebase --abort'), false)
  assert.equal(io.calls.run.some((command) => command.startsWith('git reset --')), false)
  assert.equal(io.calls.order.some((entry) => entry === 'fresh-proof-row'), false)
  assert.equal(Object.keys(io.calls.writes).some((path) => path.includes('rebase-conflict-bounce')), false)
})

test('G1 content conflict in anchor paths falls through to builder', () => {
  const stage2 = anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'first-value', [`${ANCHOR_SOURCE}:20`]: 'second-value' })
  const stage3 = anchorManifest({ [`${ANCHOR_SOURCE}:11`]: 'first-value', [`${ANCHOR_SOURCE}:21`]: 'second-value' })
  const changed = anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'CHANGED-value', [`${ANCHOR_SOURCE}:20`]: 'second-value' })
  const { io, result } = runAnchorPublication({ specs: [{
    paths: [ANCHOR_MANIFEST], stage2: { [ANCHOR_MANIFEST]: stage2 }, stage3: { [ANCHOR_MANIFEST]: stage3 },
    hunk: anchorHunk([ANCHOR_MANIFEST]), resolver: (state) => { state.worktreeBytes[`${CTX.checkout}/${ANCHOR_MANIFEST}`] = changed },
    // These successful commands make the condition-only content mutant reach explicit
    // staging/continuation; the baseline must reject before either command.
    addResult: { ok: true, output: 'mutant staged' }, continueResult: { ok: true, output: 'mutant continued' },
  }], scope: [ANCHOR_MANIFEST], limits: { build_rounds: 2 }, envelopes: {
    'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass'),
  } })
  assert.equal(result.status, 'done')
  assert.equal(io.state.resolverCalls.length, 1)
  assert.equal(io.state.abortCount, 1)
  assert.equal(io.state.continueCount, 0)
  assert.equal(io.state.addCommands.length, 0)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
  const bounce = io.calls.writes[`${TD}/rebase-conflict-bounce-r1.md`]
  assert.match(bounce, /crew\/roles\/anchors\.json/)
  assert.match(bounce, /diff --cc crew\/roles\/anchors\.json/)
})

test('H1 unsafe resolver writes restore and bounce', () => {
  const stage2 = anchorManifest({ [`${ANCHOR_SOURCE}:10`]: 'anchor-value' })
  const stage3 = anchorManifest({ [`${ANCHOR_SOURCE}:12`]: 'anchor-value' })
  const beforeSkill = `See ${ANCHOR_SOURCE}:10.\n`
  const afterSkill = `See ${ANCHOR_SOURCE}:99.\n`
  const { io, result } = runAnchorPublication({ specs: [{
    paths: [ANCHOR_MANIFEST], stage2: { [ANCHOR_MANIFEST]: stage2 }, stage3: { [ANCHOR_MANIFEST]: stage3 },
    hunk: anchorHunk([ANCHOR_MANIFEST]), resolver: (state) => { state.worktreeBytes[`${CTX.checkout}/${ANCHOR_SKILL}`] = afterSkill },
  }], scope: [ANCHOR_MANIFEST], carriers: { [ANCHOR_MANIFEST]: stage3, [ANCHOR_SKILL]: beforeSkill }, tracked: [ANCHOR_MANIFEST, ANCHOR_SKILL], limits: { build_rounds: 2 }, envelopes: {
    'builder:2': buildEnv(), 'reviewer:2': reviewEnv('pass'),
  } })
  assert.equal(result.status, 'done')
  assert.equal(io.state.abortCount, 1)
  assert.equal(io.state.continueCount, 0)
  assert.equal(io.state.worktreeBytes[`${CTX.checkout}/${ANCHOR_SKILL}`], beforeSkill)
  assert.equal(io.state.addCommands.some((command) => command.includes(ANCHOR_SKILL)), false)
  assert.equal(io.calls.assign.filter(({ role }) => role === 'builder').length, 2)
})

test('RV1-1 the observe-and-end residual reaches the commit and PR intent verbatim', () => {
  const residual = "The lane observes and ends a forbidden suite invocation only after it starts; it does not return a tool result to the seat, so #904's tool-result contract remains correctness-unverified."
  const body = `Account JSON policy calls flushed during termination grace without losing the first refusal\n\n${residual}`
  const message = composeCommitMessage({
    task: 'rpcpolicy',
    planEnv: { summary: 'ignored', details: { commit_subject: 'fix(crew): account suite policy calls', issues: [904] } },
    builderEnv: { summary: 'ignored', details: { commit_message: body } },
  })
  assert.equal(message, `fix(crew): account suite policy calls\n\n${body}\n\nRefs: #904`)
  assert.equal(commitIntent(message), body)
  const pr = composePrBody({ intent: commitIntent(message), issues: ['#904'] })
  assert.equal(pr.slice(0, `${body}\n\nRefs #904`.length), `${body}\n\nRefs #904`)
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

test('PR creation failure escalates while retaining the commit hash', () => {
  const { io, result } = convergeRun({ prThrows: 'draft PR failed' })
  assert.equal(result.status, 'escalation')
  assert.equal(io.calls.commits.length, 1)
  assert.equal(result.details.commit, 'abc1234')
  assert.match(result.details.escalation.why, /abc1234/)
  assert.deepEqual(result.details.converge.pr, null)
})

test('the converge seam exposes only issue creation and draft PR creation', () => {
  const { io } = convergeRun()
  assert.deepEqual(io.calls.gh.map((call) => call.method).sort(), ['createDraftPr', 'createIssue'])
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  for (const banned of [/ready-for-review/, /ready_for_review/, /['\"]gh (pr|issue)/, /node:child_process/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/]) {
    assert.equal(banned.test(source), false, `unexpected direct seam path ${banned}`)
  }
})

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
      'git rev-parse HEAD^': { ok: true, output: 'same1111\n' },
    },
  })
  assert.equal(unmoved.result.status, 'done')
  assert.equal(unmoved.io.calls.run.includes('git rebase origin/main'), false)
  assert.equal(unmoved.io.calls.logs.find((entry) => entry.published).published.rebased, false)
  assert.equal(unmoved.result.details.commit, unmoved.io.state.pre)
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

test('A1 normal prompt-surface silence is refused before any publish side effect', () => {
  const run = runPromptPublished(' ')
  assert.equal(run.result.status, 'escalation')
  assert.equal(run.result.details.escalation.where, 'publish')
  assert.equal(run.result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement)
  assert.match(run.result.details.escalation.why, /crew\/roles\/planner\.md/)
  assert.equal(run.io.calls.run.some((command) => command.includes('command -v gh')), false)
  assert.equal(run.io.calls.run.some((command) => command.includes('gh')), false)
  assert.equal(run.io.calls.run.some((command) => command.includes('git push')), false)
  assert.equal(run.io.calls.writes[`${TD}/pr-body.md`], undefined)
  assert.equal(run.io.calls.run.some((command) => command.includes('gh pr create')), false)
})

test('A2 resumed prompt-surface silence is refused before any publish side effect', () => {
  const file = { path: PROMPT_SCOPE[0], state: 'present', bytes: 'file:-:' + 'a'.repeat(64) }
  const checkpoint = resumeCheckpointFixture({
    accepted_scope: PROMPT_SCOPE,
    tree: { files: [file], worktree_sha256: resumeWorktreeSha256([file]) },
    commit: { message: 'feat: resume\n\n ', files: PROMPT_SCOPE },
    kind: 'publish', frozen_where: 'publish', publish: { branch: 'feature/ship', base: 'main' },
  })
  const io = publicationIo()
  const result = resumeTask({ ...CTX, task: 'resume-prompt-publish', publish: { branch: 'feature/ship' }, files_in_scope: PROMPT_SCOPE }, io, checkpoint)
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'publish')
  assert.equal(result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement)
  assert.match(result.details.escalation.why, /crew\/roles\/planner\.md/)
  assert.equal(io.calls.run.some((command) => command.includes('command -v gh')), false)
  assert.equal(io.calls.run.some((command) => command.includes('gh')), false)
  assert.equal(io.calls.run.some((command) => command.includes('git push')), false)
  assert.equal(io.calls.writes[`${TD}/pr-body.md`], undefined)
  assert.equal(io.calls.run.some((command) => command.includes('gh pr create')), false)
})

test('B1 an unmeasured claim with reason and re-measure seat count publishes', () => {
  const claim = 'unmeasured — n insufficient; reason: first-round data is not available; re-measure after 2 seats.'
  const run = runPromptPublished(claim)
  assert.equal(run.result.status, 'done')
  assert.ok(run.io.calls.writes[`${TD}/pr-body.md`].includes(claim))
})

test('B2 all three allowed measured metric-name shapes publish with before-after denominators', () => {
  for (const name of ['first-round pass rate', 'turns per seat', 'prompt-measurement-missing refusal frequency']) {
    const claim = `Measure: ${name}; before: 80% (n=2); after: 90% (n=3).`
    const run = runPromptPublished(claim)
    assert.equal(run.result.status, 'done', name)
    assert.match(run.io.calls.writes[`${TD}/pr-body.md`], new RegExp(`Measure: ${name}`), name)
  }
})

test('B3 an unsupported measured metric name is refused despite valid denominators', () => {
  const run = runPromptPublished('Measure: completion rate; before: 80% (n=2); after: 90% (n=3).')
  assert.equal(run.result.status, 'escalation')
  assert.equal(run.result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement)
})

test('B4 malformed unmeasured reasons and re-measure counts are refused', () => {
  const claims = [
    'unmeasured — n insufficient; re-measure after 2 seats.',
    'unmeasured — n insufficient; reason: ; re-measure after 2 seats.',
    'unmeasured — n insufficient; reason:   ; re-measure after 2 seats.',
    'unmeasured — n insufficient; reason: \t; re-measure after 2 seats.',
    'unmeasured — n insufficient; reason: because; data; re-measure after 2 seats.',
    'unmeasured — n insufficient; reason: data; re-measure after seats.',
    'unmeasured — n insufficient; reason: data; re-measure after 0 seats.',
  ]
  for (const claim of claims) {
    const run = runPromptPublished(claim)
    assert.equal(run.result.status, 'escalation', claim)
    assert.equal(run.result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement, claim)
  }
})

test('B5 prefixed and negated prompt measurement claims are refused', () => {
  const measured = 'Measure: turns per seat; before: 2 turns (n=2); after: 3 turns (n=3).'
  const unmeasured = 'unmeasured — n insufficient; reason: data is incomplete; re-measure after 2 seats.'
  const claims = [
    `not ${measured}`,
    `we did not ${measured}`,
    `not ${unmeasured}`,
    `we did not ${unmeasured}`,
    `${measured} not a standalone claim`,
    `${unmeasured} not a standalone claim`,
  ]
  for (const claim of claims) {
    const run = runPromptPublished(claim)
    assert.equal(run.result.status, 'escalation', claim)
    assert.equal(run.result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement, claim)
  }
})

test('C1 a point estimate without n is refused', () => {
  const claims = [
    'Prompt changes improved the first-round pass rate to 90%.',
    'Measure: turns per seat; before: 2 turns; after: 3 turns (n=2).',
    'Measure: turns per seat; before: 2 turns (n=2); after: 3 turns.',
  ]
  for (const claim of claims) {
    const run = runPromptPublished(claim)
    assert.equal(run.result.status, 'escalation', claim)
    assert.equal(run.result.details.publish.refused, PUBLISH_REFUSALS.promptMeasurement, claim)
  }
})

test('D1 a code-only lane publishes without a prompt measurement claim', () => {
  const run = runPublished({})
  assert.equal(run.result.status, 'done')
  assert.doesNotMatch(run.io.calls.writes[`${TD}/pr-body.md`], /Measure:|unmeasured — n insufficient/i)
})

test('E1 the prompt-measurement refusal is a named closed reason', () => {
  assert.equal(PUBLISH_REFUSALS.promptMeasurement, 'prompt-measurement-missing')
  assert.equal(PUBLISH_REFUSAL_NAMES.includes(PUBLISH_REFUSALS.promptMeasurement), true)
  assert.deepEqual(new Set(PUBLISH_REFUSAL_NAMES), new Set(Object.values(PUBLISH_REFUSALS)))
})

test('E2 prompt-measurement refusal guidance names its triggering path', () => {
  const paths = ['crew/roles/planner.md', 'crew/guidelines/review-do-not-flag.md']
  const defect = promptMeasurementDefect({ files: paths, body: '' })
  assert.equal(defect, 'prompt-change PR body must name a ledger cell measure with before/after and n, or say unmeasured — n insufficient with a reason and re-measure seat count; prompt surface: crew/roles/planner.md, crew/guidelines/review-do-not-flag.md')
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
    ['prompt-measurement-missing', promptPublicationOptions(' ')],
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

test('C1 publication names the measured proof generation', () => {
  const red = `red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}`
  const green = `green\nGATE-SUMMARY {"total":3,"failed":0,"errored":0}`
  const io = installParentProbe(publicationIo({
    envelopes: { 'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'gate-cmd' } }) },
    changed: ['a.mjs', 'a.test.mjs'],
  }))
  const baseRun = io.run
  let gateRuns = 0
  io.run = function (command) {
    if (String(command).includes('gate-cmd')) {
      gateRuns += 1
      return gateRuns === 1 ? { ok: false, output: red } : { ok: true, output: green }
    }
    return baseRun.call(this, command)
  }
  io.runClean = () => ({ ok: false, output: red })
  const result = driveTask({ ...CTX, publish: { branch: 'feature/ship' } }, io)
  assert.equal(result.status, 'done')
  assert.equal(result.details.gate.generation, 2)
  const body = io.calls.writes[`${TD}/pr-body.md`]
  assert.match(body, /discrimination proven on generation 2/)
  assert.doesNotMatch(body, /discrimination proven\*\* \(gate-cmd\)/)

  const oldRed = `old red\nGATE-SUMMARY {"total":3,"failed":3,"errored":0}`
  const oldGreen = `old green\nGATE-SUMMARY {"total":3,"failed":0,"errored":0}`
  const repairedRed = `repaired red\nGATE-SUMMARY {"total":7,"failed":7,"errored":0}`
  const repairedGreen = `repaired green\nGATE-SUMMARY {"total":7,"failed":0,"errored":0}`
  const files = { [`${CTX.checkout}/a.mjs`]: 'before rebuild\n' }
  const changed = Array.from({ length: 8 }, () => ['a.mjs', 'a.test.mjs'])
  let refreshedIo
  refreshedIo = installParentProbe(publicationIo({
    envelopes: {
      'planner:1': planEnv({ details: { ...planEnv().details, gate_cmd: 'old-gate-cmd' } }),
      'builder:1': buildEnv(),
      'builder:2': () => { files[`${CTX.checkout}/a.mjs`] = 'after rebuild\n'; return buildEnv() },
      'reviewer:1': reviewEnv('changes-needed'), 'reviewer:2': reviewEnv('pass'),
      'lead:1': { status: 'done', role: 'lead', details: { gate_cmd: 'repaired-gate-cmd' } },
    },
  }))
  const readFile = refreshedIo.readFile
  refreshedIo.readFile = (path) => Object.prototype.hasOwnProperty.call(files, path) ? files[path] : readFile(path)
  refreshedIo.changedFiles = () => changed.length > 1 ? changed.shift() : changed[0]
  const refreshedRun = refreshedIo.run
  let oldGateRuns = 0
  refreshedIo.run = function (command) {
    const text = String(command)
    if (text.includes('old-gate-cmd')) {
      oldGateRuns += 1
      return oldGateRuns === 1 ? { ok: false, output: oldRed } : { ok: true, output: oldGreen }
    }
    if (text.includes('repaired-gate-cmd')) return { ok: true, output: repairedGreen }
    return refreshedRun.call(this, command)
  }
  const cleanRuns = [oldRed, oldGreen, repairedRed]
  refreshedIo.runClean = () => ({ ok: false, output: cleanRuns.shift() || repairedRed })
  const refreshed = driveTask({ ...CTX, limits: { build_rounds: 2, review_rounds: 2 }, publish: { branch: 'feature/ship' } }, refreshedIo)
  assert.equal(refreshed.status, 'done')
  assert.equal(refreshed.details.gate.cmd, 'repaired-gate-cmd')
  assert.equal(refreshed.details.gate.generation, 4)
  assert.equal(oldGateRuns, 4)
  const refreshedBody = refreshedIo.calls.writes[`${TD}/pr-body.md`]
  assert.match(refreshedBody, /7 gate checks, 0 failed, 0 errored, discrimination proven on generation 4\*\* \(repaired-gate-cmd\)/)
  assert.doesNotMatch(refreshedBody, /3 gate checks, 0 failed, 0 errored.*repaired-gate-cmd/)
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
    '**2 gate checks, 0 failed, 0 errored, discrimination unproven** (gate-cmd), repaired 1 time.',
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
    '2 gate checks, 0 failed, 0 errored, discrimination unproven', '(gate-cmd)', 'repaired 1 time',
    'warm 11 pass / 2 fail / 3 skip', 'cold 13 pass / 4 fail / 5 skip', 'cold-verified from a fresh checkout',
    'Review: changes-needed, 1 residual:', 'R1 (cosmetic): leave this note', 'Changed: crew/drive.mjs',
    'Shape: commit → rebase → suite → publish', '- bounce: retry']) assert.ok(first.includes(token), token)
  assert.equal(first.split('\n')[0], 'why the lane existed')
  assert.ok(!/\{\s*"/.test(first))
})

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

test('E1 ADR-034 names the top-level narrator declaration', () => {
  const adr = readFileSync(new URL('../docs/adr/adr-034-driver-publishes.md', import.meta.url), 'utf8')
  assert.match(adr, /`crew\/capabilities\.json`'s top-level `narrator` declaration is present, the/)
  assert.doesNotMatch(adr, /local_providers.*narrator|narrator.*local_providers/)
})

test('E2 TRD U6 names the top-level narrator declaration', () => {
  const trd = readFileSync(new URL('../docs/trd-local-models.md', import.meta.url), 'utf8')
  const u6 = trd.split('\n').find((line) => line.startsWith('| U6 |')) || ''
  assert.match(u6, /`composePrBody` \+ root `narrator`/)
  assert.equal(u6.includes('local_providers'), false)
})

test('RV1-1 TRD U6 stale-location guard remains vacuity-safe', () => {
  const trd = readFileSync(new URL('../docs/trd-local-models.md', import.meta.url), 'utf8')
  const u6 = trd.split('\n').find((line) => line.startsWith('| U6 |')) || ''
  assert.equal(u6.includes('`composePrBody` + root `narrator`'), true)
  assert.equal(u6.includes('local_providers'), false)
})

test('E3 TRD L4 names the top-level narrator declaration', () => {
  const trd = readFileSync(new URL('../docs/trd-local-models.md', import.meta.url), 'utf8')
  const l4 = trd.split('\n').find((line) => line.startsWith('- **L4')) || ''
  assert.match(l4, /when the top-level `narrator` declaration is configured/)
  assert.doesNotMatch(l4, /local_providers|narrator.*local_providers|local_providers.*narrator/)
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
  assert.ok(chat.startsWith(NARRATOR_CHAT_COMMAND_PREFIX))
  // the prompt is the record and nothing else
  const prompt = narrationPrompt(NARRATION_RECORD)
  assert.ok(prompt.includes(JSON.stringify(NARRATION_RECORD)))
  assert.ok(prompt.includes('you have not seen the diff or the checkout'))
})

test('F1 top-level narrator declaration still enables narration', () => {
  const register = NARRATOR_REGISTER('http://127.0.0.1:11434/v1')
  const parsed = JSON.parse(register)
  assert.deepEqual(Object.keys(parsed), ['narrator'])
  const accepted = narrateRecord({ record: NARRATION_RECORD, registerText: register, io: narratorIo() })
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.text, HONEST_NARRATION)
})

test('G1 refused narration preserves the code-composed body byte-identically', () => {
  const record = NARRATION_RECORD
  const refusal = { refused: NARRATION_REFUSALS.unreachable }
  assert.equal(composePrBody(applyNarration(record, refusal)), composePrBody(record))
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

function configuredNarratorRegister(baseUrl, model) {
  const register = JSON.parse(NARRATOR_REGISTER(baseUrl))
  register.narrator.model = model
  return JSON.stringify(register)
}

test('PC5 narrator contract documents configured model selection', () => {
  const source = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8')
  const contract = [
    '// #806 (TRD docs/trd-local-models.md §2 U6, §4 L4) — the optional top-level `narrator`',
    '// declaration that turns narration on: the KEY is the switch and `base_url` names the endpoint.',
    '// crew/capabilities.schema.json defines `properties.narrator` and `$defs.localprovider`',
    '// around a CLOSED property set that now includes an OPTIONAL `model`: a safe configured',
    '// model is sent VERBATIM, and only its ABSENCE falls back to resolving the served model',
    "// from `<root>/models`. `pi_provider` is pi's namespace, never a served model name.",
  ].join('\n')
  assert.equal(source.includes(contract), true)
  assert.equal(source.includes('crew/capabilities.schema.json:50-71'), false)
})

test('A1 narrator declaration is admitted and supplies the configured model', () => {
  const shippedText = readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8')
  const shipped = JSON.parse(shippedText)
  const config = narratorConfig(shippedText)
  assert.equal(shipped.narrator.model, 'gpt-oss-20b')
  assert.deepEqual(config, { root: 'http://10.112.20.20:8080/v1', model: 'gpt-oss-20b' })
  const collect = []
  const accepted = narrateRecord({
    record: NARRATION_RECORD,
    registerText: shippedText,
    io: narratorIo({
      collect,
      models: { ok: true, output: JSON.stringify({ data: [{ id: 'model-one' }, { id: 'model-two' }, { id: 'model-three' }] }) },
    }),
  })
  const modelCalls = collect.filter((command) => /\/models(\b|$)/.test(command))
  const chatCalls = collect.filter((command) => command.includes('/chat/completions'))
  assert.equal(modelCalls.length, 0)
  assert.equal(chatCalls.length, 1)
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.text, HONEST_NARRATION)
  assert.equal(accepted.model, 'gpt-oss-20b')
  assert.equal(chatCalls[0].includes('"model":"gpt-oss-20b"'), true)
})

test('B1 absent model still refuses an ambiguous multi-model endpoint', () => {
  const collect = []
  const refused = narrateRecord({
    record: NARRATION_RECORD,
    registerText: NARRATOR_REGISTER('http://proxy.lan:1234'),
    io: narratorIo({
      collect,
      models: { ok: true, output: JSON.stringify({ data: [{ id: 'model-one' }, { id: 'model-two' }] }) },
    }),
  })
  assert.equal(refused.refused, NARRATION_REFUSALS.modelAmbiguous)
  assert.equal(collect.filter((command) => /\/models(\b|$)/.test(command)).length, 1)
  assert.equal(collect.filter((command) => command.includes('/chat/completions')).length, 0)
})

test('C1 absent model still narrates with a single resolved endpoint model', () => {
  const resolved = 'served-model:2026'
  const collect = []
  const accepted = narrateRecord({
    record: NARRATION_RECORD,
    registerText: NARRATOR_REGISTER('http://proxy.lan:1234'),
    io: narratorIo({
      collect,
      models: { ok: true, output: JSON.stringify({ data: [{ id: resolved }] }) },
    }),
  })
  assert.equal(collect.length, 2)
  assert.equal(collect[0].includes('/models'), true)
  assert.equal(collect[1].includes('/chat/completions'), true)
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.model, resolved)
  assert.equal(collect[1].includes(`"model":"${resolved}"`), true)
  assert.equal(collect[1].includes('"model":"local-pi"'), false)
})

test('D1 unsafe configured model is refused before any transport call', () => {
  const unsafe = [null, 7, {}, [], '', '!model', ' model', 'model;echo pwn', 'm' + 'a'.repeat(128)]
  for (const model of unsafe) {
    const collect = []
    const refused = narrateRecord({
      record: NARRATION_RECORD,
      registerText: configuredNarratorRegister('http://proxy.lan:1234', model),
      io: narratorIo({ collect }),
    })
    assert.equal(refused.refused, NARRATION_REFUSALS.unconfigured, JSON.stringify(model))
    assert.equal(collect.length, 0, JSON.stringify(model))
  }

  for (const model of ['A', 'Z'.repeat(128), 'A/B:C_1-2.3']) {
    const collect = []
    const accepted = narrateRecord({
      record: NARRATION_RECORD,
      registerText: configuredNarratorRegister('http://proxy.lan:1234', model),
      io: narratorIo({ collect }),
    })
    const chat = collect.find((command) => command.includes('/chat/completions'))
    assert.equal(accepted.refused, undefined, model)
    assert.equal(accepted.model, model, model)
    assert.equal(chat.includes(`"model":"${model}"`), true, model)
  }
})

test('F1 reasoning-only response remains an empty-content refusal', () => {
  const narrated = narrateRecord({
    record: NARRATION_RECORD,
    registerText: configuredNarratorRegister('http://proxy.lan:1234', 'Qwen/Qwen3-Coder:latest'),
    io: narratorIo({ chat: {
      ok: true,
      output: JSON.stringify({ choices: [{ message: { reasoning_content: 'internal reasoning', content: '' } }] }),
    } }),
  })
  assert.equal(narrated.refused, NARRATION_REFUSALS.empty)
  assert.equal(narrated.text, undefined)
  const published = composePrBody(applyNarration(NARRATION_RECORD, narrated))
  assert.equal(published.includes(NARRATION_HEADING), false)

  // `content` ABSENT, not merely empty. The fixture above pins `content: ''`,
  // which a `content ?? reasoning_content` fallback leaves untouched — `??` only
  // fires on null/undefined — so that case alone cannot discriminate the fallback
  // this check exists to forbid. A served model that omits `content` entirely is
  // the shape that would otherwise put private reasoning into a PR body, and the
  // measured llama-swap models all emit reasoning_content beside content.
  //
  // The refusal differs by design and the distinction is kept: an absent field is
  // an UNREADABLE response, an empty string is EMPTY narration. What matters to
  // this check is identical either way — the reasoning text never reaches the body.
  const absent = narrateRecord({
    record: NARRATION_RECORD,
    registerText: configuredNarratorRegister('http://proxy.lan:1234', 'Qwen/Qwen3-Coder:latest'),
    io: narratorIo({ chat: {
      ok: true,
      output: JSON.stringify({ choices: [{ message: { reasoning_content: 'internal reasoning' } }] }),
    } }),
  })
  assert.equal(absent.refused, NARRATION_REFUSALS.unreadable)
  assert.equal(absent.text, undefined)
  const absentBody = composePrBody(applyNarration(NARRATION_RECORD, absent))
  assert.equal(absentBody.includes(NARRATION_HEADING), false)
  assert.equal(absentBody.includes('internal reasoning'), false)
})

const NARRATOR_CHAT_COMMAND_PREFIX = 'curl -sS --connect-timeout 10 --speed-limit 1 --speed-time 60 --max-time 300 -X POST'

test('A1 narrator command bounds low-speed transfer and names a stall refusal', () => {
  const collect = []
  const stalled = narrateRecord({
    record: NARRATION_RECORD,
    registerText: configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b'),
    io: narratorIo({ collect, chat: { ok: false, output: 'curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 60 seconds' } }),
  })
  const command = collect.find((entry) => entry.includes('/chat/completions'))
  assert.match(command, /--connect-timeout 10(?:\s|$)/)
  assert.match(command, /--speed-limit 1(?:\s|$)/)
  assert.match(command, /--speed-time 60(?:\s|$)/)
  assert.equal(stalled.refused, NARRATION_REFUSALS.stall)
})

test('B1 narrator command streams and joins ordered SSE content without the old cap', () => {
  const command = narratorCommand({ root: 'http://proxy.lan:1234/v1', model: 'gpt-oss-20b', prompt: 'hello' })
  const sse = [
    ': keep-alive',
    'data: {"choices":[{"delta":{"content":"The lane "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"ran 2 build rounds."}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  assert.match(command, /"stream":true/)
  assert.doesNotMatch(command, /--max-time 30(?:\s|$)/)
  assert.equal(narrationFromResponse(sse), 'The lane ran 2 build rounds.')
})

test('C1 narrator command retains the absolute 300-second backstop', () => {
  const command = narratorCommand({ root: 'http://proxy.lan:1234/v1', model: 'gpt-oss-20b', prompt: 'hello' })
  assert.match(command, /--max-time 300(?:\s|$)/)
})

test('D1 low-speed, absolute-timeout, and dead-endpoint refusals stay distinct', () => {
  const configured = configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b')
  const ask = (output) => narrateRecord({
    record: NARRATION_RECORD,
    registerText: configured,
    io: narratorIo({ chat: { ok: false, output } }),
  })
  const stall = ask('curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 60 seconds')
  const timeout = ask('curl: (28) Operation timed out after 300000 milliseconds')
  const connectTimeout = ask('curl: (28) Failed to connect: Connection timed out after 10001 milliseconds')
  const unreachable = ask('curl: (7) Failed to connect')
  assert.equal(stall.refused, NARRATION_REFUSALS.stall)
  assert.equal(timeout.refused, NARRATION_REFUSALS.timeout)
  assert.equal(connectTimeout.refused, NARRATION_REFUSALS.timeout)
  assert.equal(unreachable.refused, NARRATION_REFUSALS.unreachable)
  assert.notEqual(timeout.refused, unreachable.refused)
  assert.notEqual(stall.refused, timeout.refused)
})

test('E1 each transport refusal preserves the published body byte-for-byte', () => {
  const base = runPublished({})
  const configured = configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b')
  const cases = [
    [NARRATION_REFUSALS.stall, 'curl: (28) Operation too slow. Less than 1 bytes/sec transferred the last 60 seconds'],
    [NARRATION_REFUSALS.timeout, 'curl: (28) Operation timed out after 300000 milliseconds'],
    [NARRATION_REFUSALS.unreachable, 'curl: (7) Failed to connect'],
  ]
  const body = (run) => run.io.calls.writes[`${TD}/pr-body.md`]
  for (const [reason, output] of cases) {
    const refused = runPublished({ capabilities: configured, commands: { [NARRATOR_CHAT_COMMAND_PREFIX]: { ok: false, output } } })
    assert.equal(refused.result.status, 'done', reason)
    assert.equal(body(refused), body(base), reason)
    assert.equal(composePrBody(applyNarration(NARRATION_RECORD, { refused: reason })), composePrBody(NARRATION_RECORD), reason)
  }
})

test('malformed SSE after valid content fails closed without returning a prefix', () => {
  const malformed = [
    'data: {"choices":[{"delta":{"content":"The lane "}}]}',
    '',
    'data: {not-json}',
    '',
  ].join('\n')
  assert.equal(narrationFromResponse(malformed), null)
  const refused = narrateRecord({
    record: NARRATION_RECORD,
    registerText: configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b'),
    io: narratorIo({ chat: { ok: true, output: malformed } }),
  })
  assert.equal(refused.text, undefined)
  assert.equal(refused.refused, NARRATION_REFUSALS.unreadable)
})

test('RV1-1 the narration length ceiling keeps its own executable witness', () => {
  const configured = configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b')
  const reply = (content) => narrateRecord({
    record: NARRATION_RECORD, registerText: configured,
    io: narratorIo({ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content } }] }) } }),
  })
  // NARRATION_MAX_CHARS is 1200 at crew/drive.mjs; the boundary PAIR is what discriminates —
  // one char over the ceiling is refused, exactly at the ceiling is not.
  assert.equal(reply('x'.repeat(1201)).refused, NARRATION_REFUSALS.tooLong)
  assert.equal(reply('x'.repeat(1200)).refused, undefined)
})

test('RV1-2 accepted prose quoting the curl timeout token is never reclassified', () => {
  const configured = configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b')
  const prose = 'The lane ran 2 build rounds. curl: (28)'
  const accepted = narrateRecord({
    record: { ...NARRATION_RECORD, marker_code: 28 }, registerText: configured,
    io: narratorIo({ chat: { ok: true, output: JSON.stringify({ choices: [{ message: { content: prose } }] }) } }),
  })
  assert.equal(accepted.refused, undefined)
  assert.equal(accepted.outcome, 'accepted')
  assert.equal(accepted.text, prose)
})

test('narration attempts carry duration model and outcome into the journal', () => {
  const configured = configuredNarratorRegister('http://proxy.lan:1234', 'gpt-oss-20b')
  const accepted = runPublished({
    capabilities: configured,
    commands: {
      [NARRATOR_CHAT_COMMAND_PREFIX]: {
        ok: true,
        output: JSON.stringify({ choices: [{ message: { content: 'The lane ran 2 build rounds.' } }] }),
      },
    },
  })
  const acceptedRow = accepted.io.calls.logs.find((entry) => entry.narration)?.narration
  assert.deepEqual(acceptedRow, {
    attempted: true, model: 'gpt-oss-20b', duration_ms: 10, outcome: 'accepted',
    reason: null, chars: 'The lane ran 2 build rounds.'.length,
  })

  const refused = runPublished({
    capabilities: configured,
    commands: { [NARRATOR_CHAT_COMMAND_PREFIX]: { ok: false, output: 'connection refused' } },
  })
  assert.deepEqual(refused.io.calls.logs.find((entry) => entry.narration)?.narration, {
    attempted: true, model: 'gpt-oss-20b', duration_ms: 10, outcome: 'refused',
    reason: NARRATION_REFUSALS.unreachable,
  })

  const preChat = runPublished({})
  assert.deepEqual(preChat.io.calls.logs.find((entry) => entry.narration)?.narration, {
    attempted: false, model: null, duration_ms: null, outcome: 'refused',
    reason: NARRATION_REFUSALS.unconfigured,
  })
})

test('F2 absent configured model keeps modelAbsent reachable', () => {
  const collect = []
  const refused = narrateRecord({
    record: NARRATION_RECORD,
    registerText: NARRATOR_REGISTER('http://proxy.lan:1234'),
    io: narratorIo({ collect, models: { ok: true, output: JSON.stringify({ data: [] }) } }),
  })
  assert.equal(refused.refused, NARRATION_REFUSALS.modelAbsent)
  assert.equal(collect.filter((command) => /\/models(\b|$)/.test(command)).length, 1)
  assert.equal(collect.filter((command) => command.includes('/chat/completions')).length, 0)
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

test('F1 configured narration is additive and refusal preserves the current body', () => {
  const narratorCommands = {
    [NARRATOR_CHAT_COMMAND_PREFIX]: { ok: true, output: JSON.stringify({ choices: [{ message: { content: 'The lane ran 2 build rounds.' } }] }) },
  }
  const configured = JSON.parse(NARRATOR_REGISTER('http://127.0.0.1:11434/v1'))
  configured.narrator.model = 'qwen3-coder'
  const register = JSON.stringify(configured)
  const narrated = runPublished({ capabilities: register, commands: narratorCommands })
  assert.equal(narrated.result.status, 'done')
  const narratedBody = narrated.io.calls.writes[TD + '/pr-body.md']
  assert.ok(narratedBody.startsWith(NARRATION_HEADING + '\nThe lane ran 2 build rounds.\n\n'), JSON.stringify(narratedBody.slice(0, 140)))
  const row = narrated.io.calls.logs.find((entry) => entry.narration)
  assert.deepEqual(row.narration, {
    attempted: true, duration_ms: 10, model: 'qwen3-coder', outcome: 'accepted',
    reason: null, chars: 'The lane ran 2 build rounds.'.length,
  })

  // a refused configured request publishes exactly the no-narrator body — byte for byte
  const dead = runPublished({ capabilities: register, commands: { [NARRATOR_CHAT_COMMAND_PREFIX]: { ok: false, output: 'connection refused' } } })
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

test('an armed run refuses green suites whose publication counts are unmeasured', () => {
  const warm = runPublished({ warm: '' })
  assert.equal(warm.result.status, 'escalation')
  assert.equal(warm.result.details.escalation.where, 'suite')
  const cold = runPublished({ coldOutput: '' })
  assert.equal(cold.result.status, 'escalation')
  assert.equal(cold.result.details.escalation.where, 'cold-suite')
  assert.equal(cold.result.details.commit, cold.io.state.post)
})

test('refsFromCommitMessage reads the trailer in order, de-duplicates, and stays empty without one', () => {
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody\n\nRefs: #679, #758, #679'), ['#679', '#758'])
  assert.deepEqual(refsFromCommitMessage('subject\n\nbody'), [])
})

test('A1 moved-base soft reset re-proves every mutation before warm suite', () => {
  const { io, result } = runRebase()
  assert.equal(result.status, 'done')
  assert.equal(REBASE_MUTATIONS.length >= 2, true)
  assert.equal(io.state.resetCommand, 'git reset --soft base1111')
  assert.equal(io.calls.commits.length, 2)
  const freshRows = io.calls.logs.flatMap((row) => row.gate_check_discriminations || [])
    .filter((row) => row.proof === 'fresh')
  assert.equal(freshRows.length, REBASE_MUTATIONS.length)
  assert.ok(freshRows.every((row) => row.measured_generation > 1))
  const suiteIndex = io.calls.order.indexOf('run:suite-cmd')
  const freshIndexes = io.calls.order.map((entry, index) => entry === 'fresh-proof-row' ? index : -1).filter((index) => index >= 0)
  assert.ok(freshIndexes.length > 0)
  assert.ok(freshIndexes.every((index) => index < suiteIndex))
  assert.equal(io.calls.order.filter((entry) => entry === 'commit').length, 2)
})

test('B1 unmoved base performs no extra proof', () => {
  const { io, result } = runRebase({ moved: false })
  assert.equal(result.status, 'done')
  assert.equal(io.state.resetCommand, null)
  assert.equal(io.calls.commits.length, 1)
  const proofRows = io.calls.logs.filter((row) => row.gate_check_discriminations)
  assert.equal(proofRows.length, 1)
  const parentRow = io.calls.logs.find((row) => row.gate_proof_parent)
  assert.equal(parentRow.gate_proof_parent, 'base1111')
  assert.equal(parentRow.gate_generation, 1)
  assert.equal(io.calls.run.some((command) => command.startsWith('git reset ')), false)
  assert.equal(io.calls.order.includes('fresh-proof-row'), false)
})

test('C1 red post-rebase proof escalates before publication', () => {
  for (const postProof of ['red', 'unproven']) {
    const { io, result } = runRebase({ postProof })
    assert.equal(result.status, 'escalation', postProof)
    assert.equal(result.details.escalation.where, 'rebase', postProof)
    assert.equal(result.details.commit, io.state.rebaseHead, postProof)
    assert.equal(io.calls.commits.length, 1, postProof)
    assert.equal(io.calls.run.some((command) => command === 'suite-cmd'), false, postProof)
    assert.equal(io.calls.run.some((command) => command.startsWith('git push')), false, postProof)
    assert.equal(io.calls.logs.some((row) => row.published), false, postProof)
    assert.equal(io.calls.logs.some((row) => row.gate_proof_parent), false, postProof)
  }
})

test('C2 soft-reset failure escalates before proof', () => {
  for (const reset of ['return', 'throw']) {
    const { io, result } = runRebase({ reset })
    assert.equal(result.status, 'escalation', reset)
    assert.equal(result.details.escalation.where, 'rebase', reset)
    assert.equal(result.details.commit, io.state.rebaseHead, reset)
    assert.equal(io.calls.commits.length, 1, reset)
    assert.equal(io.state.runCleanCalls.length, 1, reset)
    assert.equal(io.calls.order.includes('fresh-proof-row'), false, reset)
    assert.equal(io.calls.logs.some((row) => row.gate_proof_parent), false, reset)
  }
})

test('C3 thrown post-rebase proof escalates before recommit', () => {
  const { io, result } = runRebase({ proofThrow: true })
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.escalation.where, 'rebase')
  assert.match(result.details.escalation.why, /post-rebase proof threw/)
  assert.equal(result.details.commit, io.state.rebaseHead)
  assert.equal(io.calls.commits.length, 1)
  assert.equal(io.calls.run.some((command) => command === 'suite-cmd'), false)
  assert.equal(io.calls.logs.some((row) => row.gate_proof_parent), false)
})

test('C4 recommit failure escalates before publication', () => {
  for (const recommit of ['throw', 'blank']) {
    const { io, result } = runRebase({ recommit })
    assert.equal(result.status, 'escalation', recommit)
    assert.equal(result.details.escalation.where, 'rebase', recommit)
    assert.equal(result.details.commit, io.state.rebaseHead, recommit)
    assert.equal(io.calls.commits.length, 2, recommit)
    assert.equal(io.calls.run.some((command) => command === 'suite-cmd'), false, recommit)
    assert.equal(io.calls.run.some((command) => command.startsWith('git push')), false, recommit)
    assert.equal(io.calls.logs.some((row) => row.published), false, recommit)
  }
})

test('D1 interrupted uncommit window retains staged tree and recovery commit', () => {
  const { io, result } = runRebase({ proofThrow: true })
  const taskPath = `${CTX.checkout}/a.mjs`
  assert.equal(result.status, 'escalation')
  assert.equal(result.details.commit, io.state.rebaseHead)
  assert.equal(io.state.resetCommand, 'git reset --soft base1111')
  assert.equal(io.state.indexBytes[taskPath], 'POST-REBASE TASK-A\n')
  assert.equal(io.state.worktreeBytes[taskPath], 'POST-REBASE TASK-A\n')
  const hard = { ...io.state.indexBytes }
  delete hard[taskPath]
  assert.equal(hard[taskPath], undefined)
})

test('E1 proof-parent journal and base_sha sinks name verified parent', () => {
  for (const moved of [true, false]) {
    const { io, result } = runRebase({ moved })
    assert.equal(result.status, 'done', moved ? 'moved' : 'unmoved')
    const parentRow = io.calls.logs.find((row) => row.gate_proof_parent)
    const publishedRow = io.calls.logs.find((row) => row.published)
    assert.equal(parentRow.gate_proof_parent, REBASE_PARENT)
    assert.equal(publishedRow.published.base_sha, REBASE_PARENT)
    assert.equal(result.details.pr.base_sha, REBASE_PARENT)
    assert.equal(result.details.gate?.proof_parent, undefined)
  }
})

test('E2 direct-parent validation rejects blank mismatch and dropped replay', () => {
  // The driver verifies the parent with `git merge-base`, so these inject there. Each
  // case is pre-rebase-correct (`older000`, which is what makes `rebased` true) and
  // wrong only AFTER the replay — a blank, a mismatch, and a base that never moved.
  const badMergeBase = (after) => ({
    commands: {
      'git merge-base HEAD origin/main': (state) => (state.head === state.post
        ? after
        : { ok: true, output: 'older000\n' }),
    },
  })
  const cases = [
    badMergeBase({ ok: true, output: '' }),
    badMergeBase({ ok: true, output: 'other9999\n' }),
    badMergeBase({ ok: false, output: 'fatal: no merge base\n' }),
  ]
  for (const options of cases) {
    const { io, result } = runRebase(options)
    assert.equal(result.status, 'escalation')
    assert.equal(result.details.escalation.where, 'rebase')
    assert.equal(result.details.commit, io.state.rebaseHead)
    assert.equal(io.state.resetCommand, null)
    assert.equal(io.calls.logs.some((row) => row.gate_proof_parent), false)
    assert.equal(io.calls.logs.some((row) => row.published), false)
    assert.equal(io.calls.run.some((command) => command === 'suite-cmd'), false)
  }
})

test('E3 a MULTI-commit lane rebases and re-proves, because HEAD^ is not the base', () => {
  // b640 and b642 died here on 2026-09-12: both had two commits, so `git rev-parse HEAD^`
  // returned the lane's OWN first commit and the parent guard escalated correct, gate-green
  // work. `git merge-base` answers the question actually being asked at any commit count.
  const { io, result } = runRebase({
    commands: {
      // HEAD^ is the lane's own earlier commit, exactly as it is for a real two-commit lane.
      'git rev-parse HEAD^': { ok: true, output: 'lanecommit1\n' },
    },
  })
  assert.equal(result.status, 'done')
  assert.equal(io.state.resetCommand, `git reset --soft ${REBASE_PARENT}`)
  assert.equal(io.calls.logs.some((row) => row.gate_proof_parent === REBASE_PARENT), true)
})

test('F1 existing rebase escalation text remains exact', () => {
  const fetch = runPublished({ commands: { 'git fetch origin main': { ok: false, output: 'network down' } } })
  assert.equal(fetch.result.details.escalation.why, 'the fetch of origin/main failed: network down')
  const base = runPublished({ commands: { 'git rev-parse origin/main': { ok: true, output: '' } } })
  assert.equal(base.result.details.escalation.why, 'the rebase probe git rev-parse origin/main failed or returned blank output')
  const merge = runPublished({ commands: { 'git merge-base HEAD origin/main': { ok: true, output: '' } } })
  assert.equal(merge.result.details.escalation.why, 'the rebase probe git merge-base HEAD origin/main failed or returned blank output')
  const proven = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': (state) => ({ ok: true, output: state.head === state.pre ? '' : 'a.mjs\n' }),
    'git rebase --abort': (state) => { state.head = state.pre; return { ok: true, output: '' } },
  } })
  assert.equal(proven.result.details.escalation.why, 'the rebase onto origin/main failed with conflicts in a.mjs; restoration proven at HEAD pre1111')
  const unproven = runPublished({ commands: {
    'git rebase origin/main': (state) => { state.head = 'mid3333'; return { ok: false, output: 'rebase failed' } },
    'git diff --name-only --diff-filter=U': { ok: true, output: 'a.mjs\n' },
    'git rebase --abort': { ok: false, output: 'abort failed' },
  } })
  assert.equal(unproven.result.details.escalation.why, 'the rebase onto origin/main failed with conflicts in a.mjs; restoration is UNPROVEN — HEAD found after abort: mid3333')
})
