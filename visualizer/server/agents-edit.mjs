// Proposes one-line edits to a crew/agents/<role>.md frontmatter field. Pure: it reads
// nothing and writes nothing; the caller supplies the file text and applies the diff.
import { AGENT_ROLES, TIERS, parseAgent } from '../../crew/protocols.mjs'
import { unifiedDiff } from './diff.mjs'

const FIELDS = ['model', 'effort']

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function refused(refusals) {
  return { ok: false, refusals, diff: null, before: null, after: null, afterText: null }
}

const roleRefusal = (role) => ({ code: 'unknown_role', message: `unknown role ${JSON.stringify(role)}: role is one of ${AGENT_ROLES.join(', ')}` })

export function proposeAgentEdit({ agentText, agentPath, readError = null, role, tier = null, field, value } = {}) {
  if (typeof agentText !== 'string') {
    if (!AGENT_ROLES.includes(role)) return refused([roleRefusal(role)])
    const where = agentPath || `crew/agents/${role}.md`
    return refused([{ code: 'agent_unreadable', message: readError || `unable to read agent definition: unknown read error, at ${where}` }])
  }
  if (!AGENT_ROLES.includes(role)) return refused([roleRefusal(role)])
  if (!FIELDS.includes(field)) return refused([{ code: 'unknown_field', message: `unknown field ${JSON.stringify(field)}: the editable fields are ${FIELDS.join(', ')}` }])
  if (tier !== null && typeof tier !== 'string') return refused([{ code: 'bad_tier', message: 'tier must be a string or null' }])
  if (tier === null && typeof value !== 'string') return refused([{ code: 'bad_value', message: `${field} needs a string value; only a tier override can be cleared` }])
  if (value !== null && (typeof value !== 'string' || /[\r\n]/.test(value))) return refused([{ code: 'bad_value', message: 'value must be a single-line string or null' }])

  const original = parseAgent(agentText)
  if (original.defects.length) return refused(original.defects.map((message) => ({ code: 'agent_defect', message })))
  if (original.fields.name !== role || original.fields.role !== role) {
    return refused([{ code: 'agent_mismatch', message: `name and role are both ${role}, the filename; found name ${original.fields.name}, role ${original.fields.role}` }])
  }

  if (tier !== null && !TIERS.includes(tier)) {
    return refused([{ code: 'agent_defect', message: `tiers.${tier} is not a tier; the tiers are ${TIERS.join(', ')}` }])
  }

  const lines = agentText.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  const lineIndex = (key) => lines.findIndex((line, index) => index > 0 && index < end && line.startsWith(`${key}:`))
  const eol = (index) => (lines[index]?.endsWith('\r') ? '\r' : '')

  let key, text, before
  if (tier === null) {
    key = field
    before = original.fields[field]
    text = `${field}: ${value}`
  } else {
    key = 'tiers'
    const current = plain(original.fields.tiers) ? original.fields.tiers : {}
    before = plain(current[tier]) ? (current[tier][field] ?? null) : null
    if (value === null && before === null) return { ok: true, refusals: [], diff: '', before, after: null, afterText: agentText }
    const next = structuredClone(current)
    if (value === null) {
      delete next[tier][field]
      if (!Object.keys(next[tier]).length) delete next[tier]
    } else next[tier] = { ...(plain(next[tier]) ? next[tier] : {}), [field]: value }
    text = `tiers: ${JSON.stringify(next)}`
  }

  const index = lineIndex(key)
  if (index < 0) {
    if (tier !== null && value === null) return { ok: true, refusals: [], diff: '', before, after: null, afterText: agentText }
    lines.splice(end, 0, text)
  } else lines[index] = `${text}${eol(index)}`
  const afterText = lines.join('\n')

  const editedDefects = parseAgent(afterText).defects
  if (editedDefects.length) return refused(editedDefects.map((message) => ({ code: 'agent_defect', message })))
  const edited = parseAgent(afterText).fields
  const landed = tier === null ? edited[field] : (edited.tiers?.[tier]?.[field] ?? null)
  if (landed !== value) return refused([{ code: 'bad_value', message: `value ${JSON.stringify(value)} does not round-trip through the frontmatter (read back ${JSON.stringify(landed)})` }])

  const diff = unifiedDiff(agentText, afterText, { path: `crew/agents/${role}.md` })
  return { ok: true, refusals: [], diff, before, after: value, afterText }
}
