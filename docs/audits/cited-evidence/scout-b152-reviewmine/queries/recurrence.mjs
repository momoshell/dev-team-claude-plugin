// Per-lane round ordering over the disk envelope corpus, and whether a finding
// raised in one round is raised again in the next (structural recurrence, by id
// and by location, independent of the "carried forward" prose marker).
import { readFileSync } from 'node:fs';
const E = JSON.parse(readFileSync('envelopes.json', 'utf8'));
const F = JSON.parse(readFileSync('findings.json', 'utf8'));
const key = e => `${e.workspace}::${e.lane}`;
const dn = d => parseInt(String(d).slice(1), 10);
const lanes = new Map();
for (const e of E) { const k = key(e); if (!lanes.has(k)) lanes.set(k, []); lanes.get(k).push(e); }
for (const v of lanes.values()) v.sort((a, b) => dn(a.dispatch) - dn(b.dispatch));

let firstPass = 0, firstCN = 0, laneN = 0;
const traj = new Map();
for (const [k, es] of lanes) {
  const withV = es.filter(e => e.verdict);
  if (!withV.length) continue;
  laneN++;
  if (withV[0].verdict === 'pass') firstPass++; else firstCN++;
  const t = withV.map(e => e.verdict === 'pass' ? 'P' : 'C').join('');
  traj.set(t, (traj.get(t) || 0) + 1);
}
console.log(`DISK CORPUS: lanes with >=1 verdict-bearing reviewer envelope: ${laneN}`);
console.log(`  first review pass: ${firstPass}  changes-needed: ${firstCN}  (${(100*firstCN/laneN).toFixed(1)}% first-round bounce)`);
console.log('  trajectories:', [...traj].sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${t}=${n}`).join(' '));

// recurrence by (location) across consecutive rounds of the same lane
const byLaneRound = new Map();
for (const f of F) { const k = `${f.workspace}::${f.lane}`; if (!byLaneRound.has(k)) byLaneRound.set(k, new Map());
  const m = byLaneRound.get(k); const d = dn(f.dispatch); if (!m.has(d)) m.set(d, []); m.get(d).push(f); }
let pairs = 0, recur = 0; const recurBySev = {}; const totBySev = {};
for (const [k, m] of byLaneRound) {
  const ds = [...m.keys()].sort((a,b)=>a-b);
  for (let i = 0; i + 1 < ds.length; i++) {
    const cur = m.get(ds[i]), next = m.get(ds[i+1]);
    const nextLocs = new Set(next.map(f => (f.location||'').split(':')[0]));
    for (const f of cur) { pairs++; totBySev[f.severity] = (totBySev[f.severity]||0)+1;
      if (nextLocs.has((f.location||'').split(':')[0])) { recur++; recurBySev[f.severity]=(recurBySev[f.severity]||0)+1; } }
  }
}
console.log(`\nRECURRENCE (a finding's file re-appears in the same lane's NEXT review round)`);
console.log(`  findings with a next round to compare against: ${pairs}; re-appearing: ${recur} (${(100*recur/pairs).toFixed(0)}%)`);
for (const s of ['must-fix','should-fix','consider'])
  console.log(`   ${s.padEnd(11)} ${recurBySev[s]||0} / ${totBySev[s]||0}` + (totBySev[s]?` = ${(100*(recurBySev[s]||0)/totBySev[s]).toFixed(0)}%`:''));

// where do must-fix findings appear by round index?
const roundOf = new Map();
for (const [k, m] of byLaneRound) { const ds=[...m.keys()].sort((a,b)=>a-b);
  ds.forEach((d,i)=>{ for (const f of m.get(d)) { const r=i+1; if(!roundOf.has(r)) roundOf.set(r,{}); const o=roundOf.get(r); o[f.severity]=(o[f.severity]||0)+1; } }); }
console.log('\nFINDINGS BY REVIEW ROUND INDEX (disk corpus)');
for (const r of [...roundOf.keys()].sort((a,b)=>a-b)) { const o=roundOf.get(r);
  const n=Object.values(o).reduce((a,b)=>a+b,0);
  console.log(`  round ${r}: n=${String(n).padStart(3)}  must-fix=${String(o['must-fix']||0).padStart(3)} (${(100*(o['must-fix']||0)/n).toFixed(0)}%)  should-fix=${o['should-fix']||0}  consider=${o['consider']||0}`); }
