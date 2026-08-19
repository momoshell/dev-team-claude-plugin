import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  discoverLanes,
  hostLoad,
  journalAt,
  readJournal,
  watchPass,
} from '../scripts/factory/lane-watch.mjs'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'factory-lane-watch-'))
const NOW = Date.parse('2026-08-19T18:00:00.000Z')
let worldNumber = 0

const QUIET = {
  loadavg: () => [1, 1, 1],
  cpus: () => new Array(10).fill({ model: 'test' }),
  platform: 'darwin',
}

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString()
}

function world() {
  const root = join(fixtureRoot, `world-${++worldNumber}`)
  mkdirSync(root, { recursive: true })
  return root
}

function seedLane(root, {
  repo = 'dt-demo',
  task = 'demo-lane',
  journalLines = [],
  artifacts = [],
  settled = false,
} = {}) {
  const dir = join(root, repo, task)
  const taskDir = join(dir, 'task')
  mkdirSync(taskDir, { recursive: true })
  mkdirSync(join(dir, 'returns'), { recursive: true })
  writeFileSync(join(dir, 'crew.json'), JSON.stringify({ schema_version: 3, task, checkout: `/tmp/${repo}` }))
  writeFileSync(join(dir, 'journal.jsonl'), journalLines.map((line) => JSON.stringify(line)).join('\n') + (journalLines.length ? '\n' : ''))
  for (const artifact of artifacts) {
    const path = join(taskDir, artifact.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact.body ?? 'x')
    const when = (NOW - artifact.ageS * 1000) / 1000
    utimesSync(path, when, when)
  }
  if (settled) writeFileSync(join(dir, 'returns', 'task.json'), '{}')
  return { dir, taskDir, journal: join(dir, 'journal.jsonl') }
}

function limits(plan = 4, build = 5, review = 3) {
  return {
    at: iso(900_000),
    event: 'limits',
    plan_rounds: plan,
    build_rounds: build,
    review_rounds: review,
    source: { plan_rounds: 'flag', build_rounds: 'flag', review_rounds: 'default' },
  }
}

function pass(root, extra = {}) {
  return watchPass({
    root,
    now: NOW,
    silenceS: 300,
    loadThreshold: 4,
    deps: { ...QUIET, ...(extra.deps || {}) },
    ...extra.opts,
  })
}

function journalObjects(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function notesFor(path, kind) {
  return journalObjects(path).filter((line) => line.event === 'lane-watch' && (!kind || line.note === kind))
}

function snapshot(dir) {
  const out = {}
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else out[relative(dir, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(dir)
  return out
}

after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

test('the conjunction, both sides: b37-percheck-proof measured false positive is spared', () => {
  const staleRoot = world()
  const stale = seedLane(staleRoot, {
    task: 'wedged',
    journalLines: [limits(), { at: NOW - 645_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 700 }],
  })
  const staleResult = pass(staleRoot)
  const staleNotes = notesFor(stale.journal, 'silent-lane')
  assert.equal(staleNotes.length, 1)
  assert.equal(staleNotes[0].silent_s, 645)
  assert.equal(staleNotes[0].artifact_age_s, 700)
  assert.equal(staleResult.notes.filter((note) => note.note === 'silent-lane').length, 1)

  const liveRoot = world()
  const live = seedLane(liveRoot, {
    task: 'thinking',
    journalLines: [limits(), { at: NOW - 645_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'gate.mjs', ageS: 48 }],
  })
  const before = readFileSync(live.journal, 'utf8')
  pass(liveRoot)
  assert.equal(readFileSync(live.journal, 'utf8'), before)
  assert.deepEqual(notesFor(live.journal), [])
})

test('both journal at formats resolve the newer epoch and reject invalid values', () => {
  const root = world()
  const lane = seedLane(root, {
    journalLines: [
      { at: iso(900_000), event: 'seat-ready' },
      { at: NOW - 645_000, stage: 'plan:r1' },
    ],
    artifacts: [{ name: 'plan.md', ageS: 700 }],
  })
  const journal = readJournal(lane.journal)
  assert.equal(journal.lastActivityAt, NOW - 645_000)
  assert.equal(journal.lastStage, 'plan:r1')
  assert.equal(journalAt(undefined), null)
  assert.equal(journalAt('nonsense'), null)
  assert.equal(journalAt(0), 0)
  pass(root)
  assert.equal(notesFor(lane.journal, 'silent-lane')[0].silent_s, 645)
})

test('host load reports only measurable load over threshold', () => {
  const busy = hostLoad({
    threshold: 4,
    deps: { ...QUIET, loadavg: () => [240, 200, 180] },
  })
  assert.deepEqual(busy, {
    note: 'host-load',
    load_1m: 240,
    cores: 10,
    per_core: 24,
    threshold: 4,
    basis: 'os.loadavg()[0] / os.cpus().length',
  })
  assert.equal(hostLoad({ threshold: 4, deps: QUIET }), null)
  assert.equal(hostLoad({ threshold: 4, deps: { ...QUIET, platform: 'win32' } }), null)
  assert.equal(hostLoad({ threshold: 4, deps: { ...QUIET, loadavg: () => { throw new Error('interrupted') } } }), null)

  const root = world()
  const lane = seedLane(root, {
    journalLines: [{ at: NOW - 10_000, stage: 'build:r1' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  pass(root, { deps: { loadavg: () => [240, 200, 180] } })
  assert.equal(notesFor(lane.journal, 'host-load').length, 1)
})

test('budget notes use the recorded limits and fire on the last round', () => {
  const root = world()
  const last = seedLane(root, {
    repo: 'dt-a',
    task: 'last-round',
    journalLines: [limits(), { at: NOW - 10_000, stage: 'plan:r4' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  const mid = seedLane(root, {
    repo: 'dt-a',
    task: 'mid-round',
    journalLines: [limits(), { at: NOW - 10_000, stage: 'plan:r2' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  const short = seedLane(root, {
    repo: 'dt-b',
    task: 'flagged-short',
    journalLines: [limits(2), { at: NOW - 10_000, stage: 'plan:r2' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })
  const noLimits = seedLane(root, {
    repo: 'dt-b',
    task: 'without-limits',
    journalLines: [{ at: NOW - 10_000, stage: 'plan:r4' }],
    artifacts: [{ name: 'a.txt', ageS: 5 }],
  })

  pass(root)
  const lastNote = notesFor(last.journal, 'final-round')
  assert.equal(lastNote.length, 1)
  assert.deepEqual(
    { phase: lastNote[0].phase, round: lastNote[0].round, budget: lastNote[0].budget, source: lastNote[0].source },
    { phase: 'plan', round: 4, budget: 4, source: 'flag' },
  )
  assert.deepEqual(notesFor(mid.journal, 'final-round'), [])
  assert.equal(notesFor(short.journal, 'final-round')[0].budget, 2)
  assert.deepEqual(notesFor(noLimits.journal, 'final-round'), [])
})

test('nothing to report leaves a healthy journal byte-identical', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'healthy',
    journalLines: [{ at: NOW - 12_000, stage: 'build:r1' }],
    artifacts: [{ name: 'plan.md', ageS: 9 }],
  })
  const before = readFileSync(lane.journal, 'utf8')
  const result = pass(root)
  assert.equal(readFileSync(lane.journal, 'utf8'), before)
  assert.deepEqual(result.notes, [])
})

test('never acts: a pass only appends to the existing journal', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'writes',
    journalLines: [limits(), { at: NOW - 645_000, stage: 'plan:r1' }],
    artifacts: [{ name: 'task/gate.mjs', ageS: 700 }],
  })
  const before = snapshot(lane.dir)
  pass(root)
  const after = snapshot(lane.dir)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const key of Object.keys(before)) {
    if (key !== 'journal.jsonl') assert.equal(after[key], before[key], `${key} changed`)
  }
  assert.notEqual(after['journal.jsonl'], before['journal.jsonl'])
  assert.ok(after['journal.jsonl'].startsWith(before['journal.jsonl']))
})

test('finished lanes are not watched', () => {
  const root = world()
  const cases = [
    ['done', false],
    ['converge', false],
    ['escalate:build', false],
    ['plan:r1', true],
  ]
  const before = new Map()
  for (const [stage, settled] of cases) {
    const lane = seedLane(root, {
      repo: 'dt-finished',
      task: stage.replace(':', '-'),
      settled,
      journalLines: [{ at: NOW - 3_600_000, stage }],
      artifacts: [{ name: 'stale.txt', ageS: 3_600 }],
    })
    before.set(lane.journal, readFileSync(lane.journal, 'utf8'))
  }
  const result = pass(root)
  assert.deepEqual(result.lanes, [])
  assert.deepEqual(result.notes, [])
  for (const [journal, text] of before) assert.equal(readFileSync(journal, 'utf8'), text)
})

test('repeatability deduplicates unchanged notes and re-emits after journal activity', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'repeat',
    journalLines: [limits(), { at: NOW - 645_000, stage: 'plan:r4' }],
    artifacts: [{ name: 'plan.md', ageS: 700 }],
  })
  pass(root)
  const first = notesFor(lane.journal)
  assert.equal(first.length, 2)
  const afterFirst = readFileSync(lane.journal, 'utf8')
  pass(root)
  assert.equal(notesFor(lane.journal).length, first.length)
  assert.equal(readFileSync(lane.journal, 'utf8'), afterFirst)

  appendFileSync(lane.journal, `${JSON.stringify({ at: NOW - 400_000, event: 'seat-ready' })}\n`)
  pass(root)
  assert.equal(notesFor(lane.journal).length, 4)
})

test('discovery skips incomplete lanes, sorts, and tolerates an unreadable root', () => {
  const root = world()
  seedLane(root, { repo: 'repo-b', task: 'task-z' })
  seedLane(root, { repo: 'repo-a', task: 'task-z' })
  seedLane(root, { repo: 'repo-a', task: 'task-a' })

  const missingCrew = join(root, 'repo-a', 'missing-crew')
  mkdirSync(missingCrew, { recursive: true })
  writeFileSync(join(missingCrew, 'journal.jsonl'), '')
  const missingJournal = join(root, 'repo-b', 'missing-journal')
  mkdirSync(missingJournal, { recursive: true })
  writeFileSync(join(missingJournal, 'crew.json'), '{}')

  assert.deepEqual(
    discoverLanes(root).map((lane) => lane.id),
    ['repo-a/task-a', 'repo-a/task-z', 'repo-b/task-z'],
  )
  assert.deepEqual(discoverLanes(join(root, 'does-not-exist')), [])
})

test('a recent lane-watch line does not reset silence or self-silence the lane', () => {
  const root = world()
  const lane = seedLane(root, {
    task: 'self-silencing',
    journalLines: [
      { at: NOW - 645_000, stage: 'plan:r1' },
      { at: iso(5_000), event: 'lane-watch', note: 'host-load', key: 'host-load|old| |' },
    ],
    artifacts: [{ name: 'plan.md', ageS: 700 }],
  })
  const journal = readJournal(lane.journal)
  assert.equal(journal.lastActivityAt, NOW - 645_000)
  assert.equal(journal.notes.length, 1)
  pass(root)
  assert.equal(notesFor(lane.journal, 'silent-lane').length, 1)
  assert.equal(notesFor(lane.journal, 'silent-lane')[0].silent_s, 645)
})
