import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createLeanSource } from './lean-source.mjs'
import { TIERS } from './protocols.mjs'

const REPAIR = Object.freeze({ 'suite-repair': 'suite-red', conflict: 'rebase-conflict' })
const TRIGGERS = Object.freeze([...Object.values(REPAIR), 'proof-unproven', 'review-changes', 'finish-triage', 'replan', 'unclassified'])

function isoTime(value) {
  const date = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value)?.[1]
  // Date.parse accepts dates such as February 30 by rolling into March.
  if (!date || new Date(date).toJSON()?.slice(0, 10) !== date) return NaN
  return Date.parse(value)
}

function summarize(rows, spec) {
  const seat_turns = Object.create(null), finish_decisions = Object.create(null), repeat_builders = []
  let tier = TIERS.indexOf(spec.tier), suite_runs = 0, red_suites = 0, proof_runs = 0, has_pr = false
  let repair = null
  const buildReasons = new Map()
  // Keep the latest evidence per source; a result can replace or withdraw it.
  const reason = (source, trigger) => {
    buildReasons.delete(source)
    if (trigger) buildReasons.set(source, trigger)
  }
  for (const row of rows) {
    const { event, stage, role, result } = row
    if (event === 'roster' || event === 'tier-raised') tier = Math.max(tier, TIERS.indexOf(event === 'roster' ? row.tier : row.to))
    if (event === 'pr') has_pr = true
    if (event === 'run-start' || event === 'pr' || event === 'finish-ready' || (event === 'verdict' && row.status === 'stopped')) {
      repair = null
      buildReasons.clear()
    }
    if (event === 'stage-start') {
      if (Object.hasOwn(REPAIR, stage)) repair = stage
      if (stage === 'base-paths') reason(stage, 'finish-triage')
      if (stage === 'replan') reason(stage, 'replan')
    }
    if (event === 'stage-end' && stage === repair) repair = null
    if (event === 'check' && row.check === 'suite') {
      suite_runs++
      if (result?.status === 'red') red_suites++
    }
    if (event === 'check' && row.check === 'proof') {
      proof_runs++
      reason('proof', result?.status === 'red' ? 'proof-unproven' : null)
    }
    if ((event === 'verdict' && row.status === 'reviewed') || event === 'review-reused') {
      reason(role ?? 'reviewer', row.verdict === 'changes-needed' ? 'review-changes' : null)
    }
    if (event === 'finish-decision') finish_decisions[row.choice] = (finish_decisions[row.choice] ?? 0) + 1
    if (event === 'seat-turn') {
      const turn = seat_turns[role] = (seat_turns[role] ?? 0) + 1
      if (role !== 'builder') continue
      // The stage chosen by the loop settles overlapping review and suite results.
      const trigger = repair && repair === stage ? REPAIR[repair] : stage === 'build' ? [...buildReasons.values()].at(-1) : null
      if (turn > 1) repeat_builders.push({ turn, trigger: trigger ?? 'unclassified' })
      repair = null
      buildReasons.clear()
    }
  }
  const mechanical = TIERS[tier] === 'mechanical', judge = TIERS[tier] === 'judge'
  const { planner = 0, builder = 0, reviewer = 0, 'tech-lead': techLead = 0, ...extra } = seat_turns
  const minimal = tier >= 0 && builder === 1 && suite_runs === 1 && !Object.keys(finish_decisions).length && !Object.keys(extra).length
    && planner <= (mechanical ? 0 : 1) && reviewer === (mechanical ? 0 : 1) && techLead === (judge ? 1 : 0)
  return { seat_turns, suite_runs, red_suites, proof_runs, finish_decisions, has_pr, minimal, repeat_builders }
}

function report(source, since) {
  const lanes = []
  const totals = {
    minimal_path: { minimal: 0, lanes_with_pr: 0 },
    repeat_builders: { by_trigger: Object.fromEntries(TRIGGERS.map((trigger) => [trigger, 0])), builder_turns: 0 },
    suites: { red: 0, runs: 0 },
    excluded: 0,
  }
  for (const found of source.lanes()) {
    const { rows, skipped_malformed, skipped_line_numbers, error } = source.readJournalRows(found)
    const first = rows[0]
    const at = typeof first?.at === 'string' ? isoTime(first.at) : Number.isFinite(first?.at) ? new Date(first.at).getTime() : NaN
    if (at < since && !(skipped_line_numbers[0] < first.line_number)) continue
    const invalid = rows.find((row) => typeof row.event === 'string' && (!row.event.trim()
      || (row.event === 'seat-turn' && (typeof row.role !== 'string' || !row.role.trim()))
      || (row.event === 'finish-decision' && (typeof row.choice !== 'string' || !row.choice.trim()))))
    const reason = error ?? (skipped_malformed ? `task journal has ${skipped_malformed} unreadable rows`
      : !first ? 'task journal is empty' : !Number.isFinite(at) ? 'first journal row has no valid time'
        : invalid ? `task journal has an incomplete row at line ${invalid.line_number}` : null)
    const lane = { lane: found.lane, archived: found.archived }
    if (reason) {
      lanes.push({ ...lane, reason })
      totals.excluded++
      continue
    }
    const steps = summarize(rows, found.spec)
    lanes.push({ ...lane, started_at: new Date(at).toISOString(), ...steps })
    if (steps.has_pr) {
      totals.minimal_path.lanes_with_pr++
      if (steps.minimal) totals.minimal_path.minimal++
    }
    totals.repeat_builders.builder_turns += steps.seat_turns.builder ?? 0
    for (const { trigger } of steps.repeat_builders) totals.repeat_builders.by_trigger[trigger]++
    totals.suites.runs += steps.suite_runs
    totals.suites.red += steps.red_suites
  }
  return { lanes, totals }
}

const counts = (values) => Object.entries(values).map(([key, count]) => `${key}: ${count}`).join(', ') || 'none'

function printText({ lanes, totals }, stdout) {
  for (const lane of lanes) {
    const name = `${lane.lane}${lane.archived ? ' (archived)' : ''}`
    stdout(lane.reason ? `${name} | excluded: ${lane.reason}\n` : [
      name, lane.started_at, lane.has_pr ? 'PR recorded' : 'no PR', lane.minimal ? 'minimal' : 'not minimal',
      `turns: ${counts(lane.seat_turns)}`, `suites: ${lane.red_suites} red of ${lane.suite_runs}`, `proofs: ${lane.proof_runs}`,
      `hand decisions: ${counts(lane.finish_decisions)}`,
      `builder repeats: ${lane.repeat_builders.map(({ turn, trigger }) => `#${turn} ${trigger}`).join(', ') || 'none'}`,
    ].join(' | ') + '\n')
  }
  const { minimal_path, repeat_builders, suites, excluded } = totals
  stdout(`Minimal path: ${minimal_path.minimal} of ${minimal_path.lanes_with_pr} lanes with a PR\n`)
  stdout(`Builder repeats: ${Object.entries(repeat_builders.by_trigger).map(([trigger, n]) => `${trigger}: ${n} of ${repeat_builders.builder_turns}`).join(', ')} builder turns\n`)
  stdout(`Red suites: ${suites.red} of ${suites.runs} suite runs\nExcluded lanes: ${excluded}\n`)
}

export function main(argv = process.argv.slice(2), {
  root = join(homedir(), '.crew'), archiveRoot, now = Date.now,
  stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text),
} = {}) {
  let values, since
  try {
    const parsed = parseArgs({ args: argv, options: { since: { type: 'string' }, json: { type: 'boolean' } }, tokens: true })
    if (parsed.tokens.length !== new Set(parsed.tokens.map(({ name }) => name)).size || parsed.tokens.some(({ rawName, kind }) => kind !== 'option' || !rawName?.startsWith('--'))) throw new Error('invalid flags')
    values = parsed.values
    since = values.since === undefined ? now() - 7 * 24 * 60 * 60 * 1000 : isoTime(values.since)
    if (!Number.isFinite(since)) throw new Error('invalid cutoff')
  } catch {
    stderr('usage: crew steps [--since <ISO date>] [--json]\n')
    return 2
  }
  let steps
  try { steps = report(createLeanSource({ crewRoot: root, archiveRoot }), since) } catch (error) {
    stderr(`crew steps: ${error.message}\n`)
    return 1
  }
  if (values.json) stdout(`${JSON.stringify(steps, null, 2)}\n`)
  else printText(steps, stdout)
  return 0
}
