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
