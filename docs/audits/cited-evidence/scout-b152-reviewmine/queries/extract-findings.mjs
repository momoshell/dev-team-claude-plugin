// Read-only sweep of every reviewer ReturnEnvelope on disk under ~/.crew.
// Emits one JSON record per finding plus per-envelope metadata.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
const files = execSync(`find ${homedir()}/.crew -name '*.reviewer.json' -type f`, { maxBuffer: 1 << 28 })
  .toString().trim().split('\n').filter(Boolean);
const envelopes = [], findings = [], broken = [];
for (const f of files) {
  let o; try { o = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { broken.push({ file: f, err: String(e.message) }); continue; }
  const m = f.match(/\.crew\/([^/]+)\/([^/]+?)(?:\.archive-[^/]+)?\/returns\/(d\d+)\.reviewer\.json$/);
  const d = o.details || {};
  const env = {
    file: f, workspace: m?.[1] ?? null, lane: m?.[2] ?? null, dispatch: m?.[3] ?? null,
    status: o.status ?? null, verdict: d.verdict ?? null,
    must_fix: d.must_fix ?? null, should_fix: d.should_fix ?? null, consider: d.consider ?? null,
    n_findings: Array.isArray(d.findings) ? d.findings.length : null,
    has_findings_array: Array.isArray(d.findings),
  };
  envelopes.push(env);
  if (Array.isArray(d.findings)) for (const fi of d.findings) findings.push({
    lane: env.lane, workspace: env.workspace, dispatch: env.dispatch, verdict: env.verdict,
    id: fi.id ?? null, severity: fi.severity ?? null, location: fi.location ?? null,
    summary: typeof fi.summary === 'string' ? fi.summary : JSON.stringify(fi.summary ?? null),
  });
}
writeFileSync('envelopes.json', JSON.stringify(envelopes, null, 1));
writeFileSync('findings.json', JSON.stringify(findings, null, 1));
console.log('reviewer envelope files:', files.length, ' parsed:', envelopes.length, ' unparseable:', broken.length);
console.log('envelopes carrying details.findings array:', envelopes.filter(e => e.has_findings_array).length);
console.log('total findings extracted:', findings.length);
const bySev = {}; for (const f of findings) bySev[String(f.severity)] = (bySev[String(f.severity)] || 0) + 1;
console.log('severity spelling census:', JSON.stringify(bySev));
const byVerdict = {}; for (const e of envelopes) byVerdict[String(e.verdict)] = (byVerdict[String(e.verdict)] || 0) + 1;
console.log('envelope verdicts:', JSON.stringify(byVerdict));
console.log('distinct lanes:', new Set(envelopes.map(e => e.lane)).size);
if (broken.length) console.log('broken:', JSON.stringify(broken.slice(0, 5), null, 1));
