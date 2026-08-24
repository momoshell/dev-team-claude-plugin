import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
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
