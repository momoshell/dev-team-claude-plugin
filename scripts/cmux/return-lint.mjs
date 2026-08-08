// The worker-side return contract linter, and the single writer of
// 'blocked' ReturnEnvelopes.
//
// This is a THIN CLI over the parent's own evidence layer (ladder.mjs): the
// completion predicate itself — collectFsState + isFresh + validateReturn —
// is never reimplemented here, only invoked. The one rule this module adds
// that the parent does not yet enforce is the verdict-block rule: for a role
// whose record.return.verdict_block is true (roster.default.json:
// build-validator, code-reviewer, code-reviewer-deep — all markdown), the
// Verdict section must carry exactly one fenced json block that parses to
// {verdict, findings}.
//
// Invoked as a CLI by the Stop-hook gate (be-1c-02a) from inside the
// per-task --plugin-dir snapshot, and imported as a library by the adapter
// (be-1c-04). backend-notes.md: "validators throw on contract-author error,
// return violations on data error" — a malformed WORKER return (or record)
// is data; this module never throws out of the lint path itself, only out
// of writeBlockedReturn's own record/argument misuse (contract-author
// error, mirroring record.mjs's own posture).
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { validate, BLOCKED_MARKDOWN_PREFIX } from './contract.mjs'
import { validateReturn, collectFsState, isFresh } from './ladder.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DISPATCH_RECORD_SCHEMA = JSON.parse(readFileSync(join(MODULE_DIR, 'dispatch-record.schema.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Named constants (qa-notes 2026-08-02: "assert refusal messages against the
// exported constant").
// ---------------------------------------------------------------------------

export const USAGE_MESSAGE = 'usage: node return-lint.mjs [--block-json | --write-blocked] <record-path>'
export const RECORD_UNREADABLE_MESSAGE = 'record path is unreadable or is not valid JSON'
export const RECORD_INVALID_MESSAGE = 'record fails dispatch-record.schema.json'

export const RETURN_PATH_NOT_REGULAR_FILE = 'return_path_not_regular_file'
export const STALE_OR_ABSENT_RETURN = 'stale_or_absent_return'

// The one new predicate this module adds — see module header.
export const VERDICT_SECTION_MISSING = 'verdict_section_missing'
export const VERDICT_BLOCK_MISSING = 'verdict_block_missing'
export const VERDICT_BLOCK_MULTIPLE = 'verdict_block_multiple'
export const VERDICT_BLOCK_UNPARSEABLE = 'verdict_block_unparseable'
export const VERDICT_BLOCK_INVALID = 'verdict_block_invalid'

export const VERDICT_SECTION_MISSING_MESSAGE = 'markdown body has no Verdict section (outside any fenced example)'
export const VERDICT_BLOCK_MISSING_MESSAGE = 'Verdict section carries no fenced json block'
export const VERDICT_BLOCK_MULTIPLE_MESSAGE = 'Verdict section carries more than one fenced json block'
export const VERDICT_BLOCK_UNPARSEABLE_MESSAGE = 'Verdict section fenced block is not valid JSON'
export const VERDICT_BLOCK_INVALID_MESSAGE = 'Verdict section fenced block does not match {verdict, findings}'

// fix-1c-04 MF3: writeBlockedReturn refuses (fails CLOSED) a record whose
// return_path was tampered to resolve outside its own task_dir — a
// confused-deputy write of the parent-composed blocked envelope to an
// arbitrary path. Thrown, not returned as a violation, mirroring
// record.mjs's own assertWithinDir posture (contract-author/security
// refusal, not a data violation — see backend-notes.md).
export const RETURN_PATH_ESCAPES_TASK_DIR_MESSAGE = 'writeBlockedReturn: return_path resolves outside record.task_dir'

// fix-1c-04 WORKER_BLOCKED_STATUSES mirrors the constant of the same name
// owned by fix-1c-01 (contract.mjs). Re-declared here — not imported —
// because fix-1c-01 lands in a parallel fix-round slice; the drift guard in
// test/return-lint.test.mjs reads contract.mjs's own source text and fails
// if the two literals ever disagree, so this copy cannot silently rot.
const WORKER_BLOCKED_STATUSES = ['blocked', 'insufficient']

const VERDICT_ENUM = ['pass', 'changes-needed', 'inconclusive']
const SEVERITY_ENUM = ['critical', 'warning', 'suggestion']

// Presence/parse/enum ONLY — never quality (acceptance criteria). Expressed
// as a contract.mjs schema so the same budgeted, dependency-free validator
// the rest of this codebase trusts is reused rather than hand-rolled.
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: VERDICT_ENUM },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'line', 'summary'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: SEVERITY_ENUM },
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          summary: { type: 'string' },
        },
      },
    },
  },
}

// The exact stub body writeBlockedReturn composes for a verdict_block role.
const VERDICT_STUB_OBJECT = { verdict: 'inconclusive', findings: [] }

// ---------------------------------------------------------------------------
// Atomic write — mirrors record.mjs:90-95 exactly (conventions.md
// "concurrency-unsafe check-then-act": every write is tmp + rename in the
// destination directory, never rm-then-recreate).
// ---------------------------------------------------------------------------

function writeAtomicBytes(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------
// Verdict-block rule — the only new predicate. Everything else in this file
// only invokes ladder.mjs's own evidence layer.
// ---------------------------------------------------------------------------

const HEADING_LINE_RE = /^#{1,6}[ \t]+(.+?)[ \t]*$/
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/

// realHeadings(body) -> [{ name, level, start, end }] byte offsets into the
// ORIGINAL (unstripped) body, for headings that are NOT inside a fenced code
// block. Mirrors ladder.stripFences's own fence-tracking loop exactly (same
// fenceChar semantics: an unclosed fence swallows the rest of the document)
// but records offsets into the source instead of discarding fenced lines —
// this module still needs the RAW fenced bytes inside the real Verdict
// section, which stripFences would otherwise remove. `level` is carried so
// callers can apply the SAME level->=2 + case-folded-prefix predicate S1
// uses in ladder.checkSections (be-06-01 S2) — SECTION BOUNDARIES still stay
// "the next real heading of ANY level" regardless of level.
function realHeadings(body) {
  const headings = []
  let offset = 0
  let fenceChar = null
  for (const line of body.split('\n')) {
    const fenceMatch = line.match(FENCE_OPEN_RE)
    if (fenceChar) {
      if (fenceMatch && fenceMatch[1][0] === fenceChar) {
        fenceChar = null
      }
    } else if (fenceMatch) {
      fenceChar = fenceMatch[1][0]
    } else {
      const headingMatch = line.match(HEADING_LINE_RE)
      if (headingMatch) {
        const level = line.match(/^#+/)[0].length
        headings.push({ name: headingMatch[1].trim(), level, start: offset, end: offset + line.length })
      }
    }
    offset += line.length + 1
  }
  return headings
}

// extractSection(body, name) -> raw substring between the real heading that
// matches `name` (level->=2, case-folded prefix — the SAME predicate as
// ladder.checkSections, be-06-01 S2: a divergence between the heading the
// lint REQUIRES and the heading the verdict block is looked up IN is exactly
// the accept-a-fake hole recorded at .claude/dev-team/memory/backend-notes.md:16)
// and the next real heading of ANY level, or end-of-document, WITH fences
// intact — null when no matching real heading exists. A `## Verdict` heading
// that only appears inside a fenced example is never a real heading
// (realHeadings excludes it), so it can never satisfy this.
function extractSection(body, name) {
  const headings = realHeadings(body)
  const needle = name.trim().toLowerCase()
  const idx = headings.findIndex((h) => h.level >= 2 && h.name.toLowerCase().startsWith(needle))
  if (idx === -1) return null
  const start = Math.min(headings[idx].end + 1, body.length)
  const end = idx + 1 < headings.length ? headings[idx + 1].start : body.length
  return start >= end ? '' : body.slice(start, end)
}

// extractFencedBlocks(text) -> { content: string, info: string }[] — one
// entry per fenced block (the fence lines themselves stripped from
// content). Same fence-char matching as ladder.stripFences (an unclosed
// fence's content is still collected, up to end of text) — this is the
// mirror-image operation: stripFences DISCARDS fenced content, this
// COLLECTS it, so the two must agree on what counts as a fence. `info` is
// the opening fence's trailing info string (e.g. 'json' for a ```json
// fence, '' for an untagged fence) — fix-1c-04 SF2 needs this to tell a
// ```json verdict block apart from an untagged/other-language illustrative
// block sharing the same Verdict section.
function extractFencedBlocks(text) {
  const blocks = []
  let current = null
  let fenceChar = null
  let info = null
  for (const line of text.split('\n')) {
    const fenceMatch = line.match(FENCE_OPEN_RE)
    if (fenceChar) {
      if (fenceMatch && fenceMatch[1][0] === fenceChar) {
        blocks.push({ content: current.join('\n'), info })
        fenceChar = null
        current = null
        info = null
      } else {
        current.push(line)
      }
    } else if (fenceMatch) {
      fenceChar = fenceMatch[1][0]
      current = []
      info = line.slice(fenceMatch[0].length).trim()
    }
  }
  if (fenceChar) {
    blocks.push({ content: current.join('\n'), info })
  }
  return blocks
}

// extractVerdictBlock(body) -> { ok: true, verdict, findings } |
// { ok: false, keyword, message }. The parse/validate guts of the
// verdict-block rule, taking a bare markdown body string — never the
// (record, envelope) pair, and never throwing on worker data (backend-notes
// 2026-08-01: throw on contract-author error, return violations on data
// error). Exported so a caller (be-28-03's gates.mjs) can read a reviewer's
// parsed {verdict, findings} without re-parsing markdown itself; the
// realHeadings/extractSection/extractFencedBlocks trio stays module-private
// and is never exported individually (backend-notes.md:16's accept-a-fake
// hole — exporting the primitives invites a future caller to recombine them
// differently).
export function extractVerdictBlock(body) {
  const section = extractSection(body, 'Verdict')
  if (section === null) {
    return { ok: false, keyword: VERDICT_SECTION_MISSING, message: VERDICT_SECTION_MISSING_MESSAGE }
  }

  const blocks = extractFencedBlocks(section)
  if (blocks.length === 0) {
    return { ok: false, keyword: VERDICT_BLOCK_MISSING, message: VERDICT_BLOCK_MISSING_MESSAGE }
  }

  // SF2: a Verdict section legitimately carries an illustrative fenced block
  // (e.g. ```ts) alongside the real ```json verdict. When more than one
  // fenced block is present, count only json-tagged ones: exactly one ->
  // that's the verdict block; none tagged -> fall back to the original
  // all-blocks count (still VERDICT_BLOCK_MULTIPLE); more than one tagged ->
  // still VERDICT_BLOCK_MULTIPLE. A single block (tagged or not) is
  // unaffected by any of this — it goes straight to parse below.
  let candidate = blocks[0]
  if (blocks.length > 1) {
    const jsonTagged = blocks.filter((b) => b.info === 'json')
    if (jsonTagged.length !== 1) {
      return { ok: false, keyword: VERDICT_BLOCK_MULTIPLE, message: VERDICT_BLOCK_MULTIPLE_MESSAGE }
    }
    candidate = jsonTagged[0]
  }

  let parsed
  try {
    parsed = JSON.parse(candidate.content)
  } catch (err) {
    return { ok: false, keyword: VERDICT_BLOCK_UNPARSEABLE, message: `${VERDICT_BLOCK_UNPARSEABLE_MESSAGE}: ${err.message}` }
  }

  const schemaViolations = validate(VERDICT_SCHEMA, parsed)
  if (schemaViolations.length > 0) {
    const detail = schemaViolations.map((v) => `${v.path} (${v.keyword})`).join(', ')
    return { ok: false, keyword: VERDICT_BLOCK_INVALID, message: `${VERDICT_BLOCK_INVALID_MESSAGE}: ${detail}` }
  }

  return { ok: true, verdict: parsed.verdict, findings: parsed.findings }
}

// verdictBlockViolations(record, envelope) -> violations[]. Only meaningful
// for a markdown-kind, verdict_block-true role with a string body to
// inspect; a null envelope or non-string body means validateReturn already
// failed for an unrelated reason, so this reports nothing further.
function verdictBlockViolations(record, envelope) {
  if (!record.return.verdict_block) return []
  if (!envelope || record.return.kind !== 'markdown' || typeof envelope.body !== 'string') return []

  const res = extractVerdictBlock(envelope.body)
  return res.ok ? [] : [{ keyword: res.keyword, message: res.message }]
}

// ---------------------------------------------------------------------------
// lintReturn(record) -> violations[]. The completion predicate itself is
// NEVER reimplemented: collectFsState, isFresh and validateReturn are the
// parent's own functions, invoked read-only. This adds exactly the
// return_path-kind precision ladder.evaluateCompletion also carries (a
// directory/symlink at return_path names its own violation rather than
// collapsing into a generic "empty/stale" one) plus the verdict-block rule.
// ---------------------------------------------------------------------------

export function lintReturn(record) {
  const fsState = collectFsState({ record, paths: {} })
  const violations = []

  if (fsState.returnPathKind !== 'absent' && fsState.returnPathKind !== 'file') {
    violations.push({
      keyword: RETURN_PATH_NOT_REGULAR_FILE,
      message: `return_path is ${fsState.returnPathKind}, not a regular file`,
    })
  }

  const fresh = isFresh(record, fsState.returnStat)
  const validation = validateReturn(record, fsState.returnText)

  if (!fresh) {
    violations.push({
      keyword: STALE_OR_ABSENT_RETURN,
      message: fsState.returnPathKind === 'absent'
        ? 'return_path does not exist'
        : 'return_path mtime is not strictly newer than record.created_at',
    })
  }

  for (const v of validation.violations) {
    violations.push({ keyword: v.keyword, message: v.message })
  }

  for (const v of verdictBlockViolations(record, validation.envelope)) {
    violations.push(v)
  }

  return violations
}

function formatFailLines(violations) {
  return violations.map((v) => `FAIL ${v.keyword}: ${v.message}`)
}

// ---------------------------------------------------------------------------
// writeBlockedReturn(record, reason) -> string (the path written). Composes
// and atomically writes a ReturnEnvelope reporting status 'blocked' to
// record.return_path. Exported for be-1c-02a (Stop-hook gate) and be-1c-04
// (adapter) to import directly, per interface_contract.
// ---------------------------------------------------------------------------

// sanitizeReasonForMarkdown(reason) -> string — MF5. `reason` is
// worker/parent-composed free text (e.g. joined lintReturn violation
// messages) and is never itself validated markdown; unsanitized, an
// embedded newline followed by a fence-opening line would let `reason`
// open a real fence in the composed body that stripFences/realHeadings then
// treats as unclosed, swallowing every '## <required section>' heading
// pushed after it (VERDICT_SECTION_MISSING and friends on the guaranteed-
// valid envelope this function exists to produce). Collapsing every
// newline run to '; ' keeps `reason` on the single `status: blocked - `
// line it is composed onto, and stripping a leading fence run is a second,
// independent guard on the helper itself (unit-tested directly, per
// acceptance criteria) in case a caller ever emits `reason` unprefixed.
export function sanitizeReasonForMarkdown(reason) {
  return reason.replace(/[\r\n]+/g, '; ').replace(/^\s*(`{3,}|~{3,})/, '')
}

function buildBlockedMarkdownBody(record, reason) {
  const lines = [`${BLOCKED_MARKDOWN_PREFIX}${sanitizeReasonForMarkdown(reason)}`, '']
  const requiredSections = record.return.required_sections || []
  let sawVerdict = false

  for (const name of requiredSections) {
    lines.push(`## ${name}`, '')
    if (record.return.verdict_block && name === 'Verdict') {
      sawVerdict = true
      lines.push('```json', JSON.stringify(VERDICT_STUB_OBJECT), '```', '')
    }
  }

  // A verdict_block role's spec is always expected to list 'Verdict' among
  // required_sections (roster.default.json), but this composes a valid
  // envelope regardless — never relying on the record being well-formed
  // beyond what dispatch-record.schema.json itself requires.
  if (record.return.verdict_block && !sawVerdict) {
    lines.push('## Verdict', '', '```json', JSON.stringify(VERDICT_STUB_OBJECT), '```', '')
  }

  return lines.join('\n')
}

// assertReturnPathWithinTaskDir(record) -> void — MF3. Lives inside
// writeBlockedReturn itself (not at either call site) so BOTH callers, the
// gate CLI (--write-blocked) and the adapter's direct import, inherit it
// unconditionally. Mirrors record.mjs's assertWithinDir containment check
// (resolve both sides, require candidate === base || candidate startsWith
// base + '/') inlined rather than imported, per constraints. Fails CLOSED:
// throws before any body is composed or any byte is written.
function assertReturnPathWithinTaskDir(record) {
  const base = resolvePath(record.task_dir)
  const candidate = resolvePath(record.return_path)
  if (candidate !== base && !candidate.startsWith(`${base}/`)) {
    throw new Error(`${RETURN_PATH_ESCAPES_TASK_DIR_MESSAGE}: ${record.return_path}`)
  }
}

// destinationHoldsFreshNonBlockedReturn(record) -> boolean — SF7. Re-reads
// return_path through the parent's own evidence layer (collectFsState +
// isFresh + validateReturn — never reimplemented) immediately before the
// write. True only when a return already sitting at return_path is a
// regular file, fresh, schema/identity-valid AND not itself a worker-blocked
// status — i.e. a legitimate later return that must never be clobbered by
// this orphaned/racing blocked-envelope write. A markdown-kind body has no
// `status` field at all (envelope.body is a string) — that reads as `null`,
// which is correctly treated as non-blocked (a finished review return is
// never itself in WORKER_BLOCKED_STATUSES).
function destinationHoldsFreshNonBlockedReturn(record) {
  const fsState = collectFsState({ record, paths: {} })
  if (fsState.returnPathKind !== 'file') return false
  if (!isFresh(record, fsState.returnStat)) return false

  const validation = validateReturn(record, fsState.returnText)
  if (!validation.ok) return false

  // Deliberately asymmetric with ladder.mjs's classify(): classify() reads a
  // BLOCKED_MARKDOWN_PREFIX-prefixed markdown body as blocked (dispatch.mjs's
  // OUTCOME_MAPPING worker_blocked_markdown row), but this function must NOT
  // key on that prefix — doing so would let a blocked-prefixed body already
  // on disk return false here and get overwritten, destroying either a prior
  // blocked envelope from this same dispatch or a worker's own self-authored
  // blocked markdown return and its real verdict json.
  const { body } = validation.envelope
  const bodyStatus = body && typeof body === 'object' ? body.status : null
  return !WORKER_BLOCKED_STATUSES.includes(bodyStatus)
}

export function writeBlockedReturn(record, reason) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('writeBlockedReturn: reason must be a non-empty string')
  }

  assertReturnPathWithinTaskDir(record)

  const body = record.return.kind === 'markdown'
    ? buildBlockedMarkdownBody(record, reason)
    : { status: 'blocked', reason }

  const envelope = {
    schema_version: 1,
    dispatch_id: record.dispatch_id,
    slice_id: record.slice_id,
    attempt: record.attempt,
    role: record.role,
    produced_at: new Date().toISOString(),
    body,
  }

  if (destinationHoldsFreshNonBlockedReturn(record)) {
    return record.return_path
  }

  writeAtomicBytes(record.return_path, `${JSON.stringify(envelope, null, 2)}\n`)
  return record.return_path
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(msg) {
  process.stderr.write(`return-lint: ${msg}\n${USAGE_MESSAGE}\n`)
  return 2
}

// loadRecord(path) -> record. trust M4 (record.mjs:606's own posture,
// reimplemented locally rather than imported — the constraint list scopes
// this module's imports to ladder.mjs/contract.mjs only): a record is
// worker-reachable state (G13) and is validated against
// dispatch-record.schema.json before any field is trusted, exactly as
// record.readRecord does. Throws on unreadable/malformed JSON or schema
// violation — both map to exit 2 (usage), never exit 0/1, per acceptance
// criteria.
function loadRecord(path) {
  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${RECORD_UNREADABLE_MESSAGE}: ${err.message}`)
  }
  const violations = validate(DISPATCH_RECORD_SCHEMA, record)
  if (violations.length > 0) {
    const detail = violations.map((v) => `${v.path} (${v.keyword})`).join(', ')
    throw new Error(`${RECORD_INVALID_MESSAGE}: ${detail}`)
  }
  return record
}

function computeReason(violations) {
  if (violations.length === 0) {
    return 'return-lint: no violations were recorded at write time'
  }
  return formatFailLines(violations).join('\n')
}

// main(argv) -> exit code. argv excludes 'node' and the script path.
export function main(argv) {
  let mode = 'lint'
  let recordPath = null

  for (const arg of argv) {
    if (arg === '--block-json' || arg === '--write-blocked') {
      if (mode !== 'lint') return usage(`conflicting flags: cannot combine ${mode === 'lint' ? '' : `--${mode}`} with ${arg}`)
      mode = arg === '--block-json' ? 'block-json' : 'write-blocked'
    } else if (recordPath === null) {
      recordPath = arg
    } else {
      return usage(`unexpected argument: ${arg}`)
    }
  }

  if (!recordPath) {
    return usage('missing <record-path> argument')
  }

  let record
  try {
    record = loadRecord(resolvePath(recordPath))
  } catch (err) {
    return usage(err.message)
  }

  const violations = lintReturn(record)
  const ok = violations.length === 0

  if (mode === 'block-json') {
    if (ok) return 0
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: computeReason(violations) })}\n`)
    return 1
  }

  if (mode === 'write-blocked') {
    const path = writeBlockedReturn(record, computeReason(violations))
    process.stdout.write(`${path}\n`)
    return 0
  }

  for (const line of formatFailLines(violations)) {
    process.stdout.write(`${line}\n`)
  }
  process.stdout.write(`return-lint: ${ok ? 'PASS' : 'FAIL'} (${violations.length} violation(s))\n`)
  return ok ? 0 : 1
}

// realpathOr(path) -> string — realpath both sides of the direct-invocation check:
// the ESM loader realpaths import.meta.url while argv[1] stays literal, so under a
// symlinked path component (macOS TMPDIR is /var -> /private/var) a literal compare
// is silently false and the CLI no-ops (found at be-1c-02a, ruled by the lead).
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}
const invokedDirectly = process.argv[1] && realpathOr(process.argv[1]) === realpathOr(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
