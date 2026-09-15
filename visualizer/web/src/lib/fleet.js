import { TASK_PROFILES } from '../../../../crew/task-profiles.mjs'
import { assuranceMeta, executionMeta, taskProfileMeta } from './workflow-semantics.js'

export const SILENT_AFTER_MS = 30_000
const TOKEN_FIELDS = ['billed_input_tokens', 'billed_output_tokens', 'billed_cache_write_tokens', 'billed_cache_read_tokens']
export const DEFAULT_FILTERS = Object.freeze({ hide_slugless: true, hide_archived: true })

export function createSemaphore(limit = 1) {
  const maximum = Number.isInteger(limit) && limit > 0 ? limit : 1
  let active = 0
  const waiters = []
  function acquire() {
    if (active < maximum) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  function release() {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
  return {
    async run(task) {
      await acquire()
      try { return await task() } finally { release() }
    },
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textNumber(value) {
  return value.toLocaleString('en-US')
}

function measuredCell(value, text = String(value)) {
  return { value, text, dashed: false, title: null }
}

function envelopeFor(envelopes, adwId) {
  if (envelopes instanceof Map) return envelopes.get(adwId) || null
  if (envelopes && typeof envelopes === 'object') return envelopes[adwId] || null
  return null
}

export function absenceMark(reason) {
  return { value: null, text: reason || 'not measured', dashed: true, title: reason || null }
}

const CONFIGURATION_DIMENSIONS = Object.freeze([
  { key: 'task_profile', label: 'Profile', meta: taskProfileMeta },
  { key: 'execution_shape', label: 'Execution', meta: executionMeta },
  { key: 'assurance', label: 'Assurance', meta: assuranceMeta },
])

function recordedConfigurationValue(run = {}, dimension) {
  const value = run?.[dimension]
  return typeof value === 'string' && value.trim() ? value : null
}

function configurationDimensionDescriptor(source, descriptor) {
  const values = [...new Set(source.map((run) => recordedConfigurationValue(run, descriptor.key)).filter((value) => value !== null))].sort()
  if (values.length === 0) return []
  return [{ key: descriptor.key, label: descriptor.label, options: values.map((value) => ({ value, label: descriptor.meta(value).label })) }]
}

export function configurationDimensionCell(run = {}, dimension) {
  const descriptor = CONFIGURATION_DIMENSIONS.find((candidate) => candidate.key === dimension)
  const value = descriptor ? recordedConfigurationValue(run, descriptor.key) : null
  if (value === null) return absenceMark('Not recorded')
  const meta = descriptor.meta(value)
  return { ...measuredCell(value, meta.label), key: value, summary: meta.summary ?? null }
}

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const RUN_DETAIL_CONFIGURATION_AXES = Object.freeze([
  { key: 'task_profile', label: 'Task profile' },
  { key: 'execution', label: 'Execution shape' },
  { key: 'assurance', label: 'Assurance' },
])

export function runDetailConfiguration(run = {}) {
  return RUN_DETAIL_CONFIGURATION_AXES.map((descriptor) => {
    const axis = run?.configuration?.[descriptor.key]
    const requested = textValue(axis?.requested)
    const effective = textValue(axis?.effective)
    const source = textValue(axis?.source)
    return {
      ...descriptor,
      requested: textValue(axis?.requested),
      effective: textValue(axis?.effective),
      source: textValue(axis?.source),
      requested_text: requested ?? 'Not recorded',
      effective_text: effective ?? 'Not recorded',
      source_text: source ?? 'Not recorded',
      changed: requested !== null && effective !== null && source !== null ? requested !== effective : null,
    }
  })
}

function normaliseWarnings(value) {
  if (!Array.isArray(value)) return null
  return value.map((entry) => String(entry))
}

export function runDetailSeats(run = {}) {
  if (!Array.isArray(run?.seats)) return { state: 'not-recorded', rows: [], summary: 'Not recorded' }
  if (run.seats.length === 0) return { state: 'measured-empty', rows: [], summary: 'No seat overrides or policy warnings recorded' }
  const rows = run.seats.map((seat) => ({
    role: textValue(seat?.role),
    source: textValue(seat?.source),
    policy_state: textValue(seat?.policy_state),
    warnings: normaliseWarnings(seat?.warnings),
  }))
  return { state: 'measured', rows, summary: `${rows.length} seat${rows.length === 1 ? '' : 's'} recorded` }
}

const DEFAULT_PROFILE_EVIDENCE = Object.freeze([
  'structured_findings', 'checks_run', 'reproduction_or_cited_failure', 'mutation_or_negative_control',
])

const EVIDENCE_LABELS = Object.freeze({
  base_head_identity: 'Base/head identity',
  captured_evidence: 'Captured evidence',
  changed_tests: 'Changed tests',
  check_result: 'Check result',
  checks_run: 'Verification checks',
  citations: 'Citations',
  cited_findings: 'Cited findings',
  environment: 'Environment',
  explicit_unknowns: 'Explicit unknowns',
  fix_validation: 'Fix validation',
  mutation_or_negative_control: 'Test discrimination',
  regression_evidence: 'Regression evidence',
  reproduction_or_cited_failure: 'Bug reproduction',
  review: 'Review findings',
  scoped_diff: 'Scoped diff',
  severity: 'Finding severity',
  structured_findings: 'Review findings',
  suite_result: 'Suite result',
  terminal_result: 'Terminal result',
  validation: 'Validation',
  zero_source_writes: 'Zero source writes',
})

const EVIDENCE_MEANINGS = Object.freeze({
  base_head_identity: 'Pins the exact base and head that were measured',
  captured_evidence: 'Preserves the observed output behind each verification check',
  changed_tests: 'Shows which tests materially changed for the intended behavior',
  check_result: 'Records the independently measured pass, fail, blocked, or not-run result',
  checks_run: 'Shows each declared verification target that was actually checked',
  citations: 'Connects findings to their recorded source locations or evidence',
  cited_findings: 'Carries the bounded answer and the sources that support it',
  environment: 'Records the environment assumptions under which the result was measured',
  explicit_unknowns: 'Keeps unresolved questions visible instead of treating them as settled',
  fix_validation: 'Shows the validation measured after the proposed fix',
  mutation_or_negative_control: 'Shows that the tests discriminate the intended behavior',
  regression_evidence: 'Shows the recorded evidence that unrelated behavior remained intact',
  reproduction_or_cited_failure: 'Pins the initial failure or cited defect being addressed',
  review: 'Records the review evidence relevant to the requested change',
  scoped_diff: 'Identifies the measured files or change set within scope',
  severity: 'Makes the impact level of each structured finding explicit',
  structured_findings: 'Carries actionable findings with their recorded evidence and disposition',
  suite_result: 'Records the relevant suite or validation result',
  terminal_result: 'Shows the recorded terminal outcome rather than inferring one',
  validation: 'Shows the validation command or result that was actually recorded',
  zero_source_writes: 'Preserves the measured proof that the workflow did not write source files',
})

function profileEvidenceEntries(returns = {}) {
  const source = Array.isArray(returns) ? returns : Array.isArray(returns?.envelopes) ? returns.envelopes : []
  return source.filter((entry) => entry && typeof entry === 'object').map((entry) => ({
    entry,
    details: entry.details && typeof entry.details === 'object' && !Array.isArray(entry.details) ? entry.details : {},
  }))
}

function recordedEvidenceValue(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0)
}

function evidenceReference(entry, field, value) {
  return {
    assignment_id: entry.assignment_id ?? null,
    dispatch_seq: entry.dispatch_seq ?? null,
    role: entry.role ?? null,
    field,
    value,
  }
}

function evidenceFields(entries, fields) {
  const references = []
  let present = false
  for (const { entry, details } of entries) {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(details, field)) continue
      const value = details[field]
      if (!recordedEvidenceValue(value)) continue
      present = true
      if (Array.isArray(value)) {
        for (const item of value) references.push(evidenceReference(entry, field, item))
      } else references.push(evidenceReference(entry, field, value))
    }
  }
  return { present, references }
}

function combineEvidence(...payloads) {
  return {
    present: payloads.some((payload) => payload.present),
    references: payloads.flatMap((payload) => payload.references),
  }
}

function findingEvidenceFields(entries, fields) {
  const references = []
  let present = false
  for (const { entry, details } of entries) {
    const findings = details.findings
    if (!Array.isArray(findings)) continue
    for (const finding of findings) {
      if (!finding || typeof finding !== 'object') continue
      for (const field of fields) {
        const value = finding[field]
        if (!recordedEvidenceValue(value)) continue
        present = true
        if (Array.isArray(value)) {
          for (const item of value) references.push(evidenceReference(entry, `findings.${field}`, item))
        } else references.push(evidenceReference(entry, `findings.${field}`, value))
      }
    }
  }
  return { present, references }
}

function terminalEvidence(returns, entries) {
  const references = []
  let present = false
  for (const { entry } of entries) {
    if (!recordedEvidenceValue(entry.status)) continue
    present = true
    references.push(evidenceReference(entry, 'status', entry.status))
  }
  if (recordedEvidenceValue(returns?.task?.status)) {
    present = true
    references.push({ assignment_id: null, dispatch_seq: null, role: 'task', field: 'status', value: returns.task.status })
  }
  return { present, references }
}

function payloadForEvidence(key, entries, returns) {
  switch (key) {
    case 'base_head_identity': return evidenceFields(entries, ['base', 'head', 'base_head_identity'])
    case 'captured_evidence': return evidenceFields(entries, ['captured_evidence', 'evidence'])
    case 'changed_tests': return evidenceFields(entries, ['changed_tests', 'tests_changed', 'test_files', 'files_changed'])
    case 'check_result': return evidenceFields(entries, ['check_result', 'product_verdict', 'check_matrix'])
    case 'checks_run': return evidenceFields(entries, ['checks_run', 'check_matrix'])
    case 'citations': return combineEvidence(evidenceFields(entries, ['citations']), findingEvidenceFields(entries, ['citations', 'evidence', 'location']))
    case 'cited_findings': return evidenceFields(entries, ['cited_findings', 'findings', 'citations'])
    case 'environment': return evidenceFields(entries, ['environment', 'environment_assumptions'])
    case 'explicit_unknowns': return evidenceFields(entries, ['explicit_unknowns', 'unknowns'])
    case 'fix_validation': return evidenceFields(entries, ['fix_validation', 'validation', 'validation_lane'])
    case 'mutation_or_negative_control': return evidenceFields(entries, ['mutations', 'mutation_or_negative_control', 'mutation', 'negative_control'])
    case 'regression_evidence': return evidenceFields(entries, ['regression_evidence', 'suite_result', 'validation'])
    case 'reproduction_or_cited_failure': return evidenceFields(entries, ['reproduction', 'reproduction_or_cited_failure', 'cited_failure'])
    case 'review': return evidenceFields(entries, ['findings', 'review', 'verdict'])
    case 'scoped_diff': return evidenceFields(entries, ['scoped_diff', 'files_changed', 'files_in_scope'])
    case 'severity': return combineEvidence(evidenceFields(entries, ['severity']), findingEvidenceFields(entries, ['severity']))
    case 'structured_findings': return evidenceFields(entries, ['findings', 'structured_findings'])
    case 'suite_result': return evidenceFields(entries, ['suite_result', 'suite', 'validation', 'validation_lane'])
    case 'terminal_result': return terminalEvidence(returns, entries)
    case 'validation': return evidenceFields(entries, ['validation', 'validation_lane'])
    case 'zero_source_writes': return evidenceFields(entries, ['zero_source_writes', 'zero_write_proof', 'files_written'])
    default: return evidenceFields(entries, [key])
  }
}

function compactEvidenceValue(value) {
  if (typeof value === 'string') return value.trim().replaceAll(/\\s+/g, ' ').slice(0, 120)
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const encoded = JSON.stringify(value)
    return encoded.length > 120 ? `${encoded.slice(0, 117)}…` : encoded
  } catch { return 'recorded value' }
}

function checkStatusCounts(references) {
  const counts = new Map()
  for (const reference of references) {
    const value = reference.value
    const status = value && typeof value === 'object' ? (value.status ?? value.result ?? value.verdict) : null
    if (typeof status !== 'string' || !status.trim()) continue
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(' · ')
}

function evidenceSummary(key, payload) {
  if (!payload.present) return 'Not recorded'
  const references = payload.references
  const count = references.length
  if (key === 'base_head_identity') {
    const values = references.map((reference) => `${reference.field} ${compactEvidenceValue(reference.value)}`).filter(Boolean)
    return values.length ? values.join(' · ') : 'Identity fields recorded without displayable values'
  }
  if (key === 'structured_findings' || key === 'review' || key === 'cited_findings') return `${count} finding${count === 1 ? '' : 's'} recorded`
  if (key === 'checks_run') return count ? `${count} verification check${count === 1 ? '' : 's'} recorded${checkStatusCounts(references) ? ` · ${checkStatusCounts(references)}` : ''}` : '0 verification checks recorded'
  if (key === 'check_result') return checkStatusCounts(references) || (count ? `${count} check result${count === 1 ? '' : 's'} recorded` : 'Check result recorded without a count')
  if (key === 'captured_evidence') return count ? `${count} captured evidence item${count === 1 ? '' : 's'} recorded` : '0 captured evidence items recorded'
  if (key === 'environment') return count ? `${count} environment record${count === 1 ? '' : 's'} recorded` : '0 environment records recorded'
  if (key === 'mutation_or_negative_control') return count ? `${count} mutation or negative-control record${count === 1 ? '' : 's'} recorded` : '0 mutation or negative-control records recorded'
  if (key === 'changed_tests') return count ? `${count} changed-test record${count === 1 ? '' : 's'} recorded` : '0 changed-test records recorded'
  if (key === 'reproduction_or_cited_failure') return references.map((reference) => compactEvidenceValue(reference.value)).filter(Boolean).join(' · ') || 'Reproduction was recorded without displayable text'
  if (key === 'validation' || key === 'fix_validation' || key === 'regression_evidence' || key === 'suite_result') {
    const values = references.map((reference) => compactEvidenceValue(reference.value)).filter(Boolean)
    return values.length ? values.join(' · ') : 'Validation was recorded without displayable text'
  }
  if (key === 'terminal_result') return references.map((reference) => compactEvidenceValue(reference.value)).filter(Boolean).join(' · ') || 'Terminal result recorded'
  if (key === 'zero_source_writes') return references.map((reference) => compactEvidenceValue(reference.value)).filter(Boolean).join(' · ') || 'Zero-write evidence recorded'
  if (key === 'severity') {
    const severities = references.map((reference) => reference.value?.severity).filter((value) => typeof value === 'string' && value.trim())
    return severities.length ? [...new Set(severities)].map((severity) => `${severities.filter((value) => value === severity).length} ${severity}`).join(' · ') : `${count} severity record${count === 1 ? '' : 's'} recorded`
  }
  if (key === 'citations') return count ? `${count} citation${count === 1 ? '' : 's'} recorded` : '0 citations recorded'
  if (key === 'explicit_unknowns') return count ? `${count} explicit unknown${count === 1 ? '' : 's'} recorded` : '0 explicit unknowns recorded'
  return count ? `${count} record${count === 1 ? '' : 's'} recorded` : 'Recorded evidence is empty'
}

function profileEvidenceReason(profile, key) {
  const meaning = EVIDENCE_MEANINGS[key] || `${String(key).replaceAll('_', ' ')} evidence`
  const outcome = profile?.outcome || 'the recorded envelope evidence'
  return `${meaning}; this supports ${outcome.charAt(0).toLowerCase()}${outcome.slice(1)}.`
}

export function profileEvidenceView(profileKey, returns = {}) {
  const profile = TASK_PROFILES[profileKey] ?? null
  const required = profile ? [...profile.evidence] : []
  const keys = profile ? required : [...DEFAULT_PROFILE_EVIDENCE]
  const entries = profileEvidenceEntries(returns)
  const blocks = keys.map((key) => {
    const payload = payloadForEvidence(key, entries, returns)
    return {
      key,
      label: EVIDENCE_LABELS[key] || String(key).replaceAll('_', ' '),
      reason: profileEvidenceReason(profile, key),
      summary: evidenceSummary(key, payload),
      measured: payload.present,
      references: payload.references,
    }
  })
  return {
    profile: { key: profile?.name ? profileKey : null, label: profile?.name || 'Not recorded' },
    profile_specific: Boolean(profile),
    blocks,
  }
}

export function configurationFilterView(runs = [], selections = {}) {
  const source = Array.isArray(runs) ? runs : []
  const dimensions = CONFIGURATION_DIMENSIONS.flatMap((descriptor) => configurationDimensionDescriptor(source, descriptor))
  const rows = source.filter((run) => CONFIGURATION_DIMENSIONS.every((descriptor) => {
    const selection = selections?.[descriptor.key]
    if (!selection || selection === 'all') return true
    const value = recordedConfigurationValue(run, descriptor.key)
    if (value === null) return true
    return value === selection
  }))
  const count = source.length - rows.length
  const excluded = {
    count,
    line: count === 0 ? '' : `${count} measured row${count === 1 ? '' : 's'} excluded by configuration filters · not-recorded rows remain visible`,
  }
  return { dimensions, rows, excluded }
}

const OPERATIONS_DIMENSIONS = Object.freeze([
  { key: 'task_profile', label: 'Profile', field: 'task_profile', configuration: 'task_profile' },
  { key: 'execution_shape', label: 'Execution', field: 'execution_shape', configuration: 'execution' },
  { key: 'assurance', label: 'Assurance', field: 'assurance', configuration: 'assurance' },
])
const OPERATIONS_OUTCOMES = Object.freeze(['success', 'escalated', 'aborted', 'failed'])
const OPERATIONS_SEAT_SOURCES = Object.freeze(['roster', 'profile_recommendation', 'operator_override', 'reseat'])
const DRIVER_STATES = Object.freeze(['alive', 'gone', 'unknown'])
const OPERATIONS_CAUSE_ABSENT = 'cause not recorded'

function addCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function operationsOutcome(run = {}) {
  const settlement = run?.settlement
  if (settlement?.state === 'unsettled') return 'unsettled'
  const outcome = settlement?.outcome
  return settlement?.state === 'settled' && OPERATIONS_OUTCOMES.includes(outcome) ? outcome : 'unknown'
}

function operationsDimensionLabel(key, value) {
  if (key === 'task_profile') return taskProfileMeta(value).label
  if (key === 'execution_shape') return executionMeta(value).label
  if (key === 'assurance') return assuranceMeta(value).label
  return value
}

export function operationsOverview(runs = []) {
  const source = Array.isArray(runs) ? runs : []
  const dimensions = []

  for (const descriptor of OPERATIONS_DIMENSIONS) {
    const measured = []
    for (const run of source) {
      let effective = recordedConfigurationValue(run, descriptor.field)
      if (effective === null) continue
      measured.push({ run, effective })
    }
    if (measured.length === 0) continue

    const groups = new Map()
    for (const row of measured) {
      const group = groups.get(row.effective) ?? []
      group.push(row.run)
      groups.set(row.effective, group)
    }
    const rows = [...groups.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([value, group]) => {
        const measured = group
        const outcomes = { success: 0, escalated: 0, aborted: 0, failed: 0, unsettled: 0, unknown: 0 }
        for (const run of measured) outcomes[operationsOutcome(run)] += 1
        return {
          value,
          label: operationsDimensionLabel(descriptor.key, value),
          denominator: measured.length,
          outcomes,
        }
      })
    dimensions.push({ key: descriptor.key, label: descriptor.label, rows })
  }

  const escalationCauses = new Map()
  let failureCount = 0
  const unsettled = { denominator: 0, alive: 0, gone: 0, unknown: 0 }
  for (const run of source) {
    const outcome = operationsOutcome(run)
    const rawReason = run?.settlement?.reason
    const reason = rawReason == null || (typeof rawReason === 'string' && rawReason.trim() === '')
      ? OPERATIONS_CAUSE_ABSENT
      : rawReason
    if (outcome === 'escalated') addCount(escalationCauses, reason)
    if (outcome === 'failed') failureCount += 1
    if (run?.settlement?.state !== 'unsettled') continue
    unsettled.denominator += 1
    const state = run?.runtime?.driver_state === 'unknown' ? 'unknown' : DRIVER_STATES.includes(run?.runtime?.driver_state) ? run.runtime.driver_state : 'unknown'
    unsettled[state] += 1
  }

  const denominator = source.length
  const escalations = [...escalationCauses.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([cause, count]) => ({ cause, count, denominator }))

  const configurationChanges = []
  for (const run of source) {
    for (const descriptor of OPERATIONS_DIMENSIONS) {
      const axis = run?.configuration?.[descriptor.configuration]
      if (!axis || typeof axis !== 'object') continue
      const requested = recordedConfigurationValue(axis, 'requested')
      const effective = recordedConfigurationValue(axis, 'effective')
      if (requested === null || effective === null || requested === effective) continue
      configurationChanges.push({
        adw_id: run?.adw_id ?? null,
        dimension: descriptor.configuration,
        // RV1-3: the card renders `label`, not `dimension`. `dimension` is the raw
        // ledger field and is kept as the record's identity — but `execution` there
        // never matches the `Execution` heading its throughput sibling prints, so an
        // operator reading the two cards side by side sees one axis named two ways.
        label: descriptor.label,
        requested,
        effective,
        source: axis.source ?? null,
      })
    }
  }

  const seatEvidence = []
  for (const run of source) {
    if (!Array.isArray(run?.seats)) continue
    for (const seat of run.seats) {
      if (!seat || typeof seat !== 'object' || !OPERATIONS_SEAT_SOURCES.includes(seat.source)) continue
      seatEvidence.push({
        adw_id: run?.adw_id ?? null,
        role: seat.role ?? null,
        source: seat.source,
        policy_state: seat.policy_state ?? null,
        warnings: seat.warnings ?? null,
      })
    }
  }

  return {
    dimensions,
    escalations,
    failures: { count: failureCount, denominator },
    configurationChanges,
    seatEvidence,
    unsettled,
  }
}

export function deriveStatus(run = {}, taskEnvelope = null) {
  const escalation = taskEnvelope?.details?.escalation
  const typed = {
    escalated: { key: 'escalated', word: 'escalated', tone: 'serious', where: escalation?.where ?? null, why: escalation?.why ?? null },
    aborted: { key: 'aborted', word: 'aborted', tone: 'aborted', where: null, why: null },
    success: { key: 'success', word: 'success', tone: 'ok', where: null, why: null },
    failed: { key: 'fail', word: 'failed', tone: 'fail', where: null, why: null },
  }[run?.settlement?.outcome]
  if (typed) return typed
  if (taskEnvelope?.status === 'escalation') {
    return { key: 'escalated', word: 'escalated', tone: 'serious', where: escalation?.where, why: escalation?.why }
  }
  if (run?.status === 'ok') return { key: 'success', word: 'success', tone: 'ok', where: null, why: null }
  if (run?.status === 'fail') return { key: 'fail', word: 'failed', tone: 'fail', where: null, why: null }
  if (run?.status === 'aborted') return { key: 'aborted', word: 'aborted', tone: 'aborted', where: null, why: null }
  if (run?.running && !run?.phases?.length) return { key: 'queued', word: 'queued', tone: 'quiet', where: null, why: null }
  if (run?.running) return { key: 'running', word: 'running', tone: 'busy', where: null, why: null }
  return { key: 'unknown', word: 'status not recorded', tone: 'quiet', where: null, why: null }
}

const SHIP_STATUS_META = Object.freeze({
  merged: Object.freeze({ key:'merged', word:'shipped', tone:'ok' }),
  open: Object.freeze({ key:'open', word:'open', tone:'busy' }),
  'closed-unmerged': Object.freeze({ key:'closed-unmerged', word:'closed', tone:'fail' }),
  unpublished: Object.freeze({ key:'unpublished', word:'unpublished', tone:'quiet' }),
  'not-applicable': Object.freeze({ key:'not-applicable', word:'not applicable', tone:'quiet' }),
  unmeasured: Object.freeze({ key:'unmeasured', word:'not measured', tone:'quiet' }),
})

export function shipStatus(run = {}) {
  const ship = run?.ship
  const meta = SHIP_STATUS_META[ship?.state]
  const reason = typeof ship?.reason === 'string' && ship.reason.trim() ? ship.reason : null
  if (!meta || reason === null) return { key:'unmeasured', word:'not measured', tone:'quiet', reason:'ship state not measured' }
  return { ...meta, reason: ship.stale === true ? `${reason} (cached ship state is stale.)` : reason }
}

export function driverObservation(run = {}) {
  const runtime = run?.runtime && typeof run.runtime === 'object' ? run.runtime : {}
  const state = ['alive', 'gone', 'unknown'].includes(runtime.driver_state) ? runtime.driver_state : 'unknown'
  const source = typeof runtime.source === 'string' && runtime.source.trim() ? runtime.source : null
  const reason_code = typeof runtime.reason_code === 'string' && runtime.reason_code.trim() ? runtime.reason_code : null
  return {
    state,
    source,
    reason_code,
    observed_at: runtime.observed_at ?? null,
    measured: source !== null,
    text: source === null ? 'not observed' : `${state} · ${source}`,
  }
}

export function runDetailState(run = {}, events = []) {
  const missing = 'Not recorded'
  const settlement = run?.settlement && typeof run.settlement === 'object' ? run.settlement : {}
  const settlementState = textValue(settlement.state)
  const settlementOutcome = textValue(settlement.outcome)
  const settlementReason = textValue(settlement.reason)
  const settlementText = [settlementState, settlementOutcome, settlementReason].filter((value) => value !== null).join(' · ') || missing
  const observation = driverObservation(run)
  const runtime = run?.runtime && typeof run.runtime === 'object' ? run.runtime : {}
  const heartbeatState = textValue(runtime.heartbeat_state)
  const phases = Array.isArray(run?.phases) ? run.phases : []
  const eventRows = Array.isArray(events) ? events : []
  const latestPhase = phases.at(-1)
  const latestEvent = eventRows.at(-1)
  const reconciliation = textValue(run?.reconciliation_command)
  return {
    settlement: {
      state: settlementState,
      outcome: settlementOutcome,
      reason: settlementReason,
      text: settlementText,
    },
    driver: {
      ...observation,
      text: observation.measured ? observation.text : missing,
    },
    heartbeat: {
      state: heartbeatState,
      text: heartbeatState ?? missing,
      caveat: 'Heartbeat freshness does not establish driver liveness.',
    },
    latest: {
      phase: textValue(latestPhase?.name) ?? missing,
      event: textValue(latestEvent?.type) ?? missing,
    },
    remediation: {
      command: reconciliation,
      text: reconciliation ?? missing,
    },
  }
}

function conciseAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

// #953 — whether this run's crew state directory is archived is MEASURED BY THE SERVER and
// only REPORTED here. Three values and never two: true, false, or null with a stated reason.
// An unmeasured crew state is never read as "not archived".
export function crewArchive(run = {}) {
  const state = run?.crew_state && typeof run.crew_state === 'object' ? run.crew_state : null
  const archived = state && typeof state.archived === 'boolean' ? state.archived : null
  return {
    archived,
    archived_at: state?.archived_at ?? null,
    // TL8 — when the archive is measured but its instant is not, the reason travels with it.
    archived_at_absent: state?.archived_at_absent ?? null,
    absent: archived === null ? absenceMark(run?.pending?.crew_state) : null,
  }
}

// #953 · TL7 — ONE list of the status keys that mean an operator must look at this run. It
// was hard-coded in App.svelte:52 and TaskList.svelte:25,:57, which is exactly how a key
// minted in this module reaches neither. Those two consumers ask this predicate; the
// fleetView rail selects the key directly and is not a caller.
export const ATTENTION_KEYS = Object.freeze(['escalated', 'fail', 'aborted', 'silent', 'unverified', 'gone', 'contradicted'])
export function needsAttention(statusKey) { return ATTENTION_KEYS.includes(statusKey) }

const ATTENTION_SEGMENT_LABELS = Object.freeze({
  escalated: 'escalated',
  fail: 'failed',
  aborted: 'aborted',
  silent: 'stale',
  unverified: 'unverified',
  gone: 'gone',
  contradicted: 'contradicted',
})

export function attentionBreakdown(rows = []) {
  const counts = new Map()
  let total = 0
  let unattributed = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.status?.key
    if (!needsAttention(key)) continue
    total += 1
    const label = ATTENTION_SEGMENT_LABELS[key]
    if (!label) { unattributed += 1; continue }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const segments = ATTENTION_KEYS.filter((key) => ATTENTION_SEGMENT_LABELS[key]).map((key) => ({ key, label: ATTENTION_SEGMENT_LABELS[key], count: counts.get(key) ?? 0 }))
  const parts = segments.filter((segment) => segment.count > 0).map((segment) => `${segment.count} ${segment.label}`)
  if (unattributed > 0) parts.push(`${unattributed} unattributed`)
  return { total, segments, unattributed, text: parts.join(' · ') }
}

export function runActivityResult(key, values) {
  return { key, ...values, attention: needsAttention(key) }
}

export function runActivity(run = {}, now = Date.now()) {
  const driver = driverObservation(run)
  if (!run?.running) return runActivityResult('settled', { live: false, heartbeat: heartbeatCell(run, now), driver })
  const heartbeat = heartbeatCell(run, now)
  // #953 — the ledger and the crew state dir disagree. Report the disagreement; do not pick
  // a side. This sits AFTER the settled return, so settlement is read from the ledger and
  // never from the crew dir, and it answers only on a MEASURED archived === true.
  const archive = crewArchive(run)
  if (archive.archived === true) {
    const ledgerSide = run?.started_at ? `started ${run.started_at}` : 'started at a time the ledger did not record'
    const archiveSide = archive.archived_at ? `archived ${archive.archived_at}` : `archived at a time this feed could not measure (${archive.archived_at_absent || 'no reason was recorded for the absence'})`
    return runActivityResult('contradicted', {
      live: false, heartbeat, driver,
      word: 'contradicted · ledger running, crew state archived', tone: 'serious',
      why: `The ledger row still says running (${ledgerSide}), but this lane's crew state directory is archived (${archiveSide}). The two sides disagree; neither is guessed away. This run is not live, not merely stale, and not settled.`,
    })
  }
  // New shaped rows always carry runtime. Their activity comes only from the
  // cited observation; heartbeat age stays a separate freshness display.
  if (run?.runtime && typeof run.runtime === 'object') {
    if (!driver.measured) return runActivityResult('unverified', { live: false, heartbeat, driver, word: 'unsettled · runtime unconfirmed', tone: 'serious', why: 'The ledger remains unsettled, but no authoritative driver observation was recorded.' })
    if (driver.state === 'gone') return runActivityResult('gone', { live: false, heartbeat, driver, word: `driver gone · ${driver.source}`, tone: 'serious', why: `The latest ${driver.source} observation recorded the driver as gone.` })
    if (driver.state === 'alive') return runActivityResult('live', { live: true, heartbeat, driver, word: `live · ${driver.source}`, tone: 'busy', why: null })
    return runActivityResult('unverified', { live: false, heartbeat, driver, word: `runtime unknown · ${driver.source}`, tone: 'serious', why: `The latest ${driver.source} observation could not determine driver state.` })
  }
  // Historical pre-runtime objects retain the legacy heartbeat-only activity
  // readout. They are never produced by shapeRun after observations shipped.
  if (heartbeat.dashed) return runActivityResult('unverified', { live: false, heartbeat, driver, word: 'running · heartbeat unavailable', tone: 'serious', why: 'The ledger says this session is running, but this feed does not provide a heartbeat, so live activity cannot be verified.' })
  if (heartbeat.stale) {
    const quietFor = conciseAge(heartbeat.age_ms)
    return runActivityResult('silent', { live: false, heartbeat, driver, word: `stale · heartbeat ${quietFor} ago`, tone: 'serious', why: `The session still says running, but its last heartbeat was ${quietFor} ago.` })
  }
  return runActivityResult('live', { live: true, heartbeat, driver, word: 'live', tone: 'busy', why: null })
}

// #953 · TL7 — the heading an operator reads for an open record that is not live, keyed by
// the SAME status key. A contradicted lane is NOT stale: its evidence is the crew state
// directory and its heartbeat may be four seconds old, so calling it stale states a
// measurement nobody made.
const OPEN_RECORD_NOTES = Object.freeze({
  silent: 'Stale open record',
  unverified: 'Open record not verified',
  contradicted: 'Ledger running · crew state archived',
  gone: 'Driver observed gone',
})
export function openRecordNote(statusKey) { return OPEN_RECORD_NOTES[statusKey] ?? null }

export function runtimeActivity(runs = []) {
  const activity = { unsettled: 0, observed: 0, gone: 0, unmeasured: 0 }
  for (const run of Array.isArray(runs) ? runs : []) {
    const unsettled = run?.settlement?.state ? run.settlement.state === 'unsettled' : run?.running === true
    if (!unsettled) continue
    activity.unsettled += 1
    const observation = driverObservation(run)
    if (observation.measured) {
      activity.observed += 1
      if (observation.state === 'gone') activity.gone += 1
    } else activity.unmeasured += 1
  }
  if (activity.unsettled > 0 && activity.observed === 0) activity.summary = `${activity.unsettled} unsettled · runtime unconfirmed`
  else if (activity.unsettled === 0) activity.summary = 'No unsettled runs'
  else activity.summary = `${activity.unsettled} unsettled · ${activity.observed} runtime observed`
  return activity
}

export function runtimeActivitySummary(runs = []) {
  const activity = runtimeActivity(runs)
  if (activity.unsettled > 0 && activity.observed === 0) return `${activity.unsettled} unsettled · runtime unconfirmed`
  if (activity.unsettled === 0) return 'No unsettled runs'
  return `${activity.unsettled} unsettled · ${activity.observed} runtime observed`
}

export function fleetActivity(runs = [], now = Date.now()) {
  const summary = { live: 0, silent: 0, contradicted: 0, unverified: 0, gone: 0, open: 0 }
  for (const run of Array.isArray(runs) ? runs : []) {
    const activity = runActivity(run, now)
    if (activity.key === 'live') summary.live += 1
    if (activity.key === 'silent') summary.silent += 1
    // #953 · TL7 — counted ONCE, in its own bucket. Round 7 incremented `silent` too, and
    // every consumer that counts `silent` calls the row a stale heartbeat.
    if (activity.key === 'contradicted') summary.contradicted += 1
    if (activity.key === 'unverified') summary.unverified += 1
    if (activity.key === 'gone') summary.gone += 1
    if (run?.running) summary.open += 1
  }
  return summary
}

export function deriveDisplayStatus(run = {}, taskEnvelope = null, now = Date.now()) {
  const recorded = deriveStatus(run, taskEnvelope)
  if (!['running', 'queued'].includes(recorded.key)) return recorded
  const activity = runActivity(run, now)
  if (activity.key === 'silent' || activity.key === 'unverified' || activity.key === 'gone' || activity.key === 'contradicted') {
    // #953 — a contradicted row's evidence is the crew state directory, not the heartbeat;
    // `where` was hard-coded to 'heartbeat' and that would now be a false attribution.
    return { key: activity.key, word: activity.word, tone: activity.tone, where: activity.key === 'contradicted' ? 'crew state' : activity.key === 'silent' ? 'heartbeat' : 'runtime observation', why: activity.why }
  }
  return recorded
}

export function heartbeatCell(run = {}, now = Date.now()) {
  let age = finiteNumber(run?.heartbeat_age_ms)
  if (age == null && run?.last_heartbeat_at != null) {
    const timestamp = Date.parse(String(run.last_heartbeat_at))
    if (Number.isFinite(timestamp) && Number.isFinite(now)) age = now - timestamp
  }
  if (age == null) return absenceMark(run?.pending?.last_heartbeat_at)
  const seconds = Math.round(age / 1000)
  if (age <= SILENT_AFTER_MS) return { text: `${seconds}s ago`, stale: false, dashed: false, age_ms: age }
  return { text: `silent ${seconds}s`, stale: true, dashed: false, age_ms: age }
}

// #826 (parent epic #822) — the suite-slot wait a pool would otherwise convert into a
// silent gap. Three absences and never one zero: an unmeasured window carries the ledger's
// own reason, a run that never waited carries no chip at all, and a wait whose admission
// scan never reported a queue depth says unknown.
export function slotWaitCell(run = {}) {
  const rows = Array.isArray(run?.slot_waits) ? run.slot_waits : null
  // MUTATION D1: hand an unmeasured window a measured zero and the row claims no lane
  // waited, on evidence nobody collected.
  if (rows === null) return absenceMark(run?.slot_waits_absent)
  // MUTATION B1: render this case anyway and every row carries a chip — the same blindness
  // as no chip at all.
  if (!rows.length) return null
  const waited = rows.map((row) => row.waited_ms).filter((value) => finiteNumber(value) != null)
  if (!waited.length) return absenceMark(null)
  const total = waited.reduce((sum, value) => sum + value, 0)
  const seconds = Math.max(0, Math.round(total / 1000))
  // MUTATION C2: read anything but the depth column and a MEASURED queue depth disappears
  // behind "unknown".
  const depths = rows.map((row) => row.queue_depth).filter((value) => finiteNumber(value) != null)
  // MUTATION C1: coalesce an unmeasured depth to 0 and a queue nobody scanned reads as a
  // measured queue of length zero.
  const depth = depths.length ? Math.max(...depths) : null
  return {
    // MUTATION A1 (from the signature line) / MUTATION E1 (this sentence): drop the chip, or
    // rename what it says, and the run row stops telling the operator it was queued.
    ...measuredCell(total, `waiting for a suite slot · ${seconds}s`),
    waits: rows.length,
    depth,
    depth_text: depth === null ? 'queue depth unknown' : `queue depth ${depth}`,
    depth_title: depth === null ? (rows.find((row) => row.queue_depth_absent)?.queue_depth_absent ?? null) : null,
  }
}

export function tokenCell(run = {}) {
  const metrics = run?.metrics ?? run ?? {}
  let total = null
  for (const field of TOKEN_FIELDS) {
    const value = metrics?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) total = (total ?? 0) + value
  }
  if (total == null) return absenceMark(run?.pending?.billed_input_tokens)
  const input = finiteNumber(metrics?.billed_input_tokens)
  const output = finiteNumber(metrics?.billed_output_tokens)
  const cacheWrite = finiteNumber(metrics?.billed_cache_write_tokens)
  const cacheRead = finiteNumber(metrics?.billed_cache_read_tokens)
  const promptMeasured = [input, cacheWrite, cacheRead].every((value) => value != null)
  const promptTotal = promptMeasured ? input + cacheWrite + cacheRead : null
  const cacheRate = promptTotal > 0 ? cacheRead / promptTotal * 100 : null
  return {
    ...measuredCell(total, textNumber(total)),
    input,
    output,
    cacheWrite,
    cacheRead,
    promptTotal,
    cacheRate,
    cachePending: cacheRate == null ? (run?.pending?.billed_cache_read_tokens || 'prompt cache usage was not measured') : null,
  }
}

export function costCell(run = {}) {
  const reason = run?.pending?.billed_cost_usd
  if (run?.transport === 'pane' || (typeof reason === 'string' && /subscription seat/i.test(reason))) {
    return absenceMark('not measured · pane')
  }
  return absenceMark(reason)
}

export function gateCell(run = {}) {
  const generations = Array.isArray(run?.gate_generations) ? run.gate_generations : []
  if (!generations.length) return absenceMark(run?.pending?.gate_discrimination)
  const newest = [...generations].sort((a, b) => (a?.gate_generation ?? 0) - (b?.gate_generation ?? 0)).at(-1)
  const verdict = ['proven', 'failed', 'unproven'].includes(newest?.verdict) ? newest.verdict : 'unproven'
  return { ...measuredCell(verdict, verdict), verdict, generation: newest?.gate_generation ?? null }
}

export function reviewCell(run = {}) {
  const reviews = Array.isArray(run?.reviews) ? run.reviews : []
  if (!reviews.length) return absenceMark(run?.pending?.reviews)
  const last = reviews.at(-1)
  const round = reviews.length
  const bounces = reviews.filter((review) => review?.verdict === 'changes-needed').length
  const verdict = last?.verdict ?? null
  const text = `${verdict ?? 'status not recorded'} · round ${round} · ${bounces} bounce${bounces === 1 ? '' : 's'}`
  return { ...measuredCell(verdict, text), verdict, round, bounces }
}

export function tierCell(run = {}) {
  if (run?.tier == null) return absenceMark(run?.pending?.tier)
  const assurance = assuranceMeta(run.tier)
  return { ...measuredCell(run.tier, assurance.label), key: assurance.key, summary: assurance.summary }
}

export function durationCell(run = {}) {
  const duration = finiteNumber(run?.duration_ms)
  if (duration == null) return absenceMark(run?.pending?.duration_ms)
  const seconds = Math.max(0, Math.round(duration / 1000))
  if (seconds < 60) return measuredCell(duration, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return measuredCell(duration, `${minutes}m ${seconds % 60}s`)
  return measuredCell(duration, `${Math.floor(minutes / 60)}h ${minutes % 60}m`)
}

function visibleRows(runs, envelopes, now, filters) {
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (filters.hide_slugless && !run?.goal) return false
    if (filters.hide_archived && run?.triage?.reviewed_at) return false
    return true
  }).map((run) => {
    const status = deriveStatus(run, envelopeFor(envelopes, run.adw_id))
    return {
      adw_id: run.adw_id,
      run_label: run.goal || run.adw_id || 'Untitled run',
      status,
      tier: tierCell(run),
      gate: gateCell(run),
      review: reviewCell(run),
      duration: durationCell(run),
      tokens: tokenCell(run),
      cost: costCell(run),
      heartbeat: heartbeatCell(run, now),
      driver: driverObservation(run),
      slot_wait: slotWaitCell(run),
      activity: runActivity(run, now),
    }
  })
}

export function fleetView(runs, { envelopes = new Map(), now = Date.now(), filters } = {}) {
  const selected = { ...DEFAULT_FILTERS, ...(filters || {}) }
  const source = Array.isArray(runs) ? runs : []
  const rows = visibleRows(source, envelopes, now, selected)
  const hiddenCount = source.length - rows.length
  const hidden = {
    count: hiddenCount,
    line: hiddenCount === 0 ? '' : `${hiddenCount} row${hiddenCount === 1 ? '' : 's'} hidden by the default filter (slug-less or archived)`,
  }
  const escalated = rows.filter((row) => row.status.key === 'escalated')
    .map((row) => ({ ...row, why: row.status.why }))
  const contradicted = rows.filter((row) => row.activity.key === 'contradicted')
    .map((row) => ({ ...row, why: row.activity.why }))
  const gone = rows.filter((row) => row.activity.key === 'gone')
    .map((row) => ({ ...row, why: row.activity.why }))
  // The rail composition keeps an escalated contradicted lane from appearing on the rail
  // twice; with no contradicted run present this list is byte-identical to today's. The
  // contradicted clause is the ONLY clause that can rank a non-escalated lane archived seconds ago whose heartbeat is still fresh.
  const silent = rows.filter((row) => row.status.key === 'running' && row.heartbeat.stale && row.activity.key !== 'contradicted' && row.status.key !== 'escalated')
    .map((row) => ({ ...row, why: row.heartbeat.text }))
  return { rows, rail: [...escalated, ...contradicted.filter((row) => row.status.key !== 'escalated'), ...gone.filter((row) => row.status.key !== 'escalated'), ...silent], hidden, shown: rows.length }
}

export function escalationProbeTargets(rows = []) {
  const targets = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const run = row?.run && typeof row.run === 'object' ? row.run : row
    const slug = run?.goal ?? run?.task_slug
    const status = typeof run?.status === 'object' ? run.status.key : run?.status
    if (!run?.repo_slug || !slug || status === 'ok' || status === 'success' || run?.adw_id == null || seen.has(run.adw_id)) continue
    seen.add(run.adw_id)
    targets.push(run.adw_id)
  }
  return targets
}
