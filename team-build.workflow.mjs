export const meta = {
  name: 'team-build',
  description: 'Deterministic dev-team pipeline: domain leads produce Handover Specs, executors implement them (with one amend-retry on insufficient), then a spec-anchored gate (review tier per the ladder + build-validator) verifies — fanned out under the concurrency cap.',
  phases: [
    { title: 'Plan', detail: 'each task → domain lead → Handover Spec' },
    { title: 'Build', detail: 'each spec → executor (coder, or test-engineer for qa) → structured return (amend-retry on insufficient)' },
    { title: 'Gate', detail: 'each result → review (standard/deep per ladder) + build-validator, in parallel' },
  ],
}

// args: { goal: string, projectMemory?: string,
//         tasks: [{ id?: string, domain, brief, files?: string[], depends_on?: string[] }] }
// `id` defaults to `t<index>`. `depends_on` lists the ids of tasks that must PASS the gate
// before this one runs — the scheduler orders tasks into dependency waves (see below).
const goal = args?.goal ?? 'unspecified goal'
const projectMemory = args?.projectMemory ?? '(no project memory provided)'
const rawTasks = Array.isArray(args?.tasks) ? args.tasks : []

// Normalize: assign stable ids and a clean depends_on list, preserving input order.
const tasks = rawTasks.map((t, i) => ({
  ...t,
  id: t?.id != null ? String(t.id) : `t${i}`,
  depends_on: Array.isArray(t?.depends_on) ? t.depends_on.map(String) : [],
  _index: i,
}))
const idSet = new Set(tasks.map((t) => t.id))

const LEAD = {
  frontend: 'dev-team:frontend-lead',
  backend: 'dev-team:backend-lead',
  devops: 'dev-team:devops-lead',
  qa: 'dev-team:qa-lead',
}

const SPEC_SCHEMA = {
  type: 'object',
  required: ['task_id', 'domain', 'goal', 'files_in_scope', 'constraints', 'acceptance_criteria', 'validation_commands', 'discovery_context', 'out_of_scope', 'depends_on', 'interface_contract'],
  additionalProperties: false,
  properties: {
    task_id: { type: 'string' },
    domain: { type: 'string', enum: ['frontend', 'backend', 'devops', 'qa'] },
    goal: { type: 'string' },
    files_in_scope: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    acceptance_criteria: { type: 'array', items: { type: 'string' } },
    validation_commands: { type: 'array', items: { type: 'string' } },
    discovery_context: { type: 'string' },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    depends_on: { type: 'array', items: { type: 'string' } },
    interface_contract: { type: 'string' },
  },
}

const RETURN_SCHEMA = {
  type: 'object',
  required: ['status', 'reason'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'insufficient', 'blocked'] },
    reason: { type: 'string' },
    missing_context: { type: 'string', description: 'Required when status is insufficient: exactly what the coder needs (file, contract, decision).' },
    changes: { type: 'array', items: { type: 'string' }, description: "Each item formatted '<path> — <one-line summary>'." },
    validation: { type: 'string' },
  },
  // Mirror coder-return.schema.json: an insufficient return must say what's missing.
  if: { properties: { status: { const: 'insufficient' } } },
  then: { required: ['missing_context'] },
}

const BUILD_SCHEMA = {
  type: 'object',
  required: ['pass', 'summary'],
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    summary: { type: 'string', description: 'One line: "clean", or the key compile/build errors.' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['pass'],
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

// `architecture` is intentionally NOT a workflow domain — architecture-lead does Tier-3
// interactive TRD/design work, not coder-executable specs. Unknown domains fall back to backend-lead.
const leadFor = (domain) => LEAD[domain] || 'dev-team:backend-lead'

// QA tasks are executed by the test-engineer (write/run tests), everything else by the coder.
const executorFor = (domain) => (domain === 'qa' ? 'dev-team:test-engineer' : 'dev-team:coder')

// Review ladder (mirrors orchestration.md → QA gate). Deep triggers escalate the reviewer.
const DEEP_TRIGGERS = /\b(authn|authz|auth|authentication|authorization|secrets?|credentials?|encrypt(?:ion|ed|ing|s)?|tokens?|payments?|pii|migrat(?:e|es|ion|ions|ing)|backfills?|destructive|drop\s+table|truncate|ci\/?cd|pipelines?|infra(?:structure)?|terraform|kubernetes|k8s|production|prod\b|deploy(?:s|ed|ing|ment|ments)?|public[\s-]*api|api[\s-]*contract|breaking[\s-]*change|backward[\s-]*compat(?:ible|ibility)?|security|incidents?|hotfix(?:es)?|code-reviewer-deep)\b/i

const reviewTierFor = (spec) => {
  if (spec.domain === 'devops') return 'deep' // infra/delivery is inherently high-risk
  const hay = [spec.goal, spec.interface_contract, ...(spec.constraints || []), ...(spec.acceptance_criteria || [])].join('\n')
  return DEEP_TRIGGERS.test(hay) ? 'deep' : 'standard'
}
const reviewerFor = (tier) => (tier === 'deep' ? 'dev-team:code-reviewer-deep' : 'dev-team:code-reviewer')

const planPrompt = (task, extra) =>
  `You are planning ONE task toward the goal: "${goal}".\n` +
  `Project memory: ${projectMemory} (read conventions + your domain notes if present; code wins over stale memory).\n` +
  `Task: ${task.brief}\n` +
  (task.files ? `Likely files: ${JSON.stringify(task.files)}\n` : '') +
  (extra ? `${extra}\n` : '') +
  `Produce ONE Handover Spec with every field populated. discovery_context must be complete enough that the coder never explores beyond files_in_scope.`

const buildPrompt = (spec) =>
  `Execute this Handover Spec exactly. Read only within files_in_scope, implement, run validation_commands, and end with the structured return.\n\n` +
  JSON.stringify(spec, null, 2)

const gatePrompt = (spec, tier) =>
  `Spec-anchored ${tier === 'deep' ? 'DEEP ' : ''}review. Verify the change satisfies these acceptance criteria:\n` +
  `${JSON.stringify(spec.acceptance_criteria, null, 2)}\n` +
  `Files to read: ${JSON.stringify(spec.files_in_scope)}.\n` +
  (tier === 'deep' ? `This is high-risk: build the risk map, validate rollback/idempotency, stress assumptions (races, partial failures), and check contract stability.\n` : '') +
  `Return pass=true only if every acceptance criterion is met; list findings otherwise.`

const buildCheckPrompt = (spec) =>
  `Type-check and build the project, then report. The changed files are: ${JSON.stringify(spec.files_in_scope)}.\n` +
  `Set pass=true only if BOTH the type-check and the build succeed; summary = one line ("clean", or the key errors).`

if (!tasks.length) {
  log('No tasks provided in args.tasks — nothing to do.')
  return { goal, total: 0, passed: 0, results: [] }
}

log(`team-build: ${tasks.length} task(s) for goal: ${goal}`)

// Run ONE task through the full plan → build → gate chain. Returns a uniform
// { task, spec, ret, verdict, passed } shape (passed mirrors verdict.pass).
const failed = (task, spec, ret, findings) => ({ task, spec, ret, verdict: { pass: false, findings, tier: null }, passed: false })

const runTask = async (task) => {
  const id = task.id
  if (!LEAD[task.domain]) log(`task ${id}: unknown domain '${task.domain}' → falling back to backend-lead`)

  // Carry upstream dependencies' contracts into planning so dependent specs stay coherent.
  const deps = task.depends_on.map((d) => finished.get(d)).filter(Boolean)
  const depNote = deps.length
    ? `Upstream dependencies already completed — honor their contracts:\n` +
      deps.map((o) => `- ${o.task.id} (${o.spec?.domain}): interface_contract = ${o.spec?.interface_contract || '—'}; files changed = ${JSON.stringify(o.ret?.changes ?? [])}`).join('\n')
    : ''

  // Stage 1 — domain lead produces a Handover Spec
  let spec = await agent(planPrompt(task, depNote), { agentType: leadFor(task.domain), schema: SPEC_SCHEMA, label: `plan:${task.domain}-${id}`, phase: 'Plan' })
  if (!spec) return failed(task, null, null, ['lead agent died — no spec'])

  // Stage 2 — executor implements; one amend-retry on insufficient
  const executor = executorFor(task.domain)
  let ret = await agent(buildPrompt(spec), { agentType: executor, schema: RETURN_SCHEMA, label: `build:${task.domain}-${id}`, phase: 'Build' })
  if (ret && ret.status === 'insufficient') {
    const gap = ret.missing_context || ret.reason
    const amendExtra = [depNote, `A coder found the prior spec insufficient: "${gap}". Amend the Handover Spec to resolve exactly that gap.`].filter(Boolean).join('\n\n')
    const amended = await agent(planPrompt(task, amendExtra), { agentType: leadFor(task.domain), schema: SPEC_SCHEMA, label: `amend:${task.domain}-${id}`, phase: 'Plan' })
    if (amended) {
      spec = amended
      ret = await agent(buildPrompt(spec), { agentType: executor, schema: RETURN_SCHEMA, label: `rebuild:${task.domain}-${id}`, phase: 'Build' })
    }
  }

  // Stage 3 — spec-anchored gate: review (tier per ladder) + build-validator in parallel
  if (!ret) return failed(task, spec, null, ['executor agent died — no result'])
  if (ret.status !== 'done') return failed(task, spec, ret, [`executor returned status=${ret.status}: ${ret.reason}`])

  const tier = reviewTierFor(spec)
  const [review, build] = await parallel([
    () => agent(gatePrompt(spec, tier), { agentType: reviewerFor(tier), schema: VERDICT_SCHEMA, label: `gate:${task.domain}-${id}`, phase: 'Gate' }),
    () => agent(buildCheckPrompt(spec), { agentType: 'dev-team:build-validator', schema: BUILD_SCHEMA, label: `build-check:${task.domain}-${id}`, phase: 'Gate' }),
  ])

  const findings = [...((review && review.findings) || [])]
  if (!review) findings.push('review agent died — verdict unavailable')
  if (!build) findings.push('build-validator died — build status unknown')
  else if (!build.pass) findings.push(`build failed: ${build.summary}`)

  const pass = Boolean(review && review.pass && build && build.pass)
  return { task, spec, ret, verdict: { pass, findings, tier }, passed: pass }
}

// Dependency-wave scheduler: a task is READY once every dependency has finished;
// it only RUNS if every dependency passed the gate — otherwise it's skipped.
// Tasks within a wave run concurrently (a parallel() barrier between waves).
const finished = new Map() // id -> { task, spec, ret, verdict, passed }
let remaining = tasks.slice()
let waveNo = 0

while (remaining.length) {
  const ready = remaining.filter((t) => t.depends_on.every((d) => !idSet.has(d) || finished.has(d)))

  if (!ready.length) {
    // No task can advance → a cycle (or a chain into one) among what's left.
    for (const t of remaining) finished.set(t.id, failed(t, null, null, [`skipped — dependency cycle or unresolvable dependency among: ${remaining.map((x) => x.id).join(', ')}`]))
    log(`team-build: dependency cycle among ${remaining.length} task(s) [${remaining.map((t) => t.id).join(', ')}] — skipped`)
    break
  }

  waveNo++
  log(`wave ${waveNo}: ${ready.length} task(s) [${ready.map((t) => t.id).join(', ')}]`)

  const outcomes = await parallel(ready.map((task) => async () => {
    const badDep = task.depends_on.find((d) => !idSet.has(d) || !(finished.get(d) && finished.get(d).passed))
    if (badDep) {
      const why = !idSet.has(badDep) ? `unknown dependency '${badDep}'` : `dependency '${badDep}' did not pass the gate`
      return failed(task, null, null, [`skipped — ${why}`])
    }
    return runTask(task)
  }))

  ready.forEach((task, k) => finished.set(task.id, outcomes[k] || failed(task, null, null, ['task chain died'])))
  const ranIds = new Set(ready.map((t) => t.id))
  remaining = remaining.filter((t) => !ranIds.has(t.id))
}

const clean = tasks.map((t) => finished.get(t.id)).filter(Boolean)
const passed = clean.filter((r) => r.passed)
log(`team-build done: ${passed.length}/${clean.length} passed the gate (${waveNo} wave(s))`)

return {
  goal,
  total: tasks.length,
  passed: passed.length,
  results: clean.map((r) => ({
    id: r.task?.id,
    domain: r.spec?.domain ?? r.task?.domain,
    task_id: r.spec?.task_id,
    status: r.ret?.status ?? 'skipped',
    pass: r.verdict?.pass ?? false,
    review_tier: r.verdict?.tier,
    changes: r.ret?.changes ?? [],
    findings: r.verdict?.findings ?? [],
  })),
}
