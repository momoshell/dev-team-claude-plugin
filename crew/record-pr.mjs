// crew record-pr <lane> --pr <url> — record the PR an operator hand-finished a stopped lean lane in.
//
// The loop writes a `pr` row when it publishes; a hand-finish never does, so the visualizer reads the lane
// as stopped forever. This appends ONE `pr` row, marked as written by the operator, to the lane's journal.
// It never rewrites a byte already there, never creates a journal, and refuses a lane that records a PR.
// The lane must already be stopped and quiet: there is no arbitration against a concurrent writer.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from './lean-source.mjs'
import { stateless, supersededReturn } from './lean-journal-order.mjs'
import { LANE, parseJournalRows, within } from './lane-core.mjs'
import { deadRun, probeAlive } from './run-pid.mjs'

class RecordPrRefusal extends Error {}

// A dot segment (`.` or `..`) is refused: a URL parser resolves it away and the link names another PR.
const PR_URL = /^https:\/\/github\.com\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?\/)[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)$/
const refuse = (message) => { throw new RecordPrRefusal(message) }

export function parsePrUrl(url) {
  const match = typeof url === 'string' ? PR_URL.exec(url) : null
  const number = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(number)) refuse('--pr must be https://github.com/<owner>/<repo>/pull/<number>')
  return { number, url }
}

function parseRows(text) {
  const rows = parseJournalRows(text, (kind) => refuse(kind === 'malformed' ? 'task journal has a malformed row; refusing to append' : 'task journal has a non-object row; refusing to append'))
  if (!rows.length) refuse('task journal is empty')
  return rows
}

export function recordPr({ lane, url, root = join(homedir(), '.crew'), append = appendFileSync, now = Date.now, alive = probeAlive } = {}) {
  if (typeof lane !== 'string' || !LANE.test(lane)) refuse('lane must be a lean lane slug')
  const pr = parsePrUrl(url)
  const found = createLeanSource({ crewRoot: root }).resolveLane(lane)
  if (!found) refuse(`no lean lane ${lane}`)
  const journal = join(found.dir, 'task', 'journal.jsonl')
  if (!within(found.dir, journal)) refuse('task journal is missing or resolves outside the lane')
  let text
  try { text = readFileSync(journal, 'utf8') } catch (error) { refuse(`task journal unreadable: ${error?.code ?? error?.message}`) }
  const rows = parseRows(text)
  if (rows.some((row) => row.event === 'pr')) refuse(`lane ${lane} already records a pull request`)
  const last = rows.findLast((row, index) => !stateless(rows, row, index) && !supersededReturn(rows, row, index))
  if (last?.event === 'finish-decision' && last.choice === 'abandon') refuse(`lane ${lane} was abandoned with crew finish --abandon and ended unpublished; record-pr does not record a pull request for it`)
  if ((last?.event !== 'verdict' || last.status !== 'stopped') && !deadRun({ rows, taskDir: join(found.dir, 'task'), alive })) refuse(`lane ${lane} is not stopped; stop it and let it go quiet first`)
  const row = { event: 'pr', lane, stage: 'operator', actor: 'operator', at: now(), pr }
  try {
    append(realpathSync(journal), `${text.endsWith('\n') ? '' : '\n'}${JSON.stringify(row)}\n`)
  } catch (error) { refuse(`could not append to the task journal: ${error?.code ?? error?.message}`) }
  return { lane, journal, archived: found.archived, pr }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const d = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text), ...deps }
  const [lane, flag, url, ...extra] = argv
  if (lane === undefined || lane.startsWith('-') || flag !== '--pr' || url === undefined || extra.length > 0) {
    d.stderr('usage: crew record-pr <lane> --pr https://github.com/<owner>/<repo>/pull/<number>\n')
    return 2
  }
  try {
    const done = recordPr({ lane, url, root: d.root, append: d.append, now: d.now, alive: d.alive })
    d.stdout(`recorded operator-written pr #${done.pr.number} for ${lane}${done.archived ? ' (archived lane)' : ''}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof RecordPrRefusal)) throw error
    d.stderr(`crew record-pr: ${error.message.replace(/\p{Cc}+/gu, ' ')}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
