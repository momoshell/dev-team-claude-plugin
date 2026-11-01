import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const failures = []
const fail = (id, why) => failures.push(`FAIL ${id}: ${why}`)

const RULE = "Scout rule: when answering a question means reading many files or an area the brief's Context does not name, ask a `scout` that question instead of reading it all yourself, then read only what its findings cite."

function charter(id, rel) {
  try {
    const text = readFileSync(join(root, rel), 'utf8')
    if (!text.includes(RULE)) fail(id, `${rel} does not contain the exact scout rule sentence`)
  } catch (err) {
    fail(id, `${rel} unreadable (${err.message})`)
  }
}

charter('SN1', 'crew/agents/planner.md')
charter('SN2', 'crew/agents/reviewer.md')

// --- behavioural checks SN3/SN4 -------------------------------------------
let mod = null
try {
  mod = await import(pathToFileURL(join(root, 'crew/pi/extensions/subagent.ts')).href)
} catch (err) {
  fail('SN3', `subagent.ts not importable (${err.message})`)
  fail('SN4', `subagent.ts not importable (${err.message})`)
}

const READ_DIRS = ['alpha', 'beta', 'gamma']
function reads(nudge, n, tag) {
  for (let i = 0; i < n; i += 1) {
    const dir = READ_DIRS[i % READ_DIRS.length]
    const out = nudge.onToolCall({ type: 'tool_call', toolCallId: `${tag}-${i}`, toolName: 'read', input: { path: `${dir}/file-${tag}-${i}.mjs` } })
    if (out !== undefined) throw new Error('onToolCall must return undefined (never block/change a call)')
  }
}

function makeNudge() {
  const scratch = mkdtempSync(join(tmpdir(), 'scout-nudge-gate-'))
  const taskDir = join(scratch, 'task')
  const env = { CREW_ROLE: 'planner', CREW_TASK_DIR: taskDir }
  const sends = []
  const nudge = mod.createScoutNudge({
    env,
    send: (message, options) => { sends.push({ message, options }) },
    now: () => '2026-10-29T00:00:00.000Z',
  })
  const journalPath = typeof mod.journalPathFrom === 'function' ? mod.journalPathFrom(taskDir, env) : join(dirname(taskDir), 'journal.jsonl')
  const journalRows = () => (existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && row.scout_nudge)
    : [])
  return { nudge, sends, journalRows }
}

function checkSN3() {
  if (typeof mod.createScoutNudge !== 'function') { fail('SN3', 'createScoutNudge is not exported'); return }
  if (mod.SCOUT_NUDGE_READ_THRESHOLD !== 8) { fail('SN3', 'SCOUT_NUDGE_READ_THRESHOLD is not 8'); return }
  if (mod.SCOUT_NUDGE_MIN_DIRECTORIES !== 3) { fail('SN3', 'SCOUT_NUDGE_MIN_DIRECTORIES is not 3'); return }
  const { nudge, sends, journalRows } = makeNudge()
  reads(nudge, 7, 'a')
  if (sends.length !== 0) { fail('SN3', `sent ${sends.length} nudge(s) before the threshold`); return }
  reads(nudge, 1, 'b')
  if (sends.length !== 1) { fail('SN3', `expected exactly 1 nudge after 8 reads across 3 directories, got ${sends.length}`); return }
  const content = String(sends[0]?.message?.content ?? '')
  if (!/scout/i.test(content)) { fail('SN3', 'nudge message does not mention a scout'); return }
  if (mod.SCOUT_NUDGE_MESSAGE_TYPE && sends[0]?.message?.customType !== mod.SCOUT_NUDGE_MESSAGE_TYPE) {
    fail('SN3', 'nudge message customType is not SCOUT_NUDGE_MESSAGE_TYPE'); return
  }
  if (journalRows().length !== 1) { fail('SN3', `expected exactly 1 scout_nudge journal row, got ${journalRows().length}`); return }

  // Reads confined to one directory must not nudge.
  const narrow = makeNudge()
  for (let i = 0; i < 10; i += 1) narrow.nudge.onToolCall({ type: 'tool_call', toolCallId: `n-${i}`, toolName: 'read', input: { path: `solo/f${i}.mjs` } })
  if (narrow.sends.length !== 0) { fail('SN3', 'nudged although reads spanned only one directory'); return }

  // Grant wiring in the default export: no grant -> no nudge handlers; grant -> both.
  const savedAgents = process.env.CREW_PI_AGENTS
  const savedTask = process.env.CREW_TASK_DIR
  try {
    delete process.env.CREW_PI_AGENTS
    const bareHandlers = []
    mod.default({ registerTool: () => {}, on: (e, h) => bareHandlers.push([e, h]), sendMessage: () => {} })
    if (bareHandlers.some(([e]) => e === 'tool_call' || e === 'turn_start')) { fail('SN3', 'ungranted seat registered nudge handlers'); return }
    process.env.CREW_PI_AGENTS = JSON.stringify([{ name: 'scout', def: join(root, 'crew/pi/agents/scout.json') }])
    process.env.CREW_TASK_DIR = makeNudgeTaskDir()
    const grantedHandlers = []
    mod.default({ registerTool: () => {}, on: (e, h) => grantedHandlers.push([e, h]), sendMessage: () => {} })
    const names = grantedHandlers.map(([e]) => e)
    if (!names.includes('tool_call') || !names.includes('turn_start')) { fail('SN3', 'granted seat did not register tool_call/turn_start nudge handlers'); return }
  } finally {
    if (savedAgents === undefined) delete process.env.CREW_PI_AGENTS; else process.env.CREW_PI_AGENTS = savedAgents
    if (savedTask === undefined) delete process.env.CREW_TASK_DIR; else process.env.CREW_TASK_DIR = savedTask
  }
}

function makeNudgeTaskDir() {
  return join(mkdtempSync(join(tmpdir(), 'scout-nudge-gate-')), 'task')
}

function checkSN4() {
  if (typeof mod.createScoutNudge !== 'function') { fail('SN4', 'createScoutNudge is not exported'); return }
  const { nudge, sends, journalRows } = makeNudge()
  reads(nudge, 8, 'a')
  if (sends.length !== 1) { fail('SN4', `setup failed: expected 1 nudge after first threshold run, got ${sends.length}`); return }
  // A scout call resets the read count, but must not re-arm the nudge this turn.
  nudge.onToolCall({ type: 'tool_call', toolCallId: 'agent-1', toolName: 'agent', input: { agent: 'scout', task: 'look' } })
  reads(nudge, 8, 'b')
  if (sends.length !== 1) { fail('SN4', `second threshold run in the same turn sent ${sends.length - 1} extra nudge(s)`); return }
  if (journalRows().length !== 1) { fail('SN4', `expected still exactly 1 scout_nudge journal row, got ${journalRows().length}`); return }
  // A write reset likewise must not re-arm it this turn.
  nudge.onToolCall({ type: 'tool_call', toolCallId: 'w-1', toolName: 'write', input: { path: 'alpha/out.mjs', content: 'x' } })
  reads(nudge, 8, 'c')
  if (sends.length !== 1) { fail('SN4', 'write reset re-armed the nudge within the same turn'); return }
}

if (mod) {
  try { checkSN3() } catch (err) { fail('SN3', err.message) }
  try { checkSN4() } catch (err) { fail('SN4', err.message) }
}

for (const line of failures) console.log(line)
process.exit(failures.length ? 1 : 0)
