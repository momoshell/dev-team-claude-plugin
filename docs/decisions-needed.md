# Decisions needed

This is the open owner-decision register. Decisions close only through an ADR link or a dated closure line. Entries are never deleted; history remains here. Currency is the operator's responsibility at closeout.

Line counts here use `split("\n").length`, which is one greater than `wc -l` for a newline-terminated file.

## 1. Split `crew/drive.mjs`?

- **Question:** Split `crew/drive.mjs`?
- **Measurement:** 7,522 lines at `72d87b6`. It is on the protected floor, so every judge lane is a drive.mjs lane; b533's builder fetched 4,730 distinct lines of it against 148 its plan cited, in 35 paged reads.
- **Options:** Split `crew/drive.mjs` through an ADR-sized migration; keep it intact.
- **Blocked:** #1033 and the seam report scoped from it; a split also reaches every import, every anchor manifest, every `allow_test_reach` naming the file, and the protected-floor list.
- **Raised:** 2026-09-08 (Split `crew/drive.mjs`?)
- **CLOSED 2026-09-08 by [ADR-042](adr/adr-042-split-the-suites-not-the-driver.md):** `crew/drive.mjs` is NOT split. `scripts/factory/seams.mjs` measured **30 clusters at 9,634 cross-cluster edges (321.1 per cluster)**, 28 anchor pins across six manifests and 12 reaching tests — one module with a wide interface, so a split would cut live coupling and produce layers that only forward arguments. #1061's sub-file scopes are sequenced AHEAD of any structural work and unlock the eight-issue driver queue at no migration cost.
- **Not a permanent verdict, and re-opened only as a different question.** The owner's standing direction is recorded in ADR-042: every large file should become modules with proper boundaries. Giving `crew/drive.mjs` boundaries is a **refactor, not a split** — the narrow interfaces must be CREATED before any file division is safe. That is a larger act, it wants its own ADR, and it follows #1061. Do not re-raise this entry as "split?"; raise the refactor.
- **Stale-measurement note, 2026-09-09:** this entry said 7,522 lines for a day after it was closed, and the file is now **8,257**. A closed decision keeps its original measurement; the growth is recorded here so a later reader does not mistake the old number for a live one.

## 2. Effort per stage, not per seat?

- **Question:** Set effort per stage, rather than per seat?
- **Measurement:** The roster seats the builder at `effort=max` on both tiers, for a 53-edit first build and for a three-edit bounce alike. Build-round wall minus in-tool time over turns: 13–22 s/turn across b530/b531/b533/b534.
- **Options:** Set effort per stage; continue setting effort per seat.
- **Blocked:** #1028 ask 2; changing the roster's shape requires the owner.
- **Raised:** 2026-09-08 (Effort per stage, not per seat?)
- **CLOSED 2026-09-09: set effort per stage, shipped neutral, with an operator dial.** The roster gains an optional per-stage effort; **the seat's value is the default fallback** and **no stage override ships**, so every lane is byte-identical until an operator dials one. A dispatch-time dial sets it when wanted.
- **Why, measured over 1,388 seat assignments in 208 lanes** (`seat_turn_census`, fitting `model_time = overhead + marginal x turns`): the premise in #1028 ask 2 — that a bounce needs less effort than a first build — is **contradicted**. Later rounds cost MORE per turn, not less: builder 12.0 -> 15.3 s/turn, planner 12.4 -> 19.0. Marginal cost is 12-13 s/turn for planner, builder, reviewer and lead alike; the builder at `effort=max` measures 12.3 s/turn (R2 0.90), among the cheapest. **Effort and role are perfectly confounded** — every seat's effort is fixed by role, and no lane has ever run one role at two efforts — so the closest comparison (same model `gpt-5.6-sol`: planner `medium` 36.9 vs tech-lead `xhigh` 43.2 s/turn, n=110) is an **unattributable upper bound of +17%**, not a finding. The decision therefore ships the knob, not a cut: it is what lets #1030's holdout break the confound and answer whether `xhigh` earns its cost.
- **Not the lever:** the planner's **169 s fixed overhead** x 414 assignments = **19.4 h, 13% of all 146.7 h of seat wall-clock**, which no effort setting can touch. Raised separately.

## 3. Re-prove after a moved-base rebase (#1021)?

- **Question:** Re-prove after a moved-base rebase (#1021)?
- **Measurement:** The denominator is unswept: #1002 found 32 of 118 journals with the review-rebuild shape; the rebase shape has no count at all.
- **Options:** Re-prove after a moved-base rebase; retain the current proof sequencing.
- **Blocked:** Commit/rebase/publish sequencing and preservation of the post-rebase tree.
- **Raised:** 2026-09-08 (Re-prove after a moved-base rebase?)

## 4. Do prompt changes require a measured eval (#1031)?

- **Question:** Do prompt changes require a measured eval (#1031)?
- **Measurement:** `crew/roles/*.md` are prompts and today a lane changes one under an ordinary code review; b524 added two lines to `planner.md` and no cell moved to show what it did.
- **Options:** Require a measured eval for prompt changes; continue ordinary code review for prompt changes.
- **Blocked:** The review requirement for changes to `crew/roles/*.md`.
- **Raised:** 2026-09-08 (Do prompt changes require a measured eval?)

## 5. The builder turn-ceiling number (#1028 ask 1)

- **Question:** What should the builder turn-ceiling number be (#1028 ask 1)?
- **Measurement:** `TURN_CEILING_DEFAULTS` at `crew/drive.mjs:139` gives the builder `null`; measured first rounds this week were 99, 130, 151 and 40 turns. The number must come from the POST-fix distribution or the ceiling encodes today's waste.
- **Options:** Set a numeric ceiling from the POST-fix distribution; leave the builder ceiling unset.
- **Blocked:** #1028 ask 1; the decision itself is blocked on #1027 and #1026 landing.
- **Raised:** 2026-09-08 (The builder turn-ceiling number)
- **UNBLOCKED 2026-09-09, measurement delivered.** #1027 and #1026 are closed (asks shipped in #1036, #1041, #1055/#1060, #1069). #908 merged as #1024, so a ceiling pre-empts at the turn boundary instead of discarding a finished round. The POST-fix builder distribution, turns per dispatch, from every `seat_turn_census` row after `3783ded` (**n=58**): **p50 24 · p75 63 · p90 115 · p95 155 · max 362.** For the same window the builder's turns per dispatch ROSE 35 → 48 and its median `billed_cache_read_tokens` per session went 6.82M → 14.69M (+115%, #1103) — the reads and runs lanes did not reduce the builder's cost, and the ceiling is now bounding a tail that is growing, not shrinking.
- **CLOSED 2026-09-09: `builder: 200`, `reviewer: 48`.** Ratified by the owner after the measurement above. **200 rather than the 115 first recommended**, and the reason is the shape of the tail rather than a percentile: the distribution has a cliff after 155 — the healthy tail ends there, then 258 and 362 — so **200 pre-empts exactly the same 2 of 62 dispatches that 155 does**, while leaving 45 turns of headroom above the observed healthy maximum. 115 would pre-empt 5 of 62 and 64 would pre-empt 14; both cut into healthy work. The asymmetry decides it: a ceiling that rarely fires costs nothing and still bounds the pathological tail, while one that fires on a healthy lane costs that lane entirely. `turnCeilingBreached` is `turns > budget`, so a dispatch of exactly 200 is not pre-empted.
- **Reviewer 48 is a safety net, not a saving.** Reviewer after-era is p50 19, p95 36, max 37 over n=40 — it would have fired zero times this week. It is set because the reviewer is the only other producing seat left unbounded; `tech-lead` stays `null` because its measured max is 23 with no tail, and an unmeasured ceiling is a guess.
- **Re-measure and tighten after #1104.** This number comes from a distribution in which the builder's re-read refusal has never fired (it refuses only a fully contained range, so a paged builder slides past it). When that lands the distribution should move down and 200 will be loose; the ceiling is then re-derived, not assumed. Implemented by lane `b578-ceiling`.


## 6. ACP via `claude-agent-acp` for the claude seat (#1034)

- **Question:** Use ACP via `claude-agent-acp` for the claude seat (#1034)?
- **Measurement:** Verified elsewhere on 2026-09-08 against the `claude-agent-acp` source, which is not in this checkout: its ACP agent implements `requestPermission`.
- **Options:** Adopt `claude-agent-acp` for the claude seat; continue the deferral until Grok/Antigravity are added.
- **Blocked:** The ACP transport choice for the claude seat (#1034); the owner deferred it until Grok/Antigravity are added.
- **Raised:** 2026-09-08 (ACP via `claude-agent-acp` for the claude seat)

## 7. Let the shadow seat pick seat for real? (amends ADR-032)

- **Question:** Should the shadow seat pick (#291 L2, already in `crew/crew.mjs`) be promoted from record-only to actually choosing a producing seat at boot, from the roster's admissible cells, by task shape and measured availability?
- **Measurement:** The pick exists and is dark. `SHADOW_OUTCOMES` (`picked / stands / abstained / no-candidate / not-consulted`), `SHADOW_EXCLUSIONS` (`band-unknown / band-below-floor / capability-shortfall / agent-unresolved / breaker-open`) and `SHADOW_ABSENT` are shipped at `crew/crew.mjs:1103-1120`. Both of its inputs are unmeasured: `CREW_BREAKER_THRESHOLD` is unset, so cell health reads *UNMEASURED, never healthy*; `eval_cells` has 0 rows, so pass rate and cost per candidate are absent. The roster seats two agents (`pi`, `claude`) and 7 models, three of which (`fable-5`, `sonnet-5`, `haiku-4-5`) have never been seated in 876 recorded sessions. Today a 429 parks, a 5xx backs off, an auth failure refuses; nothing ever picks a different cell (`PROVIDER_RETRY_ACTIONS`, `crew/headless.mjs:293`).
- **What ADR-032 ratified (2026-08-16):** the breaker refuses an open cell at boot and does not reroute; a cell is `{provider, id, agent, effort}` and nothing else; chain-walking is *deliberately deferred behind a ratified roster field*. Promoting the pick is exactly that field. It is not a reversal of ADR-032's reasoning — a silent downgrade stays forbidden — it is the deferred half arriving with its evidence.
- **Options:** Promote the pick so producing seats (planner, builder) float among admissible cells while reviewer and tech-lead floors stay pinned by tier, every pick journalled with its exclusions; keep it record-only and read the would-have-picked as a report.
- **Blocked:** #1105 (the instruments must be lit first — a pick from unmeasured health is the guess ADR-032 forbids); #1106 (an agent register, so "the agents we have" is data); #781 (shape and strength recorded separately per dispatch, so cost-vs-outcome per cell is measurable). Nothing here is a lane until #1105 lands.
- **Owner direction, 2026-09-09:** grow the roster — more agents, more models — and select seats by task and by what is available at the moment. This entry is that direction written down as the decision it requires.
- **Raised:** 2026-09-09 (Let the shadow seat pick seat for real?)
