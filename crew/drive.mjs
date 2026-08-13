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
  gate_fails_to_triage: 2, // gate failures before build-vs-gate-defect triage
  gate_repairs: 1, // the gate's author may repair it at most once per task
})

export const WAITS_S = Object.freeze({
  planner: 1800, 'tech-lead': 1500, builder: 2400, reviewer: 1800, lead: 900,
})

// The decision enum the lead may return. The driver offers a SUBSET as
// options in each consult; any answer outside the offered set is treated as
// escalate (fail toward the human, never toward silent progress).
export const DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])

// The compounding valve: on the FIRST round of a consult the lead may answer
// decision='second-opinion' with details.from=<a seated judgment member>.
// CODE then gathers that member's perspective — same question and context,
// deliberately WITHOUT the lead's leaning (unseeded, so it is genuinely
// independent) — and re-asks the lead once, with the perspective attached
// and the valve removed. One hop, then the judge must judge. The whole
// exchange counts as ONE consult against the limit.
export const SECOND_OPINION = 'second-opinion'
export const PERSPECTIVE_TARGETS = Object.freeze(['reviewer', 'tech-lead', 'planner'])

function fail(stage, msg) {
  const err = new Error(`${stage}: ${msg}`)
  err.stage = stage
  return err
}

// --- envelope shape checks (never trust a member's file blindly) -------------
// The assignment_id check is anti-replay: a stale file from an earlier run
// (crash, escalation) must never satisfy a fresh assignment. Missing is
// tolerated (the shape contract is prompt-borne); a MISMATCH never is.
function validEnvelope(env, role, id) {
  return env && typeof env === 'object'
    && typeof env.status === 'string'
    && (env.role === undefined || env.role === role)
    && (env.assignment_id === undefined || env.assignment_id === id)
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
//        journal: <real journal.jsonl path (lives in the CREW dir)>,
//        limits?, waits? }
// io:  { assign({role, briefFile, note}) -> {id, returnPath},
//        wait(returnPath, timeoutS) -> envelope|null,
//        writeFile(path, content) -> void, readFile(path) -> string|null,
//        run(cmd) -> {ok, output},            // shell, cwd=checkout
//        runClean(cmd) -> {ok, output},      // OPTIONAL: run cmd against the
//                                            // checkout with the uncommitted
//                                            // changes temporarily set aside
//        changedFiles() -> [repo-relative..], // git status --porcelain paths
//        commit(files, message) -> hash,
//        log(obj) -> void,                    // journal line (code-owned)
//        now() -> ms }
export function driveTask(ctx, io) {
  const limits = { ...LIMITS, ...(ctx.limits || {}) }
  const waits = { ...WAITS_S, ...(ctx.waits || {}) }
  const S = { consults: 0, stages: [], commit: null, dissents: [] }
  const art = (name) => `${ctx.taskDir}/${name}`
  // The journal lives in the CREW dir, not the task dir — take its real path
  // from ctx so decision briefs and escalation artifacts never cite a 404.
  const journal = ctx.journal || art('journal.jsonl')

  // Every stage transition goes to the journal AND (when io provides it) to
  // a live status surface — the workspace pill — so a quiet team is never
  // illegible: the pill says which CODE stage is running (suite, gate,
  // commit...). On escalation it freezes at the failing stage.
  const stage = (label) => { S.stages.push(label); io.log({ at: io.now(), stage: label }); io.status?.(label) }

  function assignAndWait(role, briefFile, note) {
    const { id, returnPath } = io.assign({ role, briefFile, note })
    io.log({ at: io.now(), assign: id, role, brief: briefFile })
    const env = io.wait(returnPath, waits[role] || 1200)
    if (!validEnvelope(env, role, id)) throw fail(role, `no valid envelope at ${returnPath} within ${waits[role]}s`)
    io.log({ at: io.now(), envelope: id, role, status: env.status })
    return env
  }

  // Consult the lead: offer a closed option set, get a decision back.
  // Anything invalid, out-of-set, or timed out escalates. A first-round
  // 'second-opinion' answer triggers the code-mediated compounding hop.
  function consultLead(question, options, contextPaths, { exclude } = {}) {
    S.consults += 1
    if (S.consults > limits.lead_consults) {
      return { decision: 'escalate', reason: `lead consult limit (${limits.lead_consults}) exhausted` }
    }
    // exclude: a seat whose own output is the thing under judgment cannot be
    // offered as the independent advisor on it.
    const targets = PERSPECTIVE_TARGETS.filter((r) => ctx.roles.includes(r) && r !== exclude)
    const first = askLead(question, options, contextPaths, { round: 1, targets })
    if (first.decision !== SECOND_OPINION) return first

    // Compounding hop (code-executed, one only). Invalid target -> escalate.
    const from = first.from
    if (!targets.includes(from)) {
      return { decision: 'escalate', reason: `second-opinion target ${JSON.stringify(from)} is not a seated judgment member` }
    }
    const pBrief = art(`perspective-${S.consults}.md`)
    io.writeFile(pBrief, [
      `# Perspective requested (consult ${S.consults})`, '',
      `You are advising a decision, not re-doing your role's work. The lead's`,
      `own view is deliberately not shared with you — answer independently`,
      `from your seat's knowledge; be direct about confidence.`, '',
      `## Question`, question, '',
      `## Possible outcomes (recommend exactly one)`,
      ...options.map((o) => `- ${o}`), '',
      `## Context files (read before answering)`,
      ...contextPaths.map((x) => `- ${x}`), '',
      `Reply with a ReturnEnvelope whose details are {"perspective": "<3-8 sentences>", "recommendation": "<one outcome>", "confidence": "high|medium|low"}.`,
    ].join('\n'))
    const pEnv = assignAndWait(from, pBrief, 'perspective')
    const recommendation = pEnv.status === 'done' && options.includes(pEnv.details?.recommendation)
      ? pEnv.details.recommendation : null
    const perspective = pEnv.status === 'done'
      ? `${pEnv.details?.perspective || pEnv.summary || '(empty perspective)'} [recommends: ${recommendation || 'unstated'}; confidence: ${pEnv.details?.confidence || 'unstated'}]`
      : `(${from} returned ${pEnv.status}: ${pEnv.summary || 'no detail'})`
    io.log({ at: io.now(), perspective_from: from, recommendation, consult: S.consults })

    const second = askLead(
      `${question}\n\n## Independent perspective from ${from} (gathered unseeded)\n${perspective}`,
      options, contextPaths, { round: 2, targets: [] },
    )
    if (second.decision === SECOND_OPINION) {
      return { decision: 'escalate', reason: 'lead requested a second second-opinion — one hop is the bound' }
    }
    // Compounding policy (code-owned): synthesis by the lead, but divergence
    // is never silent, and it binds in exactly one direction —
    //   lead=accept vs advisor=escalate  -> ESCALATE (one judge asking for a
    //     human is enough on the lenient path; compounding may only ever
    //     strengthen an outcome toward safety, never weaken it);
    //   any other split -> lead prevails, dissent recorded for the human.
    if (recommendation && recommendation !== second.decision) {
      const dissent = { from, recommendation, lead_decision: second.decision, consult: S.consults }
      S.dissents.push(dissent)
      io.log({ at: io.now(), dissent })
      if (second.decision === 'accept' && recommendation === 'escalate') {
        return { decision: 'escalate', reason: `lead accepted but ${from} independently recommended escalate — on the lenient path a single judge asking for a human is binding` }
      }
    }
    return second
  }

  function askLead(question, options, contextPaths, { round, targets }) {
    const briefPath = art(`decision-${S.consults}${round === 2 ? 'b' : ''}.md`)
    const valve = round === 1 && targets.length > 0
      ? [`- ${SECOND_OPINION} (set details.from to one of: ${targets.join(', ')} — code will gather their independent view and re-ask you once)`]
      : []
    io.writeFile(briefPath, [
      `# Decision needed (consult ${S.consults}${round === 2 ? ', final round' : ''})`, '',
      `## Question`, question, '',
      `## Your options (answer with exactly one in details.decision)`,
      ...options.map((o) => `- ${o}`),
      ...valve, '',
      `## Context files (read before deciding)`,
      ...contextPaths.map((x) => `- ${x}`), '',
      `Reply with a ReturnEnvelope whose details are {"decision": <option>, "reason": "...", "guidance": "..."${round === 1 ? ', "from": "<role>" when requesting a second opinion' : ''}}.`,
      `guidance is REQUIRED when decision is bounce — it becomes the bounce brief's steer.`,
    ].join('\n'))
    const env = assignAndWait('lead', briefPath, round === 2 ? 'decision-final' : 'decision')
    const d = env.details || {}
    // Round 2: a repeat second-opinion passes through raw so consultLead can
    // name the one-hop bound precisely in its escalation reason.
    if (round === 2 && env.status === 'done' && d.decision === SECOND_OPINION) {
      return { decision: SECOND_OPINION }
    }
    const allowed = round === 1 && targets.length > 0 ? [...options, SECOND_OPINION] : options
    if (env.status !== 'done' || !allowed.includes(d.decision)) {
      return { decision: 'escalate', reason: `lead returned ${env.status}/${d.decision ?? 'no decision'} — treating as escalate` }
    }
    io.log({ at: io.now(), decision: d.decision, consult: S.consults, round, reason: d.reason })
    return { decision: d.decision, reason: d.reason || '', guidance: d.guidance || '', from: d.from }
  }

  function escalate(where, why, extraArtifacts = []) {
    stage(`escalate:${where}`)
    return {
      status: 'escalation',
      summary: `Task ${ctx.task} needs a human: ${why}`,
      artifacts: [journal, ...extraArtifacts],
      details: { stages: S.stages, escalation: { where, why }, commit: null, dissents: S.dissents },
    }
  }

  // Fired at most once per run: the plan viewer is a singleton. Today plan
  // acceptance happens exactly once, so this is defensive — a future re-entry
  // into acceptance must never mount a second pane.
  let docShown = false

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

  const planPath = planEnv.details?.plan_path || art('plan.md')
  // Put the plan of record on screen, once (io.showDoc is OPTIONAL — an io
  // without it behaves exactly as before, stage sequence included). cmux's
  // markdown viewer live-watches the file and the plan path is stable for the
  // whole task, so ONE mount covers every later revision: there is deliberately
  // no close-and-remount cycle here.
  if (!docShown) { docShown = true; io.showDoc?.(planPath) }

  const scopeFiles = planEnv.details?.files_in_scope
  if (!Array.isArray(scopeFiles) || scopeFiles.length === 0) {
    return escalate('plan', 'planner envelope carries no files_in_scope — the scope gate cannot run without it', planEnv.artifacts || [])
  }
  const lane = planEnv.details?.validation_lane || ctx.lane
  if (!lane) return escalate('plan', 'no validation lane (neither planner envelope nor --lane provided)')

  // ---- 1c. ACCEPTANCE GATE, gate-first (fusion-harness pattern) ---------------
  // The planner may author an executable acceptance gate in the TASK DIR
  // (outside the repo — immutable to the builder by construction): a command
  // that exits 0 iff what-was-asked is what-got-built. Two rules, enforced
  // mechanically: the gate is written BEFORE any build, and the BASELINE run
  // must fail RED — a green baseline means the gate is vacuous or the work
  // already exists, and either way the planner hears about it loudly (the
  // exact defect class the v2 plan review caught by hand, mechanized).
  let gateCmd = planEnv.details?.gate_cmd || null
  let gateRepairs = 0
  let gateReverified = null // set only when a MID-RUN repair is accepted:
                            // true = proven red on the pristine tree,
                            // false = io has no runClean, the proof could not run
  const gateHistory = [] // every replaced gate_cmd, for the human's audit trail
  if (gateCmd) {
    stage('gate-baseline')
    const baseline = io.run(gateCmd)
    if (baseline.ok) {
      stage('gate-baseline:green-bounce')
      const b = art('gate-vacuous-bounce.md')
      io.writeFile(b, `# Gate bounce: baseline ran GREEN\n\nYour acceptance gate passed BEFORE any work was built. Either the gate does not actually check the requested change, or the work already exists. Fix the gate (or report the work as already done via status insufficient):\n\n    ${gateCmd}\n\nOutput:\n${baseline.output.slice(-2000)}\n\nOriginal brief: ${ctx.briefFile}`)
      const env2 = assignAndWait('planner', b, 'gate-fix')
      if (env2.status !== 'done' || !env2.details?.gate_cmd) {
        return escalate('gate', `baseline-green gate could not be repaired (planner returned ${env2.status}: ${env2.summary || 'no detail'})`)
      }
      gateHistory.push(gateCmd)
      gateCmd = env2.details.gate_cmd
      const re = io.run(gateCmd)
      if (re.ok) return escalate('gate', 'repaired gate STILL green at baseline — vacuous acceptance cannot be built against')
    }
  }

  // ---- 2. BUILD + mechanical gates + REVIEW ------------------------------------
  let buildBrief = planPath
  let buildNote = 'build'
  let builderEnv = null
  let reviews = 0
  // The finish block runs ONLY when `accepted` is set — at review:pass or at
  // an explicit lead accept. No bounce, however granted, can fall out of the
  // loop into a commit: a final-round consult that grants "bounce once more"
  // EXTENDS the bound by one real round instead (bounded in turn by the
  // consult limit, so a looping judge still cannot loop the driver).
  let accepted = null
  let extraRounds = 0
  let gateTriaged = false
  build:
  for (let round = 1; round <= limits.build_rounds + extraRounds; round += 1) {
    const finalRound = () => round >= limits.build_rounds + extraRounds
    stage(`build:r${round}`)
    const env = assignAndWait('builder', buildBrief, buildNote)
    if (env.status !== 'done') {
      const c = consultLead(
        `The builder returned status=${env.status} on round ${round}: ${env.summary || ''}. Bounce with guidance, or escalate?`,
        ['bounce', 'escalate'], [buildBrief, ...(env.artifacts || [])],
      )
      if (c.decision === 'escalate') return escalate('build', c.reason, env.artifacts || [])
      if (finalRound()) extraRounds += 1 // the granted bounce needs a round to land in
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
      if (finalRound()) return escalate('scope', `out-of-scope edits persisted: ${outOfScope.join(', ')}`)
      const b = art(`build-bounce-r${round}.md`)
      io.writeFile(b, `# Scope bounce (round ${round})\n\nThese files are OUTSIDE the plan's scope — revert them or stop touching them:\n${outOfScope.map((f) => `- ${f}`).join('\n')}\n\nIn-scope set:\n${scopeFiles.map((f) => `- ${f}`).join('\n')}\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'scope-fix'
      continue
    }

    // Gate B (mechanical): the validation lane, run by code.
    stage(`lane:r${round}`)
    const laneRes = io.run(lane)
    if (!laneRes.ok) {
      if (finalRound()) {
        const c = consultLead(
          `The validation lane is still red after ${round} rounds. Bounce once more with guidance, or escalate?`,
          ['bounce', 'escalate'], [planPath, journal],
        )
        if (c.decision !== 'bounce') return escalate('lane', c.reason)
        extraRounds += 1
      }
      const b = art(`build-bounce-r${round}.md`)
      io.writeFile(b, `# Lane bounce (round ${round})\n\nThe validation lane is RED. Make it green:\n\n    ${lane}\n\nFailures:\n${laneRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
      buildBrief = b; buildNote = 'lane-fix'
      continue
    }

    // Gate B2 (mechanical): the acceptance gate, when the plan authored one.
    // Failures feed back VERBATIM; repeated failures trigger ONE build-vs-gate
    // defect triage by the reviewer (closed enum); a gate defect lets the
    // planner repair its own gate ONCE (old gate preserved in gateHistory),
    // and the repaired gate re-runs immediately WITHOUT consuming a builder
    // round. The repair contract forbids weakening any legitimate check. When
    // the io supports it, the repaired gate is re-proved red on the pristine
    // (pre-build) tree before it is trusted against the already-built tree.
    if (gateCmd) {
      stage(`gate:r${round}`)
      let gateRes = io.run(gateCmd)
      if (!gateRes.ok && round >= limits.gate_fails_to_triage && !gateTriaged && gateRepairs < limits.gate_repairs) {
        gateTriaged = true
        const tBrief = art(`gate-triage-r${round}.md`)
        io.writeFile(tBrief, `# Gate triage (round ${round})\n\nThe acceptance gate keeps failing. Decide which is defective — read the plan at ${planPath} then the gate command and its output, then the diff in ${ctx.checkout}.\n\nGate: ${gateCmd}\nOutput:\n${gateRes.output.slice(-3000)}\n\nReply with details {"defect": "build" | "gate", "reason": "..."}.`)
        const triage = assignAndWait('reviewer', tBrief, 'gate-triage')
        if (triage.status === 'done' && triage.details?.defect === 'gate') {
          gateRepairs += 1
          stage(`gate-repair:${gateRepairs}`)
          const rBrief = art('gate-repair-bounce.md')
          io.writeFile(rBrief, `# Gate repair (one allowed per task)\n\nThe reviewer diagnosed a GATE DEFECT: ${triage.details?.reason || ''}\n\nPreserve your old gate under a .r1 suffix, then fix the gate so it checks exactly what the brief asked — you may NOT weaken any legitimate check. Return the (possibly identical) gate_cmd in details.\n\nGate: ${gateCmd}\nPlan: ${planPath}\nBrief: ${ctx.briefFile}`)
          const rep = assignAndWait('planner', rBrief, 'gate-repair')
          if (rep.status === 'done' && rep.details?.gate_cmd) {
            gateHistory.push(gateCmd)
            gateCmd = rep.details.gate_cmd
            // The mid-run twin of the baseline red-proof. A repaired gate is
            // handed to a tree that is already built, where a WEAKENED gate
            // goes green in one step and walks the run to commit. So prove it
            // still fails on the pre-build tree first. io.runClean is optional:
            // an io without it keeps today's behavior exactly (additive, never
            // breaking a DI user).
            gateReverified = false
            if (typeof io.runClean === 'function') {
              stage(`gate-reverify:${gateRepairs}`)
              const pristine = io.runClean(gateCmd)
              if (pristine.ok) {
                return escalate('gate', `repaired gate is STILL green at baseline (pristine tree, builder's changes set aside): ${gateCmd} — vacuous acceptance cannot be built against`)
              }
              gateReverified = true
            }
            gateRes = io.run(gateCmd) // re-run immediately; no builder round consumed
          }
        }
      }
      if (!gateRes.ok) {
        if (finalRound()) {
          const c = consultLead(
            `The acceptance gate is still red after ${round} build rounds. Bounce once more with guidance, or escalate?`,
            ['bounce', 'escalate'], [planPath, journal],
          )
          if (c.decision !== 'bounce') return escalate('gate', c.reason)
          extraRounds += 1
        }
        const b = art(`build-bounce-r${round}.md`)
        io.writeFile(b, `# Gate bounce (round ${round})\n\nThe ACCEPTANCE GATE is red — the build does not yet do what was asked. The gate is immutable to you; make the build satisfy it:\n\n    ${gateCmd}\n\nFailures (verbatim):\n${gateRes.output.slice(-4000)}\n\nPlan: ${planPath}`)
        buildBrief = b; buildNote = 'gate-fix'
        continue
      }
    }

    // Gate C (judgment, but enum-consumed): the reviewer. An unreadable
    // verdict re-asks the REVIEWER in place — the builder is never re-run
    // for a reviewer's malformed envelope.
    while (true) {
      if (reviews >= limits.review_rounds) {
        const c = consultLead(
          `Review rounds are exhausted (${reviews}) and the last verdict was revise. Accept with residuals, or escalate?`,
          ['accept', 'escalate'], [planPath, art('review.md')],
        )
        if (c.decision === 'escalate') return escalate('review', c.reason)
        accepted = 'lead accepted with residuals (review rounds exhausted)'
        break build
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
      if (v === 'pass') { stage('review:pass'); accepted = 'review pass'; break build }
      if (v === 'revise') {
        if (finalRound()) {
          const c = consultLead(
            `Build rounds are exhausted but the review says changes-needed. Accept with residuals, or escalate?`,
            ['accept', 'escalate'], [planPath, review.details?.review_path || art('review.md')],
          )
          if (c.decision === 'escalate') return escalate('review', c.reason)
          accepted = 'lead accepted with residuals (build rounds exhausted)'
          break build
        }
        const b = art(`build-bounce-r${round}.md`)
        io.writeFile(b, `# Review bounce (round ${round})\n\nClose every must-fix in the review at ${review.details?.review_path || art('review.md')}. Plan: ${planPath}`)
        buildBrief = b; buildNote = 'review-fix'
        continue build
      }
      const c = consultLead(
        `The reviewer returned an unreadable verdict (status=${review.status}, verdict=${review.details?.verdict}). Bounce the reviewer, or escalate?`,
        ['bounce', 'escalate'], [revBrief, ...(review.artifacts || [])],
        { exclude: 'reviewer' },
      )
      if (c.decision === 'escalate') return escalate('review', c.reason)
      reviews -= 1 // the re-ask replaces the unreadable round; loop re-asks in place
    }
  }
  if (!builderEnv || !accepted) {
    return escalate('build', `no accepted build within ${limits.build_rounds + extraRounds} rounds`)
  }

  // ---- 3. FINISH: full suite (code) + commit-on-green (code) --------------------
  stage('suite')
  const suiteRes = io.run(ctx.suite)
  if (!suiteRes.ok) {
    return escalate('suite', `full suite red after acceptance — this needs eyes:\n${suiteRes.output.slice(-2000)}`)
  }
  stage('commit')
  const message = builderEnv.details?.commit_message
    || `crew(${ctx.task}): ${builderEnv.summary?.split('\n')[0] || 'task change'}`
  S.commit = io.commit(scopeFiles, message)
  stage('done')

  return {
    status: 'done',
    summary: `Task ${ctx.task} complete: committed ${S.commit} (${scopeFiles.length} files), suite green, ${accepted}. Stages: ${S.stages.join(' | ')}`,
    artifacts: [planPath, art('review.md'), journal],
    details: {
      commit: S.commit, stages: S.stages, files_committed: scopeFiles, consults: S.consults,
      dissents: S.dissents, accepted_via: accepted, escalation: null,
      gate: gateCmd ? { cmd: gateCmd, repairs: gateRepairs, ...(gateHistory.length ? { replaced: gateHistory } : {}), ...(gateReverified !== null ? { reverified: gateReverified } : {}) } : null,
    },
  }
}
