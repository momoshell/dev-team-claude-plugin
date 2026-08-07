# Architect second opinion — D3 & D6 (issue #12), 2026-08-07

## Q1 — D3 (`browser-verify` verb): AGREE WITH MODIFICATION

The decisive pro-verb argument (stronger than the package's): hand-typed `cmux browser errors list` pipes unreduced page bytes into the ORCHESTRATOR'S own context — the agent composing the gate report and deciding bounce-vs-pass — strictly worse than the rejected Agent-tool validator, because the orchestrator is one step closer to control flow. State it that way in the ADR.

The `cmux diff` precedent transfers ONLY on the permission point (orchestrator-invoked ≠ worker capability, no CMUX_ALLOWS entry). It does NOT transfer on output handling: `cmux diff` renders to a GUI for human eyes; `errors list` lands on stdout in a model transcript. Cite it for the permission half only.

Strongest counter, stated fairly: a dispatch.mjs verb is a permanent orchestrator-facing contract frozen for a feature that's opt-in/off, whose evidence never gates anything, and which can't be live-acceptance-tested in this repo (U5). Exact-precedent alternative never considered: ship PR 1 only, defer PR 2 until a consumer project runs a frontend task — D6's own "descope until observed" logic applied to D3. The answer that defeats it (belongs in the ADR): the reduction boundary is the highest-judgment content and cheapest to build now while the byte-provenance analysis is loaded; deferring guarantees a future hand-typed sequence under time pressure — deferral doesn't preserve the decision, it pre-decides it wrongly.

**Required modifications:**
1. **BLOCKING: every browser wrapper takes an explicit `timeoutMs`, and `browser-verify` has a total wall-clock budget.** `cmux()` passes `opts.timeoutMs` straight to spawnSync (`cmuxctl.mjs:152`) and it is UNDEFINED by default. Nothing guarantees cmux self-bounds (a `goto` to a hanging host); an unbounded verb at the gate stalls the orchestrator's interactive session.
2. **Do NOT add `browser-verify` to the lifecycle-order line** in `references/cmux-dispatch.md` (be-12-03 currently proposes it). Document it in `references/qa-gate.md` beside `cmux diff` (:79-81) as an optional gate adjunct + `cmux-dispatch.md` §1 prose only.
3. **Comment the `MUTATING_VERBS` addition** (`dispatch.mjs:585`): the set means "requires execution_mode: cmux" (consumed only by `assertExecutionModeCmux`), not "mutates a record" — `browser-verify` is the first member for which the name misleads. Also fix `dispatch.mjs:4` "the seven lifecycle verbs" (already wrong — COMMANDS holds eight since `phase`).
4. **Post the reinterpretation to issue #12 as a comment before dispatch** ("driven by the validator" is user-facing contract; precedent: PRE-1C-VERIFY on #4, superseding comment on #2). Same comment carries the D6 descope.

## Q2 — D6 (state save/load descope): AGREE WITH MODIFICATION

The descope is right; two imprecisions + a wrong re-entry checklist:

1. **The re-entry condition prescribes hardening that does not work.** G13/ADR-005's threat is a SAME-UID worker subprocess; mode-0600 protects against other users — security theater here; unlink-on-teardown is far too late. The ratified doctrine is **ADR-003 Am.1 Rider E: confidentiality is bounded by LIFETIME, not achieved by location.** Rewrite: any future state save/load must be lifetime-bounded (written immediately before `state load`, unlinked immediately after, unlinked on every abort path — the 1b nonce lifecycle verbatim), plus never-log and the about:blank origin guard, recording that mode/location buy nothing against G13.
2. **Stop implying the descope avoids ADR-005's residual — PR 1 walks into it.** A human logging into the preview = an authenticated browser surface in the same cmux instance as worker panes, the exact configuration ADR-005's operational rule warns against. D6 declines a REPLAYABLE ON-DISK artifact; it does not avoid the residual. ADR says so plainly; `commands/onboard.md` + `config.md` gain one line beside `cmux_preview_url`: **log the preview into dev/staging accounts only, never production or admin credentials.** Docs-only add to be-12-03.
3. **Report lines must not overclaim** — state only what was observed (console reported no errors after a `complete` wait; screenshot is an unverified capture). [Largely handled by v1.1's load_state_confirmed + prohibited-wording rules; wording flavor to fold.]
4. **Add "surface re-creation" to the re-entry trigger** — D4's create arm on a stale/dead recorded surface silently discards the session; likelier than a cmux restart and currently unnamed.

Strongest counter, stated fairly: for auth-walled apps the preview lands on a login page and the evidence channel is systematically vacuous exactly where it matters most (`clean (0)` + a screenshot of a login screen — or a white PNG). Why it doesn't win: the live surface carries the session build→gate; nobody drives login programmatically (BROWSER_SUBVERBS excludes interaction verbs) — a human logs in in the pane; `state load` would let a FILE manufacture the authenticated surface with no human in the loop, ADR-005's residual in its purest form. The vacuity risk is handled by non-overclaiming report lines, not by the verbs.

## Cross-cutting

The package descopes D6 for an unobserved need and ships D3's gate half for an equally unobserved need. Both defensible ONLY if the ADR states the distinguishing rule: the byte boundary is judgment-dense and gets built WRONGLY under pressure later; a credential-on-disk gets built AT ALL only under pressure later — one is worth pre-paying, the other isn't. Without that sentence the two decisions look made by different rules.
