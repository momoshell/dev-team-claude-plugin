## Posture by tier

Build lanes seat one reviewer per round; judge lanes seat two independent reviewers.
The lane's tier (`mechanical`, `build` or `judge`, `TIERS` in `crew/protocols.mjs`) picks the seats, but
`crew/agents/reviewer.md` declares no `tiers` key, so the reviewer runs the same
model and effort at every tier. A write surface that matches `PROTECTED` in
`crew/loop.mjs` belongs at the judge tier. Decide that when planning. The loop
raises the lane at plan acceptance from `files_in_scope`, and the loop also raises
it after the build from the changed paths (a mechanical lane restarts at judge),
so a late raise is a backstop, not the plan.

The tech-lead seat (`crew/agents/tech-lead.md`) is the judge loop's automatic
second review, beside the reviewer after a green suite. On a lock-file recheck,
both seats give a new scoped review after proof and green fast checks instead.
The tech-lead uses the reviewer's envelope shape. Build lanes have no second review. The two reviews
run independently on the same checked tree, with both passes required to publish.
Both returns are collected before combined builder feedback; a halt drains the
sibling turn. Each seat reuses only its own pass on an unchanged tree.
Record disagreements according to `references/divergence.md`.

Size the posture from the measured lanes: the first review bounces **68 of 194**
ledger lanes (F3), and **42 of those 68** pass at round 2. The historical acceptance gate retired by ADR-055 was
green on **196 of 203** first rounds (F19). A second look was proposed where
the gate was quietest.
