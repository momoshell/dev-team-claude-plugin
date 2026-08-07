# §7.4 Live-acceptance pass — findings (2026-08-07, cmux 0.64.22 build 102)

Orchestrator-run, transcript-first evidence. Harness: `python3 -m http.server 8377` serving a clean
page from a scratch dir; scratch workspace `6EA35336` created in the live window and torn down after.
Screenshots at `<scratchpad>/live-pass/shots/` (corroborating only); tree JSON captures `tree-0..6.json`.

## Verdict

**The design passes live. The shipped be-12-01 wrapper argv does not.** The D5 sequence, the clean
literal, the screenshot channel, the reduction boundary and the ≤90s budget are all validated against
real cmux — but only after correcting the CLI grammar. Four defects/corrections follow, one a PR-blocker.

## F1 — BLOCKER: wrapper argv order is inverted (be-12-01, unmerged PR #54)

Real grammar (`cmux browser --help`, live-verified end to end):

    cmux browser [--surface <id>|<surface>] <subcommand> [args]

i.e. **surface first**, then sub-verb. Shipped wrappers emit `browser <sub> <surface> …`:

- `browser errors clear <id>` → `Error: Unsupported browser subcommand: clear`
- `browser goto <id> <url>` → `Error: Unsupported browser subcommand: <the-uuid>` (parser reads
  `goto` as the surface handle)
- same failure for `wait`, `errors list`, `screenshot`.

Only `browserOpen` is correct (`open` is one of the surface-less sub-verbs). With the corrected
order the full sequence passes: `errors clear`→OK · `goto`→OK · `wait --load-state complete`→OK
(~0.02s local) · `errors list`→`No browser errors` (frozen literal confirmed byte-for-byte) ·
`screenshot --out`→ real 1600×1200 PNG, 56 401 bytes.

`test/fixtures/fake-cmux.mjs` accepts the wrong order — it mirrored the implementation instead of a
live capture (the exact tautology qa-notes 2026-08-02 names). The fake must accept ONLY the real
grammar and reject sub-verb-first loudly.

## F2 — `close-surface` NEVER closes a browser surface on this build; `browser <id> tab close` does

`cmux close-surface <uuid>` → `Error: invalid_state: Cannot close the last surface`, reproduced in
every configuration: stacked pair (2 surfaces in pane), browser stacked onto a terminal pane, and a
browser surface **alone in its pane**. `cmux browser <uuid> tab close` succeeds in all three (and
closing the last surface collapses the pane).

Impact: (a) be-12-02's abandon-close and teardown's per-surface preview close degrade to a stderr
line (best-effort semantics already tolerate this; teardown's `close-workspace` sweeps the surface
anyway); (b) **E3's frozen remediation line tells a human to run `cmux close-surface <uuid>`, which
cannot work** — it must name `cmux browser <uuid> tab close`.

## F3 — Two stacked browser surfaces are BOTH fULLY DRIVABLE on build 102

`wait`/`errors list`/`screenshot` all succeed on both members of a stacked pair (falsifies the
planning scout's "both undrivable" observation — build drift or configuration difference). A13
(survivor drivability after closing the loser) holds trivially. ADR-019's factual record needs a
dated amendment; the singleton design STANDS regardless — its independent justification (a wrong
adopt's `goto` navigates a rendered return document away; simultaneous-visibility placement) is
unchanged, and older/newer builds may differ.

## F4 — `browser open --workspace` reuse can land in ANY pane, including a worker's (A12 answered)

Third `open` against a workspace whose panes were [terminal] [terminal] [browser] reported
`placement=reuse` and stacked the new surface **into a terminal-only pane** — not the existing
browser pane. So a preview absolutely can land inside a worker's pane; be-12-02's post-create pane
check (`preview_landed_in_worker_pane` → abandon) is live-vindicated as load-bearing. A10 also
corroborated: first open in a fresh workspace → `placement=split`.

## F5 — CLI drift on this build (secondary)

- `cmux close-workspace <id>` positional is REFUSED (`requires --workspace`); the legacy verb is now
  an alias for `workspace close`. `cmuxctl.mjs:902` passes the id positionally → **shipped teardown's
  workspace close is live-broken** (pre-existing, surfaced by this gate). Fix: `--workspace <id>`.
- `new-workspace` is now an alias for `workspace create` (reference table says the latter "does not
  exist" — stale, harmless).
- `new-surface --type browser --url file://… --pane <uuid>` → `not_found: Pane not found` against a
  live pane UUID. NOT fixed in this round — named follow-up: may affect rung-2 doc-tab mounting;
  needs its own live investigation.

## Disposition

§7.5 (defer PR 2) does NOT trigger: the live pass contradicts the *transcription*, not the design —
same class as PR-1's capability-gate fix-round (also a live-falsified mechanism). Fix round 2 lifts
the cmuxctl.mjs byte-freeze deliberately (PR 1 is unmerged; the freeze exists to prevent scope creep,
not to preserve live-falsified argv), scoped to F1 + F2's remediation line + F5's close-workspace flag.
Deferred follow-ups: browser tab-close wrapper for abandon/teardown per-surface close; the
`new-surface --pane` investigation.

## Addendum — §7.4 completion through the SHIPPED code (post fix-round 2)

Same harness (`http.server 8378`), driven by a node script importing `cmuxctl.mjs` +
`browser-evidence.mjs` directly: `browserOpen` → `{placement:'split'}`, UUID by tree diff ·
`browserErrorsClear`/`browserGoto`/`browserWaitReady`/`browserScreenshot` → all `true` ·
`browserErrorsList` raw `"No browser errors\n"` → `reduceBrowserErrors` →
`{"clean":true,"count":0,"shape":"clean"}` (trimmed equality survives the live trailing newline) ·
PNG 56 401 bytes · `closeWorkspace` (fixed `--workspace` flag) verified to actually close the
workspace. The hard merge condition on PR 2 is discharged.
