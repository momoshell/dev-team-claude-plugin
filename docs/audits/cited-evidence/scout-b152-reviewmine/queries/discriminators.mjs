// Single-axis discriminators over the 254 machine-readable findings.
// Each is one regex over the finding's summary/location; the table reports the
// must-fix share within each arm, always with its denominator.
import { readFileSync } from 'node:fs';
const F = JSON.parse(readFileSync('findings.json', 'utf8'));
const sev = f => f.severity;
function arm(name, pred) {
  const yes = F.filter(pred), no = F.filter(f => !pred(f));
  const c = xs => ({ n: xs.length, mf: xs.filter(x => sev(x) === 'must-fix').length,
                     sf: xs.filter(x => sev(x) === 'should-fix').length,
                     co: xs.filter(x => sev(x) === 'consider').length });
  const a = c(yes), b = c(no);
  const pc = o => o.n ? (100 * o.mf / o.n).toFixed(0) + '%' : 'n/a';
  console.log(name.padEnd(40) +
    `YES n=${String(a.n).padStart(3)} mf=${String(a.mf).padStart(3)} sf=${String(a.sf).padStart(3)} co=${String(a.co).padStart(3)} -> must-fix ${pc(a).padStart(4)}   |   ` +
    `NO n=${String(b.n).padStart(3)} mf=${String(b.mf).padStart(3)} -> ${pc(b)}`);
}
// 1. counterexample-shaped: the summary opens by naming a concrete triggering state.
const CEX = /^\s*(A |An |With |When |After |Passing |Omitting |Adding |Deleting |Calling |Replacing |Enqueue|Mutating|Dropping|Renaming|Interpolating|Two |Three |Five |On [A-Z]|The (unknown|fake|new|outer|scout|triage|rendered|gate's|regression|nested|combined|plan-mandated|required) )/;
arm('opens naming a triggering state', f => CEX.test(f.summary || ''));
// 2. cites a measurement the reviewer performed
arm('cites its own measurement', f => /\bmeasured\b|\bI (ran|measured|checked|mutated|verified|drove)\b|verified empirically|measured directly|measured:/i.test(f.summary || ''));
// 3. the finding is ABOUT a test/gate rather than about production behaviour
arm('location is a test or gate file', f => /\.test\.(mjs|ts|js)|\/gate\.mjs|test\.yml/.test(f.location || ''));
// 4. the finding is about prose (docs, README, comments, charters)
arm('location is a doc/markdown file', f => /\.md(:|$)|README/.test(f.location || ''));
arm('summary is about a comment/prose claim', f => /comment (still )?(claims|cites|says|reads)|still (says|claims|cites|reads|tells)|prose (still )?says|the (gloss|header|charter) /i.test(f.summary || ''));
// 5. false-green language: the reviewer proved a mutation survives
arm('proves a mutation survives (false green)', f => /(leaves?|keeps?|left) [^.]{0,90}\bgreen\b|still (passes|green)|survives the suite|asserts? nothing|is vacuous|can never fail|pins nothing/i.test(f.summary || ''));
// 6. plan-conformance: the built work diverges from the plan
arm('names a plan divergence', f => /\bplan(-mandated|-required|-prescribed|-mandated)?\b[^.]{0,40}(absent|missing|not written|omit)|Plan test|plan's (Changes|required)|out-of-plan|out of plan|unplanned|absent from the plan/i.test(f.summary || ''));
// 7. carried forward from a previous round
arm('carried forward from a prior round', f => /carried (forward|over)|still (open|unchanged)|Unchanged from round|Still open from round/i.test(f.summary || ''));
// 8. indeterminate state collapsed to a definite one
arm('indeterminate collapsed to definite', f => /EPERM|EINVAL|ESRCH|EAGAIN|\bunknown\b|unproven|falsely (report|hid|credit|claim|attribut|produce|settl)|silently (hid|hiding)|reported as no |as zero|instead of unmeasured/i.test(f.summary || ''));
