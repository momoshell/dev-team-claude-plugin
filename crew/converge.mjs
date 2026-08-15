// crew/converge.mjs — pure renderers for the converged-with-residuals terminal.
// No imports, I/O, clock, or randomness: every export is a pure function of
// its arguments, so identical inputs produce byte-identical output.

export const GATE_OUTPUT_TAIL = 4000
export const SEVERITY_RANK = Object.freeze({ 'must-fix': 0, 'should-fix': 1, consider: 2 })
export const GATE_RESIDUAL_ID = 'gate-red'

export function gateSummaryLine(output) {
  let found = null
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('GATE-SUMMARY')) found = line
  }
  return found
}

function text(value) {
  return value === null || value === undefined ? '' : String(value)
}

function summaryLine(value) {
  return text(value).split(/\r?\n/)[0]
}

function sortResiduals(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (SEVERITY_RANK[a.entry.severity] - SEVERITY_RANK[b.entry.severity]) || (a.index - b.index))
    .map(({ entry }) => entry)
}

export function residualList({ findings, gateSummary } = {}) {
  const total = gateSummary && Number.isSafeInteger(gateSummary.total) ? gateSummary.total : null
  const failed = gateSummary && Number.isSafeInteger(gateSummary.failed) ? gateSummary.failed : null
  const gateResidual = {
    id: GATE_RESIDUAL_ID,
    severity: 'must-fix',
    location: null,
    summary: total !== null && failed !== null
      ? `the acceptance gate is red on ${failed} of ${total} checks`
      : 'the acceptance gate is red',
  }
  const reviewResiduals = []
  if (Array.isArray(findings)) {
    for (const entry of findings) {
      if (!entry || typeof entry !== 'object' || !Object.hasOwn(SEVERITY_RANK, entry.severity)) continue
      reviewResiduals.push({
        id: entry.id,
        severity: entry.severity,
        summary: entry.summary,
        location: entry.location ?? null,
        ...(entry.issue ? { issue: entry.issue } : {}),
      })
    }
  }
  return [gateResidual, ...sortResiduals(reviewResiduals)]
}

export function followUpIssueTitle({ task, residual } = {}) {
  const title = `residual(${text(task)}): ${text(residual?.id)} — ${summaryLine(residual?.summary)}`
  return title.length > 120 ? `${title.slice(0, 119)}…` : title
}

export function followUpIssueBody({ task, residual, gateSummary, escalation } = {}) {
  const line = gateSummary?.line ?? gateSummaryLine(gateSummary?.output)
  const where = text(escalation?.where)
  const why = text(escalation?.why)
  const location = residual?.location ?? '(none)'
  return [
    `# Residual follow-up for ${text(task)}`,
    '',
    '## What is unresolved',
    `- **id:** \`${text(residual?.id)}\``,
    `- **severity:** ${text(residual?.severity)}`,
    `- **location:** ${text(location)}`,
    `- **summary:** ${text(residual?.summary)}`,
    '',
    '## Gate summary (verbatim)',
    '```',
    line || '(the gate printed no GATE-SUMMARY line)',
    '```',
    '',
    '## Escalation reasoning (verbatim)',
    why,
    '',
    `(escalated at: ${where})`,
    '',
    'The work shipped as a DRAFT PR; this issue is its residual record.',
  ].join('\n') + '\n'
}

export function draftPrTitle({ task } = {}) {
  return `crew(${text(task)}): converged with residuals — DRAFT, not mergeable`
}

export function draftPrBody({ gateSummary, findings, escalation, roundHistory } = {}) {
  const supplied = Array.isArray(findings) ? findings.filter((entry) => entry && typeof entry === 'object') : []
  const residuals = sortResiduals(supplied.length ? supplied : residualList({ gateSummary }))
  const line = gateSummary?.line ?? gateSummaryLine(gateSummary?.output)
  const output = text(gateSummary?.output)
  const tail = output.slice(-GATE_OUTPUT_TAIL)
  const why = text(escalation?.why)
  const where = text(escalation?.where)
  const history = Array.isArray(roundHistory) ? roundHistory : []
  const bullets = residuals.map((entry) => {
    let bullet = `- **${text(entry.severity)}** \`${text(entry.id)}\` — ${text(entry.summary)}`
    if (entry.location) bullet += ` (at ${text(entry.location)})`
    if (entry.issue && Number.isInteger(entry.issue.number)) bullet += ` (follow-up: #${entry.issue.number})`
    return bullet
  })
  const historyLines = history.map((entry, index) => `${index + 1}. ${text(entry)}`)
  return [
    'This is a DRAFT PR: the work is committed, the full suite is green, and the acceptance gate is red. Merge authority is human; nothing here marks this PR ready.',
    '',
    '## Residuals (unresolved — read these first)',
    ...bullets,
    '',
    '## Gate summary (verbatim)',
    '```',
    line || '(the gate printed no GATE-SUMMARY line)',
    '```',
    '',
    `## Gate output (last ${GATE_OUTPUT_TAIL} chars, verbatim)`,
    '```',
    tail,
    '```',
    '',
    '## Why this settled here',
    why,
    '',
    `(escalated at: ${where})`,
    '',
    '## Round history',
    ...(historyLines.length ? historyLines : ['(no rounds recorded)']),
  ].join('\n') + '\n'
}
