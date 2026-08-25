// crew/tree-fingerprint.mjs — what a checkout looked like at a stated moment,
// and what changed since.
//
// WHY THIS EXISTS (#621): nothing detects a checkout that changes AFTER
// teardown proved its seats dead. On b175-paneusage a seat was still alive
// during a hand recovery and applied one of its own gate kill-mutations to the
// working tree; it merged correctly by ordering luck alone, and surfaced only
// because `git worktree remove` refused on a dirty tree. The scope gate cannot
// see this: it adjudicates PATHS, not content, and it runs before a run, never
// during a recovery.
//
// THREE ANSWERS, NEVER TWO: unchanged, changed, and could-not-measure are
// reported separately. A tree that could not be measured is NEVER reported as
// unchanged — that collapse is the defect family this module exists to not
// have, and compareFingerprints guards it before it looks at anything else.
//
// AN ENTRY DESCRIBES A NODE, NOT DEREFERENCED BYTES. `readFileSync` alone
// FOLLOWS a symlink and records neither the executable bit nor the node kind,
// so `chmod +x` and a symlink retargeted to an equal-content target both come
// back `unchanged` while `git diff --name-only` names them (measured). Every
// entry therefore carries a kind discriminator, and for a regular file the
// executable bit beside the payload digest, and for a symlink the digest of its
// LINK TEXT read with readlinkSync — never the bytes it points at.
//
// READ-ONLY BY CONSTRUCTION: the only subprocess is `git`, and only
// `rev-parse` and `ls-files`, both of which read. `git status` is deliberately
// not used: it refreshes and may WRITE .git/index, and a fingerprint that
// writes into the tree it is measuring is its own false positive.
//
// LIBRARY ONLY: importing performs no I/O, and there is no CLI verb. The
// comparison is a callable check (checkRecordedTree); a verb would need the
// usage tables and dispatch docs, which are outside this lane's fence.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const FINGERPRINT_SCHEMA = 2
export const FINGERPRINT_FILE = 'tree-fingerprint.json'

export const FINGERPRINT_OUTCOMES = Object.freeze({
  unchanged: 'unchanged',
  changed: 'changed',
  unmeasurable: 'unmeasurable',
})

export const UNMEASURABLE_CAUSES = Object.freeze({
  no_checkout: 'no checkout path was supplied, so there was nothing to measure — unmeasured, never a quiet tree',
  missing: 'the checkout path does not exist, so its working state could not be read — unmeasured, never a quiet tree',
  not_a_checkout: 'the path exists but is not a git checkout, so the tracked-and-untracked enumeration this fingerprint rests on is unavailable',
  git_failed: 'the read-only git enumeration failed, so the file list this fingerprint covers is unknown',
  unreadable: 'git listed a path this fingerprint could not read, so the tree was only partly measured — a partial measurement is not a measurement',
  unsupported_node: 'git listed a node that is neither a regular file nor a symlink, so this fingerprint has no value that describes it — an undescribed node is not a measured one',
  checkout_mismatch: 'the two fingerprints name different checkouts, so nothing about either tree follows from comparing them',
})

// The named reasons a fingerprint is WITHHELD rather than taken. A fingerprint
// is a BASELINE, and a baseline is only worth taking once everything that could
// write into the checkout was proved dead.
export const FINGERPRINT_WITHHELD = Object.freeze({
  unmeasured: 'the teardown sweep measured no seat at all, so nothing about this crew\'s writers is known — a fingerprint taken here would licence a later comparison to claim the tree was quiet when nobody ever looked',
  seats_unproven: 'the pane sweep measured seats but did not prove every one of them dead, so a writer may still be inside this checkout — a fingerprint of a tree something may still be writing is not a baseline',
  writer_unproven: 'the pane seats were proved dead but a seat ROOT or a descendant group was not, or the sweep summary cannot distinguish an unresolved row from a receipt failure — an unresolved OS process is still a checkout writer, and a proven pane tally says nothing about it',
})

// roots: settleSeatRoots' summary (crew/seat-io.mjs:580-582). Any of these is a
// root this teardown did not prove dead.
export const ROOT_UNPROVEN_KEYS = Object.freeze(['failed', 'unproven', 'unidentified'])
// descendants: reclaimDescendants' summary (crew/seat-io.mjs:693-699). Any of
// these is a group whose death was not measured.
export const DESCENDANT_UNPROVEN_KEYS = Object.freeze(['live', 'identity_refused', 'probe_unknown', 'incomplete'])

function gitRead(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) return { ok: false, detail: result.error.message }
  if (result.status !== 0) return { ok: false, detail: String(result.stderr || '').trim() || `git ${args[0]} exited ${result.status}` }
  return { ok: true, stdout: result.stdout }
}

function unmeasured(checkout, at, cause, detail = null) {
  return { measured: false, checkout: checkout ?? null, at, cause, detail }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

// The value that describes ONE node. A string, so comparison stays a single
// !== and the written record stays readable:
//   file:-:<sha256 of the bytes>      a regular file, not executable
//   file:x:<sha256 of the bytes>      a regular file, executable
//   symlink:<sha256 of the link text> a symlink, never followed
// `{ absent: true }` is a tracked path that is not on disk — a MEASURED absence,
// which is how a deletion becomes legible. `{ cause }` is a failure to describe.
function describeNode(checkout, path) {
  const full = join(checkout, path)
  let st
  try { st = lstatSync(full) } catch (err) {
    // ENOENT on lstat is an ABSENCE, and an absence is measured: git listed a
    // tracked path that is not on disk. Anything else means the tree was only
    // partly seen, which is not a measurement.
    if (err.code === 'ENOENT') return { absent: true }
    return { cause: UNMEASURABLE_CAUSES.unreadable, detail: `${path}: ${err.message}` }
  }
  if (st.isSymbolicLink()) {
    // readlinkSync reads the LINK TEXT and does not follow it, so a broken
    // symlink is measured as the symlink it is rather than raising ENOENT and
    // being mistaken for a deletion.
    try { return { value: `symlink:${sha256(readlinkSync(full))}` } }
    catch (err) { return { cause: UNMEASURABLE_CAUSES.unreadable, detail: `${path}: ${err.message}` } }
  }
  if (st.isFile()) {
    // The executable bit is metadata git tracks (100644 vs 100755); the payload
    // digest alone cannot see a chmod.
    const exec = (st.mode & 0o111) !== 0 ? 'x' : '-'
    try { return { value: `file:${exec}:${sha256(readFileSync(full))}` } }
    catch (err) {
      if (err.code === 'ENOENT') return { absent: true }
      return { cause: UNMEASURABLE_CAUSES.unreadable, detail: `${path}: ${err.message}` }
    }
  }
  // A fifo, socket, device or anything else git managed to list: there is no
  // value here that describes it, and quietly omitting it would report a
  // partly-seen tree as a measured one.
  return { cause: UNMEASURABLE_CAUSES.unsupported_node, detail: `${path}: mode ${st.mode.toString(8)}` }
}

// A fingerprint of every path git can see in the checkout — tracked plus
// untracked-and-not-ignored — keyed by repo-relative path, valued by the node
// description above. A tracked file that is absent from disk is absent from
// `entries`, which is exactly how a deletion becomes legible.
export function fingerprintTree(checkout, deps = {}) {
  const now = deps.now || (() => new Date().toISOString())
  const at = now()
  if (!checkout) return unmeasured(checkout, at, UNMEASURABLE_CAUSES.no_checkout)
  if (!existsSync(checkout)) return unmeasured(checkout, at, UNMEASURABLE_CAUSES.missing)
  const isRepo = gitRead(checkout, ['rev-parse', '--git-dir'])
  if (!isRepo.ok) return unmeasured(checkout, at, UNMEASURABLE_CAUSES.not_a_checkout, isRepo.detail)
  const listed = gitRead(checkout, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (!listed.ok) return unmeasured(checkout, at, UNMEASURABLE_CAUSES.git_failed, listed.detail)
  const head = gitRead(checkout, ['rev-parse', 'HEAD'])
  const paths = String(listed.stdout).split('\0').filter(Boolean).sort()
  const entries = {}
  for (const path of paths) {
    const node = describeNode(checkout, path)
    if (node.cause) return unmeasured(checkout, at, node.cause, node.detail)
    if (node.absent) continue
    entries[path] = node.value
  }
  return { measured: true, checkout, at, head: head.ok ? String(head.stdout).trim() : null, entries }
}

export function compareFingerprints(before, after) {
  // The guard that must come FIRST and must never be widened: an unmeasured
  // side makes every downstream comparison meaningless, and reporting it as
  // `unchanged` is precisely the collapse #621 exists to remove.
  if (!before?.measured || !after?.measured) {
    const side = !before?.measured ? 'before' : 'after'
    const source = side === 'before' ? before : after
    return {
      outcome: FINGERPRINT_OUTCOMES.unmeasurable,
      side,
      cause: source?.cause ?? UNMEASURABLE_CAUSES.no_checkout,
      detail: source?.detail ?? null,
      added: null, removed: null, modified: null, head_changed: null,
    }
  }
  if (before.checkout !== after.checkout) {
    return {
      outcome: FINGERPRINT_OUTCOMES.unmeasurable,
      side: 'both',
      cause: UNMEASURABLE_CAUSES.checkout_mismatch,
      detail: `${before.checkout} vs ${after.checkout}`,
      added: null, removed: null, modified: null, head_changed: null,
    }
  }
  const added = []
  const removed = []
  const modified = []
  for (const path of Object.keys(after.entries ?? {}).sort()) {
    if (!Object.hasOwn(before.entries ?? {}, path)) added.push(path)
    // The COMPLETE entry value, so a chmod or a symlink retarget lands here and
    // not in a false `unchanged`.
    else if (before.entries[path] !== after.entries[path]) modified.push(path)
  }
  for (const path of Object.keys(before.entries ?? {}).sort()) {
    if (!Object.hasOwn(after.entries ?? {}, path)) removed.push(path)
  }
  const headChanged = before.head === after.head ? null : { from: before.head ?? null, to: after.head ?? null }
  const outcome = added.length || removed.length || modified.length || headChanged
    ? FINGERPRINT_OUTCOMES.changed
    : FINGERPRINT_OUTCOMES.unchanged
  return { outcome, side: null, cause: null, detail: null, added, removed, modified, head_changed: headChanged }
}

// Did either OS-process sweep leave a writer unresolved? Returns null when both
// sweeps accounted for everything, otherwise the sentence naming what they did
// not. A proven PANE tally says nothing about a seat's root process or its
// descendant groups: settleSeatRoots skips an already-stamped root even when the
// stamp was `unproven` (crew/seat-io.mjs:595), and reclaimDescendants classifies
// a still-live root at crew/seat-io.mjs:758-759 and leaves its row `retryable`
// at crew/seat-io.mjs:842-843.
export function rootUnproven(roots) {
  if (!roots) return 'the seat-root settle produced no summary, so nothing about those OS writers was measured'
  for (const key of ROOT_UNPROVEN_KEYS) {
    const n = Number(roots[key]) || 0
    if (n > 0) return `seat roots report ${key}=${n}`
  }
  return null
}

export function descendantUnproven(descendants) {
  if (!descendants) return 'the descendant reclaim produced no summary, so nothing about those OS writers was measured'
  if (descendants.snapshot_ok !== true) return 'the descendant reclaim could not read a process snapshot, so its verdicts are unmeasured'
  for (const key of DESCENDANT_UNPROVEN_KEYS) {
    const n = Number(descendants[key]) || 0
    if (n > 0) return `descendant reclaim reports ${key}=${n}`
  }
  // A failed receipt alone does not logically disprove death, but this AGGREGATE
  // cannot establish that the receipt failed ALONE, so a baseline is withheld.
  // One row increments both counters while still naming a LIVE root: `live` is a
  // descendant-GROUP counter (crew/seat-io.mjs:756) and the root-alive branch
  // only sets a reason (crew/seat-io.mjs:758-759), `incomplete` needs a captured
  // group (crew/seat-io.mjs:844), and a failed emit increments `record_failed`
  // (crew/seat-io.mjs:837) beside `retryable` (crew/seat-io.mjs:841-843). So
  // `{records:1, retryable:1, record_failed:1, snapshot_ok:true}` is
  // INDISTINGUISHABLE from a dead zero-group root whose only failure was its
  // receipt, and subtracting receipts from retryable work would erase a live
  // root. Fail closed on the data that exists: ANY retryable row withholds the
  // baseline. This changes no teardown exit code and does not fix #601.
  const retryable = Number(descendants.retryable) || 0
  if (retryable > 0) return `descendant reclaim left ${retryable} row(s) retryable`
  return null
}

export function writerUnproven({ roots, descendants } = {}) {
  return rootUnproven(roots) || descendantUnproven(descendants) || null
}

// The gate on recording, as data rather than a condition buried in teardown:
// null means a fingerprint MAY be taken; anything else names why it was not.
export function fingerprintWithheld({ seats, seatsAbsent, roots, descendants } = {}) {
  if (seatsAbsent || !seats) return { cause: FINGERPRINT_WITHHELD.unmeasured, detail: seatsAbsent ?? null }
  if (seats.proven !== seats.seats) return { cause: FINGERPRINT_WITHHELD.seats_unproven, detail: `proven ${seats.proven} of ${seats.seats}` }
  const writer = writerUnproven({ roots, descendants })
  if (writer) return { cause: FINGERPRINT_WITHHELD.writer_unproven, detail: writer }
  return null
}

function recordPathFor(dirOrFile) {
  return String(dirOrFile).endsWith('.json') ? String(dirOrFile) : join(String(dirOrFile), FINGERPRINT_FILE)
}

// Written into the crew dir BEFORE the archive rename, so it travels with the
// durable record rather than being left behind beside a dir that no longer
// exists. `path` is this API's own contract: the absolute path as written. A
// caller that renames the directory afterwards owns rebasing it — teardownCore
// does exactly that, and the journal row it writes carries the archive-stable
// RELATIVE name instead.
export function recordTreeFingerprint(dir, checkout, meta = {}, deps = {}) {
  const fingerprint = (deps.fingerprintTree || fingerprintTree)(checkout, deps)
  const path = recordPathFor(dir)
  if (!fingerprint.measured) {
    return { recorded: false, path, absent: fingerprint.cause, fingerprint }
  }
  const record = {
    schema: FINGERPRINT_SCHEMA,
    task: meta.task ?? null,
    checkout,
    seats: meta.seats ?? null,
    roots: meta.roots ?? null,
    descendants: meta.descendants ?? null,
    fingerprint,
  }
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, path)
  return { recorded: true, path, file: FINGERPRINT_FILE, at: fingerprint.at, covered: Object.keys(fingerprint.entries).length }
}

export function readTreeFingerprint(dirOrFile) {
  const path = recordPathFor(dirOrFile)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// The callable check: what the recorded fingerprint said, what the tree says
// now, and the difference stated as a finding — which paths, against which
// record, taken at what time. It detects and reports; it never blocks, kills,
// reverts or deletes anything.
export function checkRecordedTree(dirOrFile, deps = {}) {
  const recordPath = recordPathFor(dirOrFile)
  const record = readTreeFingerprint(recordPath)
  const recorded = record?.fingerprint ?? null
  if (!recorded) {
    return {
      outcome: FINGERPRINT_OUTCOMES.unmeasurable,
      cause: UNMEASURABLE_CAUSES.missing,
      detail: `no recorded fingerprint at ${recordPath}`,
      record_path: recordPath, recorded_at: null, checkout: null,
      added: null, removed: null, modified: null, head_changed: null,
    }
  }
  const checkout = record.checkout ?? recorded.checkout ?? null
  const fresh = (deps.fingerprintTree || fingerprintTree)(checkout, deps)
  return {
    ...compareFingerprints(recorded, fresh),
    record_path: recordPath,
    recorded_at: recorded?.at ?? null,
    checkout,
  }
}
