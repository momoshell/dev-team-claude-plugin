// crew lanes [--all] [--json] — list lean lanes from their journals.
//
// Status, latest stage, stop reason and PR come from the lane journal only (the visualizer's lean source).
// A recorded pid can prove an open live run dead. A journal with
// unreadable rows is flagged on its status, since the status was read past a gap.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'
import { deadRun, probeAlive } from './run-pid.mjs'
import { reapLaneSeats } from './seat-reap.mjs'

const shown = (value) => (typeof value === 'string' && value !== '' ? value : 'not recorded')

export function laneRows({ root, archiveRoot, all = false, alive = probeAlive } = {}) {
  const source = createLeanSource({ crewRoot: root, archiveRoot })
  return source.listRuns()
    .filter((run) => all || !run.archived)
    .map((run) => {
      const found = run.journal_error === null ? source.resolveLane(run.task_slug) : null
      const died = found && !run.archived && deadRun({ rows: source.readJournalRows(found).rows, taskDir: join(found.dir, 'task'), alive })
      return {
        lane: run.task_slug,
        status: died ? 'stopped' : run.status,
        latest_stage: run.latest_stage,
        reason: died ? 'run-died' : run.reason,
        pr: run.pr?.url ?? null,
        archived: run.archived,
        // null when the journal itself could not be read: its rows were never counted.
        unreadable_rows: run.journal_error === null ? run.journal_skipped_malformed : null,
        unreadable_rows_reason: run.journal_error,
      }
    })
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { root: join(homedir(), '.crew'), stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), kill: process.kill, spawnSync, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now: Date.now, ...deps }
  const flags = new Set(['--all', '--json'])
  if (argv.some((arg) => !flags.has(arg))) {
    d.stderr('usage: crew lanes [--all] [--json]\n')
    return 2
  }
  const rows = laneRows({ root: d.root, archiveRoot: d.archiveRoot, all: argv.includes('--all'), alive: d.alive })
  const source = createLeanSource({ crewRoot: d.root, archiveRoot: d.archiveRoot })
  for (const row of rows) {
    row.seats = { stopped: [], unproven: [] }
    if (row.archived) continue
    const found = source.resolveLane(row.lane)
    if (!found || found.archived) continue
    const journal = source.readJournalRows(found)
    if (journal.error !== null || !deadRun({ rows: journal.rows, taskDir: join(found.dir, 'task'), alive: d.alive })) continue
    row.seats = reapLaneSeats({ dir: found.dir, alive: d.alive ?? probeAlive, kill: d.kill, spawnSync: d.spawnSync, sleep: d.sleep, now: d.now })
  }
  if (argv.includes('--json')) d.stdout(`${JSON.stringify(rows, null, 2)}\n`)
  else for (const row of rows) {
    d.stdout(`${[row.lane, row.unreadable_rows > 0 ? `${shown(row.status)} (journal has ${row.unreadable_rows} unreadable rows)` : shown(row.status), shown(row.latest_stage), shown(row.reason), shown(row.pr), row.archived ? 'archived' : 'not archived'].join(' | ')}\n`)
  }
  if (!argv.includes('--json')) for (const row of rows) {
    for (const record of row.seats.stopped) d.stdout(`stopped seat ${record.role} pgid ${record.pgid}\n`)
    for (const record of row.seats.unproven) d.stdout(`seat ${record.role}${record.pgid == null ? '' : ` pgid ${record.pgid}`}: not proven stopped\n`)
  }
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
