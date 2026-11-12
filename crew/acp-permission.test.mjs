import test from 'node:test'
import assert from 'node:assert/strict'
import { permissionHandler, readOnlyCommand, readOnlyCommandResult } from './acp-permission.mjs'
import * as permission from './acp-permission.mjs'

const toolCall = { title: 'shell', kind: 'execute', rawInput: { command: 'echo hi' } }
const options = [
  { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
  { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
  { kind: 'allow_always', name: 'Allow Always', optionId: 'always' },
]
// MUTATION: return allow_once regardless of permit
test('permissionHandler allows only what permit approves and has no lead path', () => {
  for (const [permit, choices, expected] of [
    [() => true, options, 'allow'],
    [() => false, options, 'reject'],
    [() => 'yes', options, 'reject'],
    [() => { throw Error('failed') }, options, 'reject'],
    [() => true, [{ kind: 'reject_once', optionId: 'no' }, { kind: 'allow_always', optionId: 'all' }], 'no'],
    [() => false, [{ kind: 'reject_always', optionId: 'no' }], 'no'],
    [() => true, [], null],
  ]) assert.equal(permissionHandler({ permit })({ toolCall, options: choices }), expected)
  for (const name of ['PERMISSION_POLICIES', 'PERMISSION_REFUSALS', 'permitQuestion']) assert.equal(name in permission, false)
})

test('B1 read-only command allowlist accepts ten safe commands and pipelines', () => {
  for (const command of [
    'git diff', 'git log --oneline', 'git show HEAD', 'git status --short', 'git blame file',
    'git rev-parse HEAD', 'git ls-files', 'git grep pattern', 'grep -n pattern file', 'rg pattern file',
    'cat file', 'head -n 2 file', 'tail file', 'wc -l file', 'ls -la', 'sed -n 1,4p file',
    "cat 'file name' | wc -l", 'git diff | head -n 5',
  ]) assert.equal(readOnlyCommand(command), true, command)
})

test('B2 read-only command allowlist rejects unsafe commands and malformed syntax', () => {
  for (const command of [
    'git push', 'git diff --output=file', 'git diff --ext-diff', 'git diff -Ofoo', 'git diff --open-files-in-pager=x',
    'git grep -lOrm foo', 'git grep --open=rm foo', 'git grep --open-files=rm foo',
    'rg --pre=cmd pattern', 'rg --hostname-bin=./scripts/x foo', 'sh -c true', 'echo hi', 'cat a > b',
    '| cat a', 'cat a |', 'cat a\\| wc',
    'cat $HOME', 'cat `pwd`', 'cat "unfinished', 'sed -e s/a/b/ file', 'git diff\\ > file',
    'cat a\ncat b', 'cat a\rcat b', 'cat (a)', 'cat {a}',
  ]) assert.equal(readOnlyCommand(command), false, String(command))
  for (const command of [null, undefined, 4, '', ' ', '\n']) assert.equal(readOnlyCommand(command), false)
})

const CHAINS = ['git status --short && git diff --stat && git diff -- crew/loop.mjs', 'git status&&git diff', 'git status || git log', 'git status;git show HEAD',
  'cat a && cat b | wc -l || cat c; ls', "git diff -- 'a;&&||.txt' && cat 'x > & ( )'"]

test('RC1 chains of read-only commands are allowed', () => {
  for (const command of CHAINS) {
    assert.equal(readOnlyCommand(command), true, command)
  }
})

test('RC2 a chain with any non-read-only segment is refused', () => {
  for (const command of ['git status && git push', 'git push && git status', 'git status || git push', 'git status; git push',
    'git status && git diff --output=f && cat a', 'git status | git push', 'git status && rm x ; cat a'])
    assert.equal(readOnlyCommand(command), false, command)
})

test('RC3 background, redirection, grouping, expansion and newlines in a chain stay refused', () => {
  for (const command of ['git status && git diff &', 'git status & git diff', 'git status && cat a > b', 'git status && cat < a', 'git status && cat a 2>e',
    'git status && (git diff)', 'git status && cat {a}', 'git status && cat $HOME', 'git status && cat `pwd`', 'git status && cat a\\ b',
    'git status && cat a\ncat b', 'git status && cat "a\nb"', '&& git status', 'git status &&', 'git status ;; git diff', 'git status &&& git diff',
    'git status ||| git diff', 'git status && cat "open'])
    assert.equal(readOnlyCommand(command), false, command)
})

test('RC4 the refusal names the first non-read-only segment and not later ones', () => {
  for (const [command, first, later] of [
    ['git status && git reset --hard && rm -rf never', 'git reset --hard', 'rm -rf never'],
    ['git status || git reset --hard ; rm -rf never', 'git reset --hard', 'rm -rf never'],
    ['cat f | git reset --hard | rm -rf never', 'git reset --hard', 'rm -rf never'],
    ['git status && git diff --output=x && rm -rf never', 'git diff --output=x', 'rm -rf never'],
    ['git status && cat a > b && rm -rf never', 'cat a > b', 'rm -rf never'],
    ['git status && git reset --hard && cat $HOME', 'git reset --hard', 'cat $HOME'],
  ]) {
    const result = readOnlyCommandResult(command)
    assert.equal(result.allowed, false, command)
    assert.ok(result.reason.includes(first), result.reason)
    assert.ok(!result.reason.includes(later), result.reason)
  }
  assert.deepEqual(readOnlyCommandResult('git status && cat a'), { allowed: true, reason: null })
})

test('RD1 a backslash inside a quoted argument is allowed only where the shell keeps it literal', () => {
  for (const command of [
    String.raw`grep -n "a\|b" file`, String.raw`grep -n 'a\|b' file`,
    String.raw`rg "foo\.bar" crew`, String.raw`git grep -n "x\|y"`,
  ]) assert.equal(readOnlyCommand(command), true, command)
  for (const command of [
    'cat "$(rm x)"', 'cat "`rm x`"', "cat '$HOME'", String.raw`cat a\ b`,
    String.raw`cat "x\" "; rm -rf y; cat "z"`, String.raw`grep "a\\b" f`,
    String.raw`grep "a\$b" f`, String.raw`grep 'a\'; rm -rf y`,
    'cat "a\\\nb"', 'cat "a\\\rb"', 'cat "a\\',
  ]) assert.equal(readOnlyCommand(command), false, command)
})

test('RD2 a cd with one directory argument may lead a read-only chain', () => {
  for (const command of ['cd crew && grep -n x loop.mjs', 'cd "dir name" && ls', 'cd /tmp/w; git status --short'])
    assert.equal(readOnlyCommand(command), true, command)
  for (const command of ['cd x && rm y', 'cd', 'cd a b', 'cd x; git push', 'cd $HOME && ls', 'cd x > f'])
    assert.equal(readOnlyCommand(command), false, command)
})

test('RD3 only exact 2>/dev/null and 2>&1 redirects are allowed on a read-only segment', () => {
  for (const command of [
    'grep -rn x crew 2>/dev/null', 'git log --oneline 2>&1 | head -n 5',
    'ls missing 2>/dev/null || ls', 'cd crew && rg x 2>/dev/null && cat a',
  ]) assert.equal(readOnlyCommand(command), true, command)
  for (const command of [
    'cat a 2>file', 'cat a 2> /dev/null', 'cat a 2>>/dev/null', 'cat a >/dev/null', 'cat a 1>&2',
    'cat a 2>/dev/nullx', 'cat a2>/dev/null', 'cat a 2>&1 > f', 'cat a 2>&1&', 'rm x 2>/dev/null', '2>/dev/null',
  ]) assert.equal(readOnlyCommand(command), false, command)
})

test('RV1-1 rejects git grep pager option aliases', () => {
  for (const command of ['git grep -lOrm foo', 'git grep --open=rm foo', 'git grep --open-files=rm foo'])
    assert.equal(readOnlyCommand(command), false, command)
})
