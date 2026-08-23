#!/usr/bin/env node
// R5 — `enqueue` has no liveness guard, so an enqueue that interleaves with the
// daemon's own shutdown forks a detached child that NOTHING supervises and answers
// a caller whose socket is already destroyed.
//
//   crew/daemon.mjs:1339-1342  the 'stop' command writes ok, then AWAITS stop()
//   crew/daemon.mjs:1418-1435  stop(): clears the interval, destroys every connection,
//                              clears subscribers, sets started=false, then AWAITS
//                              closeServer(value) — an await, i.e. a yield point
//   crew/daemon.mjs:1348-1360  every request is dispatched on its own microtask
//                              (`Promise.resolve().then(() => dispatch(...))`)
//   crew/daemon.mjs:1065       enqueue(): no `started` check, no `server` check
//   crew/daemon.mjs:1120       ... pump() -> startRun() -> fork(detached) anyway
//
// So a client's enqueue frame that lands in the microtask queue while stop() is
// awaiting closeServer runs AFTER the poll interval is cleared and after every
// connection is destroyed. The run is recorded 'started', a real detached child is
// forked, and no poll loop, no socket and no pidfile remain to supervise or report it.
//
// The fork seam is injected with a stand-in child (a plain detached sleeper) so this
// stays hermetic — the point under test is that a child IS forked and left
// unsupervised, not what a crew child does. Scratch daemon root only.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const REPO = process.env.H1_SCRATCH_REPO
if (!REPO) { console.error('set H1_SCRATCH_REPO to the scratch repo copy'); process.exit(2) }
const { daemon } = await import(join(REPO, 'crew/daemon.mjs'))

const root = mkdtempSync('/tmp/h1r5-')
const crewDir = join(root, 'crew')
mkdirSync(join(crewDir, 'returns'), { recursive: true })
writeFileSync(join(crewDir, 'crew.json'), JSON.stringify({ task: 'h1-r5', checkout: root, members: { builder: { transport: 'headless-json' } } }))

const forked = []
const fork = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  child.unref()
  forked.push(child.pid)
  return child
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const d = daemon({ root, deps: { pollMs: 1_000_000, fork } })
await d.start()
console.log(`socket before          : ${existsSync(d.socketPath)}   pidfile: ${existsSync(join(root, 'daemon.json'))}`)

// The interleaving the dispatcher produces: stop() is in flight (it has already
// cleared the interval and destroyed the connections) when the enqueue microtask runs.
const stopping = d.stop()
let result = null, threw = null
try { result = d.enqueue({ crew_dir: crewDir, run_id: 'r-1' }) } catch (err) { threw = err }
await stopping

console.log(`enqueue during stop()  : ${threw ? `threw ${JSON.stringify(threw.message)}` : JSON.stringify(result)}`)
console.log(`records in runs.jsonl  : [${readFileSync(join(root, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind).join(', ')}]`)
console.log(`children forked        : ${JSON.stringify(forked)}  alive=${JSON.stringify(forked.map(alive))}`)
console.log(`socket after           : ${existsSync(d.socketPath)}   pidfile: ${existsSync(join(root, 'daemon.json'))}`)
console.log(`poll loop              : cleared by stop() (crew/daemon.mjs:1420) — nothing will ever poll this run`)

const leaked = forked.length > 0 && forked.every(alive) && !existsSync(d.socketPath)
console.log('')
console.log(`EXPECTED: a daemon that is shutting down REFUSES the admission (the run stays enqueued for`)
console.log(`          the next daemon, or the caller is told 'not-running') — it does not fork.`)
console.log(`OBSERVED: the run was admitted and recorded 'started', a detached child was forked, and the`)
console.log(`          daemon then exited with no socket, no pidfile and no poll loop behind it.`)
console.log(leaked ? 'R5 REPRODUCED — an unsupervised detached child outlives the daemon that forked it' : 'R5 did not reproduce')
for (const pid of forked) { try { process.kill(pid, 'SIGKILL') } catch {} }
rmSync(root, { recursive: true, force: true })
process.exit(leaked ? 0 : 1)
