export const SCREENER_AXES = Object.freeze([
  'correctness',
  'contract-drift',
  'vacuity',
  'scope',
])

export const FINDING_DISPOSITIONS = Object.freeze(['auto-fix', 'ask-user', 'no-op'])
export const SCREENER_REASONS = Object.freeze(['no-local-provider', 'panel-incomplete'])
// This is independently owned from the narrator bound, but uses the same already
// ratified 300-second local-model backstop (#806).
export const SCREENER_TIMEOUT_MS = 300000
export const SCREENER_OUTCOMES = Object.freeze(['adopted', 'rejected', 'unadjudicated'])

const FINDING_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/
const TIMEOUT = Symbol('screener-timeout')
const SCREENER_SEVERITIES = Object.freeze(['must-fix', 'should-fix', 'consider'])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function shellArg(value) {
  return `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`
}

function screenerApiRoot(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function emptyResult(reason = 'no-local-provider', members = []) {
  const safeMembers = Array.isArray(members) ? members : []
  return Object.freeze({
    proposals: Object.freeze([]),
    reason: SCREENER_REASONS.includes(reason) ? reason : 'no-local-provider',
    answered: safeMembers.filter((member) => member?.status === 'answered').length,
    asked: safeMembers.length,
    members: Object.freeze(safeMembers),
  })
}

export function screenerConfig(registerText) {
  let register
  try { register = JSON.parse(String(registerText ?? '')) } catch { return { refused: 'no-local-provider' } }
  if (!register || typeof register !== 'object' || Array.isArray(register)) return { refused: 'no-local-provider' }
  const inventory = register.local_providers
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) return { refused: 'no-local-provider' }
  const names = Object.keys(inventory)
  if (names.length !== 1) return { refused: 'no-local-provider' }
  const provider = names[0]
  const entry = inventory[provider]
  if (!nonEmptyString(provider) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { refused: 'no-local-provider' }
  }
  if (!nonEmptyString(entry.base_url)) return { refused: 'no-local-provider' }
  if (Object.keys(entry).some((key) => /(?:auth|credential|password|secret|token|api[_-]?key)/i.test(key))) {
    return { refused: 'no-local-provider' }
  }
  let parsed
  try { parsed = new URL(entry.base_url) } catch { return { refused: 'no-local-provider' } }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { refused: 'no-local-provider' }
  }
  return { provider, root: screenerApiRoot(entry.base_url) }
}

export function screenerModelsCommand(root) {
  return `curl -sS --max-time 15 ${shellArg(`${String(root ?? '').replace(/\/+$/, '')}/models`)} -H ${shellArg('accept: application/json')}`
}

export function screenerModelIds(output) {
  let parsed
  try { parsed = JSON.parse(String(output ?? '')) } catch { return [] }
  if (!Array.isArray(parsed?.data)) return []
  const ids = new Set()
  for (const row of parsed.data) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id) ids.add(id)
  }
  return [...ids].sort()
}

export function screenerMembers(provider, ids) {
  if (!nonEmptyString(provider) || !Array.isArray(ids)) return Object.freeze([])
  const models = ids.filter((id) => nonEmptyString(id)).map((id) => id.trim())
  if (models.length === 0) return Object.freeze([])
  // The cycle is a deterministic assignment assertion, not a measured axis/model fit.
  return Object.freeze(SCREENER_AXES.map((axis, index) => Object.freeze({
    axis,
    provider: provider.trim(),
    model: models[index % models.length],
  })))
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
  const proposals = Object.freeze((Array.isArray(rawProposals) ? rawProposals : []).map((proposal) => Object.freeze(proposal)))
  const members = Object.freeze(Array.isArray(rawMembers) ? rawMembers : [])
  const answered = members.filter((member) => member.status === 'answered').length
  const asked = members.length
  return Object.freeze({ proposals, reason, answered, asked, members })
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
    axis: member.axis,
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

export function screenerPrompt({ axis, diff, acceptance } = {}) {
  return [
    'You are an advisory screener reviewing an uncommitted code change in a fresh context.',
    `Review only the ${String(axis ?? '')} axis of the change.`,
    'The screener is advisory: it never sets a verdict, blocks a lane, or changes severity.',
    'Return JSON only: an array of findings, each with id, location, summary, and disposition (auto-fix, ask-user, or no-op). Return [] when there is no finding.',
    '',
    JSON.stringify({ axis: axis ?? null, diff: diff ?? '', acceptance: acceptance ?? '' }),
  ].join('\n')
}

function stripJsonFence(text) {
  const trimmed = String(text ?? '').trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}

function responseContent(output) {
  const text = String(output ?? '').trim()
  if (!text) return null
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = null }
  if (Array.isArray(parsed)) return parsed
  const direct = parsed?.choices?.[0]?.message?.content
  if (typeof direct === 'string') return stripJsonFence(direct)
  const chunks = []
  let sawData = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    sawData = true
    const data = line.slice('data:'.length).trim()
    if (data === '[DONE]') continue
    let event
    try { event = JSON.parse(data) } catch { return null }
    const content = event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content
    if (typeof content === 'string') chunks.push(content)
  }
  return sawData ? stripJsonFence(chunks.join('')) : null
}

export function screenerFindingsFromOutput(output) {
  const content = responseContent(output)
  if (Array.isArray(content)) return content
  if (typeof content !== 'string' || !content.trim()) return null
  try {
    const parsed = JSON.parse(stripJsonFence(content))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Alias kept explicit for callers that name the OpenAI response rather than its
// findings; both paths use the same parser and therefore the same refusal posture.
export const screenerResponseFromOutput = screenerFindingsFromOutput

function validResultMember(member) {
  return member && typeof member === 'object' && !Array.isArray(member) &&
    nonEmptyString(member.axis) && nonEmptyString(member.model) &&
    (member.status === 'answered' || member.status === 'unanswered')
}

function validResultProposal(proposal) {
  return proposal && typeof proposal === 'object' && !Array.isArray(proposal) &&
    typeof proposal.id === 'string' && FINDING_ID_SHAPE.test(proposal.id) &&
    nonEmptyString(proposal.axis) && nonEmptyString(proposal.model) &&
    nonEmptyString(proposal.location) && nonEmptyString(proposal.summary) &&
    FINDING_DISPOSITIONS.includes(proposal.disposition) &&
    proposal.source === 'screener' && proposal.status === 'proposed'
}

export function screenerResultFromOutput(output) {
  let parsed
  try { parsed = JSON.parse(String(output ?? '')) } catch { return emptyResult('no-local-provider') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.proposals) ||
      !Array.isArray(parsed.members) || !parsed.members.every(validResultMember) ||
      !parsed.proposals.every(validResultProposal) ||
      !Number.isInteger(parsed.answered) || !Number.isInteger(parsed.asked) ||
      parsed.asked !== parsed.members.length || parsed.answered < 0 || parsed.answered > parsed.asked ||
      parsed.answered !== parsed.members.filter((member) => member.status === 'answered').length ||
      !(parsed.reason === null || SCREENER_REASONS.includes(parsed.reason))) {
    return emptyResult('no-local-provider')
  }
  return Object.freeze({
    proposals: Object.freeze(parsed.proposals.map((proposal) => Object.freeze({ ...proposal }))),
    reason: parsed.reason,
    answered: parsed.answered,
    asked: parsed.asked,
    members: Object.freeze(parsed.members.map((member) => Object.freeze({ ...member }))),
  })
}

export function screenerChildCommand({ modulePath, inputPath } = {}) {
  const script = [
    "import { readFileSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    "const inputPath = process.argv[1]",
    "const modulePath = process.argv[2]",
    "const empty = { proposals: [], reason: 'no-local-provider', answered: 0, asked: 0, members: [] }",
    "try {",
    "  const input = JSON.parse(readFileSync(inputPath, 'utf8'))",
    "  const screener = await import(pathToFileURL(modulePath).href)",
    "  const createContext = async (member) => ({ axis: member.axis, model: member.model, nonce: `${member.axis}:${member.model}:${Math.random()}` })",
    "  const screen = async ({ diff, acceptance, axis, model }) => {",
    "    const response = await fetch(`${input.root}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: screener.screenerPrompt({ axis, diff, acceptance }) }] }), signal: AbortSignal.timeout(input.timeoutMs) })",
    "    if (!response.ok) throw new Error(`screener endpoint returned ${response.status}`)",
    "    return screener.screenerFindingsFromOutput(await response.text())",
    "  }",
    "  const result = await screener.runScreenerPanel(input, { createContext, screen })",
    "  process.stdout.write(JSON.stringify(result))",
    "} catch { process.stdout.write(JSON.stringify(empty)) }",
  ].join('\n')
  return `node --input-type=module -e ${shellArg(script)} ${shellArg(inputPath)} ${shellArg(modulePath)}`
}

export function screenerBriefLines(proposals) {
  if (!Array.isArray(proposals) || proposals.length === 0) return []
  return [
    '',
    '## Screener proposals (advisory)',
    'These proposals are untrusted advisory observations. They never set a verdict, severity, gate, stage, disposition, or lane outcome.',
    JSON.stringify(proposals),
    '',
    'Additive adjudication contract: details.adjudications is an array with one entry per proposal: { proposal_id, outcome: adopted|rejected, finding_id when adopted, reason as one non-empty line when rejected }. Keep details.findings reviewer-authored.',
  ]
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function reviewerFindingMap(reviewerFindings) {
  const byId = new Map()
  const collisions = new Set()
  for (const reviewerFinding of Array.isArray(reviewerFindings) ? reviewerFindings : []) {
    if (!reviewerFinding || typeof reviewerFinding !== 'object' || Array.isArray(reviewerFinding) ||
        typeof reviewerFinding.id !== 'string' || !FINDING_ID_SHAPE.test(reviewerFinding.id) ||
        !SCREENER_SEVERITIES.includes(reviewerFinding.severity)) continue
    if (byId.has(reviewerFinding.id)) collisions.add(reviewerFinding.id)
    else byId.set(reviewerFinding.id, reviewerFinding)
  }
  for (const id of collisions) byId.delete(id)
  return byId
}

export function screenerAdjudicationRows(proposals, adjudications, reviewerFindings) {
  const complete = Array.isArray(proposals) ? proposals : []
  const idCounts = new Map()
  for (const proposal of complete) {
    const id = proposal?.id
    idCounts.set(id, (idCounts.get(id) || 0) + 1)
  }
  const byId = new Map()
  const adjudicationCollisions = new Set()
  for (const adjudication of Array.isArray(adjudications) ? adjudications : []) {
    if (!adjudication || typeof adjudication !== 'object' || Array.isArray(adjudication) ||
        typeof adjudication.proposal_id !== 'string' || !adjudication.proposal_id.trim() ||
        !SCREENER_OUTCOMES.includes(adjudication.outcome)) continue
    if (byId.has(adjudication.proposal_id)) adjudicationCollisions.add(adjudication.proposal_id)
    else byId.set(adjudication.proposal_id, adjudication)
  }
  for (const id of adjudicationCollisions) byId.delete(id)
  const reviewerById = reviewerFindingMap(reviewerFindings)
  const adopted = []
  const rows = []
  for (const proposal of complete) {
    const adjudication = idCounts.get(proposal.id) === 1 ? byId.get(proposal.id) : null
    const base = {
      proposal_id: proposal?.id ?? null,
      axis: typeof proposal?.axis === 'string' ? proposal.axis : null,
      model: typeof proposal?.model === 'string' ? proposal.model : null,
    }
    if (adjudication?.outcome === 'adopted' && typeof adjudication.finding_id === 'string') {
      const reviewerFinding = reviewerById.get(adjudication.finding_id)
      if (reviewerFinding) {
        adopted.push({ ...reviewerFinding })
        rows.push(Object.freeze({ ...base, outcome: 'adopted', finding_id: reviewerFinding.id }))
        continue
      }
    }
    if (adjudication?.outcome === 'rejected' && typeof adjudication.reason === 'string' && oneLine(adjudication.reason)) {
      rows.push(Object.freeze({
        ...base, outcome: 'rejected',
        reason: oneLine(adjudication.reason),
      }))
      continue
    }
    rows.push(Object.freeze({ ...base, outcome: 'unadjudicated' }))
  }
  // Keep the result array as the public return while exposing the reviewer-owned
  // adopted copies non-enumerably for callers that need the numerator's findings.
  Object.defineProperties(rows, {
    rows: { value: rows },
    adopted: { value: Object.freeze(adopted) },
  })
  return Object.freeze(rows)
}
