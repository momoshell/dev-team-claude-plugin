# Driver test redundancy measurement

Suites with at least one measured run: 5 of 5 (100%)
Suite runs measured: 80 of 85 (94.1%)
Driver suites:
- crew/drive-build.test.mjs
- crew/drive-plan.test.mjs
- crew/drive-publish.test.mjs
- crew/drive-review.test.mjs
- crew/drive.test.mjs
Mutants selected: 17 of 17 (100%)
Mutants measured: 16 of 17 (94.1%)
Mutants killed: 9 of 17 (52.9%)
Tests observed: 1085
Tests with a kill-set: 74 of 1085 (6.8%)
Wall clock seconds: 146.063

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
Checkout HEAD: cf6cdbdacb1954033d3aebb551d5867306719a6c
Tool sha256: 94800dd5c798806648c9f9850ecec63fcfae4545b0d42bf632678f236b2a8f19
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
- 821c27b99f3f5ff7e3281d71220319aeecd155fef63b2c7c4b453dedcfbd3eba: file-level-failure

Sample blind spot: only the first generated candidate per sampled line was measured (17 of 17 (100%)).
