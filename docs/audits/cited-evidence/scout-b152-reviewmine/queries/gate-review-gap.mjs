// Re-implementation of ledger.mjs gateReviewGap() (scripts/factory/ledger.mjs:2547)
// run READ-ONLY. The CLI verb is not invoked because openLedger() opens the db
// read-write and may migrate — forbidden by this brief.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os'; import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.dev-team/factory/ledger.db'), { readOnly: true });
const rows = db.prepare(`
  SELECT s.adw_id, s.task_slug,
    (SELECT COUNT(*) FROM gate_results g
       WHERE g.adw_id = s.adw_id AND g.ok = 1 AND COALESCE(g.pristine, 0) = 0) AS green_gate_runs,
    (SELECT COUNT(*) FROM review_outcomes r WHERE r.adw_id = s.adw_id) AS reviews,
    (SELECT MAX(r.must_fix) FROM review_outcomes r WHERE r.adw_id = s.adw_id) AS max_must_fix
  FROM sessions s ORDER BY s.adw_id`).all();
const denom = rows.filter(r => r.green_gate_runs > 0 && r.reviews > 0);
const numer = denom.filter(r => r.max_must_fix > 0);
console.log('gate-review-gap: how often does a non-pristine GREEN gate run precede a review with must-fix findings?');
console.log(`  denominator (runs with >=1 green non-pristine gate AND >=1 review): ${denom.length}`);
console.log(`  numerator   (of those, max must_fix > 0):                          ${numer.length}`);
console.log(`  rate: ${(100 * numer.length / denom.length).toFixed(1)}%`);
console.log(`  (total sessions scanned: ${rows.length})`);
// the converse: green gate, review, and NO must-fix ever
console.log(`  green gate + review + zero must-fix in every round: ${denom.length - numer.length}`);
db.close();
