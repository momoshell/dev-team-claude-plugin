// The protocols code reads at the agent boundary (ADR-052 section 3). P1, the lane
// brief: markdown opened by a frontmatter block. Code reads only BRIEF_FIELDS; the
// body is the planner's to read. P5, the agent definition: the same frontmatter shape,
// one field per line, with JSON for objects and object lists. Import-free, so the new
// path never loads the old one.

export const BRIEF_FIELDS = Object.freeze(['source', 'closes', 'tier', 'shape', 'acceptance', 'out_of_scope'])
export const TIERS = Object.freeze(['mechanical', 'build', 'judge'])
export const SHAPES = Object.freeze(['standard', 'stepped', 'finish'])
export const AGENT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
const ID = /^[A-Za-z][A-Za-z0-9._-]*$/
const AGENTS = Object.freeze(['claude', 'pi'])
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
const WRITES = Object.freeze(['none', 'task-dir', 'repo'])
const EXTENSIONS = Object.freeze(['readgate', 'lab', 'builderloop', 'reminders', 'skeletonread', 'subagent', 'fff'])
const AGENT_FIELDS = Object.freeze(['name', 'description', 'role', 'writes', 'envelope', 'agent', 'model', 'effort', 'fallback', 'skills', 'requires', 'tools', 'extensions', 'advisor', 'edit_assist', 'codemode', 'memory', 'rounds', 'wait_s', 'tiers'])
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
// A heading the body repeats is listed in `repeated`; the driver reads only the first.
function sections(body) {
  const out = new Map()
  const repeated = []
  let current = null
  let fence = null
  for (const line of body.split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) { if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null; continue }
    if (mark) { fence = mark; continue }
    if (/^#{1,2}\s+/.test(line)) {
      current = line.trim()
      if (out.has(current)) repeated.push(current)
      else out.set(current, [])
      continue
    }
    if (current) out.get(current).push(line)
  }
  return { parts: out, repeated }
}

// Returns { fields, body, defects }. An empty defects list is a brief code can start.
export function parseBrief(text) {
  const lines = String(text ?? '').split('\n')
  if (lines[0]?.trim() !== '---') return { fields: null, body: null, defects: ['the brief does not open with a --- frontmatter block'] }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { fields: null, body: null, defects: ['the frontmatter block is never closed with ---'] }
  const fields = {}
  const defects = []
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const pair = /^([a-z_]+):(.*)$/.exec(line)
    if (!pair) { defects.push(`frontmatter line is not key: value: ${JSON.stringify(line)}`); continue }
    if (!BRIEF_FIELDS.includes(pair[1])) { defects.push(`unknown field ${pair[1]}; the fields are ${BRIEF_FIELDS.join(', ')}`); continue }
    fields[pair[1]] = value(pair[2])
  }
  for (const key of BRIEF_FIELDS) if (!Object.hasOwn(fields, key)) defects.push(`missing field ${key}`)
  const body = lines.slice(end + 1).join('\n')
  if (typeof fields.source !== 'string' || !fields.source) defects.push('source names the issue or operator command the lane starts from')
  if (fields.closes !== null && !(Number.isSafeInteger(fields.closes) && fields.closes > 0)) defects.push('closes is null or one issue number')
  if (!TIERS.includes(fields.tier)) defects.push(`tier is one of ${TIERS.join(', ')}`)
  if (!SHAPES.includes(fields.shape)) defects.push(`shape is one of ${SHAPES.join(', ')}`)
  if (typeof fields.out_of_scope !== 'string' || !fields.out_of_scope) defects.push('out_of_scope says what the lane must not change')
  const acceptance = Array.isArray(fields.acceptance) ? fields.acceptance : []
  if (acceptance.length === 0 || !acceptance.every((id) => typeof id === 'string' && ID.test(id))) defects.push('acceptance lists the gate ids, each a letter then letters, digits, . _ or -')
  else if (new Set(acceptance).size !== acceptance.length) defects.push('acceptance repeats an id')
  const { parts, repeated } = sections(body)
  if (repeated.length) defects.push(`the body repeats ${[...new Set(repeated)].join(', ')}; the driver reads only the first`)
  const heads = (parts.get('## Acceptance') ?? []).map((line) => /^\s*[-*]\s+\(([^)]+)\)/.exec(line)?.[1]).filter(Boolean)
  if (acceptance.length && heads.join(' ') !== acceptance.join(' ')) defects.push(`the ## Acceptance items open with (${heads.join(') (') || 'none'}), not the frontmatter ids (${acceptance.join(') (')})`)
  // `closes` is the only issue binding; crew start writes it into the driver's bound-issue slot.
  const stray = body.match(/#\d+/g)
  if (stray) defects.push(`the body names ${stray.join(', ')}; write "issue N" or "PR N", because closes is the only issue binding`)
  return { fields, body, defects }
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
  edit_assist: [(v) => typeof v === 'boolean', 'is true or false'],
  codemode: [(v) => typeof v === 'boolean', 'is true or false'],
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

// A fallback stays on the seat's agent and never names the seat's own model.
function fallbackDefects(fields, prefix) {
  if (!Array.isArray(fields.fallback)) return []
  const out = []
  fields.fallback.forEach((entry, index) => {
    if (!plain(entry)) return
    if (entry.model === fields.model) out.push(`${prefix}fallback[${index}].model is the seat's own model ${fields.model}`)
    if (typeof entry.agent === 'string' && typeof fields.agent === 'string' && entry.agent !== fields.agent) out.push(`${prefix}fallback[${index}].agent ${entry.agent} changes the seat's agent ${fields.agent}`)
  })
  return out
}

// Type and vocabulary defects for the fields present; `prefix` locates a tier override.
function validateAgentFields(fields, prefix = '') {
  const out = []
  for (const [key, v] of Object.entries(fields)) {
    if (Object.hasOwn(AGENT_RULES, key)) { if (!AGENT_RULES[key][0](v)) out.push(`${prefix}${key} ${AGENT_RULES[key][1]}`) }
    else if (key === 'fallback') {
      if (!Array.isArray(v)) out.push(`${prefix}fallback is a list of {agent, model, effort} objects`)
      else v.forEach((entry, index) => out.push(...entryDefects(entry, `${prefix}fallback[${index}]`, ['agent', 'model'], ['effort'])))
    } else if (key === 'advisor' && v !== null) out.push(...entryDefects(v, `${prefix}advisor`, ['agent', 'model', 'effort']))
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
  agentDefects.push(...validateAgentFields(fields), ...fallbackDefects(fields, ''))
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
      // The effective seat is checked only when the base is sound, so one fault reports once.
      if (!fallbackDefects(fields, '').length) agentDefects.push(...fallbackDefects({ ...fields, ...allowed }, `${path}.`))
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
export const LEAD_DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])
export const FINDING_SEVERITIES = Object.freeze(['must-fix', 'should-fix', 'consider'])
export const FINDING_DISPOSITIONS = Object.freeze(['auto-fix', 'ask-user', 'no-op'])
const FINDING_ID = /^[A-Za-z0-9_-]{1,64}$/
const REVIEW_KEYS = Object.freeze(['verdict', 'findings'])
const DETAIL_KEYS = Object.freeze({
  planner: ['plan_path', 'gate_path', 'acceptance', 'mutations'],
  builder: ['summary'],
  reviewer: REVIEW_KEYS,
  'tech-lead': REVIEW_KEYS,
  lead: ['decision'],
})
const DETAIL_RULES = {
  plan_path: [nonempty, 'is a nonempty string'],
  gate_path: [nonempty, 'is a nonempty string'],
  summary: [nonempty, 'is a nonempty string'],
  verdict: [(v) => REVIEW_VERDICTS.includes(v), `is one of ${REVIEW_VERDICTS.join(', ')}`],
  decision: [(v) => LEAD_DECISIONS.includes(v), `is one of ${LEAD_DECISIONS.join(', ')}`],
}
const MUTATION_KEYS = Object.freeze(['check', 'file', 'find', 'replace'])
const FINDING_REQUIRED = Object.freeze(['id', 'severity', 'location', 'summary'])
const FINDING_RULES = {
  id: [(v) => typeof v === 'string' && FINDING_ID.test(v), 'is 1-64 letters, digits, _ or -'],
  severity: [(v) => FINDING_SEVERITIES.includes(v), `is one of ${FINDING_SEVERITIES.join(', ')}`],
  location: [nonempty, 'is a nonempty string'],
  summary: [nonempty, 'is a nonempty string'],
  disposition: [(v) => FINDING_DISPOSITIONS.includes(v), `is one of ${FINDING_DISPOSITIONS.join(', ')}`],
  patch: [nonempty, 'is a nonempty string'],
}

// One declaration per acceptance id, each exactly {check, file, find, replace}; whether the file and
// the find resolve in the checkout is the mutation proof's to measure, not this schema's.
function mutationDefects(v, acceptance) {
  if (!Array.isArray(v)) return ['details.mutations is a list of {check, file, find, replace} declarations']
  const out = []
  const seen = new Set()
  v.forEach((entry, index) => {
    const path = `details.mutations[${index}]`
    if (!plain(entry)) { out.push(`${path} is an object with ${MUTATION_KEYS.join(', ')}`); return }
    for (const key of Object.keys(entry)) if (!MUTATION_KEYS.includes(key)) out.push(`${path}.${key} is not a mutation field`)
    for (const key of MUTATION_KEYS) {
      if (!Object.hasOwn(entry, key)) out.push(`${path}.${key} is required`)
      else if (typeof entry[key] !== 'string') out.push(`${path}.${key} is a string`)
    }
    if (entry.find === '') out.push(`${path}.find is a nonempty string`)
    else if (entry.replace === entry.find) out.push(`${path}.replace differs from find`)
    if (typeof entry.check === 'string') {
      if (seen.has(entry.check)) out.push(`${path}.check repeats ${entry.check}`)
      seen.add(entry.check)
      if (Array.isArray(acceptance) && !acceptance.includes(entry.check)) out.push(`${path}.check ${entry.check} is not a declared acceptance id`)
    }
  })
  if (Array.isArray(acceptance)) for (const id of acceptance) if (!seen.has(id)) out.push(`details.mutations has no declaration for acceptance ${id}`)
  return out
}

// Returns { envelope, defects }. An empty defects list is an envelope the loop can act on;
// a refused object root is still returned, a non-object root is null.
export function validateEnvelope(role, envelope) {
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
      for (const key of Object.keys(details)) if (!required.includes(key)) defects.push(`details.${key} is not a field of ${role} details`)
      for (const key of required) {
        if (!Object.hasOwn(details, key)) { defects.push(`details.${key} is required`); continue }
        const v = details[key]
        if (Object.hasOwn(DETAIL_RULES, key)) { if (!DETAIL_RULES[key][0](v)) defects.push(`details.${key} ${DETAIL_RULES[key][1]}`) }
        else if (key === 'acceptance') {
          const validAcceptance = Array.isArray(v) && v.length > 0 && v.every((id) => typeof id === 'string' && ID.test(id)) && new Set(v).size === v.length
          if (!validAcceptance) defects.push('details.acceptance is a nonempty list of unique acceptance ids')
        } else if (key === 'mutations') defects.push(...mutationDefects(v, details.acceptance))
        else if (key === 'findings' && !Array.isArray(v)) defects.push('details.findings is a list of findings')
        else if (key === 'findings') {
          const seen = new Set()
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
            const hasPatch = Object.hasOwn(finding, 'patch')
            if (finding.disposition === 'auto-fix' && !hasPatch) defects.push(`${path}.patch is required for disposition auto-fix`)
            if (hasPatch && finding.disposition !== 'auto-fix') defects.push(`${path}.patch is only allowed with disposition auto-fix`)
          })
          if (details.verdict === 'pass' && v.some((finding) => plain(finding) && finding.severity === 'must-fix')) defects.push('details.verdict is pass but the findings include a must-fix')
        }
      }
    }
  }
  return { envelope, defects }
}
