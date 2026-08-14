import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, readdirSync, appendFileSync } from 'node:fs'
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

test('exports closed enums', () => { assert.deepEqual(PHASES, { RESERVED: 'reserved', SPAWNING: 'spawning', RUNNING: 'running' }); assert.deepEqual(VERDICTS, { FREE: 'free', RECLAIMABLE: 'reclaimable', BUSY: 'busy', UNRESOLVABLE: 'unresolvable' }) })
test('evidence enum includes successor authority', () => assert.deepEqual(EVIDENCE_KINDS, { PGID: 'pgid', SUCCESSOR: 'successor' }))
test('liveness enum is tri-state', () => assert.deepEqual(LIVENESS, { ALIVE: 'alive', DEAD: 'dead', UNKNOWN: 'unknown' }))
test('lock constants are bounded', () => { assert.equal(LOCK_ATTEMPTS, 20); assert.equal(LOCK_INTERVAL_MS, 50) })
test('marker lock names are stable and safe', () => { assert.equal(markerLockName('x'), markerLockName('x')); assert.notEqual(markerLockName('x'), markerLockName('y')); assert.match(markerLockName('x'), /^[0-9a-f]+$/) })
test('free reconciliation', () => each(({ s }) => assert.equal(s.reconcile('a').verdict, VERDICTS.FREE)))
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
test('post-link foreign token fails closed without rewriting bytes', () => { const f = fixture(); try { let tampered = null; const s = reclaimStore({ dir: f.dir, actor: 'x', deps: { ...f.deps, linkSync(from, to) { linkSync(from, to); if (!tampered) { tampered = JSON.stringify({ fence: 1, token: 'foreign', owner: { pid: 1 }, released: false }); writeFileSync(to, tampered) } } } }); const r = s.acquire('x'); assert.equal(r.reason, 'unresolvable'); assert.equal(readFileSync(join(f.dir, 'locks', 'x.lock.1'), 'utf8'), tampered) } finally { f.done() } })
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
