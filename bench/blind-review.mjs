#!/usr/bin/env node
// Blind, shuffled Sol review of replay output dirs: diffs (builder replays) or plans+gates (planner replays).
//   node bench/blind-review.mjs --kind diff|plan --out <new reviews dir> --key <key file outside --out> <run dir>...
//   node bench/blind-review.mjs --reveal --out <reviews dir> --key <key file>
// Each run gets a random code. Everything under --out carries codes only; the code -> run key is
// written apart, to --key. The reviewer never sees a cell, arm, run id or input path.
import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideProtected, CHECKOUT, CORPUS_DIR, errText, git, inside, loadCorpus, realThrough } from './replay-common.mjs'

const DIFF_RUBRIC = 'Review only this change against the task. Count must-fix findings precisely.'
const PLAN_RUBRIC = "# What to review\n\nThis change adds a lane's plan (lane/plan.md) and acceptance gate (lane/gate.mjs) for the brief above, before any code is built. In the lane the gate runs from the task dir with the checkout as cwd. Judge whether a builder following this plan, checked by this gate, would deliver what the brief asks. A must-fix is a plan or gate defect that would let a wrong build pass, make a right build fail, or miss an acceptance item or invariant. Count must-fix findings precisely."

const present = (path) => { try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } } // a dangling symlink is present
const readOr = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

// Replace every path that would name the run or the recorded lane; longest first.
function scrubber(run, manifest) {
  const pairs = []
  const add = (from, to) => { if (typeof from === 'string' && from.length > 3) pairs.push([from, to]) }
  const real = realpathSync(run)
  for (const base of new Set([run, real])) { add(join(base, 'task'), '<task>'); add(join(base, 'tree'), '<checkout>') }
  add(manifest.originalTask, '<task>')
  add(manifest.originalTree, '<checkout>')
  const lean = readJson(join(run, 'task', 'lean.json'))
  add(lean?.taskDir, '<task>')
  add(lean?.cwd, '<checkout>')
  for (const base of new Set([run, real])) add(base, '<run>')
  add(basename(run), '<run>')
  pairs.sort((a, b) => b[0].length - a[0].length)
  return (text) => pairs.reduce((t, [from, to]) => t.replaceAll(from, to), text)
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) { const j = randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]] }
  return list
}

function newCode(used) {
  for (;;) { const code = randomBytes(4).toString('hex'); if (!used.has(code)) { used.add(code); return code } }
}

// Stage coded review inputs under `out` and write the code -> run key to keyPath.
// No git and no model call. Returns the shuffled jobs; each has a `code`.
export async function prepareReviews({ runs, kind, out, keyPath, corpusDir = CORPUS_DIR, checkoutDir = CHECKOUT, home = homedir() }) {
  if (kind !== 'diff' && kind !== 'plan') throw new Error(`kind must be diff or plan, got ${JSON.stringify(kind)}`)
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('give at least one run directory')
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('--out must be an absolute path')
  if (typeof keyPath !== 'string' || !keyPath) throw new Error('--key is required: the code-to-run key must be written apart from the reviews')
  const keyFile = resolve(keyPath)
  const outDir = resolve(out)
  if (present(keyFile)) throw new Error(`key file ${keyFile} already exists (or is a symlink)`)
  if (inside(realThrough(keyFile), realThrough(outDir)) || inside(keyFile, outDir)) throw new Error(`the key file ${keyFile} must be outside the reviews dir ${outDir} (the key stays separate from review outputs)`)
  const protectedRoots = { corpusDir, checkoutDir, home }
  assertOutsideProtected(outDir, 'reviews dir', protectedRoots)
  assertOutsideProtected(keyFile, 'key file', protectedRoots)
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`reviews dir ${outDir} is not empty`)

  const inputs = []
  for (const given of runs) {
    const run = resolve(given)
    if (!existsSync(run)) throw new Error(`run directory ${run} does not exist`)
    const result = readJson(join(run, 'result.json'))
    if (typeof result?.lane !== 'string') throw new Error(`${run} has no result.json lane`)
    inputs.push({ run, result, ...loadCorpus(result.lane, corpusDir) })
  }

  const used = new Set()
  const key = {}
  const jobs = []
  mkdirSync(outDir, { recursive: true })
  for (const { run, result, dir, manifest } of inputs) {
    const code = newCode(used)
    const scrub = scrubber(run, manifest)
    const job = { code, kind, lane: result.lane, base: manifest.base, context: `ctx-${code}.md`, missing: [] }
    let context
    if (kind === 'diff') {
      const plan = readOr(join(run, 'task', 'plan.md')) ?? readOr(join(dir, 'plan.md'))
      const diff = readOr(join(run, 'diff.patch'))
      job.patch = `diff-${code}.patch`
      if (diff === null) job.missing.push('diff.patch'); else writeFileSync(join(outDir, job.patch), scrub(diff))
      context = `# Task\n\n${scrub(plan ?? '')}\n\n${DIFF_RUBRIC}\n`
    } else {
      const plan = readOr(join(run, 'task', 'plan.md'))
      const gate = readOr(join(run, 'task', 'gate.mjs'))
      job.plan = `plan-${code}.md`
      job.gate = `gate-${code}.mjs`
      if (plan === null) job.missing.push('plan.md'); else writeFileSync(join(outDir, job.plan), scrub(plan))
      if (gate === null) job.missing.push('gate.mjs'); else writeFileSync(join(outDir, job.gate), scrub(gate))
      context = `# Brief\n\n${readFileSync(join(dir, 'brief.md'), 'utf8')}\n\n${PLAN_RUBRIC}\n`
    }
    writeFileSync(join(outDir, job.context), context)
    key[code] = run
    jobs.push(job)
  }
  shuffle(jobs)
  writeFileSync(join(outDir, 'jobs.json'), JSON.stringify(jobs, null, 2))
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, JSON.stringify(key, null, 2), { mode: 0o600, flag: 'wx' }) // exclusive: never follows a link planted since the check
  return jobs
}

// sol-review files its own artifact pair under $HOME/.crew/reviews. The reviewer is run with HOME set to a
// directory under the reviews dir: every entry of the real home (and of the real ~/.crew, bar `reviews`) is linked
// in so tools, auth and git config still resolve, while ~/.crew/reviews is a fresh directory inside the output.
// The private key is never reachable from it: the key file is left out, and a directory that holds it (directly
// or through a link) is staged as a real directory whose other entries are linked, so no link leads to the key.
export function confinedHome(dir, realHome = homedir(), keyPath = null) {
  mkdirSync(dir, { recursive: true })
  const keyReal = keyPath ? realThrough(resolve(keyPath)) : null
  const realOf = (path) => { try { return realpathSync(path) } catch { return null } }
  const stage = (from, to, skip = () => false) => {
    for (const name of existsSync(from) ? readdirSync(from) : []) {
      const src = join(from, name), dst = join(to, name)
      if (skip(name) || present(dst)) continue
      const real = realOf(src)
      if (keyReal && real && real === keyReal) continue // the key itself
      if (keyReal && real && inside(keyReal, real)) { // an ancestor of the key: no link may lead here
        mkdirSync(dst, { recursive: true })
        stage(real, dst)
        continue
      }
      symlinkSync(src, dst)
    }
  }
  stage(realHome, dir, (name) => name === '.crew')
  const crew = join(dir, '.crew')
  mkdirSync(join(crew, 'reviews'), { recursive: true })
  stage(join(realHome, '.crew'), crew, (name) => name === 'reviews')
  return dir
}

function runReviewer(reviewer, args, outFile, home) {
  return new Promise((resolveRun) => {
    const chunks = []
    const child = spawn(reviewer, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } })
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => chunks.push(d))
    child.on('error', (error) => { writeFileSync(outFile, Buffer.concat(chunks)); resolveRun({ status: null, error: errText(error) }) })
    child.on('close', (status) => { writeFileSync(outFile, Buffer.concat(chunks)); resolveRun({ status, error: null }) })
  })
}

const GIT_ID = ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false']

async function reviewOne(job, { out, repo, reviewer, home, homeError }) {
  const code = job.code
  const wt = join(out, 'work', code)
  const branch = `rv-${code}`
  const result = { code, status: 'error', error: null, exit: null }
  let added = false
  try {
    if (job.missing?.length) throw new Error(`input missing: ${job.missing.join(', ')}`)
    if (homeError) throw new Error(`confined reviewer home: ${homeError}`)
    const add = git(['-C', repo, 'worktree', 'add', '-q', '-b', branch, wt, job.base])
    if (add.status !== 0) throw new Error(`git worktree add failed: ${(add.stderr || '').trim()}`)
    added = true
    if (job.kind === 'diff') {
      const apply = git(['-C', wt, 'apply', '--whitespace=nowarn', join(out, job.patch)])
      if (apply.status !== 0) throw new Error(`the coded diff does not apply at ${job.base}: ${(apply.stderr || '').trim()}`)
      git(['-C', wt, 'add', '-A'])
      const commit = git(['-C', wt, ...GIT_ID, 'commit', '-q', '-m', 'change under review'])
      if (commit.status !== 0) throw new Error(`nothing to commit for the coded diff: ${(commit.stderr || commit.stdout || '').trim()}`)
    } else {
      mkdirSync(join(wt, 'lane'), { recursive: true })
      copyFileSync(join(out, job.plan), join(wt, 'lane', 'plan.md'))
      copyFileSync(join(out, job.gate), join(wt, 'lane', 'gate.mjs'))
      git(['-C', wt, 'add', '-A'])
      const commit = git(['-C', wt, ...GIT_ID, 'commit', '-q', '-m', 'lane plan and gate under review'])
      if (commit.status !== 0) throw new Error(`commit failed: ${(commit.stderr || commit.stdout || '').trim()}`)
    }
    const run = await runReviewer(reviewer, ['--repo', wt, '--base', job.base, '--context', join(out, job.context)], join(out, `review-${code}.txt`), home)
    result.exit = run.status
    if (run.error) throw new Error(`reviewer could not run: ${run.error}`)
    if (run.status !== 0) throw new Error(`reviewer exited ${run.status}`)
    const verdict = readFileSync(join(out, `review-${code}.txt`), 'utf8').match(/^REVIEW-VERDICT: (pass|changes)$/m)
    result.verdict = verdict?.[1] ?? null
    if (!verdict) throw new Error('review has no REVIEW-VERDICT line')
    result.status = 'ok'
  } catch (e) {
    result.error = errText(e)
  } finally {
    if (added) {
      const rm = git(['-C', repo, 'worktree', 'remove', '--force', wt])
      const br = git(['-C', repo, 'branch', '-q', '-D', branch])
      const failed = [rm.status !== 0 && `worktree remove: ${(rm.stderr || '').trim()}`, br.status !== 0 && `branch delete: ${(br.stderr || '').trim()}`].filter(Boolean)
      if (failed.length) { result.status = 'error'; result.error = [result.error, `cleanup: ${failed.join('; ')}`].filter(Boolean).join('; ') }
    }
  }
  writeFileSync(join(out, `result-${code}.json`), JSON.stringify(result, null, 2))
  return result
}

// Run prepared jobs: a disposable worktree per job, the coded change applied, then the reviewer.
// Every job produces a result row, including failures.
export async function runReviews({ jobs, out, reviewer, repo = CHECKOUT, concurrency = 3, home: realHome = homedir(), keyPath = null }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a positive integer, got ${JSON.stringify(concurrency)}`)
  const outDir = resolve(out)
  const home = join(outDir, '.reviewer-home')
  let homeError = null
  try { confinedHome(home, realHome, keyPath) } catch (e) { homeError = errText(e) }
  const results = new Array(jobs.length)
  let next = 0
  const worker = async () => { while (next < jobs.length) { const i = next++; results[i] = await reviewOne(jobs[i], { out: outDir, repo, reviewer, home, homeError }) } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker))
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  return results
}

// Join the reviews to their runs. Reads the key; writes nothing.
export function reveal({ out, keyPath }) {
  const key = JSON.parse(readFileSync(resolve(keyPath), 'utf8'))
  return Object.entries(key).sort(([a], [b]) => a.localeCompare(b)).map(([code, run]) => {
    const result = readJson(join(out, `result-${code}.json`))
    const lane = readJson(join(run, 'result.json'))
    return { code, run, lane: lane?.lane ?? null, review: result?.status ?? 'missing', verdict: result?.verdict ?? null, error: result?.error ?? null }
  })
}

function parse(argv) {
  const o = { runs: [], reviewer: process.env.SOL_REVIEW ?? join(homedir(), '.crew', 'tools', 'sol-review'), concurrency: 3 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); return argv[++i] }
    if (flag === '--kind') o.kind = value()
    else if (flag === '--out') o.out = value()
    else if (flag === '--key') o.key = value()
    else if (flag === '--reviewer') o.reviewer = value()
    else if (flag === '--concurrency') o.concurrency = Number(value())
    else if (flag === '--prepare-only') o.prepareOnly = true
    else if (flag === '--reveal') o.reveal = true
    else if (flag.startsWith('--')) throw new Error(`unknown argument ${flag}`)
    else o.runs.push(flag)
  }
  return o
}

async function main(argv) {
  try {
    const o = parse(argv)
    if (!Number.isSafeInteger(o.concurrency) || o.concurrency < 1) throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(o.concurrency)}`)
    if (o.reveal) {
      if (!o.out || !o.key) throw new Error('--reveal needs --out and --key')
      for (const row of reveal({ out: resolve(o.out), keyPath: o.key })) console.log(JSON.stringify(row))
      return
    }
    const jobs = await prepareReviews({ runs: o.runs, kind: o.kind, out: o.out, keyPath: o.key })
    if (o.prepareOnly) { console.log(`prepared ${jobs.length} coded reviews in ${resolve(o.out)}`); return }
    const results = await runReviews({ jobs, out: o.out, reviewer: o.reviewer, concurrency: o.concurrency, keyPath: o.key })
    const failed = results.filter((r) => r.status !== 'ok')
    console.log(`${results.length} reviews, ${failed.length} failed; decode with --reveal --out ${resolve(o.out)} --key ${resolve(o.key)}`)
    if (failed.length) process.exitCode = 1
  } catch (e) {
    process.stderr.write(`blind-review: ${errText(e)}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2))
