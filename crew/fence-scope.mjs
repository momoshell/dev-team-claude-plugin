// crew/fence-scope.mjs — import-free line-span fence grammar.

const GLOB_META = /[*?\[\]{}]/
const SPAN_SUFFIX = /^(.*):([0-9]+)-([0-9]+)$/

const display = (entry) => {
  try { return JSON.stringify(entry) } catch { return String(entry) }
}

const invalid = (entry, reason) => Object.freeze({ kind: 'invalid', entry, path: null, reason })

function pathReason(path) {
  if (typeof path !== 'string' || path.length === 0) return 'path is empty'
  if (GLOB_META.test(path)) return 'glob patterns are not supported'
  if (path.startsWith('/') || path.includes('\\')) return 'path must be repo-relative'
  if (path.includes('\0')) return 'path contains a NUL byte'
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return 'path must not contain . or .. segments'
  return null
}

// A fence is either a legacy whole path or one closed `path:START-END` span.
// Colons are reserved for the span suffix, so a colon-bearing shape that does
// not match the complete suffix is an invalid fence rather than a whole path.
export function parseFenceScope(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return invalid(entry, 'empty or non-string fence entry')
  const match = SPAN_SUFFIX.exec(entry)
  if (!match && entry.includes(':')) return invalid(entry, 'expected path:START-END')
  if (!match) {
    const reason = pathReason(entry)
    return reason ? invalid(entry, reason) : Object.freeze({ kind: 'file', entry, path: entry })
  }
  const path = match[1]
  const reason = pathReason(path)
  if (reason) return invalid(entry, reason)
  if (path.includes(':')) return invalid(entry, 'path must not contain a colon')
  if (match[2].startsWith('0') || match[3].startsWith('0')) return invalid(entry, 'span bounds must be positive decimal integers')
  if (!Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) return invalid(entry, 'span bounds must be safe integers')
  return Object.freeze({ kind: 'span', entry, path, start: Number(match[2]), end: Number(match[3]) })
}

export function validateFenceScope(entry, lineCount) {
  const parsed = parseFenceScope(entry)
  if (parsed.kind !== 'span') return parsed
  if (!Number.isSafeInteger(lineCount) || lineCount < 0) {
    return { ...parsed, reason: `base line count is unreadable or not a non-negative integer: ${display(lineCount)}` }
  }
  if (parsed.start > parsed.end) return { ...parsed, reason: `span start ${parsed.start} is after end ${parsed.end}` }
  if (parsed.end > lineCount) return { ...parsed, reason: `span end ${parsed.end} is past base EOF ${lineCount}` }
  return parsed
}

export function fenceScopesIntersect(left, right) {
  if (!left || !right || left.path === null || right.path === null) return false
  if (left.path !== right.path) return false
  if (left.kind === 'file' || right.kind === 'file') return true
  if (left.kind !== 'span' || right.kind !== 'span') return false
  return left.start <= right.end && right.start <= left.end
}

export function fenceScopeContains(scope, hunk) {
  if (!scope || !hunk || scope.path === null || hunk.path === null || scope.path !== hunk.path) return false
  if (scope.kind === 'file') return true
  if (scope.kind !== 'span' || hunk.kind !== 'span') return false
  return scope.start <= hunk.start && hunk.end <= scope.end
}
