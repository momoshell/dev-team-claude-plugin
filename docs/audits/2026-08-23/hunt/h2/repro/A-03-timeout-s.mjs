// `crew.mjs wait --timeout-s <x>`: crew/crew.mjs:2009
//   const timeoutMs = Number(args['timeout-s'] || 3600) * 1000
//   const deadline = Date.now() + timeoutMs
//   while (Date.now() < deadline) { ... }
// No validation at all. Compare --wait-<role> (crew/drive.mjs:74-85) and
// --plan-rounds (crew/limits.mjs:29-42), which both refuse from a closed set.
import { runCli } from './run.mjs'
const CREW = '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/crew.mjs'
const TASK = 'lensa-no-such-task-12345'
const cases = [
  ['(absent)', []],
  ['abc', ['--timeout-s', 'abc']],
  ['8080abc', ['--timeout-s', '8080abc']],
  ['NaN', ['--timeout-s', 'NaN']],
  ['-5', ['--timeout-s', '-5']],
  ['0', ['--timeout-s', '0']],
  ['bare flag', ['--timeout-s']],
  ['0x10', ['--timeout-s', '0x10']],
  ['1e3', ['--timeout-s', '1e3']],
  ['" 12 "', ['--timeout-s', ' 12 ']],
  ['1.5', ['--timeout-s', '1.5']],
  ['Infinity', ['--timeout-s', 'Infinity']],
  ['1e400', ['--timeout-s', '1e400']],
  ['empty string', ['--timeout-s', '']],
  ['9007199254740993', ['--timeout-s', '9007199254740993']],
]
for (const [name, extra] of cases) {
  const r = await runCli([CREW, 'wait', '--task', TASK, ...extra], { ms: 8000 })
  console.log(String(name).padEnd(20), 'exit=' + r.code, 'sig=' + r.signal, (r.ms + 'ms').padEnd(8), 'out=' + (r.out || '(none)').slice(0, 80))
}
