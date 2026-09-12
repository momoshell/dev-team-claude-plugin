export const REGRANT_CONDITIONS = Object.freeze([
  'where-review',
  'grant-spent',
  'must-fix-converging',
  'gate-proven',
  'regrant-budget',
])

const PANEL_SEVERITIES = Object.freeze(['must-fix', 'should-fix', 'consider'])

function emptyLocation() {
  return { file: null, start: null, end: null }
}

function parsedLocation(file, start = null, end = null) {
  return { file, start, end }
}

function safeLine(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

export function parseLocation(location) {
  if (typeof location !== 'string') return emptyLocation()
  const value = location.trim()
  if (!value) return emptyLocation()

  const range = value.match(/^(.+):(\d+)-(\d+)$/)
  if (range) {
    const file = range[1].trim()
    const start = safeLine(range[2])
    const end = safeLine(range[3])
    if (!file || start === null || end === null || end < start) return emptyLocation()
    return parsedLocation(file, start, end)
  }

  const column = value.match(/^(.+):(\d+):(\d+)$/)
  if (column) {
    const file = column[1].trim()
    const line = safeLine(column[2])
    if (!file || line === null || safeLine(column[3]) === null) return emptyLocation()
    return parsedLocation(file, line, line)
  }

  const line = value.match(/^(.+):(\d+)$/)
  if (line) {
    const file = line[1].trim()
    const number = safeLine(line[2])
    if (!file || number === null) return emptyLocation()
    return parsedLocation(file, number, number)
  }

  // A location with a colon that did not match one of the supported forms is
  // not a file-level location. This keeps malformed paths from accidentally
  // matching a finding in a different part of the file.
  if (value.includes(':')) return emptyLocation()
  return parsedLocation(value)
}

function findingEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || value.id.trim() === '') return null
  if (!PANEL_SEVERITIES.includes(value.severity)) return null
  return value
}

function rangesOverlap(a, b) {
  if (a.start === null || a.end === null || b.start === null || b.end === null) return true
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end)
}

function findingsMatch(a, b) {
  if (a.severity !== b.severity) return false
  const left = parseLocation(a.location)
  const right = parseLocation(b.location)
  if (left.file === null || right.file === null || left.file !== right.file) return false
  return rangesOverlap(left, right)
}

export function fuseFindings(a, b, options = {}) {
  const sourceA = options && typeof options === 'object' && !Array.isArray(options) && options.sourceA !== undefined
    ? options.sourceA : 'a'
  const sourceB = options && typeof options === 'object' && !Array.isArray(options) && options.sourceB !== undefined
    ? options.sourceB : 'b'
  const left = (Array.isArray(a) ? a : []).map(findingEntry).filter(Boolean)
  const right = (Array.isArray(b) ? b : []).map(findingEntry).filter(Boolean)
  const consumed = new Set()
  const consensus = []
  const unmatchedA = []

  for (const leftFinding of left) {
    let partner = null
    let partnerIndex = -1
    for (let index = 0; index < right.length; index += 1) {
      if (consumed.has(index)) continue
      if (!findingsMatch(leftFinding, right[index])) continue
      partner = right[index]
      partnerIndex = index
      break
    }
    if (!partner) {
      unmatchedA.push(leftFinding)
      continue
    }
    consumed.add(partnerIndex)
    consensus.push({
      id: leftFinding.id,
      severity: leftFinding.severity,
      location: leftFinding.location,
      summary: leftFinding.summary,
      sources: [sourceA, sourceB],
      matched: { [sourceA]: leftFinding.id, [sourceB]: partner.id },
    })
  }

  const divergent = [
    ...unmatchedA.map((finding) => ({
      id: finding.id, severity: finding.severity, location: finding.location, summary: finding.summary, source: sourceA,
    })),
    ...right.filter((_, index) => !consumed.has(index)).map((finding) => ({
      id: finding.id, severity: finding.severity, location: finding.location, summary: finding.summary, source: sourceB,
    })),
  ]
  return { consensus, divergent }
}

export function adjudicatePanel(divergent, details) {
  const entries = Array.isArray(divergent) ? divergent : []
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : null
  const adjudications = source && Array.isArray(source.adjudications) ? source.adjudications : []
  const byId = new Map()
  for (const entry of adjudications) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string') continue
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  const upheld = []
  const dismissed = []
  for (const entry of entries) {
    const copy = entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry
    const decision = copy && typeof copy === 'object' ? byId.get(copy.id) : null
    if (decision?.disposition === 'dismiss') {
      dismissed.push({ ...copy, reason: decision.reason })
    } else {
      upheld.push(copy)
    }
  }
  return {
    upheld,
    dismissed,
    classInvariant: typeof source?.class_invariant === 'string' ? source.class_invariant : null,
    closesClass: source?.closes_class === true,
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function findingLine(finding) {
  const value = object(finding) || {}
  const label = []
  const fields = []
  if (value.id != null) label.push(`**${String(value.id)}**`)
  if (value.severity != null) label.push(`(${String(value.severity)})`)
  if (label.length > 0) fields.push(label.join(' '))
  if (value.location != null) fields.push(String(value.location))
  if (value.summary != null) fields.push(String(value.summary))
  return `- ${fields.join(' — ')}`
}

export function regrantVerdict(taskReturn, ledgerRows = [], options = {}) {
  const details = object(taskReturn?.details)
  const escalation = object(details?.escalation)
  const where = escalation?.where
  const whereOk = where === 'review'
  const grant = details?.extra_rounds_granted
  const grantOk = Array.isArray(grant) && grant.length > 0
  const rows = (Array.isArray(ledgerRows) ? ledgerRows : [])
    .filter((row) => Number.isInteger(row?.must_fix))
  const counts = rows.map((row) => row.must_fix)
  let convergingOk = counts.length > 0 && counts.at(-1) <= 1
  for (let index = 1; convergingOk && index < counts.length; index += 1) {
    if (counts[index] > counts[index - 1]) convergingOk = false
  }
  const gateOk = details?.gate?.discrimination === 'proven'
  const budgetOk = options?.regranted !== true
  const reasons = [
    {
      condition: 'where-review',
      ok: whereOk,
      detail: whereOk ? 'escalated at review' : `escalated at ${where == null ? 'an unknown stage' : String(where)}, not review`,
    },
    {
      condition: 'grant-spent',
      ok: grantOk,
      detail: grantOk ? `${grant.length} extra round${grant.length === 1 ? '' : 's'} granted` : 'no extra rounds were granted',
    },
    {
      condition: 'must-fix-converging',
      ok: convergingOk,
      detail: counts.length === 0
        ? 'no review rounds recorded'
        : convergingOk
          ? `must-fix went ${counts.join(' → ')} across ${counts.length} review round${counts.length === 1 ? '' : 's'}`
          : counts.at(-1) > 1
            ? `must-fix ended at ${counts.at(-1)}, above 1`
            : `must-fix rose ${counts.join(' → ')}`,
    },
    {
      condition: 'gate-proven',
      ok: gateOk,
      detail: gateOk ? 'gate discrimination is proven' : 'gate discrimination is unproven',
    },
    {
      condition: 'regrant-budget',
      ok: budgetOk,
      detail: budgetOk ? 'regrant budget is unspent' : 'regrant budget was already spent',
    },
  ]
  return { eligible: reasons.every((reason) => reason.ok), reasons }
}

export function continuationBrief({ findings = [], guidance = '', branch = null, commit = null } = {}) {
  const list = Array.isArray(findings) && findings.length > 0
    ? findings.map(findingLine)
    : ['- (none recorded — read the last review.md in the task dir)']
  const lines = [
    '# Continuation round (regranted)',
    '',
    'This is a delta-briefed continuation of an escalated run, granted once and never again for this task.',
    '',
    '## Why this run exists',
    '',
    String(guidance ?? ''),
    '',
    '## Remaining findings — close every one',
    '',
    ...list,
    '',
    '## Where the work is',
    '',
    "The prior round's changes are UNCOMMITTED in the crew's checkout.",
    ...(branch == null ? [] : [`Branch: ${String(branch)}`]),
    ...(commit == null ? [] : [`Base commit: ${String(commit)}`]),
    '',
    '## Standing instruction — extend the acceptance gate',
    '',
    "The acceptance gate must grow a check for the NEW defect class so it is RED at baseline. A continuation whose gate already covers the fix trips crew/drive.mjs's gate-baseline:green-bounce.",
    '',
    '## Bounds',
    '',
    'Do not widen scope beyond the findings above; the plan of record stands; there is no second regrant.',
  ]
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

function questionObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function questionPlainObject(value) {
  if (!questionObject(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function freezeQuestionTree(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) freezeQuestionTree(value[key], seen)
  return Object.freeze(value)
}

function questionDescription(value) {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {}
  try { return String(value) } catch { return '<unprintable>' }
}

function jsonQuestionValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((entry) => {
      const copy = jsonQuestionValue(entry, seen)
      return copy === undefined ? null : copy
    })
    seen.delete(value)
    return result
  }
  if (!questionPlainObject(value)) {
    seen.delete(value)
    return undefined
  }
  const result = {}
  for (const key of Object.keys(value)) {
    let entry
    try { entry = value[key] } catch { continue }
    const copy = jsonQuestionValue(entry, seen)
    if (copy !== undefined) result[key] = copy
  }
  seen.delete(value)
  return result
}

function choiceQuestion(prompt, options, slots) {
  return { type: 'single-choice', prompt, options: [...options], slots: [...slots] }
}

function freeTextQuestion(prompt, reason) {
  return { type: 'free-text', prompt, reason }
}

const deliberateEscalationWhere = Object.freeze([
  'converge-pr', 'scope', 'gate', 'envelope', 'triage', 'triage-scope', 'plan', 'plan-carve',
  'plan-check', 'sensitivity-floor', 'anchor-absent', 'census-exhibits', 'scope-request', 'build',
  'lane', 'harden', 'review', 'refuted-must-fix', 'diff-mutation', 'review-unresolved', 'rebase',
  'suite', 'cold-suite', 'publish', 'scout', 'directed', 'plan-scope-malformed', 'plan-scope-widened',
])

const heterogeneousReason = (where) => `heterogeneous failures at ${where} do not map to an existing closed recovery verb.`
const heterogeneousQuestion = (where, prompt) => freeTextQuestion(prompt, heterogeneousReason(where))

const escalationQuestionCatalog = {
  'converge-pr': heterogeneousQuestion('converge-pr', 'What should happen next when draft PR creation cannot be completed?'),
  scope: choiceQuestion('How should this scope escalation be resolved?', ['widen-fence-to', 'split-lane', 'park'], ['files']),
  gate: heterogeneousQuestion('gate', 'What should happen next when the acceptance gate cannot be made green?'),
  envelope: heterogeneousQuestion('envelope', 'What should happen next when a seat envelope cannot be accepted?'),
  triage: heterogeneousQuestion('triage', 'What should happen next when repair-run triage cannot proceed?'),
  'triage-scope': heterogeneousQuestion('triage-scope', 'What should happen next when a repair-run scope request is invalid?'),
  plan: heterogeneousQuestion('plan', 'What should happen next when plan preparation cannot proceed?'),
  'plan-carve': heterogeneousQuestion('plan-carve', 'What should happen next when the plan cannot be carved into an executable shape?'),
  'plan-check': choiceQuestion('How should this plan-check escalation be resolved?', ['adopt-and-continue', 're-dispatch', 'park'], ['finding_ids']),
  'sensitivity-floor': heterogeneousQuestion('sensitivity-floor', 'What should happen next when the protected-path review floor cannot be met?'),
  'anchor-absent': heterogeneousQuestion('anchor-absent', 'What should happen next when a declared proof anchor cannot be found?'),
  'census-exhibits': heterogeneousQuestion('census-exhibits', 'What should happen next when census exhibits cannot be reconciled?'),
  'scope-request': heterogeneousQuestion('scope-request', 'What should happen next when a requested scope change is refused?'),
  build: heterogeneousQuestion('build', 'What should happen next when no build can be accepted?'),
  lane: heterogeneousQuestion('lane', 'What should happen next when the validation lane remains red?'),
  harden: heterogeneousQuestion('harden', 'What should happen next when hardening proof cannot be completed?'),
  review: heterogeneousQuestion('review', 'What should happen next when review cannot reach an accepted decision?'),
  'refuted-must-fix': heterogeneousQuestion('refuted-must-fix', 'What should happen next when a must-fix is explicitly refuted?'),
  'diff-mutation': heterogeneousQuestion('diff-mutation', 'What should happen next when a diff mutation is routed incorrectly?'),
  'review-unresolved': choiceQuestion('How should this unresolved review escalation be resolved?', ['adopt-and-continue', 're-dispatch', 'park'], ['finding_ids']),
  rebase: choiceQuestion('How should this rebase escalation be resolved?', ['resolve-and-continue', 'park'], ['files', 'base', 'commit']),
  suite: heterogeneousQuestion('suite', 'What should happen next when the full suite remains red?'),
  'cold-suite': heterogeneousQuestion('cold-suite', 'What should happen next when cold-suite verification cannot complete?'),
  publish: heterogeneousQuestion('publish', 'What should happen next when publishing cannot proceed?'),
  scout: heterogeneousQuestion('scout', 'What should happen next when the scout envelope cannot be accepted?'),
  directed: heterogeneousQuestion('directed', 'What should happen next when the directed brief cannot be executed?'),
  'plan-scope-malformed': heterogeneousQuestion('plan-scope-malformed', 'What should happen next when the plan declares malformed scope?'),
  'plan-scope-widened': heterogeneousQuestion('plan-scope-widened', 'What should happen next when the plan widens the dispatched scope?'),
}

export const ESCALATION_QUESTION_TYPES = Object.freeze(['single-choice', 'free-text'])
export const ESCALATION_WHERE = deliberateEscalationWhere
export const ESCALATION_QUESTIONS = freezeQuestionTree(escalationQuestionCatalog)

export function validateEscalationQuestions(catalog) {
  const defects = []
  if (!questionPlainObject(catalog)) return ['catalog: expected a plain object']
  let keys
  try { keys = Object.keys(catalog) } catch { return ['catalog: keys are unreadable'] }
  for (const where of ESCALATION_WHERE) {
    if (!Object.hasOwn(catalog, where)) defects.push(`${where}: missing declaration`)
  }
  for (const where of keys) {
    if (!ESCALATION_WHERE.includes(where)) defects.push(`${where}: unknown declaration`)
  }
  for (const where of ESCALATION_WHERE) {
    if (!Object.hasOwn(catalog, where)) continue
    let question
    try { question = catalog[where] } catch {
      defects.push(`${where}: declaration is unreadable`)
      continue
    }
    if (!questionPlainObject(question)) {
      defects.push(`${where}: declaration must be a plain object`)
      continue
    }
    if (!Object.isFrozen(question)) defects.push(`${where}: declaration is mutable`)
    if (typeof question.prompt !== 'string' || question.prompt.trim() === '') defects.push(`${where}: prompt must be a nonblank string`)
    if (question.type !== 'single-choice' && question.type !== 'free-text') defects.push(`${where}: unknown question type`)
    if (question.type === 'single-choice') {
      if (!Object.hasOwn(question, 'options') || !Array.isArray(question.options)) defects.push(`${where}: single-choice options must be an array`)
      else {
        if (!Object.isFrozen(question.options)) defects.push(`${where}: options are mutable`)
        if (question.options.length === 0) defects.push(`${where}: choice options are missing`)
        const options = question.options.filter((option) => typeof option === 'string' && option.trim() !== '')
        if (options.length !== question.options.length) defects.push(`${where}: choice options must be nonblank strings`)
        if (new Set(options).size !== options.length) defects.push(`${where}: choice options are duplicated`)
      }
      if (!Object.hasOwn(question, 'slots') || !Array.isArray(question.slots)) defects.push(`${where}: slots must be an array`)
      else {
        if (!Object.isFrozen(question.slots)) defects.push(`${where}: slots are mutable`)
        if (question.slots.some((slot) => typeof slot !== 'string' || slot.trim() === '')) defects.push(`${where}: slots must be nonblank strings`)
        if (new Set(question.slots).size !== question.slots.length) defects.push(`${where}: slots are duplicated`)
      }
    }
    if (question.type === 'free-text' && question.options !== undefined) defects.push(`${where}: free-text declares options`)
    if (question.type === 'free-text' && (typeof question.reason !== 'string' || question.reason.trim() === '')) defects.push(`${where}: free-text lacks a reason`)
    if (question.type === 'free-text' && question.slots !== undefined) defects.push(`${where}: free-text declares slots`)
  }
  return defects
}

const escalationQuestionDefects = validateEscalationQuestions(ESCALATION_QUESTIONS)
if (escalationQuestionDefects.length > 0) throw new Error(`invalid escalation question catalog: ${escalationQuestionDefects.join('; ')}`)

function materializeQuestionSlots(declaredSlots, slots) {
  const source = questionPlainObject(slots) ? slots : {}
  const result = {}
  for (const name of declaredSlots) {
    if (!Object.hasOwn(source, name)) continue
    let value
    try { value = source[name] } catch { continue }
    const copy = jsonQuestionValue(value)
    if (copy !== undefined) result[name] = copy
  }
  return result
}

export function escalationQuestion(where, slots = {}) {
  if (!Object.hasOwn(ESCALATION_QUESTIONS, where)) throw new Error(`undeclared escalation where ${questionDescription(where)}`)
  const declaration = ESCALATION_QUESTIONS[where]
  const result = {
    type: declaration.type,
    prompt: declaration.prompt,
    ...(declaration.type === 'single-choice' ? { options: [...declaration.options] } : { reason: declaration.reason }),
    slots: materializeQuestionSlots(declaration.slots || [], slots),
  }
  return freezeQuestionTree(result)
}

export const CRASH_ESCALATION_QUESTION = freezeQuestionTree({
  type: 'free-text',
  prompt: 'What should happen next after this driver crash?',
  reason: 'A crash stage is open-ended and does not map to the deliberate escalation catalog.',
})

export function crashEscalationQuestion(stage, slots = {}) {
  const stageValue = typeof stage === 'string' ? stage : questionDescription(stage)
  const source = questionPlainObject(slots) ? slots : {}
  const materializedSlots = { stage: stageValue }
  if (Object.hasOwn(source, 'return_path')) {
    let returnPath
    try { returnPath = source.return_path } catch { returnPath = undefined }
    const copy = jsonQuestionValue(returnPath)
    if (copy !== undefined) materializedSlots.return_path = copy
  }
  return freezeQuestionTree({
    type: CRASH_ESCALATION_QUESTION.type,
    prompt: CRASH_ESCALATION_QUESTION.prompt,
    reason: CRASH_ESCALATION_QUESTION.reason,
    slots: materializedSlots,
  })
}

export function resolutionDefect(where, answer) {
  let declared
  try { declared = Object.hasOwn(ESCALATION_QUESTIONS, where) } catch { return 'unknown escalation where' }
  if (!declared) return `unknown escalation where ${questionDescription(where)}`
  const declaration = ESCALATION_QUESTIONS[where]
  let prototype
  try { prototype = Object.getPrototypeOf(answer) } catch { return 'answer must be a plain object' }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || (prototype !== Object.prototype && prototype !== null)) {
    return 'answer must be a plain object'
  }
  let keys
  try { keys = Reflect.ownKeys(answer) } catch { return 'answer keys are unreadable' }
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('value') || keys.some((key) => typeof key !== 'string')) {
    return 'answer must contain exactly type and value'
  }
  let type
  let value
  try {
    type = answer.type
    value = answer.value
  } catch {
    return 'answer fields are unreadable'
  }
  if (type !== declaration.type) return `${where}: answer type does not match declaration`
  if (declaration.type === 'single-choice') {
    if (!declaration.options.includes(value)) return `${where}: answer choice is undeclared`
    return null
  }
  if (typeof value !== 'string' || value.trim() === '') return `${where}: free-text answer must be nonblank`
  return null
}
