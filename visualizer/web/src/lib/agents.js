export const AGENT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
export const REFUSAL_FLAGS = Object.freeze(['extensions', 'skills', 'mcp_servers', 'local_provider'])
export const UNMEASURED_REASON = 'measurement is unavailable'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function missingReason(reason, fallback = UNMEASURED_REASON) {
  return typeof reason === 'string' && reason.trim() ? reason : fallback
}

export function markedValue(value, reason = UNMEASURED_REASON) {
  if (record(value) && Object.hasOwn(value, 'value')) {
    if (value.value === '' || value.value === null || value.value === undefined) {
      return { value: 'unmeasured', measured: false, reason: missingReason(value.reason, reason) }
    }
    return {
      value: value.value,
      measured: value.measured !== false,
      reason: value.measured === false ? missingReason(value.reason, reason) : (value.reason ?? null),
    }
  }
  if (value === '' || value === null || value === undefined) {
    return { value: 'unmeasured', measured: false, reason }
  }
  return { value, measured: true, reason: null }
}

export function absenceValue(value, reason = UNMEASURED_REASON) {
  return markedValue(value, reason)
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function normalizeFlags(value, refuses = []) {
  const source = record(value) ? value : {}
  const denied = new Set(list(refuses))
  return Object.fromEntries(REFUSAL_FLAGS.map((name) => {
    const raw = Object.hasOwn(source, name) ? source[name] : !denied.has(name)
    return [name, typeof raw === 'boolean' ? raw : markedValue(raw, `capability flag ${name} is unavailable`)]
  }))
}

export function normalizeAgents(payload = {}) {
  const rows = Array.isArray(payload?.agents) ? payload.agents : []
  return rows.map((row = {}) => {
    const refuses = list(row.refuses)
    const providers = list(row.providers)
    const transports = list(row.transports)
    return {
      ...row,
      name: typeof row.name === 'string' && row.name ? row.name : 'unmeasured',
      providers,
      transports,
      refuses,
      adapter: typeof row.adapter === 'string' && row.adapter ? row.adapter : markedValue(row.adapter, 'adapter is not recorded'),
      flags: normalizeFlags(row.flags || row.capability_flags, refuses),
      availability: markedValue(row.availability, 'availability-pending-1289'),
      install_hint: markedValue(row.install_hint, 'availability-pending-1289'),
    }
  })
}

export function agentView(payload = {}) {
  return normalizeAgents(payload)
}

function skillRows(payload) {
  return Array.isArray(payload?.skills) ? payload.skills : []
}

function matrixInput(payload) {
  if (Array.isArray(payload?.matrix)) return payload.matrix
  if (Array.isArray(payload?.role_by_skill)) return payload.role_by_skill
  if (Array.isArray(payload?.roles)) return payload.roles
  return []
}

function cellInput(row, name) {
  const source = row?.cells || row?.skills
  if (record(source) && record(source[name])) return source[name]
  if (record(row?.[name])) return row[name]
  return {}
}

function registerMark(value, reason) {
  if (typeof value === 'boolean') return value
  return markedValue(value, reason)
}

export function skillCell(registerGrant, lastSeatDelivery) {
  return { register_grant: registerGrant, last_seat_delivery: lastSeatDelivery }
}

export function buildSkillMatrix(payload = {}, skills = skillRows(payload)) {
  const names = skills.map((skill) => skill?.name).filter((name) => typeof name === 'string' && name)
  const rows = matrixInput(payload)
  const byRole = new Map(rows.map((row) => [row?.role, row]))
  return AGENT_ROLES.map((role) => {
    const row = byRole.get(role) || { role }
    const cells = Object.fromEntries(names.map((name) => {
      const source = cellInput(row, name)
      const registerGrant = registerMark(source.register_grant, `register grant for ${role}/${name} is unavailable`)
      const lastSeatDelivery = source.last_seat_delivery === undefined
        ? markedValue(undefined, `last-seat delivery for ${role}/${name} is unavailable`)
        : (typeof source.last_seat_delivery === 'boolean' ? source.last_seat_delivery : markedValue(source.last_seat_delivery, `last-seat delivery for ${role}/${name} is unavailable`))
      return [name, skillCell(registerGrant, lastSeatDelivery)]
    }))
    return { role, cells, skills: cells }
  })
}

export function normalizeSkills(payload = {}) {
  const skills = skillRows(payload).map((skill = {}) => ({
    ...skill,
    name: typeof skill.name === 'string' && skill.name ? skill.name : 'unmeasured',
    description: typeof skill.description === 'string' && skill.description ? skill.description : markedValue(skill.description, 'skill frontmatter is unavailable'),
  }))
  const matrix = buildSkillMatrix(payload, skills)
  return { skills, matrix, rows: matrix }
}

export function skillsView(payload = {}) {
  return normalizeSkills(payload)
}

export function normalizePrompts(payload = {}) {
  const prompts = Array.isArray(payload?.prompts) ? payload.prompts : []
  return prompts.map((prompt = {}) => ({
    ...prompt,
    role: typeof prompt.role === 'string' && prompt.role ? prompt.role : 'unmeasured',
    text: typeof prompt.text === 'string' ? prompt.text : null,
    source_bytes: markedValue(prompt.source_bytes, 'prompt source byte size is unavailable'),
    charter_bytes: markedValue(prompt.charter_bytes, 'charter_bytes is unavailable from the last boot journal'),
    arm: markedValue(prompt.arm, 'compiled role prompt is unavailable'),
    protected: prompt.protected || prompt.label || 'protected: prompt-surface',
  }))
}

export function promptsView(payload = {}) {
  return normalizePrompts(payload)
}

export function toneFor(value) {
  const mark = markedValue(value)
  if (mark.measured === false) return 'unmeasured'
  if (mark.value === true || mark.value === 'executable' || mark.value === 'measured') return 'measured'
  if (mark.value === false || mark.value === 'proposal-stub') return 'neutral'
  return 'neutral'
}

export function displayTone(value) {
  return toneFor(value)
}

export function displayValue(value) {
  const mark = record(value) && Object.hasOwn(value, 'value') ? value : markedValue(value)
  return mark.measured === false ? `Unmeasured — ${mark.reason}` : String(mark.value)
}

export function flagValue(value) {
  if (value === true) return 'allowed'
  if (value === false) return 'refused'
  return displayValue(value)
}

export function normalizeAgentsPage(payload = {}) {
  return {
    agents: normalizeAgents(payload),
    skills: normalizeSkills(payload),
    prompts: normalizePrompts(payload),
    reasons: Array.isArray(payload?.reasons) ? payload.reasons.filter((reason) => typeof reason === 'string' && reason) : [],
  }
}
