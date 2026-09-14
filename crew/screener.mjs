export const SCREENER_AXES = Object.freeze([
  'correctness',
  'contract-drift',
  'vacuity',
  'scope',
])

export const FINDING_DISPOSITIONS = Object.freeze(['auto-fix', 'ask-user', 'no-op'])
export const SCREENER_REASONS = Object.freeze(['no-local-provider', 'panel-incomplete'])

const FINDING_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/
const TIMEOUT = Symbol('screener-timeout')

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validMember(member) {
  try {
    return member !== null && typeof member === 'object' && !Array.isArray(member) &&
      nonEmptyString(member.axis) && nonEmptyString(member.provider) && nonEmptyString(member.model)
  } catch {
    return false
  }
}

function memberIdentity(member) {
  try {
    return { axis: member?.axis, model: member?.model }
  } catch {
    return { axis: undefined, model: undefined }
  }
}

function memberRow(member, status) {
  return Object.freeze({ ...memberIdentity(member), status })
}

function makeResult(rawProposals, reason, rawMembers = []) {
  const proposals = Object.freeze(rawProposals.map((proposal) => Object.freeze(proposal)))
  const members = Object.freeze(rawMembers)
  const answered = members.filter((member) => member.status === 'answered').length
  const asked = members.length
  return Object.freeze({ proposals, reason, answered, asked, members })
}

function emptyResult(reason, members = []) {
  return makeResult([], reason, members)
}

function normalizeFinding(finding, member) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null
  if (typeof finding.id !== 'string' || !FINDING_ID_SHAPE.test(finding.id)) return null
  if (!nonEmptyString(finding.location) || !nonEmptyString(finding.summary)) return null
  if (!FINDING_DISPOSITIONS.includes(finding.disposition)) return null
  return Object.freeze({
    id: finding.id,
    severity: 'consider',
    disposition: finding.disposition,
    location: finding.location,
    summary: finding.summary,
    source: 'screener', status: 'proposed',
    model: member.model,
  })
}

function normalizeResponse(response, member) {
  if (!Array.isArray(response) || response.length === 0) return null
  const proposals = response.map((finding) => normalizeFinding(finding, member))
  return proposals.some((proposal) => proposal === null) ? null : proposals
}

async function boundedScreen(screenPass, timeoutMs) {
  let timer = null
  const timeoutPass = (duration) => new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), duration)
    timer.unref?.()
  })
  try {
    return await Promise.race([screenPass, timeoutPass(timeoutMs)])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function runMember({ diff, acceptance, timeoutMs }, member, { createContext, screen }) {
  try {
    const context = await createContext(member)
    const screenPass = Promise.resolve().then(() => screen({
      diff,
      acceptance,
      axis: member.axis,
      provider: member.provider,
      model: String(member.model),
      context,
    }))
    const response = await boundedScreen(screenPass, timeoutMs)
    const proposals = normalizeResponse(response, member)
    return proposals === null
      ? { proposals: [], member: memberRow(member, 'unanswered') }
      : { proposals, member: memberRow(member, 'answered') }
  } catch {
    return { proposals: [], member: memberRow(member, 'unanswered') }
  }
}

export async function runScreenerPanel(
  { diff, acceptance, members, timeoutMs } = {},
  { createContext, screen } = {},
) {
  const configuredMembers = Array.isArray(members) ? members : []
  if (configuredMembers.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      typeof createContext !== 'function' || typeof screen !== 'function') {
    return emptyResult('no-local-provider')
  }

  const memberValidity = configuredMembers.map((member) => validMember(member))
  if (!memberValidity.some(Boolean)) return emptyResult('no-local-provider')

  const jobs = configuredMembers.map((member, index) => memberValidity[index]
    ? runMember({ diff, acceptance, timeoutMs }, member, { createContext, screen })
    : Promise.resolve({ proposals: [], member: memberRow(member, 'unanswered') }))
  const results = await Promise.all(jobs)
  const memberRows = results.map(({ member }) => member)
  if (results.some(({ member }) => member.status === 'unanswered')) {
    return emptyResult('panel-incomplete', memberRows)
  }
  return makeResult(results.flatMap(({ proposals }) => proposals), null, memberRows)
}
