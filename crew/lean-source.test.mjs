import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { createLeanSource } from './lean-source.mjs'
import { scratchDir } from '../test/helpers.mjs'

const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const members = { planner: { agent: 'pi' }, builder: { agent: 'pi' } }

function lane(root, name, rows, suffix = '') {
  const dir = join(root, `dt-${name}`, `${name}${suffix}`)
  put(join(dir, 'crew.json'), JSON.stringify({ members }))
  put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name, tier: 'build' }))
  put(join(dir, 'task', 'journal.jsonl'), jsonl(rows))
  put(join(dir, 'journal.jsonl'), jsonl([{ event: 'decoy' }]))
  return dir
}

test('a lane listing reads each journal once and a warm listing rereads no unchanged archived journal, even one with a blank first line', () => {
  const root = scratchDir('lean-reads-'), crewRoot = join(root, 'crew'), archiveRoot = join(root, 'archive')
  const original = fs.readFileSync
  try {
    const live = lane(crewRoot, 'live', [{ event: 'run-start', at: 1 }])
    const raised = lane(archiveRoot, 'raised', [{ event: 'run-start', at: 1 }, { event: 'tier-raised', to: 'judge', seats: { 'tech-lead': { agent: 'pi' } } }])
    const blank = lane(archiveRoot, 'blank', [{ event: 'run-start', at: 1 }])
    const malformed = lane(archiveRoot, 'malformed', [{ event: 'run-start', at: 1 }])
    put(join(blank, 'task', 'journal.jsonl'), '\n' + jsonl([{ event: 'run-start', at: 1 }]))
    put(join(malformed, 'task', 'journal.jsonl'), '{bad\n' + jsonl([{ event: 'run-start', at: 1 }]))
    const paths = [live, raised, blank, malformed].map((dir) => join(dir, 'task', 'journal.jsonl'))
    const counts = new Map(paths.map((path) => [path, 0]))
    fs.readFileSync = function (path, ...args) { if (counts.has(path)) counts.set(path, counts.get(path) + 1); return original.call(this, path, ...args) }
    syncBuiltinESMExports()
    const source = createLeanSource({ crewRoot, archiveRoot })
    source.listRuns()
    assert.equal(counts.get(paths[0]), 1)
    for (const path of paths) counts.set(path, 0)
    const runs = source.listRuns()
    assert.deepEqual(paths.map((path) => counts.get(path)), [1, 0, 0, 0])
    const run = runs.find((item) => item.goal === 'raised')
    assert.equal(run.tier, 'judge')
    assert.ok(run.seats.some((seat) => seat.role === 'tech-lead' && seat.agent === 'pi'))
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})

test('seat sessions of a crew.json member read no journal while a raised seat still resolves', () => {
  const root = scratchDir('lean-seat-reads-'), crewRoot = join(root, 'crew'), archiveRoot = join(root, 'archive')
  const original = fs.readFileSync
  try {
    const dir = lane(crewRoot, 'raised', [{ event: 'tier-raised', to: 'judge' }])
    put(join(dir, 'task', 'lean', 'tech-lead', 'raised.tech-lead.1.jsonl'), 'recorded\n')
    const journal = join(dir, 'task', 'journal.jsonl')
    let reads = 0
    fs.readFileSync = function (path, ...args) { if (path === journal) reads++; return original.call(this, path, ...args) }
    syncBuiltinESMExports()
    const source = createLeanSource({ crewRoot, archiveRoot })
    const { lane: found } = source.identify({ repo_slug: 'dt-raised', task_slug: 'raised', adw_id: 'lean:raised' })
    assert.equal(source.readSeatSessions(found, 'planner').status, 200)
    assert.equal(reads, 0)
    const result = source.readSeatSessions(found, 'tech-lead')
    assert.equal(result.status, 200)
    assert.equal(result.sessions[0].raw, 'recorded\n')
    assert.equal(reads, 1)
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})

