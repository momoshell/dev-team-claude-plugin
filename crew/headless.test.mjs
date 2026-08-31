import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyRun, foldUsage, headlessIo, parseStream, recogniseProviderCondition, recogniseSeatRefusal,
  SEAT_REFUSALS, SEAT_REFUSAL_ACTIONS, UNCLASSIFIED_REFUSAL, shq, updateCrewJson,
} from './headless.mjs'
import { cellFailureKind } from './seat-io.mjs'
import { startFileWriter } from '../test/helpers.mjs'

// The final three bytes of each real 2026-08-30 refusal tail, copied
// byte-for-byte so classification is adjudicated against the provider's own
// stream shape rather than a synthetic approximation.
const B332_D2_TAIL = Buffer.from('eyJ0eXBlIjoicmF0ZV9saW1pdF9ldmVudCIsInJhdGVfbGltaXRfaW5mbyI6eyJzdGF0dXMiOiJyZWplY3RlZCIsInJlc2V0c0F0IjoxNzg4MTE1MjAwLCJyYXRlTGltaXRUeXBlIjoiZml2ZV9ob3VyIiwib3ZlcmFnZVN0YXR1cyI6InJlamVjdGVkIiwib3ZlcmFnZURpc2FibGVkUmVhc29uIjoib3JnX2xldmVsX2Rpc2FibGVkIiwiaXNVc2luZ092ZXJhZ2UiOmZhbHNlLCJ1bmlmaWVkV2luZG93cyI6eyJmaXZlX2hvdXIiOnsidXRpbGl6YXRpb24iOjEsInJlc2V0c0F0IjoxNzg4MTE1MjAwfSwic2V2ZW5fZGF5Ijp7InV0aWxpemF0aW9uIjowLjMxLCJyZXNldHNBdCI6MTc4ODU2NjQwMH19fSwidXVpZCI6IjJjMmYyOWI2LWEyNjctNDE5OS1iNTgzLTAxNmEwOGMzNmRkYyIsInNlc3Npb25faWQiOiI0MmJhNjFhMC0wYTQ4LTRlZWYtOGMzMy1lN2FiNDUyMzgxNzEifQp7InR5cGUiOiJhc3Npc3RhbnQiLCJtZXNzYWdlIjp7ImRpYWdub3N0aWNzIjpudWxsLCJpZCI6IjlkZWI5MGNhLWMwYmItNDQyZS1hZmFmLTdjNDU5MGJlMGEyMiIsImNvbnRhaW5lciI6bnVsbCwibW9kZWwiOiI8c3ludGhldGljPiIsInJvbGUiOiJhc3Npc3RhbnQiLCJzdG9wX2RldGFpbHMiOm51bGwsInN0b3BfcmVhc29uIjoic3RvcF9zZXF1ZW5jZSIsInN0b3Bfc2VxdWVuY2UiOiIiLCJ0eXBlIjoibWVzc2FnZSIsInVzYWdlIjp7Im91dHB1dF90b2tlbnNfZGV0YWlscyI6bnVsbCwiaW5wdXRfdG9rZW5zIjowLCJvdXRwdXRfdG9rZW5zIjowLCJjYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMiOjAsImNhY2hlX3JlYWRfaW5wdXRfdG9rZW5zIjowLCJzZXJ2ZXJfdG9vbF91c2UiOnsid2ViX3NlYXJjaF9yZXF1ZXN0cyI6MCwid2ViX2ZldGNoX3JlcXVlc3RzIjowfSwic2VydmljZV90aWVyIjpudWxsLCJjYWNoZV9jcmVhdGlvbiI6eyJlcGhlbWVyYWxfMWhfaW5wdXRfdG9rZW5zIjowLCJlcGhlbWVyYWxfNW1faW5wdXRfdG9rZW5zIjowfSwiaW5mZXJlbmNlX2dlbyI6bnVsbCwiaXRlcmF0aW9ucyI6bnVsbCwic3BlZWQiOm51bGx9LCJjb250ZW50IjpbeyJ0eXBlIjoidGV4dCIsInRleHQiOiJZb3UndmUgaGl0IHlvdXIgc2Vzc2lvbiBsaW1pdCDCtyByZXNldHMgODo0MHBtIChFdXJvcGUvQmVsZ3JhZGUpIn1dLCJjb250ZXh0X21hbmFnZW1lbnQiOm51bGx9LCJwYXJlbnRfdG9vbF91c2VfaWQiOm51bGwsInNlc3Npb25faWQiOiI0MmJhNjFhMC0wYTQ4LTRlZWYtOGMzMy1lN2FiNDUyMzgxNzEiLCJ1dWlkIjoiMzAzOGY2MDAtYTliOS00NmZlLWJkZWEtZTFlOGJhYjVhYjExIiwidGltZXN0YW1wIjoiMjAyNi0wOC0zMFQxNzoyNjozMC4xMjFaIiwiZXJyb3IiOiJyYXRlX2xpbWl0IiwicmVxdWVzdF9pZCI6InJlcV8wMTFDZVpLb0xBYTlRdkJNNjZGaVNacmkiLCJpc19hcGlfZXJyb3JfbWVzc2FnZSI6dHJ1ZX0KeyJkdXJhdGlvbl9hcGlfbXMiOjE1MzU5Mywic3RvcF9yZWFzb24iOiJzdG9wX3NlcXVlbmNlIiwic2Vzc2lvbl9pZCI6IjQyYmE2MWEwLTBhNDgtNGVlZi04YzMzLWU3YWI0NTIzODE3MSIsInRvdGFsX2Nvc3RfdXNkIjozLjc4ODA4Mzk5OTk5OTk5OTYsInVzYWdlIjp7ImlucHV0X3Rva2VucyI6MjAsImNhY2hlX2NyZWF0aW9uX2lucHV0X3Rva2VucyI6MjM0MDIxLCJjYWNoZV9yZWFkX2lucHV0X3Rva2VucyI6MjIwMjU5OCwib3V0cHV0X3Rva2VucyI6MTM4NTksIm91dHB1dF90b2tlbnNfZGV0YWlscyI6eyJ0aGlua2luZ190b2tlbnMiOjUyNjN9LCJzZXJ2ZXJfdG9vbF91c2UiOnsid2ViX3NlYXJjaF9yZXF1ZXN0cyI6MCwid2ViX2ZldGNoX3JlcXVlc3RzIjowfSwic2VydmljZV90aWVyIjoic3RhbmRhcmQiLCJjYWNoZV9jcmVhdGlvbiI6eyJlcGhlbWVyYWxfMWhfaW5wdXRfdG9rZW5zIjoyMzQwMjEsImVwaGVtZXJhbF81bV9pbnB1dF90b2tlbnMiOjB9LCJpbmZlcmVuY2VfZ2VvIjoibm90X2F2YWlsYWJsZSIsIml0ZXJhdGlvbnMiOlt7ImlucHV0X3Rva2VucyI6Miwib3V0cHV0X3Rva2VucyI6NDk4LCJjYWNoZV9yZWFkX2lucHV0X3Rva2VucyI6MjUzMjEwLCJjYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMiOjIzNjUsImNhY2hlX2NyZWF0aW9uIjp7ImVwaGVtZXJhbF81bV9pbnB1dF90b2tlbnMiOjAsImVwaGVtZXJhbF8xaF9pbnB1dF90b2tlbnMiOjIzNjV9LCJ0eXBlIjoibWVzc2FnZSJ9XSwic3BlZWQiOiJzdGFuZGFyZCJ9LCJtb2RlbFVzYWdlIjp7ImNsYXVkZS1vcHVzLTUiOnsiaW5wdXRUb2tlbnMiOjIwLCJvdXRwdXRUb2tlbnMiOjEzODU5LCJjYWNoZVJlYWRJbnB1dFRva2VucyI6MjIwMjU5OCwiY2FjaGVDcmVhdGlvbklucHV0VG9rZW5zIjoyMzQwMjEsIndlYlNlYXJjaFJlcXVlc3RzIjowLCJjb3N0VVNEIjozLjc4ODA4Mzk5OTk5OTk5OTYsImNvbnRleHRXaW5kb3ciOjEwMDAwMDAsIm1heE91dHB1dFRva2VucyI6NjQwMDAsImNhbm9uaWNhbE1vZGVsIjoiY2xhdWRlLW9wdXMtNSIsInByb3ZpZGVyIjoiZmlyc3RQYXJ0eSIsImNvc3RCYXNpcyI6Imxpc3QifX0sInBlcm1pc3Npb25fZGVuaWFscyI6W10sInRlcm1pbmFsX3JlYXNvbiI6ImFwaV9lcnJvciIsImZhc3RfbW9kZV9zdGF0ZSI6Im9mZiIsImZhc3RfbW9kZV9kaXNhYmxlZF9yZWFzb24iOiJzZGtfb3B0X2luX3JlcXVpcmVkIiwic3ViYWdlbnRfc3RhdHMiOnsic3Bhd25lZCI6MCwicmVxdWVzdGVkIjp7ImJhY2tncm91bmQiOjAsImZvcmVncm91bmQiOjAsInVuc2V0IjowfSwic3RhcnRlZF9pbl9iYWNrZ3JvdW5kIjowLCJtYXhfZGVwdGgiOjAsInNwYXduZWRfYnlfc3ViYWdlbnRzIjowLCJjb21wbGV0ZWQiOjAsImZhaWxlZCI6MCwia2lsbGVkIjp7InBhcmVudCI6MCwidXNlciI6MCwic3lzdGVtIjowfSwicmVmdXNlZCI6eyJkZXB0aF9saW1pdCI6MCwiY29uY3VycmVuY3lfbGltaXQiOjAsImJ1ZGdldCI6MH0sImJ5X3R5cGUiOnt9fSwiaXNfZXJyb3IiOnRydWUsIm51bV90dXJucyI6MTEsInN1YnR5cGUiOiJzdWNjZXNzIiwiYXBpX2Vycm9yX3N0YXR1cyI6NDI5LCJyZXN1bHQiOiJZb3UndmUgaGl0IHlvdXIgc2Vzc2lvbiBsaW1pdCDCtyByZXNldHMgODo0MHBtIChFdXJvcGUvQmVsZ3JhZGUpIiwidHlwZSI6InJlc3VsdCIsImR1cmF0aW9uX21zIjoyMjA1NzksInV1aWQiOiI3MjBhNTI4Ny0xZDNhLTQxYTAtYmU3YS01ZGQ4N2M5ZWQ1MzIiLCJxdWV1ZWRfdHVybl9jb3VudCI6MH0K', 'base64').toString('utf8')
const B333_D2_TAIL = Buffer.from('eyJ0eXBlIjoicmF0ZV9saW1pdF9ldmVudCIsInJhdGVfbGltaXRfaW5mbyI6eyJzdGF0dXMiOiJyZWplY3RlZCIsInJlc2V0c0F0IjoxNzg4MTE1MjAwLCJyYXRlTGltaXRUeXBlIjoiZml2ZV9ob3VyIiwib3ZlcmFnZVN0YXR1cyI6InJlamVjdGVkIiwib3ZlcmFnZURpc2FibGVkUmVhc29uIjoib3JnX2xldmVsX2Rpc2FibGVkIiwiaXNVc2luZ092ZXJhZ2UiOmZhbHNlLCJ1bmlmaWVkV2luZG93cyI6eyJmaXZlX2hvdXIiOnsidXRpbGl6YXRpb24iOjEsInJlc2V0c0F0IjoxNzg4MTE1MjAwfSwic2V2ZW5fZGF5Ijp7InV0aWxpemF0aW9uIjowLjMxLCJyZXNldHNBdCI6MTc4ODU2NjQwMH19fSwidXVpZCI6IjgwZjUwM2ZjLTc2ODMtNDQ2Zi04OGE3LTU5OWI1MDgxNmMwNSIsInNlc3Npb25faWQiOiIwYmIxZTIyNC02MmZkLTQ5YjctOTM0MC05NGNmYjJhN2RiM2MifQp7InR5cGUiOiJhc3Npc3RhbnQiLCJtZXNzYWdlIjp7ImRpYWdub3N0aWNzIjpudWxsLCJpZCI6IjcyZTY2Y2FkLTE3MWUtNGIwMS1hZjIyLTcwZjk5MzhiNGY3YSIsImNvbnRhaW5lciI6bnVsbCwibW9kZWwiOiI8c3ludGhldGljPiIsInJvbGUiOiJhc3Npc3RhbnQiLCJzdG9wX2RldGFpbHMiOm51bGwsInN0b3BfcmVhc29uIjoic3RvcF9zZXF1ZW5jZSIsInN0b3Bfc2VxdWVuY2UiOiIiLCJ0eXBlIjoibWVzc2FnZSIsInVzYWdlIjp7Im91dHB1dF90b2tlbnNfZGV0YWlscyI6bnVsbCwiaW5wdXRfdG9rZW5zIjowLCJvdXRwdXRfdG9rZW5zIjowLCJjYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMiOjAsImNhY2hlX3JlYWRfaW5wdXRfdG9rZW5zIjowLCJzZXJ2ZXJfdG9vbF91c2UiOnsid2ViX3NlYXJjaF9yZXF1ZXN0cyI6MCwid2ViX2ZldGNoX3JlcXVlc3RzIjowfSwic2VydmljZV90aWVyIjpudWxsLCJjYWNoZV9jcmVhdGlvbiI6eyJlcGhlbWVyYWxfMWhfaW5wdXRfdG9rZW5zIjowLCJlcGhlbWVyYWxfNW1faW5wdXRfdG9rZW5zIjowfSwiaW5mZXJlbmNlX2dlbyI6bnVsbCwiaXRlcmF0aW9ucyI6bnVsbCwic3BlZWQiOm51bGx9LCJjb250ZW50IjpbeyJ0eXBlIjoidGV4dCIsInRleHQiOiJZb3UndmUgaGl0IHlvdXIgc2Vzc2lvbiBsaW1pdCDCtyByZXNldHMgODo0MHBtIChFdXJvcGUvQmVsZ3JhZGUpIn1dLCJjb250ZXh0X21hbmFnZW1lbnQiOm51bGx9LCJwYXJlbnRfdG9vbF91c2VfaWQiOm51bGwsInNlc3Npb25faWQiOiIwYmIxZTIyNC02MmZkLTQ5YjctOTM0MC05NGNmYjJhN2RiM2MiLCJ1dWlkIjoiMzM3ZTJiZWQtMjdhNC00MTgwLTk3ZTktMTM0YjUyODIzMDQ5IiwidGltZXN0YW1wIjoiMjAyNi0wOC0zMFQxNzozMzo1MC4wNTNaIiwiZXJyb3IiOiJyYXRlX2xpbWl0IiwicmVxdWVzdF9pZCI6InJlcV8wMTFDZVpMTW1FTHl3ZndLNHBIZlFIaWsiLCJpc19hcGlfZXJyb3JfbWVzc2FnZSI6dHJ1ZX0KeyJkdXJhdGlvbl9hcGlfbXMiOjAsInN0b3BfcmVhc29uIjoic3RvcF9zZXF1ZW5jZSIsInNlc3Npb25faWQiOiIwYmIxZTIyNC02MmZkLTQ5YjctOTM0MC05NGNmYjJhN2RiM2MiLCJ0b3RhbF9jb3N0X3VzZCI6MCwidXNhZ2UiOnsib3V0cHV0X3Rva2Vuc19kZXRhaWxzIjp7InRoaW5raW5nX3Rva2VucyI6MH0sImlucHV0X3Rva2VucyI6MCwiY2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zIjowLCJjYWNoZV9yZWFkX2lucHV0X3Rva2VucyI6MCwib3V0cHV0X3Rva2VucyI6MCwic2VydmVyX3Rvb2xfdXNlIjp7IndlYl9zZWFyY2hfcmVxdWVzdHMiOjAsIndlYl9mZXRjaF9yZXF1ZXN0cyI6MH0sInNlcnZpY2VfdGllciI6InN0YW5kYXJkIiwiY2FjaGVfY3JlYXRpb24iOnsiZXBoZW1lcmFsXzFoX2lucHV0X3Rva2VucyI6MCwiZXBoZW1lcmFsXzVtX2lucHV0X3Rva2VucyI6MH0sImluZmVyZW5jZV9nZW8iOiIiLCJpdGVyYXRpb25zIjpbXSwic3BlZWQiOiJzdGFuZGFyZCJ9LCJtb2RlbFVzYWdlIjp7fSwicGVybWlzc2lvbl9kZW5pYWxzIjpbXSwidGVybWluYWxfcmVhc29uIjoiYXBpX2Vycm9yIiwiZmFzdF9tb2RlX3N0YXRlIjoib2ZmIiwiZmFzdF9tb2RlX2Rpc2FibGVkX3JlYXNvbiI6InNka19vcHRfaW5fcmVxdWlyZWQiLCJzdWJhZ2VudF9zdGF0cyI6eyJzcGF3bmVkIjowLCJyZXF1ZXN0ZWQiOnsiYmFja2dyb3VuZCI6MCwiZm9yZWdyb3VuZCI6MCwidW5zZXQiOjB9LCJzdGFydGVkX2luX2JhY2tncm91bmQiOjAsIm1heF9kZXB0aCI6MCwic3Bhd25lZF9ieV9zdWJhZ2VudHMiOjAsImNvbXBsZXRlZCI6MCwiZmFpbGVkIjowLCJraWxsZWQiOnsicGFyZW50IjowLCJ1c2VyIjowLCJzeXN0ZW0iOjB9LCJyZWZ1c2VkIjp7ImRlcHRoX2xpbWl0IjowLCJjb25jdXJyZW5jeV9saW1pdCI6MCwiYnVkZ2V0IjowfSwiYnlfdHlwZSI6e319LCJpc19lcnJvciI6dHJ1ZSwibnVtX3R1cm5zIjoxLCJzdWJ0eXBlIjoic3VjY2VzcyIsImFwaV9lcnJvcl9zdGF0dXMiOjQyOSwicmVzdWx0IjoiWW91J3ZlIGhpdCB5b3VyIHNlc3Npb24gbGltaXQgwrcgcmVzZXRzIDg6NDBwbSAoRXVyb3BlL0JlbGdyYWRlKSIsInR5cGUiOiJyZXN1bHQiLCJkdXJhdGlvbl9tcyI6NDk3LCJ1dWlkIjoiM2M4OGFkNjUtZTk2NS00MDU0LThiNzEtYjE5OTc4YTdjM2E1IiwicXVldWVkX3R1cm5fY291bnQiOjB9Cg==', 'base64').toString('utf8')

// The b200-helperdedup envelope, byte-exact: 1921 bytes, schema-shaped, and
// unparseable on ONE literal newline inside the `summary` string value.
function b200Bytes(bytes = 1921) {
  const head = '{\n  "assignment_id": "d1",\n  "role": "builder",\n  "status": "done",\n  "summary": "deduplicated the helper\nand ran the lane green: '
  const tail = '",\n  "artifacts": ["/tmp/plan.md"],\n  "details": {}\n}\n'
  const raw = `${head}${'x'.repeat(bytes - Buffer.byteLength(head) - Buffer.byteLength(tail))}${tail}`
  assert.equal(Buffer.byteLength(raw), bytes)
  assert.throws(() => JSON.parse(raw), SyntaxError)
  return raw
}

function makeFixture(overrides = {}, roles = ['builder']) {
  const dir = mkdtempSync(join(tmpdir(), 'headless-extra-'))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const members = Object.fromEntries(roles.map((role) => [role, { model: 'sonnet', transport: 'headless-json' }]))
  const crew = { checkout: dir, members }
  const calls = []
  const adapter = { headlessCommand(spec) { calls.push(spec); return { bin: '/worker/bin', args: ['-p', spec.prompt], env: {} } } }
  let nextPid = 700
  const deps = { pid: 700, uuid: (() => { let n = 0; return () => `extra-${++n}` })(), spawn() { return { pid: ++nextPid, unref() {} } }, log() {}, ...overrides }
  const io = headlessIo({ crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: Object.fromEntries(roles.map((role) => [role, { adapter }])), bin: '/worker/bin', deps })
  return { dir, taskDir, returnsDir, crew, calls, deps, io, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'headless-io-'))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const crew = { checkout: dir, members: { builder: { model: 'sonnet', transport: 'headless-json' } } }
  const calls = []
  const adapter = { headlessCommand(spec) {
    calls.push(spec)
    return { bin: '/worker/bin', args: ['-p', spec.prompt, '--session-id', spec.sessionId], env: {} }
  } }
  let pid = 700
  const io = headlessIo({ crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: { builder: { adapter } }, bin: '/worker/bin', deps: {
    spawn() { return { pid: ++pid, unref() {} } }, uuid: () => 'uuid-1', log() {},
  } })
  return { dir, taskDir, returnsDir, crew, calls, io, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('classifyRun keeps all six worker traps distinct', () => {
  const cases = [
    ['ok', { exitCode: 0, terminal: true, sawJson: true, envelope: {}, timedOut: false }],
    ['ok-degraded', { exitCode: 137, terminal: false, sawJson: true, envelope: {}, timedOut: false }],
    ['aborted', { exitCode: 143, terminal: false, sawJson: true, envelope: null, timedOut: false }],
    ['no-envelope', { exitCode: 0, terminal: true, sawJson: true, envelope: null, timedOut: false }],
    ['malformed', { exitCode: 1, terminal: false, sawJson: false, envelope: null, timedOut: false }],
    ['timeout', { exitCode: null, terminal: false, sawJson: false, envelope: null, timedOut: true }],
  ]
  assert.deepEqual(cases.map(([expected, input]) => classifyRun(input)), cases.map(([expected]) => expected))
})

test('envelope wins over exit and stream evidence', () => {
  assert.equal(classifyRun({ exitCode: 137, terminal: false, sawJson: true, envelope: { status: 'done' }, timedOut: false }), 'ok-degraded')
})

test('real provider refusal tails classify budget-refused from parseStream bytes', () => {
  for (const tail of [B332_D2_TAIL, B333_D2_TAIL]) {
    const stream = parseStream('/fixture/stream.jsonl', () => tail, () => true)
    assert.equal(stream.lines, 3)
    assert.equal(stream.terminal, true)
    assert.equal(stream.terminalReason, 'api_error')
    assert.equal(stream.budgetRefused, true)
    assert.equal(classifyRun({
      exitCode: 1, signal: null, terminal: stream.terminal, sawJson: stream.sawJson,
      envelope: null, timedOut: false, budgetRefused: stream.budgetRefused,
    }), 'budget-refused')
  }
})

test('budget classification is conjunctive and unreadable streams carry no refusal evidence', () => {
  const apiError = parseStream('/fixture/api-error.jsonl', () => `${JSON.stringify({ type: 'result', terminal_reason: 'api_error' })}\n`, () => true)
  assert.equal(apiError.budgetRefused, false)
  assert.equal(classifyRun({ ...apiError, exitCode: 1, envelope: null, timedOut: false }), 'no-envelope')
  const synthetic = parseStream('/fixture/synthetic.jsonl', () => `${JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })}\n${JSON.stringify({ type: 'result', terminal_reason: 'completed' })}\n`, () => true)
  assert.equal(synthetic.budgetRefused, false)
  assert.equal(classifyRun({ ...synthetic, exitCode: 0, envelope: null, timedOut: false }), 'no-envelope')
  const missing = parseStream('/fixture/missing.jsonl', () => '', () => false)
  assert.equal(missing.budgetRefused, false)
  const denied = parseStream('/fixture/denied.jsonl', () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) }, () => true)
  assert.equal(denied.budgetRefused, false)
})

test('classifyRun reaches budget-refused only when the caller names evidence', () => {
  assert.equal(classifyRun({ exitCode: 1, terminal: true, sawJson: true, envelope: null, timedOut: false }), 'no-envelope')
  assert.equal(classifyRun({ exitCode: 1, terminal: true, sawJson: true, envelope: null, timedOut: false, budgetRefused: true }), 'budget-refused')
})

test('assign composes through adapter, removes stale envelope, and resumes one session', () => {
  const f = fixture()
  try {
    const stale = join(f.returnsDir, 'd1.builder.json'); writeFileSync(stale, '{}')
    const first = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md', note: 'extra' })
    assert.deepEqual({ id: first.id, returnPath: first.returnPath }, { id: 'd1', returnPath: stale })
    assert.equal(f.calls[0].resume, false); assert.equal(f.calls[0].sessionId, 'uuid-1')
    const restarted = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: f.calls ? { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } : null } }, bin: '/worker/bin', deps: { spawn() { return { pid: 901, unref() {} } }, uuid: () => 'uuid-2', log() {} } })
    assert.throws(() => restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-session-busy')
    writeFileSync(join(f.dir, 'task', 'headless', 'd1', 'exit'), '0')
    const second = restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(second.id, 'd2'); assert.equal(f.crew.members.builder.started, true)
    assert.equal(readFileSync(join(f.dir, 'task', 'headless', '.builder.active.json'), 'utf8').includes('uuid-1'), true)
  } finally { f.cleanup() }
})

// The planted legacy `starting` marker is the #134 bug: it proves nothing about whether spawn ran.
// RESERVED is the only pre-effect shape that can be reclaimed automatically.
test('a dead RESERVED reservation is reclaimed and keeps its session id', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old-reservation', key: 'builder', phase: 'reserved', owner: { pid: 999999999 }, sessionId: 'old-session', id: 'd0', exit: join(f.taskDir, 'headless', 'd0', 'exit') }))
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.equal(run.id, 'd1')
    assert.equal(f.calls[0].sessionId, 'old-session')
  } finally { f.cleanup() }
})

test('a legacy starting marker is unresolvable, not reclaimed', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ phase: 'starting', role: 'builder', pid: null, ownerPid: 999999999, sessionId: 'old-session' }))
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-unresolvable-reservation')
    assert.equal(f.calls.length, 0)
  } finally { f.cleanup() }
})

test('assign rejects a concurrent invocation for one session', () => {
  const f = fixture()
  try {
    f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' }), (err) => err.stage === 'headless-session-busy')
  } finally { f.cleanup() }
})

test('wait returns an envelope as soon as it appears', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: 'd1', status: 'done' }))
    assert.deepEqual(f.io.wait(run.returnPath, 1), { assignment_id: 'd1', status: 'done' })
  } finally { f.cleanup() }
})

test('a 1921-byte envelope with a literal newline is UNREADABLE, not absent', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const bytes = b200Bytes()
    writeFileSync(run.returnPath, bytes)
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
      assert.equal(err.stage, 'headless-parse-error')
      assert.equal(cellFailureKind(err), 'unusable-envelope')
      assert.equal(err.role, 'builder')
      assert.equal(err.raw, bytes)
      assert.equal(err.message.includes('1921 bytes'), true)
      return true
    })
    assert.equal(readFileSync(run.returnPath, 'utf8'), bytes)
  } finally { f.cleanup() }
})

test('a missing file and a denied read both stay a re-pollable absence', () => {
  let clock = 0
  const missing = makeFixture({ now: () => clock, sleep: () => { clock += 5000 }, kill: () => {} })
  try {
    const run = missing.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => missing.io.wait(run.returnPath, 30), (err) => err.stage === 'headless-timeout')
  } finally { missing.cleanup() }

  clock = 0
  let attempts = 0
  const realRead = readFileSync
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const unreadable = makeFixture({
    now: () => clock,
    sleep: () => { clock += 5000 },
    kill: () => {},
    readFileSync: (path, ...args) => {
      if (String(path).includes('/returns/')) { attempts += 1; throw denied }
      return realRead(path, ...args)
    },
  })
  try {
    const run = unreadable.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(run.returnPath, b200Bytes())
    assert.throws(() => unreadable.io.wait(run.returnPath, 30), (err) => err.stage === 'headless-timeout')
    assert.ok(attempts > 1)
  } finally { unreadable.cleanup() }
})

test('a parseable envelope is returned unchanged', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const envelope = { assignment_id: run.id, role: 'builder', status: 'done', summary: 'ok', details: { keep: true } }
    writeFileSync(run.returnPath, JSON.stringify(envelope))
    assert.deepEqual(f.io.wait(run.returnPath, 1), envelope)
  } finally { f.cleanup() }
})

test('truncated stream, clean stream without envelope, and malformed stream have distinct stages', () => {
  for (const [stream, exit, stage] of [
    ['{"type":"assistant"}\n', '137', 'headless-aborted'],
    ['{"type":"result","terminal_reason":"done"}\n', '0', 'headless-no-envelope'],
    ['not json\n', '1', 'headless-malformed'],
  ]) {
    const f = fixture()
    try {
      const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      writeFileSync(join(f.dir, 'task', 'headless', run.id, 'stream.jsonl'), stream)
      writeFileSync(join(f.dir, 'task', 'headless', run.id, 'exit'), exit)
      assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === stage)
    } finally { f.cleanup() }
  }
})

test('a captured 529 stderr is recognised as an overloaded provider condition', () => {
  const f = fixture()
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const runDir = join(f.taskDir, 'headless', run.id)
    writeFileSync(join(runDir, 'stderr.log'), 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
    writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(join(runDir, 'exit'), '1')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
      assert.equal(err.stage, 'headless-no-envelope')
      assert.equal(err.providerCondition, 'overloaded')
      return true
    })
    assert.equal(recogniseProviderCondition('{"type":"rate_limit_error"}'), 'rate-limit')
    assert.equal(recogniseProviderCondition('{"type":"authentication_error","status":401}'), 'auth')
  } finally { f.cleanup() }
})

test('ANSI-laden stderr matches through the CSI stripper a naive matcher would miss', () => {
  const raw = 'API Error: \x1b[1;31mrate\x1b[0m limit exceeded for this organization'
  assert.equal(/rate limit/i.test(raw), false)
  assert.equal(recogniseProviderCondition(raw), 'rate-limit')
})

test('seat refusal recognition stays closed, ordered, and actionable', () => {
  const positives = [
    ['prompt_cache_retention is not supported on this model', 'rejected'],
    ['Error: Codex error: model not found', 'rejected'],
    ['The model is not supported when using Codex with a ChatGPT account', 'rejected'],
    ['No API key for provider: openai-codex', 'rejected'],
    ["Fable 5's safeguards flagged this message", 'rejected'],
    ["You've hit your session limit · resets 3pm (Europe/Belgrade)", 'quota'],
    ["You've hit your weekly limit · resets 3pm (Europe/Belgrade)", 'quota'],
    ['The usage limit has been reached', 'quota'],
    ['WebSocket error', 'transient'],
    ['WebSocket closed 1000', 'transient'],
    ['terminated', 'transient'],
    ['fetch failed', 'transient'],
    ['Connection closed mid-response', 'transient'],
    ['529 Overloaded. This is temporary', 'transient'],
    ['500 Internal server error', 'transient'],
    ['Your computer went to sleep mid-response', 'suspended'],
    ['context_length_exceeded and invalid_request_error', 'overflowed'],
  ]
  assert.deepEqual(positives.map(([text]) => recogniseSeatRefusal(text)), positives.map(([, member]) => member))
  const negatives = [
    'PASS G9', 'GATE-SUMMARY {"total":403,"failed":0,"errored":0}', 'ok 401 - something',
    '↑366k ↓31k R7.0M $0.250 (sub) 73.0%/272k (auto)',
    'crew/seat-io.mjs:429:  const rows = []', '403→export function refusalRow({ role })',
  ]
  for (const value of [...negatives, '', undefined, null, [], {}]) {
    assert.equal(recogniseSeatRefusal(value), null)
    assert.equal(recogniseProviderCondition(value), null)
  }
  assert.equal(Object.isFrozen(SEAT_REFUSALS), true)
  for (const row of SEAT_REFUSALS) assert.equal(typeof row.terminal, 'boolean')
  assert.deepEqual(SEAT_REFUSALS.map((row) => row.member), ['overflowed', 'quota', 'rejected', 'suspended', 'transient'])
  assert.deepEqual(SEAT_REFUSALS.filter((row) => row.terminal === true).map((row) => row.member), ['overflowed', 'quota', 'rejected', 'suspended'])
  assert.deepEqual(SEAT_REFUSALS.filter((row) => row.terminal === false).map((row) => row.member), ['transient'])
  for (const row of SEAT_REFUSALS.filter((entry) => entry.terminal === false)) assert.equal(SEAT_REFUSAL_ACTIONS[row.member], 'journal')
  assert.equal(SEAT_REFUSALS.some((row) => row.member === UNCLASSIFIED_REFUSAL), false)
  assert.deepEqual(Object.keys(SEAT_REFUSAL_ACTIONS).sort(), [...SEAT_REFUSALS.map((row) => row.member), UNCLASSIFIED_REFUSAL].sort())
  assert.equal(Object.isFrozen(SEAT_REFUSAL_ACTIONS), true)
  for (const action of Object.values(SEAT_REFUSAL_ACTIONS)) assert.ok(['reprompt', 'end', 'journal', 'reprompt-on-silence'].includes(action))
  assert.equal(SEAT_REFUSAL_ACTIONS.rejected, 'reprompt')
  assert.equal(SEAT_REFUSAL_ACTIONS.quota, 'end')
  assert.equal(SEAT_REFUSAL_ACTIONS[UNCLASSIFIED_REFUSAL], 'reprompt-on-silence')
})

test('an unrecognised, missing, empty or unreadable stderr carries no recognition', () => {
  const failure = (stderr, overrides = {}) => {
    const f = makeFixture(overrides)
    try {
      const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
      const runDir = join(f.taskDir, 'headless', run.id)
      if (stderr !== undefined) writeFileSync(join(runDir, 'stderr.log'), stderr)
      writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
      writeFileSync(join(runDir, 'exit'), '1')
      assert.throws(() => f.io.wait(run.returnPath, 1), (err) => {
        assert.equal(err.stage, 'headless-no-envelope')
        assert.equal(Object.hasOwn(err, 'providerCondition'), false)
        return true
      })
    } finally { f.cleanup() }
  }
  failure('ordinary stderr text')
  failure('')
  failure(undefined)
  const realRead = readFileSync
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  failure('unreadable stderr', {
    readFileSync: (path, ...args) => {
      if (String(path).endsWith('/stderr.log')) throw denied
      return realRead(path, ...args)
    },
  })
})

test('recognition reads only the stderr the wrapper already captured and adds no poll', () => {
  const readPaths = []; let sleeps = 0
  const realRead = readFileSync
  const f = makeFixture({
    readFileSync: (path, ...args) => { readPaths.push(String(path)); return realRead(path, ...args) },
    sleep: () => { sleeps += 1; throw new Error('unexpected poll') },
  })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const runDir = join(f.taskDir, 'headless', run.id)
    const stderrPath = join(runDir, 'stderr.log')
    writeFileSync(stderrPath, 'ordinary stderr text')
    writeFileSync(join(runDir, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(join(runDir, 'exit'), '1')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-no-envelope')
    assert.equal(sleeps, 0)
    const allowed = new Set(['stream.jsonl', 'stderr.log', 'exit', 'cmd.json', 'pgid'])
    const underRun = readPaths.filter((path) => path.startsWith(`${runDir}/`))
    assert.ok(underRun.length > 0)
    assert.equal(underRun.every((path) => allowed.has(path.slice(runDir.length + 1))), true)
    assert.ok(readPaths.filter((path) => path === stderrPath).length <= 1)
  } finally { f.cleanup() }
})

test('shq round-trips a single quote as a shell token', () => {
  assert.equal(shq("a'b"), "'a'\\''b'")
})

test('timeout kills the detached process group and never hangs', () => {
  const f = fixture(); let clock = 0; const signals = []
  const io = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: f.calls ? { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } : null } }, bin: '/worker/bin', deps: {
    spawn() { return { pid: 88, unref() {} } }, uuid: () => 'u', now: () => clock, sleep: () => { clock += 5000 }, kill: (pid, signal) => signals.push([pid, signal]), log() {},
  } })
  try {
    const run = io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    assert.throws(() => io.wait(run.returnPath, 1), (err) => err.stage === 'headless-timeout')
    assert.ok(signals.some(([pid, signal]) => pid === -88 && signal === 'SIGTERM'))
    assert.ok(signals.some(([pid, signal]) => pid === -88 && signal === 'SIGKILL'))
    assert.equal(existsSync(join(f.dir, 'task', 'headless', '.builder.active.json')), false)
    const restarted = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: (s) => ({ bin: '/worker/bin', args: ['-p', s.prompt], env: {} }) } } }, bin: '/worker/bin', deps: { spawn() { return { pid: 89, unref() {} } }, uuid: () => 'u2', log() {} } })
    assert.equal(restarted.assign({ role: 'builder', briefFile: '/tmp/brief.md' }).id, 'd2')
  } finally { f.cleanup() }
})

test('allocator is exclusive across supervisors constructed before d1', () => { const a = makeFixture(); try { const b = headlessIo({ crew: a.crew, paths: { dir: a.dir, taskDir: a.taskDir, returnsDir: a.returnsDir }, taskDir: a.taskDir, checkout: a.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, uuid: (() => { let n = 0; return () => `b-${++n}` })(), spawn: () => ({ pid: 900, unref() {} }), log() {} } }); const first = a.io.assign({ role: 'builder', briefFile: '/tmp/b' }); writeFileSync(join(a.dir, 'task', 'headless', first.id, 'exit'), '0'); const second = b.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.notEqual(second.id, first.id); assert.equal(existsSync(join(a.dir, 'task', 'headless', second.id, 'exit')), false) } finally { a.cleanup() } })
test('two roles never adopt one candidate run directory', () => { const f = makeFixture({}, ['builder', 'reviewer']); try { const a = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); const b = f.io.assign({ role: 'reviewer', briefFile: '/tmp/b' }); assert.notEqual(a.id, b.id) } finally { f.cleanup() } })
test('running marker write crash retains SPAWNING reservation', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 901, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"running"')) throw Error('marker write'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 1); const restart = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, spawn: () => { spawned += 1; return { pid: 902, unref() {} } }, kill: () => true, log() {} } }); assert.throws(() => restart.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('post-return crash before pgid lands fails closed', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 901, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"running"')) throw Error('marker write'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); const r = headlessIo({ crew: f.crew, paths: { dir: f.dir, taskDir: f.taskDir, returnsDir: f.returnsDir }, taskDir: f.taskDir, checkout: f.dir, adapters: { builder: { adapter: { headlessCommand: () => ({ bin: '/worker/bin', args: [], env: {} }) } } }, deps: { pid: 701, kill: () => { const e = Error(); e.code = 'ESRCH'; throw e }, spawn: () => { spawned += 1; return { pid: 902, unref() {} } }, log() {} } }); assert.throws(() => r.assign({ role: 'builder', briefFile: '/tmp/b' }), (e) => e.stage === 'headless-unresolvable-reservation'); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('failed SPAWNING advance does not spawn and clears marker', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 900, unref() {} } }, writeFileSync(path, data, options) { if (String(data).includes('"phase":"spawning"')) throw Error('advance'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 0); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })
test('failed command write does not spawn and clears marker', () => { let spawned = 0; const f = makeFixture({ spawn: () => { spawned += 1; return { pid: 900, unref() {} } }, writeFileSync(path, data, options) { if (String(path).endsWith('cmd.json')) throw Error('command'); return writeFileSync(path, data, options) } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(spawned, 0); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })
test('proven-dead pgid reservation is reclaimed', () => { let spawned = 0; const f = makeFixture({ kill: (pid, signal) => { if (signal === 0) { const e = Error(); e.code = 'ESRCH'; throw e } if (Math.abs(pid) === 111) { const e = Error(); e.code = 'ESRCH'; throw e } }, spawn: () => { spawned += 1; return { pid: 900, unref() {} } } }); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); writeFileSync(join(f.taskDir, 'headless', 'd1', 'pgid'), '111'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old', key: 'builder', phase: 'spawning', owner: { pid: 999999999 }, id: 'd1', evidence: { kind: 'pgid', file: join(f.taskDir, 'headless', 'd1', 'pgid') } })); f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.equal(spawned, 1) } finally { f.cleanup() } })
test('live pgid reservation is busy', () => { let spawned = 0; const f = makeFixture({ kill: () => true, spawn: () => { spawned += 1; return { pid: 900, unref() {} } } }); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); writeFileSync(join(f.taskDir, 'headless', 'd1', 'pgid'), '222'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ reservation_id: 'old', key: 'builder', phase: 'spawning', owner: { pid: 999999999 }, id: 'd1', evidence: { kind: 'pgid', file: join(f.taskDir, 'headless', 'd1', 'pgid') } })); assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' }), (e) => e.stage === 'headless-session-busy'); assert.equal(spawned, 0) } finally { f.cleanup() } })
test('completed legacy marker frees seat', () => { const f = makeFixture(); try { mkdirSync(join(f.taskDir, 'headless', 'd1')); const exit = join(f.taskDir, 'headless', 'd1', 'exit'); writeFileSync(exit, '0'); writeFileSync(join(f.taskDir, 'headless', '.builder.active.json'), JSON.stringify({ phase: 'running', role: 'builder', id: 'd1', exit, sessionId: 'old' })); f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.equal(f.calls[0].sessionId, 'old') } finally { f.cleanup() } })
test('an active marker that VANISHES between reads yields a fresh uuid rather than a throw (a genuinely malformed marker is REFUSED as unresolvable, not healed)', () => {
  let consumed = false
  const f = makeFixture({
    readFileSync(path, ...args) {
      const value = readFileSync(path, ...args)
      if (!consumed && String(path).endsWith('/.builder.active.json')) {
        consumed = true
        unlinkSync(path)
      }
      return value
    },
  })
  try {
    const active = join(f.taskDir, 'headless', '.builder.active.json')
    mkdirSync(join(f.taskDir, 'headless'), { recursive: true })
    writeFileSync(active, '{not json')
    assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' }))
    assert.equal(f.calls[0].sessionId, 'extra-1')
  } finally { f.cleanup() }
})
test('synchronous spawn failure rolls back and retries', () => { let fail = true; const f = makeFixture({ spawn: () => { if (fail) { fail = false; throw Error('spawn') } return { pid: 901, unref() {} } } }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false); assert.doesNotThrow(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })) } finally { f.cleanup() } })
test('unref failure retains SPAWNING reservation', () => { const f = makeFixture({ spawn: () => ({ pid: 901, unref() { throw Error('unref') } }) }); try { assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/b' })); assert.equal(JSON.parse(readFileSync(join(f.taskDir, 'headless', '.builder.active.json'))).phase, 'spawning') } finally { f.cleanup() } })
test('timeout EPERM retains marker', () => { let clock = 0; const f = makeFixture({ now: () => clock, sleep: () => { clock += 5000 }, kill() { const e = Error('permission'); e.code = 'EPERM'; throw e } }); try { const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); assert.throws(() => f.io.wait(run.returnPath, 0)); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), true) } finally { f.cleanup() } })
test('timeout EPERM plus dead pgid clears marker', () => { let clock = 0; const f = makeFixture({ now: () => clock, sleep: () => { clock += 5000 }, kill(pid, signal) { if (signal === 'SIGTERM' || signal === 'SIGKILL') { const e = Error(); e.code = 'EPERM'; throw e } const e = Error(); e.code = 'ESRCH'; throw e } }); try { const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' }); mkdirSync(join(f.taskDir, 'headless', run.id), { recursive: true }); writeFileSync(join(f.taskDir, 'headless', run.id, 'pgid'), '111'); assert.throws(() => f.io.wait(run.returnPath, 0)); assert.equal(existsSync(join(f.taskDir, 'headless', '.builder.active.json')), false) } finally { f.cleanup() } })

test('the wrapper publishes its pgid atomically before the worker runs', () => {
  let shell = null
  const f = makeFixture({ spawn: (bin, args) => { shell = args[1]; return { pid: 901, unref() {} } } })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    const pgid = join(f.taskDir, 'headless', run.id, 'pgid')
    assert.ok(shell.startsWith(`printf '%s' $$ >'${pgid}.tmp';`), 'wrapper must publish its pgid as its first act')
    const published = shell.indexOf(`mv '${pgid}.tmp' '${pgid}'`)
    assert.ok(published > -1, 'pgid must be published by an atomic rename')
    assert.ok(published < shell.indexOf('/worker/bin'), 'pgid must exist before the worker starts')
  } finally { f.cleanup() }
})

test('allocation never re-adopts an existing run directory', () => {
  const f = makeFixture({ readdirSync: (p, opts) => (String(p).endsWith('/headless') ? [] : readdirSync(p, opts)) })
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    writeFileSync(join(f.taskDir, 'headless', first.id, 'exit'), '0')
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/b' })
    assert.notEqual(second.id, first.id)
    assert.equal(existsSync(join(f.taskDir, 'headless', second.id, 'exit')), false)
  } finally { f.cleanup() }
})

test('foldUsage prefers the claude result aggregate over assistant snapshots', () => {
  const capture = readFileSync(new URL('../tasks/headless-worker/captures/a-baseline.jsonl', import.meta.url), 'utf8')
  assert.deepEqual(foldUsage(capture), {
    billed_input_tokens: 18, billed_output_tokens: 287,
    billed_cache_write_tokens: 7709, billed_cache_read_tokens: 43575,
  })
})

test('foldUsage dedupes repeated assistant message ids with last occurrence wins', () => {
  const line = (id, output) => JSON.stringify({
    type: 'assistant', message: { id, usage: {
      input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000,
    } },
  })
  const text = [line('m1', 5), line('m1', 5), line('m1', 400), JSON.stringify({
    type: 'assistant', message: { id: 'm2', usage: {
      input_tokens: 8, output_tokens: 1, cache_creation_input_tokens: 36, cache_read_input_tokens: 74,
    } },
  })].join('\n')
  assert.deepEqual(foldUsage(text), {
    billed_input_tokens: 18, billed_output_tokens: 401,
    billed_cache_write_tokens: 136, billed_cache_read_tokens: 1074,
  })
})

test('headless usage stays null when a stream reports no usage', () => {
  const seen = []; const f = makeFixture({ emit: (event) => seen.push(event) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(f.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"result","terminal_reason":"done"}\n')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, status: 'done' }))
    assert.equal(f.io.wait(run.returnPath, 1).status, 'done')
    assert.deepEqual(seen.map((event) => ({ kind: event.kind, usage: event.usage })), [{ kind: 'usage', usage: null }])
  } finally { f.cleanup() }
})

test('aborted headless runs emit deduped partial usage without changing classification', () => {
  const seen = []; const f = makeFixture({ emit: (event) => seen.push(event) })
  try {
    const run = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const assistant = (output) => JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: {
      input_tokens: 4, output_tokens: output, cache_creation_input_tokens: 2, cache_read_input_tokens: 3,
    } } })
    writeFileSync(join(f.taskDir, 'headless', run.id, 'stream.jsonl'), `${assistant(1)}\n${assistant(9)}\n`)
    writeFileSync(join(f.taskDir, 'headless', run.id, 'exit'), '137')
    assert.throws(() => f.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-aborted')
    assert.deepEqual(seen.at(-1).usage, {
      billed_input_tokens: 4, billed_output_tokens: 9,
      billed_cache_write_tokens: 2, billed_cache_read_tokens: 3,
    })
  } finally { f.cleanup() }
})

test('headless usage emission is never load-bearing on happy or aborted paths', () => {
  const happy = makeFixture({ emit: () => { throw new Error('emitter down') } })
  try {
    const run = happy.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(happy.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"result"}\n')
    writeFileSync(run.returnPath, JSON.stringify({ assignment_id: run.id, status: 'done' }))
    assert.deepEqual(happy.io.wait(run.returnPath, 1), { assignment_id: run.id, status: 'done' })
  } finally { happy.cleanup() }
  const aborted = makeFixture({ emit: () => { throw new Error('emitter down') } })
  try {
    const run = aborted.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    writeFileSync(join(aborted.taskDir, 'headless', run.id, 'stream.jsonl'), '{"type":"assistant","message":{"id":"m","usage":{"output_tokens":1}}}\n')
    writeFileSync(join(aborted.taskDir, 'headless', run.id, 'exit'), '137')
    assert.throws(() => aborted.io.wait(run.returnPath, 1), (err) => err.stage === 'headless-aborted')
  } finally { aborted.cleanup() }
})

function durabilityDocument() {
  return {
    task: 'crew-json-durability',
    members: {
      builder: { role: 'builder', model: 'builder-model', transport: 'headless-json' },
      reviewer: { role: 'reviewer', model: 'reviewer-model', transport: 'headless-json' },
    },
    seats: { builder: { model: 'builder-model' }, reviewer: { model: 'reviewer-model' } },
    padding: 'x'.repeat(4096),
  }
}

function durabilityPaths(tag) {
  const dir = mkdtempSync(join(tmpdir(), `headless-json-${tag}-`))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  return { dir, taskDir, returnsDir }
}

test('T1 harness control proves plain writes tear while atomic writes race safely', async () => {
  const paths = durabilityPaths('t1')
  const file = join(paths.dir, 'crew.json')
  const text = JSON.stringify({ ...durabilityDocument(), version: '%N%' })
  let plain = null; let atomic = null
  try {
    plain = await startFileWriter({ file, text, mode: 'plain', maxMs: 2000 })
    let torn = 0
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      try { JSON.parse(readFileSync(file, 'utf8')) } catch { torn += 1 }
    }
    assert.notEqual(plain.pid, process.pid)
    assert.ok(torn > 0, 'plain writer must produce an unparseable or empty read')
    await plain.stop(); plain = null
    rmSync(`${file}.stop`, { force: true })

    writeFileSync(file, text.replace('"%N%"', '"seed"'))
    atomic = await startFileWriter({ file, text, mode: 'atomic', maxMs: 2000 })
    const contents = new Set()
    const atomicDeadline = Date.now() + 500
    while (Date.now() < atomicDeadline) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      contents.add(JSON.stringify(parsed.version))
    }
    assert.ok(contents.size >= 2, 'atomic writer must publish at least two distinct contents')
    await atomic.stop(); atomic = null
  } finally {
    if (plain) await plain.stop()
    if (atomic) await atomic.stop()
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('T2 owner publishes through a rename and never targets crew.json with writeFileSync', () => {
  const paths = durabilityPaths('t2')
  const file = join(paths.dir, 'crew.json')
  writeFileSync(file, JSON.stringify(durabilityDocument(), null, 2))
  const before = statSync(file).ino
  const targets = []; let n = 0
  try {
    const result = updateCrewJson(paths, (disk) => { disk.owner_marker = true; return true }, {
      uuid: () => `t2-${++n}`,
      writeFileSync: (path, data, options) => { targets.push(String(path)); return writeFileSync(path, data, options) },
    })
    assert.equal(result.ok, true)
    assert.notEqual(statSync(file).ino, before)
    assert.equal(targets.includes(file), false)
    assert.ok(targets.some((path) => path.includes('crew.json.tmp.')))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).owner_marker, true)
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T3 an atomic foreign writer cannot tear the locked owner', async () => {
  const paths = durabilityPaths('t3')
  const file = join(paths.dir, 'crew.json')
  const text = JSON.stringify({ ...durabilityDocument(), version: '%N%' })
  writeFileSync(file, text.replace('"%N%"', '"seed"'))
  let writer = null; let n = 0
  try {
    writer = await startFileWriter({ file, text, mode: 'atomic', maxMs: 2000 })
    for (let i = 0; i < 12; i += 1) {
      const result = updateCrewJson(paths, (disk) => { disk.owner_updates = (disk.owner_updates || 0) + 1; return true }, { uuid: () => `t3-${++n}` })
      assert.equal(result.ok, true)
      assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')))
    }
    const stopped = await writer.stop(); writer = null
    assert.ok(stopped.writes >= 1)
  } finally {
    if (writer) await writer.stop()
    rmSync(paths.dir, { recursive: true, force: true })
  }
})

test('T4 owner RMW preserves a reseat and the seat delta from a stale copy', () => {
  const paths = durabilityPaths('t4')
  const file = join(paths.dir, 'crew.json')
  try {
    writeFileSync(file, JSON.stringify(durabilityDocument(), null, 2))
    const result = updateCrewJson(paths, (disk) => {
      disk.members.reviewer.model = 'reseated-model'
      disk.reseated = { role: 'reviewer' }
      return true
    })
    assert.equal(result.ok, true)
    const persist = updateCrewJson(paths, (disk) => {
      disk.members.builder.session_id = 'stale-seat-session'
      return true
    })
    assert.equal(persist.ok, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.members.reviewer.model, 'reseated-model')
    assert.deepEqual(after.reseated, { role: 'reviewer' })
    assert.equal(after.members.builder.session_id, 'stale-seat-session')
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T5 owner fails closed for absent and unparseable crew.json', () => {
  const absent = durabilityPaths('t5-absent')
  try {
    const result = updateCrewJson(absent, (disk) => { disk.created = true; return true })
    assert.deepEqual(result, { ok: false, reason: 'absent' })
    assert.equal(existsSync(join(absent.dir, 'crew.json')), false)
  } finally { rmSync(absent.dir, { recursive: true, force: true }) }
  const unreadable = durabilityPaths('t5-unreadable')
  const file = join(unreadable.dir, 'crew.json')
  const bytes = '{"broken":'
  try {
    writeFileSync(file, bytes)
    const result = updateCrewJson(unreadable, (disk) => { disk.changed = true; return true })
    assert.deepEqual(result, { ok: false, reason: 'unreadable' })
    assert.equal(readFileSync(file, 'utf8'), bytes)
  } finally { rmSync(unreadable.dir, { recursive: true, force: true }) }
})

test('T6 headless transport persists its own deltas without erasing a disk reseat', () => {
  const paths = durabilityPaths('t6')
  const file = join(paths.dir, 'crew.json')
  const crew = { ...durabilityDocument(), checkout: paths.dir }
  const disk = durabilityDocument()
  disk.members.reviewer.model = 'operator-reseated-model'; disk.reseated = { role: 'reviewer' }
  writeFileSync(file, JSON.stringify(disk, null, 2))
  let n = 0
  try {
    const io = headlessIo({
      crew, paths, taskDir: paths.taskDir, checkout: paths.dir,
      adapters: { reviewer: { headlessCommand: (spec) => ({ bin: '/bin/worker', args: [spec.model] }) } }, bin: '/bin/worker',
      deps: { spawn: () => ({ pid: 7001, unref() {} }), uuid: () => `t6-${++n}`, now: () => 0, sleep: () => {}, pid: 7000, log() {} },
    })
    io.assign({ role: 'reviewer', briefFile: join(paths.taskDir, 'brief.md') })
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.members.reviewer.model, 'operator-reseated-model')
    assert.deepEqual(after.reseated, { role: 'reviewer' })
    assert.match(after.members.reviewer.session_id, /^t6-/)
    assert.equal(after.members.reviewer.started, true)
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

test('T7 headless transport journals a failed crew.json persist', () => {
  const paths = durabilityPaths('t7')
  const file = join(paths.dir, 'crew.json')
  const crew = { ...durabilityDocument(), checkout: paths.dir }
  writeFileSync(file, JSON.stringify(crew, null, 2))
  const events = []; let n = 0
  try {
    const io = headlessIo({
      crew, paths, taskDir: paths.taskDir, checkout: paths.dir,
      adapters: { reviewer: { headlessCommand: () => ({ bin: '/bin/worker', args: [] }) } }, bin: '/bin/worker',
      deps: {
        spawn: () => ({ pid: 7011, unref() {} }), uuid: () => `t7-${++n}`, now: () => 0, sleep: () => {}, pid: 7010,
        log: (event) => events.push(event), writeFileSync: (path, data, options) => {
          if (String(path).includes('crew.json.tmp.')) throw new Error('simulated crew.json write failure')
          return writeFileSync(path, data, options)
        },
      },
    })
    io.assign({ role: 'reviewer', briefFile: join(paths.taskDir, 'brief.md') })
    const failures = events.filter((event) => event.event === 'crew-json-persist-failed')
    assert.ok(failures.length >= 1)
    assert.ok(failures.every((event) => event.role === 'reviewer' && event.reason === 'write-failed'))
  } finally { rmSync(paths.dir, { recursive: true, force: true }) }
})

const FALLBACK_TEST_CHAIN = [
  { provider: 'anthropic', id: 'claude-opus-5', agent: 'claude', effort: 'high', model: 'claude-opus-5' },
  { provider: 'anthropic', id: 'claude-sonnet-5', agent: 'claude', effort: 'high', model: 'claude-sonnet-5' },
]

function fallbackFixture(script, { chain = FALLBACK_TEST_CHAIN, clock = null, onSleep = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'headless-fallback-'))
  const taskDir = join(dir, 'task'); const returnsDir = join(dir, 'returns')
  mkdirSync(taskDir); mkdirSync(returnsDir)
  const member = {
    transport: 'headless-json', agent: 'claude', model: 'claude-fable-5',
    provider: 'anthropic', id: 'claude-fable-5', effort: 'high',
    ...(chain ? { fallback: chain.map((entry) => ({ ...entry })) } : {}),
  }
  const crew = { schema_version: 3, tier: 'judge', checkout: dir, members: { 'tech-lead': member }, seats: { 'tech-lead': { ...member, ...(member.fallback ? { fallback: member.fallback.map((entry) => ({ ...entry })) } : {}) } } }
  writeFileSync(join(dir, 'crew.json'), JSON.stringify(crew, null, 2))
  const journal = []; let spawns = 0; let pid = 4200; let lastRunDir = null
  const deps = {
    log: (row) => journal.push(row), kill: () => {},
    ...(clock ? { now: () => clock.t } : {}),
    sleep(ms) {
      if (clock) clock.t += Number(ms) || 0
      onSleep?.({ clock, runDir: lastRunDir, spawns, returnsDir })
    },
    uuid: (() => { let n = 0; return () => `fallback-${++n}` })(),
    spawn() {
      spawns += 1
      const root = join(taskDir, 'headless')
      const dirs = readdirSync(root).filter((name) => /^d\d+$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      lastRunDir = join(root, dirs.at(-1))
      script(spawns, lastRunDir, returnsDir)
      return { pid: ++pid, unref() {} }
    },
  }
  const io = headlessIo({ crew, paths: { dir, taskDir, returnsDir }, taskDir, checkout: dir, adapters: null, bin: '/frozen/worker/bin', deps })
  const commands = () => readdirSync(join(taskDir, 'headless')).filter((name) => /^d\d+$/.test(name)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((name) => JSON.parse(readFileSync(join(taskDir, 'headless', name, 'cmd.json'), 'utf8')))
  return {
    dir, taskDir, returnsDir, crew, journal, io, commands,
    spawnCount: () => spawns,
    diskCrew: () => JSON.parse(readFileSync(join(dir, 'crew.json'), 'utf8')),
    fallbackRows: () => journal.filter((row) => row.event === 'seat-fallback'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function writeBudgetRefusal(runDir) {
  writeFileSync(join(runDir, 'stream.jsonl'), B333_D2_TAIL)
  writeFileSync(join(runDir, 'exit'), '1')
}

function writeBudgetAnswer(runDir, returnsDir) {
  writeFileSync(join(returnsDir, 'd1.tech-lead.json'), JSON.stringify({ assignment_id: 'd1', role: 'tech-lead', status: 'done' }))
  writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'completed', subtype: 'success' })}\n`)
  writeFileSync(join(runDir, 'exit'), '0')
}

test('a budget refusal re-asks the same assignment on the consumed fallback cell', () => {
  const f = fallbackFixture((n, runDir, returnsDir) => n === 1 ? writeBudgetRefusal(runDir) : writeBudgetAnswer(runDir, returnsDir))
  try {
    const run = f.io.assign({ role: 'tech-lead', briefFile: join(f.taskDir, 'brief.md') })
    const envelope = f.io.wait(run.returnPath, 600)
    assert.equal(envelope.assignment_id, 'd1')
    assert.equal(f.spawnCount(), 2)
    const commands = f.commands()
    assert.equal(commands[1].bin, '/frozen/worker/bin')
    assert.equal(commands[1].args[commands[1].args.indexOf('--model') + 1], 'claude-opus-5')
    const prompt = commands[1].args[commands[1].args.indexOf('-p') + 1]
    assert.match(prompt, /ASSIGNMENT d1:/)
    assert.equal(f.fallbackRows().length, 1)
    assert.deepEqual(f.fallbackRows()[0], {
      at: f.fallbackRows()[0].at, event: 'seat-fallback', role: 'tech-lead',
      from: { provider: 'anthropic', id: 'claude-fable-5', model: 'claude-fable-5', effort: 'high', agent: 'claude' },
      to: { provider: 'anthropic', id: 'claude-opus-5', model: 'claude-opus-5', effort: 'high', agent: 'claude' },
      cause: 'budget', assignment_id: 'd1',
    })
    for (const view of [f.crew.members['tech-lead'], f.crew.seats['tech-lead'], f.diskCrew().members['tech-lead'], f.diskCrew().seats['tech-lead']]) {
      assert.equal(view.provider, 'anthropic'); assert.equal(view.id, 'claude-opus-5'); assert.equal(view.model, 'claude-opus-5')
      assert.equal(view.fallback.length, 1); assert.equal(view.fallback[0].id, 'claude-sonnet-5')
    }
  } finally { f.cleanup() }
})

test('a second budget refusal spends no second fallback and escapes as budget', () => {
  const f = fallbackFixture((n, runDir) => writeBudgetRefusal(runDir))
  try {
    const run = f.io.assign({ role: 'tech-lead', briefFile: join(f.taskDir, 'brief.md') })
    assert.throws(() => f.io.wait(run.returnPath, 600), (err) => err.stage === 'headless-budget-refused')
    assert.equal(f.spawnCount(), 2); assert.equal(f.fallbackRows().length, 1)
    assert.equal(f.crew.members['tech-lead'].fallback.length, 1)
  } finally { f.cleanup() }
})

test('a fallback inherits the original absolute deadline and a late declared cell does not spawn', () => {
  const clock = { t: 0 }; const deadline = 600_000
  const f = fallbackFixture(() => {}, { clock, onSleep: ({ clock: c, runDir, spawns }) => {
    if (spawns === 1 && c.t > 590_000) writeBudgetRefusal(runDir)
  } })
  try {
    const run = f.io.assign({ role: 'tech-lead', briefFile: join(f.taskDir, 'brief.md') })
    assert.throws(() => f.io.wait(run.returnPath, 600), (err) => ['headless-timeout', 'headless-budget-refused'].includes(err.stage))
    assert.equal(f.spawnCount(), 2); assert.ok(clock.t <= deadline + 15_000)
  } finally { f.cleanup() }

  const lateClock = { t: 0 }; let lateDeadline = null
  const late = fallbackFixture(() => {}, { clock: lateClock, onSleep: ({ clock: c, runDir }) => {
    if (lateDeadline !== null && c.t > lateDeadline) writeBudgetRefusal(runDir)
  } })
  try {
    const run = late.io.assign({ role: 'tech-lead', briefFile: join(late.taskDir, 'brief.md') })
    lateDeadline = 600_000
    assert.throws(() => late.io.wait(run.returnPath, 600), (err) => err.stage === 'headless-budget-refused')
    assert.equal(late.spawnCount(), 1)
    assert.equal(late.journal.filter((row) => row.event === 'seat-fallback-expired').length, 1)
  } finally { late.cleanup() }
})

test('a chainless budget refusal and a legacy no-envelope run never invent fallback events', () => {
  const lateClock = { t: 0 }; let lateDeadline = null
  const chainless = fallbackFixture(() => {}, { chain: null, clock: lateClock, onSleep: ({ clock: c, runDir }) => {
    if (lateDeadline !== null && c.t > lateDeadline) writeBudgetRefusal(runDir)
  } })
  try {
    const run = chainless.io.assign({ role: 'tech-lead', briefFile: join(chainless.taskDir, 'brief.md') })
    lateDeadline = 600_000
    assert.throws(() => chainless.io.wait(run.returnPath, 600), (err) => err.stage === 'headless-budget-refused')
    assert.equal(chainless.spawnCount(), 1)
    assert.equal(chainless.fallbackRows().length, 0)
    assert.equal(chainless.journal.filter((row) => row.event === 'seat-fallback-expired').length, 0)
  } finally { chainless.cleanup() }

  const legacy = fallbackFixture((n, runDir) => {
    writeFileSync(join(runDir, 'stream.jsonl'), `${JSON.stringify({ type: 'result', terminal_reason: 'completed', subtype: 'success' })}\n`)
    writeFileSync(join(runDir, 'exit'), '0')
  })
  try {
    const run = legacy.io.assign({ role: 'tech-lead', briefFile: join(legacy.taskDir, 'brief.md') })
    assert.throws(() => legacy.io.wait(run.returnPath, 600), (err) => err.stage === 'headless-no-envelope')
    assert.equal(legacy.spawnCount(), 1); assert.equal(legacy.fallbackRows().length, 0)
    assert.equal(legacy.crew.members['tech-lead'].fallback.length, 2)
  } finally { legacy.cleanup() }
})

function headlessReaskFixture(overrides = {}) {
  const logs = []
  const f = makeFixture({ log: (row) => logs.push(row), ...overrides })
  const first = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
  const reaskPath = join(f.returnsDir, `${first.id}.reask.builder.json`)
  writeFileSync(join(f.taskDir, 'headless', first.id, 'exit'), '0')
  return { ...f, first, reaskPath, logs }
}

test('a re-ask assignment keeps the caller logical id and collects on the caller path', () => {
  const f = headlessReaskFixture()
  try {
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    assert.deepEqual(second, { id: 'd1', returnPath: f.reaskPath })
    assert.match(f.calls[1].prompt, /^ASSIGNMENT d1:/)
    assert.ok(f.calls[1].prompt.includes(f.reaskPath))
  } finally { f.cleanup() }
})

test('a re-ask is a second physical run with its own directory and reservation', () => {
  const f = headlessReaskFixture()
  try {
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    assert.equal(second.id, f.first.id)
    assert.equal(existsSync(join(f.taskDir, 'headless', 'd2')), true)
    const marker = JSON.parse(readFileSync(join(f.taskDir, 'headless', '.builder.active.json'), 'utf8'))
    assert.equal(marker.id, 'd2')
    assert.equal(marker.dir, join(f.taskDir, 'headless', 'd2'))
    const spawn = f.logs.filter((row) => row.event === 'headless-spawn').at(-1)
    assert.equal(spawn.id, 'd1')
    assert.equal(spawn.run_id, 'd2')
  } finally { f.cleanup() }
})

test("a re-ask resumes the seat's own session rather than starting a new one", () => {
  const f = headlessReaskFixture()
  try {
    f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    assert.equal(f.calls[1].resume, true)
    assert.equal(f.calls[1].sessionId, f.calls[0].sessionId)
  } finally { f.cleanup() }
})

test('a re-ask never touches the seat original return file', () => {
  const f = headlessReaskFixture()
  try {
    const original = 'original malformed bytes'
    writeFileSync(f.first.returnPath, original)
    f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    assert.equal(readFileSync(f.first.returnPath, 'utf8'), original)
  } finally { f.cleanup() }
})

test('a re-ask while the prior invocation is still live is refused as busy', () => {
  const f = makeFixture()
  try {
    const first = f.io.assign({ role: 'builder', briefFile: '/tmp/brief.md' })
    const reaskPath = join(f.returnsDir, `${first.id}.reask.builder.json`)
    assert.throws(() => f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: first.id, returnPath: reaskPath } }), (err) => err.stage === 'headless-session-busy')
    assert.equal(readdirSync(join(f.taskDir, 'headless')).filter((name) => /^d\d+$/.test(name)).length, 1)
  } finally { f.cleanup() }
})

test('a timeout marker row names the physical run', () => {
  let clock = 0
  const f = headlessReaskFixture({
    now: () => clock,
    sleep: (ms) => { clock += ms },
    kill: () => { const err = new Error('permission denied'); err.code = 'EPERM'; throw err },
  })
  try {
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    assert.throws(() => f.io.wait(second.returnPath, 1), (err) => err.stage === 'headless-timeout')
    const marker = f.logs.find((row) => row.event === 'headless-timeout-marker-retained')
    assert.equal(marker.id, f.first.id)
    assert.equal(marker.run_id, 'd2')
  } finally { f.cleanup() }
})

test('wait collects the re-ask envelope from the caller path', () => {
  const f = headlessReaskFixture()
  try {
    const second = f.io.assign({ role: 'builder', briefFile: '/tmp/reask.md', reask: { id: f.first.id, returnPath: f.reaskPath } })
    const envelope = { assignment_id: f.first.id, role: 'builder', status: 'done' }
    writeFileSync(f.reaskPath, JSON.stringify(envelope))
    assert.deepEqual(f.io.wait(second.returnPath, 1), envelope)
  } finally { f.cleanup() }
})
