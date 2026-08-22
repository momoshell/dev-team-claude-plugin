# Known limits

This reference preserves the limits in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` §§6, 8–10. They are constraints to expose, not defects this lane silently fixes.

## Contrast limit

Known limit: status colour is theme-invariant, so all four status steps and --serious fall below 4.5:1 on the paper ground.

The eight measured ratios below are computed from the declared literals, not from a rendered page:

| Alias | Ink ground | Paper ground | What the table says |
|---|---:|---:|---|
| `--status-escalated` / `--serious` | **6.78** | **2.24** | theme-invariant escalation |
| `--status-running` | **5.99** | **2.53** | theme-invariant running |
| `--status-ok` | **5.27** | **2.88** | theme-invariant success |
| `--status-fail` | **4.04** | **3.75** | theme-invariant failure |

`--status-skipped` is also below 4.5:1 on both measured grounds (3.90 on ink and 3.89 on paper in register §6), which is why the limit says all four status steps. By contrast, every theme-paired token clears 4.5:1 on its own ground: `--ink-text` is 14.72, `--paper-text` 15.63, `--ink-muted` 6.37, `--paper-muted` 6.54, `--spot-dark` 8.81, and `--spot-light` 4.59 in the declared-pair calculation.

A second contrast limit belongs to lane blocks: `visualizer/web/src/lib/PhaseGantt.svelte:59` uses `.block { color:#fff }`. The six paper role combinations range from 2.17 to 8.56 and the six ink combinations from 3.07 to 3.94; only **1 of 12 lane/ground combinations clears 4.5:1**. The `#fff` value is cited from the measured register, not introduced as a new palette value.

Neither the status contrast problem nor the lane-block contrast problem is fixed by this lane. A new component must use the aliases and surface the limitation rather than claim that a theme switch makes a status colour safe.

## Vacuous theme-sheet coverage

Known limit: test/visualizer-shape.test.mjs checks 12 name-presence regexes over theme.css and inspects no value, so deleting --status-escalated leaves the suite green.

The test at `test/visualizer-shape.test.mjs:286–292` checks role declarations and lane-to-role names only. It does not inspect the alias values, declaration count, status aliases, ordering, theme switching, or contrast. A consumer pin at `test/visualizer-panels.test.mjs:627,629` makes one FleetTable rule exact, but it does not prove that the token exists or that every component uses a token.

## What resists mechanical enforcement

Register §9 names the conventions that cannot honestly be made into current grep rules without a new decision or input:

- the spacing scale (C5), because fourteen sub-1rem values exist and no preferred scale exists;
- the type ramp, because nine ad-hoc sizes are not tokenised, even though the two weights and `.micro` usage are checkable;
- corner radius (D10), until the global reset versus component practice is resolved;
- the pill radius idiom (D3), a 3–3 tie with no governing principle;
- panel-spacing ownership (D2), which depends on where a component is mounted;
- tone completeness (D6), which needs the shaper's scattered tone vocabulary as an input.

The register §8 floor does cover role/lane mapping, two exact FleetTable strings, PhaseGantt layout locals, no `export let`/`$:` in Svelte files, and selected source pins. It does not cover a general colour-token rule.

## What the recon could not establish

Register §10 records four absences, and none should be upgraded to a fact:

1. No repo file establishes where the ratified role palette was ratified; the durable trace is `test/visualizer-shape.test.mjs:286–292` and the comment in `theme.css`.
2. No commit body explains why the role colours were chosen.
3. No rendered-page observation was available; L10, L11, D2 consequences, and visual appearance are source-derived, while the ratios above are arithmetic.
4. The recon did not trace whether the live ledger can carry `scout` or `advisor` in `agent_sessions.role`, and did not establish whether a skipped phase with no lane occurs.

Neither limit—the paper-ground contrast finding nor the vacuous theme.css test—is fixed by this lane. Record the evidence boundary when a future change proposes to fix either one.
