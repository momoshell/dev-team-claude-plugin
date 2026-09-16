import { readFileSync as fsReadFileSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { unifiedDiff } from './roster-edit.mjs'

export const AGENT_REFUSALS = Object.freeze(['extensions', 'skills', 'mcp_servers', 'local_provider'])
export const AGENT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
export const CHARTER_ROLES = Object.freeze(['_shared', ...AGENT_ROLES])
export const DELIVERY_STORES = Object.freeze(['headless', 'headless-json', 'headless-rpc', 'pane'])
export const AVAILABILITY_REASON = 'availability-pending-1289'
export const PROMPT_LABEL = 'protected: prompt-surface'

const DEFAULT_REASONS = Object.freeze({
  register: 'capability register is unavailable',
  skills: 'skill inventory is unavailable',
  prompt: 'prompt source is unavailable',
  recipients: 'prompt recipients are unavailable',
  command: 'last-seat delivery has no readable command evidence',
  journal: 'last boot journal evidence is unavailable',
  arm: 'compiled role prompt is unavailable',
})

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textValue(value) {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return null
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function reasonText(prefix, error) {
  const detail = error?.message || error?.code || (error ? String(error) : '')
  return detail ? `${prefix}: ${detail}` : prefix
}

function marked(value, reason) {
  if (value === undefined || value === null || value === '') return { value: 'unmeasured', measured: false, reason: reason || 'measurement is unavailable' }
  return { value, measured: true, reason: null }
}

function safeRead(read, path, label) {
  try {
    const value = textValue(read(path, 'utf8'))
    if (value === null) return { text: null, reason: reasonText(`${label} returned an unknown value`) }
    if (value === '') return { text: null, reason: reasonText(`${label} is empty`) }
    return { text: value, reason: null }
  } catch (error) {
    return { text: null, reason: reasonText(`${label} could not be read`, error) }
  }
}

function safeEntries(readdir, path) {
  try {
    const entries = readdir(path, { withFileTypes: true })
    if (!Array.isArray(entries)) return []
    return entries.map((entry) => {
      if (typeof entry === 'string') return { name: entry, directory: null }
      return { name: entry?.name, directory: typeof entry?.isDirectory === 'function' ? entry.isDirectory() : null }
    }).filter((entry) => typeof entry.name === 'string' && entry.name !== '')
  } catch {
    return []
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function refusal(code, message) {
  return { code, message }
}

function proposalResult({ ok = false, diff = null, refusals = [], target_path = null, after_text = null, extra = {} } = {}) {
  return { ok, diff, refusals, target_path, after_text, ...extra }
}

function validName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)
}

function validPath(value) {
  return typeof value === 'string' && value !== '' && !isAbsolute(value) && !value.split('/').includes('..') && /^[A-Za-z0-9._/-]+$/.test(value)
}

function targetInside(root, target) {
  const base = resolve(root)
  const full = resolve(target)
  const suffix = relative(base, full)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${requirePathSeparator()}`) && !isAbsolute(suffix)
}

function requirePathSeparator() {
  return process.platform === 'win32' ? '\\' : '/'
}

function parseJson(read, path, label) {
  const source = safeRead(read, path, label)
  if (!source.text) return { value: null, text: null, refusals: [refusal('read-unavailable', source.reason || `${label} is unavailable`)] }
  try {
    const value = JSON.parse(source.text)
    if (!record(value)) return { value: null, text: source.text, refusals: [refusal('json-shape', `${label} must contain a JSON object`)] }
    return { value, text: source.text, refusals: [] }
  } catch (error) {
    return { value: null, text: source.text, refusals: [refusal('json-malformed', `${label} is malformed JSON: ${error?.message || String(error)}`)] }
  }
}

function readRegister(read, checkout) {
  const path = join(checkout, 'crew', 'capabilities.json')
  const parsed = parseJson(read, path, path)
  return { ...parsed, path }
}

function readFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---\n')) return { value: null, reason: 'skill frontmatter is missing' }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { value: null, reason: 'skill frontmatter is unterminated' }
  const block = text.slice(4, end).split(/\r?\n/)
  const fields = {}
  let current = null
  for (const line of block) {
    const match = line.match(/^(name|description):\s*(.*)$/)
    if (match) {
      current = match[1]
      let value = match[2].trim()
      if (value === '>-' || value === '>' || value === '|-' || value === '|') value = ''
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      fields[current] = value
      continue
    }
    if (current === 'description' && /^\s+/.test(line) && line.trim()) fields.description = `${fields.description || ''}${fields.description ? ' ' : ''}${line.trim()}`
  }
  if (!nonBlank(fields.name) || !nonBlank(fields.description)) return { value: null, reason: 'skill frontmatter needs non-empty name and description' }
  return { value: { name: fields.name.trim(), description: fields.description.trim() }, reason: null }
}

function listSkills({ read, readdir, checkout }) {
  const root = join(checkout, 'skills')
  const entries = safeEntries(readdir, root)
  const skills = []
  const reasons = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.directory === false || !validName(entry.name)) continue
    const path = join(root, entry.name, 'SKILL.md')
    const source = safeRead(read, path, path)
    if (!source.text) {
      reasons.push(source.reason || `${path} is unavailable`)
      skills.push({ name: entry.name, description: null, content: marked(null, source.reason || 'skill content is unavailable'), path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: marked(null, source.reason || 'skill frontmatter is unavailable') })
      continue
    }
    const frontmatter = readFrontmatter(source.text)
    if (!frontmatter.value) {
      reasons.push(`${path}: ${frontmatter.reason}`)
      skills.push({ name: entry.name, description: null, content: marked(null, `${path}: ${frontmatter.reason}`), path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: marked(null, `${path}: ${frontmatter.reason}`) })
      continue
    }
    skills.push({ name: frontmatter.value.name, description: frontmatter.value.description, content: source.text, path: relative(checkout, path).replaceAll('\\', '/'), frontmatter: frontmatter.value })
  }
  return { skills, reasons }
}

function registerFlags(refuses) {
  const set = new Set(Array.isArray(refuses) ? refuses : [])
  return Object.fromEntries(AGENT_REFUSALS.map((name) => [name, !set.has(name)]))
}

function registerAgents(register, reasons) {
  const entries = record(register?.coding_agents) ? register.coding_agents : {}
  return Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
    const safe = record(entry) ? entry : {}
    const refuses = Array.isArray(safe.refuses) ? safe.refuses.filter((value) => AGENT_REFUSALS.includes(value)) : []
    const availabilityMark = Object.hasOwn(safe, 'availability')
      ? marked(safe.availability, null)
      : marked(null, AVAILABILITY_REASON)
    const installMark = Object.hasOwn(safe, 'install_hint')
      ? marked(safe.install_hint, null)
      : marked(null, AVAILABILITY_REASON)
    if (availabilityMark.measured === false && availabilityMark.reason) reasons.push(`${name} availability: ${availabilityMark.reason}`)
    if (installMark.measured === false && installMark.reason) reasons.push(`${name} install hint: ${installMark.reason}`)
    return {
      name,
      providers: Array.isArray(safe.providers) ? [...safe.providers] : [],
      transports: Array.isArray(safe.transports) ? [...safe.transports] : [],
      adapter: typeof safe.adapter === 'string' ? safe.adapter : null,
      refuses,
      flags: registerFlags(refuses),
      capability_flags: registerFlags(refuses),
      availability: availabilityMark,
      install_hint: installMark,
    }
  })
}

function commandTokens(value) {
  if (!Array.isArray(value)) return null
  return value.map((token) => String(token)).map((token) => {
    const trimmed = token.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
    return trimmed
  })
}

function shellTokens(value) {
  if (typeof value !== 'string' || value === '') return null
  const tokens = []
  let token = '', quote = null, escaped = false
  for (const character of value) {
    if (escaped) { token += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) {
      if (character === quote) quote = null
      else token += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (token !== '') { tokens.push(token); token = '' }
    } else token += character
  }
  if (escaped || quote) return null
  if (token !== '') tokens.push(token)
  return tokens
}

function deliveredNames(command) {
  if (!record(command)) return { names: null, reason: 'command evidence is not a JSON object' }
  let tokens = null
  if (Array.isArray(command.args)) tokens = commandTokens(command.args)
  else {
    const text = typeof command.command === 'string' ? command.command : typeof command.shell === 'string' ? command.shell : typeof command.cmd === 'string' ? command.cmd : null
    tokens = shellTokens(text)
  }
  if (!tokens) return { names: null, reason: 'command evidence has an unknown or interrupted token shape' }
  const names = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--skill') continue
    const operand = tokens[index + 1]
    if (!operand || operand.startsWith('--')) return { names: null, reason: 'command evidence has an empty --skill operand' }
    const normalized = operand.replaceAll('\\', '/')
    const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/)
    const name = match ? match[1] : normalized.endsWith('/SKILL.md') ? normalized.split('/').at(-2) : normalized
    if (nonBlank(name) && !names.includes(name)) names.push(name)
  }
  return { names, reason: null }
}

function laneForCommand(path) {
  const marker = `${requirePathSeparator()}task${requirePathSeparator()}`
  const index = path.lastIndexOf(marker)
  return index < 0 ? null : path.slice(0, index)
}

function candidatePaths({ readdir, crewRoot, role }) {
  const candidates = []
  for (const laneName of safeEntries(readdir, crewRoot).map((entry) => entry.name).filter((name) => name.startsWith('dt-')).sort()) {
    const laneRoot = join(crewRoot, laneName)
    for (const taskName of safeEntries(readdir, laneRoot).map((entry) => entry.name).sort()) {
      const taskRoot = join(laneRoot, taskName, 'task')
      for (const store of DELIVERY_STORES) candidates.push(join(taskRoot, store, role, 'cmd.json'))
    }
  }
  return candidates
}

function newestCommand({ read, readdir, stat, crewRoot, role }) {
  const found = []
  const failures = []
  for (const path of candidatePaths({ readdir, crewRoot, role })) {
    let info
    try {
      info = stat(path)
      if (!Number.isFinite(Number(info?.mtimeMs))) throw new Error('mtime is unavailable')
    } catch (error) {
      failures.push(reasonText(`${path} could not be statted`, error))
      continue
    }
    const source = safeRead(read, path, path)
    if (!source.text) { failures.push(source.reason || `${path} is unavailable`); continue }
    try {
      const parsed = JSON.parse(source.text)
      found.push({ path, mtimeMs: Number(info.mtimeMs), command: parsed })
    } catch (error) { failures.push(`${path} is malformed JSON: ${error?.message || String(error)}`) }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const latest = found[0]
  if (!latest) return { command: null, path: null, mtimeMs: null, names: null, reason: failures[0] || DEFAULT_REASONS.command, lane: null }
  const parsed = deliveredNames(latest.command)
  return { ...latest, ...parsed, reason: parsed.reason, lane: laneForCommand(latest.path) }
}

function validBootRows(read, path) {
  const source = safeRead(read, path, path)
  if (!source.text) return { rows: [], reason: source.reason || DEFAULT_REASONS.journal }
  const rows = []
  for (const [index, line] of source.text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (record(value) && value.event === 'boot' && record(value.charter_bytes)) rows.push({ value, index })
    } catch {}
  }
  if (!rows.length) return { rows: [], reason: `${path} has no valid boot row` }
  rows.sort((left, right) => {
    const leftAt = Date.parse(String(left.value.at || ''))
    const rightAt = Date.parse(String(right.value.at || ''))
    const leftMeasured = Number.isFinite(leftAt) ? leftAt : -Infinity
    const rightMeasured = Number.isFinite(rightAt) ? rightAt : -Infinity
    return rightMeasured - leftMeasured || right.index - left.index
  })
  return { rows, reason: null }
}

function roleDelivery({ read, readdir, stat, crewRoot, role }) {
  const command = newestCommand({ read, readdir, stat, crewRoot, role })
  if (!command.names) return {
    skills: [], measured: false, reason: command.reason || DEFAULT_REASONS.command,
    source_path: command.path, mtime_ms: command.mtimeMs, arm: marked(null, DEFAULT_REASONS.arm), charter_bytes: marked(null, DEFAULT_REASONS.journal),
  }
  const lane = command.lane
  const journal = lane ? join(lane, 'journal.jsonl') : null
  const boot = journal ? validBootRows(read, journal) : { rows: [], reason: DEFAULT_REASONS.journal }
  const row = boot.rows[0]?.value || null
  const compiledPath = lane ? join(lane, 'task', `role-${role}.md`) : null
  const compiled = compiledPath ? safeRead(read, compiledPath, compiledPath) : { text: null, reason: DEFAULT_REASONS.arm }
  const tail = '\n\nBe terse: state the result in the fewest words that carry it, and do not restate context the reader already has.\n'
  const arm = compiled.text
    ? marked(compiled.text.endsWith(tail) ? 'terse-tail' : 'control', null)
    : marked(null, compiled.reason || DEFAULT_REASONS.arm)
  const charterValue = row?.charter_bytes?.[role]
  const charterReason = charterValue == null ? row?.charter_unmeasured?.[role] || boot.reason || DEFAULT_REASONS.journal : null
  return {
    skills: command.names,
    measured: true,
    reason: null,
    source_path: command.path,
    mtime_ms: command.mtimeMs,
    arm,
    charter_bytes: Number.isFinite(Number(charterValue)) ? marked(Number(charterValue), null) : marked(null, charterReason),
    journal_path: journal,
    boot_at: row?.at || null,
  }
}

function matrixRows({ skills, register, deliveries }) {
  const configured = record(register?.roles) ? register.roles : null
  return AGENT_ROLES.map((role) => {
    const roleConfig = configured && record(configured[role]) ? configured[role] : null
    const grants = Array.isArray(roleConfig?.skills) ? roleConfig.skills : null
    const delivery = deliveries[role]
    const cells = Object.fromEntries(skills.map((skill) => {
      const name = skill.name
      const registerGrant = grants ? grants.includes(name) : marked(null, DEFAULT_REASONS.register)
      const lastSeatDelivery = delivery.measured ? delivery.skills.includes(name) : marked(null, delivery.reason || DEFAULT_REASONS.command)
      return [name, { register_grant: registerGrant, last_seat_delivery: lastSeatDelivery }]
    }))
    return { role, skills: cells, cells, delivery: { ...delivery } }
  })
}

function promptRows({ read, checkout, deliveries }) {
  const prompts = []
  const reasons = []
  for (const role of CHARTER_ROLES) {
    const path = join(checkout, 'crew', 'roles', `${role}.md`)
    const source = safeRead(read, path, path)
    const sourceBytes = source.text === null ? marked(null, source.reason || DEFAULT_REASONS.prompt) : marked(Buffer.byteLength(source.text, 'utf8'), null)
    if (!source.text) reasons.push(source.reason || `${path} is unavailable`)
    const delivery = role === '_shared' ? null : deliveries[role]
    const charterBytes = delivery?.charter_bytes || marked(null, 'shared charter has no role-keyed boot measurement')
    const arm = delivery?.arm || marked(null, 'shared charter arm is not role-keyed')
    prompts.push({
      role,
      path: relative(checkout, path).replaceAll('\\', '/'),
      text: source.text,
      recipients: null,
      recipients_reason: DEFAULT_REASONS.recipients,
      source_bytes: sourceBytes,
      charter_bytes: charterBytes,
      arm,
      protected: PROMPT_LABEL,
      label: PROMPT_LABEL,
      delivery_source: delivery?.source_path || null,
    })
  }
  return { prompts, reasons }
}

function proposalSource({ read, checkout }) {
  const register = readRegister(read, checkout)
  const before = register.text
  if (!register.value || typeof before !== 'string') return { value: null, before, path: register.path, refusals: register.refusals }
  return { value: register.value, before, path: register.path, refusals: [] }
}

function validateStringArray(value, field, { vocabulary = null, minItems = 0, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.some((item) => typeof item !== 'string' || (pattern && !pattern.test(item)) || (vocabulary && !vocabulary.includes(item)))) return [refusal('payload-shape', `${field} must be an array of ${minItems ? 'one or more ' : ''}valid strings`)]
  if (new Set(value).size !== value.length) return [refusal('payload-duplicate', `${field} must not contain duplicates`)]
  return []
}

function proposalReadFailure(source, target) {
  return proposalResult({ target_path: target, refusals: source.refusals.length ? source.refusals : [refusal('read-unavailable', `${target} could not be read`)] })
}

export function proposeAgent({ checkout = process.cwd(), name, entry, readFileSync = fsReadFileSync } = {}) {
  const source = proposalSource({ read: readFileSync, checkout: resolve(checkout) })
  const target = source.path
  if (source.refusals.length) return proposalReadFailure(source, target)
  const refusals = []
  if (!validName(name)) refusals.push(refusal('name-invalid', 'agent name must match [a-z0-9][a-z0-9-]*'))
  if (Object.hasOwn(source.value.coding_agents || {}, name)) refusals.push(refusal('name-duplicate', `coding agent ${name} already exists`))
  if (!record(entry)) refusals.push(refusal('entry-shape', 'entry must be an object'))
  const value = record(entry) ? entry : {}
  const keys = Object.keys(value)
  for (const key of keys) if (!['providers', 'transports', 'adapter', 'refuses', 'availability'].includes(key)) refusals.push(refusal('entry-field', `entry field ${key} is not supported`))
  refusals.push(...validateStringArray(value.providers, 'providers', { minItems: 1, pattern: /^[a-z0-9][a-z0-9-]*$/ }))
  refusals.push(...validateStringArray(value.transports, 'transports', { minItems: 1, vocabulary: ['pane', 'headless-json', 'headless-rpc'] }))
  if (!validPath(value.adapter)) refusals.push(refusal('adapter-path', 'adapter must be a confined checkout-relative path'))
  else if (value.adapter !== `crew/adapters/adapter-${name}.mjs`) refusals.push(refusal('adapter-path', `adapter must match coding agent ${name}: crew/adapters/adapter-${name}.mjs`))
  refusals.push(...validateStringArray(value.refuses, 'refuses', { vocabulary: AGENT_REFUSALS }))
  if (value.availability !== 'proposal-stub') refusals.push(refusal('availability-stub', 'new coding agents must carry availability: proposal-stub'))
  if (refusals.length) return proposalResult({ target_path: target, refusals })
  const afterValue = structuredClone(source.value)
  afterValue.coding_agents = {
    ...(record(afterValue.coding_agents) ? afterValue.coding_agents : {}),
    [name]: {
      providers: [...value.providers],
      transports: [...value.transports],
      adapter: value.adapter,
      refuses: [...value.refuses],
      display_name: name,
      binary: name,
      install_hint: `Install ${name} and ensure the ${name} binary is on PATH.`,
      availability: 'proposal-stub',
      availability_reason: 'proposal-stub',
    },
  }
  const after = canonicalJson(afterValue)
  return proposalResult({ ok: true, diff: unifiedDiff(source.before, after, { path: 'crew/capabilities.json' }), target_path: target, after_text: after })
}

export function proposeSkills({ checkout = process.cwd(), role, skills, readFileSync = fsReadFileSync, readdirSync = fsReaddirSync } = {}) {
  const root = resolve(checkout)
  const source = proposalSource({ read: readFileSync, checkout: root })
  const target = source.path
  if (source.refusals.length) return proposalReadFailure(source, target)
  const refusals = []
  if (!AGENT_ROLES.includes(role)) refusals.push(refusal('role-invalid', `role must be one of ${AGENT_ROLES.join(', ')}`))
  refusals.push(...validateStringArray(skills, 'skills', { pattern: /^[a-z0-9][a-z0-9-]*$/ }))
  const available = new Set(listSkills({ read: readFileSync, readdir: readdirSync, checkout: root }).skills.map((skill) => skill.name))
  for (const skill of Array.isArray(skills) ? skills : []) if (!available.has(skill)) refusals.push(refusal('skill-unknown', `skill ${skill} is not present in skills/*/SKILL.md`))
  if (refusals.length) return proposalResult({ target_path: target, refusals })
  const afterValue = structuredClone(source.value)
  afterValue.roles = record(afterValue.roles) ? afterValue.roles : {}
  afterValue.roles[role] = record(afterValue.roles[role]) ? afterValue.roles[role] : {}
  afterValue.roles[role].skills = [...skills]
  const after = canonicalJson(afterValue)
  return proposalResult({ ok: true, diff: unifiedDiff(source.before, after, { path: 'crew/capabilities.json' }), target_path: target, after_text: after })
}

export function proposePrompt({ checkout = process.cwd(), role, text, readFileSync = fsReadFileSync } = {}) {
  const root = resolve(checkout)
  const roleRoot = join(root, 'crew', 'roles')
  const target = join(roleRoot, `${String(role || '')}.md`)
  const publicTarget = `crew/roles/${String(role || '')}.md`
  const refusals = []
  if (!CHARTER_ROLES.includes(role)) refusals.push(refusal('role-invalid', `role must be one of ${CHARTER_ROLES.join(', ')}`))
  if (!targetInside(roleRoot, target)) refusals.push(refusal('path-confined', 'prompt target must remain under crew/roles/'))
  if (typeof text !== 'string' || text === '') refusals.push(refusal('text-empty', 'prompt text must be a non-empty string'))
  if (text.includes('\u0000')) refusals.push(refusal('text-invalid', 'prompt text contains a NUL byte'))
  if (refusals.length) return proposalResult({ target_path: target, refusals, extra: { labels: ['protected: prompt-surface'], public_target_path: publicTarget } })
  const beforeSource = safeRead(readFileSync, target, target)
  if (!beforeSource.text) return proposalResult({ target_path: target, refusals: [refusal('read-unavailable', beforeSource.reason || `${target} is unavailable`)], extra: { labels: ['protected: prompt-surface'], public_target_path: publicTarget } })
  const after = text.endsWith('\n') ? text : `${text}\n`
  return proposalResult({ ok: true, diff: unifiedDiff(beforeSource.text, after, { path: publicTarget }), target_path: target, after_text: after, extra: { labels: ['protected: prompt-surface'], public_target_path: publicTarget } })
}

export const proposeAgentEntry = proposeAgent
export const proposeRoleSkills = proposeSkills
export const proposeCharter = proposePrompt

export function createAgentsSource({ checkout = process.cwd(), crewRoot = process.env.HOME ? join(process.env.HOME, '.crew') : process.cwd(), readFileSync = fsReadFileSync, readdirSync = fsReaddirSync, statSync = fsStatSync } = {}) {
  const root = resolve(checkout)
  const runtimeRoot = resolve(crewRoot)
  const read = readFileSync
  const readdir = readdirSync
  const stat = statSync
  return {
    read() {
      const register = readRegister(read, root)
      const registerReasons = [...(register.refusals || []).map((item) => item.message)]
      const skillResult = listSkills({ read, readdir, checkout: root })
      const agents = registerAgents(register.value, registerReasons)
      const deliveries = Object.fromEntries(AGENT_ROLES.map((role) => [role, roleDelivery({ read, readdir, stat, crewRoot: runtimeRoot, role })]))
      const matrix = matrixRows({ skills: skillResult.skills, register: register.value, deliveries })
      const promptResult = promptRows({ read, checkout: root, deliveries })
      const reasons = [...registerReasons, ...skillResult.reasons, ...promptResult.reasons]
      for (const role of AGENT_ROLES) {
        const delivery = deliveries[role]
        if (!delivery.measured || delivery.arm.measured === false || delivery.charter_bytes.measured === false) reasons.push(`${role}: ${delivery.reason || delivery.arm.reason || delivery.charter_bytes.reason || DEFAULT_REASONS.command}`)
      }
      const roleEvidence = Object.fromEntries(AGENT_ROLES.map((role) => [role, deliveries[role]]))
      return {
        schema: 1,
        degraded: reasons.length > 0,
        reasons: [...new Set(reasons.filter(nonBlank))],
        error: register.value ? null : (registerReasons[0] || DEFAULT_REASONS.register),
        agents,
        skills: skillResult.skills,
        roles: matrix,
        matrix,
        role_by_skill: matrix,
        role_evidence: roleEvidence,
        prompts: promptResult.prompts,
        checkout: root,
        crew_root: runtimeRoot,
      }
    },
    proposeAgent(input = {}) { return proposeAgent({ ...input, checkout: root, readFileSync: read }) },
    proposeSkills(input = {}) { return proposeSkills({ ...input, checkout: root, readFileSync: read, readdirSync: readdir }) },
    proposePrompt(input = {}) { return proposePrompt({ ...input, checkout: root, readFileSync: read }) },
  }
}
