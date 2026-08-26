import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, globSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, rawRequest, scratchDir, startFileWriter, writeTornFile } from './helpers.mjs'

const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

const helperUrl = new URL('./helpers.mjs', import.meta.url).href

function runScratchChild(root, { hardExit = false } = {}) {
  const script = join(root, hardExit ? 'hard-exit.test.mjs' : 'clean.test.mjs')
  const report = join(root, hardExit ? 'hard-exit.minted' : 'clean.minted')
  const exit = hardExit ? '  process.exit(3)\n' : ''
  writeFileSync(script, `import { test } from 'node:test'\nimport { writeFileSync } from 'node:fs'\nimport { scratchDir } from ${JSON.stringify(helperUrl)}\ntest('child mints a scratch directory', () => {\n  const dir = scratchDir('helpers-child-')\n  writeFileSync(${JSON.stringify(report)}, dir)\n${exit}})\n`)
  const env = { ...process.env, TMPDIR: root, NO_COLOR: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', script], {
    env, encoding: 'utf8', timeout: 30000,
  })
  const minted = existsSync(report) ? readFileSync(report, 'utf8').trim() : ''
  rmSync(script, { force: true })
  rmSync(report, { force: true })
  return { result, minted, leftovers: readdirSync(root) }
}

test('scratchDir mints a directory under the ambient temp root with the given prefix', () => {
  const dir = scratchDir('helpers-mint-')
  assert.ok(dir.startsWith(`${tmpdir()}/`))
  assert.match(dir, /helpers-mint-[^/]+$/)
  assert.equal(existsSync(dir), true)
})

test('a scratch dir does not survive a clean node --test child', () => {
  const root = scratchDir('helpers-clean-root-')
  const child = runScratchChild(root)
  assert.equal(child.result.status, 0, child.result.stderr)
  assert.ok(child.minted.startsWith(`${root}/helpers-child-`), `child reported no minted path: ${child.minted}`)
  assert.deepEqual(child.leftovers, [])
})

test('a scratch dir does not survive a child that hard-exits mid-test', () => {
  const root = scratchDir('helpers-hard-exit-root-')
  const child = runScratchChild(root, { hardExit: true })
  assert.notEqual(child.result.status, 0, child.result.stderr)
  assert.ok(child.minted.startsWith(`${root}/helpers-child-`), `child reported no minted path: ${child.minted}`)
  assert.deepEqual(child.leftovers, [])
})

// MUTATION G1: repoint ROOT and the repository-root contract goes red.
test('ROOT still resolves to the repo root', () => {
  assert.ok(existsSync(join(ROOT, 'package.json')))
})

// MUTATION G3: normalise the request line or replace the caller Host and the raw affordance goes red.
test('rawRequest delivers a request target and Host that fetch cannot', async () => {
  const seen = []
  const server = http.createServer((req, res) => { seen.push({ url: req.url, host: req.headers.host }); res.end('ok') })
  try {
    const port = await listen(server)
    const res = await rawRequest({
      port,
      requestLine: 'GET http://evil.example/absolute-target HTTP/1.1',
      headers: ['Host: attacker.example:1234', 'Connection: close'],
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'http://evil.example/absolute-target')
    assert.equal(seen[0].host, 'attacker.example:1234')
    assert.match(res.text, /^HTTP\/1\.1 200/)
    assert.equal(res.closedWithoutResponse, false)

    const viaFetch = await fetch(`http://127.0.0.1:${port}/x`, { headers: { Host: 'attacker.example:1234' } })
    await viaFetch.text()
    assert.equal(seen.length, 2)
    assert.equal(seen[1].host, `127.0.0.1:${port}`)
    assert.notEqual(seen[1].host, 'attacker.example:1234')
  } finally {
    await new Promise((r) => server.close(r))
  }
  assert.equal(server.listening, false)
})

// MUTATION G11: hardcode closedWithoutResponse to false and the refuse-and-close input goes red.
test('rawRequest reports a socket closed without a response', async () => {
  const server = net.createServer((socket) => { socket.destroy() })
  try {
    const port = await listen(server)
    const res = await rawRequest({ port, requestLine: 'GET / HTTP/1.1', headers: ['Host: x'] })
    assert.equal(res.closedWithoutResponse, true)
    assert.equal(res.raw.length, 0)
    // The errno is platform-dependent: an immediate server-side destroy() reaches
    // the client as ECONNRESET on darwin and as a clean FIN (no error event, so
    // null) on linux. Reaching this line at all already proves the peer was
    // REACHABLE, because rawRequest rejects on the UNREACHABLE set. So pin the
    // closed set rather than one platform's spelling — a stray errno still fails.
    assert.ok(
      [null, 'ECONNRESET', 'EPIPE'].includes(res.errorCode),
      `expected a reset-or-clean close, got ${res.errorCode}`,
    )
  } finally {
    await new Promise((r) => server.close(r))
  }
})

// MUTATION G4/G6: remove the second-process write loop or invert its PID assertion and this self-test goes red.
test('startFileWriter writes from a second process while the parent reads', async () => {
  const root = scratchDir('helpers-writer-')
  const file = join(root, 'crew.json')
  const text = JSON.stringify({ pad: 'x'.repeat(4000), n: '%N%' })
  writeFileSync(file, text.split('%N%').join('seed'))
  let writer = null
  try {
    writer = await startFileWriter({ file, text })
    assert.equal(typeof writer.pid, 'number')
    assert.notEqual(writer.pid, process.pid)
    const distinct = new Set()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && distinct.size < 2) {
      try { distinct.add(readFileSync(file, 'utf8')) } catch { /* the writer's truncation window */ }
    }
    assert.ok(distinct.size >= 2, `parent observed ${distinct.size} distinct contents`)
    const stopped = await writer.stop()
    assert.ok(stopped.writes >= 2, `child reported ${stopped.writes} writes`)
    assert.throws(() => process.kill(writer.pid, 0), /ESRCH/)
  } finally {
    if (writer) { try { await writer.stop() } catch { /* already stopped */ } }
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(existsSync(root), false)
})

// MUTATION G5: publish the complete text instead of a prefix and this torn-file check goes red.
test('writeTornFile produces bytes that exist and do not parse, then recovers', () => {
  const root = scratchDir('helpers-torn-')
  try {
    const file = join(root, 'envelope.json')
    const envelope = { assignment_id: 'd1', role: 'builder', status: 'done', summary: 'y'.repeat(200) }
    const complete = JSON.stringify(envelope, null, 2)
    const torn = writeTornFile({ file, completeText: complete })
    const bytes = readFileSync(file, 'utf8')
    assert.ok(bytes.length > 0)
    assert.ok(bytes.length < complete.length)
    assert.equal(torn.tornBytes, bytes.length)
    assert.throws(() => JSON.parse(bytes), SyntaxError)
    torn.complete()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), envelope)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(existsSync(root), false)
})

// MUTATION G5: remove the parse and empty-prefix refusals and the torn fixture becomes vacuous.
test('writeTornFile refuses a prefix that parses', () => {
  const root = scratchDir('helpers-torn-guard-')
  try {
    assert.throws(() => writeTornFile({ file: join(root, 'p.json'), completeText: '{"a":1}   ', keepBytes: 7 }), /parses/)
    assert.throws(() => writeTornFile({ file: join(root, 'e.json'), completeText: '{}', keepBytes: 0 }), /empty|parses/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Helper duplication tripwire. The 2026-08-23 audit (docs/audits/2026-08-23/audit/
// s4-register.md, D1-D6) measured sqliteAvailable in 8 files, git()/gitResult() in
// 7 copies with SIX distinct bodies, and repo-root derivation in 12 copies under 6
// names. #591 consolidated the first tranche, this lane the last four carriers;
// without a detector the copies come back one call site at a time (#551).
//
// Scope: *.test.mjs under the directories that hold test files, plus the shared
// non-test test modules. Production modules are NEVER enumerated, so the indented
// `return function git(where, args)` factories in crew/arms.mjs and
// crew/harvest.mjs cannot be flagged, by construction rather than by exception.
// Blind spot, stated: a test file under a NEW top-level directory is not scanned;
// the count assertion below is the cheap guard against a scan that reads nothing.
const HELPER_NAMES = 'sqliteAvailable|git|gitResult|treeDigest|scratchDir|rawRequest|startFileWriter|writeTornFile|makeSeedLane'
// Regrowth is written however the next author writes small helpers, not only as
// a column-0 `function` declaration. A const arrow is the commonest form in this
// repo, and a helper re-declared inside a test() body is indented. Matching only
// the narrow form would leave the guard green through exactly the regrowth #551
// describes, so every binding form is covered and pinned below.
const LOCAL_HELPER_DECL = new RegExp(String.raw`^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s*\*?\s*(?:${HELPER_NAMES})\s*\(|(?:const|let|var)\s+(?:${HELPER_NAMES})\s*=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))`, 'gm')
const LOCAL_REPO_ROOT = new RegExp([
  // Quote style is unenforced here (no eslint config), and package.json pins
  // node >= 26, which makes import.meta.dirname the idiomatic derivation today.
  // A detector blind to either is blind to the forms most likely to appear next.
  String.raw`new URL\(\s*['"\x60](?:\.\./)+['"\x60]`,
  String.raw`import\.meta\.dirname`,
  String.raw`dirname\(\s*dirname\(\s*fileURLToPath`,
  String.raw`join\(\s*dirname\(\s*fileURLToPath\([^)]*\)\s*\)\s*,\s*'\.\.'`,
  String.raw`'--show-toplevel'`,
].join('|'), 'g')
const HELPER_SELF = 'test/helpers.mjs'
const HELPER_SELF_TEST = 'test/helpers.test.mjs'
const HELPER_SCAN_DIRS = ['commands', 'crew', 'scripts', 'skills', 'test', 'visualizer']
// Derived, never hand-listed. A literal list stops covering the next shared
// module someone adds beside the test files, and a detector that scans
// nothing passes (#551).
function sharedTestModules(dir = 'test') {
  return readdirSync(join(ROOT, dir)).sort()
    .map((name) => `${dir}/${name}`)
    .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs') && statSync(join(ROOT, rel)).isFile())
}

function localHelperSites(source) {
  return [...source.matchAll(LOCAL_HELPER_DECL)].length + [...source.matchAll(LOCAL_REPO_ROOT)].length
}

function helperTestFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) { if (name !== 'node_modules') helperTestFiles(rel, out) }
    else if (name.endsWith('.test.mjs')) out.push(rel)
  }
  return out
}

function helperScannedFiles() {
  return [...HELPER_SCAN_DIRS.flatMap((dir) => helperTestFiles(dir)), ...sharedTestModules()]
}

// Frozen, not forgiven. Each of these carries a local copy this lane did not
// convert: they sit outside its write fence, so the exemption — not a weaker
// rule — is how the detector owns what it newly flags. The warranty is the
// audited site COUNT as a CEILING: add a copy to an exempt file and its warranty
// fails. It is deliberately not equality — equality also fails when a copy is
// REMOVED, so the lane that finally converts an exempt file would turn this test
// red for doing the very thing the exemption is waiting for.
function frozenHelperSites(sites, why) {
  return { sites, why, warranty: (source) => localHelperSites(source) <= sites }
}

// Retired 2026-08-25 by lane b236-helperexempt (#551's cleanup lane). Each of
// these was frozen only because its copy sat outside a converting lane's fence.
// The copy is gone, so the exemption is retired and the file is now PROTECTED by
// the tripwire rather than merely unlisted:
//   commands/commands.test.mjs — converted by b232-helperdedupc (#643, a3bcbfe)
//   crew/pi/extensions/lab.test.mjs — converted by b232-helperdedupc (#643, a3bcbfe)
//   crew/pi/extensions/subagent.test.mjs — converted by b232-helperdedupc (#643, a3bcbfe)
//   test/factory-emit.test.mjs — converted by b230-helperdedupa (#642, 0fb580a)
//   test/factory-intake.test.mjs — converted by b230-helperdedupa (#642, 0fb580a)
//   test/factory-ledger.test.mjs — converted by b230-helperdedupa (#642, 0fb580a)
//   test/factory-make-brief.test.mjs — converted by b235-helperdedupb2 (#644, bd3d40d)
//   test/version-agreement.test.mjs — converted by b235-helperdedupb2 (#644, bd3d40d)
// Retired 2026-08-26 by lane b256-helperexempt2 (#551's cleanup lane), same rule:
//   crew/crew.test.mjs — converted by b247-helperdedupd (#655, eca14fc)
//   crew/drive.test.mjs — converted by b248-helperdedupf (#656, 53bb1eb)
//   skills/crew-dispatch/exhibits.test.mjs — converted by b243-helperdedupe (#650, 39e17e4)
//   skills/devops/exhibits.test.mjs — converted by b248-helperdedupf (#656, 53bb1eb)
//   skills/pr-review/findings-shape.test.mjs — converted by b247-helperdedupd (#655, eca14fc)
// Retired 2026-08-26 by lane b264-ciretireb2 (#535 wave B2), which closes #551.
// The first two were converted by lanes that have since landed and each measures
// ZERO local sites today; the third was deleted with the module it tested, so the
// exemption has nothing left to freeze:
//   skills/backend-node/exhibits.test.mjs — converted by b247-helperdedupd (#655, eca14fc)
//   skills/crew-recovery/exhibits.test.mjs — converted by b243-helperdedupe (#650, 39e17e4)
//   test/factory-ci-*.test.mjs (2 sites) — retired by this lane with the unreached
//     CI watcher module it tested (#535); named by glob because no live citation of
//     those modules may survive this commit
const HELPER_EXEMPT = new Map([
  ['test/factory-probe-repo.test.mjs', frozenHelperSites(1, 'audited 2026-08-24: one local git with a DIFFERENT identity (probe@example.invalid); outside this lane\'s fence, so frozen rather than converted')],
])

test('helper duplication tripwire — no test file re-declares a consolidated helper', () => {
  const scanned = helperScannedFiles()
  assert.ok(scanned.length >= 50, `expected at least 50 scanned test files, found ${scanned.length}`)
  const offenders = scanned.filter((file) => {
    if (file === HELPER_SELF || file === HELPER_SELF_TEST || HELPER_EXEMPT.has(file)) return false
    return localHelperSites(readFileSync(join(ROOT, file), 'utf8')) > 0
  })
  assert.deepEqual(offenders, [])
})

test('helper duplication tripwire — every exemption has a live, load-bearing warranty', () => {
  let total = 0
  for (const [file, exemption] of HELPER_EXEMPT) {
    let source
    try { source = readFileSync(join(ROOT, file), 'utf8') }
    catch (err) { assert.fail(`exemption ${file} is missing or unreadable: ${err.message}`) }
    assert.ok(exemption.why.length > 20, `exemption ${file} carries no audited reason`)
    assert.equal(exemption.warranty(source), true, `exemption ${file} warranty no longer holds`)
    assert.ok(exemption.sites > 0, `exemption ${file} is redundant`)
    total += exemption.sites
  }
  assert.equal(total, 1)
})

test('helper duplication tripwire — the detector flags a hand-rolled copy and clears an import', () => {
  assert.equal(localHelperSites('function sqliteAvailable() {}\n'), 1)
  assert.equal(localHelperSites('function gitResult(a) {}\n'), 1)
  assert.equal(localHelperSites("const R = fileURLToPath(new URL('../../', import.meta.url))\n"), 1)
  assert.equal(localHelperSites("execFileSync('git', ['rev-parse', '--show-toplevel'])\n"), 1)
  assert.equal(localHelperSites("import { git, sqliteAvailable } from './helpers.mjs'\n"), 0)
  assert.equal(localHelperSites("const HERE = fileURLToPath(new URL('./', import.meta.url))\n"), 0)
  assert.equal(localHelperSites('  return function git(where, args) {}\n'), 0)
})

// --- suite discovery contract (#551 F0) -------------------------------------
// test/helpers.mjs and test/fixtures.mjs are helper modules, and until this
// lane `node --test` collected and EXECUTED them as test files: node's default
// pattern set includes `**/test/**/*.?(c|m)js`, which matches every .mjs under
// a directory named test whatever the file is called, so no rename inside
// test/ could have fixed it. The suite command now declares its discovery
// pattern explicitly. The pattern is READ from package.json rather than
// restated here — a second copy is the copy that goes stale, which is the
// whole lesson of the D1-D6 clusters.
//
// Node's other default patterns are *-test.?(c|m)js, test-*.?(c|m)js and
// test.?(c|m)js. The narrowed pattern collects none of them, so a file named
// that way would be silently uncollected — and an uncollected test file
// reports nothing at all, which is the one failure a suite never shows you.
const DROPPED_NAME_FORMS = /(?:^|\/)(?:[^/]*-test|test-[^/]*|test)\.(?:c|m)?js$/

function suiteDiscoveryPatterns() {
  const lane = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts?.test ?? ''
  const tokens = []
  const re = /"([^"]*)"|(\S+)/g
  let match
  while ((match = re.exec(lane)) !== null) tokens.push(match[1] !== undefined ? match[1] : match[2])
  return tokens.slice(1).filter((token) => !token.startsWith('-'))
}

function repoFiles(dir = '.', out = []) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    if (name === '.git' || name === 'node_modules') continue
    const rel = dir === '.' ? name : `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) repoFiles(rel, out)
    else out.push(rel)
  }
  return out
}

test('the suite command declares a discovery pattern that collects no shared helper module', () => {
  const patterns = suiteDiscoveryPatterns()
  assert.ok(patterns.length > 0, 'package.json scripts.test declares no explicit discovery pattern, so node --test falls back to defaults that collect every .mjs under test/')
  const matched = new Set(globSync(patterns, { cwd: ROOT }))
  const shared = sharedTestModules()
  assert.ok(shared.length >= 2, `expected the shared test modules to be discovered, found ${JSON.stringify(shared)}`)
  for (const module of shared) {
    assert.equal(matched.has(module), false, `${module} is a helper module and must not be collected as a test file by ${JSON.stringify(patterns)}`)
  }
})

test('the narrowed discovery pattern still collects every test file in the tree', () => {
  const patterns = suiteDiscoveryPatterns()
  assert.ok(patterns.length > 0, 'package.json scripts.test declares no explicit discovery pattern')
  const matched = new Set(globSync(patterns, { cwd: ROOT }))
  const present = repoFiles().filter((rel) => rel.endsWith('.test.mjs'))
  assert.ok(present.length >= 50, `expected at least 50 test files in the tree, found ${present.length}`)
  assert.deepEqual(present.filter((rel) => !matched.has(rel)), [])
})

test('no file carries a test-shaped name the narrowed pattern would drop', () => {
  const orphans = repoFiles().filter((rel) => DROPPED_NAME_FORMS.test(rel))
  assert.deepEqual(orphans, [], "these files are named for one of node --test's other default patterns, which the narrowed pattern never collects")
})
