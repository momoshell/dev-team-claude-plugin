// Observational role×model priors from the append-only JSONL authority.
//
// Reproducibility contract: this reader consumes ONLY the JSONL stream up to
// an explicit positive-integer watermark. It never opens the mutable mirror,
// never guesses a missing measurement, and never turns absence into zero.
// Rates appear only at CELL_RATE_FLOOR; everything below it is unmeasured
// with its denominator beside it.
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELL_RATE_FLOOR } from './ledger.mjs';
import {
  loadLadder,
  shadowPick,
  SHADOW_ABSENT,
  SHADOW_EXCLUSIONS,
  SHADOW_OUTCOMES,
} from '../../crew/crew.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_PRIOR_OUT = join(REPO_ROOT, 'docs', 'audits', '2026-09-21', 'seat-priors', 'README.md');
const DEFAULT_SHADOW_OUT = join(REPO_ROOT, 'docs', 'audits', '2026-09-21', 'seat-priors', 'shadow-pick.md');
const TIERS = ['mechanical', 'build', 'judge'];

const COST_ABSENT_REASONS = Object.freeze([
  'no-completed-session',
  'no-provider-model-identity',
  'ambiguous-provider-model-identity',
  'no-catalog-price',
  'incomplete-catalog-rates',
  'missing-token-volume',
]);

function fail(message) {
  throw new Error(`seat-priors: ${message}`);
}

function assertWatermark(value) {
  if (!Number.isInteger(value) || value <= 0) fail(`--watermark must be a positive integer, got ${JSON.stringify(value)}`);
  return value;
}

function homeDefaultJsonlPath() {
  return join(homedir(), '.dev-team', 'factory', 'ledger.jsonl');
}

function underTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

// The home JSONL is the live factory's authority. A test process that reached it
// would read 280k real records and, worse, make a green run depend on this
// machine's history. scripts/factory/ledger.mjs owns the same refusal for the
// mutable mirror (defaultDbPath, `home_ledger_under_test`); this is that rule for
// the JSONL, and it is why LEDGER_DOORS warrants this function.
export function defaultLedgerPath() {
  if (process.env.DEVTEAM_LEDGER_JSONL) return process.env.DEVTEAM_LEDGER_JSONL;
  const path = homeDefaultJsonlPath();
  if (underTest()) {
    fail(`defaultLedgerPath: refusing the home ledger at ${path} from a process under node --test — set DEVTEAM_LEDGER_JSONL to a temporary path in this process's own environment, or pass --ledger; scripts/factory/seat-priors.mjs owns this refusal [home_ledger_under_test]`);
  }
  return path;
}

// Read exactly the first `watermark` records. Lines past W are never parsed,
// so appending later records cannot move a pinned readout.
export async function readLedgerPrefix(jsonlPath, watermark) {
  assertWatermark(watermark);
  if (typeof jsonlPath !== 'string' || jsonlPath === '') fail('ledger path is absent');
  const records = [];
  const kindCounts = {};
  let position = 0;
  const ledgerInput = createReadStream(jsonlPath, { encoding: 'utf8' });
  const lines = createInterface({ input: ledgerInput, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(`malformed JSON at record ${position} in ${jsonlPath}`);
      }
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.kind !== 'string'
        || typeof parsed.args !== 'object' || parsed.args === null) {
        fail(`malformed record at position ${position} in ${jsonlPath}`);
      }
      records.push({ position, kind: parsed.kind, args: parsed.args });
      kindCounts[parsed.kind] = (kindCounts[parsed.kind] ?? 0) + 1;
      position += 1;
      if (position >= watermark) break
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') fail(`unreadable ledger ${jsonlPath}: no such file`);
    if (error && typeof error.message === 'string' && error.message.startsWith('seat-priors: ')) throw error;
    fail(`unreadable ledger ${jsonlPath}: ${error && error.message ? error.message : String(error)}`);
  } finally {
    lines.close();
    ledgerInput.destroy();
  }
  if (records.length < watermark) fail(`truncated ledger ${jsonlPath}: wanted ${watermark} records, found ${records.length}`);
  return { records, kindCounts, watermark };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sessionKey(adwId, sessionId) {
  return `${adwId ?? ''}\0${sessionId ?? ''}`;
}

function distinctPairs(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (row.provider == null || row.model_id == null) continue;
    const key = `${row.provider}/${row.model_id}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function priceSession({ identity, volumes, catalog }) {
  if (!identity) return { cost: null, reason: 'no-provider-model-identity' };
  if (identity.ambiguous) return { cost: null, reason: 'ambiguous-provider-model-identity' };
  const entry = catalog[`${identity.provider}/${identity.model_id}`];
  if (!entry) return { cost: null, reason: 'no-catalog-price' };
  const rates = [
    entry.cost_in_per_mtok,
    entry.cost_out_per_mtok,
    entry.cost_cache_write_per_mtok,
    entry.cost_cache_read_per_mtok,
  ];
  if (!rates.every((rate) => Number.isFinite(rate))) return { cost: null, reason: 'incomplete-catalog-rates' };
  const bricks = [volumes.in, volumes.out, volumes.write, volumes.read];
  if (!bricks.every((bulk) => Number.isFinite(bulk))) return { cost: null, reason: 'missing-token-volume' };
  const cost = (bricks[0] * rates[0] + bricks[1] * rates[1] + bricks[2] * rates[2] + bricks[3] * rates[3]) / 1e6;
  return { cost, reason: null };
}

function loadRoster(roster) {
  if (roster && typeof roster === 'object') return roster;
  return JSON.parse(readFileSync(join(REPO_ROOT, 'crew', 'roster.json'), 'utf8'));
}

function gitBlobSha(rel) {
  try {
    return execFileSync('git', ['rev-parse', `HEAD:${rel}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return execFileSync('git', ['hash-object', rel], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  }
}

function gitCatFile(sha) {
  return execFileSync('git', ['cat-file', '-p', sha], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// One observational row per observed (role, raw model) start cell. Review
// identity may come from outcome/run-seat records; role and raw model always
// come from the start record itself.
export function computePriors(prefix, { roster = null } = {}) {
  const records = Array.isArray(prefix) ? prefix : prefix.records;
  const catalog = loadRoster(roster).models ?? {};
  const starts = new Map();
  const completed = new Map();
  const runSeats = [];
  const outcomes = [];
  for (const rec of records) {
    const { kind, args, position } = rec;
    switch (kind) {
      case 'startSession':
        break;
      case 'recordRunSeat':
        runSeats.push({ position, ...args });
        break;
      case 'recordReviewOutcome':
        outcomes.push({ position, ...args });
        break;
      case 'startAgentSession': {
        const key = sessionKey(args.adw_id, args.claude_session_id);
        starts.set(key, {
          adw_id: args.adw_id ?? null,
          session: args.claude_session_id ?? null,
          dispatch_id: args.dispatch_id ?? null,
          role: args.role ?? null,
          model: args.model ?? null,
          position,
        });
        break;
      }
      case 'endAgentSession': {
        const key = sessionKey(args.adw_id, args.claude_session_id);
        const started = starts.get(key);
        if (started) completed.set(key, { ...started, ...args, end_position: position });
        break;
      }
      default:
        break;
    }
  }

  // First review per run/role by earliest stream position, never timestamps.
  const firstByRunRole = new Map();
  for (const review of outcomes) {
    if (review.adw_id == null || review.role == null) continue;
    const key = `${review.adw_id}\0${review.role}`;
    const kept = firstByRunRole.get(key);
    if (!kept || review.position < kept.position) firstByRunRole.set(key, review);
  }

  // Join each first review to its matching start by adw_id + role + dispatch.
  // Starts arrive in stream order, so the first pass already keeps the
  // latest start at or before the review; no second pass can find more.
  const reviewByStartKey = new Map();
  for (const review of firstByRunRole.values()) {
    let bestKey = null;
    let best = null;
    for (const [key, start] of starts) {
      if (start.adw_id !== review.adw_id || start.role !== review.role
        || start.dispatch_id !== review.dispatch_id) continue;
      if (best === null || (start.position <= review.position && start.position > best.position)) { best = start; bestKey = key; }
    }
    if (best !== null) reviewByStartKey.set(bestKey, review);
  }

  const cells = new Map();
  const reviewRowsByCell = new Map();
  for (const [key, start] of starts) {
    if (start.role == null || start.model == null) continue;
    const cellKey = `${start.role}\0${start.model}`;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = { role: start.role, model: start.model, starts: 0, reviews: [], costs: [], costReasons: [] };
      cells.set(cellKey, cell);
    }
    cell.starts += 1;
    const review = reviewByStartKey.get(key) ?? null;
    if (review !== null) cell.reviews.push(review.verdict === 'pass' ? 'pass' : 'other');

    const done = completed.get(key);
    const identity = resolveIdentity(start, review, runSeats);
    pushShadowReview(reviewRowsByCell, identity, review, start);
    if (!done) {
      cell.costReasons.push('no-completed-session');
      continue;
    }
    const priced = priceSession({
      identity,
      volumes: {
        in: done.billed_input_tokens,
        out: done.billed_output_tokens,
        write: done.billed_cache_write_tokens,
        read: done.billed_cache_read_tokens,
      },
      catalog,
    });
    if (priced.cost === null) cell.costReasons.push(priced.reason);
    else cell.costs.push(priced.cost);
  }

  const rows = [...cells.values()].map((cell) => {
    const reviews = cell.reviews;
    const costs = cell.costs;
    const review_n = reviews.length;
    const first_round_passes = reviews.filter((verdict) => verdict === 'pass').length;
    const cost_n = costs.length;
    const row = {
      role: cell.role,
      model: cell.model,
      starts: cell.starts,
      review_n: reviews.length, cost_n: costs.length,
      first_round_passes,
      first_round_pass_rate: review_n >= CELL_RATE_FLOOR ? first_round_passes / review_n : null,
      median_cost_usd: cost_n === 0 ? null : median(costs),
    };
    row.rate_absent = row.first_round_pass_rate === null
      ? (row.review_n === 0 ? 'no first-round review observed for this cell — UNMEASURED, never zero'
        : `only ${row.review_n} first-round reviews against a floor of ${CELL_RATE_FLOOR} — UNMEASURED, never a point estimate`)
      : null;
    row.cost_absent = row.median_cost_usd === null ? pluralCostReason(cell.costReasons) : null;
    return row;
  }).sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));

  const reviewRows = [...reviewRowsByCell.values()];
  const underFloor = rows.filter((row) => row.review_n < CELL_RATE_FLOOR).length;
  return { rows, reviewRows, underFloor };
}

function pluralCostReason(reasons) {
  const counts = new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const closed = top && COST_ABSENT_REASONS.includes(top[0]) ? top[0] : 'no-completed-session';
  return `${closed}: ${top ? top[1] : 0} session(s) unpriced — UNMEASURED, never zero`;
}

function resolveIdentity(start, review, runSeats) {
  const candidates = [];
  for (const seat of runSeats) {
    if (seat.adw_id === start.adw_id && seat.role === start.role) {
      candidates.push({ provider: seat.provider, model_id: seat.model_id, agent: seat.agent, effort: seat.effort });
    }
  }
  if (review && review.provider != null && review.model_id != null) {
    candidates.push({ provider: review.provider, model_id: review.model_id, agent: review.agent, effort: review.effort });
  }
  const distinct = distinctPairs(candidates);
  if (distinct.length === 0) return null;
  if (distinct.length > 1) return { ambiguous: true };
  const only = distinct[0];
  if (only.agent == null || only.effort == null) {
    const fleshed = candidates.find((row) => row.agent != null && row.effort != null
      && row.provider === only.provider && row.model_id === only.model_id);
    if (!fleshed) return { provider: only.provider, model_id: only.model_id, agent: null, effort: null };
    return fleshed;
  }
  return only;
}

function pushShadowReview(byCell, identity, review, start) {
  if (!review || !identity || identity.ambiguous) return;
  if (identity.provider == null || identity.model_id == null
    || identity.agent == null || identity.effort == null) return;
  const key = `${identity.provider}\0${identity.model_id}\0${identity.agent}\0${identity.effort}\0${start.role}`;
  let row = byCell.get(key);
  if (!row) {
    row = {
      provider: identity.provider, model_id: identity.model_id,
      agent: identity.agent, effort: identity.effort, role: start.role,
      reviews: 0, first_round_reviews: 0, first_round_passes: 0,
    };
    byCell.set(key, row);
  }
  row.reviews += 1;
  row.first_round_reviews += 1;
  if (review.verdict === 'pass') row.first_round_passes += 1;
}

// Non-decisive readout: the last recorded lane per tier, scored by the
// existing shadow picker with a null breaker. It decides nothing.
export function computeShadowReadout(prefix, priors, { roster = null, ladder = null } = {}) {
  const records = Array.isArray(prefix) ? prefix : prefix.records;
  const seated = loadRoster(roster);
  const steps = ladder ?? loadLadder();
  const lastLane = new Map();
  for (const rec of records) {
    if (rec.kind !== 'startSession') continue;
    if (!TIERS.includes(rec.args.tier)) continue;
    const kept = lastLane.get(rec.args.tier);
    if (!kept || rec.position > kept.position) lastLane.set(rec.args.tier, rec);
  }
  const seatsByRun = new Map();
  const sourcesByRun = new Map();
  for (const rec of records) {
    if (rec.kind !== 'recordRunSeat') continue;
    if (!seatsByRun.has(rec.args.adw_id)) {
      seatsByRun.set(rec.args.adw_id, {});
      sourcesByRun.set(rec.args.adw_id, {});
    }
    seatsByRun.get(rec.args.adw_id)[rec.args.role] = {
      provider: rec.args.provider ?? null,
      id: rec.args.model_id ?? null,
      agent: rec.args.agent ?? null,
      effort: rec.args.effort ?? null,
    };
    sourcesByRun.get(rec.args.adw_id)[rec.args.role] = {
      model: rec.args.source === 'operator_override' ? 'override' : 'roster',
    };
  }
  const lanes = TIERS.map((tier) => {
    const lane = lastLane.get(tier) ?? null;
    const adwId = lane ? lane.args.adw_id : null;
    const seats = (adwId && seatsByRun.get(adwId)) || {};
    const sources = (adwId && sourcesByRun.get(adwId)) || {};
    const pick = shadowPick({
      roster: seated, tier, seats, sources,
      ladder: steps, reviewRows: priors.reviewRows, breaker: null,
    });
    const renderedSeats = {};
    for (const [role, seat] of Object.entries(pick.seats)) {
      if (!SHADOW_OUTCOMES.includes(seat.outcome)) fail(`unknown shadow outcome ${JSON.stringify(seat.outcome)}`);
      const candidates = seat.candidates.map((candidate) => {
        const reason = candidate.excluded_by?.reason ?? null;
        if (reason !== null && !SHADOW_EXCLUSIONS.includes(reason)) {
          fail(`unknown shadow exclusion reason ${JSON.stringify(reason)}`);
        }
        return {
          provider: candidate.provider, id: candidate.id,
          agent: candidate.agent, effort: candidate.effort,
          eligible: candidate.eligible,
          excluded_by: candidate.excluded_by?.reason ?? null,
          excluded_detail: candidate.excluded_by?.detail ?? null,
          reviews: candidate.reviews,
          first_round_reviews: candidate.first_round_reviews,
          first_round_passes: candidate.first_round_passes,
          first_round_pass_rate: candidate.first_round_pass_rate,
          thin: candidate.thin,
          breaker_verdict: candidate.breaker_verdict,
        };
      });
      renderedSeats[role] = {
        outcome: seat.outcome, why: seat.why, seated: seat.seated,
        picked: seat.picked, changes_seat: seat.changes_seat, candidates,
      };
    }
    return {
      tier, adw_id: adwId, lane_position: lane ? lane.position : null,
      seats: renderedSeats,
      breaker_absent: SHADOW_ABSENT.breaker,
    };
  });
  return { lanes };
}

function formatRate(row) {
  if (row.first_round_pass_rate === null) return `unmeasured (n=${row.review_n}; ${row.rate_absent})`;
  return `${row.first_round_pass_rate.toFixed(3)} (n=${row.review_n})`;
}

function formatCost(row) {
  if (row.median_cost_usd === null) return `unmeasured (n=${row.cost_n}; ${row.cost_absent})`;
  return `$${row.median_cost_usd.toFixed(4)} (n=${row.cost_n})`;
}

function kindLines(kindCounts) {
  return Object.entries(kindCounts).sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `- ${kind}: ${count}`).join('\n');
}

export function renderPriorMarkdown(priors, { watermark, kindCounts, rosterBlob, ladderBlob }) {
  const under = priors.rows.filter((row) => row.review_n < CELL_RATE_FLOOR).length;
  const lines = [];
  lines.push('# Observational seat priors');
  lines.push('');
  lines.push('An observational, confounded prior over role×model cells — a starting belief for future study, not a verdict on any cell.');
  lines.push('');
  lines.push(`watermark: ${watermark}`);
  lines.push(`roster: crew/roster.json@${rosterBlob}`);
  lines.push(`ladder: crew/model-ladder.json@${ladderBlob}`);
  lines.push(`generation: \`node scripts/factory/seat-priors.mjs --watermark ${watermark} --roster-blob ${rosterBlob} --ladder-blob ${ladderBlob}\``);
  lines.push(`floor: CELL_RATE_FLOOR = ${CELL_RATE_FLOOR}`);
  lines.push(`under_floor_cells: ${under} of ${priors.rows.length}`);
  lines.push('');
  lines.push('## Consumed prefix');
  lines.push('');
  lines.push(kindLines(kindCounts));
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- Authority is the append-only JSONL stream read to the watermark above; later records are never parsed for this readout.');
  lines.push('- Role and raw model come from `startAgentSession`; review identity may come from outcome/run-seat records.');
  lines.push('- A run/role first review is the earliest stream position for that run and role; later rounds never move the prior.');
  lines.push('- A first-round pass rate is reported only at review_n >= CELL_RATE_FLOOR; anything below is UNMEASURED with its denominator shown.');
  lines.push('- A session is priced only with an unambiguous provider/model identity, four finite catalog rates, and four measured token volumes; otherwise the median is null with a closed reason — UNMEASURED, never zero.');
  lines.push('- Absence vocabulary is closed: rate absence carries its floor wording, cost absence carries one of no-completed-session, no-provider-model-identity, ambiguous-provider-model-identity, no-catalog-price, incomplete-catalog-rates, missing-token-volume.');
  lines.push('');
  lines.push('## Role x model cells');
  lines.push('');
  lines.push('| role | model | starts | review_n | first_round_passes | first_round_pass_rate | cost_n | median_cost_usd |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of priors.rows) {
    lines.push(`| ${row.role} | ${row.model} | ${row.starts} | ${row.review_n} | ${row.first_round_passes} | ${formatRate(row)} | ${row.cost_n} | ${formatCost(row)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function renderShadowMarkdown(shadow, { watermark, kindCounts, underFloor, rosterBlob, ladderBlob }) {
  const lines = [];
  lines.push('# Shadow seat-pick readout');
  lines.push('');
  lines.push('A non-decisive shadow readout: the picker observes the latest recorded lane per tier and changes nothing.');
  lines.push('');
  lines.push(`watermark: ${watermark}`);
  lines.push(`roster: crew/roster.json@${rosterBlob}`);
  lines.push(`ladder: crew/model-ladder.json@${ladderBlob}`);
  lines.push(`generation: \`node scripts/factory/seat-priors.mjs --watermark ${watermark} --roster-blob ${rosterBlob} --ladder-blob ${ladderBlob}\``);
  lines.push(`floor: CELL_RATE_FLOOR = ${CELL_RATE_FLOOR}`);
  lines.push(`under_floor_cells: ${underFloor}`);
  lines.push('');
  lines.push('## Consumed prefix');
  lines.push('');
  lines.push(kindLines(kindCounts));
  lines.push('');
  for (const lane of shadow.lanes) {
    lines.push(`## Lane ${lane.tier}`);
    lines.push('');
    if (lane.adw_id === null) {
      lines.push(`- lane: none recorded for tier ${lane.tier} inside this prefix — UNMEASURED, never a guess.`);
      lines.push(`- breaker: ${lane.breaker_absent}`);
      lines.push('');
      continue;
    }
    lines.push(`- lane: ${lane.adw_id} (prefix position ${lane.lane_position})`);
    lines.push(`- breaker: ${lane.breaker_absent}`);
    const roles = Object.keys(lane.seats);
    if (roles.length === 0) lines.push('- seats: none recorded for this lane — UNMEASURED, never a guess.');
    for (const role of roles) {
      const seat = lane.seats[role];
      lines.push(`- seat ${role}: outcome ${seat.outcome} — ${seat.why}`);
      lines.push(`  - seated: ${seat.seated.provider ?? 'null'}/${seat.seated.id ?? 'null'}/${seat.seated.agent ?? 'null'}/${seat.seated.effort ?? 'null'}`);
      lines.push(`  - picked: ${seat.picked ? `${seat.picked.provider}/${seat.picked.id}/${seat.picked.agent}/${seat.picked.effort}` : 'null'} (changes_seat: ${seat.changes_seat})`);
      for (const candidate of seat.candidates) {
        const rate = candidate.first_round_pass_rate === null
          ? `unmeasured (n=${candidate.first_round_reviews})`
          : `${candidate.first_round_pass_rate} (n=${candidate.first_round_reviews})`;
        const exclusion = candidate.excluded_by === null ? 'eligible' : `excluded_by: ${candidate.excluded_by}${candidate.excluded_detail ? ` — ${candidate.excluded_detail}` : ''}`;
        lines.push(`  - candidate ${candidate.provider}/${candidate.id}/${candidate.agent}/${candidate.effort}: ${exclusion}; rate ${rate}; breaker_verdict ${candidate.breaker_verdict ?? 'null (unmeasured)'}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--watermark') out.watermark = argv[index + 1];
    else if (token === '--ledger') out.ledger = argv[index + 1];
    else if (token === '--prior-out') out.priorOut = argv[index + 1];
    else if (token === '--shadow-out') out.shadowOut = argv[index + 1];
    else if (token === '--roster-blob') out.rosterBlob = argv[index + 1];
    else if (token === '--ladder-blob') out.ladderBlob = argv[index + 1];
    else fail(`unknown flag ${JSON.stringify(token)}`);
    if (token.startsWith('--')) index += 1;
  }
  return out;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export async function main(argv = [], { roster = null, ladder = null, rosterBlob = null, ladderBlob = null } = {}) {
  const flags = parseArgs(argv);
  if (flags.watermark === undefined) fail('--watermark <positive integer> is required');
  const watermark = assertWatermark(Number(flags.watermark));
  const jsonlPath = flags.ledger ?? defaultLedgerPath();
  const priorOut = flags.priorOut ?? DEFAULT_PRIOR_OUT;
  const shadowOut = flags.shadowOut ?? DEFAULT_SHADOW_OUT;
  // Pinned inputs: a blob flag replays the exact recorded roster/ladder, so a
  // later roster edit cannot move these bytes. Otherwise the live inputs are
  // read and their HEAD blob ids are recorded in the header.
  const rosterSha = flags.rosterBlob ?? rosterBlob ?? gitBlobSha(join('crew', 'roster.json'));
  const ladderSha = flags.ladderBlob ?? ladderBlob ?? gitBlobSha(join('crew', 'model-ladder.json'));
  const rosterDoc = flags.rosterBlob ? JSON.parse(gitCatFile(flags.rosterBlob)) : (roster ?? loadRoster(null));
  const steps = flags.ladderBlob
    ? loadLadder({ path: `blob:${flags.ladderBlob}`, readFile: () => gitCatFile(flags.ladderBlob) })
    : (ladder ?? loadLadder());
  const meta = {
    watermark, kindCounts: null, rosterBlob: rosterSha, ladderBlob: ladderSha,
  };
  const prefix = await readLedgerPrefix(jsonlPath, watermark);
  meta.kindCounts = prefix.kindCounts;
  const priors = computePriors(prefix, { roster: rosterDoc });
  const shadow = computeShadowReadout(prefix, priors, { roster: rosterDoc, ladder: steps });
  // Both byte strings are computed before either file is touched, so a
  // refusal never leaves one fresh report beside one stale report.
  const priorText = renderPriorMarkdown(priors, meta);
  const shadowText = renderShadowMarkdown(shadow, {
    ...meta, underFloor: `${priors.underFloor} of ${priors.rows.length}`,
  });
  writeAtomic(priorOut, priorText);
  writeAtomic(shadowOut, shadowText);
  const summary = [
    `watermark: ${watermark}`,
    `kind_counts: ${JSON.stringify(prefix.kindCounts)}`,
    `under_floor_cells: ${priors.underFloor} of ${priors.rows.length}`,
  ].join('\n');
  process.stdout.write(`${summary}\n`);
  return { watermark, kindCounts: prefix.kindCounts, underFloor: priors.underFloor, rows: priors.rows.length };
}

const invoked = process.argv[1] ? join(process.argv[1]) === join(fileURLToPath(import.meta.url)) : false;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
