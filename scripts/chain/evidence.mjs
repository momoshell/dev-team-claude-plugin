// Impure evidence layer for the B1 gates CLI (issue #28). Owns exactly two
// things: (a) baseline/change-set machinery (a fingerprint-dictionary
// baseline captured once per slice, and a three-way touched-set union
// computed against it at gate time), and (b) the validation-command runner
// (fd-backed spawnSync with synthesized 124/127 classification and a
// bounded tail read).
//
// Every failure mode in this file fails CLOSED — a rename desync, a
// -u-collapsed directory, a truncated status buffer or a swallowed git
// error must never silently report "clean". This file computes evidence;
// it never renders a check or a verdict (that is scripts/chain/gates.mjs,
// be-28-03, out of scope here).
//
// Import direction: chain -> cmux only. scripts/cmux/* must never import
// scripts/chain/*.
import { spawnSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, linkSync, unlinkSync, openSync, closeSync, statSync, readSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { assertValidationCommands, RefusalError } from '../cmux/resolve.mjs'

// EVIDENCE_ERROR_CODES is a frozen closed list (conventions.md 2026-08-01:
// "prefer structural impossibility to a test assertion, and a whitelist to
// a blacklist"). Every throw site in this file must use one of these.
export const EVIDENCE_ERROR_CODES = Object.freeze([
  'git_unavailable',
  'unborn_branch',
  'status_unparseable',
  'baseline_malformed',
  'baseline_exists',
])

// GATE_RUN_TIMEOUT_MS matches this repo's harness Bash ceiling discussion
// (A0/#24 set --max-block-s 570 against a 600000ms ceiling) so gates.mjs
// never has to invent its own default.
export const GATE_RUN_TIMEOUT_MS = Object.freeze(600000)

export class EvidenceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// git primitives. Every invocation is spawnSync with an argv array (never a
// shell string) — mirrors dispatch.mjs:493-507's gitOutput/gitOk discipline.
// Unlike dispatch.mjs:1917-1924's gitPorcelain, a swallowed git error here
// THROWS rather than degrading to null: a hard_fail check that cannot see
// the tree must never report clean.
// ---------------------------------------------------------------------------

export function gitAnchorSha(cwd) {
  // -c core.fsmonitor=: rev-parse resolves a ref against the object
  // database only (no lstat/worktree read), so an fsmonitor hook has
  // nothing to lie about here — added anyway for the same uniform
  // "never trust ambient repo config on a security-relevant git
  // invocation in this file" discipline the other primitives below apply,
  // at zero functional cost.
  const res = spawnSync('git', ['-c', 'core.fsmonitor=', 'rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' })
  if (res.error) {
    throw new EvidenceError('git_unavailable', `git rev-parse --verify HEAD failed to spawn: ${res.error.message}`)
  }
  // `git rev-parse --verify HEAD` exits 128 on an unborn branch (a fresh
  // `git init` with no commit yet) — classify it explicitly, never store
  // undefined as anchor_sha.
  if (res.status === 128) {
    throw new EvidenceError('unborn_branch', 'HEAD has no commits yet (unborn branch)')
  }
  if (res.status !== 0) {
    throw new EvidenceError('git_unavailable', `git rev-parse --verify HEAD exited ${res.status}: ${(res.stderr || '').trim()}`)
  }
  return res.stdout.trim()
}

export function statusSnapshot(cwd) {
  // --no-optional-locks: avoid index.lock contention with a concurrently
  // running coder worker. --porcelain=v1: pinned against a future git
  // default-format change. -z: NUL-delimited entries with no quoting or
  // escaping ambiguity to get wrong. -uall: the default status collapses an
  // untracked directory to `dir/`, hiding the filenames inside new
  // directories — a protected-path/scope check that cannot see filenames
  // inside new dirs FAILS OPEN. --ignored=matching: without it, a file that
  // matches a .gitignore rule (e.g. this repo's own `._*`/`*.swp` rules)
  // never appears in status output AT ALL, regardless of -uall — a write
  // under a protected prefix that happens to match an ignore rule would be
  // invisible to touchedPaths. Verified against real git: adding
  // --ignored=matching to this SAME invocation only adds `!!`-prefixed
  // entries for ignored-but-present paths; it does not change the shape or
  // presence of existing M/??/R/C entries. -c core.fsmonitor=: core.fsmonitor
  // (repo-local config, coder-writable — same threat model this file
  // already states for diff.renames below) lets an arbitrary hook script
  // claim "nothing changed" for any path; git TRUSTS that claim for any
  // index entry it has previously marked fsmonitor-valid and skips the lstat
  // this function depends on — a hard_fail check that cannot see the tree
  // must never report clean. Verified against a REAL fake-fsmonitor-hook
  // repro (see test/chain-evidence.test.mjs): with a hook unconditionally
  // answering "nothing changed", a tracked-file overwrite that had already
  // been fsmonitor-validated by a prior (lock-holding) status run is
  // reported as clean by plain `git status`; adding `-c core.fsmonitor=` to
  // THIS SAME invocation neutralizes the hook for this one call only (a -c
  // flag beats ambient repo config, same mechanism already relied on for
  // --no-renames below) and correctly restores the modification.
  const res = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignored=matching'],
    { cwd, encoding: 'buffer' },
  )
  if (res.error) {
    throw new EvidenceError('git_unavailable', `git status failed to spawn: ${res.error.message}`)
  }
  if (res.status !== 0) {
    const stderrText = res.stderr ? res.stderr.toString('utf8').trim() : ''
    throw new EvidenceError('git_unavailable', `git status exited ${res.status}: ${stderrText}`)
  }
  return parsePorcelainZ(res.stdout)
}

// parsePorcelainZ(buf) -> PorcelainEntry[]. Pure. Decodes the WHOLE buffer
// as UTF-8 exactly once before splitting on '\0' (NUL cannot appear inside
// valid UTF-8 path bytes) — splitting the raw Buffer on byte 0 and slicing
// at fixed offsets is the desync bug this function exists to avoid.
export function parsePorcelainZ(buf) {
  const text = buf.toString('utf8')
  if (text.length === 0) return []

  const tokens = text.split('\0')
  const last = tokens[tokens.length - 1]
  if (last !== '') {
    // -z output always ends with a NUL terminator; a non-empty final token
    // means the buffer was truncated mid-entry. A dropped entry here is a
    // path that would silently read as untouched — never drop it.
    throw new EvidenceError('status_unparseable', 'porcelain status buffer is truncated: missing trailing NUL terminator')
  }
  tokens.pop() // drop the terminator artifact

  const entries = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.length < 3 || token[2] !== ' ') {
      throw new EvidenceError('status_unparseable', `malformed porcelain entry: ${JSON.stringify(token)}`)
    }
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      // Rename/copy exception: `XY TO\0FROM\0` — TO first (reversed vs the
      // human `from -> to` display). Consuming exactly two tokens per entry
      // is what keeps the following ordinary entries from desyncing. Git
      // documents TWO rename/copy shapes: index-side (X=R/C, e.g. `R  `,
      // xy[0]) and worktree-side (X blank, Y=R/C, e.g. ` R `, xy[1] — e.g.
      // `mv` followed by `git add -N`). Pairing on xy[0] alone leaves the
      // worktree-side shape unpaired, which desyncs every entry after it.
      if (i + 1 >= tokens.length) {
        throw new EvidenceError('status_unparseable', 'rename/copy entry missing its FROM pair (truncated buffer)')
      }
      const from = tokens[i + 1]
      entries.push({ xy, path, from })
      i += 2
    } else {
      entries.push({ xy, path })
      i += 1
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Index-bit probe (assume-unchanged / skip-worktree). `git status` has NO
// flag that can override either CE_VALID (assume-unchanged, set via
// `git update-index --assume-unchanged <path>`) or CE_SKIP_WORKTREE
// (skip-worktree, set via `git update-index --skip-worktree <path>`) — a
// path with either bit set is invisible to `git status` entirely, regardless
// of -uall/--ignored=matching/anything else, so statusSnapshot alone can
// never see it. `git ls-files -v -z` is the only primitive that reports
// these bits at all: verified against real git, it emits one NUL-delimited
// "<letter> <path>" token per tracked path, where the letter is normally
// uppercase (H cached / S skip-worktree / M unmerged / R removed / C
// modified / K to-be-killed / ? other) and is LOWERCASED iff CE_VALID
// (assume-unchanged) is also set on that path — verified against real git
// with both bits stacked on the same path (assume-unchanged set on top of an
// already-skip-worktree path yields lowercase "s", not "S"). Detecting
// assume-unchanged is therefore a case check on the letter, never a
// hardcoded "h"; detecting skip-worktree is a case-insensitive comparison
// against "S", never a hardcoded "S" alone.
// ---------------------------------------------------------------------------

const LOWERCASE_INDEX_LETTERS = new Set(['h', 's', 'm', 'r', 'c', 'k'])

// INDEX_BIT_XY: a synthetic two-character marker stored in baseline.dirty for
// a path discovered ONLY via flaggedIndexPaths (never via statusSnapshot) —
// deliberately lowercase and never a real porcelain XY code (those are
// always uppercase letters, space, '?' or '!'), so it can never be confused
// with a genuine status entry by anything that later inspects baseline.dirty.
const INDEX_BIT_XY = 'ib'

// flaggedIndexPaths(cwd) -> Set<path> of every tracked path carrying either
// bit, repo-ROOT-relative POSIX (matches statusSnapshot's path shape).
// --full-name and the `:/` (root) pathspec are BOTH required: verified
// against real git, plain `git ls-files -v -z` with no pathspec and no
// --full-name is cwd-SCOPED (it lists only entries under the CURRENT
// directory, not the whole tree) AND emits paths relative to THAT cwd, not
// the repo root — a git invocation this file's own convention (see
// statusSnapshot/touchedPaths above) says must never happen for a
// security-relevant read. Two concrete failure modes verified against real
// git with cwd set to a non-toplevel subdirectory: (a) a flagged path under
// e.g. `.claude/dev-team/` came back as `dev-team/config.md` (missing the
// `.claude/` prefix), silently defeating PROTECTED_PREFIXES matching
// downstream; (b) with cwd inside an unrelated subdirectory with no flagged
// paths of its own, the result was `[]` — a full silent revert to the
// original fail-open this source exists to close. `--full-name` alone
// fixes the path SHAPE but not the cwd SCOPE restriction; the `:/` pathspec
// (git's "match from the top of the working tree" magic pathspec) is what
// restores full-tree coverage regardless of cwd. Both together reproduce
// exactly statusSnapshot's/touchedPaths's root-relative, whole-tree shape.
// Unlike
// statusSnapshot's THROW-on-truncation discipline for a git_unavailable/
// status_unparseable infrastructure failure (this file's own "a check that
// cannot see the tree must never report clean" rule), a path actually
// FOUND here is never turned into a throw — it is folded into the touched
// set unconditionally, the same non-throwing "opaque means touched, never
// hash-compared or excluded" discipline isDirectoryShapedPath already uses
// for a collapsed ignored directory. Reasoning: unlike a truncated buffer or
// an unborn branch (both are this tool's OWN infrastructure misbehaving),
// assume-unchanged/skip-worktree are ordinary, common, non-adversarial git
// habits (this repo's own review reproduced it via a routine
// keep-local-edits-untracked workflow) — throwing here would turn the
// ENTIRE evidence layer fail-closed (blocking every gate run) for any coder
// who has ever used either bit on any file anywhere in the checkout, even
// one wholly outside any protected prefix. Guaranteeing unconditional
// inclusion in the touched set closes the exact bypass the reviewer
// reproduced (a flagged path can never again read as "0 touched paths, all
// within scope") without that disproportionate blast radius.
export function flaggedIndexPaths(cwd) {
  // -c core.fsmonitor=: see this file's top-level fsmonitor-neutralization
  // discipline (statusSnapshot/touchedPaths). --full-name -- :/: see the
  // comment above this function — required for root-relative, whole-tree
  // output regardless of cwd.
  const res = spawnSync('git', ['-c', 'core.fsmonitor=', 'ls-files', '-v', '-z', '--full-name', '--', ':/'], { cwd, encoding: 'buffer' })
  if (res.error) {
    throw new EvidenceError('git_unavailable', `git ls-files -v failed to spawn: ${res.error.message}`)
  }
  if (res.status !== 0) {
    const stderrText = res.stderr ? res.stderr.toString('utf8').trim() : ''
    throw new EvidenceError('git_unavailable', `git ls-files -v exited ${res.status}: ${stderrText}`)
  }
  const text = res.stdout.toString('utf8')
  if (text.length === 0) return new Set()

  const tokens = text.split('\0')
  const last = tokens[tokens.length - 1]
  if (last !== '') {
    throw new EvidenceError('status_unparseable', 'ls-files -v buffer is truncated: missing trailing NUL terminator')
  }
  tokens.pop()

  const flagged = new Set()
  for (const token of tokens) {
    if (token.length < 2 || token[1] !== ' ') {
      throw new EvidenceError('status_unparseable', `malformed ls-files -v entry: ${JSON.stringify(token)}`)
    }
    const letter = token[0]
    const path = token.slice(2)
    const isAssumeUnchanged = LOWERCASE_INDEX_LETTERS.has(letter)
    const isSkipWorktree = letter.toUpperCase() === 'S'
    if (isAssumeUnchanged || isSkipWorktree) flagged.add(path)
  }
  return flagged
}

export function hashFileSha256(absPath) {
  let buf
  try {
    buf = readFileSync(absPath)
  } catch (err) {
    if (err && err.code === 'ENOENT') return null // staged deletion: no bytes on disk at this moment
    throw err
  }
  return createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------------------
// Baseline capture/persistence. The baseline is instance data this tool
// itself wrote (backend-notes.md 2026-08-05: "loader severity splits on
// asset provenance") — a malformed one is a TAMPER/CORRUPTION signal and
// throws; an ABSENT one returns null and the caller (gates.mjs) turns that
// into a hard_fail check.
// ---------------------------------------------------------------------------

// isDirectoryShapedPath(p) -> true for the collapsed-directory status shape
// that --ignored=matching introduces (a wholly-untracked ignored DIRECTORY
// is reported as a single trailing-slash path, e.g. `!! .claude/worktrees/`,
// rather than expanded to the individual files inside it — a shape -uall
// alone never produced). readFileSync on such a path throws EISDIR, not
// ENOENT, so every call site below must detect this SHAPE (the path itself)
// before ever attempting to hash it — never after, and never by inspecting
// a stored sha256 value (a directory's stored sha256 is null for the exact
// same reason a staged deletion's is: neither call site may distinguish the
// two by value, only by re-checking the path shape again downstream).
export function isDirectoryShapedPath(p) {
  return p.endsWith('/')
}

// hashStatusPath(cwd, p) -> hashFileSha256, EXCEPT a directory-shaped path
// (see isDirectoryShapedPath) is never handed to readFileSync at all — it is
// unconditionally recorded as sha256: null, never hash-compared later.
function hashStatusPath(cwd, p) {
  if (isDirectoryShapedPath(p)) return null
  return hashFileSha256(join(cwd, p))
}

export function captureBaseline({ cwd, reason }) {
  const anchor_sha = gitAnchorSha(cwd)
  const captured_at = new Date().toISOString()
  const entries = statusSnapshot(cwd)

  const dirty = {}
  for (const entry of entries) {
    dirty[entry.path] = { xy: entry.xy, sha256: hashStatusPath(cwd, entry.path) }
    if (entry.from) {
      dirty[entry.from] = { xy: entry.xy, sha256: hashStatusPath(cwd, entry.from) }
    }
  }

  // A path carrying assume-unchanged/skip-worktree is invisible to
  // statusSnapshot (see flaggedIndexPaths above) and therefore never enters
  // `dirty` via the loop above, no matter what its on-disk bytes are — the
  // "reverted" detection source (touchedPaths, source 3) can only rescue a
  // path that HAD a baseline.dirty entry to compare against, so it must be
  // captured here too. git itself refuses to report this path's true state,
  // but a real byte-for-byte hash is still obtainable directly against the
  // filesystem (independent of git's index) via hashFileSha256 — captured
  // as a real sha256 whenever the file exists on disk, so a later
  // comparison can still be meaningful for this path even though it isn't
  // for the TOUCHED determination itself.
  for (const p of flaggedIndexPaths(cwd)) {
    if (!(p in dirty)) {
      dirty[p] = { xy: INDEX_BIT_XY, sha256: hashFileSha256(join(cwd, p)) }
    }
  }

  return { anchor_sha, reason, captured_at, dirty }
}

// writeBaselineExclusive: writeFileSync(tmp) + linkSync(tmp, dest). EEXIST
// is the loser and throws — never existsSync-then-rename (conventions.md
// 2026-08-02: "concurrency-unsafe check-then-act is a defect class"). A
// second capture NEVER overwrites the first.
export function writeBaselineExclusive(path, baseline) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, JSON.stringify(baseline, null, 2))
  try {
    linkSync(tmp, path)
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new EvidenceError('baseline_exists', `baseline already exists at ${path}`)
    }
    throw err
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort tmp cleanup; the link (or its absence) is what matters
    }
  }
}

export function readBaseline(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null // absent baseline: caller turns this into a hard_fail check
    throw new EvidenceError('baseline_malformed', `baseline unreadable at ${path}: ${err.message}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new EvidenceError('baseline_malformed', `baseline unparseable at ${path}: ${err.message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EvidenceError('baseline_malformed', `baseline at ${path} is not a well-formed object`)
  }
  if (typeof parsed.anchor_sha !== 'string') {
    throw new EvidenceError('baseline_malformed', `baseline at ${path} is missing a string anchor_sha`)
  }
  if (typeof parsed.dirty !== 'object' || parsed.dirty === null || Array.isArray(parsed.dirty)) {
    throw new EvidenceError('baseline_malformed', `baseline at ${path} is missing an object dirty map`)
  }
  for (const [p, entry] of Object.entries(parsed.dirty)) {
    if (!entry || typeof entry !== 'object' || typeof entry.xy !== 'string' || !('sha256' in entry)) {
      throw new EvidenceError('baseline_malformed', `baseline at ${path} has a malformed dirty entry for ${JSON.stringify(p)}`)
    }
  }

  return parsed
}

// ---------------------------------------------------------------------------
// touchedPaths: the three-way union. Every path is repo-relative POSIX,
// matching how git emits them and how gates.mjs compares against a spec's
// files_in_scope — never absolutized here.
// ---------------------------------------------------------------------------

export function touchedPaths({ cwd, baseline }) {
  // --no-renames is pinned explicitly and MUST NOT be dropped. Git has
  // rename detection ON by default (diff.renames=true since git 2.9), and
  // `--name-only` with rename detection active prints ONLY the destination
  // path for a detected rename — the FROM path (e.g. a protected path
  // vacated by a committed `git mv`) never appears at all. --no-renames
  // makes git treat a rename as an ordinary delete+add pair, emitting BOTH
  // paths as separate entries — the only shape that keeps every touched
  // path visible (this tool only cares which paths were touched, never
  // whether two entries were "the same file"). Never rely on the checkout's
  // ambient `diff.renames` config instead of pinning this flag on the argv
  // line: that config is writable by the same coder agent this check exists
  // to police (e.g. `git config diff.renames false`, or worse `... copies`,
  // to try to defeat detection a different way) — same discipline as
  // statusSnapshot's pinned --no-optional-locks/--porcelain=v1/-z/-uall
  // flags above, never trust ambient repo state for a security-relevant git
  // invocation. FLAG-ORDER TRAP: git's argv parsing is last-flag-wins for
  // this family — a LATER -M/-C/--find-copies-harder appended to this SAME
  // argv array after --no-renames would silently re-enable rename/copy
  // detection and reopen this exact bug (verified against real git). Never
  // append such a flag after --no-renames on this line; if one is ever
  // needed it must come BEFORE --no-renames, never after. Also verified
  // against real git: --no-renames alone already fully covers the
  // copy-detection case too (a copy+delete fan-out under an ambient
  // `diff.renames=copies` config behaves identically to the rename case
  // above) — no separate copy-detection flag is needed here. -c
  // core.fsmonitor=: this diff compares two commits (anchor_sha..HEAD), not
  // the working tree, so an fsmonitor hook has no worktree lstat to lie
  // about here either — added anyway for the same uniform "never trust
  // ambient repo config on a security-relevant git invocation in this file"
  // discipline statusSnapshot/flaggedIndexPaths apply, at zero functional
  // cost, and to close off any future change to this call that DID start
  // consulting the worktree.
  const diffRes = spawnSync('git', ['-c', 'core.fsmonitor=', 'diff', '--no-renames', '--name-only', '-z', `${baseline.anchor_sha}..HEAD`], { cwd, encoding: 'buffer' })
  if (diffRes.error) {
    throw new EvidenceError('git_unavailable', `git diff failed to spawn: ${diffRes.error.message}`)
  }
  if (diffRes.status !== 0) {
    const stderrText = diffRes.stderr ? diffRes.stderr.toString('utf8').trim() : ''
    throw new EvidenceError('git_unavailable', `git diff exited ${diffRes.status}: ${stderrText}`)
  }
  const diffText = diffRes.stdout.toString('utf8')
  const committed = diffText.length ? diffText.split('\0').filter((p) => p.length > 0) : []

  const freshEntries = statusSnapshot(cwd)
  const freshPathSet = new Set()
  for (const entry of freshEntries) {
    freshPathSet.add(entry.path)
    if (entry.from) freshPathSet.add(entry.from)
  }

  // Source 2: fresh status paths, excluding any path present in
  // baseline.dirty whose current content matches what was captured — this
  // is a content comparison, never a path-membership diff, so a
  // baseline-dirty file left as the user's own untouched edit is correctly
  // excluded (case d), and a rename's TO and FROM are both included (case a).
  // A directory-shaped entry (see isDirectoryShapedPath) is NEVER
  // hash-compared here — it is unconditionally touched, checked BEFORE ever
  // consulting baseline.dirty[p], never excluded by a hash-equality check.
  const dirty = new Set()
  const ignored = new Set()
  for (const entry of freshEntries) {
    const candidates = entry.from ? [entry.path, entry.from] : [entry.path]
    for (const p of candidates) {
      if (isDirectoryShapedPath(p)) {
        dirty.add(p)
        if (entry.xy === '!!') ignored.add(p)
        continue
      }
      const baselineEntry = baseline.dirty[p]
      if (baselineEntry && hashFileSha256(join(cwd, p)) === baselineEntry.sha256) {
        continue // unchanged from baseline capture: not touched
      }
      dirty.add(p)
      if (entry.xy === '!!') ignored.add(p)
    }
  }

  // Source 3: baseline-dirty paths that vanished from the fresh status
  // snapshot (git no longer sees them as different from HEAD) but whose
  // on-disk bytes differ from what baseline captured — a dirty edit that
  // was later reverted back to the committed bytes. Detectable only by
  // content comparison, never by path-membership diffing (case c). A
  // directory-shaped baseline entry is NEVER hash-compared here either — its
  // absence from freshPathSet already means its state changed, and it is
  // unconditionally counted as reverted rather than silently excluded by a
  // (necessarily null-vs-null) hash-equality check.
  const reverted = new Set()
  for (const [p, baselineEntry] of Object.entries(baseline.dirty)) {
    if (freshPathSet.has(p)) continue
    if (isDirectoryShapedPath(p)) {
      reverted.add(p)
      if (baselineEntry.xy === '!!') ignored.add(p)
      continue
    }
    if (hashFileSha256(join(cwd, p)) !== baselineEntry.sha256) {
      reverted.add(p)
      if (baselineEntry.xy === '!!') ignored.add(p)
    }
  }

  // Source 4: every path git ls-files -v currently reports with either the
  // assume-unchanged or skip-worktree bit set — UNCONDITIONALLY touched,
  // every run, regardless of what (if anything) statusSnapshot/baseline.dirty
  // say about it (see flaggedIndexPaths's own comment for why this is never
  // hash-compared, content-checked, or excluded: those two bits are exactly
  // git status's own blind spot, no per-path status flag can override them,
  // so a check gated on git status's own opinion of this path would just
  // reproduce the bypass this source exists to close).
  const indexBits = flaggedIndexPaths(cwd)

  const paths = new Set([...committed, ...dirty, ...reverted, ...indexBits])

  // sources.ignored: every touched path whose git status entry carries the
  // `!!` ignored marker (fix #2, be-28 QA round 2) — a SEPARATE,
  // clearly-labeled bucket so checkScopeCompliance (gates.mjs) can report an
  // ignored-but-not-protected touch as an advisory note rather than folding
  // it into the ordinary out-of-scope violation set. Always a SUBSET of
  // paths (never adds new touched paths on its own) and orthogonal to the
  // committed/dirty/reverted classification — an ignored path can appear in
  // either dirty or reverted AND in ignored simultaneously.
  return {
    paths: [...paths].sort(),
    sources: {
      committed: [...new Set(committed)].sort(),
      dirty: [...dirty].sort(),
      reverted: [...reverted].sort(),
      ignored: [...ignored].sort(),
      indexBits: [...indexBits].sort(),
    },
  }
}

// ---------------------------------------------------------------------------
// Validation-command runner.
// ---------------------------------------------------------------------------

function classifyExit({ res }) {
  if (res.error && res.error.code === 'ENOENT') {
    return { classified: 'missing_binary', code: 127, note: '' }
  }
  // ENOBUFS is unreachable by construction: stdio here is a single shared fd
  // (no pipe, no maxBuffer), so spawnSync never buffers output into memory.
  // Kept as a defensive branch anyway — a truncated or absent output on any
  // abnormal exit is evidence, never treated as "no failures".
  if (res.error && res.error.code === 'ENOBUFS') {
    return { classified: 'refused', code: null, note: 'ENOBUFS (unreachable by construction with fd-backed stdio; defensive branch)' }
  }
  // ETIMEDOUT is spawnSync's own AUTHORITATIVE signal that ITS `timeout`
  // option is what fired the kill — verified against this repo's targeted
  // Node version: spawnSync reliably sets res.error.code === 'ETIMEDOUT'
  // whenever its own `timeout` elapses, so this is the SOLE predicate for a
  // timeout classification. The previous heuristic (status === null &&
  // elapsedMs >= timeoutMs) is deliberately dropped: it can misfire on a
  // child killed by an unrelated external signal that merely lands at/after
  // timeoutMs, and (combined with a spawn error at timeoutMs: 0) could
  // misclassify a real spawn error as a timeout instead.
  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { classified: 'timeout', code: 124, note: '' }
  }
  // Any OTHER res.error (EACCES from a non-executable binary, EMFILE from a
  // fork failure, etc.) is a genuine spawn-level failure distinct from a
  // normal exit — falling through to the terminal exit branch below would
  // silently discard res.error.message and render as a bare, non-
  // informative exit with code null.
  if (res.error) {
    return { classified: 'spawn_error', code: null, note: res.error.message }
  }
  if (res.status === null && res.signal) {
    const signalNumber = osConstants.signals[res.signal]
    if (typeof signalNumber === 'number') {
      return { classified: 'signal', code: 128 + signalNumber, note: '' }
    }
    return { classified: 'signal_unknown', code: null, note: `unmapped signal name: ${res.signal}` }
  }
  return { classified: 'exit', code: res.status, note: '' }
}

function readTail(logPath) {
  const fd = openSync(logPath, 'r')
  try {
    const size = statSync(logPath).size
    const start = Math.max(0, size - 4000)
    const length = size - start
    const buf = Buffer.alloc(length)
    if (length > 0) {
      readSync(fd, buf, 0, length, start)
    }
    let offset = 0
    // Drop leading UTF-8 continuation bytes so a boundary that lands
    // mid-multi-byte-character never decodes to U+FFFD.
    while (offset < buf.length && (buf[offset] & 0xc0) === 0x80) {
      offset += 1
    }
    let sliced = buf.subarray(offset)
    // Only skip forward to the next newline when the read genuinely began
    // mid-line (start > 0, i.e. the file was actually truncated to the tail
    // window). When start === 0 the read includes the true beginning of the
    // file — there is no partial leading line to discard, and doing so
    // anyway would drop the single most important line (e.g. the real
    // assertion message) from every short/normal-sized log.
    if (start > 0) {
      const newlineIndex = sliced.indexOf(0x0a)
      if (newlineIndex !== -1) {
        sliced = sliced.subarray(newlineIndex + 1)
      }
    }
    return sliced.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function runValidationCommand({ cmd, cwd, timeoutMs, logPath }) {
  let argv
  try {
    // Deliberate divergence from resolve.mjs:322-325's whole-set refusal:
    // that refuses the ENTIRE set on the first offender because a
    // partially-expanded permission-rule set is a silently narrower lane.
    // Here we call assertValidationCommands PER COMMAND so one unsafe
    // command yields one named refused RunResult instead of silently
    // disabling the whole validation lane — per-command isolation is
    // LOUDER here, not quieter.
    const [validated] = assertValidationCommands([cmd])
    argv = validated.trim().split(/\s+/)
  } catch (err) {
    if (err instanceof RefusalError) {
      return {
        cmd,
        argv: [],
        code: null,
        classified: 'refused',
        signal: null,
        elapsed_ms: 0,
        ok: false,
        tail: '',
        log_path: logPath,
        note: err.message,
      }
    }
    throw err
  }

  const fd = openSync(logPath, 'w')
  let res
  const startedAt = Date.now()
  try {
    res = spawnSync(argv[0], argv.slice(1), {
      cwd,
      stdio: ['ignore', fd, fd],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } finally {
    closeSync(fd)
  }
  const elapsedMs = Date.now() - startedAt

  const classification = classifyExit({ res })
  const tail = readTail(logPath)

  return {
    cmd,
    argv,
    code: classification.code,
    classified: classification.classified,
    signal: res.signal || null,
    elapsed_ms: elapsedMs,
    ok: classification.code === 0,
    tail,
    log_path: logPath,
    note: classification.note,
  }
}
