// The builder-seat advisor: deterministic audit predicates plus a bounded,
// optional local-model judgment channel. It registers no callable surface: the
// only pi integration is observation of tool boundaries and boundary advice.
//
// Why .ts: pi loads extensions through jiti with no build step, while this
// repository imports the file directly with Node's erasable type stripping.
// The file therefore uses only erasable syntax and node:-only imports.
//
// Why zero-dep: pi is not a dependency of this checkout. Keeping the extension
// self-contained makes its closed configuration and endpoint boundary testable
// by this repository without importing pi's private runtime.
//
// Both event handlers are ordinary functions returning undefined. A note is
// advice with no authority: it carries no verdict, no interruption severity,
// no automatic resume, and no mid-turn poke; delivery happens only at a tool
// boundary.
//
// The emission guard is a behavioural re-authoring of the discipline described
// by oh-my-pi issue #3520 (309 notes, 114 containing the literal word Stop).
// No oh-my-pi source is copied here and no holder-specific licence notice is
// invented: that checkout is not present in the build environment.

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readFileSync, readSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { journalPathOf, plannerReturnNumber, plannerReturnsDirOf } from '../context-layout.mjs'
import { resolvePiBinary, createStreamReducer, carriesOwnSpend, STREAM_CAP_BYTES } from './subagent.ts'
import { modelString } from '../../adapters/adapter-pi.mjs'

export const ADVISOR_CONFIG_VERSION = 1
export const ADVISOR_GRANT_ENV = 'CREW_ADVISOR'
// Why the delta this endpoint receives is scrubbed before it is stored (#649).
// The endpoint is a llama.cpp box we own, today, on our own LAN — materially
// weaker exposure than a vendor API. But the ratified deployment shape is
// "LAN first", and "first" is a word that anticipates widening. The delta is
// assembled from whatever the builder happened to touch, which is not a bounded
// set. A redaction pass is cheap now and is the thing that makes widening a
// configuration change rather than a disclosure. It is not being added because
// the current endpoint is untrusted; it is being added so that the boundary does
// not depend on the endpoint staying trusted.
export const ADVISOR_ENDPOINT_ENV = 'CREW_ADVISOR_ENDPOINT'
export const ADVISOR_MODEL_ENV = 'CREW_ADVISOR_MODEL'
export const ADVISOR_MESSAGE_TYPE = 'crew-advisor'
export const TRIPWIRE_MANIFEST_FILE = 'advisor-manifest.json'
export const ADVISED_ROLES = Object.freeze(new Set(['builder', 'planner']))

export const SCOPE_BREACH = 'scope-breach'
export const TRIPWIRE_TOUCH = 'tripwire-touch'
export const REPEATED_FAILURE = 'repeated-failure'
export const GROWTH_DIVERGENCE = 'growth-divergence'
export const TIER0_KINDS = Object.freeze([SCOPE_BREACH, TRIPWIRE_TOUCH, REPEATED_FAILURE, GROWTH_DIVERGENCE])
// Separate from the four mechanical kinds: a model finding is not a predicate.
export const TIER1_FINDING = 'tier1-finding'
export const TRIGGERS = Object.freeze(['tier0-note', 'cadence', 'diff-growth', 'pre-return'])

export const REPEAT_FAILURE_THRESHOLD = 2
export const GROWTH_DIVERGENCE_RATIO = 2
export const GROWTH_FLOOR_BYTES = 120_000
export const CADENCE_CALLS = 25
export const TIER1_MAX_CONSULTS = 20
// Lines added plus removed against HEAD (untracked files counted) that the working diff must grow by, since the last consult, to queue one.
export const DIFF_GROWTH_LINES = 200
// An untracked file past this size is counted by an estimate rather than read.
const UNTRACKED_READ_CAP_BYTES = 1024 * 1024
// Past the read cap an untracked file's lines are counted by streaming up to this size; beyond it they are unknown.
const UNTRACKED_COUNT_CAP_BYTES = 64 * 1024 * 1024
const UNTRACKED_HEAD_BYTES = 64 * 1024

function readFileHead(path, bytes) {
  const fd = openSync(path, 'r')
  try { const buffer = Buffer.alloc(bytes); return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)) } finally { closeSync(fd) }
}

// Newlines in the file plus a last unterminated line, or null past the cap.
function countFileLines(path, cap) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let total = 0, count = 0, last = 10
    for (;;) {
      const got = readSync(fd, buffer, 0, buffer.length, null)
      if (!got) break
      total += got
      if (total > cap) return null
      for (let i = 0; i < got; i += 1) if (buffer[i] === 10) count += 1
      last = buffer[got - 1]
    }
    return total === 0 ? 0 : count + (last === 10 ? 0 : 1)
  } finally { closeSync(fd) }
}
// How long a trigger queued by a call's start waits for that call's own result before a later result sends it as orphaned.
const ORPHAN_PENDING_MS = 10 * 60 * 1000
export const DEDUPE_CAP = 256
export const SIGNATURE_CAP_BYTES = 256
export const NOTE_TEXT_CAP_BYTES = 4096
export const TARGET_CAP_BYTES = 256
export const DELTA_ENTRIES = 12
export const DELTA_ENTRY_CAP_BYTES = 512
export const EXCERPT_LINES = 12
export const READ_CAP_BYTES = 65_536
export const RESPONSE_CAP_BYTES = 65_536
export const CLAIM_CAP_BYTES = 500
export const EVIDENCE_MAX = 5
export const EVIDENCE_ITEM_CAP_BYTES = 200
export const PROBE_TIMEOUT_MS = 2000
export const CONSULT_TIMEOUT_MS = 20_000
// A judgment child that ignores SIGTERM gets SIGKILL after this grace, and a
// consult settles only once the child has closed (or a second grace has passed).
export const CHILD_KILL_GRACE_MS = 2_000
export const GIT_TIMEOUT_MS = 5000
export const DIFF_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export const JUDGMENT_CLASSES = Object.freeze(['edge-path', 'over-claim'])
export const SEVERITIES = Object.freeze(['low', 'medium', 'high'])
export const UNAVAILABLE_REASONS = Object.freeze([
  'role-unsupported', 'endpoint-unset', 'endpoint-not-local',
  'endpoint-credentials', 'model-unset', 'model-unsafe', 'endpoint-dead',
  'manifest-cell-invalid',
])
// A model id reaches a shell command line, so it is an allowlist, not a filter.
// A consult's advisor_usage spend is measured ONLY IF every frame the shared reducer
// counts as the child's own spend carries a complete usage: all four token classes
// present, each a non-negative safe integer. The shared reducer folds a missing usage
// or class to 0 (it serves other callers and keeps that contract), so this advisor-local
// check runs over the raw frames. A frame that is not own spend never counts here: zero
// own-spend frames keep the reducer's null and its usage-unavailable reason.
const ADVISOR_TOKEN_CLASSES = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])
export function ownSpendIncomplete(frame: any): boolean {
  if (!carriesOwnSpend(frame)) return false
  const usage = frame.message.usage
  if (!usage || typeof usage !== 'object') return true
  if (!ADVISOR_TOKEN_CLASSES.every((key) => Object.prototype.hasOwnProperty.call(usage, key))) return true
  return !ADVISOR_TOKEN_CLASSES.every((key) => !Object.prototype.hasOwnProperty.call(usage, key) || (Number.isSafeInteger(usage[key]) && usage[key] >= 0))
}

export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/
export const JUDGMENT_ERROR_CODES = Object.freeze([
  'transport-failed', 'timeout', 'status-not-ok', 'body-too-large', 'body-unreadable',
  'body-not-json', 'content-missing', 'payload-not-an-object', 'unknown-key',
  'class-invalid', 'severity-invalid', 'claim-invalid', 'evidence-invalid',
  'evidence-unanchored', 'no-grounded-delta', 'no-finding',
])
export const SUPPRESSION_CODES = Object.freeze(['duplicate', 'content-free', 'one-per-update'])

const DEFAULT_ROLE = 'builder'
const DEFAULT_NOW = () => new Date().toISOString()
const DEFAULT_READ = (path, encoding) => readFileSync(path, encoding)
const DEFAULT_APPEND = (path, text) => appendFileSync(path, text)

function unique(values) {
  return [...new Set(values)]
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

export function boundText(value, cap) {
  const text = String(value ?? '')
  if (byteLength(text) <= cap) return text
  const decoder = new StringDecoder('utf8')
  return decoder.write(Buffer.from(text, 'utf8').subarray(0, cap))
}

export function boundTarget(value) {
  return boundText(value, TARGET_CAP_BYTES)
}

export function journalPathFrom(taskDir, env) {
  return journalPathOf(taskDir, env)
}

export function returnsDirFrom(taskDir, env) {
  return plannerReturnsDirOf(taskDir, env)
}

function roleOf(env) {
  return String(env?.CREW_ROLE || DEFAULT_ROLE)
}

function atOf(now) {
  try { return now() } catch { return DEFAULT_NOW() }
}

function appendLine({ appendFile, journalPath, row }) {
  try {
    const result = appendFile(journalPath, `${JSON.stringify(row)}\n`)
    return result !== false
  } catch {
    return false
  }
}

function rowWithRole({ at, payloadKey, payload, role }) {
  return { at, [payloadKey]: payload, role }
}

function epochMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
    const date = Date.parse(value)
    if (Number.isFinite(date)) return date
  }
  return null
}

function manifestText({ taskDir, readFile }) {
  const path = join(String(taskDir || ''), TRIPWIRE_MANIFEST_FILE)
  let raw
  try { raw = readFile(path, 'utf8') } catch { return null }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  if (byteLength(text) > READ_CAP_BYTES) return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.schema_version !== ADVISOR_CONFIG_VERSION) return null
    if (epochMilliseconds(value.run_started_at) === null) return null
    if (!Array.isArray(value.tripwires) || !value.tripwires.every((item) => typeof item === 'string')) return null
    const rawCell = value.cell
    const cellKeys = ['provider', 'id', 'agent', 'effort', 'model']
    const cell = rawCell && typeof rawCell === 'object' && !Array.isArray(rawCell)
      && rawCell.agent === 'pi' && cellKeys.every((key) => typeof rawCell[key] === 'string' && SAFE_MODEL.test(rawCell[key]))
      ? Object.fromEntries(cellKeys.map((key) => [key, rawCell[key]])) : null
    return {
      schema_version: value.schema_version, run_started_at: value.run_started_at,
      tripwires: value.tripwires.map((item) => boundTarget(item)), cell,
      // A present cell that fails the allowlist is NOT a null (tier-0-only) cell.
      cell_invalid: rawCell != null && cell === null,
    }
  } catch { return null }
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

export function repoRelative(cwd, path) {
  if (typeof path !== 'string' || !path) return null
  let absolute
  try { absolute = resolve(String(cwd || ''), path) } catch { return null }
  let rel
  try { rel = normalizePath(relative(resolve(String(cwd || '')), absolute)) } catch { return null }
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return null
  return rel
}

export function scopeMatcher(files) {
  const entries = Array.isArray(files) ? files.map(normalizePath).filter(Boolean) : []
  return (path) => {
    const candidate = normalizePath(path)
    return entries.some((entry) => entry.endsWith('/') ? candidate.startsWith(entry) : candidate === entry)
  }
}

export function isTestFile(path) {
  return /\.test\.(mjs|js|ts)$/.test(String(path || ''))
}

function plannerReturn({ taskDir, manifest, deps, env }) {
  const epoch = epochMilliseconds(manifest?.run_started_at)
  if (epoch === null) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  const readDir = deps.readDir || readdirSync
  const fileMtime = deps.fileMtime || ((path) => {
    try { return statSync(path).mtimeMs } catch { return null }
  })
  let names
  try { names = readDir(returnsDirFrom(taskDir, env)) } catch { return { files_in_scope: [], validation_lane: null, source: 'absent' } }
  const candidates = []
  for (const name of names || []) {
    const number = plannerReturnNumber(name, env)
    if (number === null) continue
    const path = join(returnsDirFrom(taskDir, env), String(name))
    let mtime
    try { mtime = fileMtime(path) } catch { mtime = null }
    if (typeof mtime !== 'number' || !Number.isFinite(mtime) || mtime < epoch) continue
    candidates.push({ number, path })
  }
  candidates.sort((a, b) => b.number - a.number)
  const readFile = deps.readFile || DEFAULT_READ
  const candidate = candidates[0]
  if (!candidate) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  let raw
  try { raw = readFile(candidate.path, 'utf8') } catch { return { files_in_scope: [], validation_lane: null, source: 'absent' } }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
  if (byteLength(text) > READ_CAP_BYTES) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  let envelope
  try { envelope = JSON.parse(text) } catch { return { files_in_scope: [], validation_lane: null, source: 'absent' } }
  const details = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope.details : null
  if (!details || typeof details !== 'object' || Array.isArray(details)) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  const files = Array.isArray(details.files_in_scope)
    ? details.files_in_scope.filter((item) => typeof item === 'string').map(normalizePath)
    : []
  const lane = typeof details.validation_lane === 'string' && details.validation_lane.trim()
    ? details.validation_lane.trim() : null
  if (files.length === 0 && lane === null) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  return {
    files_in_scope: files, validation_lane: lane,
    source: files.length ? `planner-return-${candidate.number}` : 'absent',
  }
}

export function loadContext({ taskDir, deps = {}, env = process.env } = {}) {
  const readFile = deps.readFile || DEFAULT_READ
  const manifest = manifestText({ taskDir, readFile })
  if (!manifest) {
    return {
      files_in_scope: [], validation_lane: null, scope_source: 'absent',
      tripwires: [], tripwires_source: 'absent', run_started_at: null, cell: null,
    }
  }
  const planner = plannerReturn({ taskDir, manifest, deps, env })
  return {
    files_in_scope: planner.files_in_scope,
    validation_lane: planner.validation_lane,
    scope_source: planner.source,
    tripwires: manifest.tripwires,
    tripwires_source: 'manifest',
    run_started_at: manifest.run_started_at, cell: manifest.cell,
  }
}

function manifestEpoch({ taskDir, readFile }) {
  return manifestText({ taskDir, readFile })?.run_started_at
}

function epochKey(value) {
  if (value === null || value === undefined) return null
  return `${typeof value}:${String(value)}`
}

function contentOf(event) {
  const content = Array.isArray(event?.content) ? event.content : []
  return content.filter((part) => part && part.type === 'text').map((part) => String(part.text ?? '')).join('')
}

function inputPath(input) {
  return typeof input?.path === 'string' ? input.path : null
}

function splitSegments(command) {
  return String(command ?? '').split(/&&|\|\||[;|\n]/).map((segment) => segment.trim()).filter(Boolean)
}

export function isValidationCommand(command, lane) {
  const expected = typeof lane === 'string' ? lane.trim() : ''
  for (const segment of splitSegments(command)) {
    if (expected && (segment === expected || segment.startsWith(`${expected} `))) return true
    if (/^npm\s+test(?:\s|$)/.test(segment)) return true
    if (/^node\s+--test(?:\s|$)/.test(segment)) return true
  }
  return false
}

function removeDurations(value) {
  return String(value ?? '')
    .replace(/duration_ms\s*[:=]\s*\d+(?:\.\d+)?/gi, '')
    .replace(/\b\d+(?:\.\d+)?ms\b/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*#\s*$/g, '')
    .replace(/^\s*\d+\s+(?:[-:.]\s*)?/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function failureSignature(text) {
  const source = String(text ?? '')
  const match = source.match(/^not ok \d+ - (.+)$/m)
    || source.match(/^\s*✖\s+(.+)$/m)
    || source.match(/^\s*(AssertionError.*)$/m)
    || source.match(/^\s*(Error: .+)$/m)
  if (!match) return null
  const cleaned = boundText(removeDurations(match[1]), SIGNATURE_CAP_BYTES)
  return cleaned || null
}

export function failureTarget(text, cwd) {
  const source = String(text ?? '')
  const location = source.match(/location\s*:\s*['"]([^'"]+?)['"]/i)
  const frame = source.match(/\bat\s+(?:file:\/\/)?([^\s)]+?:\d+(?::\d+)?)/)
  const raw = location?.[1] || frame?.[1]
  if (!raw) return null
  let withoutLine = String(raw).replace(/:\d+(?::\d+)?$/, '')
  if (withoutLine.startsWith('file://')) {
    try { withoutLine = new URL(withoutLine).pathname } catch { return null }
  }
  return boundTarget(repoRelative(cwd, withoutLine) || '') || null
}

function errorCodeSet(codes) {
  return unique(codes).filter((code) => JUDGMENT_ERROR_CODES.includes(code))
}

export function normalizeNote(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function isContentFree(normalized) {
  const value = normalizeNote(normalized)
  return value.length < 12 || new Set([
    'stop', 'stopped', 'done', 'ok', 'okay', 'lgtm', 'looks good',
    'no issues', 'nothing', 'n a', 'fine', 'continue', 'proceed',
  ]).has(value)
}

export function isSelfEcho(text, injected) {
  const normalized = normalizeNote(text)
  if (!normalized) return false
  const values = injected instanceof Set ? injected : new Set(injected || [])
  for (const note of values) {
    if (note && normalized === String(note)) return true
  }
  return false
}

// pi resolves a provider it has no login for by fuzzy match (openai/... reached openrouter), so a roster provider is
// spelled as pi seats spell it; a cell outside the roster's providers passes through as written, as it always has.
function consultModel(cell) {
  try { return modelString({ provider: cell.provider, id: cell.id }) } catch { return String(cell.model) }
}

function cellIdentity(cell) { return { provider: cell.provider, model_id: cell.id, agent: cell.agent, effort: cell.effort, model: cell.model } }

function addFifo(set, value, cap) {
  if (set.has(value)) return
  set.add(value)
  while (set.size > cap) set.delete(set.values().next().value)
}

function anchorFromLine(line) {
  const match = String(line).match(/^([^\s:]+(?:\/[^\s:]+)*):(\d+):\s/)
  return match ? `${match[1]}:${match[2]}` : null
}

function excerptText({ path, content, line }) {
  const lines = String(content ?? '').split('\n')
  const start = Math.max(0, Number(line || 1) - 1)
  const selected = lines.slice(start, start + EXCERPT_LINES)
  return selected.map((item, index) => `${path}:${start + index + 1}: ${item}`).join('\n')
}

export function stripAdvisorNotes(text, injected) {
  let cleaned = String(text ?? '')
  const values = injected instanceof Set ? injected : new Set(injected || [])
  for (const note of values) {
    if (!note) continue
    const words = String(note).split(/\s+/).filter(Boolean)
    if (!words.length) continue
    const sequence = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+')
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${sequence}(?![\\p{L}\\p{N}])`, 'giu')
    cleaned = cleaned.replace(pattern, '')
  }
  return cleaned.trim() ? cleaned : ''
}

function entryFromText(text) {
  const bounded = boundText(text, DELTA_ENTRY_CAP_BYTES)
  const anchors = new Set()
  for (const line of bounded.split('\n')) {
    const anchor = anchorFromLine(line)
    if (anchor) anchors.add(anchor)
  }
  return { text: bounded, anchors: [...anchors] }
}

// --- delta redaction --------------------------------------------------------
// High-signal shapes only, each named. The bias is deliberately toward
// UNDER-redacting: the advisor's whole value is grounded, specific advice, and a
// delta scrubbed into mush produces confident advice about nothing — a failure
// that is invisible, unlike a miss. A shape that would plausibly match ordinary
// source code is left out, and each omission is stated where it is made.
export const redactionPlaceholder = (kind) => `<redacted:${kind}>`

// A value only counts as a credential when it mixes a digit and an upper-case
// letter. Measured over this checkout, that one requirement is the difference
// between redacting a single planted fixture secret and also redacting
// `payloadKey: 'advisor_unavailable'` and `const UNKNOWN_KEY = 'unknown-key'`,
// which are ordinary code. An all-lowercase secret is under-redacted on purpose.
const CREDENTIAL_VALUE_STRENGTH = /(?=.*[0-9])(?=.*[A-Z])/

// Order is meaning: the first shape that recognises a run of text owns it, so a
// token inside an Authorization header is reported as the header and counted
// once. No value class admits `<`, so a placeholder already written cannot be
// re-matched by a later rule.
const REDACTION_RULES = Object.freeze([
  // A PEM private key block, BEGIN line through its END line. Nothing in
  // ordinary source carries one, and the block is matched whole so no fragment
  // of the key body survives.
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:[A-Z][A-Z ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z][A-Z ]*)?PRIVATE KEY-----/g,
    render: () => redactionPlaceholder('private-key'),
  },
  // An Authorization header value. The header NAME is kept so the shape stays
  // legible to the model; only the credential after the colon is removed.
  {
    kind: 'authorization',
    pattern: /(Authorization\s*:\s*)([^\r\n<]+)/gi,
    render: (m) => `${m[1]}${redactionPlaceholder('authorization')}`,
  },
  // A bearer credential anywhere else. The `Bearer ` marker is unambiguous and
  // ordinary source does not carry a 12-character opaque run behind it.
  {
    kind: 'bearer-token',
    pattern: /(Bearer\s+)([A-Za-z0-9._~+\/=-]{12,})/gi,
    render: (m) => `${m[1]}${redactionPlaceholder('bearer-token')}`,
  },
  // An assignment to a name containing KEY, TOKEN, SECRET, PASSWORD, PASSWD or
  // CREDENTIAL whose value is a quoted literal — the env-var, JSON-field and
  // `k = v` forms all reduce to this one shape. The strength requirement above
  // is what keeps ordinary constants out.
  {
    kind: 'credential',
    pattern: /((?:^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_-]*\s*[:=]\s*)(["'`])([A-Za-z0-9_.\/+=~-]{16,})\2/gi,
    strong: 3,
    render: (m) => `${m[1]}${m[2]}${redactionPlaceholder('credential')}${m[2]}`,
  },
  // The same assignment unquoted, which is the dotenv and shell-export form.
  {
    kind: 'credential',
    pattern: /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*=)([A-Za-z0-9_.\/+=~-]{16,})/gi,
    strong: 2,
    render: (m) => `${m[1]}${redactionPlaceholder('credential')}`,
  },
  // A JWT: three base64url segments whose FIRST is anchored to `eyJ`, the
  // base64url of `{"`. The generic three-segment form is deliberately not used —
  // it matches ordinary dotted code such as `a.b.c` — so a JWT whose header is
  // not JSON is under-redacted on purpose.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    render: () => redactionPlaceholder('jwt'),
  },
  // GitHub's own documented token prefixes plus their opaque body. Nothing in
  // source starts a 20-character alphanumeric run with `ghp_`.
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    render: () => redactionPlaceholder('github-token'),
  },
  // OpenAI-style keys: the `sk-` prefix and at least 16 opaque characters.
  {
    kind: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    render: () => redactionPlaceholder('openai-key'),
  },
  // Slack tokens. The bare `xox` trigram is too short to be unambiguous, so the
  // type letter and its dash are required.
  {
    kind: 'slack-token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
    render: () => redactionPlaceholder('slack-token'),
  },
])

// Returns the scrubbed text and a per-kind count of what was removed. Pure: the
// caller owns where it is applied, and it is applied at exactly one place.
export function redactDelta(value) {
  let text = String(value ?? '')
  const counts = {}
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2)
      if (rule.strong && !CREDENTIAL_VALUE_STRENGTH.test(String(groups[rule.strong] ?? ''))) return groups[0]
      counts[rule.kind] = (counts[rule.kind] || 0) + 1
      return rule.render(groups)
    })
  }
  return { text, counts }
}

function safeRead(readFile, path) {
  try {
    const raw = readFile(path, 'utf8')
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')
    return byteLength(text) > READ_CAP_BYTES ? boundText(text, READ_CAP_BYTES) : text
  } catch { return null }
}

function gitOverflow(err) {
  const code = String(err?.code || '')
  const message = String(err?.message || err || '')
  return code === 'ENOBUFS' || /maxbuffer|stdout maxBuffer|buffer length/i.test(`${code} ${message}`)
}

export function gitDiffSize({ cwd, deps = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null
  const exec = deps.execFileSync || execFileSync
  const statSize = deps.fileSize || ((path) => statSync(path).size)
  const run = (args) => exec('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES, encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let diff
  try { diff = run(['--no-pager', 'diff', 'HEAD']) } catch (err) {
    return gitOverflow(err) ? { bytes: DIFF_MAX_BUFFER_BYTES, truncated: true } : null
  }
  let untracked
  try { untracked = run(['ls-files', '--others', '--exclude-standard', '-z']) } catch (err) {
    return gitOverflow(err) ? { bytes: DIFF_MAX_BUFFER_BYTES, truncated: true } : null
  }
  const diffBytes = Buffer.isBuffer(diff) ? diff.length : byteLength(diff)
  const names = (Buffer.isBuffer(untracked) ? untracked.toString('utf8') : String(untracked ?? '')).split('\0').filter(Boolean)
  let bytes = diffBytes
  try {
    for (const name of names) bytes += Number(statSize(resolve(String(cwd || ''), name))) || 0
  } catch { return null }
  return { bytes, truncated: false }
}

function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// The lane checkout's working diff against HEAD, untracked files included, as a line count (added plus removed)
// and as grounded `path:line: text` entries (one per changed file) the consult's delta can anchor to.
// null when git cannot say: the seat is unaffected.
export function gitDiffLines({ cwd, deps = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd) return null
  const exec = deps.execFileSync || execFileSync
  const read = deps.readFileBytes || ((path) => readFileSync(path))
  const statSize = deps.fileSize || ((path) => statSync(path).size)
  const head = deps.readFileHead || readFileHead
  const countLines = deps.countFileLines || countFileLines
  const run = (args) => exec('git', args, {
    cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES, encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const asText = (value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  let diff, untracked
  try { diff = asText(run(['-c', 'core.quotepath=off', '--no-pager', 'diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD'])) } catch (err) {
    return gitOverflow(err) ? { lines: DIFF_MAX_BUFFER_BYTES, text: '', entries: [], truncated: true } : null
  }
  try { untracked = asText(run(['ls-files', '--others', '--exclude-standard', '-z'])) } catch (err) {
    return gitOverflow(err) ? { lines: DIFF_MAX_BUFFER_BYTES, text: '', entries: [], truncated: true } : null
  }
  let lines = 0
  const files = new Map()
  let current = null
  let removed = null
  let header = false
  let newLine = 0
  let oldLine = 0
  const keep = (name, text) => {
    if (!files.has(name)) files.set(name, [])
    const kept = files.get(name)
    if (kept.length < EXCERPT_LINES) kept.push(text)
  }
  for (const row of diff.split('\n')) {
    // '--- ' and '+++ ' are file headers only before a file's first hunk; inside a hunk they are content.
    if (row.startsWith('diff --git ')) { current = null; removed = null; header = true; continue }
    if (header && row.startsWith('+++ ')) {
      const name = row.slice(4).replace(/\t.*$/, '')
      if (name !== '/dev/null') { current = name.replace(/^b\//, ''); if (!files.has(current)) files.set(current, []) }
      continue
    }
    // A removed line is grounded at its old path and line, so a deletion-only change can still be reviewed.
    if (header && row.startsWith('--- ')) {
      const name = row.slice(4).replace(/\t.*$/, '')
      removed = name === '/dev/null' ? null : name.replace(/^a\//, '')
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk) { header = false; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue }
    if (header) continue
    if (row.startsWith('+')) {
      lines += 1
      const kept = current === null ? null : files.get(current)
      if (kept && kept.length < EXCERPT_LINES) kept.push(`${current}:${newLine}: ${row.slice(1)}`)
      newLine += 1
    } else if (row.startsWith('-')) {
      lines += 1
      if (removed !== null) keep(removed, `${removed}:${oldLine}: (removed) ${row.slice(1)}`)
      oldLine += 1
    }
  }
  const entries = [...files.values()].filter((kept) => kept.length).map((kept) => kept.join('\n'))
  let unknown = false
  try {
    for (const name of untracked.split('\0').filter(Boolean)) {
      const absolute = resolve(String(cwd), name)
      const size = Number(statSize(absolute)) || 0
      // Past the read cap only the head is read and the lines are counted by streaming; past the count cap they are
      // unknown, reported as the overflow shape, never as zero and never estimated.
      const large = size > UNTRACKED_READ_CAP_BYTES
      const buffer = large ? head(absolute, UNTRACKED_HEAD_BYTES) : read(absolute)
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''))
      if (bytes.includes(0)) continue
      const text = bytes.toString('utf8')
      if (!text) continue
      const rows = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
      const counted = large ? countLines(absolute, UNTRACKED_COUNT_CAP_BYTES) : rows.length
      if (counted === null) unknown = true
      else lines += counted
      entries.push(rows.slice(0, EXCERPT_LINES).map((item, index) => `${name}:${index + 1}: ${item}`).join('\n'))
    }
  } catch { return null }
  if (unknown) return { lines: DIFF_MAX_BUFFER_BYTES, text: entries.join('\n'), entries, truncated: true }
  return { lines, text: entries.join('\n'), entries, truncated: false }
}

export async function probeEndpoint(url, { fetchFn = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response?.status < 500
  } catch { return false }
}

function classifyAdvisorModel(model, models) {
  if (typeof model !== 'string' || model === '') return { reason: 'model-unset' }
  if (!SAFE_MODEL.test(model) || !model.includes('/')) return { reason: 'model-unsafe' }
  if (!models || typeof models !== 'object' || Array.isArray(models)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(models))) return { reason: 'model-unsafe' }
  const roster = { models }
  if (!Object.hasOwn(roster.models, model)) return { reason: 'model-unsafe' }
  return { model }
}

export function classifyAdvisorCell({ endpoint, model, models } = {}) {
  if (endpoint === '' || endpoint === undefined) return classifyAdvisorModel(model, models)
  if (typeof endpoint !== 'string') return { reason: 'endpoint-unset' }
  let parsed
  try { parsed = new URL(endpoint) } catch { return { reason: 'endpoint-not-local' } }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\/?#]*)/.exec(endpoint)?.[1] || ''
  const hostText = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const rawHost = hostText.startsWith('[') ? hostText.slice(0, hostText.indexOf(']') + 1) : hostText.split(':')[0]
  if (!['http:', 'https:'].includes(parsed.protocol) || rawHost === '') {
    return { reason: 'endpoint-not-local' }
  }
  if (parsed.username || parsed.password) return { reason: 'endpoint-credentials' }
  if (typeof model !== 'string' || model === '') return { reason: 'model-unset' }
  if (!SAFE_MODEL.test(model)) return { reason: 'model-unsafe' }
  return { endpoint: parsed.href, model }
}

export function advisorCell(env = process.env) {
  let models = env?.CREW_ADVISOR_MODELS
  if (typeof models === 'string') {
    try { models = JSON.parse(models) } catch { models = undefined }
  }
  return { endpoint: env?.[ADVISOR_ENDPOINT_ENV], model: env?.[ADVISOR_MODEL_ENV], models }
}

function abortSignal(controller) {
  const timeout = AbortSignal.timeout(CONSULT_TIMEOUT_MS)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([controller.signal, timeout])
  return controller.signal
}

export async function readBoundedBody(response, cap = RESPONSE_CAP_BYTES) {
  const header = response?.headers?.get?.('content-length')
  const length = Number(header)
  if (Number.isFinite(length) && length > cap) return { ok: false, code: 'body-too-large' }
  let reader
  try { reader = response?.body?.getReader?.() } catch { return { ok: false, code: 'body-unreadable' } }
  if (!reader) return { ok: false, code: 'body-unreadable' }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part?.done) break
      const value = part?.value
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
      total += chunk.length
      if (total > cap) {
        try { await reader.cancel?.() } catch { /* cancellation is best effort */ }
        return { ok: false, code: 'body-too-large' }
      }
      chunks.push(chunk)
    }
  } catch { return { ok: false, code: 'body-unreadable' } }
  try { return { ok: true, text: Buffer.concat(chunks, total).toString('utf8') } } catch { return { ok: false, code: 'body-unreadable' } }
}

export const JUDGMENT_REPLY_MAX = 4

export function validateReply(value, options = {}) {
  if (!Array.isArray(value)) return validateJudgment(value, options)
  if (!value.length) return { codes: ['no-finding'] }
  if (value.length > JUDGMENT_REPLY_MAX) return { codes: ['payload-not-an-object'] }
  const codes = []
  let best = null
  // The most severe valid finding is the one judged: a high finding after a medium one must not be lost.
  for (const element of value) {
    const verdict = validateJudgment(element, options)
    if (!verdict.judgment) { codes.push(...verdict.codes); continue }
    if (!best || SEVERITIES.indexOf(verdict.judgment.severity) > SEVERITIES.indexOf(best.judgment.severity)) best = verdict
  }
  return best ?? { codes: errorCodeSet(codes) }
}

export function validateJudgment(value, { anchors = new Set(), scopeFiles = [] } = {}) {
  const codes = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { codes: ['payload-not-an-object'] }
  const allowed = new Set(['class', 'severity', 'claim', 'evidence'])
  if (Object.keys(value).some((key) => !allowed.has(key))) codes.push('unknown-key')
  if (!JUDGMENT_CLASSES.includes(value.class)) codes.push('class-invalid')
  if (!SEVERITIES.includes(value.severity)) codes.push('severity-invalid')
  if (typeof value.claim !== 'string' || value.claim.trim() === '' || byteLength(value.claim) > CLAIM_CAP_BYTES) codes.push('claim-invalid')
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > EVIDENCE_MAX
    || value.evidence.some((item) => typeof item !== 'string' || byteLength(item) > EVIDENCE_ITEM_CAP_BYTES || !/^[^\s:]+:\d+$/.test(item))) {
    codes.push('evidence-invalid')
  } else if (!anchors.has(value.evidence[0])) {
    const file = String(value.evidence[0]).split(':')[0]
    const scoped = Array.isArray(scopeFiles) && scopeFiles.some((entry) => {
      const normalized = normalizePath(entry)
      return normalized.endsWith('/') ? file.startsWith(normalized) : file === normalized
    })
    if (!scoped) codes.push('evidence-unanchored')
  }
  return { codes: errorCodeSet(codes), ...(codes.length ? {} : { judgment: value }) }
}

function responseContent(payload) {
  const content = payload?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : null
}

function requestUrl(endpoint) {
  return `${String(endpoint).replace(/\/+$/, '')}/chat/completions`
}

const REPLY_CONTRACT = `Return JSON alone: one object or an array of 1 to ${JUDGMENT_REPLY_MAX} objects, with no prose, no code fence, no wrapper key and no second object on another line. Each object has exactly the four keys class, severity, claim and evidence. class must be one of ${JUDGMENT_CLASSES.join(', ')}. severity must be one of ${SEVERITIES.join(', ')}. claim must be a non-empty string of at most ${CLAIM_CAP_BYTES} UTF-8 bytes. evidence must be an array of 1 to ${EVIDENCE_MAX} strings, each at most ${EVIDENCE_ITEM_CAP_BYTES} UTF-8 bytes and exactly a bare path:line (no range, no prose, no whitespace or colon in the path; decimal line number). The first evidence item must cite a line shown in the delta. Do not copy the example's evidence unless that line is shown in the delta. Example reply: {"class":"edge-path","severity":"low","claim":"The empty input path is not handled.","evidence":["src/widget.mjs:12"]} If neither class applies, return [] alone.`

export const BUILDER_SYSTEM_PROMPT = `Review the builder delta for exactly two judgment classes: edge-path (checklist B1: answer EPERM, unknown, interrupted, and empty paths) and over-claim (checklist B2: record no verdict stronger than what was measured). ${REPLY_CONTRACT}`
export const PLANNER_SYSTEM_PROMPT = `Review the planner delta for exactly two judgment classes: edge-path (a plan or gate omits or mishandles a required boundary, failure case, or acceptance path) and over-claim (a Ground truth citation that does not hold at the ref where the plan was written). ${REPLY_CONTRACT}`

function systemPrompt(role) {
  return role === 'planner' ? PLANNER_SYSTEM_PROMPT : BUILDER_SYSTEM_PROMPT
}

function noteTextForTier0(kind, target, signature, role) {
  if (kind === REPEATED_FAILURE) return `Repeated validation failure at ${target || 'an unknown location'}: ${signature || 'the same failure signature recurred'}`
  if (kind === SCOPE_BREACH) return `The ${role} seat touched ${target || 'an unknown path'} outside the declared scope.`
  if (kind === TRIPWIRE_TOUCH) return `The ${role} seat touched the declared tripwire ${target || 'an unknown path'}.`
  return 'The repository growth crossed the measured divergence threshold.'
}

export const REPLY_EXCERPT_CAP_BYTES = 512
export const REPLY_REASONS = Object.freeze(['timeout', 'transport-failed', 'body-too-large', 'body-not-json', 'content-missing', 'reply-unrecorded'])

export function createAdvisor({ env = process.env, deps = {} } = {}) {
  const role = roleOf(env)
  const digest = deps.digest || ((text) => createHash('sha256').update(text).digest('hex'))
  const taskDir = deps.taskDir || env?.CREW_TASK_DIR || ''
  const cwd = deps.cwd || process.cwd()
  const now = deps.now || DEFAULT_NOW
  const appendFile = deps.appendFile || DEFAULT_APPEND
  const readFile = deps.readFile || DEFAULT_READ
  const readDir = deps.readDir || readdirSync
  const fileMtime = deps.fileMtime || ((path) => {
    try { return statSync(path).mtimeMs } catch { return null }
  })
  const fetchFn = deps.fetchFn || fetch
  const spawn = deps.spawn || nodeSpawn
  const resolveBinary = deps.resolveBinary || resolvePiBinary
  const consultTimeoutMs = deps.consultTimeoutMs ?? CONSULT_TIMEOUT_MS
  const childKillGraceMs = deps.childKillGraceMs ?? CHILD_KILL_GRACE_MS
  const scheduleTimeout = deps.setTimeout || setTimeout
  const cancelTimeout = deps.clearTimeout || clearTimeout
  const send = deps.send || null
  const diffSize = deps.diffSize || ((path) => gitDiffSize({ cwd: path, deps }))
  const diffLines = deps.diffLines || ((path) => gitDiffLines({ cwd: path, deps }))
  const journalPath = journalPathFrom(taskDir, env)

  function replyRecord(replyText, codes) {
    const reason = codes.find((code) => REPLY_REASONS.includes(code)) || 'reply-unrecorded'
    if (typeof replyText !== 'string' || !replyText) return { reply: null, reply_reason: reason }
    try {
      const redacted = redactDelta(replyText).text
      return { reply: { sha256: digest(redacted), bytes: byteLength(redacted), excerpt: boundText(redacted, REPLY_EXCERPT_CAP_BYTES) } }
    } catch { return { reply: null, reply_reason: 'reply-unrecorded' } }
  }

  function contentIdentity(text) {
    const content_excerpt = boundText(text, REPLY_EXCERPT_CAP_BYTES)
    try { return { content_sha256: digest(text), content_excerpt } } catch { return { content_excerpt } }
  }

  let context = null
  let contextEpoch = null
  let contextRowEpoch = null
  let generation = 0
  let calls = 0
  const callOrdinals = new Map()
  let consults = 0
  let growthBaseline = null
  let diffBaselineLines = null
  let preReturnSpent = false
  // false, or the token of the maybe-return call that holds the turn's one maybe consult.
  let preReturnMaybeSpent = false
  let delta = []
  let anchors = new Set()
  let fired = new Set()
  let failureCounts = new Map()
  let pending = new Map()
  let inFlight = new Set()
  let controllers = new Set()
  let notes = []
  let injected = new Set()
  let dedupe = new Set()
  let acceptedEvents = new Set()

  function appendAdvisorRow(payloadKey, payload) {
    return appendLine({
      appendFile, journalPath,
      row: rowWithRole({ at: atOf(now), payloadKey, payload, role }),
    })
  }

  function resetForEpoch() {
    for (const controller of controllers) {
      try { controller.abort() } catch { /* already settled */ }
    }
    controllers.clear()
    generation += 1
    fired = new Set()
    failureCounts = new Map()
    growthBaseline = null
    diffBaselineLines = null
    preReturnSpent = false
    preReturnMaybeSpent = false
    delta = []
    anchors = new Set()
    injected = new Set()
    dedupe = new Set()
    pending = new Map()
    consults = 0
    acceptedEvents = new Set()
    notes = []
  }

  function ensureContext() {
    const freshEpoch = manifestEpoch({ taskDir, readFile })
    const freshKey = epochKey(freshEpoch)
    if (freshKey !== contextEpoch) {
      if (contextEpoch !== null) resetForEpoch()
      contextEpoch = freshKey
      context = null
      contextRowEpoch = null
    }
    const fresh = loadContext({ taskDir, env, deps: { ...deps, readFile, readDir, fileMtime } })
    if (freshKey === null) return fresh
    context = fresh
    if (contextRowEpoch !== freshKey && fresh.scope_source !== 'absent') {
      const row = {
        run_started_at: fresh.run_started_at,
        scope_source: fresh.scope_source,
        scope_count: fresh.files_in_scope.length,
        lane_available: typeof fresh.validation_lane === 'string' && fresh.validation_lane.length > 0,
        tripwires_source: fresh.tripwires_source,
        tripwires_count: fresh.tripwires.length,
      }
      appendAdvisorRow('advisor_context', row)
      contextRowEpoch = freshKey
    }
    return fresh
  }

  function currentContext() {
    return context || ensureContext()
  }

  // A write inside the lane's task dir (e.g. the builder's return file) is never a scope breach.
  function inTaskDir(rawPath) {
    if (!taskDir || typeof rawPath !== 'string' || !rawPath) return false
    try {
      const rel = relative(resolve(String(taskDir)), resolve(cwd, rawPath))
      return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
    } catch { return false }
  }

  function targetForInput(input) {
    const raw = inputPath(input)
    return boundTarget(repoRelative(cwd, raw) || normalizePath(raw || ''))
  }

  function deltaPath(path) {
    const repoPath = repoRelative(cwd, path)
    if (repoPath) return repoPath
    if (role !== 'planner' || !taskDir || typeof path !== 'string' || !path) return ''
    let taskPath
    try {
      const root = resolve(String(taskDir))
      taskPath = normalizePath(relative(root, resolve(cwd, path)))
    } catch { return '' }
    if (taskPath === 'plan.md' || taskPath === 'gate.mjs') return `task/${taskPath}`
    return ''
  }

  function emitTier0({ kind, target, targetKind, signature, trigger = 'predicate', callOrdinal = calls }) {
    const cleanTarget = boundTarget(target || '')
    const key = `${kind}\0${cleanTarget}`
    if (fired.has(key)) return false
    fired.add(key)
    const tier0Stamp = { call_ordinal: calls }
    if (callOrdinal !== calls) tier0Stamp.call_ordinal = callOrdinal
    const payload = {
      run_started_at: context?.run_started_at ?? null,
      tier: 0, trigger, kind, target: cleanTarget, target_kind: targetKind, ...tier0Stamp,
      role, outcome: 'injected',
      ...(signature ? { signature: boundText(signature, SIGNATURE_CAP_BYTES) } : {}),
    }
    const tier0Text = noteTextForTier0(kind, cleanTarget, payload.signature, role)
    Object.assign(payload, contentIdentity(tier0Text))
    const ok = appendAdvisorRow('advisor_note', payload)
    if (!ok) return false
    notes.push(payload)
    rememberInjected(normalizeNote(tier0Text))
    try {
      const delivered = send?.({ customType: ADVISOR_MESSAGE_TYPE, content: tier0Text, display: true, details: payload }, { deliverAs: 'steer' })
      delivered?.catch?.(() => {})
    } catch {}
    return true
  }

  function nowMs() {
    const parsed = Date.parse(String(atOf(now)))
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  function queue(id, trigger, callOrdinal = calls) {
    if (!id || !TRIGGERS.includes(trigger)) return
    const list = pending.get(String(id)) || []
    if (!list.some((entry) => entry.trigger === trigger)) list.push({ trigger, call_ordinal: callOrdinal, queued_at: nowMs() })
    pending.set(String(id), list)
  }

  function measureDiff() {
    let value
    try { value = diffSize(cwd) } catch { value = null }
    if (!value || typeof value !== 'object' || !Number.isFinite(value.bytes) || value.bytes < 0) return null
    return { bytes: Number(value.bytes), truncated: value.truncated === true }
  }

  function measureDiffLines() {
    let value
    try { value = diffLines(cwd) } catch { value = null }
    if (!value || typeof value !== 'object' || !Number.isFinite(value.lines) || value.lines < 0) return null
    const entries = Array.isArray(value.entries) ? value.entries.map(String) : [String(value.text ?? '')]
    return { lines: Number(value.lines), entries: entries.filter(Boolean).slice(0, DELTA_ENTRIES) }
  }

  // Whether a call writes the seat's return file `<taskDir>/<role>-<n>.json`: 'sure', 'maybe', or null. A Write/Edit
  // names it exactly. A Bash command names it through a path token ending in the return file's name, resolved against
  // the last cd before it (itself resolved against the seat's cwd). When those cds cannot be followed (a subshell,
  // pushd/popd, a quoted cd operand with whitespace), a token without an absolute path is 'maybe': it is consulted on,
  // but it never spends the turn's pre-return consult, so a later sure return write is still reviewed. At most one
  // maybe is consulted on per turn, so maybes cannot use up the consults a sure return needs.
  function returnWrite(event) {
    if (!taskDir || !role) return null
    const tool = String(event?.toolName || '')
    const input = event?.input || {}
    try {
      const root = resolve(String(taskDir))
      const name = new RegExp(`^${escapeRegExp(role)}-\\d+\\.json$`)
      if (tool === 'write' || tool === 'edit') {
        const raw = inputPath(input)
        if (!raw) return null
        const target = resolve(cwd, raw)
        return resolve(target, '..') === root && name.test(relative(root, target)) ? 'sure' : null
      }
      if (tool === 'bash') {
        const command = String(input.command ?? '')
        const cds = [...command.matchAll(/(?:^|[;&|(\s])cd\s+(['"]?)([^\s'";&|()]+)\1(?=$|[\s;&|)])/g)]
        const token = new RegExp(`(?:^|[\\s'"=<>])((?:[^\\s'"=<>;&|()]*/)?)(${escapeRegExp(role)}-\\d+\\.json)(?=$|[\\s'";&|)<>])`, 'g')
        const unfollowable = /[()]|\bpushd\b|\bpopd\b|\bcd\s+(['"])[^'"]*\s[^'"]*\1/.test(command)
        let kind = null
        for (const match of command.matchAll(token)) {
          if (unfollowable && !isAbsolute(match[1])) { kind = 'maybe'; continue }
          const before = cds.filter((cd) => cd.index < match.index)
          const dir = before.reduce((at, cd) => resolve(at, cd[2]), resolve(String(cwd)))
          if (resolve(dir, match[1] || '.', match[2]) === join(root, match[2])) return 'sure'
        }
        return kind
      }
    } catch { /* not a return write */ }
    return null
  }

  function growthCrossed(base, current) {
    if (!base || base.truncated || !current) return false
    const threshold = base.bytes === 0 ? GROWTH_FLOOR_BYTES : GROWTH_DIVERGENCE_RATIO * base.bytes
    if (current.truncated) return current.bytes >= threshold
    return current.bytes >= threshold
  }

  function appendDelta(entryText) {
    const text = String(entryText ?? '')
    if (!text) return
    if (isSelfEcho(text, injected)) return
    // The scrub lands HERE, at the one point every delta source passes through,
    // and not at the send: the stored entry, the frozen snapshot and anything
    // that ever reads either are then all the redacted form, and a fifth source
    // inherits the pass instead of having to remember it.
    const { text: scrubbed, counts } = redactDelta(text)
    const entry = entryFromText(scrubbed)
    if (!entry.text) return
    delta = [...delta, { ...entry, redactions: counts }].slice(-DELTA_ENTRIES)
    anchors = new Set(delta.flatMap((item) => item.anchors))
  }

  // What the scrub removed from the entries this consult is about to send. The
  // operator reading the advisor journal otherwise cannot tell a delta that
  // carried nothing sensitive from one that carried a private key.
  function redactionTally(entries) {
    const tally = {}
    for (const entry of entries) {
      for (const [kind, count] of Object.entries(entry.redactions || {})) tally[kind] = (tally[kind] || 0) + count
    }
    return tally
  }

  function editDelta(input) {
    const path = inputPath(input)
    if (!path) return ''
    const repoPath = deltaPath(path)
    if (!repoPath) return ''
    const absolute = resolve(cwd, path)
    const content = safeRead(readFile, absolute)
    if (content === null) return ''
    const edit = Array.isArray(input?.edits) ? input.edits[0] : null
    const needle = typeof edit?.newText === 'string' ? edit.newText : ''
    const index = needle ? content.indexOf(needle) : 0
    const line = index >= 0 ? content.slice(0, index).split('\n').length : 1
    return excerptText({ path: repoPath, content, line })
  }

  function writeDelta(input) {
    const path = inputPath(input)
    const repoPath = deltaPath(path)
    if (!repoPath) return ''
    const absolute = resolve(cwd, path)
    const content = safeRead(readFile, absolute)
    const written = typeof input?.content === 'string' ? input.content : ''
    return excerptText({ path: repoPath, content: content ?? written, line: 1 })
  }

  function readDelta(event) {
    const path = inputPath(event?.input)
    const repoPath = deltaPath(path)
    if (!repoPath) return ''
    const text = contentOf(event) || safeRead(readFile, resolve(cwd, path)) || ''
    return excerptText({ path: repoPath, content: text, line: Number(event?.input?.offset ?? 1) || 1 })
  }

  function processCall(event) {
    const current = currentContext()
    const tool = String(event?.toolName || '')
    const input = event?.input || {}
    const id = String(event?.toolCallId || '')
    const callOrdinal = calls
    if (id) callOrdinals.set(id, callOrdinal)
    if (diffBaselineLines === null) diffBaselineLines = measureDiffLines()?.lines ?? null
    if (tool === 'write' || tool === 'edit') {
      if (growthBaseline === null) {
        growthBaseline = measureDiff()
        // A constructed transcript may carry a large write while its fake git
        // seam is intentionally unavailable; the content itself is the only
        // measured lower bound available in that fixture.
        if (!growthBaseline && tool === 'write' && byteLength(input.content) >= GROWTH_FLOOR_BYTES) {
          growthBaseline = { bytes: 0, truncated: false }
        }
      }
      const target = targetForInput(input)
      const matcher = scopeMatcher(current.files_in_scope)
      if (target && current.scope_source !== 'absent' && !matcher(target) && !inTaskDir(inputPath(input))) {
        if (emitTier0({ kind: SCOPE_BREACH, target, targetKind: 'file' })) queue(id, 'tier0-note')
      }
      if (target && current.tripwires_source !== 'absent' && current.tripwires.includes(target)) {
        if (emitTier0({ kind: TRIPWIRE_TOUCH, target, targetKind: 'file' })) queue(id, 'tier0-note')
      }
      if (calls % CADENCE_CALLS === 0) queue(id, 'cadence')
    } else if (calls % CADENCE_CALLS === 0) {
      queue(id, 'cadence')
    }
  }

  // Any tool: when the working diff has grown by DIFF_GROWTH_LINES since the last consult, ground the delta and queue one.
  function processDiffGrowth(id) {
    const measured = measureDiffLines()
    if (!measured) return
    if (diffBaselineLines === null) { diffBaselineLines = measured.lines; return }
    if (measured.lines - diffBaselineLines < DIFF_GROWTH_LINES) return
    for (const entry of measured.entries) appendDelta(entry)
    diffBaselineLines = measured.lines
    queue(id, 'diff-growth', callOrdinals.get(id) ?? calls)
  }

  function processResult(event) {
    const current = currentContext()
    const tool = String(event?.toolName || '')
    const input = event?.input || {}
    const id = String(event?.toolCallId || '')
    const text = contentOf(event)
    processDiffGrowth(id)
    if ((tool === 'write' || tool === 'edit') && !event?.isError) {
      appendDelta(tool === 'edit' ? editDelta(input) : writeDelta(input))
      let measured = measureDiff()
      if (!measured && tool === 'write' && byteLength(input.content) >= GROWTH_FLOOR_BYTES) {
        measured = { bytes: byteLength(input.content), truncated: false }
      }
      if (growthBaseline && measured && growthCrossed(growthBaseline, measured)) {
        if (emitTier0({ kind: GROWTH_DIVERGENCE, target: 'repository', targetKind: 'repo', callOrdinal: callOrdinals.get(id) ?? calls })) queue(id, 'tier0-note', callOrdinals.get(id) ?? calls)
      }
    } else if (tool === 'read' && !event?.isError) {
      appendDelta(readDelta(event))
    } else if (tool === 'bash' && event?.isError && isValidationCommand(input.command, current.validation_lane)) {
      const signature = failureSignature(text)
      if (signature) {
        const place = failureTarget(text, cwd)
        const key = place ? `${place}\0${signature}` : signature
        const count = (failureCounts.get(key) || 0) + 1
        failureCounts.set(key, count)
        appendDelta(boundText(signature, SIGNATURE_CAP_BYTES))
        if (count >= REPEAT_FAILURE_THRESHOLD) {
          const target = place || signature
          if (emitTier0({ kind: REPEATED_FAILURE, target, targetKind: place ? 'file' : 'assertion', signature, callOrdinal: callOrdinals.get(id) ?? calls })) queue(id, 'tier0-note', callOrdinals.get(id) ?? calls)
        }
      }
    }
  }

  function liveGeneration(captured) {
    if (captured.generation !== generation || captured.epoch !== contextEpoch) return false
    const nowEpoch = epochKey(manifestEpoch({ taskDir, readFile }))
    return nowEpoch !== null && nowEpoch === captured.epoch
  }

  function rememberInjected(normalized) {
    if (normalized) addFifo(injected, normalized, DEDUPE_CAP)
  }

  // A host whose consults run in separate processes serialises acceptance across them (exclusiveTier1Acceptance):
  // inside it the host merges what the other consults accepted (mergeTier1Memory) before this one is judged.
  function acceptTier1Note(args) {
    if (typeof deps.exclusiveTier1Acceptance !== 'function') return acceptTier1NoteNow(args)
    try { return deps.exclusiveTier1Acceptance(() => acceptTier1NoteNow(args)) === true } catch { return false }
  }

  function acceptTier1NoteNow({ judgment, trigger, eventId, captured }) {
    const text = boundText(judgment.claim, NOTE_TEXT_CAP_BYTES)
    const normalized = normalizeNote(text)
    let code
    if (isContentFree(normalized)) code = 'content-free'
    // A must-fix pre-return finding blocks the return even if the same claim was delivered before.
    else if (!(trigger === 'pre-return' && judgment.severity === 'high')) {
      if (dedupe.has(normalized)) code = 'duplicate'
      else if (acceptedEvents.has(eventId)) code = 'one-per-update'
    }
    if (code) {
      const payload = {
        run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
        kind: TIER1_FINDING, target: boundTarget(String(judgment.evidence?.[0] || '').split(':')[0]),
        target_kind: 'file', role, outcome: 'suppressed', codes: [code], ...captured.tier1Stamp,
      }
      if (appendAdvisorRow('advisor_note', payload)) notes.push(payload)
      return false
    }
    const evidence = judgment.evidence.map((item) => boundText(item, EVIDENCE_ITEM_CAP_BYTES))
    const payload = {
      run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
      kind: TIER1_FINDING, target: boundTarget(String(evidence[0]).split(':')[0]),
      target_kind: 'file', role, outcome: 'injected', ...contentIdentity(text),
      judgment_class: judgment.class, severity: judgment.severity,
      claim: text, evidence, ...captured.tier1Stamp,
    }
    if (!appendAdvisorRow('advisor_note', payload)) return false
    notes.push(payload)
    addFifo(dedupe, normalized, DEDUPE_CAP)
    acceptedEvents.add(eventId)
    rememberInjected(normalized)
    // A must-fix pre-return finding reaches the seat as the refusal's reason; sending it too would say it twice.
    if (trigger === 'pre-return' && judgment.severity === 'high') return true
    try {
      const delivered = send?.({ customType: ADVISOR_MESSAGE_TYPE, content: text, display: true, details: payload }, { deliverAs: 'steer' })
      delivered?.catch?.(() => {})
    } catch { /* advice delivery is not load-bearing */ }
    return true
  }

  async function consult(trigger, eventId, callOrdinal, { inline = false } = {}) {
    // A host whose hooks are fresh processes (the claude seat plugin) cannot hold a consult open: tier 0 only.
    if (deps.tier1 === false) return
    const context = currentContext()
    if (!context?.cell) return
    if (consults >= TIER1_MAX_CONSULTS) return
    if (!anchors.size) {
      const payload = {
        run_started_at: context?.run_started_at ?? null, tier: 1, trigger, call_ordinal: callOrdinal,
        kind: TIER1_FINDING, target: '', target_kind: 'assertion', role,
        outcome: 'skipped', codes: ['no-grounded-delta'],
      }
      if (appendAdvisorRow('advisor_note', payload)) notes.push(payload)
      return
    }
    consults += 1
    const snapshot = Object.freeze(delta.map((entry) => {
      const text = entry.text
      const cleaned = stripAdvisorNotes(text, injected)
      const rebuilt = entryFromText(cleaned)
      return Object.freeze({ text: cleaned, anchors: Object.freeze(rebuilt.anchors) })
    }).filter((entry) => entry.text))
    const consultId = randomUUID()
    const redacted = redactionTally(delta)
    // A host whose hooks are fresh short processes hands the prepared consult to a detached worker
    // (runTier1Consult) instead of holding it open here. Nothing below this line is duplicated for it.
    if (!inline && typeof deps.deferTier1Consult === 'function') {
      try {
        deps.deferTier1Consult({
          trigger, eventId, callOrdinal, consultId, redacted, epoch: contextEpoch,
          snapshot: snapshot.map((entry) => entry.text), injected: [...injected], dedupe: [...dedupe],
        })
      } catch { /* a consult that cannot start costs the seat nothing */ }
      return
    }
    return runConsult({ trigger, eventId, callOrdinal, snapshot, context, consultId, redacted })
  }

  function runConsult({ trigger, eventId, callOrdinal, snapshot, context, consultId, redacted }) {
    const captured = {
      epoch: contextEpoch, generation, snapshot, cell: context.cell, call_ordinal: callOrdinal,
      anchors: new Set(snapshot.flatMap((e) => e.anchors)), controller: new AbortController(),
    }
    const cell = captured.cell
    const tier1Stamp = { ...cellIdentity(cell), call_ordinal: captured.call_ordinal, consult_id: consultId }
    captured.tier1Stamp = tier1Stamp
    controllers.add(captured.controller)
    // The scrub is a fact, not a silence: one row per consult, always, carrying
    // the per-kind count of what this consult's delta had removed from it.
    const consultPayload = { consult_id: consultId,
      run_started_at: context?.run_started_at ?? null, tier: 1, trigger, role,
      delta_entries: captured.snapshot.length,
      redacted,
      model: captured.cell.model, model_id: captured.cell.id, provider: captured.cell.provider, agent: captured.cell.agent, effort: captured.cell.effort,
    }
    consultPayload.provider = cell.provider
    const request = (async () => {
      let codes = []
      let judgment = null
      let replyText = null
      let foldedUsage = null
      // The priced spend row (advisor_usage) is measured IFF all hold: the child closed with
      // exit code 0 and no signal; the consult did not fail, abort, time out or hit a cap; the
      // whole stdout parsed with no invalid or trailing partial frame; and every own-spend
      // frame carries complete usage. Each condition has its own flag below, so each is
      // proven by its own test. Anything else is usage-incomplete (zero own-spend frames keep
      // usage-unavailable). The consult row keeps the partial fold (#1535) with usage_partial.
      let usageIncomplete = false // an own-spend frame lacked complete usage
      let ownSpendFrames = 0 // frames the shared reducer counts as the child's own spend
      let consultFailed = false // fail(): abort, cap, stream/stdin error; or spawn error
      let epochAborted = false
      let timedOut = false
      let parseFault = false // an invalid frame, mid-stream or trailing partial at close
      let childExit = null // { code, signal } from 'close', when the child closed
      try {
        {
          const resolved = resolveBinary(deps.binaryDeps || {})
          if (!resolved || resolved.error || !String(resolved.command || resolved.binary || '').startsWith('/')) throw new Error('pi binary unresolved')
          const binary = resolved.command || resolved.binary
          const prefix = resolved.args || []
          const dir = mkdtempSync(join(tmpdir(), 'crew-advisor-'))
          const promptFile = join(dir, 'system-prompt.txt')
          try {
            writeFileSync(promptFile, systemPrompt(role), { mode: 0o600 })
            const childArgs = ['-p','--mode','json','--no-session','--model',consultModel(cell),'--thinking',cell.effort,'--no-tools','--no-context-files','--no-extensions','--no-skills','--append-system-prompt',promptFile]
            const child = spawn(binary, [...prefix, ...childArgs], { cwd, stdio: ['pipe','pipe','pipe'] })
            const reducer = createStreamReducer()
            const pushFrame = (frame: any) => {
              if (carriesOwnSpend(frame)) ownSpendFrames += 1
              if (ownSpendIncomplete(frame)) usageIncomplete = true
              reducer.push(frame)
            }
            let stdout = '', stderr = '', settled = false, streamBytes = 0
            // Incremental decoding: a UTF-8 character split across two chunks
            // must not be decoded half by half (the shared subagent reader's rule).
            const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8')
            const childResult = await new Promise((resolveChild, rejectChild) => {
              let timeout, killTimer, hardTimer, failure = null
              // Every failure carries whatever spend was already folded: a measured
              // cost is never erased because a LATER frame went wrong.
              const settle = (error, value) => {
                if (settled) return; settled = true
                cancelTimeout(timeout); cancelTimeout(killTimer); cancelTimeout(hardTimer)
                captured.controller.signal.removeEventListener('abort', abort)
                if (error) { error.usage = reducer.usage(); rejectChild(error) } else resolveChild(value)
              }
              // A failure stops the child and settles only once it has closed:
              // SIGTERM, then SIGKILL after a grace, then settle anyway after a
              // second grace so a child that never closes cannot hang the consult.
              const fail = (error) => {
                if (settled || failure) return
                failure = error
                consultFailed = true
                try { child.kill('SIGTERM') } catch {}
                killTimer = scheduleTimeout(() => {
                  try { child.kill('SIGKILL') } catch {}
                  hardTimer = scheduleTimeout(() => settle(failure), childKillGraceMs)
                }, childKillGraceMs)
              }
              // A cause is recorded only when it is the FIRST failure: a timeout or an epoch
              // abort arriving after a stream failure must not relabel or clear that failure.
              const onTimeout = () => { if (!settled && !failure) timedOut = true; fail(new Error('timeout')) }
              timeout = scheduleTimeout(onTimeout, consultTimeoutMs)
              const abort = () => { if (!settled && !failure) epochAborted = true; fail(new Error('aborted')) }
              captured.controller.signal.addEventListener('abort', abort, { once: true })
              // Two bounds, as the subagent reader keeps them. The TOTAL raw bytes
              // the child wrote are capped at STREAM_CAP_BYTES: pi's JSON mode
              // replays messages across message_end/turn_end/agent_end, so a child
              // that reads files emits far more than its judgment, and a total cap
              // at the response size would reject it. Each FRAME, complete or still
              // unparsed, is capped at RESPONSE_CAP_BYTES: the memory held for one
              // line is bounded, and several small frames in one chunk are not
              // measured as one oversize frame.
              const oversize = () => fail(Object.assign(new Error('oversize'), { code: 'body-too-large' }))
              child.stdout?.on('data', (chunk) => {
                if (failure) return
                const bytes = Buffer.from(chunk)
                streamBytes += bytes.length
                if (streamBytes > STREAM_CAP_BYTES) { oversize(); return }
                stdout += outDecoder.write(bytes)
                let index
                while ((index = stdout.indexOf('\n')) >= 0) {
                  const frameLine = stdout.slice(0, index); stdout = stdout.slice(index + 1)
                  if (byteLength(frameLine) > RESPONSE_CAP_BYTES) { oversize(); return }
                  if (!frameLine.trim()) continue
                  try { pushFrame(JSON.parse(frameLine)) } catch { parseFault = true; fail(Object.assign(new Error('invalid frame'), { code: 'body-not-json' })); return }
                }
                if (byteLength(stdout) > RESPONSE_CAP_BYTES) { oversize(); return }
              })
              child.stderr?.on('data', (chunk) => { if (failure) return; stderr += errDecoder.write(Buffer.from(chunk)); if (byteLength(stderr) > RESPONSE_CAP_BYTES) fail(Object.assign(new Error('oversize'), { code: 'body-too-large' })) })
              if (typeof child.stdout?.on === 'function') child.stdout.on('error', () => fail(new Error('stdout failed')))
              if (typeof child.stderr?.on === 'function') child.stderr.on('error', () => fail(new Error('stderr failed')))
              child.on('error', () => { consultFailed = true; settle(new Error('spawn failed')) })
              child.on('close', (code, signal) => {
                childExit = { code, signal: signal ?? null }
                if (settled) return
                if (failure) { settle(failure); return }
                stdout += outDecoder.end()
                if (stdout.trim()) { try { pushFrame(JSON.parse(stdout)) } catch { parseFault = true; settle(Object.assign(new Error('invalid frame'), { code: 'body-not-json' })); return } }
                if (code !== 0 || signal) { settle(new Error('child failed')); return }
                settle(null, { text: reducer.text(), usage: reducer.usage() })
              })
              // A child that closes stdin before the write lands raises EPIPE
              // ASYNCHRONOUSLY on the stream; unhandled, that 'error' event kills
              // the seat. It takes the consult's failure path instead.
              if (typeof child.stdin?.on === 'function') child.stdin.on('error', () => fail(new Error('stdin failed')))
              try { child.stdin.end(JSON.stringify({ trigger, delta: captured.snapshot })) } catch { consultFailed = true; settle(new Error('stdin failed')) }
            })
            foldedUsage = childResult.usage
            const content = childResult.text
            if (!content) codes = ['content-missing']
            else {
              replyText = content
              let value
              try { value = JSON.parse(content) } catch { codes = ['body-not-json'] }
              if (!codes.length) {
                const verdict = validateReply(value, { anchors: captured.anchors, scopeFiles: context?.files_in_scope || [] })
                codes = verdict.codes || []
                judgment = verdict.judgment || null
              }
            }
          } finally { rmSync(dir, { recursive: true, force: true }) }
        }
      } catch (error) {
        consultFailed = true
        if (epochAborted) { consultFailed = false; childExit = null }
        if (error?.usage !== undefined && foldedUsage === null) foldedUsage = error.usage
        if (captured.controller.signal.aborted && !timedOut) codes = ['transport-failed']
        else if (timedOut) codes = ['timeout']
        else codes = error?.code === 'body-too-large' || error?.code === 'body-not-json' ? [error.code] : ['transport-failed']
      } finally {
        controllers.delete(captured.controller)
      }
      const uncleanExit = childExit !== null && (childExit.code !== 0 || childExit.signal !== null)
      // Safe frames can still sum past MAX_SAFE_INTEGER: a rounded aggregate is no measured
      // total, and the ledger writer would refuse it and lose the fact.
      const aggregateSafe = foldedUsage !== null && ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
        .every((key) => Number.isSafeInteger(foldedUsage[key]) && foldedUsage[key] >= 0)
      const spendMeasured = foldedUsage !== null && ownSpendFrames > 0 && !usageIncomplete
        && !consultFailed && !epochAborted && !parseFault && !uncleanExit && aggregateSafe
      {
        consultPayload.usage = foldedUsage
        if (foldedUsage === null) consultPayload.usage_reason = 'usage-unavailable'
        // #1535 keeps the fold on failure paths; it is labelled, never priced.
        else if (!spendMeasured) consultPayload.usage_partial = true
      }
      const transportFailure = timedOut || consultFailed || parseFault || uncleanExit
      const failurePayload = { consult_id: consultId, run_started_at: consultPayload.run_started_at, role, provider: cell.provider, model_id: cell.id, agent: cell.agent, effort: cell.effort, model: cell.model, kind: timedOut ? 'timeout' : 'transport-error', detail: timedOut ? 'consult timed out' : 'pi child transport failed' }
      if (transportFailure) appendAdvisorRow('advisor_cell_failure', failurePayload)
      Object.assign(consultPayload, replyRecord(replyText, codes))
      appendAdvisorRow('advisor_consult', consultPayload)
      {
        const usagePayload = {
          consult_id: consultId, run_started_at: consultPayload.run_started_at, role,
          model: consultPayload.model, model_id: cell.id, provider: cell.provider, agent: cell.agent, effort: cell.effort, usage: spendMeasured ? foldedUsage : null,
          usage_reason: spendMeasured ? null : ownSpendFrames === 0 ? 'usage-unavailable' : 'usage-incomplete',
        }; usagePayload.provider = cell.provider; appendAdvisorRow('advisor_usage', usagePayload)
      }
      if (!liveGeneration(captured)) return { ran: true, accepted: false, judgment: null, codes }
      if (codes.length || !judgment) {
        const payload = {
          run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
          kind: TIER1_FINDING, target: '', target_kind: 'assertion', role,
          outcome: codes.length === 1 && codes[0] === 'no-finding' ? 'skipped' : 'rejected', codes: errorCodeSet(codes), ...captured.tier1Stamp,
          ...(typeof replyText === 'string' && !codes.some((code) => ['timeout', 'transport-failed', 'body-too-large'].includes(code))
            ? { reply_excerpt: boundText(redactDelta(replyText).text, REPLY_EXCERPT_CAP_BYTES) } : {}),
        }
        if (appendAdvisorRow('advisor_note', payload)) notes.push(payload)
        return { ran: true, accepted: false, judgment: null, codes }
      }
      const accepted = acceptTier1Note({ judgment, trigger, eventId, captured })
      return { ran: true, accepted, judgment, codes }
    })()
    inFlight.add(request)
    request.finally(() => inFlight.delete(request)).catch(() => {})
    return request
  }

  // The detached worker's entry: run a consult a hook prepared and deferred, through the same execution and
  // acceptance code as the inline path. A request from another epoch, or one this advisor cannot trust, is dropped.
  async function runTier1Consult(request) {
    if (!request || typeof request !== 'object' || typeof request.consultId !== 'string' || typeof request.eventId !== 'string'
      || !TRIGGERS.includes(request.trigger) || !Number.isSafeInteger(request.callOrdinal)
      || !Array.isArray(request.snapshot) || !request.snapshot.every((text) => typeof text === 'string')
      || !Array.isArray(request.injected) || !request.injected.every((text) => typeof text === 'string')
      || !Array.isArray(request.dedupe) || !request.dedupe.every((text) => typeof text === 'string')
      || !request.redacted || typeof request.redacted !== 'object' || typeof request.epoch !== 'string') return
    if (epochKey(manifestEpoch({ taskDir, readFile })) !== request.epoch) return
    contextEpoch = request.epoch
    contextRowEpoch = request.epoch
    const current = ensureContext()
    if (!current?.cell || contextEpoch !== request.epoch) return
    injected = new Set(request.injected)
    dedupe = new Set(request.dedupe)
    const snapshot = Object.freeze(request.snapshot.map((text) => {
      const rebuilt = entryFromText(text)
      return Object.freeze({ text: rebuilt.text, anchors: Object.freeze(rebuilt.anchors) })
    }).filter((entry) => entry.text))
    await runConsult({
      trigger: request.trigger, eventId: request.eventId, callOrdinal: request.callOrdinal, snapshot,
      context: current, consultId: request.consultId, redacted: request.redacted,
    })
  }

  // What a detached consult learned by having its claim accepted: the dedupe and self-echo memory a host that
  // keeps the advisor's state elsewhere merges back, so later consults see a delivered claim as the pi advisor does.
  function tier1Memory() { return { dedupe: [...dedupe], injected: [...injected], events: [...acceptedEvents] } }

  function mergeTier1Memory(memory) {
    const strings = (value) => Array.isArray(value) && value.every((text) => typeof text === 'string') ? value : []
    for (const text of strings(memory?.dedupe)) addFifo(dedupe, text, DEDUPE_CAP)
    for (const text of strings(memory?.injected)) addFifo(injected, text, DEDUPE_CAP)
    for (const text of strings(memory?.events)) addFifo(acceptedEvents, text, DEDUPE_CAP)
  }

  function dispatch(id) {
    const triggers = pending.get(String(id)) || []
    pending.delete(String(id))
    for (const captured of triggers) void consult(captured.trigger, String(id), captured.call_ordinal)
  }

  // One consult on the whole working diff, awaited, before the seat's return file is written. Only an accepted
  // must-fix (high severity) finding refuses the write; a failed, timed-out or empty consult lets it through
  // (the consult's own journal rows say so) and never leaves the seat unable to return.
  async function preReturnVerdict(event, { spend, claim = null }) {
    const id = String(event?.toolCallId || '')
    const measured = measureDiffLines()
    if (measured) for (const entry of measured.entries) appendDelta(entry)
    const result = await consult('pre-return', id, calls, { inline: true })
    if (result?.ran && spend) preReturnSpent = true
    // A maybe whose consult never ran (no grounded delta, no cell, the cap) gives its slot back, if it still holds it.
    if (!result?.ran && claim && preReturnMaybeSpent === claim) preReturnMaybeSpent = false
    const judgment = result?.judgment
    if (result?.accepted && judgment?.severity === 'high') return { block: true, reason: judgment.claim }
    return undefined
  }

  async function onToolCall(event, ctx) {
    ensureContext()
    const kind = returnWrite(event)
    if (kind && (preReturnSpent || (kind === 'maybe' && preReturnMaybeSpent))) return undefined
    calls += 1
    processCall(event)
    if (calls % CADENCE_CALLS === 0) queue(String(event?.toolCallId || ''), 'cadence')
    if (kind) {
      // The maybe slot is claimed before the await, so parallel maybes cannot each pass the check.
      const claim = kind === 'maybe' ? {} : null
      if (claim) preReturnMaybeSpent = claim
      try { return await preReturnVerdict(event, { spend: kind === 'sure', claim }) } catch { if (claim && preReturnMaybeSpent === claim) preReturnMaybeSpent = false; return undefined }
    }
    return undefined
  }

  function onToolResult(event, ctx) {
    ensureContext()
    processResult(event)
    dispatch(String(event?.toolCallId || ''))
    // A host that runs each hook as its own process (deferTier1Consult) can see a call's Pre without its Post
    // (a denied or interrupted call). Calls run in parallel, so another call's result does not end a live call:
    // what a call queued waits for its own result, matched by call id alone, or is sent once older than ORPHAN_PENDING_MS.
    if (typeof deps.deferTier1Consult === 'function') {
      const cutoff = nowMs() - ORPHAN_PENDING_MS
      for (const [orphan, triggers] of [...pending]) {
        if (triggers.every((entry) => Number.isFinite(entry.queued_at) && entry.queued_at <= cutoff)) dispatch(orphan)
      }
    }
    callOrdinals.delete(String(event?.toolCallId || ''))
    return undefined
  }

  // What the tier-0 predicates keep between calls: a host that runs each hook in a fresh process stores it
  // and hands it back. Pi never calls these. The judgment channel's delta is not part of it.
  function exportState() {
    return {
      context_epoch: contextEpoch, context_row_epoch: contextRowEpoch, calls, consults, growth_baseline: growthBaseline,
      diff_baseline_lines: diffBaselineLines, pre_return_spent: preReturnSpent, pre_return_maybe_spent: preReturnMaybeSpent !== false,
      call_ordinals: [...callOrdinals], fired: [...fired], failure_counts: [...failureCounts],
      injected: [...injected], dedupe: [...dedupe],
      delta: delta.map((entry) => ({ text: entry.text, redactions: entry.redactions || {} })),
      pending: [...pending].map(([id, triggers]) => [id, triggers.map((entry) => ({ trigger: entry.trigger, call_ordinal: entry.call_ordinal, queued_at: entry.queued_at }))]),
    }
  }

  function importState(state) {
    const pairs = (value) => { if (!Array.isArray(value) || !value.every((pair) => Array.isArray(pair) && pair.length === 2)) throw new Error('advisor state is malformed'); return value }
    const strings = (value) => { if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('advisor state is malformed'); return value }
    const key = (value) => { if (value !== null && typeof value !== 'string') throw new Error('advisor state is malformed'); return value }
    if (!state || typeof state !== 'object' || !Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isSafeInteger(state.consults) || state.consults < 0) throw new Error('advisor state is malformed')
    const growth = state.growth_baseline
    if (growth !== null && !(growth && Number.isFinite(growth.bytes) && typeof growth.truncated === 'boolean')) throw new Error('advisor state is malformed')
    const diffBase = state.diff_baseline_lines === undefined ? null : state.diff_baseline_lines
    if (diffBase !== null && !(Number.isFinite(diffBase) && diffBase >= 0)) throw new Error('advisor state is malformed')
    const spent = state.pre_return_spent === undefined ? false : state.pre_return_spent
    const maybeSpent = state.pre_return_maybe_spent === undefined ? false : state.pre_return_maybe_spent
    if (typeof spent !== 'boolean' || typeof maybeSpent !== 'boolean') throw new Error('advisor state is malformed')
    const ordinals = pairs(state.call_ordinals), counts = pairs(state.failure_counts)
    if (!ordinals.every(([id, ordinal]) => typeof id === 'string' && Number.isSafeInteger(ordinal)) || !counts.every(([id, count]) => typeof id === 'string' && Number.isSafeInteger(count))) throw new Error('advisor state is malformed')
    // The judgment channel's delta and the triggers queued for the next result ride along when the host stores them.
    const storedDelta = state.delta === undefined ? [] : state.delta
    if (!Array.isArray(storedDelta) || !storedDelta.every((entry) => entry && typeof entry.text === 'string' && entry.redactions && typeof entry.redactions === 'object' && !Array.isArray(entry.redactions)
      && Object.values(entry.redactions).every((count) => Number.isSafeInteger(count) && count >= 0))) throw new Error('advisor state is malformed')
    const storedPending = state.pending === undefined ? [] : pairs(state.pending)
    if (!storedPending.every(([id, triggers]) => typeof id === 'string' && Array.isArray(triggers)
      && triggers.every((entry) => entry && TRIGGERS.includes(entry.trigger) && Number.isSafeInteger(entry.call_ordinal) && (entry.queued_at === undefined || Number.isFinite(entry.queued_at))))) throw new Error('advisor state is malformed')
    contextEpoch = key(state.context_epoch); contextRowEpoch = key(state.context_row_epoch)
    delta = storedDelta.map((entry) => ({ ...entryFromText(entry.text), redactions: { ...entry.redactions } })).filter((entry) => entry.text)
    anchors = new Set(delta.flatMap((item) => item.anchors))
    pending = new Map(storedPending.map(([id, triggers]) => [id, triggers.map((entry) => ({ trigger: entry.trigger, call_ordinal: entry.call_ordinal, queued_at: entry.queued_at ?? nowMs() }))]))
    calls = state.calls; consults = state.consults; growthBaseline = growth
    diffBaselineLines = diffBase; preReturnSpent = spent; preReturnMaybeSpent = maybeSpent ? {} : false
    callOrdinals.clear(); for (const [id, ordinal] of ordinals) callOrdinals.set(id, ordinal)
    failureCounts = new Map(counts)
    fired = new Set(strings(state.fired)); injected = new Set(strings(state.injected)); dedupe = new Set(strings(state.dedupe))
  }

  return {
    onToolCall, onToolResult, exportState, importState, runTier1Consult, tier1Memory, mergeTier1Memory,
    notes: () => [...notes],
    settled: async () => { await Promise.allSettled([...inFlight]) },
  }
}

export async function attachAdvisor(pi, { env = process.env, deps = {} } = {}) {
  const role = String(env?.CREW_ROLE || '')
  const appendFile = deps.appendFile || DEFAULT_APPEND
  const taskDir = deps.taskDir || env?.CREW_TASK_DIR || ''
  const journalPath = journalPathFrom(taskDir, env)

  const now = deps.now || DEFAULT_NOW
  if (env?.[ADVISOR_GRANT_ENV] !== '1') return
  const unavailable = (reason) => {
    const payload = { role, reason, config_version: ADVISOR_CONFIG_VERSION }
    appendLine({ appendFile, journalPath, row: rowWithRole({ at: atOf(now), payloadKey: 'advisor_unavailable', payload, role }) })
    const error = new Error(`advisor seat ${role} is unavailable: ${reason} — fix the builder advisor cell configuration`)
    error.reason = reason
    throw error
  }
  if (!ADVISED_ROLES.has(role)) return unavailable('role-unsupported')
  if (manifestText({ taskDir, readFile: deps.readFile || DEFAULT_READ })?.cell_invalid) return unavailable('manifest-cell-invalid')
  if (typeof pi?.on !== 'function' || typeof pi?.sendMessage !== 'function') throw new Error('advisor extension needs pi.on and pi.sendMessage')
  const boot = { role, outcome: 'attached', config_version: ADVISOR_CONFIG_VERSION }
  const written = appendLine({
    appendFile, journalPath,
    row: { at: atOf(now), advisor_boot: boot, role },
  })
  if (!written) throw new Error('advisor extension could not append its boot audit row')
  const advisor = createAdvisor({
    env, deps: {
      ...deps, taskDir,
      send: (message, options) => pi.sendMessage(message, options),
    },
  })
  pi.on('tool_call', (event, ctx) => advisor.onToolCall(event, ctx))
  pi.on('tool_result', (event, ctx) => advisor.onToolResult(event, ctx))
}

export default function advisorExtension(pi) {
  return attachAdvisor(pi)
}
