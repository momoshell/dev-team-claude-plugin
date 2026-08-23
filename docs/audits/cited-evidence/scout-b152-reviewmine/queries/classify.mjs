// Deterministic keyword classifier over the extracted reviewer findings.
// Categories are matched in a FIXED PRIORITY ORDER; a finding gets exactly one
// primary label (the first that matches) and the multi-match count is reported
// so the reader can see how much overlap the single label hides.
import { readFileSync, writeFileSync } from 'node:fs';
const findings = JSON.parse(readFileSync('findings.json', 'utf8'));

const CATS = [
  ['false-green', /keeps? (all |the |every |both )?[^.]{0,80}\bgreen\b|leaves? [^.]{0,90}\bgreen\b|(still |would )?(passes?|stays? green|remains? green)\b[^.]{0,40}(green|test|suite|lane|gate|guard|check)|asserts? nothing|is vacuous|are vacuous|vacuous\b|can never fail|never runs|no test\b|by no test|no repository (regression )?test|no in-repo|is untested|are untested|untested\b|not written|is absent|are absent|is missing|was not written|covered by no|omit(s|ted) the plan|pins nothing|survives the suite|test .{0,30}(absent|missing)|no plan section|nothing (in the repo )?(stops|enforces|pins|holds|composes)|no gate or/i],
  ['indeterminate-as-definite', /EPERM|EINVAL|ESRCH|EAGAIN|\bunknown\b|unproven|probe|zombie|falsely (report|hid|credit|claim|attribut|produce|settl)|silently hid|hiding|reported as no |as (four )?zero|zero .{0,20}totals|instead of unmeasured|absent .{0,25}(marker|branch)|undetermined/i],
  ['lifecycle-clobber', /overwrit|orphan|clobber|duplicate (crew|run|tier|child)|concurrent|forked|fork fails|settle|teardown|SIGTERM|SIGKILL|SIGCONT|reap|race|stale (sidecar|fetched|task)|already-settled|loses? (its|the) (result|envelope|terminal)/i],
  ['degraded-path', /degrad|fallback|fresh(-| )install|blind\b|load-bearing|Node 2[02]|below the .{0,20}floor|closed no-open|refus(e|es|al) path|instead of (failing|refusing|degrading)/i],
  ['input-boundary', /__proto__|Symbol|prototype|empty (argument|--|string|first)|trailing --|giant|RangeError|TypeError|userinfo|slice|slic(ed|ing)|prefix|coercion|Number\(|malformed|crafted|200-character|55KB|negative|null value|EISDIR|EEXIST/i],
  ['contract-literal', /literal backslash|backslash-n|byte-for-byte|byte-identical|byte-stable|verbatim|different newline|exact heading|one-line|run-on line|re-wrapped|byte-prescribed/i],
  ['stale-prose', /comment (still )?(claims|cites|says)|still (says|claims|cites|reads|tells|name)|prose|README|charter|docs\/|\.md:|gloss|imprecise|maintainer grepping|reader (concludes|going|auditing|skimming)|operator (following|reading|skimming|cannot recon)/i],
  ['out-of-plan', /out-of-plan|out of plan|unplanned|absent from the plan|Out-of-plan/i],
  ['render-join', /Svelte|render(s|ed|ing)?\b|connector|marker|hash|rail|panel|card|column|hover|keyed each|duplicate .{0,15}key|array position|swapped/i],
  ['redaction-replay', /redact|replayJsonl|replay/i],
];

const rows = findings.map((f, i) => {
  const text = `${f.summary || ''} ${f.location || ''}`;
  const hits = CATS.filter(([, re]) => re.test(text)).map(([n]) => n);
  return { ...f, idx: i, primary: hits[0] || 'unclassified', all: hits };
});
writeFileSync('classified.json', JSON.stringify(rows, null, 1));

const sevs = ['must-fix', 'should-fix', 'consider'];
const tab = {};
for (const r of rows) { (tab[r.primary] ||= {})[r.severity] = ((tab[r.primary] || {})[r.severity] || 0) + 1; }
const order = [...CATS.map(c => c[0]), 'unclassified'];
console.log('PRIMARY CATEGORY x SEVERITY  (n=' + rows.length + ' findings)');
console.log('category'.padEnd(26) + sevs.map(s => s.padStart(11)).join('') + '      n   must-fix share');
for (const c of order) {
  const t = tab[c]; if (!t) continue;
  const n = sevs.reduce((a, s) => a + (t[s] || 0), 0);
  const mf = t['must-fix'] || 0;
  console.log(c.padEnd(26) + sevs.map(s => String(t[s] || 0).padStart(11)).join('') + String(n).padStart(7) + '   ' + (100 * mf / n).toFixed(0) + '%');
}
console.log();
const multi = rows.filter(r => r.all.length > 1).length;
console.log('findings matching >1 category (overlap hidden by the primary label):', multi, 'of', rows.length);
console.log('findings matching 0 categories:', rows.filter(r => r.all.length === 0).length);
