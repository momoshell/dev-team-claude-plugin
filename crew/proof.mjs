// Red on the old source and green on the build shows that a test depends on the change.
// This is not a kill proof.
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { literalRelative, runSuite } from './checks.mjs'

export function testState(events, matches) {
  const hits = (events ?? []).filter(matches)
  if (hits.length === 0) return { state: null, reason: 'missing' }
  if (hits.length > 1) return { state: null, reason: 'ambiguous' }
  const [e] = hits
  if (e.skip) return { state: null, reason: 'skipped' }
  if (e.todo) return { state: null, reason: 'todo' }
  if (e.type === 'test:pass') return { state: 'green', reason: null }
  if (e.type === 'test:fail' && e.failureType === 'testCodeFailure') return { state: 'red', reason: null }
  return { state: null, reason: e.failureType === 'hookFailed' ? 'hook-failed' : e.failureType === 'cancelledByParent' ? 'cancelled' : 'not-body-failure' }
}

export async function testEvents({ cwd, files, timeoutMs }) {
  const run = await runSuite({ cwd, command: process.execPath, args: ['--test', `--test-reporter=${new URL('./proof-reporter.mjs', import.meta.url).href}`, '--test-reporter-destination=stdout', ...files], timeoutMs })
  const events = run.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  return { status: run.status, reason: run.reason, events }
}

// Refuse symlinked parents as well as the final path, including in the checkout.
function safePath(root, file, required) {
  let path = root
  const parts = file.split('/')
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i])
    const st = lstatSync(path, { throwIfNoEntry: false })
    if (!st) return !required
    if (i === parts.length - 1 ? !st.isFile() : !st.isDirectory()) return false
  }
  return true
}

export async function proveTests(input = {}) {
  const unmeasured = (reason, rows = []) => ({ status: 'unmeasured', reason, rows })
  let tmp, added = null, result, rows = []
  try {
    const { cwd, base = 'HEAD', tests, timeoutMs = 120_000 } = input ?? {}
    if (typeof cwd !== 'string' || !cwd || typeof base !== 'string' || !/^[^-\s]\S*$/.test(base) || !Array.isArray(tests) || !tests.length || !tests.every((t) => t && typeof t.file === 'string' && t.file && typeof t.title === 'string' && t.title)) return unmeasured('invalid-input')
    const notRun = () => ({ state: null, reason: 'not-run' })
    rows = tests.map(({ file, title }) => ({ file, title, base: notRun(), build: notRun(), proven: false, reason: null }))
    tmp = mkdtempSync(join(tmpdir(), 'crew-proof-'))
    // The old source runs in a detached worktree, a checkout like the build's, so an environment difference
    // (a missing .git, for one) can never supply the red.
    const root = join(tmp, 'base')
    const addRun = await runSuite({ cwd, command: 'git', args: ['worktree', 'add', '--detach', '--quiet', root, base], timeoutMs })
    if (addRun.status !== 'green') result = unmeasured(addRun.reason, rows)
    else {
      added = { cwd, root, timeoutMs }
      for (const row of rows) {
        if (!/\.[cm]?js$/.test(row.file)) row.reason = 'unsupported-runner'
        else if (!literalRelative(row.file) || !safePath(cwd, row.file, true) || !safePath(root, row.file, false)) row.reason = 'unsafe-path'
        else {
          const dest = join(root, row.file)
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(join(cwd, row.file), dest)
        }
      }
      const files = [...new Set(rows.filter((r) => !r.reason).map((r) => r.file))]
      if (files.length) {
        const old = await testEvents({ cwd: root, files, timeoutMs })
        const build = await testEvents({ cwd, files, timeoutMs })
        if (old.status === 'unmeasured' || build.status === 'unmeasured') result = unmeasured(old.status === 'unmeasured' ? old.reason : build.reason, rows)
        else {
          const hits = (events, dir, row) => events.filter((e) => {
            if (e?.name !== row.title || typeof e.file !== 'string') return false
            try { return relative(realpathSync(dir), realpathSync(e.file)).split(sep).join('/') === row.file } catch { return false }
          })
          for (const row of rows.filter((r) => !r.reason)) {
            const a = hits(old.events, root, row), b = hits(build.events, cwd, row)
            row.base = testState(a, () => true)
            row.build = testState(b, () => true)
            const identity = a.length === 1 && b.length === 1 && Number.isInteger(a[0].line) && Number.isInteger(a[0].column) && a[0].line === b[0].line && a[0].column === b[0].column
            row.proven = row.base.state === 'red' && row.build.state === 'green' && identity
            row.reason = row.proven ? null : row.base.state !== 'red' ? 'proof-not-red-on-base' : 'proof-not-green'
          }
        }
      }
      if (!result) result = rows.every((r) => r.proven) ? { status: 'green', reason: null, rows } : { status: 'red', reason: 'proof-unproven', rows }
    }
  } catch { result = unmeasured('runner-threw', rows) } finally {
    if (added) {
      const removed = await runSuite({ cwd: added.cwd, command: 'git', args: ['worktree', 'remove', '--force', added.root], timeoutMs: added.timeoutMs }).catch(() => null)
      if (removed?.status !== 'green') result = unmeasured('cleanup-unproven', rows)
    }
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }) } catch { result = unmeasured('cleanup-unproven', rows) }
  }
  return result
}
