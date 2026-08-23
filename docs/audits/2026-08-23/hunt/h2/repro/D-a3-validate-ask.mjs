// A3: what validateAsk lets through / refuses.
import { validateAsk, validateRequest } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
const task = 'b99-widget-rename'
const cases = [
  ['punctuation only',            '.,;:!?()[]{}<>-_=+*/'],
  ['a.b.c (3 one-char tokens)',   '...a.b.c...'],
  ['one word repeated 3x',        'the the the'],
  ['whitespace-only after trim',  '   \t\n  '],
  ['newlines only',               '\n\n\n\n'],
  ['zero-width x50',              '​'.repeat(50)],
  ['combining marks x50',         'a' + '́'.repeat(50)],   // 1 token
  ['zero-width joined 3 letters', 'a​b​c'],
  ['one giant token 100k',        'a'.repeat(100_000)],
  ['10000 words',                 Array.from({ length: 10_000 }, (_, i) => `w${i}`).join(' ')],
  ['url only',                    'https://example.com/widget/rename/now'],
  ['code fence only',             '```js\nconst rename = widget()\n```'],
  ['emoji only',                  '\u{1f600}\u{1f680}\u{1f4a5}'],
  ['CJK only',                    '小猫大'],
  ['restates heading',            'widget rename b99'],
  ['heading + 1 new token',       'widget rename b99 quickly'],
]
for (const [label, ask] of cases) {
  try {
    validateAsk(ask, task)
    console.log(`ACCEPTED  ${label.padEnd(28)} len=${ask.length}`)
  } catch (err) { console.log(`refused   ${label.padEnd(28)} -> ${err.reason}`) }
}
console.log('---- validateRequest extras ----')
const base = { ask: 'rename the widget helper', where: ['a.mjs'], done_means: 'x y', out_of_scope: 'z' }
const probes = [
  ['unknown extra key',   { ...base, issue: 42 }],
  ['where empty',         { ...base, where: [] }],
  ['where 100000 dupes',  { ...base, where: Array(100_000).fill('a.mjs') }],
  ['where duplicates',    { ...base, where: ['a.mjs', 'a.mjs', 'a.mjs'] }],
  ['prototype-poison',    JSON.parse('{"ask":"rename the widget helper","where":["a.mjs"],"done_means":"x y","out_of_scope":"z","__proto__":{"polluted":1}}')],
  ['ask = String object', { ...base, ask: new String('rename the widget helper') }],
]
for (const [label, req] of probes) {
  try { validateRequest(req, { taskName: task }); console.log(`ACCEPTED  ${label}`) }
  catch (err) { console.log(`refused   ${label} -> ${err.reason}`) }
}
console.log('({}).polluted after proto probe =', ({}).polluted)
