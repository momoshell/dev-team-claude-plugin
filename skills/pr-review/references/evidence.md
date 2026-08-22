# Evidence and limits

> **F28 first:** there is no independent ground truth for a real defect. Every
> rate below describes what earns a must-fix grade, not what catches a defect.
> The reviewer's verdict and grade are the same measurement, and the register
> has no post-merge defect, revert, or incident record to validate them.

The evidence register is `/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md`.
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
- **Panel posture — no exhibit:** the verdict-fusion flow is parked and has never
  run, so the tier-scaled panel is not measured.
- **Contract drift as an axis — no exhibit:** the nearest instrument is
  `contract-literal`, **4 must-fix of 7** (F9), too small to order by.
- **A second reviewer buys the most where the gate is quietest — no exhibit:** the
  corpus gives gate and review counts but has no panel comparison for this claim.
