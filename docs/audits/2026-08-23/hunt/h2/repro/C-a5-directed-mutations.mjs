// A5: parseDirectedBrief / validateMutations / checkFailureLine / validateCarve
const ROOT = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2'
const { parseDirectedBrief, validateMutations, checkFailureLine, validateCarve, scopeMatcher, MUTATIONS_MAX } =
  await import(`${ROOT}/repo/crew/drive.mjs`)

const B = (body) => ['# Task', '', '```directed', body, '```', ''].join('\n')
const show = (label, text) => {
  let r
  try { r = parseDirectedBrief(text) } catch (e) { r = { THREW: e.message } }
  console.log(label.padEnd(34), r.defect ? 'DEFECT: ' + String(r.defect).slice(0, 78) : r.THREW ? 'THREW ' + r.THREW : 'ACCEPT ' + JSON.stringify({ gate_cmd: r.gate_cmd, files_in_scope: r.files_in_scope }))
}

console.log('=== parseDirectedBrief ===')
show('happy', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}'))
show('CRLF brief', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}').replaceAll('\n', '\r\n'))
show('indented fence', ['# t', '   ```directed', '{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}', '   ```'].join('\n'))
show('fence w/ trailing space', ['# t', '```directed ', '{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}', '```'].join('\n'))
show('DUPLICATE gate_cmd key', B('{"gate_cmd":"safe-gate","files_in_scope":["a/b.mjs"],"gate_cmd":"rm -rf /"}'))
show('DUPLICATE files_in_scope', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs"],"files_in_scope":["crew/drive.mjs"]}'))
show('__proto__ key', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs"],"__proto__":{"x":1}}'))
show('null block', B('null'))
show('array block', B('[1]'))
show('no block', '# t\n\nnothing here')
show('two blocks', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}') + B('{"gate_cmd":"h","files_in_scope":["c/d.mjs"]}'))
show('unclosed', '# t\n```directed\n{"gate_cmd":"g"}\n')
show('4-backtick close', ['# t', '```directed', '{"gate_cmd":"g","files_in_scope":["a/b.mjs"]}', '````'].join('\n'))
show('gate_cmd whitespace', B('{"gate_cmd":"   ","files_in_scope":["a/b.mjs"]}'))
show('scope with ..', B('{"gate_cmd":"g","files_in_scope":["a/../../etc/passwd"]}'))
show('scope top-level dir', B('{"gate_cmd":"g","files_in_scope":["crew/"]}'))
show('scope whitespace-only', B('{"gate_cmd":"g","files_in_scope":["   "]}'))
show('scope trailing space', B('{"gate_cmd":"g","files_in_scope":["a/b.mjs "]}'))
{ const r = parseDirectedBrief(B(JSON.stringify({ gate_cmd: 'g', files_in_scope: Array.from({ length: 5000 }, (_, i) => `p/f${i}.mjs`) }))); console.log('scope 5000 entries'.padEnd(34), r.defect ? 'DEFECT' : 'ACCEPT (' + r.files_in_scope.length + ' entries, no cap)') }
show('scope not array', B('{"gate_cmd":"g","files_in_scope":"a/b.mjs"}'))
show('gate_cmd leading ws kept?', B('{"gate_cmd":"  g  ","files_in_scope":["a/b.mjs"]}'))
show('empty brief', '')
show('non-string brief', 42)

console.log('\n=== validateMutations ===')
const inScope = scopeMatcher(['a.mjs', 'a.test.mjs', 'tasks/x/captures/'])
const M = (o) => ({ check: 'c1', file: 'a.mjs', find: 'x', replace: 'y', ...o })
const m = (label, entries, scope = inScope) => {
  let r
  try { r = validateMutations(entries, scope) } catch (e) { r = 'THREW: ' + e.message }
  console.log(label.padEnd(38), Array.isArray(r) ? (r.length ? 'REJECT: ' + r[0].why.slice(0, 64) : 'ACCEPT') : r)
}
m('happy', [M()])
m('exempt happy', [{ check: 'c1', exempt: 'n/a' }])
m('exempt + find', [{ check: 'c1', exempt: 'n/a', find: 'x' }])
m('exempt + file', [{ check: 'c1', exempt: 'n/a', file: 'a.mjs' }])
m('exempt + replace', [{ check: 'c1', exempt: 'n/a', replace: 'y' }])
m('exempt false', [{ check: 'c1', exempt: false }])
m('exempt blank', [{ check: 'c1', exempt: '  ' }])
m('empty find', [M({ find: '' })])
m('missing find', [M({ find: undefined })])
m('find===replace', [M({ find: 'x', replace: 'x' })])
m('replace missing', [M({ replace: undefined })])
m('file out of scope', [M({ file: 'b.mjs' })])
m('file with ..', [M({ file: 'tasks/x/captures/../../../etc/passwd' })])
m('file with ....//', [M({ file: 'tasks/x/captures/....//....//etc/passwd' })])
m('file trailing slash', [M({ file: 'tasks/x/captures/' })])
m('file trailing space', [M({ file: 'a.mjs ' })])
m('file absolute', [M({ file: '/etc/passwd' })])
m('file backslash', [M({ file: 'a\\mjs' })])
m('file under dir prefix', [M({ file: 'tasks/x/captures/1.md' })])
m('NO inScope arg (default true)', [M({ file: 'crew/drive.mjs' })], undefined)
m('duplicate check', [M(), M({ file: 'a.test.mjs' })])
m('check with space', [M({ check: 'c 1' })])
m('check with colon', [M({ check: 'c:1' })])
m('check regex meta', [M({ check: 'c.*1' })])
m('check leading underscore', [M({ check: '_c1' })])
m('check __proto__', [M({ check: '__proto__' })])
m('check constructor', [M({ check: 'constructor', file: 'a.mjs' })])
m('check empty', [M({ check: '' })])
m('check non-string', [M({ check: 42 })])
m('entry null', [null])
m('entry array', [[]])
m('entries not array', 'x')
m('over MUTATIONS_MAX', Array.from({ length: MUTATIONS_MAX + 1 }, (_, i) => M({ check: `c${i}` })))
m('exactly MUTATIONS_MAX', Array.from({ length: MUTATIONS_MAX }, (_, i) => M({ check: `c${i}` })))

console.log('\n=== checkFailureLine (exact-token?) ===')
const cases = [
  ['FAIL cache', 'cache', true], ['FAIL cache-v2', 'cache', false], ['FAIL cache-v2', 'cache-v2', true],
  ['FAIL cache: why', 'cache', true], ['FAIL cache:why', 'cache', false], ['FAIL cache:v2: why', 'cache', false],
  ['FAIL cache.v2', 'cache', false], ['FAIL cache ', 'cache', true], ['  FAIL cache  ', 'cache', true],
  ['FAIL cache why', 'cache', false], ['FAIL cache\twhy', 'cache', false], ['xFAIL cache', 'cache', false],
  ['fail cache', 'cache', false], ['FAIL  cache', 'cache', false], ['FAILcache', 'cache', false],
  ['FAIL cache:', 'cache', true], ['FAIL cache —why', 'cache', false],
  ['prefix FAIL cache', 'cache', false],
  ['FAIL c1\nFAIL c2', 'c2', true],
]
for (const [out, check, want] of cases) {
  const got = checkFailureLine(out, check)
  console.log(JSON.stringify(out).padEnd(24), 'check=' + JSON.stringify(check).padEnd(12), 'got=' + String(got).padEnd(6), 'expect=' + String(want), got === want ? '' : '   <<< MISMATCH')
}

console.log('\n=== validateCarve ===')
const c = (label, d) => { let r; try { r = validateCarve(d) } catch (e) { r = 'THREW: ' + e.message }; console.log(label.padEnd(36), JSON.stringify(r)) }
c('proceed', { carve_verdict: 'proceed' })
c('carve happy', { carve_verdict: 'carve', carve_slices: [{ summary: 's', files_in_scope: ['a/b.mjs'] }] })
c('carve slice0 bad scope', { carve_verdict: 'carve', carve_slices: [{ summary: 's', files_in_scope: ['../x'] }] })
c('carve slice1 bad scope DROPPED', { carve_verdict: 'carve', carve_slices: [{ summary: 's', files_in_scope: ['a/b.mjs'] }, { summary: 't', files_in_scope: ['../x'] }] })
c('carve ALL slices bad but not 0', { carve_verdict: 'carve', carve_slices: [{ summary: 's', files_in_scope: ['a/b.mjs'] }, { summary: 't', files_in_scope: ['crew/'] }, { summary: 'u', files_in_scope: ['/abs'] }] })
c('carve slices empty', { carve_verdict: 'carve', carve_slices: [] })
c('carve verdict missing', {})
c('carve verdict null', { carve_verdict: null })
c('carve slices whitespace scope', { carve_verdict: 'carve', carve_slices: [{ summary: 's', files_in_scope: ['   '] }] })
c('carve slices not array', { carve_verdict: 'carve', carve_slices: 'x' })
c('details null', null)
