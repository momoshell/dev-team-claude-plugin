// A1-J1 behavioural proof for scripts/factory/seat-priors.mjs.
// Fixtures are compact synthetic JSONL under scratchDir; the real home
// ledger is touched only by I1's committed-byte reproduction, never mutated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, scratchDir } from './helpers.mjs';
import {
  computePriors,
  computeShadowReadout,
  main,
  readLedgerPrefix,
  renderPriorMarkdown,
  renderShadowMarkdown,
} from '../scripts/factory/seat-priors.mjs';
import {
  loadLadder,
  SHADOW_ABSENT,
  SHADOW_EXCLUSIONS,
  SHADOW_OUTCOMES,
  shadowExclusion,
} from '../crew/crew.mjs';
import { CELL_RATE_FLOOR } from '../scripts/factory/ledger.mjs';

const AT = '2026-09-21T00:00:00.000Z';

function line(kind, args, at = AT) {
  return `${JSON.stringify({ v: 1, kind, at, args })}\n`;
}

function start(adw, dispatch, role, model, session) {
  return line('startAgentSession', {
    adw_id: adw, dispatch_id: dispatch, role, model, claude_session_id: session,
    transcript_path: `/tmp/${session}.jsonl`, started_at: AT,
  });
}

function end(adw, session, volumes, endedAt = '2026-09-21T01:00:00.000Z') {
  return line('endAgentSession', {
    adw_id: adw, claude_session_id: session, ended_at: endedAt,
    billed_input_tokens: volumes.in, billed_output_tokens: volumes.out,
    billed_cache_write_tokens: volumes.write, billed_cache_read_tokens: volumes.read,
  });
}

function review(adw, dispatch, role, verdict, cell = {}) {
  return line('recordReviewOutcome', {
    adw_id: adw, dispatch_id: dispatch, role, verdict, created_at: AT,
    agent: cell.agent ?? null, provider: cell.provider ?? null,
    model_id: cell.model_id ?? null, model: cell.model ?? null,
    effort: cell.effort ?? null, transport: cell.transport ?? null,
  });
}

function runSeat(adw, role, cell) {
  return line('recordRunSeat', {
    adw_id: adw, role, agent: cell.agent, provider: cell.provider,
    model_id: cell.model_id, model: cell.model, effort: cell.effort,
    transport: cell.transport ?? 'headless-rpc', source: cell.source ?? 'roster',
    policy_state: 'passed', warnings_json: '[]', created_at: AT,
  });
}

function lane(adw, tier) {
  return line('startSession', {
    adw_id: adw, repo_slug: 'r', task_slug: 't', started_at: AT, tier,
  });
}

function writeLedger(dir, name, records) {
  const path = join(dir, name);
  writeFileSync(path, records.join(''), 'utf8');
  return path;
}

const PRICED_ROSTER = {
  models: {
    'synth/synth-a': {
      cost_in_per_mtok: 1, cost_out_per_mtok: 2,
      cost_cache_write_per_mtok: 3, cost_cache_read_per_mtok: 4,
    },
  },
  tiers: {},
};

const SYNTH_CELL = { agent: 'pi', provider: 'synth', model_id: 'synth-a', model: 'alpha-model', effort: 'medium' };
const priceOf = (v) => (v.in * 1 + v.out * 2 + v.write * 3 + v.read * 4) / 1e6;

test('A1', async () => {
  const dir = scratchDir('seat-priors-a1-');
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    start('adw-a1', 'd1', 'builder', 'alpha-model', 's-a1'),
    line('agent_sessions', { adw_id: 'adw-a1', role: 'builder', model: 'decoy-model' }),
    runSeat('adw-a1', 'builder', SYNTH_CELL),
  ]);
  const prefix = await readLedgerPrefix(ledger, 3);
  assert.equal(prefix.kindCounts.agent_sessions, 1);
  const priors = computePriors(prefix, { roster: PRICED_ROSTER });
  assert.equal(priors.rows.length, 1);
  assert.equal(priors.rows[0].role, 'builder');
  assert.equal(priors.rows[0].model, 'alpha-model');
});

test('B1', async () => {
  const dir = scratchDir('seat-priors-b1-');
  const early = { in: 100, out: 200, write: 300, read: 400 };
  const late = { in: 1000, out: 2000, write: 3000, read: 4000 };
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    start('adw-b1', 'd1', 'builder', 'beta-model', 's-b1'),
    runSeat('adw-b1', 'builder', { ...SYNTH_CELL, model: 'beta-model' }),
    end('adw-b1', 's-b1', late, '2026-09-21T02:00:00.000Z'),
    end('adw-b1', 's-b1', early, '2026-09-21T01:00:00.000Z'),
  ]);
  const prefix = await readLedgerPrefix(ledger, 4);
  const priors = computePriors(prefix, { roster: PRICED_ROSTER });
  assert.equal(priors.rows.length, 1);
  assert.equal(priors.rows[0].median_cost_usd, priceOf(early));
  assert.notEqual(priors.rows[0].median_cost_usd, priceOf(late));
});

test('C1', async () => {
  const dir = scratchDir('seat-priors-c1-');
  const volumes = { in: 100, out: 200, write: 300, read: 400 };
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    start('adw-c1', 'd1', 'builder', 'gamma-model', 's-c1'),
    runSeat('adw-c1', 'builder', { ...SYNTH_CELL, model: 'gamma-model' }),
    review('adw-c1', 'd1', 'builder', 'pass', { ...SYNTH_CELL, model: 'gamma-model' }),
    end('adw-c1', 's-c1', volumes),
    start('adw-c2', 'd1', 'planner', 'gamma-model', 's-c2'),
  ]);
  const prefix = await readLedgerPrefix(ledger, 5);
  const priors = computePriors(prefix, { roster: PRICED_ROSTER });
  assert.ok(priors.rows.length >= 2);
  for (const row of priors.rows) {
    assert.ok(Number.isInteger(row.review_n), `review_n for ${row.role}/${row.model}`);
    assert.ok(Number.isInteger(row.cost_n), `cost_n for ${row.role}/${row.model}`);
  }
  const markdown = renderPriorMarkdown(priors, {
    watermark: 5, kindCounts: prefix.kindCounts, rosterBlob: 'test-roster', ladderBlob: 'test-ladder',
  });
  assert.ok(markdown.includes('review_n'));
  assert.ok(markdown.includes('cost_n'));
  for (const row of priors.rows) {
    assert.ok(markdown.includes(`| ${row.review_n} |`), `report row carries review_n for ${row.role}/${row.model}`);
  }
});

test('D1', async () => {
  const dir = scratchDir('seat-priors-d1-');
  const records = [];
  const count = CELL_RATE_FLOOR - 1;
  for (let index = 0; index < count; index += 1) {
    records.push(start(`adw-d1-${index}`, 'd1', 'reviewer', 'delta-model', `s-d1-${index}`));
    records.push(review(`adw-d1-${index}`, 'd1', 'reviewer', index % 2 === 0 ? 'pass' : 'changes-needed'));
  }
  const ledger = writeLedger(dir, 'ledger.jsonl', records);
  const prefix = await readLedgerPrefix(ledger, records.length);
  const priors = computePriors(prefix, { roster: PRICED_ROSTER });
  assert.equal(priors.rows.length, 1);
  const row = priors.rows[0];
  assert.equal(row.review_n, CELL_RATE_FLOOR - 1);
  assert.equal(row.first_round_pass_rate, null);
  assert.ok(row.rate_absent.includes(String(CELL_RATE_FLOOR)));
  const markdown = renderPriorMarkdown(priors, {
    watermark: records.length, kindCounts: prefix.kindCounts, rosterBlob: 'test-roster', ladderBlob: 'test-ladder',
  });
  assert.ok(markdown.includes(`unmeasured (n=${count}`));
});

test('E1', async () => {
  const dir = scratchDir('seat-priors-e1-');
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    start('adw-e1', 'd1', 'builder', 'epsilon-model', 's-e1'),
  ]);
  const prefix = await readLedgerPrefix(ledger, 1);
  const priors = computePriors(prefix, { roster: PRICED_ROSTER });
  assert.equal(priors.rows.length, 1);
  const row = priors.rows[0];
  assert.equal(row.cost_n, 0);
  assert.equal(row.median_cost_usd, null);
  assert.notEqual(row.median_cost_usd, 0);
  assert.ok(typeof row.cost_absent === 'string' && row.cost_absent.length > 0);
  const markdown = renderPriorMarkdown(priors, {
    watermark: 1, kindCounts: prefix.kindCounts, rosterBlob: 'test-roster', ladderBlob: 'test-ladder',
  });
  assert.ok(markdown.includes('unmeasured (n=0'));
});

test('F1', async () => {
  const dir = scratchDir('seat-priors-f1-');
  const roster = {
    models: {},
    tiers: { build: { builder: { provider: 'nope', id: 'nope', agent: 'pi', effort: 'medium' } } },
  };
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    lane('adw-f1', 'build'),
    runSeat('adw-f1', 'builder', { agent: 'pi', provider: 'nope', model_id: 'nope', model: 'nope', effort: 'medium' }),
  ]);
  const prefix = await readLedgerPrefix(ledger, 2);
  const priors = computePriors(prefix, { roster });
  const shadow = computeShadowReadout(prefix, priors, { roster, ladder: loadLadder() });
  const seat = shadow.lanes.find((entry) => entry.tier === 'build').seats.builder;
  assert.ok(seat.candidates.length > 0);
  for (const candidate of seat.candidates) {
    assert.ok(candidate.excluded_by === null || SHADOW_EXCLUSIONS.includes(candidate.excluded_by));
  }
  assert.ok(seat.candidates.some((candidate) => candidate.excluded_by !== null));
  assert.throws(() => shadowExclusion('excluded'), /unknown shadow exclusion/);
});

test('G1', async () => {
  const dir = scratchDir('seat-priors-g1-');
  const roster = {
    models: {},
    tiers: { judge: { reviewer: { provider: 'nope', id: 'nope', agent: 'pi', effort: 'medium' } } },
  };
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    lane('adw-g1', 'judge'),
    runSeat('adw-g1', 'reviewer', { agent: 'pi', provider: 'nope', model_id: 'nope', model: 'nope', effort: 'medium' }),
  ]);
  const prefix = await readLedgerPrefix(ledger, 2);
  const priors = computePriors(prefix, { roster });
  const shadow = computeShadowReadout(prefix, priors, { roster, ladder: loadLadder() });
  for (const entry of shadow.lanes) assert.equal(entry.breaker_absent, SHADOW_ABSENT.breaker);
  const markdown = renderShadowMarkdown(shadow, {
    watermark: 2, kindCounts: prefix.kindCounts, underFloor: `${priors.underFloor} of ${priors.rows.length}`,
    rosterBlob: 'test-roster', ladderBlob: 'test-ladder',
  });
  assert.ok(markdown.includes(SHADOW_ABSENT.breaker));
  assert.ok(!markdown.includes('breaker_verdict healthy'));
  for (const outcome of Object.values(shadow.lanes.flatMap((entry) => Object.values(entry.seats)))) {
    assert.ok(SHADOW_OUTCOMES.includes(outcome.outcome));
  }
});

test('H1', async () => {
  const dir = scratchDir('seat-priors-h1-');
  const ledger = writeLedger(dir, 'ledger.jsonl', [
    lane('adw-h1', 'build'),
    start('adw-h1', 'd1', 'builder', 'eta-model', 's-h1'),
    review('adw-h1', 'd1', 'builder', 'pass'),
  ]);
  const watermark = 3;
  const first = await readLedgerPrefix(ledger, watermark);
  const firstPriors = computePriors(first, { roster: PRICED_ROSTER });
  const firstShadow = computeShadowReadout(first, firstPriors, { roster: PRICED_ROSTER, ladder: loadLadder() });
  const meta = { watermark, kindCounts: first.kindCounts, rosterBlob: 'test-roster', ladderBlob: 'test-ladder' };
  const priorBefore = renderPriorMarkdown(firstPriors, meta);
  const shadowBefore = renderShadowMarkdown(firstShadow, { ...meta, underFloor: `${firstPriors.underFloor} of ${firstPriors.rows.length}` });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(ledger, start('adw-h1-later', 'd1', 'builder', 'eta-model', 's-h1-later'));
  appendFileSync(ledger, review('adw-h1-later', 'd1', 'builder', 'pass'));
  const second = await readLedgerPrefix(ledger, watermark);
  const secondPriors = computePriors(second, { roster: PRICED_ROSTER });
  const secondShadow = computeShadowReadout(second, secondPriors, { roster: PRICED_ROSTER, ladder: loadLadder() });
  assert.equal(renderPriorMarkdown(secondPriors, meta), priorBefore);
  assert.equal(
    renderShadowMarkdown(secondShadow, { ...meta, underFloor: `${secondPriors.underFloor} of ${secondPriors.rows.length}` }),
    shadowBefore,
  );
});

test('I1', async (t) => {
  const dir = scratchDir('seat-priors-i1-');
  const records = [
    lane('adw-i1', 'build'),
    start('adw-i1', 'd1', 'builder', 'theta-model', 's-i1'),
    runSeat('adw-i1', 'builder', { ...SYNTH_CELL, model: 'theta-model' }),
    review('adw-i1', 'd1', 'builder', 'pass', { ...SYNTH_CELL, model: 'theta-model' }),
    end('adw-i1', 's-i1', { in: 100, out: 200, write: 300, read: 400 }),
  ];
  const ledger = writeLedger(dir, 'ledger.jsonl', records);
  const priorOut = join(dir, 'prior.md');
  const shadowOut = join(dir, 'shadow.md');
  await main(
    ['--ledger', ledger, '--watermark', String(records.length), '--prior-out', priorOut, '--shadow-out', shadowOut],
    { roster: PRICED_ROSTER },
  );
  assert.equal(readFileSync(priorOut, 'utf8').split('\n')[0], '# Observational seat priors');
  assert.equal(readFileSync(shadowOut, 'utf8').split('\n')[0], '# Shadow seat-pick readout');
  const committedPriorPath = join(ROOT, 'docs', 'audits', '2026-09-21', 'seat-priors', 'README.md');
  const committedShadowPath = join(ROOT, 'docs', 'audits', '2026-09-21', 'seat-priors', 'shadow-pick.md');
  const committedPrior = readFileSync(committedPriorPath, 'utf8');
  const committedShadow = readFileSync(committedShadowPath, 'utf8');
  assert.equal(committedPrior.split('\n')[0], '# Observational seat priors');
  assert.equal(committedShadow.split('\n')[0], '# Shadow seat-pick readout');
  const watermarked = committedPrior.match(/^watermark: (\d+)$/m);
  const shadowWatermarked = committedShadow.match(/^watermark: (\d+)$/m);
  assert.ok(watermarked && shadowWatermarked, 'committed reports name their watermark');
  assert.equal(shadowWatermarked[1], watermarked[1], 'both committed reports carry the same watermark');
  const watermark = Number(watermarked[1]);
  assert.ok(Number.isInteger(watermark) && watermark > 0);
  const rosterPinned = committedPrior.match(/^roster: crew\/roster\.json@([0-9a-f]{40})$/m);
  const ladderPinned = committedPrior.match(/^ladder: crew\/model-ladder\.json@([0-9a-f]{40})$/m);
  assert.ok(rosterPinned && ladderPinned, 'committed prior pins its roster and ladder inputs');
  const homeLedger = process.env.DEVTEAM_LEDGER_JSONL || join(homedir(), '.dev-team', 'factory', 'ledger.jsonl');
  if (!existsSync(homeLedger)) {
    t.diagnostic(`I1 blind spot: real-authority byte reproduction not measured — ledger absent at ${homeLedger}`);
    return;
  }
  const rePriorOut = join(dir, 'reprior.md');
  const reShadowOut = join(dir, 'reshadow.md');
  await main(['--ledger', homeLedger, '--watermark', String(watermark),
    '--roster-blob', rosterPinned[1], '--ladder-blob', ladderPinned[1],
    '--prior-out', rePriorOut, '--shadow-out', reShadowOut]);
  assert.equal(readFileSync(rePriorOut, 'utf8'), committedPrior,
    `prior bytes differ at watermark ${watermark} with pinned roster ${rosterPinned[1]} and pinned ladder ${ladderPinned[1]} — both inputs are pinned, so a mismatch is a real defect`);
  assert.equal(readFileSync(reShadowOut, 'utf8'), committedShadow,
    `shadow bytes differ at watermark ${watermark} with pinned roster ${rosterPinned[1]} and pinned ladder ${ladderPinned[1]} — both inputs are pinned, so a mismatch is a real defect`);
});

test('J1', async () => {
  const dir = scratchDir('seat-priors-j1-');
  const records = [
    lane('adw-j1', 'judge'),
    start('adw-j1', 'd1', 'reviewer', 'iota-model', 's-j1'),
    review('adw-j1', 'd1', 'reviewer', 'pass'),
  ];
  const ledger = writeLedger(dir, 'ledger.jsonl', records);
  chmodSync(ledger, 0o444);
  const outcome = await main(
    ['--ledger', ledger, '--watermark', String(records.length),
      '--prior-out', join(dir, 'prior.md'), '--shadow-out', join(dir, 'shadow.md')],
    { roster: PRICED_ROSTER },
  );
  assert.equal(outcome.watermark, records.length);
  const script = readFileSync(new URL('../scripts/factory/seat-priors.mjs', import.meta.url), 'utf8');
  for (const needle of ['agent_sessions', 'sqlite', 'SQLite', 'appendJsonl', 'UPDATE', 'INSERT', 'eval_cells', 'better-sqlite']) {
    assert.ok(!script.includes(needle), `reader source must not contain ${needle}`);
  }
  assert.ok(!/writeFileSync\s*\(\s*jsonlPath/.test(script));
  assert.ok(!/appendFileSync\s*\(\s*jsonlPath/.test(script));
  assert.ok(!/createWriteStream\s*\(\s*jsonlPath/.test(script));
});

test('R1', async () => {
  const src = readFileSync(new URL('./factory-seat-priors.test.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('I1 blind spot: real-authority byte reproduction not measured'), 'I1 keeps its blind-spot diagnostic');
  assert.ok(src.includes('if (!existsSync(homeLedger))'), 'I1 gates the real-authority half on ledger presence');
  const absent = join(scratchDir('seat-priors-r1-'), 'no-such-ledger.jsonl');
  await assert.rejects(() => readLedgerPrefix(absent, 1), /unreadable ledger/);
});

test('R2', async () => {
  const dir = scratchDir('seat-priors-r2-');
  const volumes = { in: 1000, out: 2000, write: 3000, read: 4000 };
  const records = [
    start('adw-r2', 'd1', 'builder', 'kappa-model', 's-r2'),
    runSeat('adw-r2', 'builder', { ...SYNTH_CELL, model: 'kappa-model' }),
    end('adw-r2', 's-r2', volumes),
  ];
  const ledger = writeLedger(dir, 'ledger.jsonl', records);
  const prefix = await readLedgerPrefix(ledger, records.length);
  const cheap = computePriors(prefix, { roster: PRICED_ROSTER });
  const dear = computePriors(prefix, {
    roster: {
      models: {
        'synth/synth-a': {
          cost_in_per_mtok: 10, cost_out_per_mtok: 20,
          cost_cache_write_per_mtok: 30, cost_cache_read_per_mtok: 40,
        },
      },
      tiers: {},
    },
  });
  assert.equal(cheap.rows.length, 1);
  assert.equal(dear.rows.length, 1);
  assert.ok(Number.isFinite(cheap.rows[0].median_cost_usd));
  assert.equal(dear.rows[0].median_cost_usd, cheap.rows[0].median_cost_usd * 10);
});
