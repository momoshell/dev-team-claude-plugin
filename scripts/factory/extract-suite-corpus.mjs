#!/usr/bin/env node
// Extract the recorded suite-policy corpus without making the shipped fixture
// depend on a machine's current checkout. Importing this module is deliberately
// inert: discovery and all reads happen only from extractSuiteCorpus/main.
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { shellToolCalls, recogniseSuiteInvocation, suiteRunPolicy, splitShellCommands } from '../../crew/headless.mjs'

const SUITE_COMMAND = 'npm test'
const SAMPLE_PREFIXES = Object.freeze(['00', '01', '02', '03'])
const DECISION_KEYS = Object.freeze(['lead', 'planner', 'builder', 'builder_spent'])
const DECISIONS = new Set(['admit', 'refuse', 'unrecognised'])
const ROW_KEYS = Object.freeze(['id', 'role', 'source_stream', 'command', 'kind', 'decisions', 'selected_by'])
const LEGAL_ROLES = new Set(['planner', 'lead', 'reviewer', 'builder', 'tech-lead'])
const KINDS = new Set([null, 'gate', 'scoped-test', 'suite', 'task-local'])
const REFERENCE_ROOT = '~/.crew'
const SOURCE_SCHEMA = 'suite-policy-corpus/1'

// Pinned byte-for-byte by the corpus fixture and its contract tests. These are
// prose facts about the corpus, not a second parser or policy implementation.
const SELECTION_RULE = 'Every distinct recorded command the recogniser classifies non-null under suite_command "npm test" with no gate path is selected (selected_by "recognised"); of the rest, a uniform 1-in-64 hash sample is selected (selected_by "sample") -- an unrecognised command is in the sample if and only if the sha256 of its REDACTED text, in lowercase hex, starts with one of sample_digest_prefixes. Each command carries the lexicographically smallest ATTRIBUTABLE occurrence of it: the smallest source_stream among the occurrences whose issuing role could be read, and that occurrence\'s role. A command is excluded only when NO occurrence of it has an attributable role, which is why distinct_commands_with_role is smaller than distinct_commands_redacted.'
const REDACTION = Object.freeze([
  "the extracting machine's home directory becomes ~",
  '/private/tmp/claude-<uid> and /tmp/claude-<uid> become .../claude-UID',
  '/var/folders/<a>/<b>/T/ becomes /var/folders/TMP/',
])
const DECISION_CONTEXTS = Object.freeze({
  lead: 'suiteRunPolicy({ role: "lead", fence: [], gatePath: null, suiteCommand: "npm test" }) -- the shared NEVER-OWNER verdict. lead, reviewer and tech-lead all carry SUITE_RUN_OWNERSHIP "never", so this single stored value is the expected verdict for ALL THREE, and every one of them is compared against it by the corpus tests and by the acceptance gate.',
  planner: 'suiteRunPolicy({ role: "planner", fence: [], gatePath: null, ranBefore: 0, suiteCommand: "npm test" })',
  builder: 'suiteRunPolicy({ role: "builder", fence: [], gatePath: null, suiteRanBefore: 0, suiteCommand: "npm test" })',
  builder_spent: 'suiteRunPolicy({ role: "builder", fence: [], gatePath: null, suiteRanBefore: 1, suiteCommand: "npm test" })',
})

const defaultIo = Object.freeze({
  readdir: (path, options) => readdirSync(path, options),
  readFile: (path, encoding) => readFileSync(path, encoding),
  exists: (path) => existsSync(path),
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
})

export class CorpusError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'CorpusError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function measurement(value, drawnFrom) {
  return { value, drawn_from: drawnFrom }
}

function absentMeasurement(denominator, reason) {
  return { value: null, drawn_from: denominator, absent_reason: reason }
}

function assertIo(io) {
  if (!io || typeof io.readdir !== 'function' || typeof io.readFile !== 'function'
    || typeof io.exists !== 'function' || typeof io.writeFile !== 'function') {
    throw new CorpusError('io-invalid')
  }
  return io
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new CorpusError(`${name}-invalid`)
  return value
}

function dateValue(value) {
  const date = value ?? new Date().toISOString().slice(0, 10)
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CorpusError('date-invalid')
  return date
}

/**
 * Apply the corpus redaction contract in its stated order. The home replacement
 * intentionally uses split/join rather than a regexp: a home can contain regexp
 * punctuation, while split/join remains literal and deterministic.
 */
export function redactCorpusText(text, { home } = {}) {
  requireString(home, 'home')
  let redacted = String(text ?? '')
  redacted = redacted.split(home).join('~')
  redacted = redacted.replace(/\/private\/tmp\/claude-\d+/g, '/private/tmp/claude-UID')
  redacted = redacted.replace(/(^|[^\w])\/tmp\/claude-\d+/g, '$1/tmp/claude-UID')
  redacted = redacted.replace(/\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T\//g, '/var/folders/TMP/')
  return redacted
}

function entryName(entry) {
  return typeof entry === 'string' ? entry.replace(/\/$/, '') : entry?.name
}

function entryIsDirectory(entry) {
  if (typeof entry?.isDirectory === 'function') {
    try { return entry.isDirectory() } catch { return false }
  }
  return typeof entry === 'string' && entry.endsWith('/')
}

function discoverStreams(sourceRoot, io) {
  const streams = []
  const visited = new Set()
  function walk(directory) {
    if (visited.has(directory)) return
    visited.add(directory)
    let entries
    try { entries = io.readdir(directory, { withFileTypes: true }) } catch { return }
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const name = entryName(entry)
      if (typeof name !== 'string' || name === '') continue
      const path = join(directory, name)
      if (entryIsDirectory(entry)) walk(path)
      else if (name === 'stream.jsonl') streams.push(path)
    }
  }
  walk(sourceRoot)
  return streams.sort()
}

function roleFromCmdRecord(streamPath, io) {
  const cmdPath = join(dirname(streamPath), 'cmd.json')
  let present
  try { present = io.exists(cmdPath) } catch { return null }
  if (!present) return null
  let raw
  try { raw = io.readFile(cmdPath, 'utf8') } catch { return null }
  let record
  try { record = JSON.parse(String(raw)) } catch { return null }
  const encoded = JSON.stringify(record)
  const match = encoded.match(/returns\/[A-Za-z0-9_-]+\.([a-z-]+)\.json/)
  return match && LEGAL_ROLES.has(match[1]) ? match[1] : null
}

function roleOf(streamPath, io) {
  const runDirectory = dirname(streamPath)
  const parent = basename(dirname(runDirectory))
  if (parent === 'headless-rpc') {
    const role = basename(runDirectory)
    return LEGAL_ROLES.has(role) ? role : null
  }
  return roleFromCmdRecord(streamPath, io)
}

function lineParseable(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try { JSON.parse(line) } catch { return false }
  }
  return true
}

function decisionsFor(command) {
  return {
    lead: suiteRunPolicy({ role: 'lead', command, fence: [], gatePath: null, suiteCommand: SUITE_COMMAND }).decision,
    planner: suiteRunPolicy({ role: 'planner', command, fence: [], gatePath: null, ranBefore: 0, suiteCommand: SUITE_COMMAND }).decision,
    builder: suiteRunPolicy({ role: 'builder', command, fence: [], gatePath: null, suiteRanBefore: 0, suiteCommand: SUITE_COMMAND }).decision,
    builder_spent: suiteRunPolicy({ role: 'builder', command, fence: [], gatePath: null, suiteRanBefore: 1, suiteCommand: SUITE_COMMAND }).decision,
  }
}

function isCdThenTestFamily(command) {
  const segments = splitShellCommands(command)
  return segments.length > 1 && /^cd\s/.test(segments[0])
    && segments.slice(1).some((segment) => recogniseSuiteInvocation(segment, { suiteCommand: SUITE_COMMAND, gatePath: null }) !== null)
}

function digestFor(command) {
  return createHash('sha256').update(String(command), 'utf8').digest('hex')
}

function sourceWithin(root, candidate) {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  const suffix = relative(rootPath, candidatePath)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function resolveReferenceSource(sourceStream, extraction) {
  const root = requireString(extraction.sourceRoot, 'source-root')
  const home = requireString(extraction.home, 'home')
  const redacted = requireString(sourceStream, 'source-stream')
  const rootRedacted = redactCorpusText(root, { home })
  const candidates = []
  const addRootSuffix = (prefix) => {
    if (redacted === prefix) candidates.push(root)
    else if (redacted.startsWith(`${prefix}/`)) candidates.push(join(root, redacted.slice(prefix.length + 1)))
  }
  addRootSuffix(rootRedacted)
  addRootSuffix(REFERENCE_ROOT)
  if (redacted.startsWith('~/')) candidates.push(join(home, redacted.slice(2)))
  else if (redacted === '~') candidates.push(home)
  else if (isAbsolute(redacted)) candidates.push(redacted)
  else candidates.push(join(root, redacted))
  for (const candidate of candidates) {
    if (sourceWithin(root, candidate)) return candidate
  }
  return null
}

function streamOutcomeReason(stream) {
  if (stream.unreadable) return 'unreadable'
  if (stream.unparseable) return 'unparseable'
  if (stream.calls.length === 0) return 'no-bash'
  if (stream.role === null) return 'role-less'
  return null
}

/**
 * Reject rows before they can be serialized. In particular, decision values are
 * never filled in by this function: a missing verdict is a producer error.
 */
export function validateCorpusRows(rows) {
  if (!Array.isArray(rows)) throw new CorpusError('rows-invalid')
  const ids = new Set()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new CorpusError('row-invalid')
    if (!DECISION_KEYS.every((key) => DECISIONS.has(row.decisions?.[key]))) throw new CorpusError('verdict-missing', `row ${index + 1} must state every expected verdict`)
    const keys = Object.keys(row)
    if (keys.length !== ROW_KEYS.length || !ROW_KEYS.every((key, keyIndex) => keys[keyIndex] === key)) throw new CorpusError('row-shape-invalid')
    if (typeof row.id !== 'string' || !/^[0-9a-f]{12}$/.test(row.id) || ids.has(row.id)) throw new CorpusError('id-invalid')
    ids.add(row.id)
    if (typeof row.role !== 'string' || !LEGAL_ROLES.has(row.role)) throw new CorpusError('role-invalid')
    if (typeof row.source_stream !== 'string' || !row.source_stream.endsWith('/stream.jsonl')) throw new CorpusError('source-stream-invalid')
    if (typeof row.command !== 'string' || row.command.trim() === '') throw new CorpusError('command-invalid')
    if (!KINDS.has(row.kind)) throw new CorpusError('kind-invalid')
    if (row.decisions === null || typeof row.decisions !== 'object' || Array.isArray(row.decisions)
      || Object.keys(row.decisions).length !== DECISION_KEYS.length
      || !DECISION_KEYS.every((key, keyIndex) => Object.keys(row.decisions)[keyIndex] === key)) throw new CorpusError('verdict-malformed')
    if (row.selected_by !== 'recognised' && row.selected_by !== 'sample') throw new CorpusError('selection-invalid')
    if (row.selected_by === 'recognised' && row.kind === null) throw new CorpusError('selection-invalid')
    if (row.selected_by === 'sample' && row.kind !== null) throw new CorpusError('selection-invalid')
  }
  return rows
}

function wrapStreamOutcomes(outcomes, denominator) {
  return {
    unreadable: measurement(outcomes.unreadable, denominator),
    unparseable: measurement(outcomes.unparseable, denominator),
    'role-less': measurement(outcomes['role-less'], denominator),
  }
}

function copyOutcomeReport(report, denominator) {
  const streamOutcomes = wrapStreamOutcomes(report.stream_outcomes, denominator)
  const counts = {}
  for (const [key, value] of Object.entries(report)) {
    if (key === 'stream_outcomes' || typeof value !== 'number') continue
    counts[key] = measurement(value, denominator)
  }
  return { ...counts, stream_outcomes: streamOutcomes }
}

function makeHeader({ extractedAt, counts, selected, allRows, rawDistinct, redactedDistinct, withRole, streamOutcomes }) {
  const recognised = allRows.filter((row) => row.kind !== null)
  const unrecognised = allRows.filter((row) => row.kind === null)
  return {
    schema: SOURCE_SCHEMA,
    issue: 929,
    extracted_at: extractedAt,
    source_root: REFERENCE_ROOT,
    suite_command: SUITE_COMMAND,
    gate_path: null,
    streams_scanned: counts.streams_scanned,
    streams_with_bash: counts.streams_with_bash,
    distinct_commands_recorded: rawDistinct,
    distinct_commands_redacted: redactedDistinct,
    distinct_commands_with_role: withRole,
    recognised_population: recognised.length,
    recognised_count: recognised.length,
    unrecognised_population: unrecognised.length,
    sample_digest_prefixes: [...SAMPLE_PREFIXES],
    sample_count: selected.filter((row) => row.selected_by === 'sample').length,
    entries: selected.length,
    cd_then_test_family_count: selected.filter((row) => isCdThenTestFamily(row.command)).length,
    selection_rule: SELECTION_RULE,
    redaction: [...REDACTION],
    decision_contexts: { ...DECISION_CONTEXTS },
    stream_outcomes: streamOutcomes,
  }
}

/**
 * Scan the live source tree. The returned stream metadata is intentionally
 * retained for verifyCorpus: it lets verification distinguish a gone source
 * from one that was read but could not be parsed or attributed.
 */
export function extractSuiteCorpus({ sourceRoot, home, extractedAt, io = defaultIo } = {}) {
  const root = requireString(sourceRoot, 'source-root')
  const machineHome = requireString(home, 'home')
  const fileIo = assertIo(io)
  const streams = discoverStreams(root, fileIo)
  const report = {
    stream_outcomes: { unreadable: 0, unparseable: 0, 'role-less': 0 },
    streams_scanned: streams.length,
    streams_with_bash: 0,
  }
  const byCommand = new Map()
  const rawDistinct = new Set()
  const streamRecords = []
  for (const streamPath of streams) {
    const record = {
      path: streamPath,
      source_stream: redactCorpusText(streamPath, { home: machineHome }),
      unreadable: false,
      unparseable: false,
      text: null,
      calls: [],
      role: null,
    }
    const outcomes = []
    try {
      record.text = String(fileIo.readFile(streamPath, 'utf8'))
    } catch {
      record.unreadable = true
      outcomes.push('unreadable')
    }
    if (!record.unreadable) {
      record.unparseable = !lineParseable(record.text)
      record.calls = shellToolCalls(record.text)
      if (record.calls.length > 0) report.streams_with_bash += 1
      if (record.calls.length > 0) record.role = roleOf(streamPath, fileIo)
      if (record.unparseable) outcomes.push('unparseable')
      if (record.calls.length > 0 && record.role === null) outcomes.push('role-less')
    }
    for (const outcome of outcomes) {
      report.stream_outcomes[outcome] += 1
    }
    streamRecords.push(record)
    if (record.unreadable) continue
    const source = record.source_stream
    for (const call of record.calls) {
      rawDistinct.add(call.command)
      const command = redactCorpusText(call.command, { home: machineHome })
      if (!byCommand.has(command)) byCommand.set(command, { command, occurrences: [] })
      byCommand.get(command).occurrences.push({ source_stream: source, role: record.role })
    }
  }

  const allCommands = [...byCommand.values()]
  const redactedDistinct = allCommands.length
  const attributable = []
  for (const entry of allCommands) {
    const named = entry.occurrences
      .filter((occurrence) => occurrence.role !== null)
      .sort((a, b) => (a.source_stream < b.source_stream ? -1 : a.source_stream > b.source_stream ? 1 : 0))
    if (named.length === 0) continue
    attributable.push({ command: entry.command, role: named[0].role, source_stream: named[0].source_stream })
  }
  const allRows = attributable.map((entry) => {
    const digest = digestFor(entry.command)
    const kind = recogniseSuiteInvocation(entry.command, { suiteCommand: SUITE_COMMAND, gatePath: null })
    return {
      id: digest.slice(0, 12),
      role: entry.role,
      source_stream: entry.source_stream,
      command: entry.command,
      kind,
      decisions: decisionsFor(entry.command),
      digest,
    }
  })
  const selected = []
  for (const row of allRows) {
    const { digest, ...publicRow } = row
    const kind = publicRow.kind
    const samplePrefixes = SAMPLE_PREFIXES
    const selectedBy = kind !== null ? 'recognised' : samplePrefixes.some((prefix) => digest.startsWith(prefix)) ? 'sample' : null
    if (selectedBy !== null) selected.push({ ...publicRow, selected_by: selectedBy })
  }
  selected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  validateCorpusRows(selected)
  const streamOutcomes = wrapStreamOutcomes(report.stream_outcomes, streams.length)
  const counts = {
    streams_scanned: report.streams_scanned,
    streams_with_bash: report.streams_with_bash,
    distinct_commands_recorded: rawDistinct.size,
    distinct_commands_redacted: redactedDistinct,
    distinct_commands_with_role: attributable.length,
    recognised_population: allRows.filter((row) => row.kind !== null).length,
    recognised_count: allRows.filter((row) => row.kind !== null).length,
    unrecognised_population: allRows.filter((row) => row.kind === null).length,
    sample_count: selected.filter((row) => row.selected_by === 'sample').length,
    entries: selected.length,
    cd_then_test_family_count: selected.filter((row) => isCdThenTestFamily(row.command)).length,
  }
  const header = makeHeader({
    extractedAt: dateValue(extractedAt),
    counts,
    selected,
    allRows,
    rawDistinct: rawDistinct.size,
    redactedDistinct,
    withRole: attributable.length,
    streamOutcomes,
  })
  const reportWithCounts = {
    ...copyOutcomeReport(report, streams.length),
    distinct_commands_recorded: measurement(rawDistinct.size, rawDistinct.size),
    distinct_commands_redacted: measurement(redactedDistinct, redactedDistinct),
    distinct_commands_with_role: measurement(attributable.length, redactedDistinct),
    recognised_population: measurement(counts.recognised_population, attributable.length),
    unrecognised_population: measurement(counts.unrecognised_population, attributable.length),
    recognised_count: measurement(counts.recognised_count, counts.recognised_population),
    sample_count: measurement(counts.sample_count, counts.unrecognised_population),
    entries: measurement(counts.entries, attributable.length),
    cd_then_test_family_count: measurement(counts.cd_then_test_family_count, counts.entries),
  }
  const rows = selected.map(({ id, role, source_stream, command, kind, decisions, selected_by }) => ({
    id, role, source_stream, command, kind, decisions, selected_by,
  }))
  validateCorpusRows(rows)
  const text = serializeCorpus({ header, rows })
  return {
    sourceRoot: root,
    home: machineHome,
    extractedAt: header.extracted_at,
    header,
    rows,
    text,
    report: reportWithCounts,
    streams: streamRecords,
  }
}

export function serializeCorpus({ header, rows } = {}) {
  validateCorpusRows(rows)
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new CorpusError('header-invalid')
  return `${[JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`
}

function parseReference(text) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return { header: null, rows: [], rowLines: [], invalid: [{ line: 1, reason: 'reference-empty' }] }
  let header
  const invalid = []
  try { header = JSON.parse(lines[0]) } catch { invalid.push({ line: 1, reason: 'header-invalid' }); return { header: null, rows: [], rowLines: [], invalid } }
  const rows = []
  const rowLines = []
  for (let index = 1; index < lines.length; index += 1) {
    try {
      const row = JSON.parse(lines[index])
      validateCorpusRows([row])
      rows.push(row)
      rowLines.push(lines[index])
    } catch (error) {
      invalid.push({ line: index + 1, reason: error instanceof CorpusError ? error.message : 'row-invalid' })
    }
  }
  return { header, rows, rowLines, invalid }
}

// RV1-2: the io must be THREADED IN. `extractSuiteCorpus` never puts `io` on its
// return value, so probing `extraction.io` here was always undefined: the branch
// always returned null and a present-but-undiscovered source was reported `absent`
// — "gone" — when it is merely unreadable. `discoverStreams` swallows a failed
// readdir and skips the subtree, so that is the exact case this arm must name.
function metadataForSource(extraction, sourceStream, io = null) {
  const records = Array.isArray(extraction.streams) ? extraction.streams : []
  const candidate = resolveReferenceSource(sourceStream, extraction)
  const probe = io ?? extraction.io ?? null
  const unreadableRecord = { path: candidate, source_stream: sourceStream, unreadable: true, calls: [], role: null }
  if (candidate !== null) {
    const exact = records.find((record) => record.path === candidate)
    if (exact) return exact
    try {
      if (!probe?.exists?.(candidate)) return null
      return unreadableRecord
    } catch { return unreadableRecord }
  }
  const matches = records.filter((record) => record.source_stream === sourceStream)
  return matches.length === 1 ? matches[0] : null
}

function rowKey(row) {
  return `${row.source_stream}\u0000${row.command}`
}

/**
 * Compare a fresh extraction with the committed reference. This function never
 * calls writeFile, even when every reachable row diverges.
 */
export function verifyCorpus({ referencePath, extraction, io = defaultIo } = {}) {
  const fileIo = assertIo(io)
  const reference = requireString(referencePath, 'reference-path')
  if (!extraction || typeof extraction !== 'object') throw new CorpusError('extraction-invalid')
  let raw
  try { raw = fileIo.readFile(reference, 'utf8') } catch (error) {
    throw new CorpusError('reference-unreadable', { cause: error })
  }
  const parsed = parseReference(String(raw))
  const denominator = parsed.rows.length + parsed.invalid.length
  const generatedByKey = new Map((Array.isArray(extraction.rows) ? extraction.rows : []).map((row) => [rowKey(row), row]))
  const generatedById = new Map((Array.isArray(extraction.rows) ? extraction.rows : []).map((row) => [row.id, row]))
  let matched = 0
  let divergent = 0
  let unavailableCount = 0
  const unavailableRows = []
  const divergences = []
  for (let index = 0; index < parsed.rows.length; index += 1) {
    const referenceRow = parsed.rows[index]
    const stream = metadataForSource(extraction, referenceRow.source_stream, fileIo)
    const reason = stream === null
      ? 'absent'
      : streamOutcomeReason(stream)
    if (reason !== null) {
      unavailableCount += 1
      unavailableRows.push({
        id: referenceRow.id,
        source_stream: referenceRow.source_stream,
        reason,
        population: absentMeasurement(denominator, reason),
      })
      continue
    }
    const generated = generatedByKey.get(rowKey(referenceRow)) ?? generatedById.get(referenceRow.id) ?? null
    const actualBytes = generated === null ? null : JSON.stringify(generated)
    if (actualBytes === parsed.rowLines[index]) matched += 1
    else {
      divergent += 1
      divergences.push({ id: referenceRow.id, source_stream: referenceRow.source_stream, expected: parsed.rowLines[index], actual: actualBytes })
    }
  }
  const invalidRows = parsed.invalid
  const report = {
    reference_path: reference,
    source_root: extraction.sourceRoot,
    matched: measurement(matched, denominator),
    divergent: measurement(divergent, denominator),
    invalid: measurement(invalidRows.length, denominator),
    checked: measurement(matched + divergent, denominator),
    unavailable_count: measurement(unavailableCount, denominator),
    unavailable: unavailableCount > 0
      ? absentMeasurement(denominator, 'one-or-more-reference-sources-unavailable')
      : measurement(0, denominator),
    unavailable_rows: unavailableRows,
    divergences,
    invalid_rows: invalidRows,
    stream_outcomes: extraction.report?.stream_outcomes ?? null,
  }
  return {
    report,
    matched: report.matched,
    divergent: report.divergent,
    invalid: report.invalid,
    unavailable: report.unavailable,
    unavailableRows,
    divergences,
  }
}

export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new CorpusError('arguments-invalid')
  const result = { sourceRoot: null, referencePath: null, outPath: null, date: null }
  const names = new Set(['--source-root', '--reference', '--out', '--date'])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!names.has(flag)) throw new CorpusError(`argument-invalid: ${String(flag)}`)
    if (index + 1 >= argv.length || typeof argv[index + 1] !== 'string' || argv[index + 1].startsWith('--')) throw new CorpusError(`argument-value-missing: ${flag}`)
    const value = argv[++index]
    const key = flag === '--source-root' ? 'sourceRoot' : flag === '--reference' ? 'referencePath' : flag === '--out' ? 'outPath' : 'date'
    if (result[key] !== null) throw new CorpusError(`argument-duplicate: ${flag}`)
    result[key] = value
  }
  if (result.sourceRoot !== null) requireString(result.sourceRoot, 'source-root')
  if (result.referencePath !== null) requireString(result.referencePath, 'reference-path')
  if (result.outPath !== null) requireString(result.outPath, 'out-path')
  if (result.date !== null) dateValue(result.date)
  return result
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const io = assertIo(deps.io ?? defaultIo)
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  try {
    const args = parseArgs(argv)
    const machineHome = deps.home ?? homedir()
    const sourceRoot = args.sourceRoot ?? join(homedir(), '.crew')
    const referencePath = args.referencePath ?? join(deps.cwd ?? process.cwd(), 'test/fixtures/suite-policy-corpus.jsonl')
    const outPath = args.outPath ?? null
    const extraction = extractSuiteCorpus({ sourceRoot, home: machineHome, extractedAt: args.date ?? undefined, io })
    const text = extraction.text
    if (outPath !== null) io.writeFile(outPath, text)
    if (outPath !== null) {
      stdout.write(`${JSON.stringify(extraction.report)}\n`)
      return 0
    }
    const verification = verifyCorpus({ referencePath, extraction, io })
    const report = { extraction: extraction.report, verification: verification.report }
    stdout.write(`${JSON.stringify(report)}\n`)
    return verification.report.divergent.value > 0 || verification.report.invalid.value > 0 ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { stderr.write(`${message}\n`) } catch {}
    return error instanceof CorpusError ? 2 : 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
