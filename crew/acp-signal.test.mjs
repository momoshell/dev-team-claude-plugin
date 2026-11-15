import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { signalCommandResult, SIGNAL_REFUSAL } from './acp-signal.mjs'

test('signalCommandResult classifies kill forms and leaves other commands alone', () => {
  const imports = [...readFileSync(new URL('./acp-signal.mjs', import.meta.url), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.ok(imports.length > 0 && imports.every((name) => name.startsWith('node:')))
  const table = '901 1 901\n902 901 901\n950 902 950\n951 950 950\n96587 1 96587\n96625 96587 950\n'
  const cases = [
    ['kill 950 951', true], ['cd /tmp && kill 96587 96625', false], ['/bin/kill -9 950', true],
    ['kill -s TERM 950', true], ['kill -n 9 950', true], ['kill -n 9 96587', false], ['kill -TERM 950', true], ['kill -0 950', true], ['kill -0 96587', false],
    ['kill 0 %1 $!', true], ['kill -l', true], ['kill -L', true], ['kill', true],
    ['kill -9 -901', true], ['kill -- -901', true], ['kill -9 -950', false], ['kill -- -1', false],
    ['kill -9 -999', false], ['kill 96587', false], ['kill 999', false],
    ['pkill -f nextest', false], ['killall cargo', false], ['ps ax | xargs kill', false],
    ["printf '%s\\n' 96587 | xargs sh -c 'kill \"$@\"' sh", false],
    ['ps ax | kill 950', false], ['kill $(pgrep nextest)', false], ['kill $PID', false],
    ['sh -c "kill 96587"', false], ["bash -c 'kill 950'", true], ['echo $(kill 96587)', false],
    ['echo `kill 96587`', false], ["grep -n kill f", true], ['git log --grep "kill"', true],
    ["printf '%s' 'kill 1'", true], ['cat <<EOF\nkill 1\nEOF\necho done', true], ['cat <<\'END-1\'\nkill 1\nEND-1', true],
    ['echo "kill', false], ['echo $(kill 1', false], ['VAR=x kill 96587', false],
    ['if true; then kill 96587; fi', false], ['(kill 96587)', false], ['{ kill 96587; }', false],
    ['if true; then kill 950; fi', true], ['(kill 950)', true], ['{ kill 950; }', true],
    ['cat <<EOF\n$(kill 96587)\nEOF', false], ['cat <<EOF\n`kill 96587`\nEOF', false],
    ["cat <<'EOF'\n$(kill 96587)\nEOF", true], ['cat <<EOF\n$(kill 950)\nEOF', true],
    ['kill 950 2>/dev/null', true], ['kill 950 >/dev/null 2>&1', true], ['kill 96587 2>/dev/null', false],
    ['kill 950 # stop our child', true], ['kill 96587 # foreign', false], ['echo ok # comment\nkill 96587', false],
    ['kill 950 "#literal"', false], ['kill 950 \\#literal', false], ["echo 'kill #literal'", true],
  ]
  for (const wrapper of ['xargs', 'sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'timeout', 'nice', 'time', 'setsid']) cases.push([`${wrapper} kill 950`, false])
  for (const [command, allowed] of cases) {
    assert.deepEqual(signalCommandResult(command, { root: 901, processTable: () => table }), { allowed, reason: allowed ? null : SIGNAL_REFUSAL }, command)
  }
  for (const command of ['echo hello', 'grep kill f', 'kill 0 %1 $!', 'kill -l', 'kill']) {
    assert.equal(signalCommandResult(command, { root: 0, processTable: () => { throw Error('must not run') } }).allowed, true, command)
  }
  for (const root of [0, 1, NaN, 1.5, undefined]) assert.equal(signalCommandResult('kill 950', { root, processTable: () => table }).allowed, false)
  for (const processTable of [() => { throw Error('timeout') }, () => '', () => '901 1 901\n']) assert.equal(signalCommandResult('kill 950', { root: 901, processTable }).allowed, false)
})
