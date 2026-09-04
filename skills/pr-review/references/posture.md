## Posture by tier

One reviewer is the standing posture. A write surface touching the **protected floor** boots the lane at the **judge** tier; compute that before dispatch, never after. Judge-tier and protected-floor changes are where a second independent reviewer is worth most; when a panel does form, record any disagreement according to `references/divergence.md`.

The panel flow is shipped and wired. `panelSeats()` selects the seats
(`crew/drive.mjs:531`), `panelReview()` briefs two reviewers independently
(`crew/drive.mjs:4072`), `fuseFindings()` (`crew/escalation-policy.mjs:81`) fuses
their findings at `crew/drive.mjs:4130`, `adjudicatePanel()`
(`crew/escalation-policy.mjs:128`) adjudicates the divergences at
`crew/drive.mjs:4200`, and the review loop invokes the panel at
`crew/drive.mjs:4864`. Seat selection refuses a second reviewer from the seated
partner's vendor (`crew/crew.mjs:1191`). It shipped in `842ea51` on 2026-08-15,
and no capability named for verdict fusion exists anywhere in the tree, so no
trigger of that name can be evaluated.

Two conditions gate it, and both degrade **silently** to the single-reviewer
path. A round that reviewed alone is not evidence the flow is unbuilt:

- **A regranted continuation.** The panel is formed only when ctx.continuation is
  true (`crew/drive.mjs:4420`), and the daemon's regrant hook is the sole caller
  that sets it (`crew/child.mjs:266`). Every first boot reviews with one
  reviewer.
- **A seated tech-lead.** `panelSeats()` returns null without a seated tech-lead
  partner and a distinct adjudicator (`crew/drive.mjs:531`); the driver records
  `panel_skipped: 'seats'` and continues with one reviewer.

Reading a single-reviewer round, say which of the two gates was unmet. "It did
not run because it is not built" is false here.

Size the posture from the measured lanes: the first review bounces **68 of 194**
ledger lanes (F3), and **42 of those 68** pass at round 2. The acceptance gate is
green on **196 of 203** first rounds (F19). A second reviewer buys the most where
the gate is quietest.
