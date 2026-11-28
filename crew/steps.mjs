import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createLeanSource } from './lean-source.mjs'
import { TIERS } from './protocols.mjs'

const REPAIR = Object.freeze({ 'suite-repair': 'suite-red', 'ci-repair': 'ci-red', conflict: 'rebase-conflict' })
const TRIGGERS = Object.freeze([...Object.values(REPAIR), 'fast-check-red', 'proof-unproven', 'review-changes', 'finish-triage', 'replan', 'unclassified'])

function isoTime(value) {
  const date = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value)?.[1]
  // Date.parse accepts dates such as February 30 by rolling into March.
  if (!date || new Date(date).toJSON()?.slice(0, 10) !== date) return NaN
  return Date.parse(value)
}

const journalTime = (at) => typeof at === 'string' ? isoTime(at) : Number.isFinite(at) ? new Date(at).getTime() : NaN
const printTime = (at) => new Date(at).toJSON()

function* stoppedVerdicts(rows) {
  let lastStage = null
  for (const row of rows) {
    if (row.event === 'stage-start') lastStage = row.stage ?? null
    if (row.event === 'verdict' && row.status === 'stopped') {
      yield { row, kind: [row.reason ?? null, row.stage ?? lastStage, row.observation?.role ?? null] }
    }
  }
}

function conflictPaths(rows) {
  let paths = null
  const pending = rows.slice()
  while (pending.length) {
    for (const [key, value] of Object.entries(pending.pop())) {
      if (key === 'conflicts' && Array.isArray(value)) {
        paths ??= new Set()
        for (const path of value) if (typeof path === 'string') paths.add(path)
      }
      if (value !== null && typeof value === 'object') pending.push(value)
    }
  }
  return paths
}

function summarize(rows, spec) {
  const seat_turns = Object.create(null), finish_decisions = Object.create(null), repeat_builders = []
  let tier = TIERS.indexOf(spec.tier), suite_runs = 0, red_suites = 0, proof_runs = 0, has_pr = false
  let ci_checks = 0, greenCI = 0, red_ci_checks = 0, repair = null
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
    if (event === 'check' && row.check === 'ci' && (row.action === undefined || row.action === 'wait')) {
      ci_checks++
      if (result?.status === 'red') red_ci_checks++
      if (result?.status === 'green') greenCI++
    }
    if (event === 'check' && row.check === 'proof') {
      proof_runs++
      reason('proof', result?.status === 'red' ? 'proof-unproven' : null)
    }
    if (event === 'check' && row.check === 'fast-check') reason(row.check, result?.status === 'red' ? 'fast-check-red' : null)
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
  const gate = spec.suiteGate === 'ci' ? suite_runs === 0 && ci_checks === 1 && greenCI === 1 : suite_runs === 1
  const minimal = tier >= 0 && builder === 1 && gate && !Object.keys(finish_decisions).length && !Object.keys(extra).length
    && planner <= (mechanical ? 0 : 1) && reviewer === (mechanical ? 0 : 1) && techLead === (judge ? 1 : 0)
  return { seat_turns, suite_runs, red_suites, ci_checks, red_ci_checks, proof_runs, finish_decisions, has_pr, minimal, repeat_builders }
}

function report(source, since, now) {
  const lanes = [], stops = []
  const kinds = new Map(), previousKinds = new Set(), paths = new Map()
  let lanesWithStops = 0, lanesWithRepeatStops = 0, lanesWithConflicts = 0
  const previousSince = since - (now - since)
  const totals = {
    minimal_path: { minimal: 0, lanes_with_pr: 0 },
    repeat_builders: { by_trigger: Object.fromEntries(TRIGGERS.map((trigger) => [trigger, 0])), builder_turns: 0 },
    suites: { red: 0, runs: 0 },
    ci: { red: 0, checks: 0 },
    excluded: 0,
  }
  for (const found of source.lanes()) {
    const { rows, skipped_malformed, skipped_line_numbers, error } = source.readJournalRows(found)
    const first = rows[0]
    const at = journalTime(first?.at)
    // A skipped row before the first readable one leaves the start indeterminate.
    const previous = at < since && !(skipped_line_numbers[0] < first.line_number)
    if (previous && at < previousSince) continue
    const invalid = rows.find((row) => typeof row.event === 'string' && (!row.event.trim()
      || (row.event === 'seat-turn' && (typeof row.role !== 'string' || !row.role.trim()))
      || (row.event === 'finish-decision' && (typeof row.choice !== 'string' || !row.choice.trim()))))
    const reason = error ?? (skipped_malformed ? `task journal has ${skipped_malformed} unreadable rows`
      : !first ? 'task journal is empty' : !Number.isFinite(at) ? 'first journal row has no valid time'
        : invalid ? `task journal has an incomplete row at line ${invalid.line_number}` : null)
    if (previous) {
      if (!reason) for (const { kind } of stoppedVerdicts(rows)) previousKinds.add(JSON.stringify(kind))
      continue
    }
    const lane = { lane: found.lane, archived: found.archived }
    if (reason) {
      lanes.push({ ...lane, reason })
      totals.excluded++
      continue
    }
    let laneStops = 0
    for (const { row, kind } of stoppedVerdicts(rows)) {
      const [reason, stage, role] = kind
      const key = JSON.stringify(kind), time = journalTime(row.at)
      const { question, checks } = row.observation ?? {}
      stops.push({ lane: found.lane, at: printTime(time), reason, stage, role, question })
      if (!kinds.has(key)) kinds.set(key, { reason, stage, role, stops: 0, lanes: new Set(), first_at: Infinity, last_at: -Infinity, buckets: Object.create(null) })
      const group = kinds.get(key)
      group.stops++
      group.lanes.add(found.lane)
      laneStops++
      if (Number.isFinite(time)) {
        group.first_at = Math.min(group.first_at, time)
        group.last_at = Math.max(group.last_at, time)
      }
      if (Array.isArray(checks)) {
        const buckets = new Set(checks.map((check) => check?.bucket).filter((bucket) => typeof bucket === 'string' && bucket !== 'pass'))
        for (const bucket of buckets) group.buckets[bucket] = (group.buckets[bucket] ?? 0) + 1
      }
    }
    if (laneStops > 0) lanesWithStops++
    if (laneStops > 1) lanesWithRepeatStops++
    const lanePaths = conflictPaths(rows)
    if (lanePaths) {
      lanesWithConflicts++
      for (const path of lanePaths) paths.set(path, (paths.get(path) ?? 0) + 1)
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
    totals.ci.checks += steps.ci_checks
    totals.ci.red += steps.red_ci_checks
  }
  const stops_by_kind = {
    lanes_listed: lanes.length, lanes_with_stops: lanesWithStops, lanes_with_repeat_stops: lanesWithRepeatStops,
    kinds: [...kinds].map(([key, group]) => ({ ...group, lanes: group.lanes.size,
      first_at: printTime(group.first_at), last_at: printTime(group.last_at), new: !previousKinds.has(key) })),
  }
  const rebase_conflict_paths = {
    lanes_with_conflicts_lists: lanesWithConflicts,
    paths: [...paths].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, lanes]) => ({ path, lanes })),
  }
  return { lanes, totals, stops_by_kind, stops, rebase_conflict_paths }
}

const counts = (values) => Object.entries(values).map(([key, count]) => `${key}: ${count}`).join(', ') || 'none'

function printText({ lanes, totals, stops_by_kind, rebase_conflict_paths }, stdout) {
  for (const lane of lanes) {
    const name = `${lane.lane}${lane.archived ? ' (archived)' : ''}`
    stdout(lane.reason ? `${name} | excluded: ${lane.reason}\n` : [
      name, lane.started_at, lane.has_pr ? 'PR recorded' : 'no PR', lane.minimal ? 'minimal' : 'not minimal',
      `turns: ${counts(lane.seat_turns)}`, `suites: ${lane.red_suites} red of ${lane.suite_runs}`, `proofs: ${lane.proof_runs}`,
      `hand decisions: ${counts(lane.finish_decisions)}`,
      `builder repeats: ${lane.repeat_builders.map(({ turn, trigger }) => `#${turn} ${trigger}`).join(', ') || 'none'}`,
    ].join(' | ') + '\n')
  }
  const { minimal_path, repeat_builders, suites, ci, excluded } = totals
  stdout(`Minimal path: ${minimal_path.minimal} of ${minimal_path.lanes_with_pr} lanes with a PR\n`)
  stdout(`Builder repeats: ${Object.entries(repeat_builders.by_trigger).map(([trigger, n]) => `${trigger}: ${n} of ${repeat_builders.builder_turns}`).join(', ')} builder turns\n`)
  stdout(`Red suites: ${suites.red} of ${suites.runs} suite runs\nRed CI checks: ${ci.red} of ${ci.checks} CI checks\nExcluded lanes: ${excluded}\n`)
  const { lanes_listed, lanes_with_stops, lanes_with_repeat_stops, kinds } = stops_by_kind
  stdout(`Stops by kind: ${lanes_with_stops} of ${lanes_listed} lanes stopped; ${lanes_with_repeat_stops} of ${lanes_listed} lanes stopped more than once\n`)
  for (const kind of kinds) {
    const label = [kind.reason ?? 'unknown reason', kind.stage ?? 'unknown stage', kind.role].filter((value) => value !== null).join(' / ')
    const buckets = Object.entries(kind.buckets).map(([bucket, n]) => `${bucket}: ${n} of ${kind.stops} stops`)
    stdout(`${label}${kind.new ? ' (new)' : ''} | ${kind.stops} stops in ${kind.lanes} lanes | first: ${kind.first_at ?? 'unknown'}, last: ${kind.last_at ?? 'unknown'}${buckets.length ? ` | ${buckets.join(', ')}` : ''}\n`)
  }
  const { lanes_with_conflicts_lists, paths } = rebase_conflict_paths
  stdout(`Rebase-conflict paths: ${lanes_with_conflicts_lists} lanes with a conflicts list\n`)
  for (const { path, lanes } of paths.slice(0, 10)) stdout(`${JSON.stringify(path)}: ${lanes} of ${lanes_with_conflicts_lists} lanes\n`)
}

export function main(argv = process.argv.slice(2), {
  root = join(homedir(), '.crew'), archiveRoot, now = Date.now,
  stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text),
} = {}) {
  let values, since, currentTime
  try {
    const parsed = parseArgs({ args: argv, options: { since: { type: 'string' }, json: { type: 'boolean' } }, tokens: true })
    if (parsed.tokens.length !== new Set(parsed.tokens.map(({ name }) => name)).size || parsed.tokens.some(({ rawName, kind }) => kind !== 'option' || !rawName?.startsWith('--'))) throw new Error('invalid flags')
    values = parsed.values
    currentTime = now()
    since = values.since === undefined ? currentTime - 7 * 24 * 60 * 60 * 1000 : isoTime(values.since)
    if (!Number.isFinite(since)) throw new Error('invalid cutoff')
  } catch {
    stderr('usage: crew steps [--since <ISO date>] [--json]\n')
    return 2
  }
  let steps
  try { steps = report(createLeanSource({ crewRoot: root, archiveRoot }), since, currentTime) } catch (error) {
    stderr(`crew steps: ${error.message}\n`)
    return 1
  }
  if (values.json) stdout(`${JSON.stringify(steps, null, 2)}\n`)
  else printText(steps, stdout)
  return 0
}
