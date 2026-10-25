// crew lean <spec.json>: the detached entry of `crew start --loop lean` (ADR-052). It runs the
// standard loop (crew/loop.mjs) with each seat turn played over ACP (crew/acp/seat.mjs), records
// every turn under <taskDir>/lean/<role>/<id>.jsonl, and ends with one terminal row in the run log.
// Import-safe: importing this module launches nothing; every effect crosses an injected seam.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAcpSeat } from './acp/seat.mjs'
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
    definition: { role, agent: seat.agent, model: `${seat.provider}/${seat.id}`, effort: seat.effort, writes: effective.writes ?? 'none', skills: effective.skills ?? [],
      tools: effective.tools,
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
    log: (line) => process.stdout.write(`${line}\n`),
    loopDeps: {},
    ...deps,
  }

  const runSeat = async (request) => {
    const { definition, source, charters } = definitionFor(request, spec.tier, d)
    const { role, id } = request
    const prompt = promptFor({ request, spec, source, charters, body: definition.body })
    const sessionFile = join(spec.taskDir, 'lean', role, `${id}.jsonl`)
    d.mkdirSync(dirname(sessionFile), { recursive: true })
    // 'wx': a turn id is issued once, so an existing recording is never appended to or reused.
    d.writeFileSync(sessionFile, `${JSON.stringify({ type: 'prompt', text: prompt })}\n`, { flag: 'wx' })
    // runAcpSeat swallows a failed append; the first one is kept and fails the turn afterwards.
    let recordError = null
    const guardedAppend = (...args) => {
      try { return d.appendFileSync(...args) } catch (error) { recordError ??= error; throw error }
    }
    await d.runAcpSeat({
      definition, cwd: spec.cwd, taskDir: spec.taskDir, prompt, sessionFile,
      deps: { appendFileSync: guardedAppend },
    })
    if (recordError) throw recordError
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
