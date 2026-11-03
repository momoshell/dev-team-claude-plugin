import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync as fsLink, readdirSync, unlinkSync as fsUnlink } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { reclaimStore, PHASES, EVIDENCE_KINDS, LIVENESS } from './reclaim.mjs'


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reclaim-'))
  const deps = { pid: 700, uuid: (() => { let n = 0; return () => `u-${++n}` })(), now: () => 1, sleep: () => {}, kill: () => true }
  return { dir, s: reclaimStore({ dir, actor: 'test', deps }), deps, done: () => rmSync(dir, { recursive: true, force: true }) }
}
function each(fn) { const f = fixture(); try { fn(f) } finally { f.done() } }
function deadFixture() {
  const f = fixture()
  f.deps.pid = 700
  f.deps.kill = (pid, signal) => { if (signal === 0 || signal === undefined) { const e = Error('gone'); e.code = 'ESRCH'; throw e } if (Math.abs(pid) === 111) { const e = Error('gone'); e.code = 'ESRCH'; throw e } }
  f.s = reclaimStore({ dir: f.dir, actor: 'test', deps: f.deps })
  return f
}
function planted(f, value, raw = false) {
  const p = join(f.dir, '.a.active.json')
  writeFileSync(p, raw ? value : JSON.stringify(value))
  return p
}
function marker(f, over = {}) {
  return { reservation_id: 'r1', key: 'a', role: 'a', id: 'd1', phase: PHASES.SPAWNING, owner: { pid: 999999999 }, ...over }
}
const markerLock = (key) => createHash('sha256').update(JSON.stringify(['marker', key])).digest('hex').slice(0, 32)
function heldLock(dir, key) {
  const path = join(dir, 'locks', `${markerLock(key)}.lock.1`)
  writeFileSync(path, JSON.stringify({ fence: 1, token: 'held', owner: { pid: 811, startedAt: 0 }, actor: 'holder', at: 0, released: false }))
  return path
}

// MUTATION: re-add reconcile.
test('the store exposes only the verbs the acp client calls', () => each(({ s }) => {
  assert.deepEqual(Object.keys(s).sort(), ['advance', 'clear', 'probeEvidence', 'reserve'])
}))

// MUTATION: restore completionProof.
test('reserve refuses a legacy d<N> marker with a canonical exit as unresolvable', () => {
  const f = deadFixture()
  try {
    mkdirSync(join(f.dir, 'd1'))
    const exit = join(f.dir, 'd1', 'exit')
    writeFileSync(exit, '0')
    planted(f, { role: 'a', id: 'd1', phase: 'running', ownerPid: 999999999, exit })
    assert.equal(f.s.reserve('a', { phase: 'reserved' }).reason, 'unresolvable')
  } finally { f.done() }
})

test('exports closed enums', () => assert.deepEqual(PHASES, { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }))
test('evidence enum includes successor authority', () => assert.deepEqual(EVIDENCE_KINDS, { PGID: 'pgid', SUCCESSOR: 'successor' }))
test('liveness enum is tri-state', () => assert.deepEqual(LIVENESS, { ALIVE: 'alive', DEAD: 'dead', UNKNOWN: 'unknown' }))
test('an absent marker is free', () => each(({ s }) => assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true)))
test('a marker path that cannot be read is unresolvable, not free', () => each(({ dir, s }) => {
  mkdirSync(join(dir, '.a.active.json'))
  assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'unresolvable' })
}))
test('malformed marker bytes are unresolvable', () => each(({ dir, s }) => {
  writeFileSync(join(dir, '.a.active.json'), '{not json')
  assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'unresolvable' })
}))
test('a marker containing literal null is unresolvable', () => each(({ dir, s }) => {
  writeFileSync(join(dir, '.a.active.json'), 'null')
  assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'unresolvable' })
}))
test('reserve creates owned marker', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(r.ok, true); assert.equal(r.marker.owner.pid, 700); assert.equal(r.marker.key, 'a') }))
test('reserve is exclusive', () => each(({ s }) => { assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true); assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) }))
test('reservation handle clears', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(s.clear(r.handle), true); assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true) }))
test('stale clear preserves successor', () => each(({ s, dir }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.clear(a.handle); const b = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(s.clear(a.handle), false); assert.equal(JSON.parse(readFileSync(join(dir, '.a.active.json'), 'utf8')).reservation_id, b.handle.reservation_id) }))
test('a stale advance throws and releases the marker lock', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.clear(a.handle); assert.throws(() => s.advance(a.handle, PHASES.RUNNING)); assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true) }))
test('advance changes phase', () => each(({ s, dir }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.advance(a.handle, PHASES.SPAWNING); assert.equal(JSON.parse(readFileSync(join(dir, '.a.active.json'), 'utf8')).phase, PHASES.SPAWNING) }))
test('running marker owned by this supervisor is busy', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RUNNING }); assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) }))
test('pre-effect marker owned by this supervisor is busy', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) }))
test('unknown evidence does not override a live owner', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.SPAWNING, evidence: { kind: 'none' } }); assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) }))
test('unregistered evidence is unknown', () => each(({ s }) => assert.equal(s.probeEvidence({ kind: 'none' }), LIVENESS.UNKNOWN)))
test('digest handle clears corrupt marker', () => each(({ dir, s }) => { const p = join(dir, '.a.active.json'); mkdirSync(dir, { recursive: true }); writeFileSync(p, '{broken'); const raw = readFileSync(p); const h = { key: 'a', digest: (awaitDigest(raw)) }; assert.equal(s.clear(h), true) }))
function awaitDigest(raw) { return createHash('sha256').update(raw).digest('hex') }

test('alive pgid evidence under the acp policy makes reserve busy', () => { const f = fixture(); try { mkdirSync(join(f.dir, 'd1')); const file = join(f.dir, 'd1', 'pgid'); writeFileSync(file, '222'); f.deps.kill = (pid, signal) => signal === 0 ? (pid === -222 ? true : (() => { const e = Error(); e.code = 'ESRCH'; throw e })()) : true; f.s = reclaimStore({ dir: f.dir, actor: 'test', deps: f.deps, evidencePolicies: { [EVIDENCE_KINDS.PGID]: (_key, m) => m?.evidence || null } }); planted(f, marker(f, { evidence: { kind: 'pgid', file } })); assert.deepEqual(f.s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) } finally { f.done() } })
test('invalid pgid values are unknown', () => each(({ s, dir, deps }) => { for (const value of ['0', '-1', '1.5', '9007199254740992', '']) { const file = join(dir, `p-${value || 'blank'}`); writeFileSync(file, value); assert.equal(s.probeEvidence({ kind: 'pgid', file }), LIVENESS.UNKNOWN) } }))


test('mutation is serialized against nested reserve', () => each(({ dir, deps }) => {
  let nested
  const s = reclaimStore({ dir, actor: 'test', deps: { ...deps, unlinkSync(p) {
    if (p.endsWith('.active.json')) nested = s.reserve('a', { phase: PHASES.RESERVED })
    return fsUnlink(p)
  } } })
  const r = s.reserve('a', { phase: PHASES.RESERVED })
  assert.equal(s.clear(r.handle), true)
  assert.deepEqual(nested, { ok: false, reason: 'contended' })
  assert.equal(existsSync(join(dir, '.a.active.json')), false)
}))

test('post-link foreign token fails closed without rewriting bytes', () => each(({ dir, deps }) => {
  let tampered
  const s = reclaimStore({ dir, actor: 'x', deps: { ...deps, linkSync(from, to) { fsLink(from, to); if (!tampered) { tampered = JSON.stringify({ fence: 1, token: 'foreign', owner: { pid: 1 }, released: false }); writeFileSync(to, tampered) } } } })
  assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'unresolvable' })
  assert.equal(readFileSync(join(dir, 'locks', `${markerLock('a')}.lock.1`), 'utf8'), tampered)
  assert.equal(existsSync(join(dir, '.a.active.json')), false)
}))

test('release refuses a same-fence epoch rewritten by another actor', () => each(({ dir, deps }) => {
  const path = join(dir, 'locks', `${markerLock('a')}.lock.1`)
  const foreign = JSON.stringify({ fence: 1, token: 'foreign', owner: { pid: 999999999 }, actor: 'other', released: false })
  const s = reclaimStore({ dir, actor: 'test', deps: { ...deps, linkSync(from, to) { if (to.endsWith('.a.active.json')) writeFileSync(path, foreign); fsLink(from, to) } } })
  s.reserve('a', { phase: PHASES.RESERVED })
  assert.equal(readFileSync(path, 'utf8'), foreign)
}))

test('A1 reserve and clear cycles keep only the current lock epoch', () => each(({ s, dir }) => {
  for (let i = 0; i < 25; i++) { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(r.ok, true); assert.equal(s.clear(r.handle), true) }
  const name = `${markerLock('a')}.lock.50`
  assert.deepEqual(readdirSync(join(dir, 'locks')), [name])
  const record = JSON.parse(readFileSync(join(dir, 'locks', name), 'utf8'))
  assert.equal(record.fence, 50); assert.equal(record.released, true)
}))

test('D1 acquisition scans only bounded lock entries', () => each(({ dir, deps }) => {
  const lockDir = join(dir, 'locks'), counts = []
  const observedReaddir = (path) => { const entries = readdirSync(path); if (String(path) === lockDir) counts.push(entries.length); return entries }
  const s = reclaimStore({ dir, actor: 'test', deps: { ...deps, readdirSync: observedReaddir } })
  for (let i = 0; i < 25; i++) { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(r.ok, true); assert.equal(s.clear(r.handle), true) }
  const settled = observedReaddir(lockDir)
  assert.ok(counts.every((count) => count <= 2)); assert.equal(counts.at(-1), 1)
  assert.deepEqual(settled, [`${markerLock('a')}.lock.50`])
}))

test('E1 retirement begins only after the successor maximum exists', () => each(({ s, dir, deps }) => {
  const r = s.reserve('a', { phase: PHASES.RESERVED })
  const oldPath = join(dir, 'locks', `${markerLock('a')}.lock.1`), nextPath = join(dir, 'locks', `${markerLock('a')}.lock.2`)
  let observation
  const successor = reclaimStore({ dir, actor: 'successor', deps: { ...deps, unlinkSync(path) {
    if (observation === undefined && String(path) === oldPath) {
      const successorExists = existsSync(nextPath)
      const record = successorExists ? JSON.parse(readFileSync(nextPath, 'utf8')) : null
      observation = { successorExists, successorHeld: record?.fence === 2 && record?.released === false }
    }
    return fsUnlink(path)
  } } })
  assert.equal(successor.clear(r.handle), true)
  assert.deepEqual(observation, { successorExists: true, successorHeld: true })
}))

test('F1 retirement unlink failure does not fail acquisition or release', () => each(({ s, dir, deps }) => {
  const r = s.reserve('a', { phase: PHASES.RESERVED })
  const oldPath = join(dir, 'locks', `${markerLock('a')}.lock.1`), nextPath = join(dir, 'locks', `${markerLock('a')}.lock.2`), unlinks = []
  const successor = reclaimStore({ dir, actor: 'successor', deps: { ...deps, unlinkSync(path) {
    if (String(path) === oldPath) throw Object.assign(Error('retirement denied'), { code: 'EACCES' })
    unlinks.push(String(path)); return fsUnlink(path)
  } } })
  assert.equal(successor.clear(r.handle), true)
  assert.equal(existsSync(oldPath), true); assert.equal(JSON.parse(readFileSync(nextPath, 'utf8')).released, true)
  assert.ok(unlinks.some((path) => path.endsWith('.tmp'))); assert.equal(readdirSync(join(dir, 'locks')).some((entry) => entry.includes('.tmp')), false)
  assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true)
}))

test('LW1 a held marker lock makes reserve back off for the default budget, then report contended', () => each(({ dir, deps }) => {
  heldLock(dir, 'a'); let now = 0; const sleeps = []
  const waiter = reclaimStore({ dir, actor: 'waiter', deps: { ...deps, pid: 812, now: () => now, sleep(ms) { sleeps.push(ms); now += ms } } })
  assert.deepEqual(waiter.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'contended' })
  assert.deepEqual(sleeps, [50, 100, 200, 400, 250]); assert.equal(existsSync(join(dir, '.a.active.json')), false)
}))

test('LW2 a held marker lock fails advance with the observed holder and measured wait', () => each(({ dir, deps }) => {
  heldLock(dir, 'a'); let now = 0; const sleeps = []
  const waiter = reclaimStore({ dir, actor: 'waiter', deps: { ...deps, pid: 812, now: () => now, sleep(ms) { sleeps.push(ms); now += ms } } })
  assert.throws(() => waiter.advance({ key: 'a', reservation_id: 'r' }, PHASES.SPAWNING), (err) => {
    assert.equal(err.stage, 'reclaim-lock-unavailable'); assert.equal(err.reason, 'contended')
    assert.deepEqual(err.holder, { pid: 811, started_at: 0, actor: 'holder', fence: 1 }); assert.equal(err.waited_ms, 1000)
    assert.match(err.message, /pid=811.*actor=holder.*fence=1.*waited_ms=1000/); return true
  })
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 1000)
}))

test('LW3 reserve retries a raced lock link and wins', () => each(({ dir, deps }) => {
  let now = 0, races = 0; const sleeps = []
  const racer = reclaimStore({ dir, actor: 'racer', deps: { ...deps, pid: 812, now: () => now, sleep(ms) { sleeps.push(ms); now += ms }, linkSync(from, to) {
    if (String(to).endsWith(`${markerLock('a')}.lock.1`) && races++ < 2) throw Object.assign(Error('raced'), { code: 'EEXIST' })
    return fsLink(from, to)
  } } })
  assert.equal(racer.reserve('a', { phase: PHASES.RESERVED }).ok, true); assert.deepEqual(sleeps, [50, 100])
}))

test('ESRCH holder is displaced', () => each(({ dir, deps }) => {
  heldLock(dir, 'a')
  const s = reclaimStore({ dir, actor: 'y', deps: { ...deps, pid: 701, kill() { throw Object.assign(Error('gone'), { code: 'ESRCH' }) } } })
  assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true); assert.deepEqual(readdirSync(join(dir, 'locks')), [`${markerLock('a')}.lock.2`])
}))

test('default reclaim locks still refuse corrupt maximum epochs', () => each(({ dir, s }) => {
  const name = `${markerLock('a')}.lock.3`
  writeFileSync(join(dir, 'locks', name), 'corrupt')
  assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'unresolvable' })
  assert.deepEqual(readdirSync(join(dir, 'locks')), [name]); assert.equal(existsSync(join(dir, '.a.active.json')), false)
}))
