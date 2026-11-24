// crew lanes [--all] [--json] — list lean lanes from their journals.
//
// Status, latest stage, stop reason and PR come from the lane journal only (crew/lean-source.mjs).
// A recorded pid can prove an open live run dead. A journal with
// unreadable rows is flagged on its status, since the status was read past a gap.
// The listing signals no process.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeBaseCi } from './base-ci-summary.mjs'
import { createLeanSource } from './lean-source.mjs'
import { probeAlive } from './run-pid.mjs'

const shown = (value) => (typeof value === 'string' && value !== '' ? value : 'not recorded')

function listedRuns({ root, archiveRoot, all, alive = probeAlive }) {
  return createLeanSource({ crewRoot: root, archiveRoot, alive }).listRuns().filter((run) => all || !run.archived)
}

const laneRow = (run) => ({
  lane: run.task_slug,
  status: run.status,
  latest_stage: run.latest_stage,
  reason: run.reason,
  pr: run.pr?.url ?? null,
  archived: run.archived,
  // null when the journal itself could not be read: its rows were never counted.
  unreadable_rows: run.journal_error === null ? run.journal_skipped_malformed : null,
  unreadable_rows_reason: run.journal_error,
  base_ci: run.base_ci,
})

export function laneRows(options = {}) {
  return listedRuns(options).map(laneRow)
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { root: join(homedir(), '.crew'), stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const flags = new Set(['--all', '--json'])
  if (argv.some((arg) => !flags.has(arg))) {
    d.stderr('usage: crew lanes [--all] [--json]\n')
    return 2
  }
  const runs = listedRuns({ root: d.root, archiveRoot: d.archiveRoot, all: argv.includes('--all'), alive: d.alive })
  if (argv.includes('--json')) d.stdout(`${JSON.stringify(runs.map(laneRow), null, 2)}\n`)
  else {
    const { bases, stops } = summarizeBaseCi(runs)
    for (const { repository, branch, state, reason, sha, recorded_at, lane } of bases) {
      d.stdout(`Base CI ${shown(repository)} ${shown(branch)}: ${shown(state)}${reason ? ` (${reason})` : ''} ${shown(sha?.slice(0, 8))} (recorded at lane start: ${lane}, ${shown(recorded_at)})\n`)
    }
    for (const { link, count } of stops) d.stdout(`ci-base-red: ${count} lane${count === 1 ? '' : 's'} stopped | ${link}\n`)
    for (const run of runs) {
      const row = laneRow(run)
      d.stdout(`${[row.lane, row.unreadable_rows > 0 ? `${shown(row.status)} (journal has ${row.unreadable_rows} unreadable rows)` : shown(row.status), shown(row.latest_stage), shown(row.reason), shown(row.pr), row.archived ? 'archived' : 'not archived'].join(' | ')}\n`)
    }
  }
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
