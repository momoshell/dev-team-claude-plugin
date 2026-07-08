// scripts/trello.sh — offline checks only (no network, no keychain, no real creds).
// The env below forces every credential source to miss: TRELLO_NO_KEYCHAIN skips
// `security`, TRELLO_CRED_FILE points nowhere, and the key/token vars are unset.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'

const SCRIPT = join(ROOT, 'scripts', 'trello.sh')

const cleanEnv = {
  ...process.env,
  TRELLO_NO_KEYCHAIN: '1',
  TRELLO_CRED_FILE: '/nonexistent/trello-credentials',
  TRELLO_KEY: '',
  TRELLO_TOKEN: '',
}

function run(args, env = cleanEnv) {
  return spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' })
}

test('trello.sh exists and is executable', () => {
  accessSync(SCRIPT, constants.X_OK)
})

test('trello.sh parses (bash -n)', () => {
  execFileSync('bash', ['-n', SCRIPT])
})

test('help exits 0 and documents every subcommand', () => {
  const r = run(['help'])
  assert.equal(r.status, 0)
  for (const cmd of ['check', 'auth-url', 'board', 'lists', 'next-card', 'card', 'move', 'comment']) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `usage mentions ${cmd}`)
  }
})

test('no credentials: check exits 2 with setup instructions on stderr, nothing on stdout', () => {
  const r = run(['check'])
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /No Trello credentials found/)
  assert.match(r.stderr, /power-ups\/admin/)
  assert.match(r.stderr, /auth-url/)
})

test('auth-url with a key prints the never-expiring read,write authorize URL', () => {
  const r = run(['auth-url'], { ...cleanEnv, TRELLO_KEY: 'testkey123' })
  assert.equal(r.status, 0)
  const url = r.stdout.trim()
  assert.match(url, /^https:\/\/trello\.com\/1\/authorize\?/)
  assert.match(url, /expiration=never/)
  assert.match(url, /scope=read,write/)
  assert.match(url, /key=testkey123$/)
})

test('auth-url without a key exits 2 with setup instructions', () => {
  const r = run(['auth-url'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /No Trello credentials found/)
})

test('unknown subcommand exits 2', () => {
  const r = run(['bogus'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown command: bogus/)
})

test('subcommands with wrong arity fail before any network call', () => {
  // creds are present here, so a passing arity check would try the network —
  // the usage error must fire first (and instantly).
  const env = { ...cleanEnv, TRELLO_KEY: 'k', TRELLO_TOKEN: 't' }
  for (const args of [['board'], ['lists'], ['next-card'], ['card'], ['move', 'onlyone'], ['comment', 'onlyone']]) {
    const r = run(args, env)
    assert.equal(r.status, 2, `${args.join(' ')} exits 2`)
    assert.match(r.stderr, /usage: trello\.sh/, `${args.join(' ')} prints usage`)
  }
})

test('credentials never appear on stdout or stderr', () => {
  const env = { ...cleanEnv, TRELLO_KEY: 'sekretkey', TRELLO_TOKEN: 'sekrettoken' }
  // auth-url legitimately embeds the key (it's part of the authorize URL); the
  // token must never surface anywhere, on any code path that fails offline.
  for (const args of [['move', 'onlyone'], ['bogus'], ['help']]) {
    const r = run(args, env)
    assert.ok(!`${r.stdout}${r.stderr}`.includes('sekrettoken'), `${args.join(' ')} leaks the token`)
  }
})
