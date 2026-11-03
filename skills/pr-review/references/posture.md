## Posture by tier

One reviewer per round is the standing posture. The lane's tier (`mechanical`,
`build` or `judge`, `TIERS` in `crew/protocols.mjs`) picks the seats, but
`crew/agents/reviewer.md` declares no `tiers` key, so the reviewer runs the same
model and effort at every tier. A write surface that matches `PROTECTED` in
`crew/loop.mjs` belongs at the judge tier. Decide that when planning. The loop
raises the lane at plan acceptance from `files_in_scope`, and the loop also raises
it after the build from the changed paths (a mechanical lane restarts at judge),
so a late raise is a backstop, not the plan.

The tech-lead seat (`crew/agents/tech-lead.md`) is the judge loop's automatic
second review, after the reviewer passes and the suite is green. It uses the
reviewer's envelope shape. Build lanes have no second review. The two reviews
run one after the other, never two reviewers on one round, so there is no panel.
Record disagreements according to `references/divergence.md`.

Size the posture from the measured lanes: the first review bounces **68 of 194**
ledger lanes (F3), and **42 of those 68** pass at round 2. The historical acceptance gate retired by ADR-055 was
green on **196 of 203** first rounds (F19). A second look was proposed where
the gate was quietest.
