#!/usr/bin/env node
// Replay a recorded lane's first builder turn at its base commit with a named seat cell and arm list,
// then run the gate, the mutation proof and the touched tests.
//   node bench/replay-builder.mjs --lane b1380 --cell cell.json --arms fff,readgate --out /absolute/new-run
// Writes result.json, diff.patch and session.jsonl into --out (a new directory). See bench/README.md.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAgent } from '../crew/protocols.mjs'
import { addWorktree, addedLines, inside, isTestFile, advisorRows, callSeat, checkDiagnostics, dirtyFiles, errText, loadChecks, parseCli, prepareLane, loadEnvelope, readCellFile, readJournal, realThrough, rowKinds, runReplay, seatDefinition, sleepMs, unmeasuredError, validateArms, validateCell, writeDiff } from './replay-common.mjs'

const count = (s, k) => Number(s?.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm'))?.[1] ?? NaN)

export function boundState(events, id) {
  const hits = (events ?? []).filter((e) => typeof e?.name === 'string' && e.name.startsWith(`(${id}) `))
  if (hits.length === 0) return { state: null, reason: 'missing' }
  if (hits.length > 1) return { state: null, reason: 'ambiguous' }
  const [e] = hits
  if (e.skip) return { state: null, reason: 'skipped' }
  if (e.todo) return { state: null, reason: 'todo' }
  if (e.type === 'test:pass') return { state: 'green', reason: null }
  if (e.type === 'test:fail' && e.failureType === 'testCodeFailure') return { state: 'red', reason: null }
  return { state: null, reason: e.failureType === 'hookFailed' ? 'hook-failed' : e.failureType === 'cancelledByParent' ? 'cancelled' : 'not-body-failure' }
}

function testEvents(cwd, files) {
  if (!files.length) return []
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const reporter = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'events-reporter.mjs')).href
  const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', ...files], { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 })
  if (r.error) throw r.error
  if (r.signal) throw new Error(`test runner terminated by ${r.signal}`)
  return r.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

async function proveBound({ tree, outDir, onCleanup, step, changed, plan, envelope }) {
  const ids = (plan.acceptance ?? []).map((a) => a.id ?? a)
  const files = changed.filter((f) => /\.test\.[cm]?js$/.test(f) && existsSync(join(tree, f)))
  const buildEvents = await step('bound-build', () => testEvents(tree, files))
  const baseEvents = await step('bound-base', () => {
    const base = join(outDir, 'base')
    addWorktree({ repo: tree, base: 'HEAD', tree: base, onCleanup })
    const realBase = realpathSync(base)
    for (const file of changed.filter(isTestFile)) {
      const src = join(tree, file)
      if (!existsSync(src) || !statSync(src).isFile()) continue
      const dest = join(base, file)
      // copyFileSync follows a symlink at dest, and mkdirSync a symlinked parent: either could write outside the base worktree.
      if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink() || !inside(realThrough(dest), realBase)) throw new Error(`refused base copy of ${file}: symlink or outside the base worktree`)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
    return testEvents(base, files)
  })
  const state = (events, id) => events === undefined ? { state: null, reason: 'not-run' } : boundState(events, id)
  const rows = {}
  for (const id of ids) {
    const base = state(baseEvents, id), build = state(buildEvents, id)
    const name = buildEvents?.find((e) => e.name?.startsWith(`(${id}) `))?.name
    const declarations = envelope?.details?.mutations
    const mutation = Array.isArray(declarations) ? declarations.find((m) => m && typeof m === 'object' && m.check === id) : undefined
    let mutant, mutantEvents
    if (!mutation) mutant = { state: null, reason: 'no-mutation' }
    else if (typeof mutation.file === 'string' && isTestFile(mutation.file)) mutant = { state: null, reason: 'mutation-in-test' }
    else {
      const events = await step(`bound-mutant-${id}`, () => {
        let file, original
        try {
          file = resolve(tree, mutation.file)
          const realFile = realpathSync(file), realTree = realpathSync(tree)
          if (!inside(file, resolve(tree)) || file === resolve(tree) || !inside(realFile, realTree) || !statSync(file).isFile()) return null
          if (isTestFile(relative(resolve(tree), file)) || isTestFile(relative(realTree, realFile))) return 'mutation-in-test'
          original = readFileSync(file)
        } catch { return null }
        const text = original.toString('utf8'), { find, replace } = mutation
        if (typeof find !== 'string' || !find || typeof replace !== 'string' || find === replace || text.split(find).length !== 2) return null
        try {
          writeFileSync(file, text.replace(find, () => replace))
          return testEvents(tree, files)
        } finally { writeFileSync(file, original) }
      })
      mutantEvents = events
      mutant = events === null ? { state: null, reason: 'bind-fail' } : events === 'mutation-in-test' ? { state: null, reason: 'mutation-in-test' } : state(events, id)
    }
    const row = { test: name ?? null, base, build, mutant, red_on_base: base.state === 'red', green_on_build: build.state === 'green', killed: mutant.state === 'red' }
    const identity = (events, cwd) => {
      const hits = (events ?? []).filter((e) => typeof e?.name === 'string' && e.name.startsWith(`(${id}) `))
      const e = hits.length === 1 ? hits[0] : null
      return typeof e?.file === 'string' && Number.isInteger(e.line) && Number.isInteger(e.column) ? JSON.stringify([relative(realpathSync(cwd), e.file), e.line, e.column, e.name]) : null
    }
    const buildIdentity = identity(buildEvents, tree)
    row.proven = row.red_on_base && row.green_on_build && row.killed && buildIdentity !== null && buildIdentity === identity(baseEvents, join(outDir, 'base')) && buildIdentity === identity(mutantEvents, tree)
    rows[id] = row
  }
  return { of: ids.length, proven: Object.values(rows).filter((row) => row.proven).length, ids: rows }
}

// options: { lane, cell | cellFile, arms, out } (cell already parsed, or a path read inside the recorded run); deps (test seams): prepareRun, runAcpSeat, runGate, proveMutations, corpusDir, repoDir, home, sleepMs.
export async function runBuilder(options, deps = {}) {
  const { lane, arms } = options ?? {}
  return runReplay({
    kind: 'builder', options, deps,
    async body({ outDir, step, errors, onCleanup, result }) {
      result.charter = options.charter ?? null
      result.variant = options.buildFirst ? 'build-first' : 'gate'
      validateArms(arms)
      const cell = validateCell(options.cell ?? readCellFile(options.cellFile)) // a bad cell file is a recorded failure, not a crash
      result.cell = cell
      if (options.buildFirst && options.charter === undefined) throw new Error('build-first needs --charter')
      let charterBody
      if (options.charter !== undefined) {
        const parsed = parseAgent(readFileSync(options.charter, 'utf8'))
        if (parsed.defects.length) throw new Error(`invalid charter ${options.charter}: ${parsed.defects.join('; ')}`)
        charterBody = parsed.body.trim()
      }
      const prep = await (deps.prepareRun ?? ((ctx) => prepareLane({ role: 'builder', ...ctx })))({ lane, cell, arms, outDir, onCleanup, charterBody, buildFirst: options.buildFirst, deps })
      const task = prep.taskDir
      const tree = prep.cwd
      const { turn, error: seatError, wallS: seatWallS } = await callSeat({ deps, definition: seatDefinition({ role: 'builder', cell, arms }), prep, outDir })
      if (seatError) errors.push(`seat: ${seatError}`)
      if (cell.advisor) (deps.sleepMs ?? sleepMs)((cell.settle_s ?? 120) * 1000) // let the advisor's last rows land
      const wallS = seatWallS
      const { envelope, error: envelopeError, status, status_reason } = loadEnvelope(task, prep.returnName)
      Object.assign(result, { status, status_reason })
      if (envelopeError) errors.push(envelopeError)
      let gate = null, proof = null
      const plan = prep.plan ?? {}
      const mutations = plan.mutations ?? []
      if (!options.buildFirst) {
      const gatePath = join(task, 'gate.mjs')
      const { runGate, proveMutations } = await loadChecks(deps)
      gate = await step('gate', () => runGate({ cwd: tree, gatePath, timeoutMs: 600_000 }))
      const gateIssue = gate === undefined ? null : unmeasuredError('gate', gate)
      if (gateIssue) errors.push(gateIssue)
      proof = gate?.status === 'green'
        ? await step('mutations', () => proveMutations({ cwd: tree, gatePath, checks: (plan.acceptance ?? []).map((a) => a.id ?? a), mutations, timeoutMs: 600_000 }))
        : null
      const proofIssue = proof === undefined || proof === null ? null : unmeasuredError('mutations', proof)
      if (proofIssue) errors.push(proofIssue)
      }
      const changed = (await step('status', () => dirtyFiles(tree))) ?? []
      const diff = (await step('diff', () => writeDiff(tree, join(outDir, 'diff.patch')))) ?? null
      const added = (await step('added', () => addedLines(tree))) ?? null
      const bound = options.buildFirst ? await proveBound({ tree, outDir, onCleanup, step, changed, plan, envelope }) : null
      const tests = changed.filter((f) => f.endsWith('.test.mjs') && existsSync(join(tree, f)))
      const targeted = tests.length ? await step('tests', () => {
        const { NODE_TEST_CONTEXT, ...env } = process.env // a parent test runner would switch the child to its machine format
        const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: tree, env, encoding: 'utf8', timeout: 900_000 })
        if (r.error) throw r.error
        return r
      }) : null
      const journal = readJournal(task)
      return {
        wallS, stop: turn?.stopReason ?? null, usage: turn?.usage ?? null,
        envelope: envelope ? { status: envelope.status, summary: envelope.summary } : null,
        gate: gate ? { status: gate.status, reason: gate.reason, failing: gate.failingIds, error: checkDiagnostics(gate).error } : null,
        mutations: proof ? { status: proof.status, reason: proof.reason, diagnostics: checkDiagnostics(proof), killed: proof.rows?.filter((r) => r.outcome === 'killed').length, of: mutations.length, rows: proof.rows?.map((r) => `${r.check}:${r.outcome}${r.reason ? `/${r.reason}` : ''}`) } : null,
        targeted: targeted ? { files: tests.length, pass: count(targeted.stdout, 'pass'), fail: count(targeted.stdout, 'fail'), status: targeted.status } : null,
        armRows: rowKinds(journal), advisor: advisorRows(journal), changed, diff, added, bound,
      }
    },
  })
}

async function main(argv) {
  let result
  try {
    const { lane, cellFile, arms, out, charter, buildFirst } = parseCli(argv, { allowCharter: true, allowBuildFirst: true })
    result = await runBuilder({ lane, cellFile, arms, out, charter, buildFirst })
  } catch (e) {
    process.stderr.write(`replay-builder: ${errText(e)}\n`)
    process.exitCode = 2
    return
  }
  console.log(JSON.stringify({ id: result.id, lane: result.lane, error: result.error, gate: result.gate?.status ?? null, killed: result.mutations?.killed ?? null, of: result.mutations?.of ?? null, bound: result.bound ? { proven: result.bound.proven, of: result.bound.of } : null }))
  if (result.error) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2))
