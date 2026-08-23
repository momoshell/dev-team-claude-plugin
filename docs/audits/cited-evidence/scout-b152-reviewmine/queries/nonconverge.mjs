// Lanes whose recorded review rounds never reached a pass (disk corpus), and
// what their findings were made of. n is small; reported as a raw listing.
import { readFileSync } from 'node:fs';
const E = JSON.parse(readFileSync('envelopes.json','utf8'));
const C = JSON.parse(readFileSync('classified.json','utf8'));
const dn = d => parseInt(String(d).slice(1),10);
const lanes = new Map();
for (const e of E) { if (!e.verdict) continue; const k=`${e.workspace}::${e.lane}`; (lanes.get(k)||lanes.set(k,[]).get(k)).push(e); }
const never=[], conv=[];
for (const [k,es] of lanes) { es.sort((a,b)=>dn(a.dispatch)-dn(b.dispatch));
  (es.some(e=>e.verdict==='pass') ? conv : never).push(k); }
console.log(`lanes reaching a pass: ${conv.length}   lanes never reaching a pass: ${never.length}`);
const nset = new Set(never.map(k=>k.split('::')[1]));
const cnt = (rows) => { const o={}; for (const r of rows) o[r.primary]=(o[r.primary]||0)+1; return o; };
const inNever = C.filter(r => nset.has(r.lane));
console.log(`findings in never-passing lanes: ${inNever.length}`);
console.log('  primary category mix:', JSON.stringify(cnt(inNever)));
console.log('  severity mix:', JSON.stringify(cnt(inNever.map(r=>({primary:r.severity})))));
console.log('  lanes:', [...nset].join(', '));
