import { readFileSync } from 'node:fs';
const E = JSON.parse(readFileSync('envelopes.json','utf8'));
const F = JSON.parse(readFileSync('findings.json','utf8'));
const withArr = E.filter(e => e.has_findings_array);
const empty = withArr.filter(e => e.n_findings === 0);
console.log(`envelopes carrying a findings array: ${withArr.length}; of those, EMPTY (review produced no finding at all): ${empty.length} (${(100*empty.length/withArr.length).toFixed(0)}%)`);
const ev = {}; for (const e of empty) ev[String(e.verdict)] = (ev[String(e.verdict)]||0)+1;
console.log('  their verdicts:', JSON.stringify(ev));
const dist = {}; for (const e of withArr) dist[e.n_findings] = (dist[e.n_findings]||0)+1;
console.log('  findings-per-review distribution:', JSON.stringify(dist));
console.log(`  mean findings per findings-array review: ${(F.length/withArr.length).toFixed(2)}`);

// summary length by severity — is the "counterexample opening" just verbosity?
const len = {}; for (const f of F) { (len[f.severity] ||= []).push((f.summary||'').length); }
for (const [s,a] of Object.entries(len)) { a.sort((x,y)=>x-y);
  console.log(`  ${s.padEnd(11)} n=${a.length} median summary length ${a[a.length>>1]} chars, mean ${(a.reduce((x,y)=>x+y,0)/a.length).toFixed(0)}`); }

// where do must-fix findings land — top-level subsystem of the location path
const sub = {};
for (const f of F) { let p = (f.location||'').split(':')[0];
  p = p.replace(/^.*\/\.crew\/[^/]+\/[^/]+\//, 'TASKDIR/');
  const seg = p.split('/'); const k = seg.length>1 ? seg.slice(0,2).join('/').replace(/\/[^/]*\.(mjs|js|ts|svelte|md|yml|json)$/,'') : (seg[0]||'?');
  const top = p.startsWith('crew/roles')?'crew/roles': p.startsWith('crew/pi')?'crew/pi': p.startsWith('crew/adapters')?'crew/adapters': p.split('/')[0] + (p.split('/')[1]&&p.split('/').length>2 ? '/'+p.split('/')[1] : '');
  (sub[top] ||= {})[f.severity] = ((sub[top]||{})[f.severity]||0)+1; }
console.log('\nWHERE FINDINGS LAND (top-of-path), must-fix share:');
const rows = Object.entries(sub).map(([k,v])=>({k, mf:v['must-fix']||0, sf:v['should-fix']||0, co:v['consider']||0, n:(v['must-fix']||0)+(v['should-fix']||0)+(v['consider']||0)})).sort((a,b)=>b.n-a.n);
for (const r of rows) if (r.n>=4) console.log(`  ${r.k.padEnd(24)} n=${String(r.n).padStart(3)} must-fix=${String(r.mf).padStart(3)} (${(100*r.mf/r.n).toFixed(0)}%) should-fix=${r.sf} consider=${r.co}`);
