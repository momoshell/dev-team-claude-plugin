// crew lean <spec.json>: the detached entry of `crew start --loop lean` (ADR-052). It runs the
// standard loop (crew/loop.mjs) with each seat turn played over ACP (crew/acp/seat.mjs), records
// every turn under <taskDir>/lean/<role>/<id>.jsonl, and ends with one terminal row in the run log.
// Import-safe: importing this module launches nothing; every effect crosses an injected seam.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpSeat } from './acp/seat.mjs'
import { acpProviderFailureKind, acpTextReset, providerRetryDecision, PROVIDER_RETRY_TOTAL_WAIT_MS } from './headless.mjs'
import { runLoop } from './loop.mjs'
import { AGENT_ROLES, parseAgent } from './protocols.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHARTER_LINK = /\]\((\.\.?\/[^)\s]+\.md)\)/g
const stopped = (reason) => ({ status: 'stopped', reason, pr: null })

// The P2 shape this turn must write; the role's own detail keys, with the issued role and id.
function exampleEnvelope(role, id, acceptance) {
  const review = { verdict: 'pass', findings: [{ id: 'R1', severity: 'should-fix', location: 'path/to/file.mjs:10', summary: 'what is wrong and why' }] }
  const details = {
    planner: {
      subject: 'fix(crew): publish measured lane results',
      plan_path: '<absolute path of the plan you wrote>',
      gate_path: '<absolute path of the gate you wrote>',
      acceptance,
      mutations: acceptance.map((check) => ({ check, file: '<repo-relative file the gate reads>', find: '<literal text in that file>', replace: '<different literal text that makes this check fail>' })),
    },
    builder: { summary: '<what you built>' },
    reviewer: review,
    'tech-lead': review,
    lead: { decision: 'bounce' },
  }[role]
  return { role, id, status: 'done', summary: '<one line>', details }
}

// The definition one turn runs: the file's fields with the tier override applied, then the
// received cell's agent, effort and model, which the loop resolved from the same definitions.
function definitionFor({ role, seat }, tier, d) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`unknown role ${JSON.stringify(role)}`)
  const source = join(HERE, 'agents', `${role}.md`)
  const { fields, body, defects } = parseAgent(d.readFileSync(source, 'utf8'))
  if (defects.length) throw new Error(`agent definition ${source} is refused:\n- ${defects.join('\n- ')}`)
  const override = fields.tiers?.[tier]
  if (override === null) throw new Error(`role ${role} is unseated at tier ${tier}`)
  const effective = { ...fields, ...override }
  const charters = [...body.matchAll(CHARTER_LINK)].map((link) => resolve(dirname(source), link[1]))
  return {
    definition: { role, agent: seat.agent, model: `${seat.provider}/${seat.id}`, effort: seat.effort, writes: effective.writes ?? 'none', skills: effective.skills ?? [], requires: effective.requires ?? [],
      tools: effective.tools,
      extensions: effective.extensions, advisor: effective.advisor, edit_assist: effective.edit_assist, codemode: effective.codemode,
      wait_s: effective.wait_s,
      body },
    source, charters,
  }
}

function promptFor({ request, spec, source, charters, body }) {
  const { role, id, returnPath, brief, planPath, gatePath, feedback } = request
  const lines = [
    body,
    '',
    `Definition source: ${source}`,
    ...charters.map((charter) => `Charter file (relative links in the definition resolve from ${dirname(source)}): ${charter}`),
    '',
    '## Brief',
    brief,
    ...(planPath ? ['', `Plan path: ${planPath}`] : []),
    ...(gatePath ? [`Gate path: ${gatePath}`] : []),
    ...(role === 'reviewer' ? ['', '## Changed paths', ...request.changedPaths.map((path) => `- ${JSON.stringify(path)}`)] : []),
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
    JSON.stringify(exampleEnvelope(role, id, spec.acceptance), null, 2),
    'status is done, insufficient or escalate; use insufficient or escalate instead of faking a done.',
    '',
  ]
  return lines.join('\n')
}

export async function runLean(spec, deps = {}) {
  const d = {
    runAcpSeat, readFileSync, mkdirSync, writeFileSync, appendFileSync,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
    loopDeps: {},
    ...deps,
  }

  const runSeat = async (request) => {
    const { definition, source, charters } = definitionFor(request, spec.tier, d)
    const { role, id } = request
    const prompt = promptFor({ request, spec, source, charters, body: definition.body })
    d.mkdirSync(join(spec.taskDir, 'lean', role), { recursive: true })
    // A provider failure is retried in a fresh ACP session inside the shared bounds. The issued id,
    // prompt and definition stay the same; each attempt records to its own session file.
    let attempts = 0, waitedMs = 0
    for (;;) {
      const sessionFile = join(spec.taskDir, 'lean', role, attempts === 0 ? `${id}.jsonl` : `${id}.retry-${attempts}.jsonl`)
      // 'wx': a turn id is issued once, so an existing recording is never appended to or reused.
      const header = `${JSON.stringify({ type: 'prompt', text: prompt })}\n`
      d.writeFileSync(sessionFile, header, { flag: 'wx' })
      // runAcpSeat swallows a failed append; the first one is kept and fails the turn afterwards. Every
      // relayed line is also kept in memory: the skill proof reads that copy, which the seat cannot rewrite.
      let recordError = null
      const relayed = []
      const guardedAppend = (...args) => {
        try { const out = d.appendFileSync(...args); if (args[0] === sessionFile) relayed.push(String(args[1])); return out } catch (error) { recordError ??= error; throw error }
      }
      const turn = await d.runAcpSeat({
        definition, cwd: spec.cwd, taskDir: spec.taskDir, prompt, sessionFile,
        deps: { appendFileSync: guardedAppend },
      })
      if (recordError) throw recordError
      // The runtime writes the one turn row of every turn, accepted or not.
      guardedAppend(sessionFile, `${JSON.stringify({ type: 'turn', stopReason: turn?.stopReason ?? null, usage: turn?.usage ?? null, refusal: turn?.refusal ?? null })}\n`, 'utf8')
      // A refused or unmeasured turn fails here, before the loop reads an envelope the seat never earned.
      if (turn?.refusal || !turn?.stopReason) {
        const failure = Object.assign(new Error(turn?.refusal?.message ?? 'ACP seat turn returned no stop reason'), { code: turn?.refusal?.code ?? null, errorKind: turn?.refusal?.errorKind ?? null })
        if (!turn?.refusal) throw failure
        const kind = acpProviderFailureKind(turn?.refusal?.errorKind)
        const at = d.now()
        const reset = kind === 'rate_limit' ? acpTextReset(turn.refusal.message, at) : null
        const decision = providerRetryDecision({ kind, reset, attempts, waitedMs, at })
        if (!decision.retry) throw failure
        await d.sleep(decision.wait_ms)
        // The wait actually taken counts, never less than the one intended; an oversleep that crosses the bound buys no replacement.
        waitedMs += Math.max(decision.wait_ms, d.now() - at)
        if (waitedMs > PROVIDER_RETRY_TOTAL_WAIT_MS) throw failure
        attempts += 1
        continue
      }
      // Trusted runtime context for the loop's required-skill proof; never read from the seat's envelope.
      // The proof reads the relayed copy, and only while the file on disk is still exactly what was
      // relayed: a seat that removed, blocked or rewrote its own recording proves nothing.
      const recorded = relayed.join('')
      let intact = false
      try { intact = d.readFileSync(sessionFile, 'utf8') === header + recorded } catch { /* unreadable is not intact */ }
      return { definition, recorded: intact ? recorded : null, cwd: spec.cwd }
    }
  }

  let result
  try { result = await runLoop(spec, { ...d.loopDeps, runSeat }) } catch { result = stopped('runner-threw') }
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
