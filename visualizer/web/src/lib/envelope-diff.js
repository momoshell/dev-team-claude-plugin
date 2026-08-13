const FIELDS = ['status', 'summary', 'artifacts', 'details']

function primitive(value) { return value === null || typeof value !== 'object' }
function equal(a, b) {
  if (primitive(a) && primitive(b)) return Object.is(a, b)
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function walk(path, from, to, changes) {
  const missingFrom = from === undefined, missingTo = to === undefined
  if (missingFrom || missingTo) {
    const value = missingFrom ? to : from
    if (value && typeof value === 'object') {
      const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value).sort()
      if (!keys.length) changes.push({ path, from: missingFrom ? undefined : from, to: missingTo ? undefined : to, change: missingFrom ? 'added' : 'removed' })
      for (const key of keys) walk(Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, missingFrom ? undefined : value[key], missingTo ? undefined : value[key], changes)
    } else changes.push({ path, from: missingFrom ? undefined : from, to: missingTo ? undefined : to, change: missingFrom ? 'added' : 'removed' })
    return
  }
  if (equal(from, to)) return
  if (from && to && typeof from === 'object' && typeof to === 'object' && Array.isArray(from) === Array.isArray(to)) {
    if (Array.isArray(from)) {
      for (let i = 0; i < Math.max(from.length, to.length); i += 1) walk(`${path}[${i}]`, from[i], to[i], changes)
    } else {
      for (const key of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) walk(path ? `${path}.${key}` : key, from[key], to[key], changes)
    }
    return
  }
  changes.push({ path, from, to, change: 'changed' })
}

export function diffEnvelopes(previous, current) {
  const changes = []
  for (const key of FIELDS) walk(key, previous?.[key], current?.[key], changes)
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

export function attemptPairs(envelopes = []) {
  const previous = new Map(), pairs = []
  for (const envelope of [...envelopes].sort((a, b) => (a.dispatch_seq ?? 0) - (b.dispatch_seq ?? 0))) {
    if (previous.has(envelope.role)) pairs.push({ role: envelope.role, previous: previous.get(envelope.role), current: envelope })
    previous.set(envelope.role, envelope)
  }
  return pairs
}
