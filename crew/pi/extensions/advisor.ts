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

import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { appendFileSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, relative, resolve } from 'node:path'
import { resolvePiBinary, createStreamReducer, STREAM_CAP_BYTES } from './subagent.ts'

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
export const TRIGGERS = Object.freeze(['tier0-note', 'cadence'])

export const REPEAT_FAILURE_THRESHOLD = 2
export const GROWTH_DIVERGENCE_RATIO = 2
export const GROWTH_FLOOR_BYTES = 120_000
export const CADENCE_CALLS = 25
export const TIER1_MAX_CONSULTS = 20
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
])
// A model id reaches a shell command line, so it is an allowlist, not a filter.
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/
export const JUDGMENT_ERROR_CODES = Object.freeze([
  'transport-failed', 'status-not-ok', 'body-too-large', 'body-unreadable',
  'body-not-json', 'content-missing', 'payload-not-an-object', 'unknown-key',
  'class-invalid', 'severity-invalid', 'claim-invalid', 'evidence-invalid',
  'evidence-unanchored', 'no-grounded-delta',
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

export function journalPathFrom(taskDir) {
  return join(dirname(String(taskDir || '')), 'journal.jsonl')
}

export function returnsDirFrom(taskDir) {
  return join(dirname(String(taskDir || '')), 'returns')
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
    return {
      schema_version: value.schema_version,
      run_started_at: value.run_started_at,
      tripwires: value.tripwires.map((item) => boundTarget(item)),
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

function plannerReturn({ taskDir, manifest, deps }) {
  const epoch = epochMilliseconds(manifest?.run_started_at)
  if (epoch === null) return { files_in_scope: [], validation_lane: null, source: 'absent' }
  const readDir = deps.readDir || readdirSync
  const fileMtime = deps.fileMtime || ((path) => {
    try { return statSync(path).mtimeMs } catch { return null }
  })
  let names
  try { names = readDir(returnsDirFrom(taskDir)) } catch { return { files_in_scope: [], validation_lane: null, source: 'absent' } }
  const candidates = []
  for (const name of names || []) {
    const match = /^d(\d+)\.planner\.json$/.exec(String(name))
    if (!match) continue
    const path = join(returnsDirFrom(taskDir), String(name))
    let mtime
    try { mtime = fileMtime(path) } catch { mtime = null }
    if (typeof mtime !== 'number' || !Number.isFinite(mtime) || mtime < epoch) continue
    candidates.push({ number: Number(match[1]), path })
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

export function loadContext({ taskDir, deps = {} } = {}) {
  const readFile = deps.readFile || DEFAULT_READ
  const manifest = manifestText({ taskDir, readFile })
  if (!manifest) {
    return {
      files_in_scope: [], validation_lane: null, scope_source: 'absent',
      tripwires: [], tripwires_source: 'absent', run_started_at: null,
    }
  }
  const planner = plannerReturn({ taskDir, manifest, deps })
  return {
    files_in_scope: planner.files_in_scope,
    validation_lane: planner.validation_lane,
    scope_source: planner.source,
    tripwires: manifest.tripwires,
    tripwires_source: 'manifest',
    run_started_at: manifest.run_started_at,
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

export const BUILDER_SYSTEM_PROMPT = 'Review the builder delta for exactly two judgment classes: edge-path (checklist B1: answer EPERM, unknown, interrupted, and empty paths) and over-claim (checklist B2: record no verdict stronger than what was measured). Return JSON with class, severity, claim, and evidence.'
export const PLANNER_SYSTEM_PROMPT = 'Review the planner delta for exactly two judgment classes: edge-path (a plan or gate omits or mishandles a required boundary, failure case, or acceptance path) and over-claim (a Ground truth citation that does not hold at the ref where the plan was written). Return JSON with class, severity, claim, and evidence.'

function systemPrompt(role) {
  return role === 'planner' ? PLANNER_SYSTEM_PROMPT : BUILDER_SYSTEM_PROMPT
}

function noteTextForTier0(kind, target, signature, role) {
  if (kind === REPEATED_FAILURE) return `Repeated validation failure at ${target || 'an unknown location'}: ${signature || 'the same failure signature recurred'}`
  if (kind === SCOPE_BREACH) return `The ${role} seat touched ${target || 'an unknown path'} outside the declared scope.`
  if (kind === TRIPWIRE_TOUCH) return `The ${role} seat touched the declared tripwire ${target || 'an unknown path'}.`
  return 'The repository growth crossed the measured divergence threshold.'
}

export function createAdvisor({ env = process.env, deps = {} } = {}) {
  const role = roleOf(env)
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
  const send = deps.send || null
  const diffSize = deps.diffSize || ((path) => gitDiffSize({ cwd: path, deps }))
  const journalPath = journalPathFrom(taskDir)

  let context = null
  let contextEpoch = null
  let contextRowEpoch = null
  let generation = 0
  let calls = 0
  let consults = 0
  let growthBaseline = null
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
    const fresh = loadContext({ taskDir, deps: { ...deps, readFile, readDir, fileMtime } })
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

  function emitTier0({ kind, target, targetKind, signature, trigger = 'predicate' }) {
    const cleanTarget = boundTarget(target || '')
    const key = `${kind}\0${cleanTarget}`
    if (fired.has(key)) return false
    fired.add(key)
    const payload = {
      run_started_at: context?.run_started_at ?? null,
      tier: 0, trigger, kind, target: cleanTarget, target_kind: targetKind,
      role, outcome: 'injected',
      ...(signature ? { signature: boundText(signature, SIGNATURE_CAP_BYTES) } : {}),
    }
    const ok = appendAdvisorRow('advisor_note', payload)
    if (!ok) return false
    notes.push(payload)
    return true
  }

  function queue(id, trigger) {
    if (!id || !TRIGGERS.includes(trigger)) return
    const list = pending.get(String(id)) || []
    if (!list.includes(trigger)) list.push(trigger)
    pending.set(String(id), list)
  }

  function measureDiff() {
    let value
    try { value = diffSize(cwd) } catch { value = null }
    if (!value || typeof value !== 'object' || !Number.isFinite(value.bytes) || value.bytes < 0) return null
    return { bytes: Number(value.bytes), truncated: value.truncated === true }
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
      if (target && current.scope_source !== 'absent' && !matcher(target)) {
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

  function processResult(event) {
    const current = currentContext()
    const tool = String(event?.toolName || '')
    const input = event?.input || {}
    const id = String(event?.toolCallId || '')
    const text = contentOf(event)
    if ((tool === 'write' || tool === 'edit') && !event?.isError) {
      appendDelta(tool === 'edit' ? editDelta(input) : writeDelta(input))
      let measured = measureDiff()
      if (!measured && tool === 'write' && byteLength(input.content) >= GROWTH_FLOOR_BYTES) {
        measured = { bytes: byteLength(input.content), truncated: false }
      }
      if (growthBaseline && measured && growthCrossed(growthBaseline, measured)) {
        if (emitTier0({ kind: GROWTH_DIVERGENCE, target: 'repository', targetKind: 'repo' })) queue(id, 'tier0-note')
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
          if (emitTier0({ kind: REPEATED_FAILURE, target, targetKind: place ? 'file' : 'assertion', signature })) queue(id, 'tier0-note')
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

  function acceptTier1Note({ judgment, trigger, eventId }) {
    const text = boundText(judgment.claim, NOTE_TEXT_CAP_BYTES)
    const normalized = normalizeNote(text)
    let code
    if (isContentFree(normalized)) code = 'content-free'
    else if (dedupe.has(normalized)) code = 'duplicate'
    else if (acceptedEvents.has(eventId)) code = 'one-per-update'
    if (code) {
      const payload = {
        run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
        kind: TIER1_FINDING, target: boundTarget(String(judgment.evidence?.[0] || '').split(':')[0]),
        target_kind: 'file', role, outcome: 'suppressed', codes: [code],
      }
      if (appendAdvisorRow('advisor_note', payload)) notes.push(payload)
      return false
    }
    const evidence = judgment.evidence.map((item) => boundText(item, EVIDENCE_ITEM_CAP_BYTES))
    const payload = {
      run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
      kind: TIER1_FINDING, target: boundTarget(String(evidence[0]).split(':')[0]),
      target_kind: 'file', role, outcome: 'injected',
      judgment_class: judgment.class, severity: judgment.severity,
      claim: text, evidence,
    }
    if (!appendAdvisorRow('advisor_note', payload)) return false
    notes.push(payload)
    addFifo(dedupe, normalized, DEDUPE_CAP)
    acceptedEvents.add(eventId)
    rememberInjected(normalized)
    try {
      const delivered = send?.({ customType: ADVISOR_MESSAGE_TYPE, content: text, display: true, details: payload }, { deliverAs: 'steer' })
      delivered?.catch?.(() => {})
    } catch { /* advice delivery is not load-bearing */ }
    return true
  }

  async function consult(trigger, eventId) {
    if (consults >= TIER1_MAX_CONSULTS) return
    if (!anchors.size) {
      const payload = {
        run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
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
    const captured = {
      epoch: contextEpoch, generation, snapshot,
      anchors: new Set(snapshot.flatMap((e) => e.anchors)), controller: new AbortController(),
    }
    controllers.add(captured.controller)
    // The scrub is a fact, not a silence: one row per consult, always, carrying
    // the per-kind count of what this consult's delta had removed from it.
    const consultPayload = {
      run_started_at: context?.run_started_at ?? null, tier: 1, trigger, role,
      delta_entries: captured.snapshot.length,
      redacted: redactionTally(delta),
      model: String(env?.[ADVISOR_MODEL_ENV] || ''),
    }
    const body = JSON.stringify({
      model: String(env?.[ADVISOR_MODEL_ENV] || ''), temperature: 0, stream: false,
      messages: [
        { role: 'system', content: systemPrompt(role) },
        { role: 'user', content: JSON.stringify({ trigger, delta: captured.snapshot }) },
      ],
    })
    const request = (async () => {
      let codes = []
      let judgment = null
      let foldedUsage = null
      try {
        if (env?.[ADVISOR_ENDPOINT_ENV]) {
        const response = await fetchFn(requestUrl(String(env?.[ADVISOR_ENDPOINT_ENV] || '')), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
          signal: abortSignal(captured.controller),
        })
        if (!response || response.ok === false || !(response.status >= 200 && response.status < 300)) {
          codes = ['status-not-ok']
        } else {
          const bounded = await readBoundedBody(response, RESPONSE_CAP_BYTES)
          if (!bounded.ok) codes = [bounded.code]
          else {
            let payload
            try { payload = JSON.parse(bounded.text) } catch { codes = ['body-not-json'] }
            if (!codes.length) {
              const content = responseContent(payload)
              if (content === null) codes = ['content-missing']
              else {
                let value
                try { value = JSON.parse(content) } catch { codes = ['body-not-json'] }
                if (!codes.length) {
                  const verdict = validateJudgment(value, {
                    anchors: captured.anchors, scopeFiles: context?.files_in_scope || [],
                  })
                  codes = verdict.codes || []
                  judgment = verdict.judgment || null
                }
              }
            }
          }
        }
        } else {
          const resolved = resolveBinary(deps.binaryDeps || {})
          if (!resolved || resolved.error || !String(resolved.command || resolved.binary || '').startsWith('/')) throw new Error('pi binary unresolved')
          const binary = resolved.command || resolved.binary
          const prefix = resolved.args || []
          const dir = mkdtempSync(join(tmpdir(), 'crew-advisor-'))
          const promptFile = join(dir, 'system-prompt.txt')
          try {
            writeFileSync(promptFile, systemPrompt(role), { mode: 0o600 })
            const childArgs = ['-p','--mode','json','--no-session','--model',String(env?.[ADVISOR_MODEL_ENV] || ''),'--tools','read,grep,find,ls','--exclude-tools','edit,write,bash','--no-extensions','--no-skills','--append-system-prompt',promptFile]
            const child = spawn(binary, [...prefix, ...childArgs], { cwd, stdio: ['pipe','pipe','pipe'] })
            const reducer = createStreamReducer()
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
                clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(hardTimer)
                captured.controller.signal.removeEventListener('abort', abort)
                if (error) { error.usage = reducer.usage(); rejectChild(error) } else resolveChild(value)
              }
              // A failure stops the child and settles only once it has closed:
              // SIGTERM, then SIGKILL after a grace, then settle anyway after a
              // second grace so a child that never closes cannot hang the consult.
              const fail = (error) => {
                if (settled || failure) return
                failure = error
                try { child.kill('SIGTERM') } catch {}
                killTimer = setTimeout(() => {
                  try { child.kill('SIGKILL') } catch {}
                  hardTimer = setTimeout(() => settle(failure), childKillGraceMs)
                }, childKillGraceMs)
              }
              const abort = () => fail(new Error('aborted'))
              timeout = setTimeout(abort, consultTimeoutMs)
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
                  try { reducer.push(JSON.parse(frameLine)) } catch { fail(Object.assign(new Error('invalid frame'), { code: 'body-not-json' })); return }
                }
                if (byteLength(stdout) > RESPONSE_CAP_BYTES) { oversize(); return }
              })
              child.stderr?.on('data', (chunk) => { if (failure) return; stderr += errDecoder.write(Buffer.from(chunk)); if (byteLength(stderr) > RESPONSE_CAP_BYTES) fail(Object.assign(new Error('oversize'), { code: 'body-too-large' })) })
              child.on('error', () => settle(new Error('spawn failed')))
              child.on('close', (code) => {
                if (settled) return
                if (failure) { settle(failure); return }
                stdout += outDecoder.end()
                if (stdout.trim()) { try { reducer.push(JSON.parse(stdout)) } catch { settle(Object.assign(new Error('invalid frame'), { code: 'body-not-json' })); return } }
                if (code !== 0) { settle(new Error('child failed')); return }
                settle(null, { text: reducer.text(), usage: reducer.usage() })
              })
              // A child that closes stdin before the write lands raises EPIPE
              // ASYNCHRONOUSLY on the stream; unhandled, that 'error' event kills
              // the seat. It takes the consult's failure path instead.
              if (typeof child.stdin?.on === 'function') child.stdin.on('error', () => fail(new Error('stdin failed')))
              try { child.stdin.end(JSON.stringify({ trigger, delta: captured.snapshot })) } catch { settle(new Error('stdin failed')) }
            })
            foldedUsage = childResult.usage
            const content = childResult.text
            if (!content) codes = ['content-missing']
            else {
              let value
              try { value = JSON.parse(content) } catch { codes = ['body-not-json'] }
              if (!codes.length) {
                const verdict = validateJudgment(value, { anchors: captured.anchors, scopeFiles: context?.files_in_scope || [] })
                codes = verdict.codes || []
                judgment = verdict.judgment || null
              }
            }
          } finally { rmSync(dir, { recursive: true, force: true }) }
        }
      } catch (error) {
        if (error?.usage !== undefined && foldedUsage === null) foldedUsage = error.usage
        if (captured.controller.signal.aborted) codes = ['transport-failed']
        else codes = error?.code === 'body-too-large' || error?.code === 'body-not-json' ? [error.code] : ['transport-failed']
      } finally {
        controllers.delete(captured.controller)
      }
      if (!env?.[ADVISOR_ENDPOINT_ENV]) {
        consultPayload.usage = foldedUsage
        if (foldedUsage === null) consultPayload.usage_reason = 'usage-unavailable'
      }
      appendAdvisorRow('advisor_consult', consultPayload)
      if (!liveGeneration(captured)) return
      if (codes.length || !judgment) {
        const payload = {
          run_started_at: context?.run_started_at ?? null, tier: 1, trigger,
          kind: TIER1_FINDING, target: '', target_kind: 'assertion', role,
          outcome: 'rejected', codes: errorCodeSet(codes),
        }
        if (appendAdvisorRow('advisor_note', payload)) notes.push(payload)
        return
      }
      acceptTier1Note({ judgment, trigger, eventId })
    })()
    inFlight.add(request)
    request.finally(() => inFlight.delete(request)).catch(() => {})
  }

  function dispatch(id) {
    const triggers = pending.get(String(id)) || []
    pending.delete(String(id))
    for (const trigger of triggers) void consult(trigger, String(id))
  }

  function onToolCall(event, ctx) {
    ensureContext()
    calls += 1
    processCall(event)
    if (calls % CADENCE_CALLS === 0) queue(String(event?.toolCallId || ''), 'cadence')
    return undefined
  }

  function onToolResult(event, ctx) {
    ensureContext()
    processResult(event)
    dispatch(String(event?.toolCallId || ''))
    return undefined
  }

  return {
    onToolCall, onToolResult,
    notes: () => [...notes],
    settled: async () => { await Promise.allSettled([...inFlight]) },
  }
}

export async function attachAdvisor(pi, { env = process.env, deps = {} } = {}) {
  const role = String(env?.CREW_ROLE || '')
  const appendFile = deps.appendFile || DEFAULT_APPEND
  const taskDir = deps.taskDir || env?.CREW_TASK_DIR || ''
  const journalPath = journalPathFrom(taskDir)
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
  const cell = classifyAdvisorCell(advisorCell(env))
  if (cell.reason) return unavailable(cell.reason)
  const modelOnly = !cell.endpoint
  if (!modelOnly) {
    let live = false
    try {
      live = await probeEndpoint(cell.endpoint, { fetchFn: deps.fetchFn, timeoutMs: PROBE_TIMEOUT_MS })
    } catch { live = false }
    if (!live) return unavailable('endpoint-dead')
  }
  if (typeof pi?.on !== 'function' || typeof pi?.sendMessage !== 'function') throw new Error('advisor extension needs pi.on and pi.sendMessage')
  const boot = { role, outcome: 'attached', endpoint: cell.endpoint, model: cell.model, config_version: ADVISOR_CONFIG_VERSION }
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
