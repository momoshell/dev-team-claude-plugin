// B1b: the same measurement built from REAL `node --test --test-reporter=tap`
// bytes captured on this checkout (tap-one.txt = test/factory-make-brief.test.mjs,
// 71 tests, 15063 B). A real MULTI-file run emits one summary at the very END,
// so the body is repeated and exactly one summary is appended.
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { LAB_OUTPUT_CAP_BYTES, LAB_OUTPUT_CAP_LINES, parseTapSummary } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/pi/extensions/lab.ts'
const one = readFileSync(new URL('./tap-one.txt', import.meta.url), 'utf8')
const summaryAt = one.indexOf('\n1..')
const body = one.slice(one.indexOf('\n') + 1, summaryAt + 1)   // per-test blocks only
console.log(`one real test file: ${Buffer.byteLength(one)} B / ${one.split('\n').length} lines / 71 tests`)
console.log(`lab caps: ${LAB_OUTPUT_CAP_BYTES} B and ${LAB_OUTPUT_CAP_LINES} lines\n`)
const bound = (v) => {
  const t = Buffer.byteLength(v) > LAB_OUTPUT_CAP_BYTES
    ? new StringDecoder('utf8').write(Buffer.from(v).subarray(0, LAB_OUTPUT_CAP_BYTES)) : v
  const lines = t.split('\n')
  return lines.length > LAB_OUTPUT_CAP_LINES ? lines.slice(0, LAB_OUTPUT_CAP_LINES).join('\n') : t
}
for (const files of [1, 2, 3, 4, 8, 40]) {
  const n = 71 * files
  const whole = `TAP version 13\n${body.repeat(files)}1..${n}\n# tests ${n}\n# suites 0\n# pass ${n}\n# fail 0\n# duration_ms 1\n`
  let acc = ''
  for (const line of whole.split('\n')) acc = bound(`${acc}${line}\n`)
  const s = parseTapSummary(acc)
  console.log(`${String(files).padStart(2)} test file(s) / ${String(n).padStart(4)} tests = ${String(Buffer.byteLength(whole)).padStart(7)} B -> parseTapSummary(what runSuite kept) = ${JSON.stringify(s)}  ${s.pass === null ? '<== runSuite throws refusal "suite-failed"' : ''}`)
}
console.log('\nthis checkout ships 2162 passing tests across ~40 test files.')
