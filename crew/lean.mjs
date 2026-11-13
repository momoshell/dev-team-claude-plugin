// crew lean <spec.json>: the detached entry of `crew start` (ADR-052). It runs the
// standard loop (crew/loop.mjs) with each seat turn played over ACP (crew/acp/seat.mjs), records
// every turn under <taskDir>/lean/<role>/<id>.jsonl, and ends with one terminal row in the run log.
// Import-safe: importing this module launches nothing; every effect crosses an injected seam.
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpSeat } from './acp/seat.mjs'
import { openMemory, renderSection } from './memory.mjs'
import { acpProviderFailureKind, acpTextReset, providerRetryDecision, PROVIDER_RETRY_TOTAL_WAIT_MS } from './acp/provider.mjs'
import { runLoop } from './loop.mjs'
import { withRunOverride } from './agents.mjs'
import { AGENT_ROLES, parseAgent } from './protocols.mjs'
import { loadMap, resolveSeatSkills } from '../hooks/skill-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHARTER_LINK = /\]\((\.\.?\/[^)\s]+\.md)\)/g
const MAX_DROPPED = 10
const LOOP_STAGES = 'The loop runs each test the builder names on the old source and on the build. It then runs the suite, commits, rebases and opens the PR. Do not run those stages yourself.'
const stopped = (reason) => ({ status: 'stopped', reason, pr: null })

function recordState(leanDir, sessionFile) {
  try {
    const entries = []
    const walk = (path) => {
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        entries.push([relative(leanDir, path), 'dir'])
        for (const name of readdirSync(path).sort()) walk(join(path, name))
      } else if (path !== sessionFile) {
        if (stat.isFile()) entries.push([relative(leanDir, path), 'file', createHash('sha256').update(readFileSync(path)).digest('hex')])
        else if (stat.isSymbolicLink()) entries.push([relative(leanDir, path), 'link', readlinkSync(path)])
        else throw new Error('unsupported lean record entry')
      }
    }
    walk(leanDir)
    return JSON.stringify(entries)
  } catch { return null }
}

// The P2 shape this turn must write; the role's own detail keys, with the issued role and id.
function exampleEnvelope(role, id, tier, testsRequired) {
  const review = {
    verdict: 'changes-needed',
    findings: [{ id: 'R1', severity: 'must-fix', location: 'path/to/file.mjs:10', summary: 'what breaks', trigger: 'the concrete state that breaks it', start_line: 10, end_line: 10, uncertain: 'what was not verified' }],
    requirements: [{ requirement: 'the brief asks for this', status: 'unmet', evidence: 'what was read' }],
    failure_modes: [{ breaks: 'what breaks', where: 'where it breaks', trigger: 'when it breaks', tested: false, covered: false }],
    coverage: { read: ['paths read'], complete: true },
  }
  const details = {
    planner: {
      subject: 'fix(crew): publish measured lane results',
      plan_path: '<absolute path of the plan you wrote>',
      tests: [{ file: '<repo-relative test file>', title: '<exact test title>' }],
      files_in_scope: ['<repo-relative file the build touches>'],
      validation_lane: '<the node --test command that checks the change>',
    },
    builder: {
      summary: '<what you built>',
      ...(tier === 'mechanical' ? { subject: 'docs(crew): correct a lane brief typo' } : {}),
      ...(testsRequired === false ? {} : { tests: [{ file: '<repo-relative test file>', title: '<exact test title>' }] }),
      notes: '<what you did not test, the guards you relied on, the checks you ran>',
    },
    reviewer: review,
    'tech-lead': review,
    lead: { decision: 'bounce', target: 'builder', instructions: '<what the bounced seat must do>' },
  }[role]
  return { role, id, status: 'done', summary: '<one line>', details }
}

// The definition one turn runs: the file's fields with the tier override applied, then the
// received cell's agent, effort and model, which the loop resolved from the same definitions.
function definitionFor({ role, seat, filesInScope }, tier, d, overrides) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`unknown role ${JSON.stringify(role)}`)
  const source = join(HERE, 'agents', `${role}.md`)
  const parsed = parseAgent(d.readFileSync(source, 'utf8'))
  const { body, defects } = parsed
  if (defects.length) throw new Error(`agent definition ${source} is refused:\n- ${defects.join('\n- ')}`)
  const fields = withRunOverride(parsed.fields, Object.hasOwn(overrides ?? {}, role) ? overrides[role] : undefined)
  const override = fields.tiers?.[tier]
  if (override === null) throw new Error(`role ${role} is unseated at tier ${tier}`)
  const effective = { ...fields, ...override }
  const laneRole = ['builder', 'reviewer', 'tech-lead'].includes(role)
  let skills = effective.skills ?? []
  if (laneRole) {
    const loaded = loadMap(dirname(HERE), { requireSkillFiles: false })
    if (!loaded.ok) throw new Error(`skill map: ${loaded.reason}`)
    const selected = resolveSeatSkills({ map: loaded.map, role, files: filesInScope ?? null })
    skills = [...new Set([...skills, ...selected.skills.map((path) => path.split('/')[1])])]
  }
  const charters = [...body.matchAll(CHARTER_LINK)].map((link) => resolve(dirname(source), link[1]))
  return {
    definition: { role, agent: seat.agent, model: `${seat.provider}/${seat.id}`, effort: seat.effort, writes: effective.writes ?? 'none', skills, requires: effective.requires ?? [],
      tools: effective.tools,
      extensions: effective.extensions, advisor: effective.advisor,
      wait_s: effective.wait_s,
      body },
    source, charters, memory: effective.memory,
  }
}

// A repair turn: the work is done and its return file failed validation. Names the defects and the
// path, and asks for nothing but a corrected envelope there.
function repairPromptFor({ request, spec }) {
  const { role, id, returnPath, repair } = request
  return [
    'Your envelope was refused. Do not redo the assignment and do not edit any other file.',
    '',
    '## Defects',
    ...repair.defects.map((defect) => `- ${defect}`),
    '',
    '## Return',
    'Read the existing file at the return path below and keep its completed results. Write only a corrected',
    'P2 envelope, as JSON, to that same path; nothing else you write counts as your return.',
    `Envelope id: ${id}`,
    `Return path: ${returnPath}`,
    JSON.stringify(exampleEnvelope(role, id, request.tier ?? spec.tier, request.testsRequired), null, 2),
    'status is done, insufficient or escalate; use insufficient or escalate instead of faking a done.',
    '',
  ].join('\n')
}

function promptFor({ request, spec, source, charters, body, section }) {
  const { role, id, returnPath, brief, planPath, feedback } = request
  const lines = [
    body,
    '',
    `Definition source: ${source}`,
    ...charters.map((charter) => `Charter file (relative links in the definition resolve from ${dirname(source)}): ${charter}`),
    ...(role === 'builder' ? [] : ['', LOOP_STAGES]),
    '',
    '## Brief',
    brief,
    ...(planPath ? ['', `Plan path: ${planPath}`] : []),
    ...(role === 'builder' && Array.isArray(spec.builderChecks) && spec.builderChecks.length ? ['', '## Project checks', "Before returning, run each line below in the checkout, as written. They are this project's own fast checks and an exception to the rule against running whole packages. Report each line's command and result in `notes`. The loop does not run them or read their result; the suite stays the gate.", ...spec.builderChecks.map((check) => `- ${check}`)] : []),
    ...(role === 'reviewer' && spec.shape !== 'finish' && !request.deltaReview && !request.reserveReview && !request.recheckReview ? ['', '## Full review', 'No earlier reviewed tree is given: review the whole diff. The round-2 must-fix limit does not apply; any defect in the diff may be a must-fix. Still carry or close each earlier must-fix.'] : []),
    ...(request.recheckReview ? ['', '## Recheck review', `Compare git diff ${request.recheckReview.reviewed}^ ${request.recheckReview.reviewed} with git diff ${request.recheckReview.onto} ${request.recheckReview.rebased} to inspect lane code the rebase or the conflict turn altered. Use git diff ${request.recheckReview.reviewed}^ ${request.recheckReview.onto} to inspect the base's new commits. A must-fix is an earlier finding still unresolved, a defect in lane code the rebase or the conflict turn altered, or a defect where the base's new commits meet the lane's change. A new problem elsewhere in the already-reviewed diff is a should-fix.`] : []),
    ...(request.deltaReview ? ['', '## Delta review', `A must-fix must be an earlier finding still unresolved or a defect in code changed since tree ${request.deltaReview.baseTree}. Use git diff ${request.deltaReview.baseTree} to inspect the delta. Raise a new problem elsewhere as a should-fix.`] : []),
    ...(['reviewer', 'tech-lead'].includes(role) ? ['', '## Builder report', `Tests: ${JSON.stringify(request.builderReport?.tests ?? [])}`, `Notes: ${JSON.stringify(request.builderReport?.notes ?? null)}`, '', '## Changed paths', ...request.changedPaths.map((path) => `- ${JSON.stringify(path)}`)] : []),
    ...(section ? ['', section] : []),
    ...(request.reserveReview ? ['', '## Reserve re-review', `Review only the fix since tree ${request.reserveReview.baseTree} against the prior findings below, including regressions introduced by that fix. Use git diff ${request.reserveReview.baseTree} to inspect the fix. Do not raise unrelated defects in the earlier diff. This is the final review: pass or stop.`] : []),
    '',
    '## Feedback',
    JSON.stringify(feedback ?? []),
    '',
    '## Return',
    'This ACP turn has no submit_envelope tool. When the work is done, write your envelope as JSON',
    'directly to the return path below. This P2 shape overrides any envelope or submission instruction',
    'in the definition or charter above; nothing else you write counts as your return.',
    `Envelope id: ${id}`,
    `Return path: ${returnPath}`,
    `Task directory: ${spec.taskDir}`,
    JSON.stringify(exampleEnvelope(role, id, request.tier ?? spec.tier, request.testsRequired), null, 2),
    'status is done, insufficient or escalate; use insufficient or escalate instead of faking a done.',
    '',
  ]
  return lines.join('\n')
}

export async function runLean(spec, deps = {}) {
  const d = {
    runAcpSeat, readFileSync, mkdirSync, writeFileSync, appendFileSync, rmSync, recordState,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
    loopDeps: {},
    ...deps,
  }

  const prompts = new Map()
  const runSeat = async (request, { emit }) => {
    const { definition, source, charters, memory } = definitionFor(request, request.tier ?? spec.tier, d, spec.roster?.snapshot ?? spec.roster?.overrides)
    const { role, id } = request
    let recording = { definition }
    try {
    let sectionText = ''
    if (!request.repair) {
      if (memory === true) {
        const dir = process.env.CREW_MEMORY_DIR || join(spec.cwd, '.claude', 'dev-team', 'memory')
        const extract = openMemory({ dir }).context({ task: request.brief, role })
        const section = renderSection(extract)
        if (!section) {
          const dropped = extract.dropped ?? []
          await emit('memory-empty', { role, id, reason: extract.reason ?? 'empty', dropped: dropped.slice(0, MAX_DROPPED), dropped_omitted: Math.max(0, dropped.length - MAX_DROPPED) })
        } else sectionText = section
      }
    }
    const baseStem = request.repair ? `${id}.repair` : id
    const prompt = request.rerun && prompts.has(baseStem) ? prompts.get(baseStem) : request.repair ? repairPromptFor({ request, spec }) : promptFor({ request, spec, source, charters, body: definition.body, section: sectionText })
    if (request.rerun) prompts.delete(baseStem)
    else prompts.set(baseStem, prompt)
    d.mkdirSync(join(spec.taskDir, 'lean', role), { recursive: true })
    const stem = `${baseStem}${request.rerun ? '.rerun' : ''}`
    // A provider failure is retried in a fresh ACP session inside the shared bounds. The issued id,
    // prompt and definition stay the same; each attempt records to its own session file.
    let attempts = 0, waitedMs = 0
    for (;;) {
      const sessionFile = join(spec.taskDir, 'lean', role, attempts === 0 ? `${stem}.jsonl` : `${stem}.retry-${attempts}.jsonl`)
      // 'wx': a turn id is issued once, so an existing recording is never appended to or reused.
      const header = `${JSON.stringify({ type: 'prompt', text: prompt })}\n`
      d.writeFileSync(sessionFile, header, { flag: 'wx' })
      // runAcpSeat swallows a failed append; the first one is kept and fails the turn afterwards.
      // The relayed copy serves the muse integrity check and the tool-call count.
      let recordError = null
      const relayed = []
      const guardedAppend = (...args) => {
        try { const out = d.appendFileSync(...args); if (args[0] === sessionFile) relayed.push(String(args[1])); return out } catch (error) { recordError ??= error; throw error }
      }
      const checkRecords = definition.agent === 'muse' && definition.writes !== 'none'
      const fingerprint = () => { try { return d.recordState(join(spec.taskDir, 'lean'), sessionFile) } catch { return null } }
      const violation = (reason) => Object.assign(new Error(reason), { reason })
      const before = checkRecords ? fingerprint() : null
      if (checkRecords && typeof before !== 'string') throw violation('acp-seat-record-unmeasured')
      let turn, turnError, failed = false
      try {
        turn = await d.runAcpSeat({
          definition, cwd: spec.cwd, taskDir: spec.taskDir, prompt, sessionFile, briefText: spec.brief,
          deps: { appendFileSync: guardedAppend },
        })
        if (recordError) throw recordError
        // The runtime writes the one turn row of every turn, accepted or not.
        guardedAppend(sessionFile, `${JSON.stringify({ type: 'turn', stopReason: turn?.stopReason ?? null, usage: turn?.usage ?? null, refusal: turn?.refusal ?? null, ...(typeof turn?.usage_reason === 'string' ? { usage_reason: turn.usage_reason } : {}) })}\n`, 'utf8')
      } catch (error) {
        failed = true
        if (error?.method === 'session/new' && acpProviderFailureKind(error.errorKind, error.errorMessage) === 'authentication_failed') {
          if (!Object.isExtensible(error)) error = Object.assign(new Error(String(error.message ?? error)), { reason: error.reason, code: error.code, method: error.method, errorKind: error.errorKind, errorMessage: error.errorMessage })
          error.providerKind = 'authentication_failed'
        }
        turnError = error
      }
      // Compare the file with the relayed copy for the muse integrity check.
      const recorded = relayed.join('')
      let intact = false
      try { intact = d.readFileSync(sessionFile, 'utf8') === header + recorded } catch { /* unreadable is not intact */ }
      const toolIds = new Set()
      for (const line of recorded.split('\n')) {
        try {
          const update = JSON.parse(line)?.update
          if (update?.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string') toolIds.add(update.toolCallId)
        } catch { /* skip malformed session lines */ }
      }
      recording = { definition, stopReason: turn?.stopReason ?? null, usage: turn?.usage ?? null, ...(typeof turn?.usage_reason === 'string' ? { usage_reason: turn.usage_reason } : {}), toolCalls: recordError ? null : toolIds.size }
      if (checkRecords) {
        const after = fingerprint()
        if (typeof after !== 'string') throw violation('acp-seat-record-unmeasured')
        if (after !== before || !intact) throw violation('acp-seat-wrote-record')
      }
      if (failed) throw turnError
      if (turn?.refusal || !turn?.stopReason) {
        const failure = Object.assign(new Error(turn?.refusal?.message ?? 'ACP seat turn returned no stop reason'), { code: turn?.refusal?.code ?? null, errorKind: turn?.refusal?.errorKind ?? null })
        if (!turn?.refusal) throw failure
        const kind = acpProviderFailureKind(turn?.refusal?.errorKind, turn?.refusal?.errorMessage)
        if (kind !== null) failure.providerKind = kind
        const at = d.now()
        const reset = kind === 'rate_limit' ? acpTextReset(turn.refusal.message, at) : null
        const decision = providerRetryDecision({ kind, reset, attempts, waitedMs, at })
        if (!decision.retry) throw failure
        await d.sleep(decision.wait_ms)
        // The wait actually taken counts, never less than the one intended; an oversleep that crosses the bound buys no replacement.
        waitedMs += Math.max(decision.wait_ms, d.now() - at)
        if (waitedMs > PROVIDER_RETRY_TOTAL_WAIT_MS) throw failure
        // The refused attempt's envelope was never earned: the replacement must write its own or leave none.
        if (request.returnPath) d.rmSync(request.returnPath, { force: true })
        attempts += 1
        recording = { definition }
        continue
      }
      return recording
    }
    } catch (error) {
      if (['acp-seat-wrote-repo', 'acp-seat-repo-unmeasured', 'acp-seat-wrote-record', 'acp-seat-record-unmeasured'].includes(error?.reason) && request.returnPath) {
        try { d.rmSync(request.returnPath, { force: true }) } catch { /* preserve the turn error */ }
      }
      if (!error || typeof error !== 'object' || !Object.isExtensible(error)) {
        error = Object.assign(new Error(String(error?.message ?? error)), { code: error?.code ?? null, providerKind: error?.providerKind })
      }
      error.recording = recording
      throw error
    }
  }

  let result
  try { result = await runLoop(spec, { ...d.loopDeps, runSeat }) } catch (error) {
    let described
    try { described = { code: error?.code ?? null, message: String(error?.message ?? error) } } catch { described = { code: null, message: 'unprintable error' } }
    result = { ...stopped('runner-threw'), error: described }
  }
  d.log(JSON.stringify({ event: 'loop-result', ...result }))
  return result
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = { readFileSync, log: (line) => process.stdout.write(`${line}\n`), ...deps }
  if (argv.length !== 1 || argv[0].startsWith('--')) {
    process.stderr.write('usage: crew lean <spec.json>\n')
    return 2
  }
  let spec
  try { spec = JSON.parse(d.readFileSync(resolve(argv[0]), 'utf8')) } catch (error) {
    process.stderr.write(`crew lean: cannot read the spec ${argv[0]}: ${error?.code ?? error?.message}\n`)
    d.log(JSON.stringify({ event: 'loop-result', ...stopped('invalid-input') }))
    return 1
  }
  try {
    const result = await runLean(spec, deps)
    return result.status === 'done' ? 0 : 1
  } catch (error) {
    process.stderr.write(`crew lean: the terminal row could not be written: ${error?.code ?? error?.message}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
