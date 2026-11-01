// Read-only ACP recording projection. Source line order and identity are separate
// from timing; neither a pending call nor a missing terminal row proves liveness.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const text = value => typeof value === 'string' ? value : ''
const stamp = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? value : null
export const prettyTraceValue = value => value === undefined ? 'Not recorded' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const blockText = content => Array.isArray(content) ? content.map(block => text(block?.text) || text(block?.content?.text)).filter(Boolean).join('\n') : text(content?.text)

export function projectRecording(recording = {}) {
  const records = [], calls = new Map(), messages = new Map(), warnings = []
  let usage = null, previous = null
  const lines = typeof recording.raw === 'string' ? recording.raw.split('\n') : []
  function add(kind, name, line, row, suffix = `line:${line}`) {
    const record = { id: `${recording.file || 'recording'}\0${suffix}`, index: records.length + 1,
      kind, lane: kind === 'tool' ? 'Tools' : kind === 'model' ? 'Model' : 'Input', name,
      text: '', status: null, input: undefined, output: undefined,
      started_at: stamp(row?.at), ended_at: stamp(row?.at), duration_ms: null, raw: [],
      call_id: null, session_id: row?.sessionId ?? null, incomplete: false }
    records.push(record)
    return record
  }
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue
    const line = index + 1
    let row
    try { row = JSON.parse(lines[index]) } catch {
      warnings.push({ line, reason: 'Invalid JSON' })
      const record = add('runtime', 'Unreadable source row', line, null)
      record.text = lines[index]; record.raw.push({ line, source: lines[index] }); previous = record; continue
    }
    if (!object(row)) {
      warnings.push({ line, reason: 'Row is not an object' })
      const record = add('runtime', 'Unsupported source row', line, null)
      record.output = row; record.raw.push({ line, row }); previous = record; continue
    }
    const update = object(row.update) ? row.update : null
    const kind = text(update?.sessionUpdate)
    let record
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const callId = text(update.toolCallId), session = text(row.sessionId)
      const key = JSON.stringify([session, callId])
      record = callId ? calls.get(key) : null
      if (!record) {
        record = add('tool', 'Tool name not recorded', line, row, callId ? `call:${key}` : `line:${line}`)
        record.call_id = callId || null
        record.started_at = null; record.ended_at = null
        if (callId) calls.set(key, record)
      }
      const toolName = text(update.name) || text(update._meta?.claudeCode?.toolName) || (kind === 'tool_call' && /^[A-Za-z_.-]+$/.test(text(update.title)) ? text(update.title) : '') || text(update.kind)
      if (toolName) record.name = toolName
      if (text(update.title)) record.text = update.title
      if (text(update.status)) record.status = update.status
      if (own(update, 'rawInput')) record.input = update.rawInput
      if (own(update, 'rawOutput')) record.output = update.rawOutput
      else if (own(update._meta?.claudeCode ?? {}, 'toolResponse')) record.output = update._meta.claudeCode.toolResponse
      else if (Array.isArray(update.content) && update.content.length) record.output = update.content
      if (kind === 'tool_call' && record.started_at === null) record.started_at = stamp(row.at)
      if (['completed', 'failed', 'cancelled'].includes(update.status)) record.ended_at = stamp(row.at)
      record.incomplete = !['completed', 'failed', 'cancelled'].includes(record.status)
    } else if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(kind)) {
      const category = kind === 'user_message_chunk' ? 'input' : 'model'
      const name = kind === 'agent_thought_chunk' ? 'Reasoning' : category === 'input' ? 'User message' : 'Assistant message'
      const messageId = text(update.messageId), key = JSON.stringify([row.sessionId ?? '', kind, messageId])
      record = messageId ? messages.get(key) : previous?.chunkKind === kind && previous.session_id === (row.sessionId ?? null) ? previous : null
      if (!record) {
        record = add(category, name, line, row, messageId ? `message:${key}` : `line:${line}`)
        record.chunkKind = kind
        if (messageId) messages.set(key, record)
      }
      record.ended_at = stamp(row.at)
      record.text += blockText(update.content)
      record.output = record.text
      if (!blockText(update.content) && update.content) record.output = update.content
    } else {
      const prompt = row.type === 'prompt'
      record = add(prompt ? 'input' : 'runtime', prompt ? 'Seat prompt' : row.type === 'turn' ? 'Turn result' : row.kind === 'permission' ? 'Permission decision' : kind || text(row.type) || text(row.kind) || 'Unrecognized event', line, row)
      if (prompt) { record.input = row.text; record.text = text(row.text) }
      else {
        record.output = update ?? row
        record.text = row.type === 'turn' ? text(row.stopReason) || text(row.refusal?.message) || 'No stop reason recorded'
          : row.kind === 'permission' ? [row.tool, row.option_kind ?? row.option].filter(Boolean).join(' · ')
            : kind === 'plan' ? (Array.isArray(update.entries) ? update.entries : []).map(entry => text(entry?.content)).join(' · ') : kind || text(row.kind) || text(row.type) || 'Source event'
        if (row.type === 'turn') {
          record.status = row.refusal ? 'refused' : text(row.stopReason) || null
          record.usage = object(row.usage) ? row.usage : null
          usage = record.usage
        }
      }
    }
    record.raw.push({ line, row })
    previous = record
  }
  for (const record of records) {
    if (record.started_at !== null && record.ended_at !== null && record.ended_at >= record.started_at) record.duration_ms = record.ended_at - record.started_at
    const preview = record.kind === 'tool' ? [record.text, record.input !== undefined ? prettyTraceValue(record.input) : '', record.output !== undefined ? blockText(record.output) || prettyTraceValue(record.output) : ''].filter(Boolean).join(' → ') : record.text || (record.input !== undefined ? prettyTraceValue(record.input) : blockText(record.output) || prettyTraceValue(record.output))
    record.preview = preview.replace(/\s+/g, ' ').slice(0, 240)
    record.searchText = [record.name, record.text, prettyTraceValue(record.input), prettyTraceValue(record.output), record.call_id].join('\n').toLowerCase()
  }
  return { records, warnings, usage, source_lines: lines.filter(line => line.trim()).length,
    tool_count: records.filter(record => record.kind === 'tool').length }
}

export function filterTrace(records, { query = '', kind = 'all', from = 1, to = Infinity } = {}) {
  const needle = query.trim().toLowerCase()
  return records.filter(record => (kind === 'all' || record.kind === kind) && record.index >= from && record.index <= to && (!needle || record.searchText.includes(needle)))
}

export function traceOverview(records, mode = 'sequence') {
  if (mode === 'time') {
    const timed = records.filter(record => record.started_at !== null && record.duration_ms !== null)
    if (!timed.length) return []
    const start = Math.min(...timed.map(record => record.started_at))
    const end = Math.max(...timed.map(record => record.ended_at))
    const span = end - start
    return timed.map(record => ({ id: record.id, index: record.index, lane: record.lane,
      x: span ? (record.started_at - start) / span : 0, width: span ? record.duration_ms / span : 1 }))
  }
  const total = records.length
  return records.map((record, index) => ({ id: record.id, index: record.index, lane: record.lane, x: index / total, width: 1 / total }))
}

export function nearestTraceSpan(spans, fraction, lane) {
  const candidates = spans.filter(span => span.lane === lane)
  const pool = candidates.length ? candidates : spans
  return pool.reduce((best, span) => {
    const distance = fraction < span.x ? span.x - fraction : fraction > span.x + span.width ? fraction - span.x - span.width : 0
    return !best || distance < best.distance ? { span, distance } : best
  }, null)?.span ?? null
}
