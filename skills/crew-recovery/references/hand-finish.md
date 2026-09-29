# Hand-finishing an escalated lane

Most escalations are not bad work. The lane paid for planning, building and
proof, then stopped on something only a human could re-scope: a vacuous check,
a stale citation outside the fence, a criterion the seat was not allowed to
meet. Throwing that away and re-dispatching costs a full plan round and the
same defect usually comes back. This file is the procedure for finishing such a
lane by hand. It is generic; commands specific to this repository are in the
last section.

`closeout.md` owns the order of preserve, teardown, commit and publish;
`mutation-proof.md` owns per-check proof; `escalations.md` owns what each
stage token means. This file does not repeat them.

## Decide first: finish, or re-dispatch

Hand-finish when the build exists and the blocker is outside the work:

- a gate check that cannot fail (it tests the environment, or guards dead code);
- a citation, pin or fixture outside the fence that the change legitimately moved;
- a plan criterion the seat was forbidden to satisfy (for example a full-suite
  run by a builder that may not run the suite);
- hardening that failed on shape (a duplicated entry, a source file edited after
  review) while the reviewed build is sound.

Re-dispatch instead when:

- **the premise is wrong.** The gate labels and mutations are frozen against
  it and no in-scope fix exists. Re-scope, and do **not** adopt the old plan: it
  carries the bad premise.
- **the lane died at plan with no build.** There is nothing to finish, and
  building every check by hand is a lane's work. Fix the brief (often a
  mutation that needs a file outside the fence) and dispatch fresh.

## The procedure

1. **Recover before touching anything.** Prove the tree quiet, preserve the
   state directory by copy, and tear down before committing, as the recovery
   closeout in `closeout.md` orders it. Then save the uncommitted build as a
   patch next to the batch: the worktree is the only copy.
2. **Diagnose from the per-seat returns, not the roll-up.** Read the escalation
   reason in full, then verify it independently. Read mutation declarations and
   findings from the seat that made them. The recurring shapes: a check that
   passes because of the checkout path; a guard whose condition is always true
   (an equivalent mutant); a mutation anchored to text the builder wrote
   differently; a test outside the fence that hard-codes a moved line number.
3. **Fix the defect at its carrier.** Correct the check, the pin or the fixture
   that is wrong. Never weaken an assertion to make the gate green.
4. **Commit before any proof.** Commit the built tree and your fixes, then run
   the per-check mutation proof on the committed text (`mutation-proof.md`).
   Count the table from the harness output, never from memory: N of N killed,
   each by its own `FAIL <label>` line.
5. **Rebase onto the current main.** Resolve conflicts hunk by hand. Never take
   one side of a whole file (`--ours`/`--theirs`): a side that looks like a
   line-number shift can carry a pin or entry the other side lacks. Two guarded
   shortcuts are safe:
   - a hunk whose two sides are identical once digits are removed is a pure
     line shift; take either side, because step 6 re-derives the numbers;
   - for an anchor manifest, keep the side whose pinned texts are a superset of
     the other's, and refuse when neither is.

   Anything else stops for a human read.
6. **Re-derive every citation after the rebase.** Repair every anchor manifest
   against the current source, and re-point every prose or audit citation by its
   quoted text. A citation whose text is no longer unique is an error to read,
   not a line to guess.
7. **Suite warm and cold, then the gate.** Run the full suite in the worktree
   and again in a fresh worktree under a temporary directory; cold catches
   location-sensitive tests. Run the lane's acceptance gate last. State both
   totals against main's.
8. **Review the hand work as a delta.** If the lane already passed review,
   review only the commits since that point. Collect every finding in the first
   pass and fix them together. Cap it at three passes; after the cap only
   data-loss or false-clean findings block, and anything new becomes a residual
   in the PR body.
9. **Publish.** Push, open the PR, and write the body so it closes only what it
   names: an issue number next to "fix" or "close" closes that issue, even in a
   sentence saying it stays open. State the denominators, what was done by hand,
   what the lane's own review never saw, and every residual. Verify the PR's
   first line after creating it. Keep the worktree until the operator merges.

## Skills: loading is not applying

A hand-finish writes code, so the repository's coding skills apply to it. Two
hand-finishes measured on 2026-09-28 loaded every coding skill and walked none
of their hand-written code against the lean ladder. So:

- the report ends with `skills loaded: <exact names, or none>`; a missing line
  reads as not loaded;
- before the final commit, walk each hand-written change against the ladder
  rung by rung and report each rung hit, or `ladder: none hit`;
- run the lean-debt harvest and report it.

## This repo

- Recover: `node scripts/factory/closeout.mjs recover <lane> --checkout <worktree>`
  (without `--checkout` it probes the working directory and refuses as not quiet).
- Preserve the build: `git -C <worktree> diff > <batch-dir>/<lane>-build.patch`.
- Repair pins, one skill directory per call:
  `node skills/qa-test-writing/anchor-pin.mjs --repair-all <dir>` for each
  directory holding an `anchors.json` (every `skills/*` and `crew/roles`). A
  second positional is swallowed and still exits 0.
- Audit citations live in `docs/audits/**` tables as `| <file>:<line> | <quote> |`;
  `crew/drive-docs.test.mjs` asserts each quote is on its cited line.
- Suite: `npm test`. Gate: `node <archived-state-dir>/task/gate.mjs`.
- Review: `~/.crew/tools/sol-review --since <reviewed commit>`; a hook blocks raw
  reviewer calls and gates lane PRs.
- Push as `cd <worktree> && git push …`: the review hook reads the lane directory
  from `cd <dir>;` with the semicolon attached and refuses.
- Skills to load: `dev-team:backend-node`, `dev-team:qa-test-writing`,
  `dev-team:lean-build`; the ladder is in `crew/roles/_shared.md`; the harvest is
  `node scripts/factory/lean-debt.mjs`.
