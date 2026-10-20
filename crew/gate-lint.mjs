// Blind spots, stated not closed: a test file the gate does not name by string literal is not linted; a named file absent at plan time (written later by the gate or the builder) is not linted; the gate's own console calls, including a probe body embedded in the gate source, never count.
import { join } from 'node:path'
export const GATE_LINT_RULES = Object.freeze(['vitest-console-observation', 'exact-refusal-list'])
const REFUSAL_NAME = /refus|error|reject|unsupported|violat/i
const EXACT_PATTERNS = [
  /assert_eq!\s*\(\s*([^,]+?)\s*,\s*(?:vec!\s*)?\[/,
  /\b(?:deepStrictEqual|deepEqual)\s*\(\s*([^,]+?)\s*,\s*\[/,
  /expect\s*\(\s*([^)]+?)\s*\)\s*\.\s*to(?:Strict)?Equal\s*\(\s*\[/,
  // reversed operand order for assert_eq!/deep*:
  /assert_eq!\s*\(\s*(?:vec!\s*)?\[[^\]]*\]\s*,\s*([^)]+?)\)/,
  /\b(?:deepStrictEqual|deepEqual)\s*\(\s*\[[^\]]*\]\s*,\s*([^)]+?)\)/,
]
const PRINTED = /(?:console\.(?:log|info|warn|error|debug)|process\.(?:stdout|stderr)\.write)\s*\(\s*['"`]([^'"`\n]+)['"`]/g
const NAMED_FILE = /['"`]([^'"`\s]+\.(?:test|spec)\.[a-z]+|[^'"`\s]+\.rs)['"`]/g
export function lintGate({ source, gateFile = 'gate.mjs', checkout = '', gateDir = '', readFile }) {
  const text = typeof source === 'string' ? source : ''
  const read = (p) => { try { const t = readFile(p); return typeof t === 'string' ? t : null } catch { return null } }
  const resolved = []
  const seen = new Set()
  for (const m of text.matchAll(new RegExp(NAMED_FILE.source, 'g'))) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    if (name.split('/').some((segment) => segment === '..')) continue
    const checkoutText = read(join(checkout, name))
    if (checkoutText !== null) {
      resolved.push({ name, text: checkoutText, origin: 'checkout' })
      continue
    }
    const gateDirText = read(join(gateDir, name))
    if (gateDirText !== null) resolved.push({ name, text: gateDirText, origin: 'gate-dir' })
  }
  const findings = []
  // lean: line-based regex scan, no AST; multiline assertions and computed list literals are missed — upgrade path is a real parser per language
  const globalExact = EXACT_PATTERNS.map((p) => new RegExp(p.source, 'g'))
  const CONSTANT = /^(?:\[\s*\.\.\.\s*)?[A-Z][A-Z0-9_]*\b/
  const scanExact = (file, body) => {
    const lines = String(body).split('\n')
    lines.forEach((line, idx) => {
      globalExact.forEach((re, pi) => {
        re.lastIndex = 0
        for (const m of line.matchAll(re)) {
          const expr = (m[1] ?? '').trim()
          if (!REFUSAL_NAME.test(expr)) continue
          if (CONSTANT.test(expr)) continue
          let empty = false
          if (pi <= 2) {
            const after = line.slice((m.index ?? 0) + m[0].length)
            const close = after.indexOf(']')
            if (close >= 0 && after.slice(0, close).trim() === '') empty = true
          } else {
            const b = m[0].match(/\[([^\]]*)\]/)
            if (b && b[1].trim() === '') empty = true
          }
          if (empty) continue
          findings.push({ rule: 'exact-refusal-list', file, line: idx + 1, why: 'exact-equality assertion on ' + expr + ' against a list literal; assert containment instead' })
        }
      })
    })
  }
  scanExact(gateFile, text)
  for (const r of resolved) {
    if (r.origin !== 'gate-dir') continue
    scanExact(r.name, r.text)
  }
  const invokesVitest = /\bvitest\b/.test(source)
  if (invokesVitest) {
    const printedRe = new RegExp(PRINTED.source, 'g')
    for (const r of resolved) {
      const lines = String(r.text).split('\n')
      lines.forEach((line, idx) => {
        printedRe.lastIndex = 0
        const perLine = new RegExp(PRINTED.source, 'g')
        for (const m of line.matchAll(perLine)) {
          const literal = (m[1] ?? '').trim()
          if (literal.length < 3) continue
          const token = literal.split(/\s+/)[0] ?? ''
          if (token.length < 3) continue
          const coupled = text.includes("'" + token) || text.includes('"' + token) || text.includes('`' + token) || text.includes('/^' + token)
          if (!coupled) continue
          findings.push({ rule: 'vitest-console-observation', file: r.name, line: idx + 1, why: "gate matches console output '" + literal + "' printed by a passing vitest test; reporters drop it" })
        }
      })
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)))
  return findings
}
