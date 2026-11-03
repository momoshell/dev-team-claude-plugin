const AGENT_ROLES = Object.freeze(['lead', 'planner', 'builder', 'reviewer', 'tech-lead'])
const UNMEASURED_REASON = 'measurement is unavailable'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function missingReason(reason, fallback = UNMEASURED_REASON) {
  return typeof reason === 'string' && reason.trim() ? reason : fallback
}

function markedValue(value, reason = UNMEASURED_REASON) {
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

function skillCell(registerGrant, lastSeatDelivery) {
  return { register_grant: registerGrant, last_seat_delivery: lastSeatDelivery }
}

function buildSkillMatrix(payload = {}, skills = skillRows(payload)) {
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

function normalizeSkills(payload = {}) {
  const skills = skillRows(payload).map((skill = {}) => ({
    ...skill,
    name: typeof skill.name === 'string' && skill.name ? skill.name : 'unmeasured',
    description: typeof skill.description === 'string' && skill.description ? skill.description : markedValue(skill.description, 'skill frontmatter is unavailable'),
    content: typeof skill.content === 'string' && skill.content ? skill.content : markedValue(skill.content, 'skill content is unavailable'),
  }))
  const matrix = buildSkillMatrix(payload, skills)
  return { skills, matrix, rows: matrix }
}

function measuredGrant(value) {
  if (typeof value === 'boolean') return value
  if (record(value) && value.measured !== false && typeof value.value === 'boolean') return value.value
  return null
}

function grantReason(value, fallback) {
  return record(value) && typeof value.reason === 'string' && value.reason.trim() ? value.reason : fallback
}

export function normalizeSkillsPage(payload = {}) {
  const normalized = normalizeSkills(payload)
  const rows = normalized.skills.map((skill) => {
    const grants = normalized.matrix.map((row) => {
      const grant = row.cells[skill.name]?.register_grant
      return { role: row.role, raw: grant, value: measuredGrant(grant) }
    })
    const unknown = grants.filter((grant) => grant.value === null)
    const holders = unknown.length
      ? {
          value: null,
          measured: false,
          reason: unknown.map((grant) => `${grant.role}: ${grantReason(grant.raw, `register grant for ${grant.role}/${skill.name} is unavailable`)}`).join('; '),
        }
      : { value: grants.filter((grant) => grant.value === true).map((grant) => grant.role), measured: true, reason: null }
    return { ...skill, holders }
  })
  return {
    skills: rows,
    rows,
    matrix: normalized.matrix,
    reasons: Array.isArray(payload?.reasons) ? payload.reasons.filter((reason) => typeof reason === 'string' && reason) : [],
  }
}

function toneFor(value) {
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
