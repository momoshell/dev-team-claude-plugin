import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { scratchDir } from './helpers.mjs'

const script = fileURLToPath(new URL('../scripts/factory/skill-reads.mjs', import.meta.url))
function journal(root, name, rows) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
test('R1 skill-read rates distinguish measured rows, deduplicate paths, include archives and sort', () => {
  const root = scratchDir('skill-read-')
  journal(root, 'archive', [
    { at: 1780000000000, seat_turn_census: { transport: 'headless-rpc', role: 'builder', skill_reads: ['skills/lean-build/SKILL.md', 'skills/lean-build/SKILL.md'] } },
    { at: 1780000000000, seat_turn_census: { transport: 'headless-rpc', role: 'builder', skill_reads: [] } },
    { at: 1780000000000, seat_turn_census: { transport: 'headless-rpc', role: 'builder' } },
    { at: 1780000000000, seat_turn_census: { transport: 'headless-json', role: 'planner', skill_reads: ['skills/x/SKILL.md'] } },
    { at: 1780000000000, seat_turn_census: { transport: 'acp', role: 'builder', skill_reads: null } },
  ])
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /pi builder: 1 of 2 measured; 1 unmeasured/)
  assert.match(result.stdout, /pi builder skills\/lean-build\/SKILL\.md: 1 of 2/)
  assert.match(result.stdout, /claude planner: 1 of 1 measured; 0 unmeasured/)
  assert.match(result.stdout, /acp builder: 0 of 0 measured; 1 unmeasured/)
  const filtered = spawnSync(process.execPath, [script, '--root', root, '--since', '2026-06-01T00:00:00Z'], { encoding: 'utf8' })
  assert.equal(filtered.status, 0)
  assert.equal(filtered.stdout, '')
})
test('R2 skill-read empty roots and invalid options are bounded', () => {
  const root = scratchDir('skill-read-empty-')
  assert.equal(spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' }).stdout, '')
  assert.equal(spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' }).status, 2)
  assert.equal(spawnSync(process.execPath, [script, '--since', 'no-date'], { encoding: 'utf8' }).status, 2)
})
test('RV1-4 skill-read names and counts root traversal and invalid timestamp errors', () => {
  const parent = scratchDir('skill-read-root-')
  const missing = join(parent, 'does-not-exist')
  const traversal = spawnSync(process.execPath, [script, '--root', missing], { encoding: 'utf8' })
  assert.match(traversal.stderr, /1 root traversal errors/)
  assert.match(traversal.stderr, /does-not-exist/)
  const root = join(parent, 'invalid-time')
  journal(root, 'seat', [{ seat_turn_census: { transport: 'headless-rpc', role: 'builder', skill_reads: [] } }])
  const invalidTime = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  assert.match(invalidTime.stderr, /1 census timestamps missing or invalid/)
  assert.match(invalidTime.stderr, /journal\.jsonl:1/)
})

test('R3 skill-read names unreadable journals', () => {
  const root = scratchDir('skill-read-bad-')
  mkdirSync(join(root, 'seat', 'journal.jsonl'), { recursive: true })
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  assert.match(result.stderr, /1 unreadable journals/)
  assert.match(result.stderr, /journal\.jsonl/)
})
