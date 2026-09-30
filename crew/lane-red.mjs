export const FAILURE_BLOCK_LINES = 40
export const FAILURE_BLOCK_BYTES = 2048
export const FAILURES_SECTION_BYTES = 12288

export function failingTestsSection(output) {
  const raw = typeof output === 'string' ? output : ''
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
  // lean: retain whole reporter output and entries; stream if output memory becomes material
  const entries = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const tap = /^\s*not ok \d+ - /.test(line)
    const spec = /^\s*✖ /.test(line)
    if (!tap && !spec) continue
    if (tap && /# TODO\b/i.test(line)) continue
    if (spec && /^\s*✖ failing tests:/.test(line)) continue
    const indent = line.match(/^\s*/)[0].length
    const block = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]
      if (next.trim() && next.match(/^\s*/)[0].length <= indent) break
      block.push(next)
    }
    while (block.length && !block.at(-1).trim()) block.pop()
    const kept = []
    let bytes = 0
    for (const diagnostic of block) {
      const size = Buffer.byteLength(diagnostic, 'utf8') + (kept.length ? 1 : 0)
      if (kept.length >= FAILURE_BLOCK_LINES || bytes + size > FAILURE_BLOCK_BYTES) break
      kept.push(diagnostic)
      bytes += size
    }
    const cut = block.length - kept.length
    entries.push([line, ...kept, ...(cut ? [`  [cut: ${cut} more diagnostic lines]`] : [])].join('\n'))
  }
  if (!entries.length) return { found: 0, omitted: 0, text: `no failing test line found in ${Buffer.byteLength(raw, 'utf8')} bytes of output` }
  const selected = []
  for (const entry of entries) {
    const left = entries.length - selected.length - 1
    const footer = left ? `\n[${left} more failing tests omitted: section bound ${FAILURES_SECTION_BYTES} bytes]` : ''
    if (Buffer.byteLength([...selected, entry].join('\n') + footer, 'utf8') > FAILURES_SECTION_BYTES) break
    selected.push(entry)
  }
  const omitted = entries.length - selected.length
  const omittedLine = omitted ? `[${omitted} more failing tests omitted: section bound ${FAILURES_SECTION_BYTES} bytes]` : ''
  return { found: entries.length, omitted, text: [...selected, ...(omittedLine ? [omittedLine] : [])].join('\n') }
}
