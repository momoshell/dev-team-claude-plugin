import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, globSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, forAll, rawRequest, scratchDir, startFileWriter, trackProcessGroupFile, writeTornFile } from './helpers.mjs'

const listen = async (server) => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

const helperUrl = new URL('./helpers.mjs', import.meta.url).href

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

function sharedTestModules(dir = 'test') {
  return readdirSync(join(ROOT, dir)).sort()
    .map((name) => `${dir}/${name}`)
    .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs') && statSync(join(ROOT, rel)).isFile())
}

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

// The property harness itself. Mutation killed: dropping the seed (two runs then differ);
// returning state without the zero bump (seed 0 is stuck at 0 forever); counting runs from
// 1; dropping the input from the failure message.
test('forAll is seeded, bounded to [0,1), runs exactly N times, and names run, seed and input on failure', () => {
  const sequence = (seed) => { const out = []; forAll((random) => out.push(random()), () => {}, { runs: 5, seed }); return out }
  assert.deepEqual(sequence(7), sequence(7), 'the same seed is the same sequence')
  assert.notDeepEqual(sequence(7), sequence(8))
  assert.ok(sequence(0).every((x) => x > 0 && x < 1), 'seed 0 is normalised: the stream moves and stays inside [0,1)')
  let runs = 0
  assert.equal(forAll(() => runs++, () => {}, { runs: 37 }), 37)
  assert.equal(runs, 37)
  assert.throws(() => forAll((random) => ({ n: Math.floor(random() * 100) }), (input) => { if (input.n >= 0) throw new Error('nope') }, { runs: 3, seed: 11 }),
    (error) => /^property failed on run 0 of 3 \(seed 11\) with input \{"n":\d+\}\nnope$/.test(error.message) && error.cause?.message === 'nope')
  const circular = {}; circular.self = circular
  assert.throws(() => forAll(() => circular, () => { throw new Error('still named') }, { runs: 1 }), /with input \[object Object\]\nstill named/)
  assert.throws(() => forAll(() => { throw new Error('gen') }, () => {}, { runs: 1 }), (error) => /generator failed on run 0 of 1 \(seed \d+\): gen/.test(error.message) && error.cause?.message === 'gen')
})

// Mutation killed: deleting the EPIPE drain in test/helpers.mjs, or narrowing it to process.stderr only (the reporter writes to stdout), leaves the sleep group alive.
test('WL1 tracked detached process group is reaped when the node --test runner is SIGTERMed', async () => {
  const root = scratchDir('helpers-wl1-')
  const script = join(root, 'wl1-child.test.mjs')
  const pidFile = join(root, 'sleep.pid')
  const release = join(root, 'release')
  writeFileSync(script, `import { test } from 'node:test'\nimport { spawn } from 'node:child_process'\nimport { writeFileSync, existsSync } from 'node:fs'\nimport { trackProcessGroupFile } from ${JSON.stringify(helperUrl)}\ntest('wl1 fixture spawns sleep then waits for release', () => {\n  trackProcessGroupFile(${JSON.stringify(pidFile)})\n  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })\n  child.unref()\n  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))\n  const deadline = Date.now() + 20000\n  while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {}\n})\ntest('wl1 fixture holds the runner open', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 60000))\n})\n`)
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.NODE_TEST_CONTEXT
  delete env.FORCE_COLOR
  delete env.CLICOLOR_FORCE
  const runner = spawn(process.execPath, ['--test', '--test-reporter=tap', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  let output = ''
  runner.stdout.on('data', (chunk) => { output += chunk })
  runner.stderr.on('data', (chunk) => { output += chunk })
  let pid = null
  try {
    const reportDeadline = Date.now() + 10000
    while (pid === null && Date.now() < reportDeadline) {
      try {
        const value = Number(String(readFileSync(pidFile, 'utf8')).trim())
        if (Number.isSafeInteger(value) && value > 1) pid = value
      } catch {}
      if (pid === null) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(Number.isSafeInteger(pid) && pid > 1, true, `child reported no detached pid: ${pid}`)
    assert.doesNotThrow(() => process.kill(-pid, 0))
    process.kill(runner.pid, 'SIGTERM')
    await new Promise((resolve, reject) => {
      if (runner.exitCode !== null) { resolve(); return }
      const timer = setTimeout(() => reject(new Error(`runner did not exit after SIGTERM (pid ${runner.pid})`)), 10000)
      runner.once('exit', () => { clearTimeout(timer); resolve() })
    })
    writeFileSync(release, '')
    await assertProcessGone(-pid, 10000)
  } finally {
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    if (Number.isSafeInteger(runner.pid)) { try { process.kill(-runner.pid, 'SIGKILL') } catch {} }
    try { runner.kill('SIGKILL') } catch {}
  }
})

async function assertProcessGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let state = 'still present'
    try { process.kill(pid, 0) } catch (error) {
      if (error?.code === 'ESRCH') return
      if (error?.code !== 'EPERM') throw error
      state = 'unobservable (EPERM)'
    }
    assert.ok(Date.now() < deadline, `process ${pid} ${state} after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
