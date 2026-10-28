## Posture by tier

One reviewer per round is the standing posture. The lane's tier (`mechanical`,
`build` or `judge`, `TIERS` in `crew/protocols.mjs`) sets the reviewer's effort:
`crew/agents/reviewer.md` raises it at the judge tier. A write surface that
touches the loop's own enforcement (`crew/loop.mjs`, `crew/checks.mjs`,
`crew/acp/grants.mjs`, `hooks/`) belongs at the judge tier; decide that when
planning, never after the build.

The tech-lead seat (`crew/agents/tech-lead.md`) is not an automatic stage:
today's standard loop does not dispatch it, and `crew/loop.mjs` consults the
lead, not the tech-lead. It reviews only when a person assigns it. Its details
keys are the reviewer's: verdict and findings. The lean loop never runs two
reviewers on one round, so there is no panel to adjudicate. When a manually
assigned tech-lead and a reviewer do land on the same line with different
verdicts, record the disagreement according to `references/divergence.md`.

Reading a round that reviewed alone, say which condition applied: no tech-lead
review was assigned, or the reviewer's verdict stood. "A panel did not run" is
not a defect in a lane where no panel exists.

Size the posture from the measured lanes: the first review bounces **68 of 194**
ledger lanes (F3), and **42 of those 68** pass at round 2. The acceptance gate is
green on **196 of 203** first rounds (F19). A second look buys the most where
the gate is quietest.
