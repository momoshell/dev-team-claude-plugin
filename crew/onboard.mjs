// Calibrate project proof runners in a disposable worktree (ADR-057).
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { literalRelative, runSuite, validTimeout } from './checks.mjs'
import { entryCommand, junitEvents, PROOF_TIMEOUT_DEFAULT_MS, testState, validProofEntry } from './proof.mjs'

export const SUITE_TIMEOUT_DEFAULT_MS = 1800000
export const ONBOARD_REASONS = Object.freeze(['not-onboarded', 'onboarding-stale'])
export class OnboardRefusal extends Error {
  constructor(reason) {
    super(`${reason}: run /onboard to calibrate this checkout`)
    if (!ONBOARD_REASONS.includes(reason)) throw new TypeError(`unknown onboarding refusal: ${reason}`)
    this.reason = reason
  }
}

export const projectHash = ({ suite, proof }) => createHash('sha256').update(JSON.stringify([suite, proof.map((e) => [e.match, e.setup ?? null, e.run])])).digest('hex')
const validProject = (p) => p && typeof p === 'object' && !Array.isArray(p) && typeof p.suite === 'string' && p.suite.trim() && !/["'\\\0]/.test(p.suite) && Array.isArray(p.proof) && p.proof.every(validProofEntry) && (p.suiteTimeoutMs === undefined || validTimeout(p.suiteTimeoutMs)) && (p.proofTimeoutMs === undefined || validTimeout(p.proofTimeoutMs))

export function requireOnboarded(checkout, read = readFileSync) {
  let p
  try { p = JSON.parse(read(join(checkout, '.crew', 'project.json'), 'utf8')) } catch (error) {
    throw new OnboardRefusal(error?.code === 'ENOENT' ? 'not-onboarded' : 'onboarding-stale')
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new OnboardRefusal('onboarding-stale')
  if (!Object.hasOwn(p, 'onboarded')) throw new OnboardRefusal('not-onboarded')
  if (!validProject(p) || !p.onboarded || typeof p.onboarded !== 'object' || p.onboarded.hash !== projectHash(p)) throw new OnboardRefusal('onboarding-stale')
  return { suite: p.suite, proof: p.proof, hash: p.onboarded.hash, suiteTimeoutMs: p.suiteTimeoutMs ?? SUITE_TIMEOUT_DEFAULT_MS, proofTimeoutMs: p.proofTimeoutMs ?? PROOF_TIMEOUT_DEFAULT_MS }
}

export async function checkOnboarding({ checkout, draft, timeoutMs = 120_000 }) {
  let rows = [], tmp, root, added = false, cleanupFailed = false
  try {
    const p = JSON.parse(readFileSync(draft, 'utf8'))
    if (!validProject(p)) throw new Error('invalid suite or proof')
    rows = p.proof.map((e) => ({ match: e.match, reason: 'not-run' }))
    for (const [i, e] of p.proof.entries()) {
      const c = e.calibrate
      if (!c || typeof c !== 'object' || typeof c.file !== 'string' || !literalRelative(c.file) || typeof c.text !== 'string' || !c.text || typeof c.pass !== 'string' || !c.pass.trim() || typeof c.fail !== 'string' || !c.fail.trim() || c.pass === c.fail || p.proof.findIndex((entry) => matchesGlob(c.file, entry.match)) !== i) throw new Error(`invalid calibration for ${e.match}`)
    }
    tmp = mkdtempSync(join(tmpdir(), 'crew-onboard-'))
    root = join(tmp, 'tree')
    const add = await runSuite({ cwd: checkout, command: 'git', args: ['worktree', 'add', '--detach', '--quiet', root, 'HEAD'], timeoutMs })
    if (add.status !== 'green') throw new Error(`worktree add: ${add.reason ?? add.status}`)
    added = true
    for (const [i, e] of p.proof.entries()) {
      try {
        const c = e.calibrate
        let path = root
        for (const part of c.file.split('/')) {
          path = join(path, part)
          const st = lstatSync(path, { throwIfNoEntry: false })
          if (st?.isSymbolicLink() || (st && path !== join(root, c.file) && !st.isDirectory())) throw new Error('unsafe probe path')
        }
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, c.text)
        if (e.setup) {
          const [command, ...args] = e.setup.trim().split(/\s+/)
          const setup = await runSuite({ cwd: root, command, args, timeoutMs })
          if (setup.status !== 'green') throw new Error(`setup: ${setup.reason ?? setup.status}`)
        }
        for (const [side, title, expected] of [['pass', c.pass, 'green'], ['fail', c.fail, 'red']]) {
          const report = join(tmp, `report-${i}-${side}.xml`)
          const values = { file: c.file, title, report, stem: basename(c.file, extname(c.file)) }
          const [command, ...args] = entryCommand(e.run, values)
          const run = await runSuite({ cwd: root, command, args, timeoutMs })
          if (run.status === 'unmeasured') throw new Error(`${side}: ${run.reason}`)
          let events
          try { events = junitEvents(readFileSync(report, 'utf8')) } catch {}
          const state = testState(events?.filter((event) => title === event.name || (event.classname && (title === `${event.classname}.${event.name}` || title === `${event.classname}::${event.name}`))))
          if (state.state !== expected) throw new Error(`${side}: expected ${expected}, got ${state.state ?? state.reason}`)
        }
        rows[i].reason = null
      } catch (error) { rows[i].reason = error.message }
    }
    if (rows.some((row) => row.reason)) return { status: 'red', rows }
    const proof = p.proof.map(({ calibrate, ...entry }) => entry)
    // Cleanup must be proven before the project file is written.
    if (added) {
      const removed = await runSuite({ cwd: checkout, command: 'git', args: ['worktree', 'remove', '--force', '--force', root], timeoutMs })
      if (removed.status !== 'green') { cleanupFailed = true; throw new Error(`cleanup: ${removed.reason ?? removed.status}; kept ${root}`) }
      added = false
    }
    rmSync(tmp, { recursive: true, force: true }); tmp = null
    const project = { suite: p.suite, proof, ...(p.suiteTimeoutMs === undefined ? {} : { suiteTimeoutMs: p.suiteTimeoutMs }), ...(p.proofTimeoutMs === undefined ? {} : { proofTimeoutMs: p.proofTimeoutMs }) }
    const dir = join(checkout, '.crew'), target = join(dir, 'project.json')
    const dirStat = lstatSync(dir, { throwIfNoEntry: false })
    const fileStat = dirStat?.isDirectory() ? lstatSync(target, { throwIfNoEntry: false }) : null
    if ((dirStat && !dirStat.isDirectory()) || (fileStat && !fileStat.isFile())) throw new Error('unsafe project path')
    mkdirSync(dir, { recursive: true })
    const staged = join(dir, `.onboard-${randomUUID()}`)
    try {
      writeFileSync(staged, `${JSON.stringify({ ...project, onboarded: { hash: projectHash(project) } }, null, 2)}\n`, { flag: 'wx' })
      renameSync(staged, target)
    } catch (error) {
      rmSync(staged, { force: true })
      throw error
    }
    return { status: 'green', rows }
  } catch (error) {
    return { status: 'red', rows: rows.length ? rows.map((row) => ({ ...row, reason: !row.reason || row.reason === 'not-run' ? error.message : row.reason })) : [{ match: 'draft', reason: error.message }] }
  } finally {
    if (added && !cleanupFailed) {
      const removed = await runSuite({ cwd: checkout, command: 'git', args: ['worktree', 'remove', '--force', '--force', root], timeoutMs }).catch(() => null)
      if (removed?.status !== 'green') { cleanupFailed = true; rows.push({ match: 'cleanup', reason: `cleanup failed; kept ${root}` }) }
    }
    if (tmp && !cleanupFailed) try { rmSync(tmp, { recursive: true, force: true }) } catch { rows.push({ match: 'cleanup', reason: 'cleanup failed' }) }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let draft, checkout, bad = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!['--check', '--checkout'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('-') || (flag === '--check' ? draft : checkout)) { bad = true; break }
    if (flag === '--check') draft = resolve(argv[++i]); else checkout = resolve(argv[++i])
  }
  if (bad || !draft) { process.stderr.write('usage: crew onboard --check <draft.json> [--checkout <dir>]\n'); return 2 }
  if (!checkout) {
    const git = await runSuite({ cwd: process.cwd(), command: 'git', args: ['rev-parse', '--show-toplevel'] })
    if (git.status !== 'green') { process.stderr.write('crew onboard: not inside a git checkout; pass --checkout <dir>\n'); return 1 }
    checkout = git.stdout.trim()
  }
  const result = await checkOnboarding({ checkout, draft })
  for (const row of result.rows) process.stdout.write(`crew onboard: ${row.match}: ${row.reason ?? 'proven'}\n`)
  if (!result.rows.length) process.stdout.write(`crew onboard: ${result.status === 'green' ? 'no proof entries; project recorded' : 'failed'}\n`)
  return result.status === 'green' ? 0 : 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main()
