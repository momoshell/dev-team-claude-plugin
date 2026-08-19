# Seat pre-return checklist

Repo-owned judgment data. The two authoring seats — builder and planner —
self-apply this list to their own work before they write a ReturnEnvelope; the
charters name this file and do not restate it (the shape follows
`crew/guidelines/review-do-not-flag.md`).

Every item is mechanical and deterministic: checkable by the seat that wrote
the work, against its own diff or its own plan, without a second seat. That is
deliberate — this is the tier-0 predicate set the #294 advisor will fire
mid-round, and shipping the self-applied version first is what gives that
advisor's A/B a fair baseline instead of credit for bounces the checklist alone
would have prevented.

Measured over 164 archived lanes on 2026-08-19 (`~/.crew/*/*/journal.jsonl`
plus `returns/*.json`): 220 first reviews, 94 bounced — a 43% first-review
bounce rate, each bounce costing two seat hops and roughly ten minutes. Of the
93 recorded must-fix findings, the two dominant classifiable families are
unhandled edge paths (19%) and over-claimed verdicts (13%). Both are visible in
the builder's own diff; neither needs a reviewer to notice.

## Builder — before you return

- **B1 — every new error path answers EPERM, unknown, interrupted and empty.**
  Walk your own diff for the paths you added: each read, spawn, probe or parse
  you introduced, and what your code does when it comes back denied (EPERM,
  ENOENT), indeterminate (unknown), cut short (interrupted, a partial write),
  or with nothing in it (empty output, an empty list, a zero-byte file). Where
  a case cannot happen, say why in your envelope summary rather than leaving it
  unanswered. Kills: the unhandled-edge-path family — 19% of 93 archived
  must-fixes (18 findings: EPERM, unknown, interrupted, empty, ENOENT, crash,
  race). Run `b34-reclaim` is the archetype: all three of its must-fixes were
  "what does this do when the probe returns unknown, or when EPERM comes back."
- **B2 — nothing you record is stronger than what you measured.** Read back
  every verdict, status and count you are about to write — in the code, in the
  envelope and in any artifact — and downgrade the ones you did not observe:
  `proven` only where a proof ran, a clean floor only where the floor was
  probed, `failed` only where a failure was seen (an indeterminate result is
  `unknown`, and an interrupted one is not a result at all). Kills: the
  over-claimed-verdict family — 13% of 93 archived must-fixes (12 findings),
  and the one class a reviewer cannot check faster than you can.
- **B3 — the plan's lane ran green on the tree you are returning.** Re-run the
  plan's validation lane after your last edit, not before it, and paste the
  final pass/fail counts into `details.validation` and your summary; an earlier
  green on an earlier tree is not evidence about this one. Kills: the stale-lane
  bounce — the charter already requires the run (`crew/roles/builder.md`), and a
  claimed green the driver's own suite stage then reddens costs the whole round.

## Planner — before you return

- **P1 — every file:line anchor you cite resolves to what you say it does.**
  Re-read each anchor in `plan.md`'s Ground truth (and anywhere else you cite
  one) with `sed -n` or `Read` before you return, and correct the ones that have
  drifted; an anchor you cannot resolve is `assumed`, never `verified`. Kills:
  the falsified-anchor plan round — lane `b37-percheck-proof` spent five plan
  rounds, its tech-lead's round-1 check having "reviewed every cited code anchor
  and falsified the claimed post-green seam." The greps cost seconds here and a
  check round costs two seat hops.
- **P2 — you ran your own gate at baseline and pasted its GATE-SUMMARY line
  into plan.md.** Run the gate yourself against the unbuilt tree, confirm it
  exits non-zero with `errored: 0`, and record the literal summary line as a
  verified Ground truth fact in `plan.md`. Kills: the gate bounce that spends a
  whole plan round on a vacuous or broken gate — the driver enforces exactly
  this at baseline (`crew/drive.mjs:230-236`) and a second green baseline
  escalates the task.
- **P3 — every gate check names the mutation that kills it.** Each check
  carries a `MUTATION:` comment naming one edit to an in-scope file that turns
  that check red, and the same set is declared in `details.mutations` so the
  driver can apply them to the built tree. Kills: the whole-gate false positive
  — a gate that is red overall while some individual check adjudicates nothing
  (#330, `crew/drive.mjs:851-914`).
