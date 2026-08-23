// A9: the "declare every hit" line the brief tells the seat to RUN is built by
// string concatenation into a double-quoted shell word joined with BRE `\|`
// (make-brief.mjs generatedGrep). Keys can legally contain `.` (a BRE wildcard)
// and `$` (a shell expansion).
import { extractKeys, extractSymbols, renderBrief } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs'
const src = [
  'export const $HOME$secret = 1',
  'export function widgetHelper() {}',
  "const e = 'bad-input'",
  "const p = 'lib/a.b.mjs'",
].join('\n')
console.log('extractSymbols:', JSON.stringify(extractSymbols(src, 'lib/x.mjs')))
console.log('extractKeys   :', JSON.stringify(extractKeys(src, 'lib/x.mjs')))
const brief = renderBrief({
  request: { ask: 'rename the widget helper', done_means: 'green', out_of_scope: 'none' },
  where: [{ path: 'lib/x.mjs', kind: 'file' }],
  discovery: { candidates: ['lib/x.mjs'], tripwires: [], broadKeys: [], coupled: [], keys: extractKeys(src, 'lib/x.mjs') },
})
console.log('rendered command:')
console.log('  ' + brief.split('\n').find((l) => l.startsWith('declare every hit')))
