# Finish schema-valid insufficient builds

## Minimal change
- In `crew/finish.mjs:135-162`, retain every existing finish guard and the journal's builder-role/array/zero-defects requirements. Change only the status predicate to `['done', 'insufficient'].includes(row.parsed?.status)`. Do not admit `escalate`, remove schema-defect checks, change envelope selection semantics, or alter lead/finish decisions.
- Clarify the header/refusal wording at `crew/finish.mjs:1-15` and `crew/finish.mjs:157-157`: finish needs a schema-valid done or insufficient builder result, not necessarily an accepted done build.
- Update `skills/crew-recovery/SKILL.md:25-42` to state that a schema-valid insufficient builder result can be finished, while absent/defective builder returns remain refused.

## Regression tests
- Split the outdated combined refusal test at `crew/finish.test.mjs:48-60`: insufficient with zero defects is no longer a refusal. Keep absent-builder, defective-builder and wrong-role coverage; retain refusal for escalate.
- Add a positive test alongside `crew/finish.test.mjs:103-132` with a complete schema-valid insufficient builder envelope, uncommitted worktree change, and a lead-escalated stop after build (stage-start build followed by a null-stage stop). Assert finish.json creation, preserved original spec/worktree change and exactly one stubbed detached spawn. Existing done behavior stays green (FI1).
- Add isolated cases where the only builder row has nonempty defects, including insufficient and done statuses, and malformed/missing parsed data or defects. Assert finish-no-build and no writes/spawn (FI2). Use a complete valid builder envelope in new fixtures rather than just a status stub.

## Proof and boundaries
- Validation lane: `node --test crew/finish.test.mjs`.
- The task's gate imports `crew/finish.mjs` only from process.cwd(), uses an in-memory stopped-lane fixture and stubbed spawn, and checks FI1/FI2 independently. It is red before the status change; no real run or operator decision is launched.
- Mutation FI1 replaces `['done', 'insufficient'].includes(row.parsed?.status)` with the old done-only predicate. Mutation FI2 removes the zero-defects requirement while retaining the array check. Keep those exact literal anchors in the built code so the loop can measure both regressions.
- Scope is only crew/finish.mjs, crew/finish.test.mjs and skills/crew-recovery/SKILL.md. No gate repairs, lead policy changes, decision-path changes or other refactors.
