import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareReviews, reveal, runReviews } from './blind-review.mjs'
import { CHECKOUT, CORPUS_DIR } from './replay-common.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'blind-review-test-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0
const fresh = (label) => join(scratch, `${label}-${n++}`)
const put = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)) }
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))
const fakeHome = () => { const h = fresh('home'); mkdirSync(join(h, '.crew', 'tools'), { recursive: true }); writeFileSync(join(h, '.gitconfig'), '[user]\n'); return h }
const files = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.reviewer-home').flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))

function makeRuns(count = 2) {
  return Array.from({ length: count }, (_, i) => {
    const run = fresh(`secret-run-${i}`)
    put(join(run, 'result.json'), { id: `secret-run-${i}`, lane: 'b1380', cell: { model: 'secret-model' }, arms: ['secret-arm'] })
    put(join(run, 'diff.patch'), `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+changed-${i} ${run}/tree\n`)
    put(join(run, 'task', 'plan.md'), `# plan-${i}\n${run}/task and ${run}/tree\n`)
    put(join(run, 'task', 'gate.mjs'), `// gate-${i} ${run}/task\n`)
    return run
  })
}

test('diff and plan reviews are coded, shuffled inputs with the key apart', async () => {
  const runs = makeRuns(5)
  for (const kind of ['diff', 'plan']) {
    const out = fresh(`reviews-${kind}`), keyPath = fresh('keys') + '/key.json'
    const jobs = await prepareReviews({ runs, kind, out, keyPath })
    const key = json(keyPath)
    assert.equal(jobs.length, 5)
    assert.deepEqual(Object.values(key).sort(), [...runs].sort())
    assert.deepEqual(jobs.map((j) => j.code).sort(), Object.keys(key).sort())
    assert.equal(new Set(jobs.map((j) => j.code)).size, 5)
    const all = files(out)
    const text = all.join('\n') + all.map((f) => readFileSync(f, 'utf8')).join('\n')
    for (const secret of [...runs, 'secret-run', 'secret-model', 'secret-arm']) assert(!text.includes(secret), `leaked ${secret}`)
    assert(!all.includes(keyPath))
    for (const job of jobs) {
      assert(readFileSync(join(out, job.context), 'utf8').length > 0)
      if (kind === 'diff') assert(/\+changed-\d <run>\/tree|\+changed-\d <checkout>/.test(readFileSync(join(out, job.patch), 'utf8')))
      else {
        assert(/<task>/.test(readFileSync(join(out, job.plan), 'utf8')))
        assert(readFileSync(join(out, job.context), 'utf8').includes('# Brief'))
      }
    }
  }
})

test('the key must stay outside the reviews dir, including through symlinks', async () => {
  const runs = makeRuns(1)
  const out = fresh('reviews')
  await assert.rejects(prepareReviews({ runs, kind: 'diff', out, keyPath: join(out, 'key.json') }), /key/)
  assert(!existsSync(out))
  const real = fresh('real')
  mkdirSync(real)
  const alias = fresh('alias')
  symlinkSync(real, alias)
  await assert.rejects(prepareReviews({ runs, kind: 'plan', out: real, keyPath: join(alias, 'k.json') }), /key/)
  await assert.rejects(prepareReviews({ runs, kind: 'plan', out: alias, keyPath: join(real, 'sub', 'k.json') }), /key/)
  assert.deepEqual(readdirSync(real), [])
})

test('a dangling symlink at the key path cannot publish the key into the reviews', async () => {
  const runs = makeRuns(1)
  const out = fresh('reviews'), elsewhere = fresh('elsewhere')
  mkdirSync(elsewhere)
  const keyLink = join(elsewhere, 'key.json')
  symlinkSync(join(out, 'key.json'), keyLink) // dangling: out does not exist yet
  await assert.rejects(prepareReviews({ runs, kind: 'diff', out, keyPath: keyLink }), /key/)
  assert(!existsSync(out))
  // a link into an existing reviews dir, and a link chain through a dangling directory alias
  const out2 = fresh('reviews')
  mkdirSync(out2)
  const link2 = join(elsewhere, 'k2.json')
  symlinkSync(join(out2, 'key.json'), link2)
  await assert.rejects(prepareReviews({ runs, kind: 'plan', out: out2, keyPath: link2 }), /key/)
  assert.deepEqual(readdirSync(out2), [])
  const dirLink = join(elsewhere, 'dir')
  symlinkSync(join(out, 'sub'), dirLink)
  await assert.rejects(prepareReviews({ runs, kind: 'plan', out, keyPath: join(dirLink, 'k.json') }))
  assert(!existsSync(out))
})

test('both destinations stay out of the corpus, the checkout and ~/.crew', async () => {
  const runs = makeRuns(1)
  const home = fakeHome()
  const ok = { runs, kind: 'diff', home }
  await assert.rejects(prepareReviews({ ...ok, out: join(CORPUS_DIR, 'b1380', 'reviews'), keyPath: fresh('k') }), /corpus/)
  await assert.rejects(prepareReviews({ ...ok, out: join(CHECKOUT, 'bench', 'reviews-x'), keyPath: fresh('k') }), /checkout/)
  await assert.rejects(prepareReviews({ ...ok, out: join(home, '.crew', 'reviews-x'), keyPath: fresh('k') }), /\.crew/)
  await assert.rejects(prepareReviews({ ...ok, out: fresh('o'), keyPath: join(CORPUS_DIR, 'b1380', 'key.json') }), /corpus/)
  await assert.rejects(prepareReviews({ ...ok, out: fresh('o'), keyPath: join(CHECKOUT, 'key.json') }), /checkout/)
  await assert.rejects(prepareReviews({ ...ok, out: fresh('o'), keyPath: join(home, '.crew', 'key.json') }), /\.crew/)
  const alias = fresh('alias')
  symlinkSync(CORPUS_DIR, alias)
  await assert.rejects(prepareReviews({ ...ok, out: join(alias, 'b1380', 'r'), keyPath: fresh('k') }), /corpus|checkout/)
  assert(!existsSync(join(CORPUS_DIR, 'b1380', 'reviews')) && !existsSync(join(CORPUS_DIR, 'b1380', 'r')) && !existsSync(join(CHECKOUT, 'key.json')))
})

test('bad input is refused, a missing artifact stays visible', async () => {
  const runs = makeRuns(2)
  await assert.rejects(prepareReviews({ runs, kind: 'other', out: fresh('o'), keyPath: fresh('k') }), /kind/)
  await assert.rejects(prepareReviews({ runs: [], kind: 'diff', out: fresh('o'), keyPath: fresh('k') }), /at least one/)
  await assert.rejects(prepareReviews({ runs: [fresh('nope')], kind: 'diff', out: fresh('o'), keyPath: fresh('k') }), /does not exist/)
  rmSync(join(runs[1], 'diff.patch'))
  const jobs = await prepareReviews({ runs, kind: 'diff', out: fresh('o'), keyPath: fresh('k') })
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.flatMap((j) => j.missing), ['diff.patch'])
})

function reviewRepo() {
  const repo = fresh('repo')
  mkdirSync(repo)
  const sh = (...a) => { const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  writeFileSync(join(repo, 'x'), 'a\n')
  sh('init', '-q'); sh('add', '.'); sh('commit', '-q', '-m', 'base')
  return { repo, base: sh('rev-parse', 'HEAD') }
}

test('execution applies the coded change, runs the reviewer, cleans up and keeps every result', async () => {
  const { repo, base } = reviewRepo()
  const runs = makeRuns(2)
  for (const run of runs) put(join(run, 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  const out = fresh('reviews'), keyPath = fresh('keys') + '/key.json'
  const jobs = (await prepareReviews({ runs, kind: 'diff', out, keyPath })).map((j) => ({ ...j, base }))
  jobs[0].base = base
  const reviewer = fresh('reviewer') + '.sh'
  put(reviewer, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case $1 in --repo) R=$2;; esac; shift; done\ngrep -q "^b$" "$R/x" && echo "found change" || echo "no change"\nif [ "$(git -C "$R" log --format=%s -1)" = "change under review" ]; then echo "REVIEW-VERDICT: pass"; fi\n')
  chmodSync(reviewer, 0o755)
  const results = await runReviews({ jobs, out, reviewer, repo, home: fakeHome() })
  assert.equal(results.length, 2)
  for (const r of results) assert.equal(r.status, 'ok', r.error)
  for (const j of jobs) assert(/found change/.test(readFileSync(join(out, `review-${j.code}.txt`), 'utf8')))
  assert.equal(spawnSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1)
  assert.equal(spawnSync('git', ['-C', repo, 'branch', '--list', 'rv-*'], { encoding: 'utf8' }).stdout.trim(), '')
  const text = files(out).map((f) => readFileSync(f, 'utf8')).join('\n')
  for (const run of runs) assert(!text.includes(run))
  assert.deepEqual(reveal({ out, keyPath }).map((r) => r.review), ['ok', 'ok'])
  assert(reveal({ out, keyPath }).every((r) => r.verdict === 'pass'))
})

test('diff and plan commits bypass inherited refusing hooks only in disposable worktrees', async () => {
  const { repo, base } = reviewRepo()
  const hooks = fresh('hooks'), sentinel = fresh('hook-ran')
  mkdirSync(hooks)
  const hook = join(hooks, 'pre-commit')
  const hookText = `#!/bin/sh\necho ran > '${sentinel}'\nexit 1\n`
  put(hook, hookText); chmodSync(hook, 0o755)
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(git('config', 'core.hooksPath', hooks).status, 0)
  const probe = git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '--allow-empty', '-m', 'probe')
  assert.notEqual(probe.status, 0)
  assert(existsSync(sentinel))
  rmSync(sentinel)
  const status = git('status', '--porcelain').stdout
  const runs = makeRuns(1)
  put(join(runs[0], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  for (const kind of ['diff', 'plan']) {
    const out = fresh('reviews')
    const jobs = (await prepareReviews({ runs, kind, out, keyPath: fresh('k') + '/key.json' })).map((j) => ({ ...j, base }))
    const reviewer = fresh('reviewer') + '.sh'
    const contentCheck = kind === 'diff'
      ? '[ "$(git -C "$R" show HEAD:x)" = b ]'
      : '[ "$(git -C "$R" show HEAD:lane/plan.md)" = "$(cat "$R/lane/plan.md")" ] && git -C "$R" cat-file -e HEAD:lane/gate.mjs'
    put(reviewer, `#!/bin/sh\nwhile [ $# -gt 0 ]; do case $1 in --repo) R=$2;; --base) B=$2;; esac; shift; done\n[ "$R" != '${repo}' ] && [ "$(git -C "$R" rev-parse HEAD^)" = "$B" ] && [ "$(git -C "$R" log -1 --format='%an <%ae>')" = 'bench <bench@example.invalid>' ] && ${contentCheck} && echo 'REVIEW-VERDICT: pass'\n`)
    chmodSync(reviewer, 0o755)
    const [result] = await runReviews({ jobs, out, reviewer, repo, home: fakeHome() })
    assert.equal(result.status, 'ok', result.error)
    assert.equal(result.verdict, 'pass')
    assert.deepEqual(json(join(out, `result-${result.code}.json`)), result)
    assert.deepEqual(json(join(out, 'results.json')), [result])
    assert(!existsSync(sentinel))
    assert.equal(git('rev-parse', 'HEAD').stdout.trim(), base)
    assert.equal(git('status', '--porcelain').stdout, status)
    assert.equal(readFileSync(join(repo, 'x'), 'utf8'), 'a\n')
    assert(!existsSync(join(repo, 'lane')))
    assert.equal(readFileSync(hook, 'utf8'), hookText)
    assert.equal(git('config', 'core.hooksPath').stdout.trim(), hooks)
    assert.equal(git('worktree', 'list', '--porcelain').stdout.match(/^worktree /gm).length, 1)
    assert.equal(git('branch', '--list', 'rv-*').stdout.trim(), '')
  }
})

test('a failed worktree cleanup turns an otherwise good review into an error result', async () => {
  const { repo, base } = reviewRepo()
  const runs = makeRuns(1)
  put(join(runs[0], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  const out = fresh('reviews')
  const jobs = (await prepareReviews({ runs, kind: 'diff', out, keyPath: fresh('k') + '/key.json' })).map((j) => ({ ...j, base }))
  const reviewer = fresh('reviewer') + '.sh'
  // a locked worktree cannot be removed by a single --force, and its checked-out branch cannot be deleted
  put(reviewer, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case $1 in --repo) R=$2;; esac; shift; done\ngit -C "$R" worktree lock "$R"\necho "REVIEW-VERDICT: pass"\n')
  chmodSync(reviewer, 0o755)
  const [r] = await runReviews({ jobs, out, reviewer, repo, home: fakeHome() })
  assert.equal(r.status, 'error')
  assert.match(r.error, /cleanup: .*worktree remove/)
  assert.match(r.error, /branch delete/)
  assert.equal(json(join(out, `result-${r.code}.json`)).status, 'error')
  assert.equal(json(join(out, 'results.json'))[0].status, 'error')
  spawnSync('git', ['-C', repo, 'worktree', 'unlock', join(out, 'work', r.code)])
})

test('execution failures are results, not omissions', async () => {
  const { repo, base } = reviewRepo()
  const runs = makeRuns(3)
  put(join(runs[0], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-zzz\n+b\n') // does not apply
  rmSync(join(runs[1], 'diff.patch')) // missing
  put(join(runs[2], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  const out = fresh('reviews')
  const jobs = (await prepareReviews({ runs, kind: 'diff', out, keyPath: fresh('k') + '/key.json' })).map((j) => ({ ...j, base }))
  const results = await runReviews({ jobs, out, reviewer: '/nonexistent/reviewer', repo, home: fakeHome() })
  assert.equal(results.length, 3)
  assert(results.every((r) => r.status === 'error' && r.error))
  assert(results.some((r) => /does not apply/.test(r.error)))
  assert(results.some((r) => /input missing/.test(r.error)))
  assert(results.some((r) => /reviewer could not run/.test(r.error)))
  assert.equal(spawnSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1)
  assert.equal(readdirSync(out).filter((f) => f.startsWith('result-')).length, 3)
})

test('the reviewer runs with a confined home: its own artifacts land in the reviews dir', async () => {
  const { repo, base } = reviewRepo()
  const runs = makeRuns(1)
  put(join(runs[0], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  const out = fresh('reviews')
  const jobs = (await prepareReviews({ runs, kind: 'diff', out, keyPath: fresh('k') + '/key.json' })).map((j) => ({ ...j, base }))
  const home = fakeHome()
  const reviewer = fresh('reviewer') + '.sh'
  put(reviewer, '#!/bin/sh\nmkdir -p "$HOME/.crew/reviews" && echo artifact > "$HOME/.crew/reviews/probe.md"\nls "$HOME/.crew"\ncat "$HOME/.gitconfig"\necho "REVIEW-VERDICT: pass"\n')
  chmodSync(reviewer, 0o755)
  const [r] = await runReviews({ jobs, out, reviewer, repo, home })
  assert.equal(r.status, 'ok', r.error)
  assert(!existsSync(join(home, '.crew', 'reviews')), 'the real ~/.crew/reviews was written')
  assert.equal(readFileSync(join(out, '.reviewer-home', '.crew', 'reviews', 'probe.md'), 'utf8'), 'artifact\n')
  const text = readFileSync(join(out, `review-${jobs[0].code}.txt`), 'utf8')
  assert(text.includes('tools') && text.includes('[user]'), text)
})

test('a key kept under the real home is unreachable from the reviewer home', async () => {
  const { repo, base } = reviewRepo()
  const home = fakeHome()
  mkdirSync(join(home, 'secrets', 'deep'), { recursive: true })
  writeFileSync(join(home, 'secrets', 'other.txt'), 'kept\n')
  const keys = [join(home, 'bench-key.json'), join(home, 'secrets', 'deep', 'key.json')]
  for (const keyPath of keys) {
    const runs = makeRuns(1)
    put(join(runs[0], 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
    const out = fresh('reviews')
    const jobs = (await prepareReviews({ runs, kind: 'diff', out, keyPath, home })).map((j) => ({ ...j, base }))
    const reviewer = fresh('reviewer') + '.sh'
    put(reviewer, `#!/bin/sh\nif find -L "$HOME" -name 'key.json' -o -name 'bench-key.json' 2>/dev/null | grep -q .; then echo KEY-REACHABLE; fi\ncat "$HOME/secrets/other.txt" 2>/dev/null\necho "REVIEW-VERDICT: pass"\n`)
    chmodSync(reviewer, 0o755)
    const [r] = await runReviews({ jobs, out, reviewer, repo, home, keyPath })
    assert.equal(r.status, 'ok', r.error)
    const text = readFileSync(join(out, `review-${jobs[0].code}.txt`), 'utf8')
    assert(!text.includes('KEY-REACHABLE'), text)
    assert.equal(keys.filter((k) => existsSync(k)).length, 1) // only this run's key
    assert(existsSync(keyPath) && !existsSync(join(out, '.reviewer-home', 'bench-key.json')))
    rmSync(keyPath)
  }
  // the other home entries are still linked in
})

test('plan reviews stage the coded plan and gate in the worktree', async () => {
  const { repo, base } = reviewRepo()
  const runs = makeRuns(1)
  const out = fresh('reviews')
  const jobs = (await prepareReviews({ runs, kind: 'plan', out, keyPath: fresh('k') + '/key.json' })).map((j) => ({ ...j, base }))
  const reviewer = fresh('reviewer') + '.sh'
  put(reviewer, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case $1 in --repo) R=$2;; esac; shift; done\nls "$R/lane"\necho "REVIEW-VERDICT: changes"\n')
  chmodSync(reviewer, 0o755)
  const [r] = await runReviews({ jobs, out, reviewer, repo, home: fakeHome() })
  assert.equal(r.status, 'ok', r.error)
  assert.equal(r.verdict, 'changes')
  assert(/gate\.mjs\nplan\.md/.test(readFileSync(join(out, `review-${jobs[0].code}.txt`), 'utf8')))
})

test('importing the module runs nothing and the key write is not a symlink', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./blind-review.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert(!lstatSync(new URL('./blind-review.mjs', import.meta.url)).isSymbolicLink())
})

test('an invalid --concurrency is refused before anything is prepared', () => {
  for (const bad of ['abc', '0', '-2', '1.5']) {
    const out = fresh('reviews')
    const key = fresh('k') + '/key.json'
    const r = spawnSync(process.execPath, [join(CHECKOUT, 'bench', 'blind-review.mjs'), '--kind', 'diff', '--out', out, '--key', key, '--concurrency', bad, ...makeRuns(1)], { encoding: 'utf8' })
    assert.equal(r.status, 2, bad)
    assert.match(r.stderr, /concurrency/)
    assert(!existsSync(out) && !existsSync(key))
  }
})
