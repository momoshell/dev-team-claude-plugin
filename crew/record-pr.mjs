// crew record-pr <lane> --pr <url> — record the PR an operator hand-finished a stopped lean lane in.
//
// The loop writes a `pr` row when it publishes; a hand-finish never does, so the visualizer reads the lane
// as stopped forever. This appends ONE `pr` row, marked as written by the operator, to the lane's journal.
// It never rewrites a byte already there, never creates a journal, and refuses a lane that records a PR.
// The lane must already be stopped and quiet: there is no arbitration against a concurrent writer.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLeanSource } from '../visualizer/server/lean-source.mjs'

export class RecordPrRefusal extends Error {}

const LANE = /^[a-z0-9][a-z0-9-]{0,62}$/
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)$/
const refuse = (message) => { throw new RecordPrRefusal(message) }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function parsePrUrl(url) {
  const match = typeof url === 'string' ? PR_URL.exec(url) : null
  const number = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(number)) refuse('--pr must be https://github.com/<owner>/<repo>/pull/<number>')
  return { number, url }
}

function within(root, path) {
  try {
    const base = realpathSync(root), real = realpathSync(path)
    return real === base || real.startsWith(`${base}${sep}`)
  } catch { return false }
}

function parseRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { refuse('task journal has a malformed row; refusing to append') }
    if (!isObject(row)) refuse('task journal has a non-object row; refusing to append')
    rows.push(row)
  }
  if (!rows.length) refuse('task journal is empty')
  return rows
}

export function recordPr({ lane, url, root = join(homedir(), '.crew'), append = appendFileSync, now = Date.now } = {}) {
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
  const last = rows.findLast((row) => row.event !== 'stage-end')
  if (last?.event !== 'verdict' || last.status !== 'stopped') refuse(`lane ${lane} is not stopped; stop it and let it go quiet first`)
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
    const done = recordPr({ lane, url, root: d.root, append: d.append, now: d.now })
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
