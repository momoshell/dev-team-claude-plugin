// E9: is a HALF-WRITTEN envelope (writer race) distinguishable from a
// genuinely malformed one? readEnvelopeFile (seat-io.mjs:1327-1349) has no
// settle window and no retry: the first read that lands mid-write is terminal.
import { mkdtempSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEnvelopeFile, cellFailureKind, reaskDecision } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/seat-io.mjs'

const dir = mkdtempSync(join(tmpdir(), 'lensB-e9-'))
const p = join(dir, 'd1.builder.json')
const full = JSON.stringify({ assignment_id: 'd1', role: 'builder', status: 'done', summary: 'a real turn', artifacts: [], details: { pr: '#1' } })

// A seat writing with a plain non-atomic open/write/write/close -- the shape any
// `Write` tool or `> file` redirection produces. The reader polls in between.
const fd = openSync(p, 'w')
writeSync(fd, full.slice(0, 40))
let first
try { readEnvelopeFile(p, { role: 'builder' }); first = 'parsed' }
catch (err) { first = { stage: err.stage, kind: cellFailureKind(err), terminal: true, msg: err.message.slice(0, 120) } }
writeSync(fd, full.slice(40))
closeSync(fd)
let second
try { second = { parsed: readEnvelopeFile(p, { role: 'builder' }) } } catch (err) { second = { stage: err.stage } }

console.log('read #1 (mid-write) :', JSON.stringify(first))
console.log('read #2 (complete)  :', JSON.stringify(second))
console.log('reask offered?      :', JSON.stringify(reaskDecision({ kind: 'unusable-envelope', transport: 'pane', surfaceId: 'sfc', alive: true, asked: false })))
console.log()
console.log('A half-written file and a permanently-broken file produce the SAME')
console.log('terminal stage. The wait does not re-read once before giving up, so a')
console.log('read that loses the race to a slow writer costs the turn one bounded')
console.log('re-ask (or, on a non-pane transport, the whole assignment).')
console.log()

// The two are byte-distinguishable in principle: a truncation ends inside the
// JSON grammar, so JSON.parse reports "Unexpected end of JSON input" / "Unterminated
// string", while a broken-escape defect reports "Bad control character".
const cases = [
  ['truncated mid-key', full.slice(0, 40)],
  ['truncated mid-value', full.slice(0, 70)],
  ['truncated at 1 byte', '{'],
  ['zero bytes', ''],
  ['raw newline in string (b52)', '{"summary":"a\nb"}'],
  ['trailing comma', '{"a":1,}'],
  ['single quotes', "{'a':1}"],
]
for (const [name, body] of cases) {
  writeFileSync(p, body)
  try { readEnvelopeFile(p); console.log(name.padEnd(30), 'PARSED') }
  catch (err) { console.log(name.padEnd(30), JSON.stringify(/read: (.*)$/.exec(err.message)?.[1] ?? err.message)) }
}
console.log()
console.log('=> V8 DOES separate them ("Unexpected end of JSON input"/"Unterminated string"')
console.log('   = truncation) but the reader keeps no such distinction: one stage for all.')
