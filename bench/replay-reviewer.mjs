#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEnvelope } from '../crew/protocols.mjs'
import { CHECKOUT, SCOPE_BACKFILL, addWorktree, advisorRows, callSeat, errText, git, loadCorpus, loadEnvelope, parseCli, readCellFile, readJournal, rewriter, rowKinds, runReplay, seatDefinition, sleepMs, validateArms, validateCell, writeJournalStart } from './replay-common.mjs'

function prepare({ lane, outDir, onCleanup, deps }) {
  const { dir, manifest } = loadCorpus(lane, deps.corpusDir)
  const builtHead = manifest.reviewer?.builtHead
  if (!builtHead) throw new Error('missing reproducible built head')
  if (typeof builtHead !== 'string' || !/^[0-9a-f]{40}$/.test(builtHead)) throw new Error('invalid built head pin')
  const repo = deps.repoDir ?? CHECKOUT
  const resolved = git(['-C', repo, 'rev-parse', '--verify', `${builtHead}^{commit}`])
  if (resolved.status !== 0) throw new Error('unresolvable built head')
  const parents = git(['-C', repo, 'rev-list', '--parents', '-n', '1', resolved.stdout.trim()])
  const parts = parents.stdout.trim().split(/\s+/)
  if (parents.status !== 0 || parts.length !== 2) throw new Error('built head must have exactly one parent')
  const reviewBase = parts[1]
  let recordedPrompt
  try { recordedPrompt = readFileSync(join(dir, 'reviewer-prompt.txt'), 'utf8') } catch { throw new Error('missing first reviewer prompt') }
  if (!recordedPrompt.trim()) throw new Error('missing first reviewer prompt')
  const task = join(outDir, 'task'), tree = join(outDir, 'tree')
  const rewrite = rewriter(manifest, task, tree)
  const prompt = rewrite(recordedPrompt)
  const returnName = prompt.match(/reviewer-\d+\.json/)?.[0]
  if (!returnName) throw new Error('reviewer prompt names no return file')
  ;(deps.addWorktree ?? addWorktree)({ repo, base: builtHead, tree, onCleanup })
  const reset = git(['-C', tree, 'reset', '--mixed', reviewBase])
  if (reset.status !== 0) throw new Error(`git reset failed: ${reset.stderr}`)
  writeJournalStart(task, deps.sleepMs ?? sleepMs)
  for (const name of ['plan.md', 'gate.mjs', 'planner-1.json', 'lean.json']) writeFileSync(join(task, name), rewrite(readFileSync(join(dir, name), 'utf8')))
  const file = join(task, 'planner-1.json')
  const ret = JSON.parse(readFileSync(file, 'utf8'))
  ret.details ??= {}
  if (SCOPE_BACKFILL[lane]) {
    ret.details.files_in_scope ??= SCOPE_BACKFILL[lane]
    ret.details.validation_lane ??= `node --test ${SCOPE_BACKFILL[lane].filter((f) => f.endsWith('.test.mjs')).join(' ')}`
  }
  ret.details.gate_cmd ??= `node ${join(task, 'gate.mjs')}`
  writeFileSync(file, JSON.stringify(ret, null, 2))
  return { prompt, briefText: readFileSync(join(dir, 'brief.md'), 'utf8'), cwd: tree, taskDir: task, returnName, plan: ret.details, knownDefect: manifest.knownDefect ?? null }
}

function seed(tree, rows, check) {
  const matches = Array.isArray(rows) ? rows.filter((row) => row?.check === check) : []
  if (matches.length !== 1) throw new Error('mutation check must select exactly one declaration')
  const mutation = matches[0]
  if (typeof mutation.check !== 'string' || !mutation.check.trim() || typeof mutation.file !== 'string' || !mutation.file || typeof mutation.find !== 'string' || !mutation.find || typeof mutation.replace !== 'string' || mutation.find === mutation.replace) throw new Error('invalid mutation declaration')
  const name = mutation.file
  if (isAbsolute(name) || name.split(/[\\/]/).some((p) => !p || p === '.' || p === '..' || p === '.git') || name.includes('\\')) throw new Error('unsafe mutation path')
  const file = join(tree, name)
  let at = tree
  for (const part of name.split('/')) {
    at = join(at, part)
    if (lstatSync(at).isSymbolicLink()) throw new Error('unsafe mutation symlink')
  }
  if (!lstatSync(file).isFile() || !realpathSync(file).startsWith(realpathSync(tree) + sep)) throw new Error('unsafe mutation file')
  const source = readFileSync(file, 'utf8')
  const first = source.indexOf(mutation.find)
  if (first < 0 || source.indexOf(mutation.find, first + 1) !== -1) throw new Error('mutation find must occur exactly once')
  writeFileSync(file, source.replace(mutation.find, mutation.replace))
  return mutation
}

export async function runReviewer(options, deps = {}) {
  const { lane, arms, variant, mutation } = options ?? {}
  return runReplay({ kind: 'reviewer', options, deps, async body({ outDir, errors, onCleanup, result }) {
    Object.assign(result, { variant: variant ?? null, seededMutation: null, verdict: null, findings: null, seededFileCited: null, knownDefect: null, defectFileCited: null, firstReturnStatus: null, usage: null, wallS: null, unknown: { verdict: 'not-measured', findings: 'not-measured', defectFileCited: 'not-measured', seededFileCited: variant === 'clean' ? 'not-seeded' : 'not-measured', firstReturnStatus: 'not-measured', usage: 'not-measured', wallS: 'not-measured' } })
    validateArms(arms)
    const cell = validateCell(options.cell ?? readCellFile(options.cellFile))
    result.cell = cell
    if (!['clean', 'seeded'].includes(variant)) throw new Error('variant must be clean or seeded')
    if (variant === 'seeded' ? typeof mutation !== 'string' || !mutation.trim() : mutation !== undefined) throw new Error('seeded requires mutation; clean rejects mutation')
    const prep = prepare({ lane, outDir, onCleanup, deps })
    result.knownDefect = prep.knownDefect
    if (!prep.knownDefect) result.unknown.defectFileCited = 'no-known-defect'
    if (variant === 'seeded') result.seededMutation = seed(prep.cwd, prep.plan.mutations, mutation)
    const { turn, error, wallS } = await callSeat({ deps, definition: seatDefinition({ role: 'reviewer', cell, arms }), prep, outDir })
    result.wallS = wallS; delete result.unknown.wallS
    result.usage = turn?.usage ?? null
    if (result.usage !== null) delete result.unknown.usage
    if (error) errors.push(`seat: ${error}`)
    if (cell.advisor) (deps.sleepMs ?? sleepMs)((cell.settle_s ?? 120) * 1000)
    const loaded = loadEnvelope(prep.taskDir, prep.returnName)
    Object.assign(result, { status: loaded.status, status_reason: loaded.status_reason })
    if (loaded.error) errors.push(loaded.error)
    let envelope = loaded.envelope
    const expectedId = prep.prompt.match(/^Envelope id:\s*(\S+)/m)?.[1]
    if (envelope) {
      const { defects } = validateEnvelope('reviewer', envelope)
      if (expectedId && envelope.id !== expectedId) defects.push('id does not match issued id')
      if (defects.length) { errors.push(`envelope: ${defects.join('; ')}`); envelope = null }
    }
    if (envelope) { result.firstReturnStatus = envelope.status; delete result.unknown.firstReturnStatus }
    const d = envelope?.details
    if (envelope?.status === 'done') {
      result.verdict = d.verdict; result.findings = d.findings
      delete result.unknown.verdict; delete result.unknown.findings
      if (prep.knownDefect) {
        const names = prep.knownDefect.files.flatMap((file) => [file, join(prep.cwd, file)])
        result.defectFileCited = d.findings.some((finding) => names.some((name) => finding.location === name || (finding.location.startsWith(name + ':') && /^:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/.test(finding.location.slice(name.length)))))
        delete result.unknown.defectFileCited
      }
      if (variant === 'seeded') {
        const names = [result.seededMutation.file, join(prep.cwd, result.seededMutation.file)]
        result.seededFileCited = d.findings.some((finding) => finding.severity === 'must-fix' && names.some((name) => finding.location === name || (finding.location.startsWith(name + ':') && /^:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/.test(finding.location.slice(name.length)))))
        delete result.unknown.seededFileCited
      }
    }
    const journal = readJournal(prep.taskDir)
    result.stop = turn?.stopReason ?? null
    result.armRows = rowKinds(journal); result.advisor = advisorRows(journal)
    return {}
  } })
}

export function parseReviewerCli(argv) {
  const rest = [], extra = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--variant' || argv[i] === '--mutation') {
      const key = argv[i].slice(2)
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`)
      extra[key] = argv[++i]
    } else rest.push(argv[i])
  }
  return { ...parseCli(rest), ...extra }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await runReviewer(parseReviewerCli(process.argv.slice(2)))
    console.log(JSON.stringify({ id: result.id, lane: result.lane, error: result.error, verdict: result.verdict }))
    if (result.error) process.exitCode = 1
  } catch (e) { process.stderr.write(`replay-reviewer: ${errText(e)}\n`); process.exitCode = 2 }
}
