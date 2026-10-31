#!/usr/bin/env node
// Replay a recorded lane's first planner turn at its base commit with a named seat cell and arm list.
//   node bench/replay-planner.mjs --lane b1380 --cell cell.json --arms subagent,fff --out /absolute/new-run
// The planner starts from a fresh task dir (no recorded plan). Its own gate is run once on the unchanged
// tree to see which acceptance ids go red; its mutations are not proved. See bench/README.md.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemory, renderSection } from '../crew/memory.mjs'
import { parseAgent } from '../crew/protocols.mjs'
import { advisorRows, callSeat, checkDiagnostics, dirtyFiles, errText, loadChecks, parseCli, prepareLane, loadEnvelope, readCellFile, readJournal, rowKinds, runReplay, seatDefinition, sleepMs, unmeasuredError, validateArms, validateCell, writeDiff } from './replay-common.mjs'

// The planner names its gate; only a file inside the replay's task dir is run.
function gateFile(task, details) {
  const named = typeof details.gate_path === 'string' ? resolve(details.gate_path) : null
  if (named && existsSync(named) && realpathSync(named).startsWith(realpathSync(task) + sep)) return named
  return existsSync(join(task, 'gate.mjs')) ? join(task, 'gate.mjs') : null
}

const nonEmptyFile = (f) => { try { return statSync(f).isFile() && statSync(f).size > 0 } catch { return false } }

// options: { lane, cell | cellFile, arms, out, memory?, charter? } (cell already parsed, or a path read inside the recorded run); deps (test seams): prepareRun, runAcpSeat, runGate, corpusDir, repoDir, home, sleepMs.
export async function runPlanner(options, deps = {}) {
  const { lane, arms } = options ?? {}
  return runReplay({
    kind: 'planner', options, deps,
    async body({ outDir, step, errors, onCleanup, result }) {
      result.charter = options.charter ?? null
      validateArms(arms)
      const cell = validateCell(options.cell ?? readCellFile(options.cellFile)) // a bad cell file is a recorded failure, not a crash
      result.cell = cell
      let charterBody
      if (options.charter !== undefined) {
        const parsed = parseAgent(readFileSync(options.charter, 'utf8'))
        if (parsed.defects.length) throw new Error(`invalid charter ${options.charter}: ${parsed.defects.join('; ')}`)
        charterBody = parsed.body
      }
      const prep = await (deps.prepareRun ?? ((ctx) => prepareLane({ role: 'planner', ...ctx })))({ lane, cell, arms, outDir, onCleanup, charterBody, deps })
      if (options.memory !== undefined) {
        const extract = openMemory({ dir: options.memory }).context({ task: prep.briefText, role: 'planner' })
        const section = renderSection(extract)
        result.memory = { dir: options.memory, included: extract.included, dropped: extract.dropped, bytes: extract.bytes, reason: extract.reason }
        if (!section) throw new Error(`memory rendered no section: ${extract.reason}`)
        prep.prompt += `\n\n${section}`
      }
      const task = prep.taskDir
      const tree = prep.cwd
      const { turn, error: seatError, wallS } = await callSeat({ deps, definition: seatDefinition({ role: 'planner', cell, arms }), prep, outDir })
      if (seatError) errors.push(`seat: ${seatError}`)
      if (cell.advisor) (deps.sleepMs ?? sleepMs)((cell.settle_s ?? 120) * 1000)
      const { envelope, error: envelopeError } = loadEnvelope(task, prep.returnName)
      if (envelopeError) errors.push(envelopeError)
      const details = envelope?.details ?? {}
      const gatePath = gateFile(task, details)
      if (!nonEmptyFile(join(task, 'plan.md'))) errors.push('planner: plan.md not written')
      if (!gatePath) errors.push('planner: gate.mjs not written')
      const { runGate } = await loadChecks({ ...deps, proveMutations: deps.proveMutations ?? (() => null) })
      // A planner's gate must be red on the unchanged tree; every acceptance id should fail there.
      const baseline = gatePath ? await step('gate', () => runGate({ cwd: tree, gatePath, timeoutMs: 600_000 })) : null
      const baselineIssue = baseline === undefined || baseline === null ? null : unmeasuredError('gate', baseline)
      if (baselineIssue) errors.push(baselineIssue)
      const changed = (await step('status', () => dirtyFiles(tree))) ?? []
      await step('diff', () => writeDiff(tree, join(outDir, 'diff.patch')))
      const journal = readJournal(task)
      const advisor = advisorRows(journal)
      return {
        wallS, stop: turn?.stopReason ?? null, usage: turn?.usage ?? null,
        envelope: envelope ? { status: envelope.status, summary: envelope.summary, acceptance: details.acceptance ?? null, mutations: details.mutations?.length ?? null } : null,
        gate: gatePath ? { path: gatePath, baseline: baseline?.status ?? null, reason: baseline?.reason ?? null, error: baseline ? checkDiagnostics(baseline).error : null, failing: baseline?.failingIds ?? null } : null,
        repo_writes: changed.length, changed, kinds: rowKinds(journal),
        advisor: { consults: advisor.consults.map((c) => c.trigger), notes: advisor.notes.filter((n) => n.claim).map((n) => ({ trigger: n.trigger, severity: n.severity, claim: n.claim })) },
        lab_runs: journal.filter((r) => r.lab_run).length, scouts: journal.filter((r) => r.subagent_usage).length,
      }
    },
  })
}

async function main(argv) {
  let result
  try {
    const { lane, cellFile, arms, out, memory, charter } = parseCli(argv, { allowMemory: true, allowCharter: true })
    result = await runPlanner({ lane, cellFile, arms, out, ...(memory !== undefined ? { memory } : {}), ...(charter !== undefined ? { charter } : {}) })
  } catch (e) {
    process.stderr.write(`replay-planner: ${errText(e)}\n`)
    process.exitCode = 2
    return
  }
  console.log(JSON.stringify({ id: result.id, lane: result.lane, error: result.error, baseline: result.gate?.baseline ?? null, failing: result.gate?.failing ?? null }))
  if (result.error) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2))
