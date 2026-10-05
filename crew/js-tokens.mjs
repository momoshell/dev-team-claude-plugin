// BLIND SPOT: block-closing } versus object-literal } cannot be distinguished by this tokenizer; a regex statement immediately after a block may be classified as division.
// lean: lexical-only brace disambiguation; upgrade to a parser if block/object regex syntax becomes required.
const keywords = new Set(['return', 'typeof', 'case', 'void', 'in', 'of', 'delete', 'throw', 'new', 'yield', 'await'])
const heads = new Set(['if', 'while', 'for', 'with'])
const operators = ['>>>=', '&&=', '||=', '??=', '===', '!==', '**=', '>>>', '<<=', '>>=', '?.', '=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '&=', '|=', '^=', '...']
export function tokenizeJs(source) {
  const tokens = []
  let i = 0, previous = null, beforePrevious = null, regexAllowed = true
  const parens = []
  const emit = (kind, start, end) => {
    end = Math.min(end, source.length)
    if (end > start) tokens.push({ kind, text: source.slice(start, end), start, end })
  }
  const significant = (kind, start, end, allowed) => {
    emit(kind, start, end)
    beforePrevious = previous
    previous = tokens.at(-1)
    regexAllowed = allowed
  }
  const walk = (interpolation = false) => {
    let braces = 0
    while (i < source.length) {
      const start = i, c = source[i], d = source[i + 1]
      if (interpolation && c === '}' && braces === 0) { significant('punctuator', i, ++i, false); return }
      if (/\s/u.test(c)) { i++; while (i < source.length && /\s/u.test(source[i])) i++; emit('whitespace', start, i); continue }
      if (c === '#' && d === '!' && start === 0) { i += 2; while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++; emit('comment', start, i); continue }
      if (c === '/' && (d === '/' || d === '*')) {
        i += 2
        if (d === '/') { while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++ }
        else { while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; if (i < source.length) i += 2 }
        emit('comment', start, i); continue
      }
      if (c === "'" || c === '"') {
        i++
        while (i < source.length) { if (source[i] === '\\') { i = Math.min(source.length, i + 2); continue } if (source[i++] === c) break }
        significant('string', start, i, false); continue
      }
      if (c === '`') {
        let chunkStart = i++
        while (i < source.length) {
          if (source[i] === '\\') { i = Math.min(source.length, i + 2); continue }
          if (source[i] === '`') { i++; significant('template', chunkStart, i, false); break }
          if (source[i] === '$' && source[i + 1] === '{') {
            const dollar = i
            emit('template', chunkStart, dollar)
            significant('punctuator', dollar, dollar + 2, true)
            i = dollar + 2
            walk(true)
            chunkStart = i
            continue
          }
          i++
        }
        if (i >= source.length && (tokens.at(-1)?.kind !== 'template' || tokens.at(-1)?.end !== i) && chunkStart < i) significant('template', chunkStart, i, false)
        continue
      }
      if (c === '/' && regexAllowed) {
        i++; let cls = false, esc = false
        while (i < source.length && source[i] !== '\n' && source[i] !== '\r') { const x = source[i++]; if (esc) esc = false; else if (x === '\\') esc = true; else if (x === '[') cls = true; else if (x === ']') cls = false; else if (x === '/' && !cls) break }
        while (i < source.length && /[a-z]/i.test(source[i])) i++
        significant('regex', start, i, false); continue
      }
      if (/[$_\p{ID_Start}]/u.test(c)) {
        i++; while (i < source.length && /[$_\u200c\u200d\p{ID_Continue}]/u.test(source[i])) i++
        const text = source.slice(start, i)
        const property = previous?.text === '.' || previous?.text === '?.'
        significant('name', start, i, !property && keywords.has(text)); continue
      }
      if (/[0-9]/.test(c)) { i++; while (i < source.length && /[\w.]/.test(source[i])) i++; significant('number', start, i, false); continue }
      const op = operators.find(x => source.startsWith(x, i)) || c
      i += op.length
      const head = c === '(' && previous?.kind === 'name' && heads.has(previous.text) && beforePrevious?.text !== '.' && beforePrevious?.text !== '?.'
      if (c === '(') parens.push(head)
      if (interpolation && c === '{') braces++
      else if (interpolation && c === '}') braces--
      significant('punctuator', start, i, c === ')' ? Boolean(parens.pop()) : c === '}' || c === ']' ? false : !['.', '?.', '++', '--'].includes(op))
    }
  }
  walk()
  return tokens
}
export function blankJsComments(source) {
  return tokenizeJs(source).map((token) => token.kind === 'comment' ? token.text.replace(/[^\r\n]/g, ' ') : token.text).join('')
}
