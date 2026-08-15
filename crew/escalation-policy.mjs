export const REGRANT_CONDITIONS = Object.freeze([
  'where-review',
  'grant-spent',
  'must-fix-converging',
  'gate-proven',
  'regrant-budget',
])

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
