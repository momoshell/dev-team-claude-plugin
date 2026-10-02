export const FAILURE_BLOCK_LINES = 40
export const FAILURE_BLOCK_BYTES = 2048
export const FAILURES_SECTION_BYTES = 12288

export function dropPassingLines(text) {
  const raw = typeof text === 'string' ? text : ''
  // lean: retain one reporter output; stream segments if test-output volume becomes material
  const segments = raw.match(/[^\n]*\n|[^\n]+$/g) || []
  const remove = new Set()
  const suites = new Map()
  const subtests = new Map()
  const plainAt = (index) => segments[index].replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n$/, '')
  for (let i = 0; i < segments.length; i += 1) {
    const plain = plainAt(i)
    const indent = plain.match(/^\s*/)[0].length
    const suite = /^\s*▶ /.test(plain)
    if (suite) suites.set(indent, i)
    const subtest = /^\s*# Subtest:/.test(plain)
    if (subtest) subtests.set(indent, i)
    if (/^\s*✔ /.test(plain)) remove.add(i)
    if (/^\s*✔ /.test(plain)) {
      if (suites.has(indent)) { remove.add(suites.get(indent)); suites.delete(indent) }
      if (subtests.has(indent)) subtests.delete(indent)
    }
    if (/^\s*ok \d+(?:\s|$)/.test(plain)) {
      remove.add(i)
      if (subtests.has(indent)) { remove.add(subtests.get(indent)); subtests.delete(indent) }
      let yamlEnd = -1
      let yamlStarted = false
      for (let k = i + 1; k < segments.length; k += 1) {
        const yaml = plainAt(k)
        const yamlIndent = yaml.match(/^\s*/)[0].length
        if (yaml.trim() && yamlIndent <= indent) break
        if (yamlIndent > indent && /^\s*---$/.test(yaml)) yamlStarted = true
        if (yamlStarted && yamlIndent > indent && /^\s*\.\.\.$/.test(yaml)) { yamlEnd = k; break }
      }
      if (yamlEnd >= 0) for (let k = i + 1; k <= yamlEnd; k += 1) remove.add(k)
    }
    if (/^\s*not ok \d+(?:\s|$)/.test(plain)) subtests.delete(indent)
  }
  return segments.filter((_, index) => !remove.has(index)).join('')
}

const titleHasLabel = (title, labels) => labels.some((label) => {
  let from = 0
  while (from <= title.length - label.length) {
    const index = title.indexOf(label, from)
    if (index < 0) return false
    const before = title[index - 1], after = title[index + label.length]
    if ((!before || !/[A-Za-z0-9._-]/.test(before)) && (!after || !/[A-Za-z0-9._-]/.test(after))) return true
    from = index + 1
  }
  return false
})

export function failingTestsSection(output, labels = null) {
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
    const title = line.replace(/^\s*(?:not ok \d+ - |✖\s+)/, '')
    if (labels !== null && !titleHasLabel(title, labels)) continue
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
      if (kept.length >= FAILURE_BLOCK_LINES || bytes + size > FAILURE_BLOCK_BYTES) {
        if (labels !== null && kept.length < FAILURE_BLOCK_LINES) {
          const available = FAILURE_BLOCK_BYTES - bytes - (kept.length ? 1 : 0)
          if (available > 0) {
            const prefix = Buffer.from(diagnostic).subarray(0, available).toString().replace(/�$/, '')
            if (prefix) {
              kept.push(prefix)
              bytes += Buffer.byteLength(prefix, 'utf8') + (kept.length > 1 ? 1 : 0)
            }
          }
        }
        break
      }
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

export function labelledFailures(output, labels) {
  return failingTestsSection(output, Array.isArray(labels) ? labels : [])
}

export function stepFailureDiagnostics(io, labels, steps, shellArg) {
  if (!Array.isArray(labels) || !labels.length) return ''
  const paths = []
  for (const step of Array.isArray(steps) ? steps : []) {
    for (const path of Array.isArray(step?.files_in_scope) ? step.files_in_scope : []) {
      if (typeof path === 'string' && /\.test\.(?:mjs|js|ts)$/.test(path) && !paths.includes(path)) paths.push(path)
    }
  }
  if (!paths.length) return ''
  const command = `node --test --test-reporter=tap ${paths.map((path) => shellArg(path)).join(' ')}`
  try {
    const result = io.run(command)
    if (typeof result?.output !== 'string') return '\ndiagnostics unavailable: test command returned non-text output'
    const labelled = labelledFailures(result.output, labels)
    const failures = labelled.found ? labelled : failingTestsSection(result.output)
    if (labelled.found) return `\nFailing tests titled with ${labels.join(', ')} (${failures.found} found):\n${failures.text}`
    return `\nFailing tests (none titled with ${labels.join(', ')}; ${failures.found} found):\n${failures.text}`
  } catch (error) {
    return `\ndiagnostics unavailable: ${error?.message || String(error)}`
  }
}
