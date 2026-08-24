# Convergence measurements

## Baseline

The settled sample had **13 stages** — 1 plan, 1 build, and 1 review — in
**4 of 7** lanes. **Planning is the largest stage in every lane**. The seven
lane table is:

| lane | planning / total |
|---|---:|
| b188 | **24m of 41m** (**59%**) |
| b186 | **21m of 82m** |
| b183 | **17m of 48m** |
| b184 | **17m of 106m** |
| b190 | **11m of 33m** |
| b185 | **9m of 63m** |
| b189 | **9m of 41m** |

`lane:rN` runs were **76-163s** and final suites were **75-132s**, so test
mechanics were **10-15%** of a lane. First-pass review was **1 of 4** for
b183–b186 and **3 of 3** for b187–b190.

## Lever 1

Design does not belong in a build brief. **b184** said “add a read-only mode and route the doors through it”; settling that design in judge plan-check took
**three tech-lead rounds** at xhigh, then an escalation and re-dispatch. **b187**
used the same tier, but its brief carried the finished table and one directional
rule and was accepted at **round 1**. A brief containing *decide*, **choose the shape**, or **add a mode** carries undone design and belongs in a scout or an
orchestrator decision before dispatch.

## Lever 2

The default **`plan_rounds`** is 2 (`crew/drive.mjs:23`, **`plan_rounds: 2, // planner attempts`**) plus grantable extras. **b184** used **`2 + 1 granted and needed 4`**: the escalation was budget exhaustion, not disagreement. Use **`--plan-rounds 3`** on a judge lane when that extra attempt is needed.

## Lever 3

The gate runs **before review**, so anything expressible as a check costs zero
review rounds. **b190** named the exact kill-mutation per finding; its gate had
**5 control/kill pairs** and passed first round with **no findings**. **b186**
left per-finding judgement to the lane and needed **3 review rounds**.

## Lever 4

**serial discovery** is the real convergence cost: b186 reviews and b184
plan-checks had the same shape, each round closing the previous findings and
surfacing **two new ones** visible only after the previous fixes. Layered review
is inherent; the remedy is moving checks earlier (**lever 3**), not adding more
rounds.

## Lever 5

Prescription density beats brief size. **b190** was the **second-largest brief**
and the **second-fastest plan**, because every finding arrived with its exact
kill-mutation and honest assertion. **b188** was smaller but took **24 minutes**
because its brief still asked for judgement calls. Describing costs plan
minutes; prescribing does not.

## Lever 6

Narrow the write surface; it is charged three times. b183: **5 files** → **30 acks** → **72KB** → **17m** plan. b189: **2 files** → **2 acks** → **26KB** → **9m** plan.

## Lever 7

The compiler re-measures the suite on every compile and deliberately refuses a
recorded baseline: **a recorded baseline is a fact about a commit and is never consumed** (`scripts/factory/make-brief.mjs:1251`). The principle is right, but **4 lanes x 2 passes** on one commit is **8 identical measurements**, about nine of the roughly ten minutes before dispatch. Measuring once per commit is consistent with the principle.

## Lever 8

Pass 1 of the two-pass compile exists only to read a refusal, which is then fed
back verbatim; a dispatcher that derives coupled sources itself can **compile once**. Levers 7 and 8 are dispatcher work recorded at **#584**, not operator
rules; they are named here so operators know where pre-dispatch minutes go.

## Lever 9

Scale the seat budget to the proof the brief demands. `b187-jsonleaf` escalated
at **builder** on **no valid envelope within 2400s** while healthy — **Working…**,
**1890s** elapsed, mid mutation matrix, on top of the **14 files** its brief demanded,
because it also demanded **six kill-mutations**, each in its own scratch
checkout. The builder wait is `builder: 2400, reviewer: 1800` (`crew/drive.mjs:44`); a brief or plan asking for N isolated proofs needs roughly N × suite_time added, passed as **`--wait-builder`** on `run`.
