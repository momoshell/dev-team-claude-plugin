// Gate for LP1/LP2: builds hand-made lean lane journals in a temp crew root,
// reads them through the repo's lean source, and checks the derived state.
// Usage: node gate.mjs [repoRoot]   (default: process.cwd())
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(process.argv[2] ?? process.cwd())
const failures = []
const fail = (id, why) => failures.push(`FAIL ${id}: ${why}`)

let createLeanSource
try {
  ;({ createLeanSource } = await import(pathToFileURL(join(repoRoot, 'visualizer/server/lean-source.mjs')).href))
} catch (error) {
  fail('LP1', `cannot import lean-source.mjs: ${error.message}`)
  fail('LP2', `cannot import lean-source.mjs: ${error.message}`)
}

const PR = { number: 7, url: 'https://github.com/o/r/pull/7' }
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

if (createLeanSource) {
  const sandbox = mkdtempSync(join(tmpdir(), 'lanes-gate-'))
  try {
    const crewRoot = join(sandbox, '.crew')
    const archiveRoot = join(sandbox, '.crew-journal-archive')
    mkdirSync(archiveRoot, { recursive: true })
    const lane = (name, rows) => {
      const dir = join(crewRoot, `dt-${name}`, name)
      put(join(dir, 'crew.json'), JSON.stringify({ members: { planner: { agent: 'pi' } } }))
      put(join(dir, 'task', 'lean.json'), JSON.stringify({ id: name, tier: 'build' }))
      put(join(dir, 'task', 'journal.jsonl'), jsonl(rows))
    }
    const stopped = [
      { event: 'stage-start', stage: 'build' },
      { event: 'verdict', stage: 'build', status: 'stopped', reason: 'seat-unmeasured' },
      { event: 'stage-end', stage: 'build' },
    ]
    const ready = { event: 'finish-ready', status: 'ready-for-operator' }
    // LP1: finish --accept appends `pr` then `finish-decision`.
    lane('lp1', [...stopped, ready,
      { event: 'pr', lane: 'lp1', stage: 'publish', pr: PR },
      { event: 'finish-decision', lane: 'lp1', choice: 'accept', notesSha256: null }])
    // LP2: journal ends at finish-ready, no later decision.
    lane('lp2', [...stopped, ready])

    const runs = Object.fromEntries(
      createLeanSource({ crewRoot, archiveRoot }).listRuns().map((run) => [run.task_slug, run]))

    const lp1 = runs.lp1
    if (!lp1) fail('LP1', 'lane lp1 not listed')
    else {
      if (lp1.status !== 'done') fail('LP1', `status=${JSON.stringify(lp1.status)} expected "done"`)
      else if (lp1.running !== false) fail('LP1', `running=${JSON.stringify(lp1.running)} expected false`)
      else if (JSON.stringify(lp1.pr) !== JSON.stringify(PR)) fail('LP1', `pr=${JSON.stringify(lp1.pr)} expected ${JSON.stringify(PR)}`)
    }

    const lp2 = runs.lp2
    if (!lp2) fail('LP2', 'lane lp2 not listed')
    else {
      if (lp2.status !== 'running') fail('LP2', `status=${JSON.stringify(lp2.status)} expected "running" (as today)`)
      else if (lp2.running !== true) fail('LP2', `running=${JSON.stringify(lp2.running)} expected true`)
      else if (lp2.pr !== null) fail('LP2', `pr=${JSON.stringify(lp2.pr)} expected null`)
    }
  } catch (error) {
    if (!failures.length) { fail('LP1', `gate error: ${error.message}`); fail('LP2', `gate error: ${error.message}`) }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

for (const line of failures) console.log(line)
if (failures.length) process.exit(1)
console.log('PASS LP1 LP2')
