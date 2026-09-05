# Evidence and limits

> **F28 first:** there is no independent ground truth for a real defect. Every
> rate below describes what earns a must-fix grade, not what catches a defect.
> The reviewer's verdict and grade are the same measurement, and the register
> has no post-merge defect, revert, or incident record to validate them.

The scout register `scout-b152-reviewmine/findings.md` cannot be followed from this repository; its denominators are vendored below, but the F-number provenance is not independently resolvable here.
F0 records the corpus and its denominators: **274** `review_outcomes` rows,
**278** JSONL records, **339** reviewer envelopes over **228** lanes, **254**
extracted findings, **194** ledger lanes versus **227** disk lanes, and **1,879**
`gate_results` rows. These corpora are not interchangeable.

The limits are part of every interpretation:

- The ledger cannot name a finding's kind (F7, F20).
- `must_fix ≥ 1 ⟺ changes-needed` holds on **273 of 274** rows, so counting
  must-fixes adds nothing to the verdict (F2).
- The machine-readable finding corpus covers **92 of 124** `changes-needed`
  envelopes (F8); the remaining findings are only in prose.
- The classifier's single label hides overlap: **94 of 254** findings match more
  than one category and **48** match none (F9).
- F28's confound applies to every rate: these are grades, not validated defect
  catch rates.

## Rules with no exhibit

- **Divergence-as-signal — no exhibit:** nothing in the corpus records two
  reviewers on one line; the rule is design guidance.
- **Panel posture — no exhibit:** the cross-vendor panel is shipped and wired
  (invoked at `crew/drive.mjs:5267`), but the corpus carries no panel round, so
  the tier-scaled panel is **unmeasured, not unbuilt**. Nothing in the corpus
  records which of the two gates in `references/posture.md` — a regranted
  continuation (`crew/drive.mjs:4758`) or a seated tech-lead
  (`crew/drive.mjs:626`) — was unmet on a given lane. The audit register
  recorded this correction at
  `docs/audits/2026-08-23/audit/register-devops-prreview.md` and the skill went
  uncorrected until this lane.
- **Contract drift as an axis — no exhibit:** the nearest instrument is
  `contract-literal`, **4 must-fix of 7** (F9), too small to order by.
- **A second reviewer buys the most where the gate is quietest — no exhibit:** the
  corpus gives gate and review counts but has no panel comparison for this claim.
