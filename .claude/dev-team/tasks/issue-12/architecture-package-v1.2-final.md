# Architecture Package v1.2 — FINAL delta (appends to v1 + v1.1)

**Date:** 2026-08-07 · **Inputs:** consult-architect.md, consult-qa-lead.md, consult-backend-lead.md, u2-scout-findings.md + timing addendum. **Status:** design closed. Supersedes v1.1 §A1 (singleton) and §A2's `safeDetail` clause. All other v1/v1.1 content stands.

**Rejections (owner's calls):**
| Rejected | Source | Reason |
|---|---|---|
| "Candidate-pane adopt arm evaporates under the sidecar" | backend-lead | `browser open --workspace` STACKS into an existing browser pane (`placement=reuse`, live-verified) — "no record + live surface" can never be resolved by creating. The sidecar removes the lost-record motivation; reuse semantics reinstate the scan for a stronger reason (C1). |
| Downgrade concurrency guard to a documented invariant | qa-lead caveat (c) | Roster imposes no one-frontend-coder-per-wave limit; a documented invariant is exactly the fail-open the stacked finding punishes. Take the lock. |
| `safeDetail` (v1.1 §A2) | self-reject | AC7 forbids page bytes on stderr; truncation bounds volume, not content; an injection fits in 120 chars. Code-only wins. |
| "Byte-identical JSON ready vs never-ready" | qa-lead Q3 | Unachievable — screenshot_path is timestamped. Modified: identical KEY SET; only load_state_confirmed/warnings/screenshot_path differ. |
| Deferring PR 2 | architect's stated alternative | Rejected on the architect's own defeating argument, folded into ADR-019 as the anti-deferral rule (C8-8). |

## C1 — Singleton, final: sidecar + lock + mandatory pre-create authority scan

**Adopted: backend-lead option (A).** Block moves to single-writer sidecar `<stateDir>/browser.json`; whole resolve→decide→create→stamp inside `withRecordLock` (record.mjs:834; worktrees.json precedent dispatch.mjs:485,550). Consequences: **workspaceCmd needs no edit**; `carried` untouched; IC-1 carry clause deleted; the ~12 whole-object deepEqual test sites stay green; stateDir teardown sweep covers the sidecar. Lock hold trivially bounded (`browser open` = 0.06s fire-and-forget, vs LOCK_STALE_MS 30s). RecordLockError → catch → log `preview_lock_contended` → skip, in the cosmetic zone. **Lock spans the side effect, not the write.**

**The scan survives, now mandatory:** (1) a second `browser open --workspace` REUSES the existing browser pane and stacks — both undrivable — so "sidecar absent + live surface present" cannot be resolved by creating; (2) a rung-2 doc-tab browser must never be adopted — `browser-verify`'s `goto` would navigate a rendered return document away (active data loss).

> **Pre-create authority scan** (fresh `tree({all:true})` taken by `ensurePreviewBrowser` ITSELF — never dispatch.mjs:921's stale liveTree). Partition every browser-typed surface in the bound workspace:
> - **worker-pane browsers** — in the pane containing `workspace.json.initial_surface_id`, or in any dispatch record's `surface.pane_id` (`listRecords`, terminated included — a collapsed doc tab outlives its dispatch). Ignored entirely: never adopted, never counted.
> - **free browsers** — everything else.
> Then: **0 free → create** · **exactly 1 free, alone in its pane → adopt** (stamp; no rename) · **1 free sharing its pane, or ≥2 free → fail closed** (`preview_pane_stacked` / `preview_surface_ambiguous`), create nothing, skip.

Both exclusion keys UUID-derived; initial pane located via `initial_surface_id`, NOT `initial_pane_id` (which keeps zero readers — keep the :764 comment, now stating this slice deliberately declined to give it a reader). **Post-create pane check:** `browserOpen` returns paneId; if it falls in the worker-pane set → log `preview_landed_in_worker_pane`, stamp anyway, never create a second, never close anything (covers A10/A12).

**IC-1 (replaced):** `<stateDir>/browser.json`, written only by `ensurePreviewBrowser` under the lock; read by it + `browser-verify` (read-only); every consumer corroborates against a fresh tree + workspace_id equality. Shape: `{ surface_id, pane_id, workspace_id, origin, created_at }` — `origin`, not `url` (C4). Absent = no preview (`readJsonOrWarn`).

## C2 — Logging: code-only; safeDetail deleted

Wrappers log `res.error?.code` + sub-verb + surface id, NEVER `.message` (deliberate divergence from the house pattern, stated at the definition site). Code logged only if it matches `^[a-z_]{1,32}$`, else the literal `<unparsed>` (makes the closed-vocabulary claim structural). Code surfaced upward into IC-4 `warnings` (e.g. `"errors_list:js_error"`) so wedged ≠ silent. AC7 now satisfiable by construction: only a closed-vocabulary token, an integer count, a 3-value shape enum, a boolean, and dispatcher-composed paths cross any boundary.

## C3 — IC-2 spawn timeouts (architect's blocking item)

| wrapper | cmux-side bound | spawn timeoutMs |
|---|---|---|
| browserOpen | none (0.06s fire-and-forget) | 10000 |
| browserGoto | ~15.5s self-bound → `navigation_timeout` | 20000 |
| browserWaitReady | `--load-state complete --timeout-ms 20000` | 25000 |
| browserErrorsClear / browserErrorsList | none (0.04s class) | 10000 |
| browserScreenshot | none | 20000 |

**browser-verify total wall-clock budget ≤ 90s** (85s worst case), stated at the verb + in qa-gate.md (orchestrator sizes its Bash timeout). 10s open bound = ~3× lock headroom. Also final: `browserOpen` parses ONLY `placement=(\w+)`; `BROWSER_LOAD_STATE='complete'` frozen module constant.

## C4 — Origin-only + tightened URL accept path

**IC-4's field is `origin`** (`scheme://host[:port]`); every report line, warning, and the sidecar carry origin only. Full URL exists in exactly two places: config file + goto argv. Validator, final: refuse any `@`; full-match `^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~:\/?#\[\]!$&'()*+,;=%-]*)?$`; port ≤ 65535 (explicit numeric check); refuse `%` not followed by two hex digits; length ≤ 2048; `.trim()` first. Comment the deliberate exclusions: backslash (WHATWG treats `\` as `/` in special schemes) and the case-sensitive `https?` anchor.

## C5 — D3/D6 final wording (architect's modifications, all adopted)

**D3:** (1) browser-verify NOT in the lifecycle-order line — qa-gate.md beside cmux diff as an optional gate adjunct + one cmux-dispatch.md §1 paragraph; (2) MUTATING_VERBS comment (means "requires execution_mode: cmux", not "mutates a record"); (3) fix dispatch.mjs:4 to name COMMANDS with no number; (4) ADR argument restated: hand-typing pipes unreduced page bytes into the ORCHESTRATOR'S context (closer to control flow than the validator); cmux diff cited for the permission half only.
**D6:** (1) re-entry condition per ADR-003 Am.1 Rider E (lifetime-bounded: written immediately before load, unlinked immediately after + on every abort path; mode-0600/location buy nothing vs G13); (2) ADR states plainly: PR 1 walks into ADR-005's residual the moment a human logs in — the descope declines a REPLAYABLE ON-DISK ARTIFACT, not the configuration; (3) onboard.md + config.md: "log the preview into dev/staging accounts only, never production or admin credentials" (be-12-03); (4) surface re-creation joins the re-entry trigger.

## C6 — Slice/test/AC deltas (final)

**be-12-01 adds:** timeout table; code-only logging + shape guard; placement-only parsing; frozen BROWSER_LOAD_STATE. Fixture: REJECTS wrong --load-state values (`load` fails); a flag printing `OK <path>` WITHOUT writing the file; `navigation_timeout` modeled. Tests: `'load'` absent from scripts/cmux/; exact timeoutMs in each argv; js_error/navigation_timeout degrade + detail ABSENT from stderr; out-of-vocabulary code → `<unparsed>`; remove-BROWSER_SUBVERBS-guard mutation red.

**be-12-02 (replaces v1.1 candidate-pane set):** no workspaceCmd edit; browser.json + lock spanning resolve→create→stamp; C1 scan; post-create check. Tests: 0 free → create · 1 free alone → adopt, zero opens · 1 free sharing pane → `preview_pane_stacked` · 2 free → `preview_surface_ambiguous` · rung-2 doc-tab neither adopted nor counted · collapsed doc-tab pane still excluded via its record · initial pane excluded via initial_surface_id, reordered panes[] don't change the outcome. Concurrency (PR-1 hold): pre-created lock → zero opens + `preview_lock_contended` + code 0; lock-removal mutation red. Trigger conjuncts one at a time: non-worktree role; 'Frontend'/'frontend ' negatives; cache lacking browser.open / absent / unreadable / malformed → zero calls, code 0, exactly one remediation line. A/B strengthened: deepEqual workspace.json vs pre-feature baseline + deepEqual UNVERIFIABLE_VERBS content. URL: @ refused; hostless refused; port>65535 refused; bad % refused; trailing \r trimmed; unanchor mutation + allowlist→denylist swap red; ambiguity→take-first mutation red.

**be-12-03:** reducer bar — BOTH degenerates as a named comment block (`===CLEAN_LINE`-only and `!includes('[error]')`; the latter reads empty/whitespace/null/js_error-payload as CLEAN — each must → unrecognized+not-clean); leak test positive-first same-run (raw return CONTAINS marker; count===3; marker absent from JSON + stderr + every file under stateDir AND taskDir); multiline stack-trace error → count:1; invert-unrecognized mutation red; firewall inversion BOTH directions red; browserErrorsList exactly one call site; existsSync-drop mutation red vs the OK-without-write fixture flag. Doc tests: "screenshot captured" never "verified rendering"; ≤90s budget; origin-only rule; dev/staging line. Ready vs never-ready JSON: identical KEY SET, only load_state_confirmed/warnings/screenshot_path differ.

**ACs:** AC3 → C1 outcome set under the lock. **AC17:** two concurrent frontend dispatches → at most one `browser open` across both processes; loser skips, code 0; no reachable path leaves two browser surfaces in one pane. **AC18:** workspace.json byte-unchanged by the feature; workspaceCmd untouched in the diff. **AC19:** explicit timeoutMs per wrapper exceeding cmux-side bound; ≤90s budget stated in doc. **AC20:** no page-influenced byte reaches stderr (code-only + seeded-marker covering JSON/stderr/all files under stateDir+taskDir). **AC21:** origin only — no full URL in any JSON field, log line, report line, or sidecar. **AC16 extended:** qa-gate.md carries dev/staging line + the "clean (0) on a never-loaded page is reachable" caveat (connection-refused leaves the console CLEAN — load_state_confirmed is the ONLY suppressor; v1.1's rule is load-bearing).

**discovery_context for coders:** ensurePreviewBrowser takes its OWN fresh tree; test/cmux-dispatch.test.mjs deepEquals whole workspace-state at ~12 sites (3459, 3492, 3500, 3584, 3762, 3777, 3790, 3873, 3887, 3940, 4110, 4142); spec.domain never schema-validated at dispatch (exact match; full-stack-authored-backend gets no preview — accepted); MUTATING_VERBS has one consumer; teardown verify pass has no assertion; preflight test :242-255 deepEquals unverifiable_verbs (expected red, slice-A lane).

## C7 — Dispatch plan, final

- **Before any dispatch (orchestrator):** post the D3 reinterpretation + D6 descope as a comment on issue #12 (precedent: superseding comment on #2, PRE-1C-VERIFY on #4).
- **PR 1 hold condition:** discharged by C1 lock + scan + AC17.
- **PR 2 gate condition (supersedes U5):** one orchestrator-run LIVE pass against real cmux of the exact sequence, using `python3 -m http.server` for a real http:// origin — happy path + stacked case — transcript evidence. Add A12 to that pass (does open reuse a pane holding a rung-2 file:// doc tab?).
- **PR-2 panel:** lenses ADR-002 data-plane (+ permission/exposure sub-charter) / cmux-surface-discipline / doc-contract-coherence. Blocking overrides: page byte in JSON/log/stderr/disk outside PNG · browser-verify reachable without mode gate or workspace binding · contract.mjs/CMUX_ALLOWS diff · screenshot outside stateDir.
- **PR-1 panel:** unchanged lenses + blocking overrides for fail-open on singleton ambiguity and lock-scope narrowing (locking the write instead of the side effect).

## C8 — ADR-019 final text amendments (beyond v1.1 §A5)

(5) Singleton paragraph → sidecar + lock + scan wording (verbatim in the lead's delta; includes "the lock spans the side effect" and "worker panes are excluded by UUID, never by a surface title"). (6) New bounded-spawns paragraph. (7) Byte-boundary paragraph gains code-only logging + origin-only clauses ("refusing to echo a value on the reject path while printing it on the accept path is the same leak"). (8) New closing paragraph — the distinguishing rule: the byte boundary would be built WRONGLY under pressure later; a credential-on-disk would be built AT ALL only under pressure later; deferral pre-decides wrongly. (9) D6 paragraph folds C5's four modifications. (10) Frozen literals: `--load-state complete`; error-code vocabulary js_error/navigation_timeout/not_found/invalid_params/invalid_state/not_supported/spawn_error; rename-tab is terminal-surfaces-only on 0.64.22 (also in cmux-dispatch.md).

## C9 — Memory deltas, final

conventions.md: the three v1 entries stand; entry 3 extended (code-only sibling rule — sanitizing the detail bounds volume, not content); NEW spawn-timeout-exceeds-remote-bound entry; NEW create-verb-that-reuses-needs-a-pre-create-authority-scan entry (UUID-derived exclusions, never title/content; verify collision behavior live before treating a duplicate as cosmetic).
backend-notes.md: endorse backend-lead's four verbatim.
qa-notes.md: endorse qa-lead's three verbatim + a fourth from the timing probe (connection-refused leaves a console CLEAN — "0 errors" on a never-loaded page reads identically to success; the liveness flag, not the error count, makes the claim non-vacuous).
architecture-notes.md: ADR-019 as amended by v1.1 §A5 + C8.

## C10 — Unknowns, final

Closed: A1, A2, A3, A4, A7, A8, A9/U4, U1, U5 (superseded by the C7 live gate), backend-lead's dead-port timing. Remaining, mitigated, non-blocking: A10 (first open always splits — post-create check + stamp-anyway), A12 (open vs rung-2 pane reuse — same mitigation, one command in the PR-2 live pass), A5 (clean-literal stability — unrecognized fails not-clean). Named accepted residual: auth-walled apps preview a login page — evidence is thinnest where the app is most interesting; handled by non-overclaiming lines, never by `state load`.
