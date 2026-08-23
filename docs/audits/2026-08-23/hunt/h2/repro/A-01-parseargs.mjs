// Characterize the shared parseArgs shape (factoryctl exports it; crew.mjs's is
// byte-identical: crew/crew.mjs:2127-2137 vs crew/factoryctl.mjs:13-22).
import { parseArgs } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/factoryctl.mjs'
const NUL = String.fromCharCode(0)
const cases = [
  ['repeated flag', ['--task', 'a', '--task', 'b']],
  ['empty value', ['--task', '']],
  ['equals form', ['--task=alpha']],
  ['equals form empty', ['--task=']],
  ['flag-like value', ['--task', '--checkout', '/tmp']],
  ['missing value at end', ['boot', '--task']],
  ['bare -- terminator', ['send', '--', 'run-1', 'hello']],
  ['-- then flag', ['--task', '--', 'x']],
  ['single dash value', ['--task', '-1']],
  ['negative number value', ['--timeout-s', '-5']],
  ['value with newline', ['--task', 'a\nb']],
  ['value with NUL', ['--task', 'a' + NUL + 'b']],
  ['msg starting with --', ['send', 'run-1', '--force reset']],
  ['flag name with spaces', ['--my flag', 'v']],
  ['triple dash', ['---task', 'v']],
  ['proto pollution', ['--__proto__', 'x', '--task', 't']],
  ['constructor key', ['--constructor', 'x']],
]
for (const [name, argv] of cases) {
  let out
  try { out = JSON.stringify(parseArgs(argv)) } catch (e) { out = 'THREW ' + e.message }
  console.log(name.padEnd(24), out)
}
const p = parseArgs(['--__proto__', 'boom', '--task', 't'])
console.log('proto own?', Object.prototype.hasOwnProperty.call(p, '__proto__'), 'keys:', Object.keys(p), 'polluted?', {}.boom)
