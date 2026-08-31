import { acceptRows } from './panels.js'

export const ROLE_ORDER = Object.freeze(['planner', 'builder', 'reviewer', 'tech-lead', 'lead', 'driver'])

const EFFORT_WHY = 'not recorded per run — agent_sessions carries model but no effort column (scripts/factory/ledger.mjs:406-426); effort is recorded only on cell_failures and modifier_attempts rows (crew/seat-io.mjs:264-265, 285-288)'
const CONTEXT_WHY = 'claude pane seats land an agent_sessions row via emitPaneUsage (crew/seat-io.mjs:1940); pi/codex pane seats land none because only claude ships a reader (crew/seat-io.mjs:877), so pane totals are a floor; no live transport records occupancy — headless-json/headless-rpc land rows with both columns NULL; context_window has no verified source (U-4); see docs/ledger-queries.md'
const MODEL_WHY = 'not measured — no agent_sessions row carries a model for this dispatch (a pi/codex pane seat ships no usage reader, crew/seat-io.mjs:877)'
const MUST_FIX_WHY = 'predates this measurement — the review recorded no must-fix count'
const ARTIFACT_WHY = 'artifact bytes are not served: no endpoint serves file bytes and server.mjs is fenced this batch'

const GATE_TONES = Object.freeze({
  proven: { tone: 'proven', label: 'Proven', explanation:'The gate passed with the built changes and turned red when those changes were removed.' },
  failed: { tone: 'failed', label: 'Failed proof', explanation:'The recorded proof did not establish that the gate depends on the built changes.' },
  unproven: { tone: 'unproven', label: 'Proof incomplete', explanation:'The factory could not complete enough counterfactual evidence to judge the gate.' },
})

function mark(text, title) {
  return { text, dashed: true, title: title || 'not measured' }
}

function payload(event) {
  if (event == null) return {}
  if (event.payload_json == null && event.payload && typeof event.payload === 'object') return event.payload
  try {
    return typeof event.payload_json === 'string' ? JSON.parse(event.payload_json || '{}') : (event.payload_json || {})
  } catch { return {} }
}

function laneOf(value) {
  return value == null ? null : value
}

function sameValue(left, right) {
  if (left == null || right == null) return left == null && right == null
  return String(left) === String(right)
}

function laneSort(left, right) {
  if (left == null) return right == null ? 0 : 1
  if (right == null) return -1
  const a = Number(left), b = Number(right)
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b
  return String(left).localeCompare(String(right))
}

function laneKey(lane) {
  return lane == null ? 'null' : String(lane)
}

function roleForLane(lane) {
  const index = Number(lane)
  return Number.isInteger(index) && index >= 0 ? (ROLE_ORDER[index] ?? null) : null
}

export function laneRows(run = {}, events = [], _options = {}) {
  const phases = Array.isArray(run.phases) ? run.phases : []
  const agents = Array.isArray(run.agents) ? run.agents : []
  const sourceEvents = Array.isArray(events) ? events : []
  const phaseById = new Map(phases.map((phase) => [String(phase.id), phase]))
  const eventRoles = new Map()

  for (const event of sourceEvents) {
    if (event?.phase_id == null || !['agent_start', 'agent_end'].includes(event.type)) continue
    const phase = phaseById.get(String(event.phase_id))
    const role = payload(event)?.role
    if (!phase || !role) continue
    const key = laneKey(laneOf(phase.lane))
    if (!eventRoles.has(key)) eventRoles.set(key, role)
  }

  const seatRoles = new Map()
  for (const agent of agents) {
    const lane = laneOf(agent?.lane)
    if (!seatRoles.has(laneKey(lane)) && agent?.role) seatRoles.set(laneKey(lane), agent.role)
  }

  const candidates = []
  const addCandidate = (lane) => {
    const normalized = laneOf(lane)
    if (!candidates.some((entry) => sameValue(entry, normalized))) candidates.push(normalized)
  }
  for (const phase of phases) addCandidate(phase?.lane)
  for (const agent of agents) addCandidate(agent?.lane)
  candidates.sort(laneSort)

  const lanes = [], collapsed = []
  for (const lane of candidates) {
    const owned = phases.filter((phase) => sameValue(laneOf(phase?.lane), lane))
    const seats = agents.filter((agent) => sameValue(laneOf(agent?.lane), lane))
    const key = laneKey(lane)
    const role = eventRoles.get(key) ?? seatRoles.get(key) ?? roleForLane(lane) ?? (lane == null ? 'unlinked' : null)
    if (!owned.length) {
      collapsed.push({ lane, role })
      continue
    }
    const model = seats.map((seat) => seat?.model).find((value) => value != null && (typeof value !== 'string' || value.length > 0)) ?? null
    const firstSeat = seats[0] ?? null
    lanes.push({
      lane,
      key: lane == null ? 'unlinked' : `lane-${lane}`,
      role,
      phase_ids: owned.map((phase) => phase.id),
      header: {
        role,
        lane,
        dispatch_ids: seats.map((seat) => seat?.dispatch_id ?? null),
        attempts: owned.length,
        outcome: seats.at(-1)?.outcome ?? null,
        model,
        model_mark: model == null ? mark('model —', firstSeat?.model_pending || MODEL_WHY) : null,
        effort_mark: mark('effort —', firstSeat?.effort_pending || EFFORT_WHY),
        context_mark: mark('context —', firstSeat?.context_pending || CONTEXT_WHY),
      },
    })
  }
  return {
    lanes,
    collapsed,
    unavailable: run.phase_lanes == null ? (run.pending?.phase_lanes ?? null) : null,
  }
}

export function bounceArrows(run = {}) {
  const reviews = Array.isArray(run.reviews) ? run.reviews : null
  if (!reviews) return {
    arrows: [],
    pending: run.pending?.reviews ?? 'review outcomes are not recorded for this run',
  }
  const phases = [...(Array.isArray(run.phases) ? run.phases : [])]
    .sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0))
  const reviewPhases = phases.filter((phase) => String(phase?.name || '').startsWith('review'))
  const arrows = []
  reviews.forEach((review, index) => {
    if (review?.verdict !== 'changes-needed') return
    const from = reviewPhases[index]
    if (!from) return
    const to = phases.find((phase) => (phase?.seq ?? 0) > (from?.seq ?? 0) && String(phase?.name || '').startsWith('build'))
    if (!to) return
    const mustFix = review.must_fix == null ? null : review.must_fix
    arrows.push({
      round: index + 1,
      from_phase_id: from.id,
      from_phase: from.name,
      to_phase_id: to.id,
      to_phase: to.name,
      must_fix: mustFix,
      label: mustFix == null ? 'must-fix —' : `must-fix ${mustFix}`,
      title: mustFix == null ? MUST_FIX_WHY : `${mustFix} must-fix findings bounced into ${to.name}`,
    })
  })
  return { arrows, pending: null }
}

export function gateMarkers(run = {}) {
  const generations = Array.isArray(run.gate_generations) ? run.gate_generations : null
  if (!generations) return {
    markers: [],
    pending: run.pending?.gate_generations ?? run.pending?.gate_discrimination ?? 'gate discrimination is not recorded for this run',
  }
  const checksByGeneration = new Map()
  for (const row of Array.isArray(run.gate_checks) ? run.gate_checks : []) {
    if (row?.gate_generation != null) checksByGeneration.set(String(row.gate_generation), row)
  }
  const markers = generations.map((generation) => {
    const verdict = generation?.verdict
    const tone = GATE_TONES[verdict] || GATE_TONES.unproven
    const row = generation?.gate_generation == null ? null : (checksByGeneration.get(String(generation.gate_generation)) ?? null)
    const generationLabel = generation?.gate_generation == null ? 'Gate' : `Gate G${generation.gate_generation}`
    const counts = generation?.checks_total == null
      ? null
      : `${generation.checks_failed ?? '—'} failed · ${generation.checks_errored ?? '—'} errored · ${generation.checks_total} checks`
    return {
      generation: generation?.gate_generation ?? null,
      verdict: verdict ?? null,
      tone: tone.tone,
      label: `${generationLabel} · ${tone.label}`,
      title: [tone.explanation, counts, generation?.note].filter(Boolean).join(' '),
      phase_id: row?.phase_id ?? null,
      checks: row?.checks ?? [],
    }
  })
  return { markers, pending: null }
}

function latestLeadEnvelope(returns) {
  const envelopes = Array.isArray(returns?.envelopes) ? returns.envelopes.filter((entry) => entry?.role === 'lead') : []
  return envelopes.reduce((latest, entry) => {
    if (!latest) return entry
    const left = Number(latest.dispatch_seq), right = Number(entry.dispatch_seq)
    if (Number.isFinite(right) && (!Number.isFinite(left) || right >= left)) return entry
    return latest
  }, null)
}

function evidenceItem(item, kind) {
  // A residual may be recorded as a bare string rather than an object. Reading
  // only object properties silently emptied it, and hiding recorded evidence is
  // the one thing this surface exists to prevent.
  const why = typeof item === 'string'
    ? item
    : (item?.why ?? item?.evidence ?? item?.detail ?? null)
  const text = why == null ? '' : (typeof why === 'string' ? why : JSON.stringify(why))
  return {
    id: item?.id ?? null,
    kind,
    why,
    blocks: renderMarkdown(text),
  }
}

function findingIds(returns) {
  const ids = new Set()
  let measured = false
  for (const envelope of Array.isArray(returns?.envelopes) ? returns.envelopes : []) {
    const findings = envelope?.details?.findings
    if (!Array.isArray(findings)) continue
    measured = true
    for (const finding of findings) if (finding?.id != null) ids.add(String(finding.id))
  }
  return { ids, measured }
}

export function acceptEvidence(run = {}, returns = {}) {
  const panel = acceptRows(run)
  const lead = latestLeadEnvelope(returns)
  const refuted = Array.isArray(lead?.details?.refuted) ? lead.details.refuted : []
  const residuals = Array.isArray(lead?.details?.residuals) ? lead.details.residuals : []
  const rawEvidence = [
    ...refuted.map((item) => evidenceItem(item, 'refuted')),
    ...residuals.map((item) => evidenceItem(item, item?.type === 'cosmetic' ? 'cosmetic' : 'residual')),
  ]
  const findingEvidence = findingIds(returns)
  // A findings array is a measured join side. Once it exists, an evidence item
  // without a matching id is stale/foreign evidence, not an accept finding.
  // An item carrying an id that the findings array does not know is foreign and
  // is dropped. An item with NO id cannot be matched either way, so dropping it
  // would discard real recorded evidence to enforce a join it can never satisfy
  // — a bare-string residual is exactly that case. Keep it.
  const evidence = findingEvidence.measured
    ? rawEvidence.filter((item) => item.id == null || findingEvidence.ids.has(String(item.id)))
    : rawEvidence
  const rows = panel.rows.map((row) => {
    // cosmetic_count belongs here: a recorded nonzero cosmetic count with no
    // evidence items is exactly the case the pending note explains, and leaving
    // it out rendered an unexplained empty evidence area.
    const counted = [row.refuted_count, row.residual_count, row.cosmetic_count]
      .map((value) => typeof value === 'number' ? value : Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0)
    return {
      ...row,
      evidence,
      evidence_pending: evidence.length ? null : counted > 0
        ? 'the counts are recorded in accept_decisions; the per-finding evidence is not — the lead envelope carries no refuted/residual items for this run'
        : null,
    }
  })
  return { rows, pending: panel.pending }
}

function gateTone(verdict) {
  return GATE_TONES[verdict]?.tone ?? (verdict == null ? null : 'unproven')
}

function gateRunPassed(row) {
  if (row?.ok === true || row?.ok === 1 || row?.ok === '1') return true
  if (row?.ok === false || row?.ok === 0 || row?.ok === '0') return false
  return null
}

function gateRunSummary(row) {
  for (const check of Array.isArray(row?.checks) ? row.checks : []) {
    if (typeof check?.label !== 'string') continue
    try {
      const parsed = JSON.parse(check.label)
      if (parsed && typeof parsed === 'object' && ['total', 'failed', 'errored'].some((key) => parsed[key] != null)) {
        return {
          total: parsed.total ?? null,
          failed: parsed.failed ?? null,
          errored: parsed.errored ?? null,
        }
      }
    } catch {}
  }
  return null
}

function gateSummaryText(summary) {
  if (!summary) return null
  const parts = []
  if (summary.total != null) parts.push(`${summary.total} run`)
  if (summary.failed != null) parts.push(`${summary.failed} failed`)
  if (summary.errored != null) parts.push(`${summary.errored} errored`)
  return parts.join(' · ') || null
}

function proofStage(row, { label, detail, passing, passLabel, failLabel }) {
  if (!row) return null
  const passed = gateRunPassed(row)
  const expected = passed == null ? null : passed === passing
  return {
    label,
    detail,
    result: passed == null ? 'Result not recorded' : passed ? passLabel : failLabel,
    tone: expected == null ? 'unknown' : expected ? 'expected' : 'unexpected',
    summary: gateSummaryText(gateRunSummary(row)),
  }
}

function gateAttemptLabel(row) {
  const name = String(row?.gate_name || 'gate run')
  if (name.startsWith('gate-baseline')) return 'Before work'
  if (/^gate:r\d+$/.test(name)) return `Built result · ${name.slice(5).toUpperCase()}`
  if (/^gate-proof:\d+$/.test(name)) return 'Without built changes'
  const mutation = name.match(/:checks:m(\d+)$/)
  if (mutation) return `Mutation probe M${mutation[1]}`
  return name.replaceAll(':', ' · ').replaceAll('-', ' ')
}

export function gateProofStory(rows = [], generation = null, generations = []) {
  const selected = (Array.isArray(rows) ? rows : []).filter((row) => generation == null || String(row?.gate_generation) === String(generation))
  const baseline = selected.find((row) => String(row?.gate_name || '').startsWith('gate-baseline')) ?? null
  const built = [...selected].reverse().find((row) => /^gate:r\d+$/.test(String(row?.gate_name || ''))) ?? null
  const pristine = [...selected].reverse().find((row) => /^gate-proof:\d+$/.test(String(row?.gate_name || ''))) ?? null
  const mutationRows = selected.filter((row) => /:checks:m\d+$/.test(String(row?.gate_name || '')))
  const mutationRed = mutationRows.filter((row) => gateRunPassed(row) === false).length
  const mutationGreen = mutationRows.filter((row) => gateRunPassed(row) === true).length
  const mutationUnknown = mutationRows.length - mutationRed - mutationGreen
  const generationRow = (Array.isArray(generations) ? generations : []).find((row) => String(row?.gate_generation) === String(generation)) ?? null
  const verdict = generationRow?.verdict ?? null
  const generationCount = new Set((Array.isArray(generations) ? generations : []).map((row) => row?.gate_generation).filter((value) => value != null)).size
  const verdictCopy = verdict === 'proven'
    ? {
      headline: generationCount > 1 ? 'The repaired gate distinguishes the built result' : 'The gate distinguishes the built result',
      explanation: 'It passed with the built changes and turned red when those changes were removed.',
    }
    : verdict === 'failed'
      ? { headline:'The gate did not distinguish the built result', explanation:generationRow?.note || 'The recorded proof did not show that the gate depends on the built changes.' }
      : { headline:'The gate proof is incomplete', explanation:generationRow?.note || 'The recorded evidence could not establish whether the gate depends on the built changes.' }
  const stages = [
    proofStage(baseline, { label:'Before work', detail:'The task should begin with a red gate.', passing:false, passLabel:'Unexpectedly green', failLabel:'Red as expected' }),
    proofStage(built, { label:'Built result', detail:'The completed work should make the gate pass.', passing:true, passLabel:'Passed', failLabel:'Still failing' }),
    proofStage(pristine, { label:'Without built changes', detail:'Removing the work should make the gate fail.', passing:false, passLabel:'Stayed green', failLabel:'Turned red' }),
  ].filter(Boolean)
  const attempts = selected.map((row) => ({
    label: gateAttemptLabel(row),
    result: gateRunPassed(row) == null ? 'Not recorded' : gateRunPassed(row) ? 'Green' : 'Red',
    tone: gateRunPassed(row) == null ? 'unknown' : gateRunPassed(row) ? 'green' : 'red',
    summary: gateSummaryText(gateRunSummary(row)),
    attempt: row?.attempt ?? null,
  }))
  return {
    verdict,
    headline: verdictCopy.headline,
    explanation: verdictCopy.explanation,
    stages,
    attempts,
    generation_count: generationCount,
    mutation: mutationRows.length ? {
      total: mutationRows.length,
      red: mutationRed,
      green: mutationGreen,
      unknown: mutationUnknown,
      summary: `${mutationRed} of ${mutationRows.length} recorded mutation probes turned the gate red`,
    } : null,
  }
}

function samePhase(left, right) {
  return left != null && right != null && String(left) === String(right)
}

export function phaseFilterId(run = {}, value = null) {
  if (value == null || value === '') return ''
  const phases = Array.isArray(run?.phases) ? run.phases : []
  const match = phases.find((phase) => samePhase(phase?.id, value) || phase?.name === value)
  return match?.id ?? value
}

function artifactBlocks(envelopes) {
  const blocks = []
  for (const envelope of envelopes) {
    for (const value of [envelope?.summary, envelope?.details?.reason, envelope?.details?.guidance, envelope?.details?.why]) {
      if (typeof value === 'string' && value.length) blocks.push(...renderMarkdown(value))
    }
    for (const finding of Array.isArray(envelope?.details?.findings) ? envelope.details.findings : []) {
      if (typeof finding?.summary === 'string' && finding.summary.length) blocks.push(...renderMarkdown(finding.summary))
    }
  }
  return blocks
}

function artifactDocuments(envelopes) {
  return [...envelopes].reverse().map((envelope) => {
    const blocks = artifactBlocks([envelope])
    return {
      id: `${envelope?.role || 'agent'}-${envelope?.dispatch_seq ?? 'unknown'}`,
      role: envelope?.role || 'agent',
      dispatch_seq: envelope?.dispatch_seq ?? null,
      status: envelope?.status ?? null,
      blocks,
    }
  }).filter((document) => document.blocks.length)
}

function artifactPaths(envelopes) {
  const paths = new Map()
  for (const envelope of envelopes) {
    for (const path of Array.isArray(envelope?.artifacts) ? envelope.artifacts : []) {
      if (!paths.has(path)) paths.set(path, { path, reason: ARTIFACT_WHY, sources: [] })
      paths.get(path).sources.push(`${envelope?.role || 'agent'} d${envelope?.dispatch_seq ?? '—'}`)
    }
  }
  return [...paths.values()]
}

export function phasePanel(run = {}, { phase = null, events = [], returns = {} } = {}) {
  const phases = Array.isArray(run.phases) ? run.phases : []
  const found = phases.find((entry) => entry?.name === phase)
    ?? phases.find((entry) => samePhase(entry?.id, phase))
  if (!found) {
    return {
      phase: null,
      found: false,
      gate: null,
      accept: null,
      events: [],
      artifacts: null,
      pending: `no phase named ${phase ?? '—'} in this run`,
    }
  }

  const gateRows = (Array.isArray(run.gate_checks) ? run.gate_checks : [])
    .filter((row) => samePhase(row?.phase_id, found.id))
  const orderedGateRows = [...gateRows].sort((left, right) => ((left?.gate_generation ?? 0) - (right?.gate_generation ?? 0)) || ((left?.attempt ?? 0) - (right?.attempt ?? 0)))
  const gateRow = orderedGateRows.at(-1) ?? null
  const gateChecks = orderedGateRows.flatMap((row) => Array.isArray(row?.checks) ? row.checks : [])
  const gatePending = orderedGateRows.map((row) => row?.checks_pending).filter((value) => typeof value === 'string' && value.length).join(' · ') || null
  const generation = (Array.isArray(run.gate_generations) ? run.gate_generations : [])
    .find((entry) => samePhase(entry?.gate_generation, gateRow?.gate_generation)) ?? null
  const proof = gateProofStory(orderedGateRows, gateRow?.gate_generation ?? null, run.gate_generations)
  const envelopeList = Array.isArray(returns?.envelopes) ? returns.envelopes : []
  const scopedEvents = (Array.isArray(events) ? events : []).filter((event) => samePhase(event?.phase_id, found.id))
  const gate = gateRow == null
    ? {
      generation: null,
      verdict: null,
      tone: null,
      checks: [],
      checks_pending: run.pending?.gate_checks ?? 'no gate ran in this phase',
      checks_total: null,
      checks_failed: null,
      checks_errored: null,
      note: null,
    }
    : {
      generation: gateRow.gate_generation ?? null,
      verdict: generation?.verdict ?? null,
      tone: gateTone(generation?.verdict),
      checks: gateChecks,
      checks_pending: gatePending,
      checks_total: generation?.checks_total ?? null,
      checks_failed: generation?.checks_failed ?? null,
      checks_errored: generation?.checks_errored ?? null,
      note: generation?.note ?? null,
      proof,
    }
  return {
    phase: found,
    found: true,
    gate,
    accept: acceptEvidence(run, returns),
    events: scopedEvents,
    artifacts: {
      blocks: artifactBlocks(envelopeList),
      documents: artifactDocuments(envelopeList),
      paths: artifactPaths(envelopeList),
    },
    pending: returns?.error ?? null,
  }
}

function inlineRuns(value) {
  const source = typeof value === 'string' ? value : String(value ?? '')
  const runs = []
  let text = ''
  const flush = () => {
    if (text) { runs.push({ kind: 'text', text }); text = '' }
  }
  const pushDelimited = (delimiter, kind, index) => {
    const close = source.indexOf(delimiter, index + delimiter.length)
    if (close <= index + delimiter.length) return false
    flush()
    runs.push({ kind, text: source.slice(index + delimiter.length, close) })
    cursor = close + delimiter.length
    return true
  }
  let cursor = 0
  while (cursor < source.length) {
    if (source.startsWith('**', cursor) && pushDelimited('**', 'strong', cursor)) continue
    if (source[cursor] === '`') {
      const close = source.indexOf('`', cursor + 1)
      if (close > cursor + 1) {
        flush()
        runs.push({ kind: 'code', text: source.slice(cursor + 1, close) })
        cursor = close + 1
        continue
      }
    }
    if (source[cursor] === '[') {
      const closeLabel = source.indexOf('](', cursor + 1)
      const closeUrl = closeLabel < 0 ? -1 : source.indexOf(')', closeLabel + 2)
      if (closeLabel > cursor + 1 && closeUrl > closeLabel + 2) {
        flush()
        runs.push({ kind: 'link', text: source.slice(cursor + 1, closeLabel), href: source.slice(closeLabel + 2, closeUrl) })
        cursor = closeUrl + 1
        continue
      }
    }
    if (source[cursor] === '*' || source[cursor] === '_') {
      const delimiter = source[cursor]
      const close = source.indexOf(delimiter, cursor + 1)
      if (close > cursor + 1) {
        flush()
        runs.push({ kind: 'emphasis', text: source.slice(cursor + 1, close) })
        cursor = close + 1
        continue
      }
    }
    text += source[cursor]
    cursor += 1
  }
  flush()
  return runs
}

export function renderMarkdown(text) {
  const source = typeof text === 'string' ? text : ''
  const blocks = []
  const lines = source.split('\n')
  let paragraph = []
  let list = []
  let code = null

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ kind: 'paragraph', runs: inlineRuns(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = () => {
    if (!list.length) return
    blocks.push({ kind: 'list', ordered: list[0].ordered, items: list.map((item) => ({ runs: inlineRuns(item.text) })) })
    list = []
  }
  const flushText = () => { flushParagraph(); flushList() }

  for (const line of lines) {
    if (code != null) {
      if (/^\s*```/.test(line)) {
        const block = { kind: 'code', text: code.lines.join('\n') }
        if (code.language) block.language = code.language
        blocks.push(block)
        code = null
      } else code.lines.push(line)
      continue
    }
    const fence = line.match(/^\s*```\s*(.*)$/)
    if (fence) {
      flushText()
      code = { language: fence[1] || null, lines: [] }
      continue
    }
    if (/^\s*$/.test(line)) { flushText(); continue }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      flushText()
      blocks.push({ kind: 'heading', level: heading[1].length, runs: inlineRuns(heading[2]) })
      continue
    }
    const callout = line.match(/^\s*((?:BLOCKER|CLOSED|ALREADY HANDLED(?:\s+by\s+the\s+reference)?|RE-?PROVED|PREFERRED|ALTERNATIVE|WARNING|NOTE|VERDICT|ESCALATE)(?:\s*\([^)]*\))?)(?::|\.|\s+—)\s*(.*)$/i)
    if (callout) {
      flushText()
      const key = callout[1].toUpperCase()
      const tone = /BLOCKER|ESCALATE/.test(key) ? 'serious' : /CLOSED|HANDLED|PROVED/.test(key) ? 'ok' : /WARNING|VERDICT/.test(key) ? 'warn' : 'neutral'
      blocks.push({ kind: 'callout', label: callout[1], tone, runs: inlineRuns(callout[2]) })
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flushText()
      blocks.push({ kind: 'blockquote', runs: inlineRuns(quote[1]) })
      continue
    }
    if (/^\s*(?:---+|\*\*\*|___)\s*$/.test(line)) {
      flushText()
      blocks.push({ kind: 'rule' })
      continue
    }
    const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/)
    if (item) {
      flushParagraph()
      const ordered = /^\s*\d/.test(line)
      if (list.length && list[0].ordered !== ordered) flushList()
      list.push({ text: item[1], ordered })
      continue
    }
    if (list.length) flushList()
    paragraph.push(line)
    flushParagraph()
  }
  if (code != null) {
    const block = { kind: 'code', text: code.lines.join('\n') }
    if (code.language) block.language = code.language
    blocks.push(block)
  }
  flushText()
  return blocks
}
