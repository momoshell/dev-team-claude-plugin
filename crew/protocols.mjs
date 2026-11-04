// The protocols code reads at the agent boundary (ADR-052 section 3). P1, the lane
// brief: markdown opened by a frontmatter block. Code reads BRIEF_FIELDS and checks
// the body shape. P5, the agent definition: the same frontmatter shape,
// one field per line, with JSON for objects and object lists. Import-free, so the new
// path never loads the old one.

export const ISSUE_SOURCE = /^issue ([1-9]\d*)$/
export const BRIEF_FIELDS = Object.freeze(['source', 'closes', 'mechanical', 'shape', 'out_of_scope', 'suite', 'generated', 'regenerate'])
export const TIERS = Object.freeze(['mechanical', 'build', 'judge'])
export const SHAPES = Object.freeze(['standard', 'finish'])
export const AGENT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
const ID = /^[A-Za-z][A-Za-z0-9._-]*$/
const AGENTS = Object.freeze(['claude', 'pi', 'muse'])
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const WRITES = Object.freeze(['none', 'task-dir', 'repo'])
const EXTENSIONS = Object.freeze(['readgate', 'skeletonread', 'subagent', 'fff'])
const AGENT_FIELDS = Object.freeze(['name', 'description', 'role', 'writes', 'envelope', 'agent', 'model', 'effort', 'skills', 'requires', 'tools', 'extensions', 'advisor', 'memory', 'rounds', 'wait_s', 'tiers'])
const AGENT_REQUIRED = Object.freeze(['name', 'description', 'role', 'agent', 'model', 'effort'])
// A tier may override how a seat runs, never who it is or which tiers exist.
const TIER_OVERRIDES = Object.freeze(AGENT_FIELDS.filter((key) => !['name', 'description', 'role', 'tiers'].includes(key)))
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/
const TOKEN_LIST = /^\[\s*[A-Za-z][A-Za-z0-9._-]*(\s*,\s*[A-Za-z][A-Za-z0-9._-]*)*\s*\]$/

// One frontmatter value: [a, b] is a list, null is null, digits are an integer,
// anything else is a string with one pair of surrounding quotes removed.
function value(raw) {
  const text = raw.trim()
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).split(',').map((item) => value(item)).filter((item) => item !== '')
  if (text === 'null') return null
  if (/^\d+$/.test(text)) return Number(text)
  const quoted = /^(["'])(.*)\1$/.exec(text)
  return quoted ? quoted[2] : text
}

// The body's lines grouped by level-1 or level-2 heading, skipping fenced text: a
// heading or item quoted inside a fence is an example, as the driver reads it.
// `includeFences` retains fenced lines as content without treating headings inside them as boundaries.
// A heading the body repeats is listed in `repeated`; the driver reads only the first.
function sections(body, { includeFences = false } = {}) {
  const out = new Map()
  const repeated = []
  const askQuotes = new Set()
  let current = null
  let fence = null
  for (const [index, line] of body.split('\n').entries()) {
    if (current === '## The ask' && /^ {0,3}>/.test(line)) askQuotes.add(index)
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (includeFences && current) out.get(current).push(line)
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null
      continue
    }
    if (mark) { if (includeFences && current) out.get(current).push(line); fence = mark; continue }
    if (/^ {0,3}#{1,2}\s+/.test(line)) {
      current = line.trim()
      if (out.has(current)) repeated.push(current)
      else out.set(current, [])
      continue
    }
    if (current) out.get(current).push(line)
  }
  return { parts: out, repeated, askQuotes }
}

// Returns { fields, body, ask, paths, defects }. An empty defects list is a brief code can start.
export function parseBrief(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return { fields: null, body: null, ask: [], paths: [], defects: ['the brief does not open with a --- frontmatter block'] }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { fields: null, body: null, ask: [], paths: [], defects: ['the frontmatter block is never closed with ---'] }
  const fields = {}
  const defects = []
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const pair = /^([a-z_]+):(.*)$/.exec(line)
    if (!pair) { defects.push(`frontmatter line is not key: value: ${JSON.stringify(line)}`); continue }
    // ADR-055 §1: the planner, not the brief, writes criteria.
    if (pair[1] === 'acceptance') { defects.push('acceptance is not a brief field: the planner writes the criteria (ADR-055 §1)'); continue }
    if (pair[1] === 'tier') { defects.push('tier is not a brief field: use mechanical: true for a mechanical lane (ADR-055 §1)'); continue }
    if (!BRIEF_FIELDS.includes(pair[1])) { defects.push(`unknown field ${pair[1]}; the fields are ${BRIEF_FIELDS.join(', ')}`); continue }
    fields[pair[1]] = value(pair[2])
  }
  for (const key of BRIEF_FIELDS) if (!['out_of_scope', 'suite', 'mechanical', 'generated', 'regenerate'].includes(key) && !Object.hasOwn(fields, key)) defects.push(`missing field ${key}`)
  const body = lines.slice(end + 1).join('\n')
  if (typeof fields.source !== 'string' || !fields.source) defects.push('source names the issue or operator command the lane starts from')
  if (fields.closes !== null && !(Number.isSafeInteger(fields.closes) && fields.closes > 0)) defects.push('closes is null or one issue number')
  if (Object.hasOwn(fields, 'mechanical')) {
    if (fields.mechanical === 'true') fields.mechanical = true
    else defects.push('mechanical is true, or the field is absent')
  }
  if (!SHAPES.includes(fields.shape)) defects.push(`shape is one of ${SHAPES.join(', ')}`)
  if (Object.hasOwn(fields, 'out_of_scope') && (typeof fields.out_of_scope !== 'string' || !fields.out_of_scope)) defects.push('out_of_scope says what the lane must not change')
  if (Object.hasOwn(fields, 'suite') && (typeof fields.suite !== 'string' || fields.suite.trim() === '')) defects.push('suite is a command line (for example: suite: cargo test -p power-api)')
  if (Object.hasOwn(fields, 'generated') !== Object.hasOwn(fields, 'regenerate')) defects.push('generated and regenerate must be declared together')
  if (Object.hasOwn(fields, 'generated') && !(Array.isArray(fields.generated) && fields.generated.length > 0 && fields.generated.every((path) => {
    if (typeof path !== 'string') return false
    const file = path.endsWith('/') ? path.slice(0, -1) : path
    return file !== '' && !file.startsWith('/') && !/[\\\0*?\[\]]/.test(file) && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  }))) defects.push('generated is a nonempty list of literal repo-relative paths')
  if (Object.hasOwn(fields, 'regenerate') && (typeof fields.regenerate !== 'string' || fields.regenerate.trim() === '' || fields.regenerate.includes('\0'))) defects.push('regenerate is a nonempty command line')
  for (const key of ['suite', 'regenerate']) {
    if (typeof fields[key] === 'string' && /["'\\]/.test(fields[key])) defects.push(`${key} is split on whitespace and run without a shell: quotes and backslashes are refused`)
  }
  const { parts, repeated, askQuotes } = sections(body, { includeFences: true })
  if (repeated.length) defects.push(`the body repeats ${[...new Set(repeated)].join(', ')}; the driver reads only the first`)
  for (const line of body.split('\n')) {
    if (/^ {0,3}#{1,2}\s+/.test(line)) break
    if (line.trim()) defects.push(`the body holds only ## The ask and ## Context: ${line}`)
  }
  for (const heading of parts.keys()) {
    if (!['## The ask', '## Context'].includes(heading)) defects.push(`the body holds only ## The ask and ## Context: ${body.split('\n').find((line) => line.trim() === heading)}`)
  }
  const issue = typeof fields.source === 'string' && ISSUE_SOURCE.test(fields.source)
  if (typeof fields.source === 'string' && fields.source.startsWith('issue') && !issue) defects.push("source is issue N, or the operator's request")
  const ask = parts.get('## The ask')
  if (issue && ask) defects.push('an issue brief has no ## The ask: crew start takes the issue body as the ask')
  if (!issue) {
    // Quote markers alone (`> >`) carry no ask: a quoted line counts once a letter or digit is left.
    if (!ask?.some((line) => /[\p{L}\p{N}]/u.test(line.replace(/^ {0,3}>[ \t]?/, '')))) defects.push("the body has no ## The ask; quote the operator's words there")
    for (const line of ask ?? []) if (line.trim() && !/^ {0,3}>/.test(line)) defects.push(`## The ask quotes the source: every line starts with >: ${line}`)
  }
  const context = parts.get('## Context') ?? []
  let hasItem = false
  const paths = new Set()
  for (const line of context) {
    if (!line.trim()) continue
    if (/^ {0,3}[-*] +/.test(line)) hasItem = true
    if (!/^ {0,3}[-*] +(?:`[^`]+`|(?:issue|PR) [1-9]\d*)(?:[ \t]+(?:`[^`]+`|(?:issue|PR) [1-9]\d*))*[ \t]*$/.test(line)) defects.push(`## Context holds only bare pointers: each item is one or more code spans, issue N or PR N, with no other text: ${line}`)
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    for (const [index, span] of spans.entries()) {
      if (/^(?:[\/~]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(span) || span.split('/').includes('..')) defects.push(`## Context points only inside the checkout (ADR-056 Amendment 1): ${span}`)
      if (index === 0 || span.includes('/')) paths.add(span)
    }
  }
  if (!hasItem) defects.push('the body has no ## Context with at least one pointer')
  // Quoted ask lines are the source's words and bind nothing; only `closes` reaches the bound-issue slot.
  const stray = body.split('\n').flatMap((line, index) => askQuotes.has(index) ? [] : (line.match(/#\d+/g) ?? []))
  if (stray.length) defects.push(`the body names ${stray.join(', ')}; write "issue N" or "PR N", because closes is the only issue binding`)
  const blocks = []
  let previous = -2
  for (const i of askQuotes) {
    const text = lines[end + 1 + i].replace(/^ {0,3}>[ \t]?/, '')
    if (i === previous + 1) blocks.at(-1).text += `\n${text}`
    else blocks.push({ line: end + 2 + i, text })
    previous = i
  }
  const quotedAsk = blocks.filter(({ text }) => /[\p{L}\p{N}]/u.test(text))
  return { fields, body, ask: quotedAsk, paths: [...paths], defects }
}

const nonempty = (v) => typeof v === 'string' && v !== ''
const list = (v) => Array.isArray(v) && v.every(nonempty)
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const AGENT_RULES = {
  name: [(v) => nonempty(v) && ID.test(v), 'is an identifier: a letter then letters, digits, . _ or -'],
  description: [nonempty, 'is a nonempty string'],
  role: [(v) => AGENT_ROLES.includes(v), `is one of ${AGENT_ROLES.join(', ')}`],
  writes: [(v) => WRITES.includes(v), `is one of ${WRITES.join(', ')}`],
  envelope: [nonempty, 'is a nonempty string'],
  agent: [(v) => AGENTS.includes(v), `is one of ${AGENTS.join(', ')}`],
  model: [(v) => typeof v === 'string' && MODEL.test(v), 'is provider/id: provider [a-z0-9-]+, id [A-Za-z0-9._-]+'],
  effort: [(v) => EFFORTS.includes(v), `is one of ${EFFORTS.join(', ')}`],
  skills: [list, 'is a list of nonempty strings'],
  requires: [list, 'is a list of nonempty strings'],
  tools: [list, 'is a list of nonempty strings'],
  extensions: [(v) => Array.isArray(v) && v.every((item) => EXTENSIONS.includes(item)), `is a list drawn from ${EXTENSIONS.join(', ')}`],
  memory: [(v) => typeof v === 'boolean', 'is true or false'],
  rounds: [(v) => Number.isSafeInteger(v) && v > 0, 'is a positive safe integer'],
  wait_s: [(v) => Number.isSafeInteger(v) && v > 0, 'is a positive safe integer'],
}

// One P5 value: scalars as P1 reads them plus true/false; { and [ open JSON. The one
// non-JSON form is the ADR's bare list [plan, qa-test-writing], flat identifier tokens only.
function agentValue(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { value: JSON.parse(trimmed) } } catch (error) {
      if (TOKEN_LIST.test(trimmed)) return { value: trimmed.slice(1, -1).split(',').map((item) => item.trim()) }
      return { error: `is not valid JSON (${error.message})` }
    }
  }
  if (trimmed === 'null') return { value: null }
  if (trimmed === 'true' || trimmed === 'false') return { value: trimmed === 'true' }
  if (/^-?\d+$/.test(trimmed)) return { value: Number(trimmed) }
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return { value: quoted ? quoted[2] : trimmed }
}

// An object with exactly the named keys: `required` must be present, `optional` may be.
function entryDefects(entry, path, required, optional = []) {
  if (!plain(entry)) return [`${path} is an object with ${required.join(', ')}`]
  const out = []
  for (const key of Object.keys(entry)) {
    if (![...required, ...optional].includes(key)) out.push(`${path}.${key} is not a field of ${path}`)
    else if (!AGENT_RULES[key][0](entry[key])) out.push(`${path}.${key} ${AGENT_RULES[key][1]}`)
  }
  for (const key of required) if (!Object.hasOwn(entry, key)) out.push(`${path}.${key} is required`)
  return out
}

// Type and vocabulary defects for the fields present; `prefix` locates a tier override.
function validateAgentFields(fields, prefix = '') {
  const out = []
  for (const [key, v] of Object.entries(fields)) {
    if (Object.hasOwn(AGENT_RULES, key)) { if (!AGENT_RULES[key][0](v)) out.push(`${prefix}${key} ${AGENT_RULES[key][1]}`) }
    else if (key === 'advisor' && v !== null) out.push(...entryDefects(v, `${prefix}advisor`, ['agent', 'model', 'effort']))
  }
  return out
}

// Returns { fields, body, defects }. An empty defects list is an agent definition code can seat.
export function parseAgent(text) {
  const lines = String(text ?? '').split('\n')
  if (lines[0]?.trim() !== '---') return { fields: null, body: null, defects: ['the agent definition does not open with a --- frontmatter block'] }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { fields: null, body: null, defects: ['the frontmatter block is never closed with ---'] }
  const fields = {}
  const agentDefects = []
  for (const line of lines.slice(1, end).map((item) => item.replace(/\r$/, ''))) {
    if (!line.trim()) continue
    const pair = /^([a-z_]+):(.*)$/.exec(line)
    if (!pair) { agentDefects.push(`frontmatter line is not key: value: ${JSON.stringify(line)}`); continue }
    const [, key, raw] = pair
    if (!AGENT_FIELDS.includes(key)) { agentDefects.push(`unknown field ${key}; the fields are ${AGENT_FIELDS.join(', ')}`); continue }
    if (Object.hasOwn(fields, key)) { agentDefects.push(`duplicate field ${key}`); continue }
    const parsed = agentValue(raw)
    if (parsed.error) agentDefects.push(`${key} ${parsed.error}`)
    else fields[key] = parsed.value
  }
  for (const key of AGENT_REQUIRED) if (!Object.hasOwn(fields, key)) agentDefects.push(`missing field ${key}`)
  agentDefects.push(...validateAgentFields(fields))
  if (Object.hasOwn(fields, 'tiers')) {
    if (!plain(fields.tiers)) agentDefects.push(`tiers is an object keyed by ${TIERS.join(', ')}`)
    else for (const [tier, override] of Object.entries(fields.tiers)) {
      const path = `tiers.${tier}`
      if (!TIERS.includes(tier)) { agentDefects.push(`${path} is not a tier; the tiers are ${TIERS.join(', ')}`); continue }
      if (override === null) continue
      if (!plain(override)) { agentDefects.push(`${path} is null (unseated) or an object of overrides`); continue }
      for (const key of Object.keys(override)) if (!TIER_OVERRIDES.includes(key)) agentDefects.push(`${path}.${key} cannot be overridden; the overrides are ${TIER_OVERRIDES.join(', ')}`)
      const allowed = Object.fromEntries(Object.entries(override).filter(([key]) => TIER_OVERRIDES.includes(key)))
      agentDefects.push(...validateAgentFields(allowed, `${path}.`))
    }
  }
  const body = lines.slice(end + 1).join('\n')
  return { fields, body, defects: agentDefects }
}

// P2, the seat envelope: JSON per role, validated as a parsed value. Paths in it declare
// artifacts; nothing here reads or runs them.
export const ENVELOPE_FIELDS = Object.freeze(['role', 'id', 'status', 'summary', 'details'])
export const ENVELOPE_STATUSES = Object.freeze(['done', 'insufficient', 'escalate'])
export const REVIEW_VERDICTS = Object.freeze(['pass', 'changes-needed'])
export const REQUIREMENT_STATUSES = Object.freeze(['met', 'unmet', 'human-verify'])
export const LEAD_DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])
export const FINDING_SEVERITIES = Object.freeze(['must-fix', 'should-fix', 'consider'])
export const FINDING_DISPOSITIONS = Object.freeze(['auto-fix', 'ask-user', 'no-op'])
const FINDING_ID = /^[A-Za-z0-9_-]{1,64}$/
const REVIEW_KEYS = Object.freeze(['verdict', 'findings', 'requirements', 'failure_modes', 'coverage'])
const DETAIL_KEYS = Object.freeze({
  planner: ['subject', 'plan_path', 'tests'],
  builder: ['summary'],
  reviewer: REVIEW_KEYS,
  'tech-lead': REVIEW_KEYS,
  lead: ['decision'],
})
// Fields a role may carry beyond its required ones. A planner states the context the builder's arms read.
const OPTIONAL_DETAIL_KEYS = Object.freeze({
  planner: ['files_in_scope', 'validation_lane', 'judge', 'question'],
  builder: ['tests', 'notes', 'question', 'subject'],
  reviewer: ['question', 'closed', 'findings_omitted'],
  'tech-lead': ['question', 'closed', 'findings_omitted'],
  lead: ['question', 'target'],
})
const ARCHIVED_OPTIONAL = Object.freeze({ planner: ['tests'], reviewer: ['requirements', 'failure_modes', 'coverage'], 'tech-lead': ['requirements', 'failure_modes', 'coverage'] })
// ADR-055 §8: archived planner returns still carry these fields.
const LEGACY_DETAIL_KEYS = Object.freeze({
  planner: ['acceptance', 'gate_path', 'gate_cmd', 'mutations'],
})
const SUBJECT_TYPES = Object.freeze(['chore', 'ci', 'crew', 'docs', 'feat', 'fix', 'merge', 'perf', 'refactor', 'revert', 'spike', 'test', 'wip', 'workflow'])
const SUBJECT_PATTERN = new RegExp(String.raw`^(?:${SUBJECT_TYPES.join('|')})(?:\([A-Za-z0-9][A-Za-z0-9._/-]*\))?!?: \S(?:.*\S)?$`)
const DETAIL_RULES = {
  subject: [(v) => typeof v === 'string' && v.length <= 72 && !/[\x00-\x1f\x7f]/.test(v)
    && SUBJECT_PATTERN.test(v),
  `is a conventional-commit subject of at most 72 characters: type(scope): summary, type one of ${SUBJECT_TYPES.join(', ')}`],
  plan_path: [nonempty, 'is a nonempty string'],
  files_in_scope: [(v) => Array.isArray(v) && v.length > 0 && v.every(nonempty), 'is a nonempty list of nonempty strings'],
  validation_lane: [nonempty, 'is a nonempty string'],
  judge: [(v) => nonempty(v) && !/[\x00-\x1f\x7f]/.test(v), 'is a one-line reason the lane needs judge review'],
  summary: [nonempty, 'is a nonempty string'],
  verdict: [(v) => REVIEW_VERDICTS.includes(v), `is one of ${REVIEW_VERDICTS.join(', ')}`],
  decision: [(v) => LEAD_DECISIONS.includes(v), `is one of ${LEAD_DECISIONS.join(', ')}`],
  tests: [(v) => Array.isArray(v) && v.every((t) => plain(t) && Object.keys(t).length === 2 && nonempty(t.file) && nonempty(t.title)), 'is a list of {file, title} with nonempty strings'],
  notes: [nonempty, 'is a nonempty string'],
  question: [nonempty, 'is a nonempty string'],
  target: [(v) => ['builder', 'planner'].includes(v), 'is one of builder, planner'],
  requirements: [(v) => Array.isArray(v) && v.length > 0 && v.every((r) => plain(r) && Object.keys(r).length === 3 && nonempty(r.requirement) && REQUIREMENT_STATUSES.includes(r.status) && nonempty(r.evidence)), 'is a nonempty list of {requirement, status, evidence}'],
  failure_modes: [(v) => Array.isArray(v) && v.length <= 3 && v.every((f) => plain(f) && Object.keys(f).length === 5 && nonempty(f.breaks) && nonempty(f.where) && nonempty(f.trigger) && typeof f.tested === 'boolean' && typeof f.covered === 'boolean'), 'is a list of at most three {breaks, where, trigger, tested, covered}'],
  coverage: [(v) => plain(v) && Object.keys(v).length === 2 && list(v.read) && v.read.length > 0 && typeof v.complete === 'boolean', 'is {read, complete} with a nonempty read list and a boolean'],
  findings_omitted: [(v) => Number.isSafeInteger(v) && v > 0, 'is a positive safe integer'],
  closed: [(v) => Array.isArray(v) && v.every((c) => plain(c) && Object.keys(c).length === 2 && typeof c.id === 'string' && FINDING_ID.test(c.id) && nonempty(c.evidence)), 'is a list of {id, evidence}'],
}
const FINDING_REQUIRED = Object.freeze(['id', 'severity', 'location', 'summary'])
const FINDING_RULES = {
  id: [(v) => typeof v === 'string' && FINDING_ID.test(v), 'is 1-64 letters, digits, _ or -'],
  severity: [(v) => FINDING_SEVERITIES.includes(v), `is one of ${FINDING_SEVERITIES.join(', ')}`],
  location: [nonempty, 'is a nonempty string'],
  summary: [nonempty, 'is a nonempty string'],
  disposition: [(v) => FINDING_DISPOSITIONS.includes(v), `is one of ${FINDING_DISPOSITIONS.join(', ')}`],
  patch: [nonempty, 'is a nonempty string'],
  trigger: [nonempty, 'is a nonempty string'],
  uncertain: [nonempty, 'is a nonempty string'],
  start_line: [(v) => Number.isSafeInteger(v) && v > 0, 'is a positive safe integer'],
  end_line: [(v) => Number.isSafeInteger(v) && v > 0, 'is a positive safe integer'],
}

// Returns { envelope, defects }. An empty defects list is an envelope the loop can act on;
// a refused object root is still returned, a non-object root is null.
export function validateEnvelope(role, envelope, { archived = false, prior = [] } = {}) {
  if (!plain(envelope)) return { envelope: null, defects: ['envelope is a JSON object'] }
  const defects = []
  for (const key of Object.keys(envelope)) {
    if (!ENVELOPE_FIELDS.includes(key)) defects.push(`unknown field ${key}`)
  }
  for (const key of ENVELOPE_FIELDS) if (!Object.hasOwn(envelope, key)) defects.push(`missing field ${key}`)
  if (!AGENT_ROLES.includes(envelope.role)) defects.push(`role is one of ${AGENT_ROLES.join(', ')}`)
  if (envelope.role !== role) defects.push('role must match the expected role')
  if (!nonempty(envelope.id)) defects.push('id is a nonempty string')
  if (!ENVELOPE_STATUSES.includes(envelope.status)) defects.push(`status is one of ${ENVELOPE_STATUSES.join(', ')}`)
  if (!nonempty(envelope.summary)) defects.push('summary is a nonempty string')
  const required = AGENT_ROLES.includes(role) ? DETAIL_KEYS[role] : null
  const details = envelope.details
  if (required && Object.hasOwn(envelope, 'details')) {
    if (!plain(details)) defects.push(`details is an object with ${required.join(', ')}`)
    else {
      const optional = OPTIONAL_DETAIL_KEYS[role] ?? []
      for (const key of Object.keys(details)) {
        if (optional.includes(key)) {
          if (!DETAIL_RULES[key][0](details[key])) defects.push(`details.${key} ${DETAIL_RULES[key][1]}`)
        }
        else if (!required.includes(key) && !(archived && (LEGACY_DETAIL_KEYS[role] ?? []).includes(key))) defects.push(`details.${key} is not a field of ${role} details`)
      }
      for (const key of required) {
        if (!Object.hasOwn(details, key)) { if (!archived || !(ARCHIVED_OPTIONAL[role] ?? []).includes(key)) defects.push(`details.${key} is required`); continue }
        const v = details[key]
        if (Object.hasOwn(DETAIL_RULES, key)) { if (!DETAIL_RULES[key][0](v)) defects.push(`details.${key} ${DETAIL_RULES[key][1]}`) }
        else if (key === 'findings' && !Array.isArray(v)) defects.push('details.findings is a list of findings')
        else if (key === 'findings') {
          const seen = new Set()
          if (['reviewer', 'tech-lead'].includes(role) && !archived && v.length > 5) defects.push('details.findings is limited to five; count the rest in details.findings_omitted')
          v.forEach((finding, index) => {
            const path = `details.findings[${index}]`
            if (!plain(finding)) { defects.push(`${path} is an object with ${FINDING_REQUIRED.join(', ')}`); return }
            for (const key of Object.keys(finding)) {
              if (!Object.hasOwn(FINDING_RULES, key)) defects.push(`${path}.${key} is not a finding field`)
              else if (!FINDING_RULES[key][0](finding[key])) defects.push(`${path}.${key} ${FINDING_RULES[key][1]}`)
            }
            for (const key of FINDING_REQUIRED) if (!Object.hasOwn(finding, key)) defects.push(`${path}.${key} is required`)
            if (FINDING_RULES.id[0](finding.id)) {
              if (seen.has(finding.id)) defects.push(`${path}.id repeats ${finding.id}`)
              seen.add(finding.id)
            }
            if (['reviewer', 'tech-lead'].includes(role) && !archived && finding.severity === 'must-fix' && !Object.hasOwn(finding, 'trigger')) defects.push(`${path}.trigger is required for a must-fix`)
            const hasPatch = Object.hasOwn(finding, 'patch')
            if (finding.disposition === 'auto-fix' && !hasPatch) defects.push(`${path}.patch is required for disposition auto-fix`)
            if (hasPatch && finding.disposition !== 'auto-fix') defects.push(`${path}.patch is only allowed with disposition auto-fix`)
          })
          if (details.verdict === 'pass' && v.some((finding) => plain(finding) && finding.severity === 'must-fix')) defects.push('details.verdict is pass but the findings include a must-fix')
        }
      }
      if (['reviewer', 'tech-lead'].includes(role)) {
        if (!archived && envelope.status === 'done' && details.verdict === 'changes-needed' && Array.isArray(details.findings) && !details.findings.some((f) => plain(f) && ['must-fix', 'should-fix'].includes(f.severity))) defects.push('details.verdict is changes-needed but no finding is must-fix or should-fix')
        if (details.verdict === 'pass' && Array.isArray(details.requirements) && details.requirements.some((r) => r?.status === 'unmet')) defects.push('details.verdict is pass but a requirement is unmet')
        if (details.verdict === 'pass' && Object.hasOwn(details, 'coverage') && details.coverage?.complete !== true) defects.push('details.verdict is pass but coverage is incomplete')
        if (!archived && Array.isArray(prior)) for (const id of prior) {
          if (typeof id === 'string' && FINDING_ID.test(id) && !(Array.isArray(details.findings) && details.findings.some((f) => f?.id === id)) && !(Array.isArray(details.closed) && details.closed.some((c) => c?.id === id))) defects.push(`details must carry or close prior finding ${id}`)
        }
      }
      if (role === 'lead' && details.decision === 'bounce' && !Object.hasOwn(details, 'target')) defects.push('details.target is required for a bounce: builder or planner')
    }
  }
  return { envelope, defects }
}
