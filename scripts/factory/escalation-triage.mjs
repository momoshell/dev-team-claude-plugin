#!/usr/bin/env node

// Standalone, record-only escalation triage. This module deliberately has no
// import path from crew/driver/daemon code: a local model may suggest a cause,
// but only the measured endSession row remains authoritative.
import { readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join } from 'node:path'
import {
  ESCALATION_CAUSES,
  ESCALATION_CAUSE_UNCLASSIFIED,
  escalationCause,
  defaultDbPath,
  openLedger,
} from './ledger.mjs'

// These values are environment-variable names rather than endpoint defaults.
// An absent setting is an intentional no-op, not a request to guess a local
// service or to fall back to a paid provider.
export const CREW_TRIAGE_ENDPOINT = 'CREW_TRIAGE_ENDPOINT'
export const CREW_TRIAGE_MODEL = 'CREW_TRIAGE_MODEL'

export const TRIAGE_STREAM_TAIL_BYTES = 16 * 1024
export const TRIAGE_PROMPT_MAX_BYTES = 64 * 1024
export const TRIAGE_EVIDENCE_MAX_BYTES = 2 * 1024
export const TRIAGE_REQUEST_TIMEOUT_MS = 10 * 1000
export const TRIAGE_MAX_STREAMS = 64

export const TRIAGE_REFUSALS = Object.freeze({
  endpointUnconfigured: 'endpoint-unconfigured',
  modelUnconfigured: 'model-unconfigured',
  alreadyClassified: 'already-classified',
  alreadyProposed: 'already-proposed',
  proposalCauseInvalid: 'proposal-cause-invalid',
  proposalEvidenceInvalid: 'proposal-evidence-invalid',
  responseInvalid: 'response-invalid',
  responseReadFailed: 'response-read-failed',
  endpointFailed: 'endpoint-failed',
  endpointTimeout: 'endpoint-timeout',
  ledgerUnavailable: 'ledger-unavailable',
  ledgerWriteFailed: 'ledger-write-failed',
  ledgerResultInvalid: 'ledger-result-invalid',
  sessionMissing: 'session-missing',
  durableRecordIncomplete: 'durable-record-incomplete',
  triageFailed: 'triage-failed',
})
export const TRIAGE_REFUSAL_NAMES = Object.freeze(Object.values(TRIAGE_REFUSALS))

function unchanged(reason) {
  return { recorded: false, reason }
}

export { unchanged }

function diagnostic(diagnostics, source, reason, code = null, partial = true) {
  diagnostics.push({ source, reason, code, partial })
}

function errorCode(error) {
  const code = error?.code
  if (typeof code === 'string' && code.trim()) return code.toUpperCase()
  if (error?.name === 'AbortError') return 'ABORT_ERR'
  if (typeof error?.name === 'string' && error.name.trim()) return error.name.toUpperCase()
  return 'UNKNOWN'
}

function readFailureReason(source, error) {
  const code = errorCode(error)
  if (code === 'ENOENT') return `${source}-missing`
  if (code === 'EPERM' || code === 'EACCES') return `${source}-permission-denied`
  if (code === 'EINTR' || code === 'ABORT_ERR') return `${source}-interrupted`
  return `${source}-read-failed`
}

function readText(path, read, diagnostics, source) {
  let value
  try {
    value = read(path, 'utf8')
  } catch (error) {
    diagnostic(diagnostics, source, readFailureReason(source, error), errorCode(error))
    return { present: false, text: '' }
  }
  if (value == null || String(value).trim().length === 0) {
    diagnostic(diagnostics, source, `${source}-empty`, null)
    return { present: false, text: '' }
  }
  return { present: true, text: String(value) }
}

function parseJsonl(text, source, diagnostics, { tailTruncated = false } = {}) {
  const raw = String(text ?? '')
  if (raw.trim().length === 0) {
    diagnostic(diagnostics, source, `${source}-empty`, null)
    return []
  }
  let lines = raw.split(/\r?\n/)
  const terminated = /\r?\n$/.test(raw)
  if (tailTruncated && lines.length > 0) {
    // A byte-bounded tail can begin in the middle of a JSON line. The first
    // fragment is not evidence; discard it rather than attempting a repair.
    if (lines[0].trim() !== '') diagnostic(diagnostics, source, `${source}-tail-truncated`, null)
    lines = lines.slice(1)
  }
  if (terminated && lines.at(-1) === '') lines.pop()
  const rows = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      rows.push(parsed)
    } catch {
      const final = index === lines.length - 1 && !terminated
      diagnostic(diagnostics, source, final ? `${source}-torn-final` : `${source}-malformed-line`, null)
    }
  }
  return rows
}

function utf8Prefix(bytes, maxBytes) {
  let end = Math.min(bytes.byteLength, Math.max(0, maxBytes))
  let text = bytes.subarray(0, end).toString('utf8')
  while (Buffer.byteLength(text, 'utf8') > maxBytes && end > 0) {
    end -= 1
    text = bytes.subarray(0, end).toString('utf8')
  }
  return text
}

function boundedTail(text, maxBytes) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8')
  if (bytes.byteLength <= maxBytes) return { text: bytes.toString('utf8'), truncated: false }
  let start = bytes.byteLength - maxBytes
  let tail = bytes.subarray(start).toString('utf8')
  while (Buffer.byteLength(tail, 'utf8') > maxBytes && start < bytes.byteLength) {
    start += 1
    tail = bytes.subarray(start).toString('utf8')
  }
  return { text: tail, truncated: true }
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function directoryName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry.name === 'string') {
    if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) return null
    return entry.name
  }
  return null
}

function safeStreamName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name)
}

function loadStreams({ root, read, readdir, diagnostics }) {
  const streamRoot = join(root, 'task', 'headless')
  let entries
  try {
    entries = readdir(streamRoot, { withFileTypes: true })
  } catch (error) {
    diagnostic(diagnostics, 'streams', readFailureReason('streams', error), errorCode(error))
    return []
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    diagnostic(diagnostics, 'streams', 'streams-empty', null)
    return []
  }
  const names = [...new Set(entries.map(directoryName).filter(safeStreamName))].sort()
  if (names.length > TRIAGE_MAX_STREAMS) {
    diagnostic(diagnostics, 'streams', 'streams-bounded', null)
  }
  const streams = []
  for (const name of names.slice(0, TRIAGE_MAX_STREAMS)) {
    const source = `stream-${name}`
    const path = join(streamRoot, name, 'stream.jsonl')
    const sourceRead = readText(path, read, diagnostics, source)
    if (!sourceRead.present) {
      streams.push({ id: name, tail: '', records: [] })
      continue
    }
    const tail = boundedTail(sourceRead.text, TRIAGE_STREAM_TAIL_BYTES)
    const records = parseJsonl(tail.text, source, diagnostics, { tailTruncated: tail.truncated })
    streams.push({
      id: name,
      tail: tail.text,
      records,
    })
  }
  return streams
}

function safeLedgerSession(ledger, adwId, diagnostics) {
  if (!adwId) {
    diagnostic(diagnostics, 'ledger', 'adw-id-absent', null)
    return null
  }
  if (!ledger || typeof ledger.getSession !== 'function') {
    diagnostic(diagnostics, 'ledger', 'ledger-session-unavailable', null)
    return null
  }
  try {
    const session = ledger.getSession(adwId)
    if (session == null) diagnostic(diagnostics, 'ledger', 'session-missing', null)
    return session ?? null
  } catch (error) {
    diagnostic(diagnostics, 'ledger', 'ledger-session-read-failed', errorCode(error))
    return null
  }
}

function safeLedgerProposal(ledger, adwId, diagnostics) {
  if (!adwId || !ledger || typeof ledger.escalationProposalFor !== 'function') {
    if (adwId) diagnostic(diagnostics, 'ledger', 'ledger-proposal-unavailable', null)
    return null
  }
  try {
    const proposal = ledger.escalationProposalFor(adwId)
    if (proposal != null && (typeof proposal !== 'object' || Array.isArray(proposal))) {
      diagnostic(diagnostics, 'ledger', 'ledger-proposal-unreadable', null)
      return null
    }
    return proposal ?? null
  } catch (error) {
    diagnostic(diagnostics, 'ledger', 'ledger-proposal-read-failed', errorCode(error))
    return null
  }
}

function safeLedgerObservations(ledger, adwId, diagnostics) {
  if (!adwId || !ledger || typeof ledger.runObservationsFor !== 'function') {
    if (adwId) diagnostic(diagnostics, 'ledger', 'ledger-observations-unavailable', null)
    return []
  }
  try {
    const rows = ledger.runObservationsFor([adwId])
    if (!Array.isArray(rows)) {
      diagnostic(diagnostics, 'ledger', 'ledger-observations-unreadable', null)
      return []
    }
    return rows
  } catch (error) {
    diagnostic(diagnostics, 'ledger', 'ledger-observations-read-failed', errorCode(error))
    return []
  }
}

/**
 * Read the durable escalation evidence and nothing else. In particular this
 * function does not inspect an external working tree or a model endpoint.
 * A second argument is the test seam for denied/interrupted/torn reads.
 */
export function loadDurableEscalationRecord(input = {}, deps = {}) {
  if (typeof input === 'string') input = { crewDir: input }
  const config = input && typeof input === 'object' ? input : {}
  const diagnostics = []
  const root = typeof config.crewDir === 'string' ? config.crewDir.trim() : ''
  const read = deps.readFileSync || deps.readFile || fsReadFileSync
  const readdir = deps.readdirSync || deps.readdir || fsReaddirSync
  if (!root || !isAbsolute(root)) {
    diagnostic(diagnostics, 'crew', 'crew-dir-invalid', null)
    return {
      adw_id: null,
      escalation: null,
      return: null,
      journal: [],
      observations: [],
      streams: [],
      session: null,
      proposal: null,
      diagnostics,
      partial: true,
    }
  }

  const returnRead = readText(join(root, 'returns', 'task.json'), read, diagnostics, 'return')
  let taskReturn = null
  if (returnRead.present) {
    try {
      const parsed = JSON.parse(returnRead.text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('return is not an object')
      taskReturn = parsed
    } catch {
      diagnostic(diagnostics, 'return', 'return-malformed', null)
    }
  }

  const journalRead = readText(join(root, 'journal.jsonl'), read, diagnostics, 'journal')
  const allJournal = journalRead.present ? parseJsonl(journalRead.text, 'journal', diagnostics) : []
  let boundary = -1
  for (let index = 0; index < allJournal.length; index += 1) {
    if (allJournal[index]?.event === 'run-start') boundary = index
  }
  if (boundary < 0) diagnostic(diagnostics, 'journal', 'journal-run-start-absent', null)
  const journal = boundary >= 0 ? allJournal.slice(boundary) : allJournal
  const runStart = boundary >= 0 ? allJournal[boundary] : null
  const escalation = taskReturn?.details?.escalation && typeof taskReturn.details.escalation === 'object'
    && !Array.isArray(taskReturn.details.escalation) ? taskReturn.details.escalation : null
  if (taskReturn && escalation === null) diagnostic(diagnostics, 'return', 'return-escalation-absent', null)

  const runId = firstNonBlank(
    runStart?.run_id,
    taskReturn?.run_id,
    taskReturn?.details?.run_id,
  )
  let adwId = firstNonBlank(
    runStart?.adw_id,
    runStart?.adwId,
    taskReturn?.adw_id,
    taskReturn?.adwId,
    taskReturn?.details?.adw_id,
    runId,
  )
  // Daemon run ids are not sidecar ids. Prefer the ledger's canonical
  // linkRun/taskReadout association whenever one is available; the direct
  // run-id fallback remains useful for old archives and local fixtures.
  if (runId && config.ledger && typeof config.ledger.taskReadout === 'function') {
    try {
      const readout = config.ledger.taskReadout(runId)
      if (typeof readout?.adw_id === 'string' && readout.adw_id.trim()) adwId = readout.adw_id.trim()
      else if (Array.isArray(readout?.candidates) && readout.candidates.length > 0) {
        diagnostic(diagnostics, 'ledger', 'run-id-ambiguous', null)
      }
    } catch (error) {
      diagnostic(diagnostics, 'ledger', 'run-id-resolution-failed', errorCode(error))
    }
  }
  const session = safeLedgerSession(config.ledger, adwId, diagnostics)
  const proposal = safeLedgerProposal(config.ledger, adwId, diagnostics)
  const observations = safeLedgerObservations(config.ledger, adwId, diagnostics)
  const streams = loadStreams({ root, read, readdir, diagnostics })

  return {
    adw_id: adwId,
    escalation,
    return: taskReturn,
    journal,
    observations,
    streams,
    session,
    proposal,
    diagnostics,
    partial: diagnostics.length > 0,
  }
}

function utf8Bound(text, maxBytes) {
  const value = String(text ?? '')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  const marker = '…[truncated]'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (maxBytes <= markerBytes) return utf8Prefix(bytes, maxBytes)
  return `${utf8Prefix(bytes, maxBytes - markerBytes)}${marker}`
}

/** Return a bounded instruction containing only the durable record. */
export function proposalPrompt(durableRecord) {
  const record = { record: durableRecord, }
  let serialized
  try { serialized = JSON.stringify(record) } catch { return null }
  const prompt = [
    'Classify the unclassified escalation from the durable run record below.',
    'Return JSON only with exactly two useful fields: proposed_cause and evidence.',
    `proposed_cause must be one of: ${ESCALATION_CAUSES.join(', ')}.`,
    'Evidence must quote or summarize facts in the record; do not inspect or infer unrecorded source changes.',
    serialized,
  ].join('\n')
  return utf8Bound(prompt, TRIAGE_PROMPT_MAX_BYTES)
}

function parseJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function responsePayload(response) {
  const parsed = parseJson(response)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (Object.hasOwn(parsed, 'proposed_cause') || Object.hasOwn(parsed, 'evidence')) return parsed
  const content = parsed?.choices?.[0]?.message?.content
  if (typeof content !== 'string') return null
  const nested = parseJson(content)
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : null
}

/** Parse and validate either direct JSON or an OpenAI-compatible chat reply. */
export function proposalFromResponse(response) {
  const parsed = responsePayload(response)
  if (!parsed) return unchanged('response-invalid')
  const proposedCause = parsed.proposed_cause
  if (!ESCALATION_CAUSES.includes(proposedCause)) return unchanged('proposal-cause-invalid')
  if (typeof parsed.evidence !== 'string' || parsed.evidence.trim() === '') {
    return unchanged('proposal-evidence-invalid')
  }
  return {
    ok: true,
    proposed_cause: proposedCause,
    evidence: utf8Bound(parsed.evidence.trim(), TRIAGE_EVIDENCE_MAX_BYTES),
  }
}

function endpointUrl(endpoint) {
  const base = String(endpoint).trim().replace(/\/+$/, '')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

async function boundedFetch(url, options = {}) {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is unavailable')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRIAGE_REQUEST_TIMEOUT_MS)
  try {
    return await globalThis.fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function requestWithinBudget(request, url, options) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('triage request timed out'), { code: 'ETIMEDOUT' })), TRIAGE_REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => request(url, options)), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function timeoutError(error) {
  return error?.name === 'AbortError' || error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR'
}

async function responseBody(response) {
  if (response == null) return null
  if (typeof response === 'string') return response
  if (typeof response.json === 'function') return response.json()
  if (typeof response.text === 'function') return response.text()
  if (Object.hasOwn(response, 'body')) return response.body
  if (Object.hasOwn(response, 'output')) return response.output
  return response
}

function sessionFromRecord(durableRecord, ledger) {
  if (durableRecord?.session && typeof durableRecord.session === 'object') return durableRecord.session
  const adwId = firstNonBlank(durableRecord?.adw_id)
  if (!adwId || !ledger || typeof ledger.getSession !== 'function') return null
  try { return ledger.getSession(adwId) ?? null } catch { return null }
}

function proposalFromRecord(durableRecord, ledger) {
  if (durableRecord?.proposal && typeof durableRecord.proposal === 'object' && !Array.isArray(durableRecord.proposal)) {
    return durableRecord.proposal
  }
  const adwId = firstNonBlank(durableRecord?.adw_id)
  if (!adwId || !ledger || typeof ledger.escalationProposalFor !== 'function') return null
  try { return ledger.escalationProposalFor(adwId) ?? null } catch { return null }
}

/**
 * Ask once and persist only a validated proposal. Every operational failure is
 * a named no-op so this off-critical-path consumer cannot hold up a lane.
 */
export async function triageEscalation(input = {}, deps = {}) {
  const config = input && typeof input === 'object' ? input : {}
  const durableRecord = config.durableRecord
  const ledger = config.ledger
  const measured = escalationCause(durableRecord?.escalation)
  if (measured.cause !== ESCALATION_CAUSE_UNCLASSIFIED) return unchanged('already-classified')

  const session = sessionFromRecord(durableRecord, ledger)
  if (!session) return unchanged('session-missing')
  if (session.terminal_reason != null && session.terminal_reason !== ESCALATION_CAUSE_UNCLASSIFIED) {
    return unchanged('already-classified')
  }
  const existingProposal = proposalFromRecord(durableRecord, ledger)
  if (existingProposal != null) return unchanged('already-proposed')

  const endpoint = config.endpoint
  if (!endpoint) return unchanged('endpoint-unconfigured')
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return unchanged('endpoint-unconfigured')
  const model = config.model
  if (!model || (typeof model === 'string' && model.trim() === '')) return unchanged('model-unconfigured')
  if (typeof model !== 'string') return unchanged('model-unconfigured')

  const adwId = firstNonBlank(durableRecord?.adw_id, session?.adw_id)
  if (!adwId) return unchanged('session-missing')
  if (!ledger || typeof ledger.recordEscalationProposal !== 'function') {
    return unchanged('ledger-unavailable')
  }

  let body
  try {
    const prompt = proposalPrompt(durableRecord)
    if (typeof prompt !== 'string') return unchanged('durable-record-incomplete')
    body = JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    })
  } catch {
    return unchanged('durable-record-incomplete')
  }

  const request = deps.request || boundedFetch
  let response
  try {
    response = await requestWithinBudget(request, endpointUrl(endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch (error) {
    return unchanged(timeoutError(error) ? 'endpoint-timeout' : 'endpoint-failed')
  }
  if (response == null || response?.ok === false || (Number.isFinite(Number(response?.status)) && Number(response.status) >= 400)) {
    return unchanged('endpoint-failed')
  }

  let raw
  try { raw = await responseBody(response) } catch { return unchanged('response-read-failed') }
  let proposal
  try { proposal = proposalFromResponse(raw) } catch { return unchanged('response-invalid') }
  if (!proposal.ok) return unchanged(proposal.reason)

  try {
    const result = ledger.recordEscalationProposal({
      adw_id: adwId,
      proposed_cause: proposal.proposed_cause,
      proposed_by: model,
      proposed_evidence: proposal.evidence,
    })
    if (!result || typeof result.recorded !== 'boolean' || typeof result.reason !== 'string') {
      return unchanged('ledger-result-invalid')
    }
    return result
  } catch {
    return unchanged('ledger-write-failed')
  }
}

/** Load one crew archive and run the optional consumer against it. */
export async function runEscalationTriage(input = {}, deps = {}) {
  const config = typeof input === 'string' ? { crewDir: input } : (input && typeof input === 'object' ? input : {})
  let ledger = config.ledger || deps.ledger || null
  let ownedLedger = false
  try {
    if (!ledger) {
      const dbPath = config.dbPath || deps.dbPath || defaultDbPath()
      ledger = openLedger({ dbPath })
      ownedLedger = true
    }
    const durableRecord = config.durableRecord || loadDurableEscalationRecord({ crewDir: config.crewDir, ledger }, deps)
    const endpoint = config.endpoint ?? deps.endpoint ?? process.env[CREW_TRIAGE_ENDPOINT]
    const model = config.model ?? deps.model ?? process.env[CREW_TRIAGE_MODEL]
    return await triageEscalation({ durableRecord, endpoint, model, ledger }, deps)
  } catch {
    return unchanged('triage-failed')
  } finally {
    if (ownedLedger) {
      try { ledger?.close?.() } catch {}
    }
  }
}

const mainPath = process.argv[1]
if (mainPath && mainPath === fileURLToPath(import.meta.url)) {
  const crewDir = process.argv[2]
  let result
  try {
    result = await runEscalationTriage({ crewDir })
  } catch {
    result = unchanged('triage-failed')
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = 0
}
