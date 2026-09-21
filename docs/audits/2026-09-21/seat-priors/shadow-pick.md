# Shadow seat-pick readout

A non-decisive shadow readout: the picker observes the latest recorded lane per tier and changes nothing.

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

## Lane mechanical

- lane: none recorded for tier mechanical inside this prefix — UNMEASURED, never a guess.
- breaker: no breaker policy is configured (CREW_BREAKER_THRESHOLD unset) — candidate cell health is UNMEASURED, never healthy

## Lane build

- lane: 82389e7c-a672-4160-870b-8624b03d3fc3 (prefix position 280608)
- breaker: no breaker policy is configured (CREW_BREAKER_THRESHOLD unset) — candidate cell health is UNMEASURED, never healthy
- seat lead: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: anthropic/claude-opus-5/claude/high
  - picked: anthropic/claude-opus-5/claude/high (changes_seat: false)
  - candidate anthropic/claude-opus-5/claude/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat planner: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: openai/gpt-5.6-sol/pi/medium
  - picked: openai/gpt-5.6-sol/pi/medium (changes_seat: false)
  - candidate openai/gpt-5.6-sol/pi/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
  - candidate openai/gpt-5.6-sol/pi/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat builder: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: meta/muse-spark-1.3-contributor/pi/medium
  - picked: meta/muse-spark-1.3-contributor/pi/medium (changes_seat: false)
  - candidate meta/muse-spark-1.3-contributor/pi/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
  - candidate meta/muse-spark-1.3-contributor/pi/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat reviewer: outcome picked — the picker ranks anthropic/claude-opus-5/claude/high first on a 0.610738255033557 first-round pass rate across 149 first-round reviews.
  - seated: anthropic/claude-opus-5/claude/high
  - picked: anthropic/claude-opus-5/claude/high (changes_seat: false)
  - candidate anthropic/claude-opus-5/claude/high: eligible; rate 0.610738255033557 (n=149); breaker_verdict null (unmeasured)
  - candidate anthropic/claude-opus-5/claude/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)

## Lane judge

- lane: 0f397b14-e1ca-4f54-886a-c2c214880deb (prefix position 279367)
- breaker: no breaker policy is configured (CREW_BREAKER_THRESHOLD unset) — candidate cell health is UNMEASURED, never healthy
- seat lead: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: anthropic/claude-opus-5/claude/high
  - picked: anthropic/claude-opus-5/claude/high (changes_seat: false)
  - candidate anthropic/claude-opus-5/claude/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat planner: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: openai/gpt-5.6-sol/pi/high
  - picked: openai/gpt-5.6-sol/pi/high (changes_seat: false)
  - candidate openai/gpt-5.6-sol/pi/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
  - candidate openai/gpt-5.6-sol/pi/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat builder: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: meta/muse-spark-1.3-contributor/pi/high
  - picked: meta/muse-spark-1.3-contributor/pi/high (changes_seat: false)
  - candidate meta/muse-spark-1.3-contributor/pi/high: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
  - candidate meta/muse-spark-1.3-contributor/pi/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat reviewer: outcome picked — the picker ranks anthropic/claude-opus-5/claude/high first on a 0.610738255033557 first-round pass rate across 149 first-round reviews.
  - seated: anthropic/claude-opus-5/claude/high
  - picked: anthropic/claude-opus-5/claude/high (changes_seat: false)
  - candidate anthropic/claude-opus-5/claude/high: eligible; rate 0.610738255033557 (n=149); breaker_verdict null (unmeasured)
  - candidate anthropic/claude-opus-5/claude/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
- seat tech-lead: outcome stands — no candidate carries a measured non-thin first-round pass rate, so the seated cell stands — a thin or absent sample is not a verdict.
  - seated: anthropic/claude-fable-5/claude/medium
  - picked: anthropic/claude-fable-5/claude/medium (changes_seat: false)
  - candidate anthropic/claude-fable-5/claude/medium: eligible; rate unmeasured (n=0); breaker_verdict null (unmeasured)
