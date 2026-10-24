// The protocols code reads at the agent boundary (ADR-052 section 3). P1, the lane
// brief: markdown opened by a frontmatter block. Code reads only BRIEF_FIELDS; the
// body is the planner's to read. Import-free, so the new path never loads the old one.

export const BRIEF_FIELDS = Object.freeze(['source', 'closes', 'tier', 'shape', 'acceptance', 'out_of_scope'])
export const TIERS = Object.freeze(['mechanical', 'build', 'judge'])
export const SHAPES = Object.freeze(['standard', 'stepped', 'finish'])
const ID = /^[A-Za-z][A-Za-z0-9._-]*$/

// One frontmatter value: [a, b] is a list, null is null, digits are an integer,
// anything else is a string with one pair of surrounding quotes removed.
function value(raw) {
  const text = raw.trim()
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1).split(',').map((item) => value(item)).filter((item) => item !== '')
  if (text === 'null') return null
  if (/^\d+$/.test(text)) return Number(text)
  const quoted = /^(["'])(.*)\1$/.exec(text)
  return quoted ? quoted[2] : text
}

// The body's lines grouped by level-1 or level-2 heading, skipping fenced text: a
// heading or item quoted inside a fence is an example, as the driver reads it.
function sections(body) {
  const out = new Map()
  let current = null
  let fence = null
  for (const line of body.split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) { if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null; continue }
    if (mark) { fence = mark; continue }
    if (/^#{1,2}\s+/.test(line)) { current = line.trim(); if (!out.has(current)) out.set(current, []); continue }
    if (current) out.get(current).push(line)
  }
  return out
}

// Returns { fields, body, defects }. An empty defects list is a brief code can start.
export function parseBrief(text) {
  const lines = String(text ?? '').split('\n')
  if (lines[0]?.trim() !== '---') return { fields: null, body: null, defects: ['the brief does not open with a --- frontmatter block'] }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { fields: null, body: null, defects: ['the frontmatter block is never closed with ---'] }
  const fields = {}
  const defects = []
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const pair = /^([a-z_]+):(.*)$/.exec(line)
    if (!pair) { defects.push(`frontmatter line is not key: value: ${JSON.stringify(line)}`); continue }
    if (!BRIEF_FIELDS.includes(pair[1])) { defects.push(`unknown field ${pair[1]}; the fields are ${BRIEF_FIELDS.join(', ')}`); continue }
    fields[pair[1]] = value(pair[2])
  }
  for (const key of BRIEF_FIELDS) if (!Object.hasOwn(fields, key)) defects.push(`missing field ${key}`)
  const body = lines.slice(end + 1).join('\n')
  if (typeof fields.source !== 'string' || !fields.source) defects.push('source names the issue or operator command the lane starts from')
  if (fields.closes !== null && !(Number.isInteger(fields.closes) && fields.closes > 0)) defects.push('closes is null or one issue number')
  if (!TIERS.includes(fields.tier)) defects.push(`tier is one of ${TIERS.join(', ')}`)
  if (!SHAPES.includes(fields.shape)) defects.push(`shape is one of ${SHAPES.join(', ')}`)
  if (typeof fields.out_of_scope !== 'string' || !fields.out_of_scope) defects.push('out_of_scope says what the lane must not change')
  const acceptance = Array.isArray(fields.acceptance) ? fields.acceptance : []
  if (acceptance.length === 0 || !acceptance.every((id) => typeof id === 'string' && ID.test(id))) defects.push('acceptance lists the gate ids, each a letter then letters, digits, . _ or -')
  else if (new Set(acceptance).size !== acceptance.length) defects.push('acceptance repeats an id')
  const parts = sections(body)
  const heads = (parts.get('## Acceptance') ?? []).map((line) => /^\s*[-*]\s+\(([^)]+)\)/.exec(line)?.[1]).filter(Boolean)
  if (acceptance.length && heads.join(' ') !== acceptance.join(' ')) defects.push(`the ## Acceptance items open with (${heads.join(') (') || 'none'}), not the frontmatter ids (${acceptance.join(') (')})`)
  // The driver binds issues off `#N` in the brief, so the only one allowed is the closing
  // line, and it promotes a Closes trailer only from that line under `## The ask`.
  if (!parts.has('## The ask')) defects.push('the body has a ## The ask section')
  const closing = body.split('\n').filter((line) => /^Closes #\d+$/.test(line.trim()))
  const want = Number.isInteger(fields.closes) ? `Closes #${fields.closes}` : null
  const inAsk = (parts.get('## The ask') ?? []).filter((line) => line === want)
  if (want && !(closing.length === 1 && inAsk.length === 1)) defects.push(`the ## The ask section carries the line "${want}" alone, exactly once`)
  if (!want && closing.length) defects.push('closes is null but the body carries a Closes line')
  const stray = body.split('\n').filter((line) => line.trim() !== want).join('\n').match(/#\d+/g)
  if (stray) defects.push(`the body names ${stray.join(', ')}; write "issue N" or "PR N" instead, so nothing but the Closes line binds an issue`)
  return { fields, body, defects }
}
