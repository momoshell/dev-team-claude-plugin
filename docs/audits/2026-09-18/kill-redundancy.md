# Driver test redundancy measurement

Suites with at least one measured run: 5 of 5 (100%)
Suite runs measured: 80 of 85 (94.1%)
Driver suites (pristine baseline: measured leaf tests, or the reason it was not):
- crew/drive-build.test.mjs: 285 tests
- crew/drive-plan.test.mjs: 140 tests
- crew/drive-publish.test.mjs: 106 tests
- crew/drive-review.test.mjs: 308 tests
- crew/drive.test.mjs: 246 tests
Mutants selected: 17 of 17 (100%)
Mutants measured: 16 of 17 (94.1%)
Mutants killed: 9 of 17 (52.9%)
Tests observed: 1085
Tests with a kill-set: 74 of 1085 (6.8%)
Wall clock seconds: 140.181

## Sampling
Lines requested: 40
Lines sampled: 40
Lines with a candidate: 17 of 40 (42.5%)
Lines skipped (no candidate): 23 of 40 (57.5%)
Candidates generated on sampled lines: 36
Candidates selected (first per line): 17 of 36 (47.2%)
Candidates omitted: 19 of 36 (52.8%)

## Provenance
Seed: 0
Checkout HEAD: b9334af52bc604dee99ba0a49b5491676b7f79a4
Tool sha256: bbc5e6be5c3ab0f1bcfff61e448cff9b2e04554ceac66c335b0a6f45d7c97da0
Node: v26.8.2

## Redundancy candidates (sampled kill-set subsumption, not proof of redundancy)
A candidate is a test whose sampled kill-set is a strict subset of another test's.
The sample is finite and one operator per line; shared hooks and ordering effects are
not modelled. Unsampled mutants may separate the two tests.
- none observed

## Survivors (gaps in this sample)
- if: 2 of 7 (28.6%) survivors
- DISCRIMINATE: 1 of 7 (14.3%) survivors
- resumeEscalate: 1 of 7 (14.3%) survivors
- resolveDiffMutationCap: 1 of 7 (14.3%) survivors
- parseQuestions: 1 of 7 (14.3%) survivors
- Error: 1 of 7 (14.3%) survivors

## Unmeasured outcomes
- 821c27b99f3f5ff7e3281d71220319aeecd155fef63b2c7c4b453dedcfbd3eba: outcome-set-differs

Sample blind spot: only the first generated candidate per sampled line was measured (17 of 36 (47.2%) of the candidates generated on sampled lines).
