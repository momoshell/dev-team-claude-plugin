export function diffLineKind(line) {
  const value = String(line || '')
  if (/^(diff --git |index |--- |\+\+\+ |@@ |\\ No newline)/.test(value)) return 'meta'
  if (value.startsWith('+')) return 'addition'
  if (value.startsWith('-')) return 'removal'
  return 'context'
}

export function diffLines(text, empty = '(no change)') {
  return String(text || empty).split('\n').map((line) => ({ text:line, kind:diffLineKind(line) }))
}
