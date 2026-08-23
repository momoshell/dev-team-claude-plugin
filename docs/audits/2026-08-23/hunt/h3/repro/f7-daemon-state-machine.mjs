// F7 — three defects in the daemon's run-state machine, reproduced against a
// throwaway daemon root. Nothing here touches the checkout.
//
// The fixture is the shape crew/daemon.test.mjs:72-125 uses (injected deps: no
// real fork, no real kill, no real timers).
//
// Run:  node f7-daemon-state-machine.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from './harness.mjs'

const { daemon, deriveState, normalizeEvent, usageWindow, RUN_STATES } = await import(`${REPO}/crew/daemon.mjs`)
const line = (t) => console.log(`\n===== ${t}`)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'h3-daemon-'))
  const root = join(dir, 'daemon')
  const crewDir = join(dir, 'crew')
  const returnsDir = join(crewDir, 'returns')
  mkdirSync(join(crewDir, 'task'), { recursive: true }); mkdirSync(returnsDir, { recursive: true })
  const roles = ['planner', 'builder', 'reviewer']
  const members = Object.fromEntries(roles.map((r) => [r, { model: 'x', transport: 'headless-json' }]))
  const taskReturn = join(returnsDir, 'task.json')
  const journal = join(crewDir, 'journal.jsonl')
  writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'h3', checkout: dir, roles, members, task_return: taskReturn }))
  writeFileSync(journal, '')
  const brief = join(dir, 'brief.md'); writeFileSync(brief, '# brief\n')
  const alive = new Set([700, 900])
  let clock = 1
  const deps = {
    pid: 700, now: () => clock++,
    uuid: (() => { let n = 0; return () => `run-${++n}` })(),
    fork: () => ({ pid: 900, on() {}, kill() {}, unref() {}, disconnect() {} }),
    spawnSync: () => ({ status: 0, stdout: '{}', stderr: '' }),
    kill: (pid, sig) => { if (sig === 0 && !alive.has(pid)) { const e = Error('gone'); e.code = 'ESRCH'; throw e } return true },
    setInterval: () => null, clearInterval: () => {},
  }
  const d = daemon({ root, deps })
  const rows = () => readFileSync(join(root, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, root, crewDir, returnsDir, taskReturn, journal, brief, d, alive, rows,
    // the daemon addresses each run's envelope by run id (crew/daemon.mjs:1090
    // runReturnPath), not by the crew's well-known returns/task.json
    returnPathFor: (runId) => rows().find((r) => r.kind === 'enqueued' && r.run_id === runId).task_return,
    records: () => rows().map((r) => r.kind),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
line('F7a — a SETTLED run un-settles: state() and result() never consult the settlement')
// crew/daemon.mjs:802-806  settle() records run.envelope, run.lifecycle='settled',
//                          and a `settled` registry row
// crew/daemon.mjs:878      const terminal = !!runEnvelope(run)      <- live disk read
// crew/daemon.mjs:894-896  result(): re-reads the file every call; falls back to
//                          `reason: run.orphan_reason || 'pending'`
// Nothing on either read path looks at run.lifecycle === 'settled' or run.envelope.
{
  const f = fixture()
  try {
    // no d.start(): poll()/enqueue() need no socket, and start() is async
    const run = f.d.enqueue({ crew_dir: f.crewDir, brief: f.brief })
    const envPath = f.returnPathFor(run.run_id)
    writeFileSync(envPath, JSON.stringify({ status: 'done', summary: 'shipped' }))
    f.d.poll()
    console.log('registry after settle   :', f.records().join(','))
    console.log('state / result at settle:', f.d.state({ run: run.run_id }).state,
      '/', f.d.result({ run: run.run_id }).outcome)

    // a third party rewrites the well-known envelope (a second run in the same
    // crew dir, a worktree rebuild, a `git clean` that recreates returns/)
    writeFileSync(envPath, JSON.stringify({ status: 'escalation', summary: 'someone else' }))
    console.log('after REWRITE           :', f.d.state({ run: run.run_id }).state,
      '/', f.d.result({ run: run.run_id }).outcome)

    unlinkSync(envPath)
    const r = f.d.result({ run: run.run_id })
    console.log('after UNLINK            :', f.d.state({ run: run.run_id }).state, '/', JSON.stringify(r))
    console.log('registry UNCHANGED      :', f.records().join(','))
    console.log('')
    console.log('EXPECTED : a run with a `settled` registry row reports its RECORDED outcome,')
    console.log('           or at minimum refuses to claim `pending`. OBSERVED below: done -> escalation -> not-done/pending.')
    console.log('PINNED?  : no — crew/daemon.test.mjs:1989-2008 removes the file only for an')
    console.log('           ORPHANED run, where run.orphan_reason is set and the literal is never reached.')
  } finally { f.cleanup() }
}

// ---------------------------------------------------------------------------
line('F7b — `blocked` is a ONE-WAY LATCH for a live run')
// crew/daemon.mjs:593  if (event.kind === 'blocked') run.blocked = true
// the only two `run.blocked = false` sites are crew/daemon.mjs:494 (freshRun) and
// crew/daemon.mjs:786 (regrantIfEligible). Nothing clears it during a run's life.
// The producer is crew/daemon.mjs:204 `if (row.no_lead_escalation != null)`.
{
  const f = fixture()
  try {
    // no d.start(): poll()/enqueue() need no socket, and start() is async
    const run = f.d.enqueue({ crew_dir: f.crewDir, brief: f.brief })
    f.d.poll()
    console.log('before          :', f.d.state({ run: run.run_id }).state)
    appendFileSync(f.journal, `${JSON.stringify({ at: 1, no_lead_escalation: 'no lead seated' })}\n`)
    f.d.poll()
    console.log('after blocked   :', f.d.state({ run: run.run_id }).state)
    for (let i = 0; i < 5; i += 1) {
      appendFileSync(f.journal, `${JSON.stringify({ at: 2 + i, stage: `build:r${i + 1}` })}\n`)
      f.d.poll()
    }
    console.log('after 5 more polls with fresh stage activity:', f.d.state({ run: run.run_id }).state,
      '(child alive:', f.alive.has(900), ')')
    console.log('')
    console.log('EXPECTED : `working` once the run resumes producing events.')
    console.log('OBSERVED : `blocked`, indefinitely.')
    console.log('NOTE     : today every no_lead_escalation producer terminates the run')
    console.log('           immediately (crew/drive.mjs:1671, and every consultLead caller')
    console.log('           returns escalate), so done/dead precedence in deriveState masks it.')
    console.log('           It is one non-terminal blocked producer away from pinning a live run.')
  } finally { f.cleanup() }
}

// ---------------------------------------------------------------------------
line('F7c — deriveState: `queued` and `blocked` are unreachable at WORKER scope')
// crew/daemon.mjs:876  return deriveState({ terminal, alive: exitSeen ? false : true, blocked: false })
//                      — `blocked` is hard-coded false and `queued` is never passed.
console.log('RUN_STATES        :', RUN_STATES.join(', '))
console.log('worker-scope call : deriveState({terminal, alive, blocked:false})  -> reachable answers:')
const workerAnswers = new Set()
for (const terminal of [true, false]) for (const alive of [true, false]) {
  workerAnswers.add(deriveState({ terminal, alive, blocked: false }))
}
console.log('                   ', [...workerAnswers].join(', '))
console.log('unreachable at worker scope:', RUN_STATES.filter((s) => !workerAnswers.has(s)).join(', '))

// ---------------------------------------------------------------------------
line('F7d — normalizeEvent DECLARES top-level token fields usage-bearing, then drops them')
// crew/daemon.mjs:216  `if (row.type === 'result') return roleEvent('terminal-result', ...)`  <- returns first
// crew/daemon.mjs:224  `... || row.input_tokens != null || row.output_tokens != null) return usageEvent(row)`
// crew/daemon.mjs:697  `if ((row.usage || row.message?.usage) && ...) appendEvent(run, usageEvent(withRole))`
//                      <- the re-emit guard tests only the TWO nested shapes, not the four :224 accepts
console.log('result frame, TOP-LEVEL tokens ->',
  JSON.stringify(normalizeEvent('stream', { type: 'result', role: 'b', input_tokens: 100, output_tokens: 50 })))
console.log('result frame, NESTED usage     ->',
  JSON.stringify(normalizeEvent('stream', { type: 'result', role: 'b', usage: { input_tokens: 9, output_tokens: 9 } })))
console.log('bare frame,   TOP-LEVEL tokens ->',
  JSON.stringify(normalizeEvent('stream', { role: 'b', input_tokens: 100, output_tokens: 50 })))
console.log('EXPECTED : the first line also yields a usage event (crew/daemon.mjs:697 re-emits')
console.log('           beside the terminal-result for the NESTED shape and only that one).')
console.log('OBSERVED : the 100/50 tokens are gone from the projection.')

// ---------------------------------------------------------------------------
line('F7e — usageWindow fabricates a MEASURED ZERO for a missing db and for since:null')
// crew/daemon.mjs:273  if (!fsExistsSync(dbPath)) return { measured: true, total: 0, sessions: 0 }
// crew/daemon.mjs:282  FROM agent_sessions WHERE started_at >= ?      (>= NULL is NULL for every row)
// A `measured: true, total: 0` answer ADMITS a run past the budget ceiling
// (crew/daemon.mjs:1055 checks only the flag, crew/daemon.mjs:1059 then compares).
console.log('dbPath undefined ->', JSON.stringify(usageWindow({ dbPath: undefined, since: new Date().toISOString() })))
console.log('dbPath missing   ->', JSON.stringify(usageWindow({ dbPath: '/nonexistent/h3.db', since: new Date().toISOString() })))
console.log('EXPECTED : `measured: false` with a why — a ledger that is not there was not READ.')
console.log('OBSERVED : a measured zero, which admits every run.')
console.log('NOTE     : assertBudget (crew/daemon.mjs:363-365) always builds a non-empty')
console.log('           budgetLedgerDb and an ISO since, so this is the EXPORTED helper\'s')
console.log('           contract, not a live admission bypass — see the notes for the seam-only')
console.log('           non-finite-total case (crew/daemon.mjs:1059 `usage.total >= max`).')
