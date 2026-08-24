import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync as fsLink, readdirSync, appendFileSync, renameSync as fsRename, unlinkSync as fsUnlink } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { reclaimStore, reservationEngine, PHASES, VERDICTS, EVIDENCE_KINDS, LEASE_PHASES, SUCCESSOR_STATES, PARK_STATES, LAUNCH_STATES, CONFLICT_REASONS, LIVENESS, markerLockName, leaseKey, parkLockName, LOCK_ATTEMPTS, LOCK_INTERVAL_MS } from './reclaim.mjs'

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
function parkFixture(f, run_id = 'r', seats = [{ role: 'a', sessionId: 's1' }, { role: 'b', sessionId: 's2' }]) {
  const minted = f.s.mintPark({ run_id, seats })
  assert.equal(minted.ok, true)
  const id = minted.park.park_id
  const answer = { decision_id: `d-${id}`, actor: 'ops', answer: 'yes' }
  assert.equal(f.s.recordAnswer(id, answer).ok, true)
  return { id, seats, answer }
}
function enqueueLog(result = true) {
  const calls = []
  const fn = (spec) => { calls.push(JSON.parse(JSON.stringify(spec))); return typeof result === 'function' ? result(spec) : result }
  return { fn, calls }
}
function authority(map = {}) {
  return (spec) => map[spec?.run_id] || SUCCESSOR_STATES.UNKNOWN
}

test('exports closed enums', () => { assert.deepEqual(PHASES, { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }); assert.deepEqual(VERDICTS, { FREE: 'free', RECLAIMABLE: 'reclaimable', BUSY: 'busy', UNRESOLVABLE: 'unresolvable' }) })
test('evidence enum includes successor authority', () => assert.deepEqual(EVIDENCE_KINDS, { PGID: 'pgid', SUCCESSOR: 'successor' }))
test('liveness enum is tri-state', () => assert.deepEqual(LIVENESS, { ALIVE: 'alive', DEAD: 'dead', UNKNOWN: 'unknown' }))
test('lock constants are bounded', () => { assert.equal(LOCK_ATTEMPTS, 20); assert.equal(LOCK_INTERVAL_MS, 50) })
test('marker lock names are stable and safe', () => { assert.equal(markerLockName('x'), markerLockName('x')); assert.notEqual(markerLockName('x'), markerLockName('y')); assert.match(markerLockName('x'), /^[0-9a-f]+$/) })
test('free reconciliation', () => each(({ s }) => assert.equal(s.reconcile('a').verdict, VERDICTS.FREE)))
test('an absent marker is free', () => each(({ s }) => assert.equal(s.reconcile('a').verdict, VERDICTS.FREE)))
test('a marker path that cannot be read is unresolvable, not free', () => each(({ dir, s }) => {
  mkdirSync(join(dir, '.a.active.json'))
  assert.equal(s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE)
}))
test('malformed marker bytes are unresolvable', () => each(({ dir, s }) => {
  writeFileSync(join(dir, '.a.active.json'), '{not json')
  assert.equal(s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE)
}))
test('a marker containing literal null is unresolvable', () => each(({ dir, s }) => {
  writeFileSync(join(dir, '.a.active.json'), 'null')
  assert.equal(s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE)
}))
test('reserve creates owned marker', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(r.ok, true); assert.equal(r.marker.owner.pid, 700); assert.equal(r.marker.key, 'a') }))
test('reserve is exclusive', () => each(({ s }) => { assert.equal(s.reserve('a', { phase: PHASES.RESERVED }).ok, true); assert.deepEqual(s.reserve('a', { phase: PHASES.RESERVED }), { ok: false, reason: 'busy' }) }))
test('reservation handle clears', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(s.clear(r.handle), true); assert.equal(s.reconcile('a').verdict, VERDICTS.FREE) }))
test('stale clear preserves successor', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.clear(a.handle); const b = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(s.clear(a.handle), false); assert.equal(s.reconcile('a').marker.reservation_id, b.handle.reservation_id) }))
test('stale advance throws', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.clear(a.handle); assert.throws(() => s.advance(a.handle, PHASES.RUNNING)) }))
test('advance changes phase', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); s.advance(a.handle, PHASES.SPAWNING); assert.equal(s.reconcile('a').marker.phase, PHASES.SPAWNING) }))
test('running marker owned by this supervisor is busy', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RUNNING }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY) }))
test('pre-effect marker owned by this supervisor is busy', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.RESERVED }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY) }))
test('unknown evidence does not override a live owner', () => each(({ s }) => { const a = s.reserve('a', { phase: PHASES.SPAWNING, evidence: { kind: 'none' } }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY) }))
test('unregistered evidence is unknown', () => each(({ s }) => assert.equal(s.probeEvidence({ kind: 'none' }), LIVENESS.UNKNOWN)))
test('injected probe alive', () => each(({ dir, deps }) => { const s = reclaimStore({ dir, deps, probes: { custom: () => LIVENESS.ALIVE } }); assert.equal(s.probeEvidence({ kind: 'custom' }), LIVENESS.ALIVE) }))
test('injected probe dead', () => each(({ dir, deps }) => { const s = reclaimStore({ dir, deps, probes: { custom: () => LIVENESS.DEAD } }); assert.equal(s.probeEvidence({ kind: 'custom' }), LIVENESS.DEAD) }))
test('injected probe throws unknown', () => each(({ dir, deps }) => { const s = reclaimStore({ dir, deps, probes: { custom: () => { throw Error('down') } } }); assert.equal(s.probeEvidence({ kind: 'custom' }), LIVENESS.UNKNOWN) }))
test('override requires actor', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RUNNING }); assert.throws(() => s.override('a', { reservation_id: r.handle.reservation_id })) }))
test('override remains subordinate to a live owner', () => each(({ s }) => { const r = s.reserve('a', { phase: PHASES.RUNNING }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY); s.override('a', { actor: 'ops', reason: 'reviewed', reservation_id: r.handle.reservation_id }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY) }))
test('override mismatch throws', () => each(({ s }) => { s.reserve('a', { phase: PHASES.RUNNING }); assert.throws(() => s.override('a', { actor: 'ops', reservation_id: 'wrong' })) }))
test('alive evidence outranks override', () => each(({ dir, deps }) => { const ev = join(dir, 'd1', 'pgid'); mkdirSync(join(dir, 'd1')); writeFileSync(ev, '700'); const s = reclaimStore({ dir, deps, probes: { pgid: () => LIVENESS.ALIVE } }); const r = s.reserve('a', { phase: PHASES.SPAWNING, id: 'd1', evidence: { kind: 'pgid', file: ev } }); s.override('a', { actor: 'ops', reservation_id: r.handle.reservation_id }); assert.equal(s.reconcile('a').verdict, VERDICTS.BUSY) }))
test('lock acquire and release', () => each(({ s }) => { const a = s.acquire('x'); assert.equal(a.ok, true); assert.equal(s.checkFence(a.handle), true); assert.equal(s.release(a.handle), true); assert.equal(s.checkFence(a.handle), false) }))
test('lock fences increase monotonically and retain epochs', () => each(({ s, dir }) => { const a = s.acquire('x'); s.release(a.handle); const b = s.acquire('x'); assert.equal(b.handle.fence, 2); assert.equal(existsSync(join(dir, 'locks', 'x.lock.1')), true); assert.equal(existsSync(join(dir, 'locks', 'x.lock.2')), true) }))
test('stale lock release is harmless', () => each(({ s }) => { const a = s.acquire('x'); s.release(a.handle); const b = s.acquire('x'); assert.equal(s.release(a.handle), false); assert.equal(s.checkFence(b.handle), true) }))
test('withLock passes a handle', () => each(({ s }) => { let seen; s.withLock('x', (h) => { seen = h; assert.equal(s.checkFence(h), true) }); assert.equal(typeof seen.token, 'string') }))
test('lock override requires attestation', () => each(({ s }) => { const a = s.acquire('x'); assert.throws(() => s.overrideLock('x', { actor: 'ops', reason: 'x', fence: a.handle.fence, token: a.handle.token })); assert.equal(s.checkFence(a.handle), true) }))
test('lock override can displace with attestation', () => each(({ s }) => { const a = s.acquire('x'); s.overrideLock('x', { actor: 'ops', reason: 'stopped', fence: a.handle.fence, token: a.handle.token, attestation: { quiesced: true, method: 'operator stop' } }); const b = s.acquire('x'); assert.equal(b.ok, true); assert.equal(b.handle.fence, 2) }))
test('digest handle clears corrupt marker', () => each(({ dir, s }) => { const p = join(dir, '.a.active.json'); mkdirSync(dir, { recursive: true }); writeFileSync(p, '{broken'); const raw = readFileSync(p); const h = { key: 'a', digest: (awaitDigest(raw)) }; assert.equal(s.clear(h), true) }))
function awaitDigest(raw) { return createHash('sha256').update(raw).digest('hex') }

test('completed legacy marker with canonical exit is reclaimable', () => { const f = deadFixture(); try { mkdirSync(join(f.dir, 'd1')); const exit = join(f.dir, 'd1', 'exit'); writeFileSync(exit, '0'); planted(f, { exit, id: 'd1', role: 'a', phase: 'running', ownerPid: 999999999 }); assert.equal(f.s.reconcile('a').verdict, VERDICTS.RECLAIMABLE) } finally { f.done() } })
test('completed current marker with canonical exit is reclaimable', () => { const f = deadFixture(); try { mkdirSync(join(f.dir, 'd1')); const exit = join(f.dir, 'd1', 'exit'); writeFileSync(exit, '0'); planted(f, marker(f, { phase: PHASES.RUNNING, exit })); assert.equal(f.s.reconcile('a').verdict, VERDICTS.RECLAIMABLE) } finally { f.done() } })
test('unrelated exit is not completion proof', () => { const f = deadFixture(); try { mkdirSync(join(f.dir, 'd1')); const other = join(f.dir, 'other'); writeFileSync(other, '0'); planted(f, marker(f, { exit: other })); assert.equal(f.s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE) } finally { f.done() } })
test('unrecognized phase is not completion proof', () => { const f = deadFixture(); try { mkdirSync(join(f.dir, 'd1')); const exit = join(f.dir, 'd1', 'exit'); writeFileSync(exit, '0'); planted(f, marker(f, { phase: 'nonsense', exit })); assert.equal(f.s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE) } finally { f.done() } })
test('reconcile digest is exact on-disk bytes', () => { const f = deadFixture(); try { const raw = '{\n  "role": "a", "phase": "starting", "ownerPid": 999999999\n}\n'; planted(f, raw, true); const r = f.s.reconcile('a'); assert.equal(r.handle.digest, awaitDigest(Buffer.from(raw))); assert.notEqual(r.handle.digest, awaitDigest(Buffer.from(JSON.stringify(JSON.parse(raw))))); assert.equal(f.s.clear(r.handle), true) } finally { f.done() } })
test('canonical evidence rejects a decoy path while canonical worker is alive', () => { const f = deadFixture(); try { mkdirSync(join(f.dir, 'd1')); const canonical = join(f.dir, 'd1', 'pgid'); const decoy = join(f.dir, 'decoy'); writeFileSync(canonical, '222'); writeFileSync(decoy, '111'); f.deps.kill = (pid, signal) => { if (signal === 0) { const e = Error('dead'); e.code = 'ESRCH'; throw e } if (Math.abs(pid) === 222) return true; const e = Error('dead'); e.code = 'ESRCH'; throw e }; planted(f, marker(f, { evidence: { kind: 'pgid', file: decoy } })); assert.equal(f.s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE) } finally { f.done() } })
test('canonical evidence probes as busy', () => { const f = fixture(); try { mkdirSync(join(f.dir, 'd1')); const file = join(f.dir, 'd1', 'pgid'); writeFileSync(file, '222'); f.deps.kill = (pid, signal) => signal === 0 ? (pid === -222 ? true : (() => { const e = Error(); e.code = 'ESRCH'; throw e })()) : true; f.s = reclaimStore({ dir: f.dir, actor: 'test', deps: f.deps }); planted(f, marker(f, { evidence: { kind: 'pgid', file } })); assert.equal(f.s.reconcile('a').verdict, VERDICTS.BUSY) } finally { f.done() } })
test('invalid pgid values are unknown', () => each(({ s, dir, deps }) => { for (const value of ['0', '-1', '1.5', '9007199254740992', '']) { const file = join(dir, `p-${value || 'blank'}`); writeFileSync(file, value); assert.equal(s.probeEvidence({ kind: 'pgid', file }), LIVENESS.UNKNOWN) } }))
test('lease-shaped engine without surface policies fails closed', () => { const f = deadFixture(); try { const e = reservationEngine({ dir: f.dir, actor: 'x', phases: { allowed: ['held'], preEffect: null }, completionProof: null, evidencePolicy: null, deps: f.deps }); const r = e.reserve('a', { phase: 'held', evidence: { kind: 'unknown' } }); assert.equal(r.ok, true); const p = join(f.dir, '.a.active.json'); const m = JSON.parse(readFileSync(p)); m.owner.pid = 999999999; writeFileSync(p, JSON.stringify(m)); assert.equal(e.reconcile('a').verdict, VERDICTS.UNRESOLVABLE) } finally { f.done() } })
test('post-link foreign token fails closed without rewriting bytes', () => { const f = fixture(); try { let tampered = null; const s = reclaimStore({ dir: f.dir, actor: 'x', deps: { ...f.deps, linkSync(from, to) { fsLink(from, to); if (!tampered) { tampered = JSON.stringify({ fence: 1, token: 'foreign', owner: { pid: 1 }, released: false }); writeFileSync(to, tampered) } } } }); const r = s.acquire('x'); assert.equal(r.reason, 'unresolvable'); assert.equal(readFileSync(join(f.dir, 'locks', 'x.lock.1'), 'utf8'), tampered) } finally { f.done() } })
test('lock epoch paths are retained after release', () => each(({ s, dir }) => { const a = s.acquire('x'); s.release(a.handle); s.acquire('x'); assert.equal(existsSync(join(dir, 'locks', 'x.lock.1')), true) }))
test('bounded lock acquisition returns contended', () => { const f = fixture(); try { f.s.acquire('x'); let sleeps = 0; const s = reclaimStore({ dir: f.dir, actor: 'y', deps: { ...f.deps, pid: 701, sleep: () => { sleeps += 1 } } }); const r = s.acquire('x'); assert.equal(r.reason, 'contended'); assert.ok(sleeps <= LOCK_ATTEMPTS) } finally { f.done() } })
test('ESRCH holder is displaced', () => { const f = fixture(); try { const a = f.s.acquire('x'); const s = reclaimStore({ dir: f.dir, actor: 'y', deps: { ...f.deps, pid: 701, kill: () => { const e = Error(); e.code = 'ESRCH'; throw e } } }); assert.equal(s.acquire('x').ok, true); assert.equal(s.checkFence(a.handle), false) } finally { f.done() } })
test('unattested lock override does not unblock', () => each(({ s }) => { const a = s.acquire('x'); assert.throws(() => s.overrideLock('x', { actor: 'ops', reason: 'x', fence: a.handle.fence, token: a.handle.token })); assert.equal(s.checkFence(a.handle), true) }))
test('digest lock override recovers corrupt maximum', () => { const f = fixture(); try { const p = join(f.dir, 'locks', 'x.lock.1'); writeFileSync(p, 'corrupt'); const d = awaitDigest(Buffer.from('corrupt')); f.s.overrideLock('x', { actor: 'ops', reason: 'repair', fence: 1, digest: d, attestation: { quiesced: true, method: 'stopped' } }) } catch (err) { assert.fail(err) } finally { f.done() } })
test('override digest is inert after marker bytes change', () => { const f = deadFixture(); try { const p = planted(f, marker(f)); const raw = readFileSync(p); f.s.override('a', { actor: 'ops', reason: 'review', digest: awaitDigest(raw) }); writeFileSync(p, 'changed'); assert.equal(f.s.reconcile('a').verdict, VERDICTS.UNRESOLVABLE) } finally { f.done() } })
test('reservation id override survives a phase rewrite', () => { const f = deadFixture(); try { const r = f.s.reserve('a', { phase: PHASES.RUNNING }); const p = join(f.dir, '.a.active.json'); const m = JSON.parse(readFileSync(p)); m.owner.pid = 999999999; writeFileSync(p, JSON.stringify(m)); f.s.override('a', { actor: 'ops', reason: 'review', reservation_id: r.handle.reservation_id }); f.s.advance(r.handle, PHASES.SPAWNING); assert.equal(f.s.reconcile('a').verdict, VERDICTS.RECLAIMABLE) } finally { f.done() } })
test('torn override tail does not swallow next record', () => { const f = deadFixture(); try { planted(f, marker(f)); writeFileSync(join(f.dir, 'overrides.jsonl'), '{torn', { flag: 'a' }); f.s.override('a', { actor: 'ops', reason: 'next', reservation_id: 'r1' }); assert.equal(f.s.reconcile('a').verdict, VERDICTS.RECLAIMABLE) } finally { f.done() } })
test('mutation is serialized against nested reserve', () => { const f = deadFixture(); try { let nested; const original = f.deps.unlinkSync; f.deps.unlinkSync = (p) => { if (p.endsWith('.active.json')) nested = f.s.reserve('a', { phase: PHASES.RESERVED }); return original(p) }; const r = f.s.reserve('a', { phase: PHASES.RESERVED }); f.s.clear(r.handle); assert.ok(nested?.reason === 'contended' || f.s.reconcile('a').verdict === VERDICTS.FREE) } finally { f.done() } })

test('release refuses a same-fence epoch rewritten by another actor', () => each(({ s, dir }) => {
  const a = s.acquire('x')
  const p = join(dir, 'locks', 'x.lock.1')
  const foreign = JSON.stringify({ fence: 1, token: 'foreign', owner: { pid: 999999999 }, actor: 'other', released: false })
  writeFileSync(p, foreign)
  assert.equal(s.release(a.handle), false)
  assert.equal(readFileSync(p, 'utf8'), foreign)
}))

test('an unattested lock override record is inert', () => {
  for (const attestation of [undefined, { quiesced: false, method: 'stop' }, { quiesced: true, method: '  ' }]) {
    each(({ s, dir }) => {
      const a = s.acquire('x')
      appendFileSync(join(dir, 'overrides.jsonl'), `\n${JSON.stringify({ kind: 'lock', name: 'x', fence: a.handle.fence, identity: { kind: 'token', value: a.handle.token }, actor: 'ops', reason: 'x', attestation })}\n`)
      assert.equal(s.checkFence(a.handle), true)
      assert.equal(s.acquire('x').ok, false)
    })
  }
})

test('slice enums and identities are exact and frozen', () => {
  assert.deepEqual(LEASE_PHASES, { HELD: 'held', TRANSFERRED: 'transferred' })
  assert.deepEqual(SUCCESSOR_STATES, { ABSENT: 'absent', ACTIVE: 'active', RESUMED: 'resumed', ABANDONED: 'abandoned', MISMATCH: 'mismatch', UNKNOWN: 'unknown' })
  assert.deepEqual(PARK_STATES, ['parked', 'claimed', 'resumed', 'abandoned'])
  assert.deepEqual(LAUNCH_STATES, [null, 'pending', 'enqueued'])
  assert.deepEqual(CONFLICT_REASONS, ['answer-conflict', 'successor-conflict', 'decision-mismatch', 'no-answer', 'park-settled', 'seat-busy', 'enqueue-unresolved', 'unresolvable'])
  assert.equal(Object.isFrozen(PARK_STATES), true)
  assert.equal(Object.isFrozen(LAUNCH_STATES), true)
  assert.equal(Object.isFrozen(CONFLICT_REASONS), true)
  assert.match(leaseKey('role', 'session'), /^[0-9a-f]{32}$/)
  assert.match(parkLockName('park'), /^[0-9a-f]{32}$/)
  assert.notEqual(leaseKey('role', 'session'), markerLockName('role'))
  assert.notEqual(parkLockName('park'), markerLockName('park'))
})

test('finding 2 validates every lease boundary before locking', () => each(({ s, dir }) => {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  const cases = [
    [[], { spec, successorState: () => 'absent' }],
    [{ role: 'a' }, { spec, successorState: () => 'absent' }],
    [[{ role: ' ', sessionId: 's' }], { spec, successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: '' }], { spec, successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: 's' }, { role: 'a', sessionId: 's' }], { spec, successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: 's' }], { spec: { ...spec, extra: true }, successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: 's' }], { spec: { ...spec, decision: { ...spec.decision, answer: ' ' } }, successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: 's' }], { spec, order: 'a', successorState: () => 'absent' }],
    [[{ role: 'a', sessionId: 's' }], { spec, successorState: null }],
  ]
  for (const [seats, opts] of cases) {
    assert.deepEqual(s.acquireLeases(seats, opts), { ok: false, reason: 'unresolvable' })
    assert.equal(s.activeLeases().length, 0)
    assert.equal(readdirSync(join(dir, 'leases')).filter((name) => name.endsWith('.json')).length, 0)
  }
}))

test('successor liveness is terminal-only', () => {
  const f = deadFixture()
  try {
    const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
    assert.equal(f.s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'absent' }).ok, true)
    assert.equal(f.s.reconcileLease('a', 's', { successorState: () => 'absent' }).verdict, VERDICTS.UNRESOLVABLE)
    assert.equal(f.s.reconcileLease('a', 's', { successorState: () => 'resumed' }).verdict, VERDICTS.RECLAIMABLE)
  } finally { f.done() }
})

test('finite lease clock refuses before writing', () => each(({ dir, deps }) => {
  const s = reclaimStore({ dir, actor: 'clock', deps: { ...deps, now: () => NaN } })
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  assert.deepEqual(s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'absent' }), { ok: false, reason: 'unresolvable' })
  assert.equal(s.activeLeases().length, 0)
}))

test('malformed normalized specs refuse before writing', () => each(({ s }) => {
  const base = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  for (const spec of [{}, { ...base, extra: 1 }, { ...base, run_id: ' ' }, { ...base, decision: { ...base.decision, answer: ' ' } }]) {
    assert.deepEqual(s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'absent' }), { ok: false, reason: 'unresolvable' })
    assert.equal(s.activeLeases().length, 0)
  }
}))

test('set equality is a strict verifier guard', () => each(({ s }) => {
  const park = { park_id: 'p', seats: [{ role: 'a', sessionId: 's', warm: false }], leases: [], spec: { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }, decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  assert.deepEqual(s.verifyLeaseSet(park), { ok: false, reason: 'lease-set-mismatch' })
}))

test('lease record has the canonical eight keys', () => each(({ s, dir }) => {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  const result = s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'absent' })
  assert.equal(result.ok, true)
  const record = JSON.parse(readFileSync(join(dir, 'leases', `${leaseKey('a', 's')}.json`), 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['at', 'key', 'owner', 'phase', 'reservation_id', 'role', 'sessionId', 'spec'])
  assert.equal(record.phase, LEASE_PHASES.HELD)
  assert.deepEqual(Object.keys(record.owner).sort(), ['pid', 'startedAt'])
  assert.equal(Number.isFinite(record.owner.startedAt), true)
  assert.equal(Number.isFinite(record.at), true)
  assert.equal('evidence' in record, false)
}))

test('lease release reports a foreign remaining member and continues', () => each(({ s, dir }) => {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  const got = s.acquireLeases([{ role: 'a', sessionId: 's' }, { role: 'b', sessionId: 's' }], { spec, successorState: () => 'absent' })
  const path = join(dir, 'leases', `${leaseKey('b', 's')}.json`)
  const foreign = JSON.parse(readFileSync(path, 'utf8'))
  foreign.reservation_id = 'foreign'
  writeFileSync(path, JSON.stringify(foreign))
  const released = s.releaseLeases(got.handles)
  assert.equal(released.ok, false)
  assert.deepEqual(released.released.map((seat) => seat.role), ['a'])
  assert.deepEqual(released.remaining.map((seat) => seat.role), ['b'])
}))

test('recordAnswer is byte-stable and conflict-safe', () => each(({ s, dir }) => {
  const id = s.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).park.park_id
  const answer = { decision_id: 'd', actor: 'a', answer: 'yes' }
  assert.equal(s.recordAnswer(id, answer).ok, true)
  const path = join(dir, 'parks', `${id}.json`)
  const before = readFileSync(path, 'utf8')
  assert.equal(s.recordAnswer(id, answer).existing, true)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(s.recordAnswer(id, { ...answer, actor: 'b' }).reason, 'answer-conflict')
  assert.equal(s.recordAnswer(id, { decision_id: 'd2', actor: 'a', answer: 'yes' }).reason, 'answer-conflict')
  assert.equal(readFileSync(path, 'utf8'), before)
}))

test('claim freezes one persisted decision and replay is pure', () => each(({ s, dir }) => {
  const id = s.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).park.park_id
  s.recordAnswer(id, { decision_id: 'd', actor: 'a', answer: 'yes' })
  let calls = 0
  let seen
  const enqueue = (spec) => { calls += 1; seen = spec; return true }
  const args = { decision_id: 'd', successor_run_id: 'next', enqueue, successorState: () => 'absent' }
  assert.equal(s.claim(id, args).ok, true)
  assert.equal(Object.isFrozen(seen), true)
  assert.equal(Object.isFrozen(seen.decision), true)
  const before = readFileSync(join(dir, 'parks', `${id}.json`), 'utf8')
  assert.equal(s.claim(id, args).replayed, true)
  assert.equal(calls, 1)
  assert.equal(readFileSync(join(dir, 'parks', `${id}.json`), 'utf8'), before)
  assert.equal(s.claim(id, { ...args, successor_run_id: 'different' }).reason, 'successor-conflict')
}))

test('claim and settlement preserve authority outcomes', () => {
  const f = deadFixture()
  try {
    const id = f.s.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).park.park_id
    f.s.recordAnswer(id, { decision_id: 'd', actor: 'a', answer: 'yes' })
    assert.equal(f.s.claim(id, { decision_id: 'd', successor_run_id: 'next', enqueue: () => true, successorState: () => 'absent' }).park.launch_state, 'pending')
    assert.equal(f.s.settlePark(id, { successorState: () => 'absent' }).reason, 'no-terminal-evidence')
    assert.equal(f.s.settlePark(id, { successorState: () => 'resumed', outcome: 'abandoned' }).park.state, 'resumed')
    assert.equal(f.s.settlePark(id, { successorState: () => 'resumed' }).already, true)
  } finally { f.done() }
})

test('active successor links and transfers leases', () => each(({ s, dir }) => {
  const id = s.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).park.park_id
  s.recordAnswer(id, { decision_id: 'd', actor: 'a', answer: 'yes' })
  const result = s.claim(id, { decision_id: 'd', successor_run_id: 'next', enqueue: () => true, successorState: () => 'active' })
  assert.equal(result.park.launch_state, 'enqueued')
  assert.equal(Number.isFinite(result.park.linked_at), true)
  const lease = JSON.parse(readFileSync(join(dir, 'leases', `${leaseKey('a', 's')}.json`), 'utf8'))
  assert.equal(lease.phase, LEASE_PHASES.TRANSFERRED)
}))

test('unsafe ids and generated traversal never touch parks', () => each(({ s, dir, deps }) => {
  for (const id of ['../x', 'a/b', '.', '..', ' ']) {
    assert.equal(s.readPark(id), null)
    assert.equal(s.recordAnswer(id, { decision_id: 'd', actor: 'a', answer: 'y' }).reason, 'unresolvable')
    assert.equal(s.claim(id, { decision_id: 'd', successor_run_id: 'x', enqueue: () => true, successorState: () => 'absent' }).reason, 'unresolvable')
    assert.equal(s.settlePark(id, { successorState: () => 'resumed' }).reason, 'unresolvable')
  }
  const generated = reclaimStore({ dir, actor: 'generated', deps: { ...deps, uuid: () => 'park-0-id' } })
  assert.equal(generated.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).ok, true)
}))

test('parked rows carrying successor residue are unreadable', () => each(({ s, dir }) => {
  for (const mutate of [
    (park) => ({ ...park, spec: { run_id: 'next', resumes_park_id: park.park_id, decision: { decision_id: 'd', actor: 'ops', answer: 'yes' } } }),
    (park) => ({ ...park, leases: [{ reservation_id: 'r', role: 'a', sessionId: 's' }] }),
  ]) {
    const id = s.mintPark({ run_id: 'r', seats: [{ role: 'a', sessionId: 's' }] }).park.park_id
    const path = join(dir, 'parks', `${id}.json`)
    writeFileSync(path, JSON.stringify(mutate(JSON.parse(readFileSync(path, 'utf8')))))
    assert.equal(s.readPark(id), null)
  }
}))

test('reconcileParks sends active claimed rows through linking', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  assert.equal(f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).ok, true)
  const out = f.s.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ACTIVE })
  assert.deepEqual(out.linked, [id])
  const park = f.s.readPark(id)
  assert.equal(park.launch_state, 'enqueued')
  assert.equal(park.leases.length, 2)
  for (const handle of park.leases) assert.equal(JSON.parse(readFileSync(join(f.dir, 'leases', `${leaseKey(handle.role, handle.sessionId)}.json`), 'utf8')).phase, LEASE_PHASES.TRANSFERRED)
} finally { f.done() } })

test('reconcileParks completes a half-transferred set', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  let renames = 0
  const broken = reclaimStore({ dir: f.dir, actor: 'test', deps: { ...f.deps, renameSync(from, to) { if (String(to).includes('/leases/') && ++renames === 2) { const e = Error('rename'); e.code = 'EIO'; throw e } return fsRename(from, to) } } })
  const claimed = broken.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ACTIVE })
  assert.equal(claimed.linked, false)
  assert.deepEqual(f.s.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ACTIVE }).linked, [id])
} finally { f.done() } })

test('reconcileParks settles claimed rows only on terminal authority', () => {
  for (const state of [SUCCESSOR_STATES.RESUMED, SUCCESSOR_STATES.ABANDONED]) {
    const f = deadFixture()
    try {
      const { id } = parkFixture(f, state)
      const claimed = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: `next-${id}`, enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
      assert.equal(claimed.ok, true)
      const out = f.s.reconcileParks({ enqueue: () => true, successorState: () => state })
      assert.deepEqual(out.settled, [id])
      const park = f.s.readPark(id)
      assert.equal(park.state, state)
      assert.equal(park.launch_state, null)
      assert.deepEqual(park.leases, [])
    } finally { f.done() }
  }
})

test('reconcileParks adopts matching leases and renews owners', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  const claim = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  const before = claim.park.leases.map((h) => h.reservation_id)
  for (const handle of claim.park.leases) {
    const path = join(f.dir, 'leases', `${leaseKey(handle.role, handle.sessionId)}.json`)
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), owner: { pid: 999999999, startedAt: 1 } }))
  }
  const log = enqueueLog()
  assert.deepEqual(f.s.reconcileParks({ enqueue: log.fn, successorState: () => SUCCESSOR_STATES.ABSENT }).relaunched, [id])
  const park = f.s.readPark(id)
  assert.deepEqual(park.leases.map((h) => h.reservation_id), before)
  assert.equal(log.calls.length, 1)
  for (const seat of park.seats) assert.equal(JSON.parse(readFileSync(join(f.dir, 'leases', `${leaseKey(seat.role, seat.sessionId)}.json`), 'utf8')).owner.pid, f.deps.pid)
} finally { f.done() } })

test('reconcileParks replaces a malformed lease carrying its persisted id', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  const claim = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  const target = claim.park.leases[0]
  const path = join(f.dir, 'leases', `${leaseKey(target.role, target.sessionId)}.json`)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), reservation_id: target.reservation_id, phase: 'bad' }))
  assert.deepEqual(f.s.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).relaunched, [id])
  const next = JSON.parse(readFileSync(path, 'utf8'))
  assert.notEqual(next.reservation_id, target.reservation_id)
  assert.equal(f.s.readPark(id).leases.find((h) => h.role === target.role).reservation_id, next.reservation_id)
} finally { f.done() } })

test('malformed leases block linking and terminal release', () => {
  for (const authorityState of [SUCCESSOR_STATES.ACTIVE, SUCCESSOR_STATES.RESUMED]) {
    const f = deadFixture()
    try {
      const { id } = parkFixture(f, `r-${authorityState}`)
      const claim = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
      assert.equal(claim.ok, true)
      const path = join(f.dir, 'leases', `${leaseKey('b', 's2')}.json`)
      writeFileSync(path, '{broken')
      const before = readFileSync(join(f.dir, 'parks', `${id}.json`), 'utf8')
      const out = f.s.reconcileParks({ enqueue: () => true, successorState: () => authorityState })
      assert.deepEqual(out.unresolvable, [id])
      assert.equal(readFileSync(join(f.dir, 'parks', `${id}.json`), 'utf8'), before)
      assert.equal(readFileSync(path, 'utf8'), '{broken')
      assert.equal(existsSync(join(f.dir, 'leases', `${leaseKey('a', 's1')}.json`)), true)
    } finally { f.done() }
  }
})

test('claimed enqueued absent rolls back only after a complete release', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  const claim = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ACTIVE })
  assert.equal(claim.park.launch_state, 'enqueued')
  const survivor = join(f.dir, 'leases', `${leaseKey('b', 's2')}.json`)
  const broken = reclaimStore({ dir: f.dir, actor: 'test', deps: { ...f.deps, unlinkSync(path) { if (path === survivor) { const e = Error('unlink'); e.code = 'EIO'; throw e } return fsUnlink(path) } } })
  assert.deepEqual(broken.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).unresolvable, [id])
  assert.equal(broken.readPark(id).state, 'claimed')
  assert.deepEqual(f.s.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).restored, [id])
  assert.equal(f.s.readPark(id).state, 'parked')
} finally { f.done() } })

test('relaunch enqueue errors retain the claimed set', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  const before = f.s.readPark(id)
  assert.deepEqual(f.s.reconcileParks({ enqueue: () => { throw Error('down') }, successorState: () => SUCCESSOR_STATES.ABSENT }).unresolvable, [id])
  const after = f.s.readPark(id)
  assert.equal(after.state, 'claimed')
  assert.equal(after.leases.length, before.leases.length)
  for (const handle of after.leases) assert.equal(existsSync(join(f.dir, 'leases', `${leaseKey(handle.role, handle.sessionId)}.json`)), true)
} finally { f.done() } })

test('relaunch falsy enqueue restores and preserves foreign leases', () => { const f = deadFixture(); try {
  const { id } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  assert.deepEqual(f.s.reconcileParks({ enqueue: () => false, successorState: () => SUCCESSOR_STATES.ABSENT }).restored, [id])
  assert.equal(f.s.readPark(id).state, 'parked')
  const f2 = deadFixture()
  try {
    const fixture2 = parkFixture(f2)
    const claimed2 = f2.s.claim(fixture2.id, { decision_id: `d-${fixture2.id}`, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
    assert.equal(claimed2.ok, true)
    const foreignPath = join(f2.dir, 'leases', `${leaseKey('b', 's2')}.json`)
    const foreign = JSON.parse(readFileSync(foreignPath, 'utf8'))
    foreign.reservation_id = 'foreign'
    foreign.spec.run_id = 'foreign-run'
    foreign.spec.resumes_park_id = 'foreign-park'
    writeFileSync(foreignPath, JSON.stringify(foreign))
    assert.deepEqual(f2.s.reconcileParks({ enqueue: () => true, successorState: (spec) => spec.run_id === 'next' ? SUCCESSOR_STATES.ABSENT : SUCCESSOR_STATES.UNKNOWN }).restored, [fixture2.id])
    assert.equal(existsSync(foreignPath), true)
  } finally { f2.done() }
} finally { f.done() } })

test('unknown and mismatch authority leave claimed parks untouched', () => {
  for (const state of [SUCCESSOR_STATES.UNKNOWN, SUCCESSOR_STATES.MISMATCH]) {
    const f = deadFixture()
    try {
      const { id } = parkFixture(f, state)
      const claimed = f.s.claim(id, { decision_id: `d-${id}`, successor_run_id: `next-${id}`, enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
      assert.equal(claimed.ok, true)
      const path = join(f.dir, 'parks', `${id}.json`)
      const before = readFileSync(path, 'utf8')
      const log = enqueueLog()
      assert.deepEqual(f.s.reconcileParks({ enqueue: log.fn, successorState: () => state }).unresolvable, [id])
      assert.equal(readFileSync(path, 'utf8'), before)
      assert.equal(log.calls.length, 0)
    } finally { f.done() }
  }
})

test('overrideLease requires attestation and matches raw identity', () => { const f = deadFixture(); try {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'ops', answer: 'yes' } }
  const got = f.s.acquireLeases([{ role: 'a', sessionId: 's1' }], { spec, successorState: () => SUCCESSOR_STATES.ABSENT })
  const input = { actor: 'ops', reason: 'dead', reservation_id: got.handles[0].reservation_id }
  for (const bad of [
    { ...input },
    { ...input, attestation: { quiesced: false, method: 'stop' } },
    { ...input, attestation: { quiesced: true, method: '  ' } },
    { ...input, actor: ' ', attestation: { quiesced: true, method: 'stop' } },
    { ...input, reason: ' ', attestation: { quiesced: true, method: 'stop' } },
    { actor: 'ops', reason: 'dead', attestation: { quiesced: true, method: 'stop' } },
    { ...input, reservation_id: 'wrong', attestation: { quiesced: true, method: 'stop' } },
  ]) {
    assert.throws(() => f.s.overrideLease('a', 's1', bad))
    assert.equal(f.s.reconcileLease('a', 's1', { successorState: () => SUCCESSOR_STATES.ABSENT }).verdict, VERDICTS.UNRESOLVABLE)
  }
  const attestation = { quiesced: true, method: 'stop' }
  f.s.overrideLease('a', 's1', { ...input, attestation })
  assert.equal(f.s.reconcileLease('a', 's1', { successorState: () => SUCCESSOR_STATES.ABSENT }).verdict, VERDICTS.RECLAIMABLE)
  const lines = readFileSync(join(f.dir, 'overrides.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const record = lines.at(-1)
  assert.equal(record.actor, 'ops')
  assert.equal(record.reason, 'dead')
  assert.deepEqual(record.attestation, attestation)
  assert.equal(record.key, leaseKey('a', 's1'))
} finally { f.done() } })

test('digest lease overrides are inert after replacement bytes change', () => { const f = deadFixture(); try {
  const path = join(f.dir, 'leases', `${leaseKey('a', 's1')}.json`)
  writeFileSync(path, '{broken')
  const raw = readFileSync(path)
  f.s.overrideLease('a', 's1', { actor: 'ops', reason: 'repair', digest: awaitDigest(raw), attestation: { quiesced: true, method: 'stop' } })
  assert.equal(f.s.reconcileLease('a', 's1', { successorState: () => SUCCESSOR_STATES.ABSENT }).verdict, VERDICTS.RECLAIMABLE)
  const replacement = JSON.stringify({ reservation_id: 'new', key: leaseKey('a', 's1'), phase: LEASE_PHASES.HELD, role: 'a', sessionId: 's1', spec: { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'ops', answer: 'yes' } }, owner: { pid: 999999999, startedAt: 1 }, at: 1 })
  writeFileSync(path, replacement)
  assert.notEqual(f.s.reconcileLease('a', 's1', { successorState: () => SUCCESSOR_STATES.ABSENT }).verdict, VERDICTS.RECLAIMABLE)
  assert.equal(readFileSync(path, 'utf8'), replacement)
} finally { f.done() } })

test('reconcileParks validates arguments and returns six empty buckets', () => each(({ s }) => {
  for (const input of [{}, { enqueue: () => true }, { successorState: () => SUCCESSOR_STATES.ABSENT }, { enqueue: 1, successorState: () => SUCCESSOR_STATES.ABSENT }, { enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT, order: 'a' }]) {
    const out = s.reconcileParks(input)
    assert.deepEqual(out, { linked: [], relaunched: [], restored: [], unresolvable: [], waiting: [], settled: [] })
  }
}))

test('unattested lease override ledger records stay inert at verdict time', () => { const f = deadFixture(); try {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'ops', answer: 'yes' } }
  const got = f.s.acquireLeases([{ role: 'a', sessionId: 's1' }], { spec, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(got.ok, true)
  const key = leaseKey('a', 's1')
  const ledger = join(f.dir, 'overrides.jsonl')
  for (const attestation of [undefined, { quiesced: false, method: 'stop' }, { quiesced: true, method: '  ' }]) {
    const record = { at: 1, actor: 'ops', reason: 'manual', kind: 'lease', key, identity: { kind: 'reservation_id', value: got.handles[0].reservation_id }, ...(attestation === undefined ? {} : { attestation }) }
    appendFileSync(ledger, `\n${JSON.stringify(record)}\n`)
    assert.equal(f.s.reconcileLease('a', 's1', { successorState: () => SUCCESSOR_STATES.ABSENT }).verdict, VERDICTS.UNRESOLVABLE)
  }
} finally { f.done() } })

test('reconcileParks rejects malformed rows without writes or enqueue', () => {
  const mutations = [
    ['bad state', (park) => ({ ...park, state: 'nonsense' })],
    ['claimed/null', (park) => ({ ...park, launch_state: null })],
    ['parked/pending', (park) => ({ ...park, state: 'parked', launch_state: 'pending', spec: null, leases: [] })],
    ['decision/spec disagreement', (park) => ({ ...park, spec: { ...park.spec, decision: { ...park.spec.decision, answer: 'no' } } })],
    ['foreign resumes_park_id', (park) => ({ ...park, spec: { ...park.spec, resumes_park_id: 'elsewhere' } })],
    ['extra key', (park) => ({ ...park, extra: true })],
    ['unparseable', null],
  ]
  for (const [label, mutate] of mutations) {
    const f = deadFixture()
    try {
      const { id, answer } = parkFixture(f)
      const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
      assert.equal(claimed.ok, true, label)
      const path = join(f.dir, 'parks', `${id}.json`)
      const value = mutate ? mutate(JSON.parse(readFileSync(path, 'utf8'))) : null
      const bytes = mutate ? JSON.stringify(value) : '{broken'
      writeFileSync(path, bytes)
      const before = readFileSync(path, 'utf8')
      const enq = enqueueLog()
      const out = f.s.reconcileParks({ enqueue: enq.fn, successorState: () => SUCCESSOR_STATES.ABSENT })
      assert.equal(out.unresolvable.includes(id), true, label)
      assert.equal(readFileSync(path, 'utf8'), before, label)
      assert.equal(enq.calls.length, 0, label)
    } finally { f.done() }
  }
})

test('terminal rows with same-spec lease residue remain untouched', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  assert.equal(f.s.settlePark(id, { successorState: () => SUCCESSOR_STATES.RESUMED }).ok, true)
  const seat = { role: 'a', sessionId: 's1' }
  const path = join(f.dir, 'leases', `${leaseKey(seat.role, seat.sessionId)}.json`)
  writeFileSync(path, JSON.stringify({ reservation_id: 'stray', key: leaseKey(seat.role, seat.sessionId), phase: LEASE_PHASES.HELD, role: seat.role, sessionId: seat.sessionId, spec: claimed.park.spec, owner: { pid: 999999999, startedAt: 1 }, at: 1 }))
  const parkPath = join(f.dir, 'parks', `${id}.json`)
  const before = readFileSync(parkPath, 'utf8')
  const leaseBefore = readFileSync(path, 'utf8')
  const out = f.s.reconcileParks({ enqueue: () => true, successorState: () => { throw Error('terminal rows do not probe authority') } })
  assert.deepEqual(out.unresolvable, [id])
  assert.equal(readFileSync(parkPath, 'utf8'), before)
  assert.equal(readFileSync(path, 'utf8'), leaseBefore)
} finally { f.done() } })

test('cross-park claim refuses without enqueue and preserves P1', () => { const f = deadFixture(); try {
  const p1 = parkFixture(f, 'r1')
  const first = f.s.claim(p1.id, { decision_id: p1.answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(first.ok, true)
  const parkPath = join(f.dir, 'parks', `${p1.id}.json`)
  const before = readFileSync(parkPath, 'utf8')
  const ids = first.park.leases.map((handle) => handle.reservation_id)
  const p2 = parkFixture(f, 'r2')
  const enq = enqueueLog()
  const blocked = f.s.claim(p2.id, { decision_id: p2.answer.decision_id, successor_run_id: 'other', enqueue: enq.fn, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.deepEqual(blocked, { ok: false, reason: 'unresolvable' })
  assert.equal(enq.calls.length, 0)
  assert.equal(readFileSync(parkPath, 'utf8'), before)
  assert.deepEqual(f.s.readPark(p1.id).leases.map((handle) => handle.reservation_id), ids)
  const conflict = f.s.claim(p1.id, { decision_id: p1.answer.decision_id, successor_run_id: 'different', enqueue: enq.fn, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(conflict.reason, 'successor-conflict')
} finally { f.done() } })

test('reconcileParks sweeps throwing, waiting, terminal, and corrupt rows', () => { const f = deadFixture(); try {
  const boomSeats = [{ role: 'a', sessionId: 'boom-a' }, { role: 'b', sessionId: 'boom-b' }]
  const waitingSeats = [{ role: 'a', sessionId: 'waiting-a' }, { role: 'b', sessionId: 'waiting-b' }]
  const terminalSeats = [{ role: 'a', sessionId: 'terminal-a' }, { role: 'b', sessionId: 'terminal-b' }]
  const boom = parkFixture(f, 'r1', boomSeats)
  assert.equal(f.s.claim(boom.id, { decision_id: boom.answer.decision_id, successor_run_id: 'boom', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).ok, true)
  const waiting = parkFixture(f, 'r2', waitingSeats)
  const terminal = parkFixture(f, 'r3', terminalSeats)
  assert.equal(f.s.claim(terminal.id, { decision_id: terminal.answer.decision_id, successor_run_id: 'term', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).ok, true)
  assert.equal(f.s.settlePark(terminal.id, { successorState: () => SUCCESSOR_STATES.RESUMED }).ok, true)
  writeFileSync(join(f.dir, 'parks', 'wrecked.json'), '{nope')
  const enq = enqueueLog((spec) => { if (spec.run_id === 'boom') throw Error('enqueue down'); return true })
  const out = f.s.reconcileParks({ enqueue: enq.fn, successorState: (spec) => spec.run_id === 'term' ? SUCCESSOR_STATES.RESUMED : SUCCESSOR_STATES.ABSENT })
  assert.equal(out.unresolvable.includes(boom.id), true)
  assert.deepEqual(out.waiting, [waiting.id])
  assert.deepEqual(out.settled, [terminal.id])
  assert.equal(out.unresolvable.includes('wrecked'), true)
  for (const values of Object.values(out)) assert.deepEqual(values, [...values].sort())
} finally { f.done() } })

test('relaunch reserve failure rolls back every persisted lease', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  const target = claimed.park.leases.find((handle) => handle.role === 'b')
  const targetPath = join(f.dir, 'leases', `${leaseKey(target.role, target.sessionId)}.json`)
  writeFileSync(targetPath, JSON.stringify({ ...JSON.parse(readFileSync(targetPath, 'utf8')), phase: 'bad' }))
  const broken = reclaimStore({ dir: f.dir, actor: 'broken', deps: { ...f.deps, linkSync(from, to) { if (String(to) === targetPath) { const e = Error('busy'); e.code = 'EEXIST'; throw e } return fsLink(from, to) } } })
  const out = broken.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.deepEqual(out.restored, [id])
  assert.equal(broken.readPark(id).state, 'parked')
  assert.equal(broken.activeLeases().length, 0)
} finally { f.done() } })

test('relaunch verifies the complete lease set before enqueue', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  const first = claimed.park.leases.find((handle) => handle.role === 'a')
  const firstPath = join(f.dir, 'leases', `${leaseKey(first.role, first.sessionId)}.json`)
  const parkPath = join(f.dir, 'parks', `${id}.json`)
  let parkWrites = 0
  const broken = reclaimStore({ dir: f.dir, actor: 'broken', deps: { ...f.deps, renameSync(from, to) { const result = fsRename(from, to); if (String(to) === parkPath && ++parkWrites === 2) writeFileSync(firstPath, '{clobbered'); return result } } })
  const enq = enqueueLog()
  const out = broken.reconcileParks({ enqueue: enq.fn, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.deepEqual(out.unresolvable, [id])
  assert.equal(enq.calls.length, 0)
  assert.equal(broken.readPark(id).state, 'claimed')
  assert.equal(readFileSync(firstPath, 'utf8'), '{clobbered')
} finally { f.done() } })

// --- review findings, 2026-08-14 (each test dies without its fix) -----------

// #1 HIGH: writeReplace/advance stage `<key>.json.tmp.<uuid>` beside the
// record. Parsing every directory entry turned a crashed writer's orphan into
// a permanent phantom lease, so the post-release scan saw a lease that is not
// a lease and settlement could never complete.
test('scratch files are skipped, not reported as corrupt leases or parks', () => each(({ s, dir }) => {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  assert.equal(s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'active' }).ok, true)
  writeFileSync(join(dir, 'leases', `${leaseKey('a', 's')}.json.tmp.orphan`), '{"half":')
  const leases = s.activeLeases()
  assert.equal(leases.length, 1, 'the orphan must not appear as a second lease')
  assert.equal(leases.filter((l) => l.corrupt).length, 0, 'a scratch file is not a corrupt record')

  assert.equal(s.mintPark({ run_id: 'r2', seats: [{ role: 'a', sessionId: 's' }] }).ok, true)
  writeFileSync(join(dir, 'parks', 'whatever.json.tmp.orphan'), '{"half":')
  const parks = s.listParks()
  assert.equal(parks.filter((p) => p.corrupt).length, 0, 'a park scratch file is not a corrupt row')
}))

// A real record that will not parse must STILL surface — the scratch filter
// must not become a way to hide corruption.
test('a .json lease that will not parse is still reported corrupt', () => each(({ s, dir }) => {
  writeFileSync(join(dir, 'leases', 'a__s.json'), '{not json')
  const corrupt = s.activeLeases().filter((l) => l.corrupt)
  assert.equal(corrupt.length, 1)
}))

// #3: reserve() loses a race with its own vocabulary ('busy' | 'contended').
// Leaking those through reported a RETRYABLE contention as the terminal
// 'unresolvable', and neither is a member of the closed CONFLICT_REASONS.
test('a lease lock lost to contention reports seat-busy, not the terminal unresolvable', () => each(({ s, dir, deps }) => {
  const spec = { run_id: 'r', resumes_park_id: 'p', decision: { decision_id: 'd', actor: 'a', answer: 'y' } }
  const key = leaseKey('a', 's')
  // leaseLockName is module-private but deterministic; recomputed here so the
  // test can hold the exact lock reserve() will need.
  const lockName = createHash('sha256').update(JSON.stringify(['lease-lock', key])).digest('hex').slice(0, 32)
  // Another supervisor holds the lease LOCK while no lease RECORD exists, so
  // reconcile answers FREE and acquire proceeds to reserve(), whose withLock
  // exhausts LOCK_ATTEMPTS and answers 'contended'. Mapping that to
  // 'unresolvable' would report a retryable race as terminal. The earlier
  // two-store version of this test was vacuous: it hit the BUSY pre-check
  // branch, which already mapped correctly, and survived the mutation.
  const other = reclaimStore({ dir, actor: 'other', deps: { ...deps, pid: 701 } })
  assert.equal(other.acquire(lockName).ok, true)
  const out = s.acquireLeases([{ role: 'a', sessionId: 's' }], { spec, successorState: () => 'active' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'seat-busy')
  assert.ok(CONFLICT_REASONS.includes(out.reason), 'the reason must be a member of the closed set')
}))

// #7: reservationEngine builds an internal lock-only store for every reclaim
// root. Creating leases/ and parks/ there planted two directories inside
// headless/ and headless-rpc/, whose run-allocation enumerates the root.
test('a lock-only store creates no record directories', () => each(({ dir, deps }) => {
  const sub = join(dir, 'lockonly')
  mkdirSync(sub, { recursive: true })
  reclaimStore({ dir: sub, actor: 'test', deps, _lockOnly: true })
  assert.equal(existsSync(join(sub, 'leases')), false)
  assert.equal(existsSync(join(sub, 'parks')), false)
}))

// --- review round-2 residuals, 2026-08-14 (each test dies without its guard) --

// should-fix 1: the sweep's per-row catch. Another supervisor holding ONE
// park's lock makes withLock throw reclaim-lock-unavailable for that row;
// without the catch the throw aborts the whole sweep and every later park —
// including healthy waiting rows — is silently skipped.
test('a row whose lock is held elsewhere buckets unresolvable without aborting the sweep', () => { const f = deadFixture(); try {
  const locked = parkFixture(f, 'r1', [{ role: 'a', sessionId: 'lk-a' }])
  const waiting = parkFixture(f, 'r2', [{ role: 'b', sessionId: 'wt-b' }])
  // The holder must look ALIVE to the sweeping store — under deadFixture's
  // all-pids-dead kill, the engine's automatic ESRCH displacement would just
  // take the lock over (correct behaviour, wrong scenario).
  const liveKill = (pid, signal) => { if (pid === 701 || pid === -701) return true; const e = Error('gone'); e.code = 'ESRCH'; throw e }
  const other = reclaimStore({ dir: f.dir, actor: 'other', deps: { ...f.deps, pid: 701, kill: liveKill } })
  assert.equal(other.acquire(parkLockName(locked.id)).ok, true)
  const sweeper = reclaimStore({ dir: f.dir, actor: 'sweeper', deps: { ...f.deps, kill: liveKill } })
  const out = sweeper.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(out.unresolvable.includes(locked.id), true, 'the contended row buckets unresolvable')
  assert.equal(out.waiting.includes(waiting.id), true, 'rows after the contended one are still swept')
} finally { f.done() } })

// should-fix 2: the settlement vocabulary. An incomplete release must answer
// lease-release-incomplete (retryable), never the terminal unresolvable —
// collapsing the two is exactly what the r2 rework existed to prevent.
test('settlePark reports lease-release-incomplete when a lease unlink fails', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  const target = claimed.park.leases[0]
  const targetPath = join(f.dir, 'leases', `${leaseKey(target.role, target.sessionId)}.json`)
  const broken = reclaimStore({ dir: f.dir, actor: 'broken', deps: { ...f.deps, unlinkSync(path) { if (String(path) === targetPath) { const e = Error('io'); e.code = 'EIO'; throw e } return fsUnlink(path) } } })
  const out = broken.settlePark(id, { successorState: () => SUCCESSOR_STATES.RESUMED })
  assert.deepEqual({ ok: out.ok, reason: out.reason }, { ok: false, reason: 'lease-release-incomplete' })
  assert.equal(broken.readPark(id).state, 'claimed', 'an incomplete release never persists the terminal state')
} finally { f.done() } })

// consider C2: the settle residue scan. All owned handles release cleanly, but
// a stray same-spec lease under another key remains on disk — settlement must
// refuse with the retryable reason rather than declare the seat set free.
test('settlePark refuses on same-spec lease residue outside the released set', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  const claimed = f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.equal(claimed.ok, true)
  const strayKey = leaseKey('c', 'sx')
  writeFileSync(join(f.dir, 'leases', `${strayKey}.json`), JSON.stringify({ reservation_id: 'stray', key: strayKey, phase: LEASE_PHASES.HELD, role: 'c', sessionId: 'sx', spec: claimed.park.spec, owner: { pid: 999999999, startedAt: 1 }, at: 1 }))
  const out = f.s.settlePark(id, { successorState: () => SUCCESSOR_STATES.RESUMED })
  assert.deepEqual({ ok: out.ok, reason: out.reason }, { ok: false, reason: 'lease-release-incomplete' })
} finally { f.done() } })

// consider C5: bucket ordering, with ids whose FILENAME order differs from
// their stem order ('a-b.json' < 'a.json' as filenames, 'a' < 'a-b' as stems)
// so the promised ascending order is only true if the sweep actually sorts.
test('sweep buckets are sorted by id, not by readdir filename order', () => { const f = deadFixture(); try {
  writeFileSync(join(f.dir, 'parks', 'a.json'), '{nope')
  writeFileSync(join(f.dir, 'parks', 'a-b.json'), '{nope')
  const out = f.s.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT })
  assert.deepEqual(out.unresolvable, ['a', 'a-b'])
} finally { f.done() } })

// consider C6: the under-lock re-validation. The park file is valid when
// listParks scans it and is tampered before the row's lock is taken — the
// TOCTOU window the re-read exists for. A raw re-read would act on the
// tampered record (here: link it under its forged park_id).
test('a park tampered between the scan and its lock is re-validated, not acted on', () => { const f = deadFixture(); try {
  const { id, answer } = parkFixture(f)
  assert.equal(f.s.claim(id, { decision_id: answer.decision_id, successor_run_id: 'next', enqueue: () => true, successorState: () => SUCCESSOR_STATES.ABSENT }).ok, true)
  const parkPath = join(f.dir, 'parks', `${id}.json`)
  // Tamper AFTER listParks validated the row and exactly when its lock is
  // being taken: flip claimed/pending to parked/null while leaving the spec
  // and lease handles in place. That is malformed residue per the row
  // invariant — a raw re-read would trust the phase and bucket it 'waiting',
  // silently parking a row that still owns seats.
  let tampered = false
  const broken = reclaimStore({ dir: f.dir, actor: 'broken', deps: { ...f.deps, linkSync(from, to) {
    if (!tampered && String(to).includes(parkLockName(id))) { tampered = true; writeFileSync(parkPath, JSON.stringify({ ...JSON.parse(readFileSync(parkPath, 'utf8')), state: 'parked', launch_state: null })) }
    return fsLink(from, to)
  } } })
  const out = broken.reconcileParks({ enqueue: () => true, successorState: () => SUCCESSOR_STATES.ACTIVE })
  assert.equal(out.unresolvable.includes(id), true, 'the tampered row is unresolvable')
  assert.equal(out.waiting.length, 0, 'residue-carrying parked/null is never read as a healthy waiting row')
  assert.equal(JSON.parse(readFileSync(parkPath, 'utf8')).state, 'parked', 'the row is left untouched for a human')
} finally { f.done() } })
