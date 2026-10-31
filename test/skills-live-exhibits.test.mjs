import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const read = file => readFileSync(resolve(root, file), 'utf8')
const flat = text => text.replace(/\s+/g, ' ')
function docs(dir) {
  const files = readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? docs(`${dir}/${e.name}`) : e.name.endsWith('.md') ? [`${dir}/${e.name}`] : [])
  assert.ok(files.length, `no markdown in ${dir}`)
  return files
}
const qa = 'skills/qa-test-writing', backend = 'skills/backend-node', review = 'skills/pr-review'
const falsification = `${review}/references/falsification.md`
const section = (text, heading) => text.split(`## ${heading}`)[1]?.split('\n## ')[0] ?? ''

// MUTATION: append a tripwire declaration instruction to the scope heading.
test('SX1', () => {
  for (const file of docs(qa)) {
    const text = flat(read(file))
    assert.doesNotMatch(text, /\b(?:declar(?:e|es|ed|ing|ation(?:s)?)|list(?:s|ed|ing)?|enumerat(?:e|es|ed|ing))\b.{0,110}\btripwires?\b|\btripwires?\b.{0,80}\bdeclar(?:e|es|ed|ing|ation(?:s)?)\b/i, file)
    assert.doesNotMatch(text, /\borchestrator\b.{0,120}\b(?:author\w*|writ\w*|creat\w*|owns?)\b.{0,60}\bgate\b|\bgate\b.{0,70}\b(?:authored|written|created|owned)\b.{0,30}\borchestrator\b/i, file)
  }
  assert.match(flat(read(`${qa}/references/gates.md`)), /\bplanner\b.{0,30}\b(?:authors?|writes?|owns?)\b.{0,60}\bgate\b/i)
})

// MUTATION: add a deleted vocabulary as an exhibit.
test('SX2', () => {
  const all = docs(qa).map(read).join('\n')
  for (const name of ['guardedKill', 'MODIFIER_KINDS', 'openRun', 'foldRpcUsage', 'SHADOW_ABSENT', 'USAGE_ABSENT_CAUSES', 'CREW_BREAKER_THRESHOLD', 'KNOWN_FLAGS']) assert.ok(!all.includes(name), name)
  for (const name of ['proveMutations', 'runGate', 'CHECK_REASONS', 'crew/checks.mjs']) assert.ok(all.includes(name), name)
  const captures = read(`${qa}/references/captures.md`)
  assert.ok(!captures.includes('stream.jsonl'))
  for (const name of ['task/lean/<role>/<id>.jsonl', 'crew/show.mjs']) assert.ok(captures.includes(name))
  assert.match(read(`${qa}/references/absence.md`), /usage:\s*null/)
  assert.ok(read(`${qa}/references/absence.md`).includes('crew/pi/extensions/subagent.ts'))
})

// MUTATION: append a path with a line number to the evidence heading.
test('SX3', () => {
  for (const file of docs(backend)) assert.doesNotMatch(read(file), /[A-Za-z0-9_./-]+\.[A-Za-z][A-Za-z0-9_-]*:\d+(?:[-–]\d+)?|`:\d+(?:[-–]\d+)?/, file)
})

// MUTATION: append a missing review recipe to the falsification heading.
test('SX4', () => {
  for (const file of docs(review)) {
    const text = read(file)
    const tokens = new Set(text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:mjs|cjs|js|ts|jsonl|json|md|yaml|yml|txt)\b/g) ?? [])
    for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) if (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(token) && token.includes('/')) tokens.add(token)
    for (const token of text.match(/\bsol-[A-Za-z0-9_-]+\b/g) ?? []) tokens.add(token)
    for (const [, dest] of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) if (!/^(?:[a-z]+:|#)/i.test(dest)) tokens.add(dest.split('#')[0])
    for (const token of tokens) {
      const candidates = [resolve(root, token), resolve(root, dirname(file), token), resolve(root, review, token)]
      for (const [, base, parent] of text.matchAll(/`([^`/]+\.(?:json|md|mjs|ts))` under `([^`]+\/)`/g)) if (base === token) candidates.push(resolve(root, parent, base))
      assert.ok(candidates.some(p => p.startsWith(`${root}/`) && existsSync(p)), `${file}: unresolved ${token}`)
    }
  }
})

// MUTATION: replace the impact floor with a style-only finding rule.
test('SX5', () => {
  const text = read(falsification), prose = flat(section(text, 'Falsify before you write'))
  assert.ok(prose.includes('Report a finding only when its wrong outcome reaches a user, an operator, data, or a security boundary.'))
  assert.ok(prose.includes('A preference, wording, or style point alone is not a finding.'))
  for (const severity of ['must-fix', 'should-fix', 'consider']) assert.ok(text.includes(severity))
})

// MUTATION: permit reporting a variant covered by a recorded ruling.
test('SX6', () => {
  assert.ok(flat(section(read(falsification), 'Rulings persist across rounds')).includes("Do not report a variant that a recorded ruling's rationale already covers."))
})
