// The single repair boundary both envelope readers share. crew/headless.mjs's
// readEnvelopeOrThrow and crew/seat-io.mjs's readEnvelopeFile both delegate
// here so pane and RPC see the same bytes, the same outcome, and the same
// journal row; the import direction stays seat-io -> headless-rpc -> headless
// because neither wrapper imports the other, only this leaf.
//
// An UNREADABLE envelope is not an ABSENT one: `null` is the wait loop's
// "nothing on disk yet", but NOTHING ever rewrites a seat's envelope —
// reading is not authoring — so a file that IS there and cannot be parsed
// fails at the read boundary, staged so cellFailureKind maps it onto the
// EXISTING 'unusable-envelope' kind. No new vocabulary, and no repair of a
// seat's own file: the original bytes stay on disk byte-identical.
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

function repairJsonStringControls(raw) {
  let insideString = false
  let escaped = false
  let byteOffset = 0
  const offsets = []
  let repairedRaw = ''
  for (const char of raw) {
    const code = char.charCodeAt(0)
    const byteLength = Buffer.byteLength(char, 'utf8')
    if (!insideString) {
      repairedRaw += char
      if (char === '"') insideString = true
    } else if (escaped) {
      repairedRaw += char
      escaped = false
    } else if (char === '\\') {
      repairedRaw += char
      escaped = true
    } else if (char === '"') {
      repairedRaw += char
      insideString = false
    } else if (code <= 0x1f) {
      offsets.push(byteOffset)
      repairedRaw += code === 0x08 ? '\\b'
        : code === 0x09 ? '\\t'
          : code === 0x0a ? '\\n'
            : code === 0x0c ? '\\f'
              : code === 0x0d ? '\\r'
                : `\\u00${code.toString(16).padStart(2, '0')}`
    } else {
      repairedRaw += char
    }
    byteOffset += byteLength
  }
  return { raw: repairedRaw, offsets }
}

// A lossy decode is detectable by re-encoding: valid UTF-8 round-trips byte for byte, and a
// substituted U+FFFD does not. Both arguments come from the SAME read, so no rename can sit
// between them.
//
// BLIND SPOT, stated rather than omitted: when the injected reader returns a string there are
// no bytes to compare and this cannot prove validity, so it admits. Every enumerated runtime
// caller passes Node's `fs.readFileSync`, which returns a Buffer when given no encoding, so
// production always takes the checked path; a string-only test shim does not.
function envelopeBytesAreUtf8(bytes, decoded) {
  if (typeof bytes === 'string') return true
  try { return Buffer.from(decoded, 'utf8').equals(Buffer.from(bytes)) } catch { return false }
}

function envelopeParseFailure(path, raw, stage, role, error) {
  const parseFailure = new Error(`unusable envelope at ${path}: the file EXISTED (${raw.length} bytes) and is not JSON this driver can read: ${error.message}`)
  parseFailure.stage = stage
  if (role) parseFailure.role = role
  parseFailure.raw = raw   // reading is not authoring: the exact bytes travel with
  // the failure so a re-ask can tell "not re-emitted yet" from "re-emitted and
  // still broken", and nothing ever writes them back.
  return parseFailure
}

function journalFailure(path, raw, stage, role, message, cause = null) {
  const failure = cause === null
    ? new Error(`unusable envelope at ${path}: ${message}`)
    : new Error(`unusable envelope at ${path}: ${message}`, { cause })
  failure.stage = stage
  if (role !== null) failure.role = role
  failure.raw = raw
  return failure
}

// The lane's crew directory is the nearest ancestor holding the authoritative
// sibling `crew.json`. Return-path depth cannot name it: a flat
// `<crew>/returns/<name>.json` sits one level down while a run-scoped
// `<crew>/returns/<run-id>/<name>.json` sits two, so depth arithmetic journals
// the scoped repair beside the returns dir instead of the lane. Fail CLOSED:
// with no crew directory there is no evidence home, so the repair is staged
// rather than returned unjournaled.
function findCrewDir(returnPath, existsSync) {
  let dir = dirname(returnPath)
  while (true) {
    let found = false
    try { found = existsSync(join(dir, 'crew.json')) } catch { return null }
    if (found) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function readEnvelopeWithRepair(path, { existsSync = fsExistsSync, readFileSync = fsReadFileSync, stage, role = null, writeFileSync = fsWriteFileSync, now = Date.now } = {}) {
  if (!path || !existsSync(path)) return null
  let raw
  // A read that loses a race with a rename, or that comes back denied, is an
  // ABSENCE and not a defect: the next poll sees the file. Only bytes we
  // actually read and cannot parse are terminal.
  // ONE snapshot, decoded from the bytes we actually hold. Reading the path twice — once
  // decoded, once for validation — was a real TOCTOU in BOTH directions: a rename between the
  // reads turned a valid repairable envelope into a terminal defect, and malformed bytes from
  // the first snapshot were still accepted if the second snapshot happened to round-trip.
  let bytes
  try { bytes = readFileSync(path) } catch { return null }
  // An io shim may only speak strings; then there are no bytes to validate and `raw` is all
  // there is. That is recorded as a blind spot on `envelopeBytesAreUtf8` rather than hidden.
  raw = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
  let value
  try { value = JSON.parse(raw) } catch (strictError) {
    // `readFileSync(path, 'utf8')` LOSSILY decodes: a malformed byte becomes U+FFFD before the
    // scanner ever runs. Repairing such bytes would change an authored value and report a false
    // offset — precisely what "the repair authors nothing" promises it cannot do. Encoding is a
    // different defect from an in-string control, so it is refused, not repaired. Measured 0 of
    // 2,773 archived envelopes, but reachable, and a value-changing repair is never acceptable.
    if (!envelopeBytesAreUtf8(bytes, raw)) throw envelopeParseFailure(path, raw, stage, role, strictError)
    const repaired = repairJsonStringControls(raw)
    if (repaired.offsets.length === 0) throw envelopeParseFailure(path, raw, stage, role, strictError)
    try { value = JSON.parse(repaired.raw) } catch { throw envelopeParseFailure(path, raw, stage, role, strictError) }
    const row = {
      at: now(), event: 'envelope-repair', outcome: 'repaired', role,
      assignment_id: value.assignment_id ?? null, return_path: path,
      escaped_count: repaired.offsets.length, escaped_offsets: repaired.offsets,
    }
    const crewDir = findCrewDir(path, existsSync)
    if (crewDir === null) throw journalFailure(path, raw, stage, role, 'repaired bytes could not be recorded beside crew.json')
    const journalPath = join(crewDir, 'journal.jsonl')
    try {
      writeFileSync(journalPath, `${JSON.stringify(row)}\n`, { flag: 'a' })
    } catch (err) {
      throw journalFailure(path, raw, stage, role, `repaired bytes could not be recorded in ${journalPath}`, err)
    }
  }
  return value && typeof value === 'object' ? value : null
}
