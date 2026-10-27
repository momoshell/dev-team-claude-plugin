// crew lanes [--all] [--json] — list lean lanes from their journals.
//
// Status, latest stage, stop reason and PR come from the lane journal only (the visualizer's lean source).
// Lean lanes record no pid, so this never says whether a lane's processes are alive or dead. A journal with
// unreadable rows is flagged on its status, since the status was read past a gap.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'

const NOT_RECORDED = 'not recorded'
const shown = (value) => (typeof value === 'string' && value !== '' ? value : NOT_RECORDED)
const statusOf = (row) => row.unreadable_rows > 0 ? `${shown(row.status)} (journal has ${row.unreadable_rows} unreadable rows)` : shown(row.status)

export function laneRows({ root, archiveRoot, all = false } = {}) {
  return createLeanSource({ crewRoot: root, archiveRoot }).listRuns()
    .filter((run) => all || !run.archived)
    .map((run) => ({
      lane: run.task_slug,
      status: run.status,
      latest_stage: run.latest_stage,
      reason: run.reason,
      pr: run.pr?.url ?? null,
      archived: run.archived,
      unreadable_rows: run.journal_skipped_malformed,
    }))
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { root: join(homedir(), '.crew'), stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const flags = new Set(['--all', '--json'])
  if (argv.some((arg) => !flags.has(arg))) {
    d.stderr('usage: crew lanes [--all] [--json]\n')
    return 2
  }
  const rows = laneRows({ root: d.root, archiveRoot: d.archiveRoot, all: argv.includes('--all') })
  if (argv.includes('--json')) d.stdout(`${JSON.stringify(rows, null, 2)}\n`)
  else for (const row of rows) {
    d.stdout(`${[row.lane, statusOf(row), shown(row.latest_stage), shown(row.reason), shown(row.pr), row.archived ? 'archived' : 'not archived'].join(' | ')}\n`)
  }
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
