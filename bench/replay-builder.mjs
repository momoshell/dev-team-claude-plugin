#!/usr/bin/env node
// Replay a recorded lane's first builder turn at its base commit with a named seat cell and arm list,
// then run the gate, the mutation proof and the touched tests.
//   node bench/replay-builder.mjs --lane b1380 --cell cell.json --arms fff,readgate --out /absolute/new-run
// Writes result.json, diff.patch and session.jsonl into --out (a new directory). See bench/README.md.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advisorRows, callSeat, checkDiagnostics, dirtyFiles, errText, loadChecks, parseCli, prepareLane, loadEnvelope, readCellFile, readJournal, rowKinds, runReplay, seatDefinition, sleepMs, unmeasuredError, validateArms, validateCell, writeDiff } from './replay-common.mjs'

const count = (s, k) => Number(s?.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm'))?.[1] ?? NaN)

// options: { lane, cell | cellFile, arms, out } (cell already parsed, or a path read inside the recorded run); deps (test seams): prepareRun, runAcpSeat, runGate, proveMutations, corpusDir, repoDir, home, sleepMs.
export async function runBuilder(options, deps = {}) {
  const { lane, arms } = options ?? {}
  return runReplay({
    kind: 'builder', options, deps,
    async body({ outDir, step, errors, onCleanup, result }) {
      validateArms(arms)
      const cell = validateCell(options.cell ?? readCellFile(options.cellFile)) // a bad cell file is a recorded failure, not a crash
      result.cell = cell
      const prep = await (deps.prepareRun ?? ((ctx) => prepareLane({ role: 'builder', ...ctx })))({ lane, cell, arms, outDir, onCleanup, deps })
      const task = prep.taskDir
      const tree = prep.cwd
      const { turn, error: seatError, wallS: seatWallS } = await callSeat({ deps, definition: seatDefinition({ role: 'builder', cell, arms }), prep, outDir })
      if (seatError) errors.push(`seat: ${seatError}`)
      if (cell.advisor) (deps.sleepMs ?? sleepMs)((cell.settle_s ?? 120) * 1000) // let the advisor's last rows land
      const wallS = seatWallS
      const { envelope, error: envelopeError, status, status_reason } = loadEnvelope(task, prep.returnName)
      Object.assign(result, { status, status_reason })
      if (envelopeError) errors.push(envelopeError)
      const gatePath = join(task, 'gate.mjs')
      const { runGate, proveMutations } = await loadChecks(deps)
      const gate = await step('gate', () => runGate({ cwd: tree, gatePath, timeoutMs: 600_000 }))
      const gateIssue = gate === undefined ? null : unmeasuredError('gate', gate)
      if (gateIssue) errors.push(gateIssue)
      const plan = prep.plan ?? {}
      const mutations = plan.mutations ?? []
      const proof = gate?.status === 'green'
        ? await step('mutations', () => proveMutations({ cwd: tree, gatePath, checks: (plan.acceptance ?? []).map((a) => a.id ?? a), mutations, timeoutMs: 600_000 }))
        : null
      const proofIssue = proof === undefined || proof === null ? null : unmeasuredError('mutations', proof)
      if (proofIssue) errors.push(proofIssue)
      const changed = (await step('status', () => dirtyFiles(tree))) ?? []
      const tests = changed.filter((f) => f.endsWith('.test.mjs') && existsSync(join(tree, f)))
      const targeted = tests.length ? await step('tests', () => {
        const { NODE_TEST_CONTEXT, ...env } = process.env // a parent test runner would switch the child to its machine format
        const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: tree, env, encoding: 'utf8', timeout: 900_000 })
        if (r.error) throw r.error
        return r
      }) : null
      const diff = (await step('diff', () => writeDiff(tree, join(outDir, 'diff.patch')))) ?? null
      const journal = readJournal(task)
      return {
        wallS, stop: turn?.stopReason ?? null, usage: turn?.usage ?? null,
        envelope: envelope ? { status: envelope.status, summary: envelope.summary } : null,
        gate: gate ? { status: gate.status, reason: gate.reason, failing: gate.failingIds, error: checkDiagnostics(gate).error } : null,
        mutations: proof ? { status: proof.status, reason: proof.reason, diagnostics: checkDiagnostics(proof), killed: proof.rows?.filter((r) => r.outcome === 'killed').length, of: mutations.length, rows: proof.rows?.map((r) => `${r.check}:${r.outcome}${r.reason ? `/${r.reason}` : ''}`) } : null,
        targeted: targeted ? { files: tests.length, pass: count(targeted.stdout, 'pass'), fail: count(targeted.stdout, 'fail'), status: targeted.status } : null,
        armRows: rowKinds(journal), advisor: advisorRows(journal), changed, diff,
      }
    },
  })
}

async function main(argv) {
  let result
  try {
    const { lane, cellFile, arms, out } = parseCli(argv)
    result = await runBuilder({ lane, cellFile, arms, out })
  } catch (e) {
    process.stderr.write(`replay-builder: ${errText(e)}\n`)
    process.exitCode = 2
    return
  }
  console.log(JSON.stringify({ id: result.id, lane: result.lane, error: result.error, gate: result.gate?.status ?? null, killed: result.mutations?.killed ?? null, of: result.mutations?.of ?? null }))
  if (result.error) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2))
