# ADR-041 — Claims at plan-accept: the accepted plan's scope is the write claim

**Status:** proposed 2026-09-06 · **Issue:** #970 · **Owner:** operator

## Decision

Collision avoidance moves off the dispatch-time fence and onto a claim taken
when a plan is accepted.

The operator authors no fence. A dispatch names an issue and a checkout, and
says nothing about the write surface.

The planner's accepted `files_in_scope` is the write claim. It is recorded at
plan-accept rather than at dispatch, because plan-accept is the first moment at
which any party has read the code.

A claim is taken atomically against every live lane's accepted claims, in the
same batch or not, under one lock shared by all lanes — the discipline of the
existing `.crewjson-lock`, but not that lock itself, which lives inside a single
lane's own crew directory and so is never contended: the first accepted claim
wins and the second bounces. That closes the one hazard the change creates: two
planners racing for one file.

A collision bounces the planner naming the holder — "`crew/crew.test.mjs` is
held by b481 until it settles" — which costs one plan round; it never kills a
lane. The planner routes around, carves, or waits.

The scope gate does not change. It still refuses a write outside the accepted
scope, adjudicating the diff that exists rather than a guess made before it
existed.

A claim releases on lane settlement, which the journal already records.

The test-reach check of #960 becomes advice to the planner — *these tests import
your surface; claim them* — rather than a dispatch refusal.

Taken together these retire the `external` fence machinery and the
`external-fence-*` refusals with it.

## Grounds, measured

The operator measured this on 2026-09-06 over every journal under `~/.crew`, a
corpus of **262 lanes**. This record cites that sweep; it does not re-derive it.

| event | count |
|---|---|
| rebase conflicts — what the collision half of a fence exists to prevent | **1** — b379, one hunk in `test/factory-dispatch-batch.test.mjs` |
| plan-scope widenings journalled — the planner finding the fence wrong | **4**, plus b465 and b472, which escalated before the row was written |
| lanes killed by a fence too NARROW | **at least 4** in one week — b451, b465, b472, b478 |
| lanes killed by a fence too WIDE | **0** |

Every fence death had one shape. The planner read the code, computed the true
write surface, and was refused by a ceiling authored without that reading. The
lead of b465, verbatim: *"the dispatched surface is a ceiling neither the
planner nor I may raise, so I cannot fund it."* b478 wanted five files under
`visualizer/web/src/`; its only sibling was working in `scripts/factory/`. No
collision existed, and the refusal was pure ceiling.

The economics that used to justify the ceiling have inverted. Fences date from
when lanes were cheap and unreliable and the operator wanted tight control. The
planner is now the most expensive seat in the crew at roughly 7.5M cache-read
tokens per plan round, and a fence error wastes exactly that seat plus a whole
boot. On 2026-09-06 about 9% of the day's Opus window went to fence deaths.

## Two jobs fused into one mechanism

A fence does two jobs, and only one of them is load-bearing.

1. **Collision avoidance.** Two concurrent writers must not edit one file. This
   is why a batch of four can run at all, and it is kept — as a claim.
2. **Scope ceiling.** A lane may not exceed its authored surface. This is
   redundant: the scope gate adjudicates what was actually written and the
   reviewer reads the diff, both after the code exists and both on evidence
   rather than on a prior guess.

Job 2 is the one costing lanes. Claims keep job 1 and drop job 2 to the
controls that already do it better.

## Alternatives

**Rejected — keep the ceiling as it stands.** The status quo is rejected on the
measurement above: over 262 lanes it prevented one rebase conflict and killed at
least four lanes in a single week, and not one lane died of a fence that was too
wide. A control whose only measured failures are in one direction is mistuned in
that direction. It is also authored by the least-informed party at the earliest
possible moment, which is the property the measurement keeps punishing.

**Recorded, not rejected — auto-admit a widening onto unclaimed files.** Keep
the register and keep the dispatch-time fence, but auto-admit a plan-scope
widening when no live lane holds the requested files, refusing only on a real
collision. It is the same principle with far less surgery, and on 2026-09-06 it
would have saved three of the four dead lanes. It is recorded here as a legitimate
first step toward this decision rather than as a competitor to it, because it
changes the fence from a ceiling into a claim without moving where the claim is
taken.

## Blind spots

- Fences were **on for all 262 lanes**, so the collision rate measured is the
  rate *with* prevention, and the uncontrolled rate is unknown. Under claims
  every bounce is exactly a would-have-been collision, so the first batch
  measures the uncontrolled rate at the cost of rounds rather than lanes.
- **No measured case exists** of a ceiling catching a lane that was genuinely
  going astray. That is absence of evidence and not evidence of absence: no
  sweep was run for it, and this record does not claim one.
- The r51 refusal of 2026-09-06 showed **four lanes' corrected fences
  overlapping on 11 files**, so shared test carriers are common and collisions
  under claims will be more frequent than the b478 case suggests. That is a
  bounce cost, not a death cost, but it is a real and recurring one.

## What this does NOT decide

- **The sequencing of the lanes that implement it.** Whether the auto-admit
  alternative lands first as a cheap step, or the full claim register lands in
  one lane, and in what order the `external` fence machinery is retired, is the
  operator's to sequence. This record names the options and stops there.
- The on-disk shape of a claim record, the journal event that releases it, and
  the wording of the bounce message beyond the example above.
- Anything about ADR-040's post-merge anchor repair, which is orthogonal: it
  removes manifests from fences, while this removes the ceiling from fences.

## Consequences

- A dispatch carries no write surface, so an operator can no longer get one
  wrong; a batch is specified by issues and checkouts alone.
- A planner that discovers the true surface mid-plan widens into it without a
  human in the loop, unless another live lane holds a file it wants.
- Contention becomes visible as bounces rather than invisible as deaths, and
  the bounce rate is the first honest measurement of how often two lanes really
  do want one file.
- `#970` stays open until the lanes this record sequences have landed. This
  record does not close #970; it unblocks it.
