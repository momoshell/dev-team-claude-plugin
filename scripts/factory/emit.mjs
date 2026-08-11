#!/usr/bin/env node
// scripts/factory/emit.mjs — the never-throwing emitter facade over
// scripts/factory/ledger.mjs, plus the run sidecar (<stateDir>/ledger/run.json)
// that owns run identity, the phase cursor, caller-allocated seq ranges,
// per-gate attempt counters, heartbeat cadence, the billed accumulator, the
// per-dispatch resolution map, and the drop counters.
//
// ADR-024/ADR-026 clause 1 (INSTRUMENTATION IS NEVER LOAD-BEARING): every
// public method on the emitter returned by openRun() is wrapped so no throw
// ever escapes it — a failure increments a drop counter and writes AT MOST
// ONE stderr line for the whole process lifetime. ledger.mjs deliberately
// throws when its own JSONL append fails ("losing the raw record is fatal
// to the caller", ledger.mjs:11-13); this facade exists specifically to
// swallow that (and every other ledger/lock failure) without ever changing
// a caller's outcome, exit code, or returned value. openRun() ITSELF never
// throws either — any failure standing up the sidecar (an unwritable
// stateDir, a missing parent, a filesystem without hardlink support) yields
// a fully-formed, fully-inert DEGRADED emitter with the same method
// surface, never an exception out of openRun().
//
// ADR-027 (LOCK DISCIPLINE / the seq-allocation gotcha this module exists
// for): ledger.mjs's own seq allocator (nextSeq, ledger.mjs:624-643) seeds
// itself from SELECT MAX(seq) ONCE per process per (adw_id, kind) — a
// single-process-only design. Below the Node floor ensureDb() always
// returns null, so max is ALWAYS 0 and every below-floor process restarts
// numbering at 1: a deterministic 100% collision the instant a second
// process (or a second below-floor process) shares an adw_id. This module
// is the first multi-process caller, so it never relies on ledger's own
// allocator — every emission passes an EXPLICIT seq drawn from a
// PARENT-allocated, sidecar-persisted range. The critical section that
// allocates a range contains NO sqlite, NO JSONL, NO spawn — it only reads
// the sidecar, bumps its `next`/`reserved_through` counters, and does an
// atomic replace, all before any ledger I/O happens outside the lock. The
// reservation is persisted BEFORE any emission: a crash mid-batch leaves a
// GAP, never a DUPLICATE. seq is therefore MONOTONE, NOT GAPLESS — safe
// because ledger.mjs's readers never assume contiguity: listEvents pages by
// `id` (ledger.mjs:1131) and dumpTable orders by the table's natural key
// (ledger.mjs:1148), neither of which "repairs" a gap by inferring a
// missing row from the numbering.
//
// Lock waiting is BOUNDED, always (conventions.md 2026-08-08): a fixed
// retry budget (20 x 50ms ~= 1s), then a counted give-up. Stealing a stale
// lock is a discrete, one-shot action and never itself consumes that
// bounded wait budget — only genuine contention waits do.
//
// conventions.md 2026-08-02 (concurrency-unsafe check-then-act): every
// check-then-act on the sidecar (create-or-adopt, startRun's idempotency,
// endRun's idempotency, the stale-lock steal) happens INSIDE a single lock
// acquisition — never as an unlocked read followed by a separate write. The
// sidecar's one-time creation is exclusive-create via
// writeFileSync(tmp)+linkSync (kept ONLY for that genuine "does this run
// exist yet" exclusivity, which needs EEXIST semantics) — EEXIST is the
// "someone else already created it, adopt their file" signal, never an
// error. Every LATER mutation of an already-existing sidecar is an atomic
// renameSync replace instead: unlike unlink-then-link, a rename has no
// absent-file window, so no unlocked reader can ever observe "no run yet"
// mid-mutation and mint a second identity. The lock file itself is ALSO
// created via writeFileSync(tmp)+linkSync (never via a direct
// writeFileSync(path, ..., {flag:'wx'}) — that's TWO separate syscalls,
// open() then write(), with a window in between where the lock file exists
// but is 0 bytes; linkSync makes the fully-written content visible at the
// lock path in ONE atomic step, so it is NEVER observable half-written —
// M5, round 3) carrying {pid, started_at}. A corrupt or unparseable lock —
// now reachable only via genuine external damage, since the create path can
// no longer produce one itself — is STALE only once it clears the SAME age
// gate a normal stale judgment requires (via on-disk mtime, since its
// content, and therefore its own recorded age, is lost); it is never broken
// on sight. A lock file that vanishes between our EEXIST and our read of it
// is CONTENTION (retry), never automatically stale. Stealing a stale lock is
// a compare-and-take (atomic rename-away, content-verified) — never a plain
// unlink — so a second stealer can never delete a lock a third process
// legitimately just created.
//
// LIBRARY vs CLI: importing this file performs no I/O, opens no file, and
// installs no signal handler (mirrors ledger.mjs:34-41). installFinalizer()
// is opt-in only — openRun() never installs it, and delegates to
// ledger.mjs's OWN installFinalizer (the only writer that can honestly land
// status 'fail') rather than hand-rolling a signal handler.
//
// #40 written obligation: this module never sweeps or writes
// ~/.dev-team/factory/ itself, and it never resolves a default db path the
// way the ledger CLI does — db_path always travels explicitly, in the
// sidecar.

import {
  writeFileSync, unlinkSync, linkSync, renameSync, readFileSync, mkdirSync, chmodSync, statSync, existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  openLedger, isoMs, SESSION_STATUSES,
} from './ledger.mjs'

// ---------------------------------------------------------------------------
// Module-scoped state — the closed set of stderr once-guards this module
// uses to honor "at most one stderr line for the whole process lifetime"
// PER NOTICE KIND (module header, line 10) across EVERY emitter/handle this
// process ever opens — never per-call, per-instance state, which would let
// two or more emitters opened by the same process (e.g. two verbs invoked
// in-process, a caller that re-opens after dispose(), or several verbs each
// hitting their own facade failure) each independently produce their own
// line (M4 residual, round 3):
//   - ledgerDegradedNoticeRelayed: the ledger's OWN degraded-notice relay
//     (see openRunInner's `ledgerStderrRelay` below).
//   - facadeFailureNoticeWritten: every OTHER facade-side failure/give-up
//     notice raised from within an already-open emitter (lock give-ups,
//     sidecar identity mismatches, reserveSeq/bumpStat/emit failures, ...).
//   - degradedOpenRunNoticeWritten: the single "openRun is running fully
//     degraded" notice raised when openRun() itself cannot stand up a
//     working sidecar at all.
// A test-only reset (_resetNoticeGuardsForTest, exported at the bottom of
// this file) exists SOLELY so a test suite sharing one process across many
// otherwise-independent scenarios can isolate them — never called from any
// real call site.
// ---------------------------------------------------------------------------

let ledgerDegradedNoticeRelayed = false
let facadeFailureNoticeWritten = false
let degradedOpenRunNoticeWritten = false

// ---------------------------------------------------------------------------
// Small fs helpers — the atomic-write primitives this whole module rests on.
// ---------------------------------------------------------------------------

function tmpNameFor(path) {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
}

function unlinkIfExists(path) {
  try {
    unlinkSync(path)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function chmodIfExists(path, mode) {
  try {
    chmodSync(path, mode)
  } catch {
    // Tolerate a missing file — mirrors ledger.mjs's own chmodIfExists.
  }
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Absent or corrupt — both are "nothing usable here" to every caller of
    // this helper. Callers that must DISTINGUISH absent from corrupt (the
    // lock steal logic) use readFileStatus below instead.
    return null
  }
}

// Distinguishes "the file is genuinely gone" (ENOENT — ordinary contention:
// e.g. a holder released between our EEXIST and this read) from "the file
// is there but unparseable" (corrupt — STALE, safe to break) from a clean
// parse. Never conflates the first two, unlike readJsonOrNull.
function readFileStatus(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' }
    throw err
  }
  try {
    return { status: 'parsed', value: JSON.parse(raw) }
  } catch {
    return { status: 'corrupt' }
  }
}

function secureMkdirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mode is masked by the process umask, so an explicit chmod is what
  // actually guarantees 0700 (mirrors ledger.mjs's ensureDirAndPerms).
  chmodIfExists(dir, 0o700)
}

// Exclusive create: the FIRST writer to link its tmp file into `path` wins;
// every later attempt gets EEXIST — the ADOPT signal, never an error. Used
// ONLY for the sidecar's one-time creation (openRun, itself now inside the
// run lock — see createOrAdoptSidecar) — by the time any mutation runs, the
// sidecar is known to already exist.
function createExclusive(path, obj) {
  secureMkdirSync(dirname(path))
  const tmp = tmpNameFor(path)
  writeFileSync(tmp, JSON.stringify(obj))
  chmodIfExists(tmp, 0o600)
  try {
    linkSync(tmp, path)
    chmodIfExists(path, 0o600)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') {
      unlinkIfExists(tmp)
      throw err
    }
    return false
  } finally {
    unlinkIfExists(tmp)
  }
}

// Atomic replace — valid ONLY while the caller holds the RMW lock on
// `path` (so no other writer can observe a torn state in between).
// renameSync is an atomic replace on POSIX filesystems: unlike an
// unlink-then-link pair, there is NO window in which `path` is absent, so
// no unlocked reader (sidecar(), the create-or-adopt decision, startRun,
// endRun) can ever observe "no run yet" mid-mutation.
function replaceLocked(path, obj) {
  const tmp = tmpNameFor(path)
  writeFileSync(tmp, JSON.stringify(obj))
  chmodIfExists(tmp, 0o600)
  renameSync(tmp, path)
}

// Synchronous, bounded sleep for the lock-wait retry loop only — a
// deliberately small, local re-implementation (not shared with
// ledger.mjs's own foreground-only sleepSync) confined to this module's own
// bounded (20 x 50ms ~= 1s) retry budget.
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

const LOCK_RETRY_BUDGET = 20
const LOCK_RETRY_INTERVAL_MS = 50
// Small random jitter added to every retry sleep so multiple contenders
// woken from the same fixed interval don't stay synchronized on every
// subsequent retry ("thundering herd" — should-fix, round 3).
const LOCK_RETRY_JITTER_MS = 15
// Well above the ~1s bounded retry window, so a lock genuinely held by a
// live, well-behaved holder is never mistaken for stale mid-contention.
const LOCK_STALE_AGE_MS = 30_000

function retryDelayMs() {
  return LOCK_RETRY_INTERVAL_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS)
}

// A corrupt/unparseable lock carries no `started_at` of its own to judge age
// from (its content is lost) — its ON-DISK MTIME is the only honest proxy
// for "how long has something been sitting at this path". Falls back to
// treating a lock that vanished out from under us (ENOENT while statting)
// as ordinary contention, never as an instant steal.
function corruptLockAgeMs(lockPath, nowMs) {
  try {
    return nowMs - statSync(lockPath).mtimeMs
  } catch {
    return 0
  }
}

// process.kill(pid, 0) liveness probe: ESRCH means "definitely no such
// process" (dead, safe to steal regardless of age); anything else — the
// process is alive, or we simply lack permission to know (EPERM) — must
// NEVER be treated as "dead" on liveness grounds alone.
function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

// A lock is stale if its holder is confirmed DEAD (steal regardless of
// age), or — absent a confirmed-dead holder — if it's simply too old.
// `existing` is always a successfully-parsed object here; a corrupt lock is
// handled by its own separate branch in acquireLock, never routed through
// this function.
function isLockStale(existing, nowMs) {
  if (!existing || typeof existing.started_at !== 'string') return true
  if (Number.isInteger(existing.pid) && !pidIsAlive(existing.pid)) return true
  const startedMs = Date.parse(existing.started_at)
  return !Number.isFinite(startedMs) || (nowMs - startedMs) > LOCK_STALE_AGE_MS
}

function lockValuesEqual(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  return a.pid === b.pid && a.started_at === b.started_at
}

// Compare-and-take steal: renameSync is atomic, so whatever is CURRENTLY at
// `lockPath` the instant we rename is exactly what we take — never a lock a
// concurrent unlinker could split into "gone, then written by someone else"
// under us. After the rename, we verify the content we actually captured
// matches what we judged stale BEFORE we read it — if a fresh, live lock
// raced in between our judgment and this rename, we put it straight back
// and treat this attempt as ordinary contention rather than a steal. A
// concurrent stealer racing the SAME rename gets ENOENT and must back off.
function stealStaleLock(lockPath, judgedStaleValue, judgedCorrupt) {
  const staleName = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  try {
    renameSync(lockPath, staleName)
  } catch (err) {
    if (err.code === 'ENOENT') return { stolen: false }
    throw err
  }
  const taken = readFileStatus(staleName)
  const takenValue = taken.status === 'parsed' ? taken.value : null
  const matches = judgedCorrupt
    ? taken.status !== 'parsed' // still corrupt/unparseable — same stale kind
    : lockValuesEqual(takenValue, judgedStaleValue)
  if (matches) {
    unlinkIfExists(staleName)
    return { stolen: true }
  }
  // We grabbed something OTHER than what we judged stale (a fresh, live
  // lock raced in) — restore it and refuse to steal. NOTE: renameSync(a, b)
  // when `b` already exists SUCCEEDS SILENTLY and OVERWRITES rather than
  // throwing, so this is not a true compare-and-restore — if a legitimate
  // successor has ALREADY created a new lock at `lockPath` in the narrow
  // window between our rename-away above and this restore, this call would
  // clobber it. This narrow, pre-existing race is unrelated to M5 (which
  // only concerns the ORIGINAL create) and is not itself a Must-fix; a
  // caller who loses their lock this way still fails safe via the same
  // bounded retry/give-up path every other contention case uses.
  if (!existsSync(lockPath)) {
    try {
      renameSync(staleName, lockPath)
      return { stolen: false }
    } catch {
      // Fall through to the orphan-cleanup below.
    }
  }
  unlinkIfExists(staleName)
  return { stolen: false }
}

// Bounded RMW lock acquisition. A corrupt/unparseable or confirmed-stale
// lock is broken (stolen) — but only ONCE per call, on the FIRST such
// judgment; from then on contention is waited out for the fixed retry
// budget before giving up. `waitAttempts` — NOT the steal itself — is the
// only thing the bounded budget counts: a steal is a discrete, free retry.
// Returns the holder object {pid, started_at} on success, or null on
// give-up.
//
// M5 (round 3): the lock file is created via the SAME exclusive-create
// primitive (createExclusive: writeFileSync(tmp) then linkSync(tmp, path))
// used for the sidecar's own one-time creation, never via
// writeFileSync(path, ..., {flag:'wx'}) directly. The latter is
// open(O_CREAT|O_EXCL) followed by a SEPARATE write() syscall — between
// those two syscalls the lock file exists on disk but is 0 bytes, and a
// concurrent reader landing in that window would see a corrupt/unparseable
// lock. linkSync is a single atomic syscall: the fully-written tmp file's
// content becomes visible at `lockPath` in one step, so `lockPath` is NEVER
// observable half-written by any concurrent reader.
function acquireLock(lockPath, nowFn) {
  secureMkdirSync(dirname(lockPath))
  let stoleOnce = false
  let waitAttempts = 0
  for (;;) {
    const holder = { pid: process.pid, started_at: isoMs(nowFn()) }
    if (createExclusive(lockPath, holder)) {
      return holder
    }
    const read = readFileStatus(lockPath)
    if (read.status === 'missing') {
      // Vanished between our EEXIST and this read (e.g. the holder just
      // released) — genuine contention, never automatically stale.
      if (waitAttempts >= LOCK_RETRY_BUDGET) return null
      waitAttempts += 1
      sleepSync(retryDelayMs())
      continue
    }
    const existingValue = read.status === 'parsed' ? read.value : null
    const judgedCorrupt = read.status === 'corrupt'
    // M5 (round 3): a corrupt/unparseable lock carries no pid/started_at to
    // run the normal liveness+age gate against — its content is lost, not
    // merely absent. Since the atomic create above means a lock can no
    // longer be observed mid-write under NORMAL operation, a genuinely
    // corrupt lock here can only be the result of external damage (e.g. a
    // `kill -9` mid-write of some OTHER writer, or on-disk corruption) — it
    // must still clear the SAME age gate a normal stale judgment requires
    // (via on-disk mtime, the only proxy left once content is lost) rather
    // than being treated as instantly stale with no check at all.
    const judgedStale = judgedCorrupt
      ? corruptLockAgeMs(lockPath, nowFn()) > LOCK_STALE_AGE_MS
      : isLockStale(existingValue, nowFn())
    if (!stoleOnce && judgedStale) {
      stoleOnce = true
      const { stolen } = stealStaleLock(lockPath, existingValue, judgedCorrupt)
      if (stolen) continue // free retry — does not consume the wait budget
    }
    if (waitAttempts >= LOCK_RETRY_BUDGET) return null
    waitAttempts += 1
    sleepSync(retryDelayMs())
  }
}

// Release only if the on-disk lock still carries THIS holder's exact
// pid + started_at — a late-waking, already-superseded holder must never
// delete a successor's lock (mirrors dispatch.mjs:2017-2025).
function releaseLock(lockPath, holder) {
  const current = readJsonOrNull(lockPath)
  if (current && current.pid === holder.pid && current.started_at === holder.started_at) {
    unlinkIfExists(lockPath)
  }
}

// Strips ANSI CSI escape sequences whole, then strips every remaining
// control character (including embedded newlines) — two distinct passes
// because a bare control-character strip alone would leave the printable
// remainder of an ANSI sequence (e.g. "31m") behind as visible garbage.
function stripControlAndAnsi(message) {
  // eslint-disable-next-line no-control-regex
  const withoutAnsi = message.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
  // eslint-disable-next-line no-control-regex
  return withoutAnsi.replace(/[\x00-\x1F\x7F]/g, '')
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

const ZERO_STATS = Object.freeze({
  emitted: 0,
  dropped: 0,
  lock_giveups: 0,
  resolution_ambiguous: 0,
  resolution_missing: 0,
  payload_keys_dropped: 0,
})
const STAT_FIELDS = Object.freeze(Object.keys(ZERO_STATS))
// The closed set of stats a caller may bump directly via bumpStat — never
// an arbitrary string, so a hostile or accidental name (including
// prototype-pollution shapes) can't collide with anything.
const BUMPABLE_STATS = new Set(['resolution_missing', 'resolution_ambiguous', 'payload_keys_dropped'])
const FORBIDDEN_GATE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_SEQ_RESERVE_N = 64

// ---------------------------------------------------------------------------
// The fully-inert DEGRADED emitter — returned when openRun() itself cannot
// stand up a working sidecar (unwritable stateDir, missing parent, a
// filesystem without hardlink support, a lock give-up during the very
// first create-or-adopt). Same method surface as a healthy emitter; every
// method is a no-op that counts into `dropped` and never throws.
// ---------------------------------------------------------------------------

function buildDegradedEmitter(stderr, reason) {
  const localStats = { ...ZERO_STATS }
  // Module-scoped (not per-call) guard — see the module-scoped state comment
  // above: three separate degraded openRun() calls in the same process must
  // still produce at most one total stderr line, never one each (M4).
  function noteStderrOnce(line) {
    if (degradedOpenRunNoticeWritten) return
    degradedOpenRunNoticeWritten = true
    try {
      stderr.write(`${line}\n`)
    } catch {
      // Best-effort: a broken stderr sink must not itself become a throw.
    }
  }
  noteStderrOnce(`emit: openRun is running fully degraded — ${reason && reason.message ? reason.message : String(reason)}`)

  function drop(returnValue) {
    return () => {
      localStats.dropped += 1
      return returnValue
    }
  }

  return {
    adwId: null,
    sidecar: drop(null),
    startRun: drop(undefined),
    phaseTransition: drop({ phase_id: null }),
    reserveSeq: drop([]),
    updateSidecar: drop(false),
    bumpGateAttempt: drop(0),
    bumpStat: drop(false),
    emit: drop(false),
    mapSignalLogEntries: drop([]),
    endRun: drop(undefined),
    stats: () => ({ ...localStats }),
    statsSnapshot: () => ({ level: 'warn', message: 'emit stats: unavailable (openRun degraded)' }),
    installFinalizer: drop(undefined),
    dispose: drop(undefined),
  }
}

// ---------------------------------------------------------------------------
// openRun — creates or adopts the run sidecar; never throws.
// ---------------------------------------------------------------------------

export function openRun(opts = {}) {
  const stderr = opts.stderr || process.stderr
  try {
    return openRunInner(opts)
  } catch (err) {
    return buildDegradedEmitter(stderr, err)
  }
}

function openRunInner({
  stateDir,
  repoSlug,
  taskSlug,
  dbPath,
  nodeVersion,
  now = () => Date.now(),
  stderr = process.stderr,
  // TEST SEAM ONLY (never used by a real call site): overrides how emit()
  // obtains its ledger handle, so a test can inject a handle whose writers
  // throw or are otherwise degraded without touching the real ledger.
  _openLedger,
} = {}) {
  const ledgerDir = join(stateDir, 'ledger')
  const sidecarPath = join(ledgerDir, 'run.json')
  const lockPath = join(ledgerDir, 'run.lock')
  const requestedDbPath = dbPath || join(ledgerDir, 'ledger.db')
  const requestedJsonlPath = join(dirname(requestedDbPath), 'ledger.jsonl')

  secureMkdirSync(ledgerDir)

  const localStats = { ...ZERO_STATS }
  let lastFlushedStats = { ...ZERO_STATS }
  // Module-scoped (not per-instance) guard — see the module-scoped state
  // comment above: every OTHER emitter this process ever opens shares this
  // same flag, so N emitters each independently hitting a facade failure
  // (a lock give-up, a sidecar identity mismatch, a reserveSeq/bumpStat/emit
  // failure, ...) still produce at most one total stderr line for the whole
  // process, never one each (M4 residual, round 3).
  function noteStderrOnce(line) {
    if (facadeFailureNoticeWritten) return
    facadeFailureNoticeWritten = true
    try {
      stderr.write(`${line}\n`)
    } catch {
      // Best-effort: a broken stderr sink must not itself become a throw.
    }
  }

  function initialSidecar(adwId, nowMs) {
    return {
      adw_id: adwId,
      repo_slug: repoSlug,
      task_slug: taskSlug,
      db_path: requestedDbPath,
      jsonl_path: requestedJsonlPath,
      created_at: isoMs(nowMs),
      run_started: false,
      run_ended: false,
      phase: {
        name: null, seq: null, phase_id: null, started_at: null,
      },
      seq: {
        event: { next: 1, reserved_through: 0 },
        phase: { next: 1, reserved_through: 0 },
      },
      gate_attempts: {},
      heartbeats: {},
      billed: {
        input: null, output: null, cache_write: null, cache_read: null,
      },
      stats: { ...ZERO_STATS },
      dispatches: {},
    }
  }

  // create-or-adopt happens INSIDE the run lock — the ONLY safe place this
  // check-then-act can live (conventions.md 2026-08-02). An unlocked read
  // here is exactly the bug this round exists to fix: two racing callers
  // both see "no run yet" and mint two different adw_ids sharing one seq
  // counter.
  function createOrAdoptSidecar() {
    const holder = acquireLock(lockPath, now)
    if (!holder) return null
    try {
      const existing = readJsonOrNull(sidecarPath)
      if (existing && existing.adw_id) return existing
      const candidate = initialSidecar(randomUUID(), now())
      const created = createExclusive(sidecarPath, candidate)
      return created ? candidate : (readJsonOrNull(sidecarPath) || candidate)
    } finally {
      releaseLock(lockPath, holder)
    }
  }

  const sidecar = createOrAdoptSidecar()
  if (!sidecar) {
    localStats.lock_giveups += 1
    noteStderrOnce(`emit: lock give-up during sidecar create-or-adopt at ${lockPath}`)
    return buildDegradedEmitter(stderr, new Error('lock give-up during sidecar create-or-adopt'))
  }
  const adwId = sidecar.adw_id

  // S6: the ADOPTED sidecar's db_path/jsonl_path win over whatever this
  // call locally resolved — otherwise two verbs invoked with different
  // DEVTEAM_LEDGER_DB values could share one adw_id/seq space while writing
  // to two different databases, silently.
  let effectiveDbPath = requestedDbPath
  let effectiveJsonlPath = requestedJsonlPath
  if (sidecar.db_path && sidecar.db_path !== requestedDbPath) {
    localStats.dropped += 1
    noteStderrOnce(`emit: adopted sidecar's db_path (${sidecar.db_path}) differs from this call's dbPath (${requestedDbPath}) — using the adopted path`)
    effectiveDbPath = sidecar.db_path
    effectiveJsonlPath = sidecar.jsonl_path || join(dirname(effectiveDbPath), 'ledger.jsonl')
  }

  // Relays the ledger's OWN degraded-notice stderr line through a
  // module-scoped (not per-openRun) once-guard: two emitters opened by this
  // SAME process must still produce at most one relayed line for the whole
  // process lifetime, never one each (M4).
  function ledgerStderrRelay(chunk) {
    if (ledgerDegradedNoticeRelayed) return true
    ledgerDegradedNoticeRelayed = true
    try {
      stderr.write(chunk)
    } catch {
      // Best-effort.
    }
    return true
  }

  const openLedgerFn = _openLedger
    || (() => openLedger({
      dbPath: effectiveDbPath,
      jsonlPath: effectiveJsonlPath,
      nodeVersion,
      now,
      stderr: { write: ledgerStderrRelay },
    }))

  // M4: cache ONE ledger handle per emitter INSTANCE — opened lazily on
  // first real use, reused across every emit() call, closed on
  // dispose()/endRun(). Opening fresh per emission both re-triggers
  // ledger.mjs's open+migrate work on every single call AND defeats
  // ledger.mjs's per-HANDLE degraded-notice guard (per-emission handles
  // meant per-emission stderr lines).
  let cachedLedgerHandle = null
  // VISIBILITY SEAM: ledger.mjs's own mirror() helper deliberately never
  // rethrows a mirror-write failure (see ledger.mjs:10-13, the
  // MIRROR-NEVER-AUTHORITY invariant) — it only increments the handle's own
  // stats().mirror_errors. Left unchecked, that means a real sqlite write
  // genuinely lost under contention (e.g. SQLITE_BUSY exhausting
  // busy_timeout) returns NORMALLY from recordEvent/etc., so emit()'s own
  // try/catch below never sees it and reports dropped: 0 even though a row
  // is gone from the mirror. lastMirrorErrors tracks the last OBSERVED value
  // of the handle's own counter so any INCREASE across an emit() call — a
  // silent write loss that just happened — is folded into this facade's own
  // `dropped` counter (never a separate field: the six-field stats() shape
  // is part of this module's own tested contract, and "a write this facade
  // asked for did not durably land" is squarely what `dropped` already
  // means).
  let lastMirrorErrors = null
  function ledgerHandle() {
    if (!cachedLedgerHandle) cachedLedgerHandle = openLedgerFn()
    return cachedLedgerHandle
  }
  function absorbMirrorErrors(handle) {
    if (!handle || typeof handle.stats !== 'function') return
    const { mirror_errors: mirrorErrors } = handle.stats()
    if (typeof mirrorErrors !== 'number') return
    if (lastMirrorErrors === null) {
      lastMirrorErrors = mirrorErrors
      return
    }
    const delta = mirrorErrors - lastMirrorErrors
    if (delta > 0) {
      localStats.dropped += delta
      noteStderrOnce(`emit: detected ${delta} silent mirror-write failure(s) via ledger stats().mirror_errors — counted as dropped`)
    }
    lastMirrorErrors = mirrorErrors
  }
  function closeLedgerHandle() {
    if (cachedLedgerHandle) {
      try {
        cachedLedgerHandle.close()
      } catch {
        // Best-effort.
      }
      cachedLedgerHandle = null
    }
  }

  // Locked read-modify-write: acquires the bounded lock, hands the CURRENT
  // on-disk sidecar to `mutateFn`, persists whatever it returns (merging
  // this instance's OUTSTANDING stats delta additively into the sidecar's
  // cumulative stats, never overwriting another process's already-recorded
  // counts — S3), then releases. Never does ledger I/O — that always
  // happens after the returned `{ ok, result }` unwinds this call.
  //
  // M2: fails CLOSED. If the locked read doesn't yield a parseable sidecar
  // carrying THIS run's adw_id, this gives up and returns { ok: false } —
  // it never synthesizes a fresh initialSidecar() here, which would rewind
  // seq to 1 and wipe phase/billed/stats (a DUPLICATE, exactly what ADR-027
  // exists to prevent). initialSidecar() is reachable ONLY from the
  // genuine create path inside createOrAdoptSidecar above.
  function withLock(mutateFn) {
    const holder = acquireLock(lockPath, now)
    if (!holder) {
      localStats.lock_giveups += 1
      noteStderrOnce(`emit: lock give-up acquiring ${lockPath}`)
      return { ok: false }
    }
    try {
      const draft = readJsonOrNull(sidecarPath)
      if (!draft || draft.adw_id !== adwId) {
        localStats.dropped += 1
        noteStderrOnce('emit: sidecar missing or identity mismatch under lock — refusing to synthesize a fresh counter set')
        return { ok: false }
      }
      const result = mutateFn(draft)
      if (!draft.stats || typeof draft.stats !== 'object') draft.stats = { ...ZERO_STATS }
      for (const key of STAT_FIELDS) {
        const delta = localStats[key] - lastFlushedStats[key]
        const base = Number.isFinite(draft.stats[key]) ? draft.stats[key] : 0
        draft.stats[key] = base + delta
      }
      lastFlushedStats = { ...localStats }
      replaceLocked(sidecarPath, draft)
      return { ok: true, result }
    } finally {
      releaseLock(lockPath, holder)
    }
  }

  function reserveSeq(kind, n = 1) {
    try {
      if ((kind !== 'event' && kind !== 'phase') || !Number.isInteger(n) || n < 1) {
        // Mirrors the oversized-n path below: an invalid n (0, negative,
        // fractional, NaN, Infinity, a string, null, ...) is a counted drop,
        // never a silent no-op (should-fix, round 3).
        localStats.dropped += 1
        noteStderrOnce(`emit: reserveSeq refused an invalid request (kind=${JSON.stringify(kind)}, n=${JSON.stringify(n)})`)
        return []
      }
      if (n > MAX_SEQ_RESERVE_N) {
        localStats.dropped += 1
        noteStderrOnce(`emit: reserveSeq refused an oversized range request (n=${n} > ${MAX_SEQ_RESERVE_N})`)
        return []
      }
      const { ok, result } = withLock((draft) => {
        const start = draft.seq[kind].next
        draft.seq[kind].next = start + n
        // seq is MONOTONE, NOT GAPLESS: persisting reserved_through here,
        // before any emission, means a crash or a later drop leaves a GAP
        // (never a duplicate) — safe because readers never infer a missing
        // row from a numbering gap (see the module header).
        draft.seq[kind].reserved_through = start + n - 1
        return Array.from({ length: n }, (_, i) => start + i)
      })
      return ok ? result : []
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: reserveSeq failed unexpectedly: ${err && err.message}`)
      return []
    }
  }

  function updateSidecar(patchFn) {
    try {
      const { ok } = withLock((draft) => {
        patchFn(draft)
        return true
      })
      return !!ok
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: updateSidecar failed unexpectedly: ${err && err.message}`)
      return false
    }
  }

  // S2: the explicit mutator for the three counters (resolution_missing,
  // resolution_ambiguous, payload_keys_dropped) that otherwise have no way
  // to be incremented. `name` is checked against a closed enum — never an
  // arbitrary property write — so a hostile or accidental name can't
  // collide with anything or reach a prototype.
  function bumpStat(name, n = 1) {
    try {
      if (!BUMPABLE_STATS.has(name) || !Number.isInteger(n) || n < 1) {
        localStats.dropped += 1
        noteStderrOnce('emit: bumpStat given an invalid stat name or amount — dropped')
        return false
      }
      localStats[name] += n
      const { ok } = withLock(() => true)
      return !!ok
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: bumpStat failed unexpectedly: ${err && err.message}`)
      return false
    }
  }

  function bumpGateAttempt(gateName) {
    try {
      if (typeof gateName !== 'string' || !gateName || FORBIDDEN_GATE_NAMES.has(gateName)) {
        localStats.dropped += 1
        noteStderrOnce('emit: bumpGateAttempt given an invalid gate name — dropped')
        return 0
      }
      const { ok, result } = withLock((draft) => {
        if (!draft.gate_attempts || typeof draft.gate_attempts !== 'object') draft.gate_attempts = {}
        const current = Object.hasOwn(draft.gate_attempts, gateName) ? draft.gate_attempts[gateName] : 0
        const next = current + 1
        draft.gate_attempts[gateName] = next
        return next
      })
      return ok ? result : 0
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: bumpGateAttempt failed unexpectedly: ${err && err.message}`)
      return 0
    }
  }

  // emit(fn): reuses this instance's cached ledger handle, runs
  // fn(handle, nextSeq) — swallowing EVERY throw (a throwing ledger writer,
  // a throwing handle open, a seq-reservation give-up surfaced through
  // nextSeq) and counting it as a dropped emission rather than letting it
  // escape. `nextSeq(kind)` is a convenience bound to this same instance's
  // reserveSeq — fn must never fall back to an omitted seq (that would
  // silently re-enable ledger.mjs's own single-process allocator and
  // reintroduce the exact collision this module exists to prevent), so a
  // give-up here aborts the whole emission.
  function emit(fn) {
    try {
      const handle = ledgerHandle()
      const nextSeq = (kind) => {
        const [v] = reserveSeq(kind, 1)
        if (v === undefined) {
          throw new Error(`emit: seq reservation gave up for kind '${kind}'`)
        }
        return v
      }
      fn(handle, nextSeq)
      localStats.emitted += 1
      absorbMirrorErrors(handle)
      return true
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: emission dropped: ${err && err.message}`)
      return false
    }
  }

  // S7: the "already started" decision happens INSIDE the same lock
  // acquisition that marks `run_started` — never an unlocked read followed
  // by a separate emit/write, which would let two racing callers both see
  // "not started" and both emit startSession.
  function startRun() {
    try {
      const { ok, result } = withLock((draft) => {
        if (draft.run_started) return { alreadyStarted: true }
        draft.run_started = true
        return { alreadyStarted: false }
      })
      if (!ok) return
      if (result.alreadyStarted) return
      emit((handle) => {
        handle.startSession({
          adw_id: adwId, repo_slug: repoSlug, task_slug: taskSlug, started_at: isoMs(now()),
        })
      })
      phaseTransition('planning')
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: startRun failed unexpectedly: ${err && err.message}`)
    }
  }

  // phaseTransition(name): a no-op when already in `name` (checked INSIDE
  // the lock, so two callers racing the same target name never both
  // reserve a seq or both emit a phase row); otherwise reserves a seq for
  // the new phase and marks the sidecar's phase pointer eagerly — still
  // inside the same critical section, still with NO ledger I/O in it —
  // before releasing the lock and only THEN calling endPhase/startPhase.
  function phaseTransition(name) {
    try {
      const startedAt = isoMs(now())
      const { ok, result } = withLock((draft) => {
        if (draft.phase.name === name) {
          return { noop: true, phaseId: draft.phase.phase_id }
        }
        const prevPhase = { ...draft.phase }
        const start = draft.seq.phase.next
        draft.seq.phase.next = start + 1
        draft.seq.phase.reserved_through = start
        // Eagerly mark the pointer as already-transitioned (phase_id still
        // explicit null, never omitted, until the ledger write below
        // resolves it) so a second, concurrent caller targeting the SAME
        // name sees the no-op path above rather than double-reserving.
        draft.phase = {
          name, seq: start, phase_id: null, started_at: startedAt,
        }
        return { noop: false, prevPhase, newSeq: start }
      })
      if (!ok) return { phase_id: null }
      if (result.noop) return { phase_id: result.phaseId }

      const { prevPhase, newSeq } = result
      let phaseId = null
      emit((handle) => {
        if (prevPhase.name != null) {
          handle.endPhase({ adw_id: adwId, seq: prevPhase.seq, status: 'ok' })
        }
        phaseId = handle.startPhase({
          adw_id: adwId, name, seq: newSeq, started_at: startedAt,
        })
      })
      // Compare-and-set write-back (round 3 Must-fix): only install the
      // resolved phase_id if the sidecar's phase pointer is STILL the one
      // this call installed eagerly above (draft.phase.name === name &&
      // draft.phase.seq === newSeq) at the moment this write-back finally
      // runs. If a concurrent phaseTransition's ledger I/O landed and its
      // OWN write-back already superseded this pointer (moved name/seq on)
      // while this call's endPhase/startPhase were in flight, this call's
      // write-back must be a no-op — a blind overwrite here would silently
      // REWIND the phase pointer to this call's now-stale value, producing
      // a duplicate phase row and a duplicated endPhase call at a stale seq.
      updateSidecar((draft) => {
        if (draft.phase && draft.phase.name === name && draft.phase.seq === newSeq) {
          draft.phase = {
            name, seq: newSeq, phase_id: phaseId, started_at: startedAt,
          }
        }
        // else: a newer transition already superseded this one — no-op.
      })
      return { phase_id: phaseId }
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: phaseTransition failed unexpectedly: ${err && err.message}`)
      return { phase_id: null }
    }
  }

  // S7: reads the phase pointer AND decides whether this is the first
  // (non-duplicate) endRun call INSIDE the same lock acquisition that marks
  // `run_ended` — so a second endRun call (a normal teardown racing a
  // finalizer, say) can never double-emit endSession.
  function endRun({ status } = {}) {
    try {
      if (status === 'fail') {
        // Reserved for ledger.mjs's own finalizer — the only writer that
        // can honestly claim the run died. Never emitted from a normal
        // endRun call.
        localStats.dropped += 1
        noteStderrOnce('emit: endRun refuses status "fail" — reserved for the ledger finalizer')
        return
      }
      if (!SESSION_STATUSES.includes(status)) {
        localStats.dropped += 1
        noteStderrOnce('emit: endRun given an unrecognized status — dropped')
        return
      }
      const { ok, result } = withLock((draft) => {
        if (draft.run_ended) return { alreadyEnded: true }
        draft.run_ended = true
        return {
          alreadyEnded: false,
          phaseSnapshot: draft.phase && draft.phase.name != null ? { ...draft.phase } : null,
          billedSnapshot: draft.billed ? { ...draft.billed } : null,
        }
      })
      if (!ok) return
      if (result.alreadyEnded) return
      const { phaseSnapshot, billedSnapshot } = result
      emit((handle) => {
        if (phaseSnapshot) {
          handle.endPhase({ adw_id: adwId, seq: phaseSnapshot.seq, status: 'ok' })
        }
        handle.endSession({
          adw_id: adwId,
          status,
          billed_input_tokens: billedSnapshot ? billedSnapshot.input : null,
          billed_output_tokens: billedSnapshot ? billedSnapshot.output : null,
          billed_cache_write_tokens: billedSnapshot ? billedSnapshot.cache_write : null,
          billed_cache_read_tokens: billedSnapshot ? billedSnapshot.cache_read : null,
        })
      })
      closeLedgerHandle()
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: endRun failed unexpectedly: ${err && err.message}`)
    }
  }

  function mapSignalLogEntries(entries, { levels, messageMaxChars } = {}) {
    try {
      // S8: an omitted/invalid cap or level set fails SAFE — drop-and-count
      // the whole batch rather than silently passing content through
      // unbounded or under an unclamped level.
      const levelsValid = Array.isArray(levels) && levels.length > 0
      const maxCharsValid = Number.isInteger(messageMaxChars) && messageMaxChars >= 0
      if (!levelsValid || !maxCharsValid) {
        localStats.dropped += Array.isArray(entries) ? entries.length : 0
        noteStderrOnce('emit: mapSignalLogEntries given an invalid levels array or messageMaxChars — dropping the batch rather than passing through unbounded')
        return []
      }
      const out = []
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        // A non-string message is DROPPED and counted — never .slice()d:
        // inside a never-throw facade, calling .slice() on a non-string
        // would throw a TypeError that this same try/catch would then
        // silently swallow for the WHOLE batch, not just this one entry.
        if (!entry || typeof entry.message !== 'string') {
          localStats.dropped += 1
          continue
        }
        // Mirrors ladder.mjs:719 exactly — one shared enum, passed in by
        // the caller, never a second one defined here.
        const level = levels.includes(entry.level) ? entry.level : 'progress'
        // Strip AND cap: sanitization bounds content, capping bounds
        // volume — two distinct surfaces (conventions.md 2026-08-08).
        const message = stripControlAndAnsi(entry.message).slice(0, messageMaxChars)
        // Nothing else from the entry is forwarded (PAYLOAD_KEYS.log is
        // exactly ['level', 'message']).
        out.push({ level, message })
      }
      return out
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: mapSignalLogEntries failed unexpectedly: ${err && err.message}`)
      return []
    }
  }

  function statsSnapshot() {
    try {
      const s = { ...localStats }
      const anyDrop = [
        s.dropped, s.lock_giveups, s.resolution_ambiguous, s.resolution_missing, s.payload_keys_dropped,
      ].some((n) => n > 0)
      return {
        level: anyDrop ? 'warn' : 'info',
        message: `emit stats: emitted=${s.emitted} dropped=${s.dropped} lock_giveups=${s.lock_giveups} `
          + `resolution_ambiguous=${s.resolution_ambiguous} resolution_missing=${s.resolution_missing} `
          + `payload_keys_dropped=${s.payload_keys_dropped}`,
      }
    } catch {
      return { level: 'warn', message: 'emit stats: unavailable' }
    }
  }

  // S1: delegates to ledger.mjs's OWN installFinalizer rather than
  // hand-rolling a signal handler — 'fail' is reserved for that finalizer
  // (the only writer that can honestly claim the run died abnormally), and
  // ledger.mjs's implementation already re-raises correctly and consults
  // its in-process registry rather than the (optional) mirror.
  let finalizerHandle = null
  function installFinalizer() {
    try {
      if (finalizerHandle) return // opt-in, idempotent — never installed twice
      finalizerHandle = ledgerHandle().installFinalizer({ adw_id: adwId })
    } catch (err) {
      localStats.dropped += 1
      noteStderrOnce(`emit: installFinalizer failed unexpectedly: ${err && err.message}`)
    }
  }

  function dispose() {
    if (finalizerHandle) {
      try {
        finalizerHandle.uninstall()
      } catch {
        // Best-effort.
      }
      finalizerHandle = null
    }
    closeLedgerHandle()
  }

  return {
    adwId,
    sidecar: () => {
      const current = readJsonOrNull(sidecarPath) || sidecar
      return current === null ? null : deepFreeze(structuredClone(current))
    },
    startRun,
    phaseTransition,
    reserveSeq,
    updateSidecar,
    bumpGateAttempt,
    bumpStat,
    emit,
    mapSignalLogEntries,
    endRun,
    stats: () => ({ ...localStats }),
    statsSnapshot,
    installFinalizer,
    dispose,
  }
}

// TEST SEAM ONLY (never used by a real call site): resets every
// module-scoped stderr once-guard to its initial (never-written) state. A
// real process never calls this — the guards exist precisely to hold for
// the whole process lifetime — but a test SUITE sharing one process across
// many otherwise-independent scenarios needs a way to isolate them from one
// another (round 3, M4 residual).
export function _resetNoticeGuardsForTest() {
  ledgerDegradedNoticeRelayed = false
  facadeFailureNoticeWritten = false
  degradedOpenRunNoticeWritten = false
}
