// crew/drive.mjs — the deterministic task-loop driver (crew v3).
//
// "Code disposes, the lead decides." The mechanical loop lives HERE, as
// tested code: assignment order, envelope waits, the git scope gate, the
// validation lane, the full suite, commit-on-green, every bounce and every
// bound. An agent never drives this loop. The LEAD pane is consulted only at
// genuine judgment points — a member returning insufficient, a bounce limit
// exhausting, a verdict that code cannot arbitrate — and answers with a
// DECISION envelope carrying a closed enum that this driver branches on.
// Escalation ladder: code -> lead -> orchestrator/human, each hop only when
// the enum says so.
//
// Dependency injection: every side effect goes through the `io` object so
// the whole state machine is unit-testable without cmux or live panes.
// realIo() (in crew.mjs) wires it to driver.mjs + child_process.

export const LIMITS = Object.freeze({
  plan_rounds: 2, // planner attempts (initial + bounces)
  build_rounds: 3, // builder attempts across lane/scope/review bounces
  review_rounds: 2, // reviewer verdicts
  lead_consults: 4, // total decision consults per task
})

export const WAITS_S = Object.freeze({
  planner: 1800, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
})

// The decision enum the lead may return. The driver offers a SUBSET as
// options in each consult; any answer outside the offered set is treated as
// escalate (fail toward the human, never toward silent progress).
export const DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])

function fail(stage, msg) {
  const err = new Error(`${stage}: ${msg}`)
  err.stage = stage
  return err
}

// --- envelope shape checks (never trust a member's file blindly) -------------
function validEnvelope(env, role) {
  return env && typeof env === 'object'
    && typeof env.status === 'string'
    && (env.role === undefined || env.role === role)
}

function verdictOf(env) {
  const v = env?.details?.verdict
  return v === 'pass' || v === 'approve' ? 'pass'
    : v === 'changes-needed' || v === 'revise' ? 'revise'
    : null
}

// --- the driver ----------------------------------------------------------------
// ctx: { task, briefFile, taskDir, checkout, roles: [..seated roles..],
//        lane: <fallback validation command|null>, suite: <full-suite command>,
//        limits?, waits? }
// io:  { assign({role, briefFile, note}) -> {id, returnPath},
//        wait(returnPath, timeoutS) -> envelope|null,
//        writeFile(path, content) -> void, readFile(path) -> string|null,
//        run(cmd) -> {ok, output},            // shell, cwd=checkout
//        changedFiles() -> [repo-relative..], // git status --porcelain paths
//        commit(files, message) -> hash,
//        log(obj) -> void,                    // journal line (code-owned)
//        now() -> ms }
export function driveTask(ctx, io) {
  const limits = { ...LIMITS, ...(ctx.limits || {}) }
  const waits = { ...WAITS_S, ...(ctx.waits || {}) }
  const S = { consults: 0, stages: [], commit: null }
  const art = (name) => `${ctx.taskDir}/${name}`

  const stage = (label) => { S.stages.push(label); io.log({ at: io.now(), stage: label }) }

  function assignAndWait(role, briefFile, note) {
    const { id, returnPath } = io.assign({ role, briefFile, note })
    io.log({ at: io.now(), assign: id, role, brief: briefFile })
    const env = io.wait(returnPath, waits[role] || 1200)
    if (!validEnvelope(env, role)) throw fail(role, `no valid envelope at ${returnPath} within ${waits[role]}s`)
    io.log({ at: io.now(), envelope: id, role, status: env.status })
    return env
  }

  // Consult the lead: offer a closed option set, get a decision back.
  // Anything invalid, out-of-set, or timed out escalates.
  function consultLead(question, options, contextPaths) {
    S.consults += 1
    if (S.consults > limits.lead_consults) {
      return { decision: 'escalate', reason: `lead consult limit (${limits.lead_consults}) exhausted` }
    }
    const briefPath = art(`decision-${S.consults}.md`)
    io.writeFile(briefPath, [
      `# Decision needed (consult ${S.consults})`, '',
      `## Question`, question, '',
      `## Your options (answer with exactly one in details.decision)`,
      ...options.map((o) => `- ${o}`), '',
      `## Context files (read before deciding)`,
      ...contextPaths.map((p) => `- ${p}`), '',
      `Reply with a ReturnEnvelope whose details are {"decision": <option>, "reason": "...", "guidance": "..."}.`,
      `guidance is REQUIRED when decision is bounce — it becomes the bounce brief's steer.`,
    ].join('\n'))
    const env = assignAndWait('lead', briefPath, 'decision')
    const d = env.details || {}
    if (env.status !== 'done' || !options.includes(d.decision)) {
      return { decision: 'escalate', reason: `lead returned ${env.status}/${d.decision ?? 'no decision'} — treating as escalate` }
    }
    io.log({ at: io.now(), decision: d.decision, consult: S.consults, reason: d.reason })
    return { decision: d.decision, reason: d.reason || '', guidance: d.guidance || '' }
  }

  function escalate(where, why, extraArtifacts = []) {
    stage(`escalate:${where}`)
    return {
      status: 'escalation',
      summary: `Task ${ctx.task} needs a human: ${why}`,
      artifacts: [art('journal.jsonl'), ...extraArtifacts],
      details: { stages: S.stages, escalation: { where, why }, commit: null },
    }
  }

  // ---- 1. PLAN ----------------------------------------------------------------
  let planEnv = null
  let planBrief = ctx.briefFile
  for (let round = 1; round <= limits.plan_rounds; round += 1) {
    stage(`plan:r${round}`)
    const env = assignAndWait('planner', planBrief, round === 1 ? 'plan' : 'plan-revision')
    if (env.status !== 'done') {
      const c = consultLead(
        `The planner returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce it with guidance, or escalate?`,
        ['bounce', 'escalate'], [planBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') return escalate('plan', c.reason, env.artifacts || [])
      const b = art(`plan-bounce-r${round}.md`)
      io.writeFile(b, `# Plan bounce (round ${round})\n\n${c.guidance}\n\nOriginal brief: ${ctx.briefFile}\nPlanner said: ${env.summary || env.status}`)
      planBrief = b
      continue
    }
    planEnv = env
    // ---- 1b. CHECK (only when a tech-lead is seated) ---------------------------
    if (!ctx.roles.includes('tech-lead')) break
    stage(`check:r${round}`)
    const planPath = env.details?.plan_path || art('plan.md')
    const checkBrief = art(`check-brief-r${round}.md`)
    io.writeFile(checkBrief, [
      `# Plan check (round ${round})`, '',
      `Read the task brief at ${ctx.briefFile} and the plan at ${planPath}.`,
      `Falsify the plan's ground truth against the repo at ${ctx.checkout}.`,
      `Planner consult questions: ${JSON.stringify(env.details?.consult_questions || [])}`,
      `Write plan-check.md in the task dir. details.verdict must be approve or revise.`,
    ].join('\n'))
    const check = assignAndWait('tech-lead', checkBrief, 'plan-check')
    const v = verdictOf(check)
    if (v === 'pass') break
    if (round === limits.plan_rounds) {
      const c = consultLead(
        `The plan check still says revise after ${round} round(s). Accept the latest plan anyway, or escalate?`,
        ['accept', 'escalate'], [planPath, check.details?.check_path || art('plan-check.md')],
      )
      if (c.decision === 'escalate') return escalate('plan-check', c.reason)
      break // accept: proceed on the latest plan
    }
    const b = art(`plan-bounce-r${round}.md`)
    io.writeFile(b, `# Plan revision (round ${round})\n\nRevise plan.md per the check at ${check.details?.check_path || art('plan-check.md')}. Close every must-fix. Original brief: ${ctx.briefFile}`)
    planBrief = b
    planEnv = null
  }
  if (!planEnv) return escalate('plan', `no accepted plan within ${limits.plan_rounds} rounds`)

  const scopeFiles = planEnv.details?.files_in_scope
  if (!Array.isArray(scopeFiles) || scopeFiles.length === 0) {
    return escalate('plan', 'planner envelope carries no files_in_scope — the scope gate cannot run without it', planEnv.artifacts || [])
  }
  const lane = planEnv.details?.validation_lane || ctx.lane
  if (!lane) return escalate('plan', 'no validation lane (neither planner envelope nor --lane provided)')

  // ---- 2. BUILD + mechanical gates + REVIEW ------------------------------------
  const planPath = planEnv.details?.plan_path || art('plan.md')
  let buildBrief = planPath
  let buildNote = 'build'
  let builderEnv = null
  let reviews = 0
  for (let round = 1; round <= limits.build_rounds; round += 1) {
    stage(`build:r${round}`)
    const env = assignAndWait('builder', buildBrief, buildNote)
    if (env.status !== 'done') {
      const c = consultLead(
        `The builder returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce with guidance, or escalate?`,
        ['bounce', 'escalate'], [buildBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') return escalate('build', c.reason, env.artifacts || [])
      const b = art(`build-bounce-r${round}.md`)
      io.writeFile(b, `# Build bounce (round ${round})\n\n${c.guidance}\n\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'build-fix'
      continue
    }
    builderEnv = env

    // Gate A (mechanical): scope by git, never by self-report.
    stage(`scope-gate:r${round}`)
    const changed = io.changedFiles()
    const outOfScope = changed.filter((f) => !scopeFiles.includes(f))
    if (outOfScope.length > 0) {
      if (round === limits.build_rounds) return escalate('scope', `out-of-scope edits persisted: ${outOfScope.join(', ')}`)
      const b = art(`build-bounce-r${round}.md`)
      io.writeFile(b, `# Scope bounce (round ${round})\n\nThese files are OUTSIDE the plan's scope — revert them or stop touching them:\n${outOfScope.map((f) => `- ${f}`).join('\n')}\n\nIn-scope set:\n${scopeFiles.map((f) => `- ${f}`).join('\n')}\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'scope-fix'
      continue
    }

    // Gate B (mechanical): the validation lane, run by code.
    stage(`lane:r${round}`)
    const laneRes = io.run(lane)
    if (!laneRes.ok) {
      if (round === limits.build_rounds) {
        const c = consultLead(
          `The validation lane is still red after ${round} rounds. Bounce once more with guidance, or escalate?`,
          ['bounce', 'escalate'], [planPath, art('journal.jsonl')],
        )
        if (c.decision !== 'bounce') return escalate('lane', c.reason)
      }
      const b = art(`build-bounce-r${round}.md`)
      io.writeFile(b, `# Lane bounce (round ${round})\n\nThe validation lane is RED. Make it green:\n\n    ${lane}\n\nFailures:\n${laneRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'lane-fix'
      continue
    }

    // Gate C (judgment, but enum-consumed): the reviewer.
    if (reviews >= limits.review_rounds) {
      const c = consultLead(
        `Review rounds are exhausted (${reviews}) and the last verdict was revise. Accept with residuals, or escalate?`,
        ['accept', 'escalate'], [planPath, art('review.md')],
      )
      if (c.decision === 'escalate') return escalate('review', c.reason)
      break
    }
    stage(`review:r${reviews + 1}`)
    const revBrief = art(`review-brief-${reviews + 1}.md`)
    io.writeFile(revBrief, [
      `# Review (round ${reviews + 1})`, '',
      `Plan of record: ${planPath}. Changes are uncommitted in ${ctx.checkout} — read the diff with git.`,
      `Re-run the validation lane yourself: ${lane}`,
      `Write review.md in the task dir. details.verdict must be pass or changes-needed.`,
    ].join('\n'))
    const review = assignAndWait('reviewer', revBrief, 'review')
    reviews += 1
    const v = verdictOf(review)
    if (v === 'pass') { stage('review:pass'); break }
    if (v !== 'revise') {
      const c = consultLead(
        `The reviewer returned an unreadable verdict (status=${review.status}, verdict=${review.details?.verdict}). Bounce the reviewer, or escalate?`,
        ['bounce', 'escalate'], [revBrief, ...(review.artifacts || [])],
      )
      if (c.decision === 'escalate') return escalate('review', c.reason)
      reviews -= 1 // the re-ask replaces the unreadable round
      continue
    }
    if (round === limits.build_rounds) {
      const c = consultLead(
        `Build rounds are exhausted but the review says changes-needed. Accept with residuals, or escalate?`,
        ['accept', 'escalate'], [planPath, review.details?.review_path || art('review.md')],
      )
      if (c.decision === 'escalate') return escalate('review', c.reason)
      break
    }
    const b = art(`build-bounce-r${round}.md`)
    io.writeFile(b, `# Review bounce (round ${round})\n\nClose every must-fix in the review at ${review.details?.review_path || art('review.md')}. Plan: ${planPath}`)
    buildBrief = b; buildNote = 'review-fix'
  }
  if (!builderEnv) return escalate('build', `no accepted build within ${limits.build_rounds} rounds`)

  // ---- 3. FINISH: full suite (code) + commit-on-green (code) --------------------
  stage('suite')
  const suiteRes = io.run(ctx.suite)
  if (!suiteRes.ok) {
    return escalate('suite', `full suite red after review pass — this needs eyes:\n${suiteRes.output.slice(-2000)}`)
  }
  stage('commit')
  const message = builderEnv.details?.commit_message
    || `crew(${ctx.task}): ${builderEnv.summary?.split('\n')[0] || 'task change'}`
  S.commit = io.commit(scopeFiles, message)
  stage('done')

  return {
    status: 'done',
    summary: `Task ${ctx.task} complete: committed ${S.commit} (${scopeFiles.length} files), suite green, review pass. Stages: ${S.stages.join(' | ')}`,
    artifacts: [planPath, art('review.md'), art('journal.jsonl')],
    details: { commit: S.commit, stages: S.stages, files_committed: scopeFiles, consults: S.consults, escalation: null },
  }
}
