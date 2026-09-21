# Observational seat priors

An observational, confounded prior over role×model cells — a starting belief for future study, not a verdict on any cell.

watermark: 280826
roster: crew/roster.json@c0f8a5f2d37780ddf33f174cfee3589ba265e3f3
ladder: crew/model-ladder.json@d9a5d11f0c56347e8d73cc6890b2bdee456c7845
generation: `node scripts/factory/seat-priors.mjs --watermark 280826 --roster-blob c0f8a5f2d37780ddf33f174cfee3589ba265e3f3 --ladder-blob d9a5d11f0c56347e8d73cc6890b2bdee456c7845`
floor: CELL_RATE_FLOOR = 12
under_floor_cells: 13 of 15

## Consumed prefix

- endAgentSession: 4419
- endPhase: 3348
- endSession: 628
- heartbeat: 224587
- recordAcceptDecision: 13
- recordCellFailure: 176
- recordEvalCell: 52
- recordEvent: 20344
- recordGateDiscrimination: 767
- recordGateResult: 9641
- recordModifierAttempt: 1198
- recordMutationAnchorAbsence: 7
- recordMutationAnchorBind: 21
- recordPhaseSlotWait: 274
- recordPlanScope: 14
- recordReviewOutcome: 634
- recordRoutingChoice: 5
- recordRunConfiguration: 576
- recordRunSeat: 913
- recordSeatReclaim: 3438
- recordSeatTeardown: 1254
- recordSeatTurnCensus: 86
- startAgentSession: 4427
- startPhase: 3363
- startSession: 641

## Method

- Authority is the append-only JSONL stream read to the watermark above; later records are never parsed for this readout.
- Role and raw model come from `startAgentSession`; review identity may come from outcome/run-seat records.
- A run/role first review is the earliest stream position for that run and role; later rounds never move the prior.
- A first-round pass rate is reported only at review_n >= CELL_RATE_FLOOR; anything below is UNMEASURED with its denominator shown.
- A session is priced only with an unambiguous provider/model identity, four finite catalog rates, and four measured token volumes; otherwise the median is null with a closed reason — UNMEASURED, never zero.
- Absence vocabulary is closed: rate absence carries its floor wording, cost absence carries one of no-completed-session, no-provider-model-identity, ambiguous-provider-model-identity, no-catalog-price, incomplete-catalog-rates, missing-token-volume.

## Role x model cells

| role | model | starts | review_n | first_round_passes | first_round_pass_rate | cost_n | median_cost_usd |
| --- | --- | --- | --- | --- | --- | --- | --- |
| builder | openai-codex/gpt-5.3-codex-spark | 3 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 2 | $0.2050 (n=2) |
| builder | openai-codex/gpt-5.6-luna | 150 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 36 | $0.1264 (n=36) |
| builder | openai-codex/gpt-5.6-terra | 224 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 55 | $0.3771 (n=55) |
| builder | openrouter/meta/muse-spark-1.3-contributor | 63 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 63 | $0.0659 (n=63) |
| lead | claude-opus-5 | 409 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 135 | $0.8354 (n=135) |
| planner | claude-opus-5 | 205 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 0 | unmeasured (n=0; no-provider-model-identity: 205 session(s) unpriced — UNMEASURED, never zero) |
| planner | claude-sonnet-5 | 1 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 0 | unmeasured (n=0; no-provider-model-identity: 1 session(s) unpriced — UNMEASURED, never zero) |
| planner | openai-codex/gpt-5.6-sol | 345 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 135 | $1.3125 (n=135) |
| planner | openai-codex/gpt-6-astra | 6 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 6 | $1.9499 (n=6) |
| planner | openrouter/meta/muse-spark-1.3-contributor | 58 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 58 | $0.0278 (n=58) |
| reviewer | claude-opus-5 | 337 | 164 | 104 | 0.634 (n=164) | 222 | $1.7153 (n=222) |
| reviewer | openai-codex/gpt-5.6-sol | 37 | 20 | 19 | 0.950 (n=20) | 20 | $0.7773 (n=20) |
| reviewer | openai-codex/gpt-5.6-terra | 7 | 3 | 3 | unmeasured (n=3; only 3 first-round reviews against a floor of 12 — UNMEASURED, never a point estimate) | 3 | $0.6199 (n=3) |
| tech-lead | claude-fable-5 | 12 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 12 | $2.6795 (n=12) |
| tech-lead | openai-codex/gpt-5.6-sol | 246 | 0 | 0 | unmeasured (n=0; no first-round review observed for this cell — UNMEASURED, never zero) | 63 | $1.5463 (n=63) |
