# QA-lead consult — issue #12, 2026-08-07

NOTE (orchestrator): qa-lead reviewed package v1 concurrently with the lead's v1.1 amendment; the title-adopt cuts, rename-tab/hostname fixture fidelity, stacked modeling, `complete` literal, and the wait-outcome JSON field are ALREADY delivered by v1.1 (as `load_state_confirmed`). The items below marked ★ are the genuinely new deltas beyond v1.1.

## Q1 — PR/panel split: 2 PRs / 2 panels CONFIRMED as cut
Every slice edits scripts/cmux/*.mjs → panel per PR regardless. 1 PR = lens dilution (ADR-002 boundary competing with a VERBS diff under one panel); 3 PRs = slice A alone has no observable behavior (argv-shape review only). Revert granularity clean (C→B→A one-directional).
★ **Condition: PR 1 must not merge with a reachable double-create** (stacking now disables the feature) — see Q4-1.

## Q2 — PR-2 lens swap: sound as a RENAME, not a scope deletion
Adopt ADR-002 data-plane as primary lens, with a permission/exposure SUB-CHARTER on lens 1: (1) `browser-verify` in MUTATING_VERBS = the execution-mode authorization gate — a verb reachable without the mode gate or workspace binding is an authorization defect; (2) screenshot siting stateDir-vs-taskDir is exposure reasoning; (3) onboard.md is in CMUX_WIRED_SURFACES and the contract.mjs byte-identity claim spans both PRs.
★ PR-2 blocking overrides (any one blocks regardless of majority): page-controlled byte reaching JSON/log/stderr/disk outside the PNG; **browser-verify reachable without the execution-mode gate or workspace binding**; any contract.mjs/CMUX_ALLOWS diff; **any screenshot written outside stateDir**.

## Q3 — Reducer mutation bar: necessary, NOT sufficient
★ **Vacuity trap A — leak test needs its positive first, in the same run:** (a) `browserErrorsList` raw return CONTAINS the marker (bytes reached the boundary), (b) `console_errors.count === 3` (seen and counted), (c) marker absent from JSON, stderr, AND every file under stateDir + taskDir (AC7 claims disk; two of three channels were covered).
★ **Vacuity trap B — the second degenerate:** `clean = !stdout.includes('[error]')` survives the entire v1 test list — reads empty/whitespace/null/`Error: js_error: …` payloads all as CLEAN (exactly the stacked-undrivable live failure). Required negatives: empty string, whitespace-only, null/non-string, raw js_error payload → each `shape:'unrecognized'`, `clean:false`. Ship BOTH degenerates as a named comment block per qa-notes 2026-08-02.
★ **Missing mutations:** (1) invert the unrecognized fail-direction (clean:true on unrecognized); (2) remove the BROWSER_SUBVERBS guard (the only structure keeping eval/state unreachable); (3) unanchor the URL regex + separately swap scheme allowlist→denylist; (4) readCmuxPreviewUrl ambiguity→take-first; (5) drop existsSync, trust cmux's OK (needs a fixture flag printing `OK <path>` WITHOUT writing the file — live-motivated); (6) drop each of the four D7 trigger conjuncts one at a time (conjunctive predicate; dropping `domain==='frontend'` must fail a test or the issue's hard requirement is unverified); (7) import-firewall inversion BOTH directions (add a repo import into browser-evidence; add a browser-evidence import into ladder — the guard needs its own red).
★ **Count-correctness fixture:** a multiline single error with stack trace (`'boom\n    at foo.js:1\n    at bar.js:2'`) must yield count:1 — kills `split('\n').length`.
★ **Blank-screenshot pinning:** doc test pins "screenshot captured" (never "verified rendering"); byte-identical JSON between ready/never-ready cases except the flag/warning.

## Q4 — Slice test list deltas
Cuts (title-arm tests, renameTab step, fixture generic-rename) — SUPERSEDED, delivered by v1.1.
★ **1. Concurrent create is a data-integrity defect (HOLD PR 1 on this):** two frontend worktree dispatches in one wave both run ensurePreviewBrowser against a wholesale-rewritten workspace.json → both see no record → both create → `placement=reuse` stacks → BOTH undrivable, last writer's record points at a dead surface. Conventions 2026-08-02 check-then-act class. Needs an exclusive-create guard (`wx` lock / linkSync EEXIST) or a stated single-preview-per-wave invariant, plus a test. [Caveat (c): if the roster structurally allows only one frontend coder per wave, downgrades to documented invariant + comment.]
2. Live-preview-exists-record-gone test — delivered by v1.1 (record-derived candidate-pane arm); the test requirement stands: **no reachable path may leave two browser surfaces in one pane.**
★ 3. `--load-state complete` byte-pinned AND **the fake must REJECT wrong `--load-state` values** (fake accepting `load` ships a green regression that hard-fails live).
4. js_error frozen capture + degrade tests — delivered by v1.1.
5. Stacked end-to-end case — delivered by v1.1 (fixture models from topology).
6. IC-4 wait-outcome field — delivered by v1.1 (`load_state_confirmed`).
★ 7. Trigger-conjunct negatives with other terms held true: frontend spec on a non-worktree role → zero browser calls; preflight cache lacking `browser.open` / absent / unreadable / malformed → zero browser calls, dispatch code 0, exactly one stderr remediation line.
★ 8. Strengthen the A/B: deepEqual of written workspace.json between key-absent and pre-feature baseline; deepEqual of the new UNVERIFIABLE_VERBS content in test/cmux-preflight.test.mjs.

★ **Procedural — U5 challenged: live acceptance IS possible.** `python3 -m http.server` in a scratch dir = real http:// URL, real first-paint, real console. Both live scouts so far overturned a settled-looking assumption. **Gate condition for PR 2: one orchestrator-run live pass of the exact `errors clear → goto → wait --load-state complete → errors list → screenshot` sequence against real cmux — happy path plus the stacked case — with transcript evidence** (qa-notes 2026-08-03, screenshots corroborating-only). Shipping fake-only is the largest residual risk in the plan.

## Proposed qa-notes memory deltas (3, verbatim in the consult output file)
1. Model the refusal, not just the success — frozen live captures per OBJECT TYPE; fakes reject wrong enumerated-literal values. 2. "Duplicate is merely cosmetic" must be live-verified before licensing a fail-open arm. 3. existsSync proves a file, never a render; the wait result is the only non-vacuous liveness signal.

## Open cross-checks
- D4 replacement adopt key: delivered by v1.1 — record-derived. ✓ (matches qa-lead's stated constraint)
- Concurrency guard: pending backend-lead + architecture-lead answers.
- A9 (MUTATING_VERBS drift guard): still unverified by anyone.
