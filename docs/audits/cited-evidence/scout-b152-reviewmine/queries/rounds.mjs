import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os'; import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.dev-team/factory/ledger.db'), { readOnly: true });
const rows = db.prepare(`select adw_id, verdict, must_fix, should_fix, consider, created_at, dispatch_id from review_outcomes order by adw_id, created_at, id`).all();
const byLane = new Map();
for (const r of rows) { if (!byLane.has(r.adw_id)) byLane.set(r.adw_id, []); byLane.get(r.adw_id).push(r); }
const seq = new Map(); // round index -> {pass, cn}
let firstPass = 0, firstCN = 0;
const trajectories = new Map();
for (const [lane, rs] of byLane) {
  rs.forEach((r, i) => {
    const k = i + 1;
    if (!seq.has(k)) seq.set(k, { pass: 0, cn: 0 });
    seq.get(k)[r.verdict === 'pass' ? 'pass' : 'cn']++;
  });
  if (rs[0].verdict === 'pass') firstPass++; else firstCN++;
  const t = rs.map(r => r.verdict === 'pass' ? 'P' : 'C').join('');
  trajectories.set(t, (trajectories.get(t) || 0) + 1);
}
console.log('lanes with >=1 review:', byLane.size);
console.log('first review pass:', firstPass, ' first review changes-needed:', firstCN);
console.log('\nby round index:');
for (const k of [...seq.keys()].sort((a,b)=>a-b)) { const v = seq.get(k); console.log(`  round ${k}: n=${v.pass+v.cn} pass=${v.pass} changes-needed=${v.cn}`); }
console.log('\ntrajectory (per lane, in time order):');
for (const [t,n] of [...trajectories].sort((a,b)=>b[1]-a[1])) console.log(`  ${t}: ${n} lanes`);
// magnitude of must_fix on first-round bounces
const firstCNrows = [...byLane.values()].map(rs=>rs[0]).filter(r=>r.verdict!=='pass');
const mfDist = {}; for (const r of firstCNrows) mfDist[r.must_fix] = (mfDist[r.must_fix]||0)+1;
console.log('\nmust_fix on first-round bounce rows:', JSON.stringify(mfDist));
db.close();
