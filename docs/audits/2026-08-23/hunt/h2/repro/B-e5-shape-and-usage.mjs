// E5: what the downstream shape checks admit, and what the usage folders do
// with hostile numbers.
import { envelopeDefect } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/drive.mjs'
import { foldUsage, recogniseProviderCondition, classifyRun } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless.mjs'
import { foldRpcUsage, carriesOwnSpend, emptyTurnEnvelope, isBusyRefusal } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/headless-rpc.mjs'

const line = (l, v) => console.log(l.padEnd(40), JSON.stringify(v))

console.log('--- envelopeDefect: wrong types that pass truthiness ---')
const base = { status: 'done', summary: 's', artifacts: [], details: {} }
for (const [n, patch] of [
  ['baseline', {}],
  ['status:1', { status: 1 }],
  ['status:{}', { status: {} }],
  ['status:["done"]', { status: ['done'] }],
  ['status missing', { status: undefined }],
  ['artifacts:"a.md"', { artifacts: 'a.md' }],
  ['summary:0', { summary: 0 }],
  ['summary:"   "', { summary: '   ' }],
  ['details:null', { details: null }],
  ['details:[]', { details: [] }],
  ['details:"x"', { details: 'x' }],
  ['artifacts:[null]', { artifacts: [null] }],
]) line(n, envelopeDefect({ ...base, ...patch }, null))
console.log('NOTE: envelopeDefect never checks env.status at all (drive.mjs:634-671).')

console.log('\n--- emptyTurnEnvelope passes every shape check ---')
line('defect', envelopeDefect(emptyTurnEnvelope({ id: 'd1', role: 'builder', returnPath: '/tmp/x' }), null))

console.log('\n--- foldUsage: hostile token numbers ---')
line('1e308 result', foldUsage(JSON.stringify({ type: 'result', usage: { input_tokens: 1e308, output_tokens: 1e308 } })))
line('two 1e308 assistants -> Infinity?', foldUsage([
  JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { input_tokens: 1e308 } } }),
  JSON.stringify({ type: 'assistant', message: { id: 'b', usage: { input_tokens: 1e308 } } }),
].join('\n')))
line('string tokens "500"', foldUsage(JSON.stringify({ type: 'result', usage: { input_tokens: '500', output_tokens: '250' } })))
line('negative tokens', foldUsage(JSON.stringify({ type: 'result', usage: { input_tokens: -900 } })))
line('9007199254740993', foldUsage('{"type":"result","usage":{"input_tokens":9007199254740993}}'))
line('usage array', foldUsage(JSON.stringify({ type: 'result', usage: [1, 2] })))
line('__proto__ message id', foldUsage(JSON.stringify({ type: 'assistant', message: { id: '__proto__', usage: { input_tokens: 7 } } })))

console.log('\n--- foldRpcUsage ---')
line('1e308', foldRpcUsage([{ type: 'message_end', message: { role: 'assistant', usage: { input: 1e308 } } }, { type: 'message_end', message: { role: 'assistant', usage: { input: 1e308 } } }]))
line('string usage', foldRpcUsage([{ type: 'message_end', message: { role: 'assistant', usage: { input: '90' } } }]))
line('carriesOwnSpend role via proto', carriesOwnSpend({ type: 'message_end', message: Object.create({ role: 'assistant' }) }))
line('carriesOwnSpend toolResult', carriesOwnSpend({ type: 'message_end', message: { role: 'toolResult' } }))

console.log('\n--- recogniseProviderCondition: false positives ---')
for (const s of [
  'Error: something failed\n    at /repo/crew/drive.mjs:401:12',
  'gate summary: 429 checks passed',
  'wrote 401 bytes to disk',
  'HTTP/1.1 200 OK',
  'the file /tmp/x-403-y.log is gone',
  'model returned overloaded_error',
  'req took 429 ms',
  'rate limit',
  'x'.repeat(1_000_000) + ' 429 ',
]) line(JSON.stringify(s).slice(0, 56), recogniseProviderCondition(s))
line('non-string 429', recogniseProviderCondition(429))
line('array', recogniseProviderCondition(['429']))

console.log('\n--- classifyRun with a NON-OBJECT envelope ---')
for (const e of [true, 0, '', 'done', [], {}, null]) {
  line(`envelope=${JSON.stringify(e)}`, classifyRun({ exitCode: 0, signal: null, terminal: true, sawJson: true, envelope: e, timedOut: false }))
}

console.log('\n--- isBusyRefusal ---')
for (const f of [
  { success: false, error: 'Agent is already processing.' },
  { success: false, error: { message: 'already processing' } },
  { success: false, error: null },
  { success: 0, error: 'already processing' },
]) line(JSON.stringify(f), isBusyRefusal(f))
