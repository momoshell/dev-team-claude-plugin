# Architecture Package — issue #12 (4b: browser singleton, epic #15 / D8)

**Author:** architecture-lead · **Date:** 2026-08-06 · **Status:** draft, pending `dev-team:plan-reviewer`
**Repo:** `/Users/x/Development/dev-team-claude-plugin` · **Base:** `main` @ `b0dcb40`, plugin `0.1.62`

> Orchestrator note: the U1/U2/A8/U4 unknowns in §11 are RESOLVED — see `u2-scout-findings.md` in this directory (A1 verified, A2 corrected to `complete`, A3 failed → record-only singleton, A4 verified with blank-screenshot caveat, plus the stacked-surfaces-undrivable finding) and: ADR-019 confirmed unclaimed (epic #39 sub-issues carry only ADR-007); `onboard.md` confirmed in `CMUX_WIRED_SURFACES` (`test/cmux-contract.test.mjs:618`); `test/cmux-preflight.test.mjs:242-255` asserts `result.unverifiable_verbs`, so the `browser` addition is an expected red covered by the slice lane.

---

## 1. Problem / goal

Epic #15's D8 record is one line (`/Users/x/Development/dev-team-claude-plugin/docs/trd-cmux-execution-mode.md:565`) plus an additive-gate-evidence clause (`:486`) and a promised-but-unwritten `references/qa-gate.md` browser-verify row (`:252`). The issue asks for: one browser surface per task workspace (live preview at build; the same surface driven by-ref at the gate), session continuity via `state save/load`, browser-verify evidence in the gate report, never for backend-only tasks, singleton, torn down with the workspace.

Two of those asks are unbuildable as written and one is unwise:

- **"driven by the validator"** — the reviewer/validator pane flip was shipped-then-reverted 2026-08-04 (architecture-notes.md 2026-08-04). No validator runs in a pane; `CMUX_ALLOWS` is the frozen two-element list and widening it is an ADR-013 amendment.
- **"a split beside the frontend coder's pane"** — cmux 0.64.22 has no anchor-pane argument on `browser open`/`open-split`/`new-pane`.
- **`state save`/`state load`** — writes cookies/localStorage to disk, landing directly on the residual risk ADR-005's addendum names by name, for a benefit that the same-surface build→gate flow already provides for free.

This package resolves all eight open questions decisively, descopes `state save/load`, and reinterprets "driven by the validator" as "driven at the gate by the dispatcher, on the orchestrator's invocation."

---

## 2. Artifact decision

| Artifact | Verdict | Why |
|---|---|---|
| **PRD-lite** | **No** | Product behavior is fully specified by the issue body + TRD D8. No persona/workflow ambiguity. |
| **TRD/RFC** | **No separate doc** | §§3–7 of *this* package are the TRD-lite. The durable content compresses into one ADR; a standalone TRD would be a second copy of the epic TRD's D8 row. |
| **ADR** | **Yes — one: ADR-019** | Six decisions here are durable and revisit-worthy (invoker, singleton mechanism, evidence boundary, the `state save/load` descope). One ADR, not three — this is one feature. |
| **Execution plan** | **Yes** | §7. Three slices, two PRs. |
| **Convention deltas** | **Yes — 3** | §10. Two generalize beyond this feature; one extends the ADR-002 clarification. |

`dev-team:doc-writer` persists the ADR text (§9) into `architecture-notes.md` and the conventions (§10) into `conventions.md` **after** plan-review, orchestrator-committed.

---

## 3. Ground truth this design rests on

Sourced from the discovery digest at `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/tasks/issue-12/discovery-digest.md` plus the gap-fill reads below. Everything marked *verified* was read in the working tree this session or captured in the live 0.64.22 probe; *unverified* items are re-listed in §11.

**Live probe (verified):** `browser open <url> --workspace <ref> --focus false` → `OK surface=surface:N pane=pane:N placement=split`. Second open in the same workspace → `placement=reuse`, **a second surface** — no native singleton. `errors list` clean → the literal `No browser errors`; dirty → `[error] <msg>` lines. `state save` on `about:blank` → `SecurityError`. Sub-verb family: `open|open-split|new goto snapshot wait screenshot console errors state eval viewport` + interaction verbs.

**Code facts confirmed by direct read this session:**

| Fact | Site |
|---|---|
| `VERBS` is a frozen 25-entry array; `runVerb` asserts membership before spawn; `browser` is absent | `scripts/cmux/cmuxctl.mjs:25-30`, `:148-153` |
| `UNVERIFIABLE_VERBS = VERBS.filter(v => !(v in VERB_METHODS)).sort()` — **adding to `VERBS` mutates preflight.json's recorded content** | `cmuxctl.mjs:346` |
| `recoverNewId` throws unless exactly 1 new object of the kind appears | `cmuxctl.mjs:284-292` |
| `mountDocTab` rung 2 creates a `type:'browser'` surface **inside a worker's pane** with `--url file://…` | `cmuxctl.mjs:1058` |
| `findVerifiedDocTabSibling` accepts a `markdown` **or `browser`** typed sibling — but only within `paneId` | `scripts/cmux/dispatch.mjs:1572-1584` |
| `MUTATING_VERBS = new Set(['workspace','dispatch','await','close','teardown','phase'])` | `dispatch.mjs:585` |
| `loadPreflightOrRefuse` is called by **`workspaceCmd` only** (`:695`); `teardownCmd` reads the cache directly via `readPreflightCache(...) \|\| {}` and branches on `close_workspace_available` | `dispatch.mjs:638`, `:695`, `:1953`, `:1967` |
| `workspace.json` is rewritten **wholesale**; `carried` (`:779`) is the single merge point; `env_file` is workspace-id-scoped and omitted-when-null | `dispatch.mjs:766-791` |
| `initial_pane_id` is written at `:783` and **read nowhere** in `scripts/cmux/` | grep, whole dir |
| `teardownCmd` flatMaps **every pane's every surface** → `closeSurface` each | `dispatch.mjs:1960-1963` |
| `reconcile`/`paneAlive` are record-driven; identity is the full `(workspace_id, pane_id, surface_id)` triple | `scripts/cmux/ladder.mjs:508-522`, `:535-554` |
| `spec.domain` is parsed at `dispatch.mjs:908` and dropped | `dispatch.mjs:908` |
| ADR-018 reader shape: `stripFencedCodeBlocks` → one regex per key → >1 match refuses as ambiguous → absent returns null | `dispatch.mjs:119-167` |
| The fake's `LIVE_METHODS` already carries the full `browser.*` family verbatim | `test/fixtures/fake-cmux.mjs:196-217` |
| `test/cmux-dispatch.test.mjs` owns `setUpWorkspace`/`freshCmuxEnv`/`makeSpecFile`; **importing a test file re-registers its whole suite** (backend-notes 2026-08-01) | `test/cmux-dispatch.test.mjs:111,163-170` |

---

## 4. Decisions

### D1 — `browser` is ONE `VERBS` entry, guarded by a frozen sub-verb allowlist, and never enters `VERB_METHODS`

`VERBS` gains exactly one element, `'browser'`. Sub-verbs ride as argv tokens (`cmux('browser', ['errors','list',surfaceId])`) — the `markdown open` shape (`cmuxctl.mjs:1038`), already precedented. A new module-private constant guards the family one level down:

```
const BROWSER_SUBVERBS = Object.freeze(['open', 'goto', 'wait', 'errors', 'screenshot'])
```

`browserVerb(sub, args, opts)` throws **before any spawn** on a sub-verb outside that set — the same shape `runVerb` applies to `VERBS`. `eval`, `state`, `console`, `snapshot`, `viewport` and every interaction verb are structurally unreachable.

**No `VERB_METHODS` entry.** Two reasons, the second decisive:
1. Non-load-bearing verbs degrade, never hard-stop preflight (conventions.md 2026-08-06). No dispatch resolution, completion decision, or gate verdict depends on the browser (see D5).
2. **`VERB_METHODS` maps one CLI verb to one RPC method.** `browser` covers five distinct methods (`browser.open`, `browser.goto`, `browser.wait_for`, `browser.errors`, `browser.screenshot`). Any single mapping would gate the whole family on one method's presence — structurally wrong, not merely conservative. The map cannot express a family.

Capability handling instead: at each of the two call sites, read the already-cached `preflight.json` the way `teardownCmd` does (`readPreflightCache(...) || {}`) and require `Array.isArray(cached.methods) && cached.methods.includes('browser.open')`. Absent, unreadable, or missing → **skip the preview, one loud stderr line naming the remediation** (`brew upgrade --cask cmux`, or re-run `preflight`). Zero preflight.json schema change; every existing cache keeps working (a cache predating `browser.open` in the live methods list simply means no preview until re-preflight, which the 24h staleness warning already nudges).

> **Rejected:** a `VERB_METHODS` entry keyed on `browser.open`. It buys a preflight hard-stop on *every* dispatch — including backend-only tasks that will never open a browser — in exchange for detecting a feature we already detect at the point of use, where the failure is free.
> **Rejected:** a new derived `browser_available` boolean in `preflight.json`. It changes a worker-adjacent cached artifact's shape (`isValidPreflightCache`, `cmuxctl.mjs:366`) for information the `methods` array already carries verbatim.

**Consequence to handle:** `UNVERIFIABLE_VERBS` (`cmuxctl.mjs:346`) is derived from `VERBS` minus `VERB_METHODS`, so adding `browser` changes `preflight.json`'s recorded content. `test/cmux-preflight.test.mjs` must be in every validation lane for slice A.

### D2 — Creation uses `cmux browser open`, and the id comes from a tree diff, not from the printed line

`browserOpen(url, { workspaceId })` issues `cmux browser open <url> --workspace <ws-uuid> --focus false`, then recovers the surface id and pane id by **before/after `tree({all:true})` diff** via `recoverNewId`. The printed `OK …` line is parsed for the `placement` token only, which is **logged and never persisted**.

Two independent reasons the printed id is not usable:
1. **It is a positional ref.** The probe returned `surface=surface:6 pane=pane:5`. This repo persists UUIDs only and never positional refs (ADR/U-4, conventions.md 2026-08-01) — the printed id could not be written to `workspace.json` even if we wanted it.
2. Resolving a positional ref to a UUID needs a `tree` read anyway, so the diff is strictly simpler than parse-then-resolve.

`browser open` beats `new-surface --type browser --url` because `browser open` with a real `http(s)` URL is **live-verified this session**, while `new-surface --type browser --url` is live-**unverified** even for the `file://` case its own call site admits (`cmuxctl.mjs:1047-1051`). Choosing the verified path over the unverified one is this repo's own doctrine. `browser` must enter `VERBS` regardless (for the gate verbs), so there is no marginal verb cost.

> **Rejected:** `new-surface --type browser --url <http-url> --workspace <id> --focus false`. Already in `VERBS` and already fake-modeled — but it trades a live-verified call for an unverified one to save an allowlist entry we are adding anyway.

### D3 — The invoker: `dispatchCmd` creates; a new orchestrator-invoked `dispatch.mjs browser-verify` verb collects evidence. `contract.mjs` is byte-identical.

**Build phase.** `dispatchCmd` calls `ensurePreviewBrowser(...)` in the cosmetic-degradation zone — after `sendLine` and `mountDocTab`, immediately before `setPhase('building')` (`dispatch.mjs:1097-1110`), inside its own `try/catch` that logs and continues. A preview failure can never fail a dispatch, and creating it after the worker is live maximizes the chance cmux's default split lands next to the pane that just became relevant.

**Gate phase.** A new CLI verb, `node dispatch.mjs browser-verify --task <slug>`, joins `MUTATING_VERBS` (`dispatch.mjs:585`) — execution-mode-gated and workspace-binding-required like every other mutating verb. The orchestrator invokes it at the gate, from its own interactive session, exactly as it invokes `phase --set gate`.

This is the `cmux diff` precedent (`references/qa-gate.md:81`, conventions.md 2026-08-04) applied one notch further: an orchestrator-invoked gate surface needs **no `CMUX_ALLOWS` entry**. `contract.mjs` stays byte-identical; ADR-013's freeze is untouched; no worker ever runs a `cmux browser` verb.

The issue's "driven by-ref by the validator" is reinterpreted, deliberately and on the record: **the dispatcher drives the surface by UUID at the gate, and the reduced evidence reaches the validator's reviewer bundle and the gate report as data.** The validator itself stays an Agent-tool subagent with no cmux reach.

> **Rejected (a): orchestrator hand-types the whole sequence.** conventions.md 2026-08-01 is explicit that mechanical, failure-prone verb sequences belong in a tested script, not orchestration prose. This sequence is four cmux calls with UUID resolution, a fresh-tree corroboration, a filesystem write, and a byte-boundary reduction. Hand-typed, "console errors clean" would be a human eyeballing page-controlled prose — the exact vacuity class qa-notes.md warns about, with no ADR-002 boundary enforceable by anything.
> **Rejected (b): an Agent-tool validator with Bash running `cmux browser …`.** Technically possible (Agent-tool subagents aren't roster-profile-sandboxed) and strictly worse: it pipes unreduced page-controlled bytes (`errors list`, `snapshot`) straight into the context of the agent that emits the verdict enum the gate branches on. That is a prompt-injection ingress with a control-flow consumer at the far end. Reject on the merits, not merely as unbuilt.
> **Rejected (c): waiting for the validator pane flip.** It is blocked on two unbuilt designs (dispatch-time-baseline `clean` postcondition; `extractSection` runtime shadowing — architecture-notes.md 2026-08-04). #12 must not inherit that dependency.

### D4 — Singleton: the `workspace.json` `browser` block is the key, a fresh tree is the authority, a frozen tab title is the fallback, and ambiguity fails closed

Recorded in `workspace.json` (schema-free, takes new keys freely — how `tier` and `env_file` landed), joining `carried` at `dispatch.mjs:779`:

```json
"browser": {
  "surface_id": "<lowercase-uuid>",
  "pane_id":    "<lowercase-uuid>",
  "workspace_id": "<lowercase-uuid>",
  "url": "<cmux_preview_url at creation>",
  "created_at": "<ISO8601 with ms>"
}
```

Key omitted entirely when there is no preview — never `"browser": null` (the `env_file` precedent, `dispatch.mjs:785-790`).

**Resolution order, every time, before any create:**

1. Read `workspace.json`, then read a **fresh** `tree({all:true})`.
2. If the recorded `surface_id` is present in the tree, typed `browser`, and inside a workspace whose id equals both the recorded `workspace_id` and the live bound `workspace_id` → **reuse.** Zero cmux create calls, nothing re-stamped. (Steady state, silent.)
3. Otherwise scan the bound workspace for browser-typed surfaces whose title equals the frozen literal `PREVIEW_TAB_TITLE = 'dev-team preview'`:
   - exactly 1 → **adopt** (stamp its ids, no create);
   - 0 → **create** (D2), then `renameTab(surfaceId, PREVIEW_TAB_TITLE)`, then stamp;
   - **≥2 → fail closed:** create nothing, log one loud `preview_surface_ambiguous` line, skip the preview for this dispatch. Ambiguous ≠ absent — the `findDocTabSurface` `{id, ambiguous}` and `deriveTurnEndAt` N≥2-collision-arm-none precedents (`dispatch.mjs:1246-1251`), and the failure mode architecture-notes calls "exactly the fail-open hole that let an ambiguous pane accumulate panels forever."

**Why the title key exists at all:** `mountDocTab` rung 2 legitimately creates `type:'browser'` surfaces (`cmuxctl.mjs:1058`), so "any browser-typed surface in the workspace" is *not* a valid singleton scan — it would conflate doc tabs with the preview. Doc-tab browsers carry a `file://` URL as their title and never the frozen literal, so the title discriminates cleanly. Title-keyed reuse is already this repo's pattern (`ensureWorkspace` re-finds by title, `cmuxctl.mjs:599-643`).

**The design is safe if the title key does not work** (see §11-U3): the record key carries all steady-state behavior; a failed title scan degrades to "0 found → create," and the worst case is a second preview after a `workspace.json` loss — cosmetic, and teardown sweeps both.

**`workspaceCmd` carries the block forward verbatim** in `carried`, exactly like `tier` — no validation, no refusal. This is a **deliberate asymmetry vs `env_file`**, which refuses four ways on a reuse mismatch (`dispatch.mjs:740-758`): an env file is a security-relevant ingress that cannot be retroactively applied to a live workspace, whereas a stale preview record is corroborated against a fresh tree by every consumer and simply re-creates. Refusing a dispatch because a preview browser died would be the tail wagging the dog. State this in the code comment; a reviewer will ask.

> **Rejected:** a type-only tree scan (no record). Cannot distinguish the preview from a rung-2 doc tab, and re-derives the surface on every call with no provenance.
> **Rejected:** record-only (no title fallback). Loses the surface permanently on a malformed/deleted `workspace.json` while a live preview keeps occupying a pane, and the next dispatch stacks a second one.

### D5 — Evidence: a reduced `{clean, count, shape}` tuple + a screenshot path in `stateDir`. It never gates the verdict.

**New pure module** `scripts/cmux/browser-evidence.mjs` — the `triage.mjs` pattern applied to page bytes instead of screen bytes:

```
BROWSER_ERRORS_CLEAN_LINE = 'No browser errors'   // frozen live capture, 0.64.22
reduceBrowserErrors(stdout) -> { clean, count, shape }
```

- trimmed stdout === the clean literal → `{ clean:true,  count:0,    shape:'clean' }`
- ≥1 line matching `/^\[error\]/` → `{ clean:false, count:N,    shape:'errors' }`
- anything else → `{ clean:false, count:null, shape:'unrecognized' }` — **fails toward not-clean**, never toward clean.

**No message text ever leaves the function.** `browserErrorsList` is the only wrapper that returns raw page bytes; its JSDoc names `reduceBrowserErrors` as its single legal consumer. The module imports nothing from this repo, and `ladder.mjs` / `triage.mjs` / `contract.mjs` never import it — asserted by a source-text import-firewall test, the exact `triage.mjs`↔`ladder.mjs` guard (architecture-notes.md 2026-08-06).

**Screenshot** → `<stateDir>/browser/verify-<compact-ISO>.png`, path composed entirely by the dispatcher. `stateDir` because it is parent-side and never `--add-dir`'d (siting rule + Rider C/D): a screenshot of a logged-in app in `taskDir` would be published to every concurrently dispatched worker. Teardown archives/deletes `stateDir` wholesale, so it is swept for free (the `.collapsed` sidecar precedent, `resolve.mjs:172-184`). Existence is confirmed by an independent `existsSync`, never by cmux's `OK <path>` — `closeSurface`'s never-report-success discipline generalized.

**`snapshot` is dropped from this slice.** The accessibility tree is a large page-controlled blob with no reduction that is both non-vacuous and non-injecting. Named as a non-goal, not an omission.

**The gate never branches on this.** D17 stands: the gate branches on the parsed `{verdict, findings}` enum alone (`references/qa-gate.md:65-77`). Browser evidence is an **additive evidence line** (TRD `:486`). A dirty console does not block; it appears in the gate report and the reviewer bundle. The orchestrator, being a judgment agent, may *choose* to bounce after reading it — that is judgment, not a mechanical branch, and the distinction is stated in both `references/qa-gate.md` and the code comment, because branching on it is precisely the ADR-002 violation a future reader will be tempted to "fix in."

Gate-report line shapes (orchestrator-composed, from `browser-verify`'s JSON):
- `browser-verify: console errors clean (0) · screenshot <abs path>`
- `browser-verify: 3 console error(s) — screenshot <abs path>` (count only, never a message)
- `browser-verify: console-error output in an unrecognized shape — treat as unverified · screenshot <abs path>`

> **Rejected:** passing `errors list` prose through to the report for the human. It reads as harmless and is the ingress: prose in a gate report is prose in the orchestrator's context, which *does* drive control flow.
> **Rejected:** a triage.mjs-style closed-enum signature match on error messages. Buys nothing here — a count is already the whole actionable signal, and a signature table invites growth into a decision input.

### D6 — `browser state save` / `state load` does not ship in this slice

Descoped, deliberately, against a line of the issue body.

The stated purpose is auth continuity coder→gate. **The same surface persists across build and gate in the same cmux instance**, so the live session already carries it — `state save/load` adds value only across a cmux restart or a surface recreation. Against that narrow benefit:

- State files carry cookies and localStorage: secrets on disk, in the same `stateDir` a same-uid worker subprocess can reach (G13).
- ADR-005's addendum names *authenticated browser surfaces near worker panes* as **the** residual risk of the whole cmux posture. `state load` is the verb that manufactures exactly that.
- `state save` throws `SecurityError` on `about:blank` (live-verified), so it needs a pre-navigation guard whose failure mode is a confusing error on a feature nobody asked for twice.

Shipping it would make this slice's largest delta a secrets-on-disk surface in service of a crash-recovery case that has never been observed.

**Re-entry condition, recorded in ADR-019:** a live case where a cmux restart between build and gate lost an auth session *and* re-login was expensive enough to justify writing credentials to disk. At that point the design owes a mode-0600 file, an unlink-on-teardown path, an explicit never-log rule, and a `state save` origin guard — a slice of its own.

> **Rejected:** shipping it "since the verbs exist." Verb availability is not a reason; it is the whole shape of over-architecting.

### D7 — Trigger, teardown, and the lifecycle non-interactions

**Trigger** (all four required, evaluated in `dispatchCmd`):
1. `readCmuxPreviewUrl(configText)` returns a URL (absent = feature off = today's behavior exactly);
2. `spec?.domain === 'frontend'` — defensive read; anything else, including a missing field, means no preview;
3. `resolved.isolation === 'worktree'` — the role actually builds code. In today's roster that is `coder`, which is literally "the frontend coder's pane" from the issue; expressed as a property, not a role name, so it does not go stale;
4. `browser.open ∈ cached preflight methods` (D1).

"Never spawned for backend-only tasks" is then structural: a backend spec never satisfies (2).

**Teardown: zero new code.** `teardownCmd` flatMaps every pane's every surface in the bound workspace and `closeSurface`s each (`dispatch.mjs:1960-1963`) — the preview is in a pane of that workspace, so it is already closed. `stateDir`'s wholesale sweep removes `browser/` screenshots and `workspace.json`. The only new work is a **regression test** asserting the preview surface id appears in the fake's close-surface invocation log. Resisting a dedicated close path is the decision.

**Verified non-interactions** (each gets a regression test):

| Surface | Why the preview is invisible to it |
|---|---|
| `reconcile` / `classify` / `paneAlive` | Record-driven; identity is the full triple (`ladder.mjs:508-522`). The preview is in no record. **No record-level invisibility work is needed.** |
| `closeCmd`'s doc-tab collapse | `findDocTabSurface` is **pane-scoped** (`dispatch.mjs:1572-1584`). The preview lives in its own pane, so it can never be mistaken for a doc-tab sibling and can never authorize a terminal close. |
| `statusCmd` | Builds rows from records only. |
| `workspaceCmd`'s `initial_pane_id = ws.panes[0].id` (`:764`) | A new pane could theoretically shift index 0 on a later `workspace` run — **inert**: `initial_pane_id` is written at `:783` and read nowhere in `scripts/cmux/`. Noted in the code comment so a future reader who gives it a consumer knows to revisit. |

**Placement:** accept cmux's default. No `move-surface`, no `split-off`. Moving the preview *into* the coder's pane would stack it as a tab and destroy the simultaneous visibility that is the entire point; "beside pane X" is not expressible. `--focus false` on create; no browser wrapper ever issues a focus verb. The reported `placement` token is logged so a live acceptance run can observe what actually happened. Adjacency stays a human concern, per the issue.

### D8 — Preview URL: a config key, not a spec field; the coder starts the server; the gate re-navigates

`cmux_preview_url` in `.claude/dev-team/config.md`, read by `readCmuxPreviewUrl(configText)` in `dispatch.mjs` beside `readCmuxEnvFile` — the ADR-018 reader shape verbatim: fenced-block-stripped, one regex, **>1 line ⇒ `OperationalError` "ambiguous (a fenced example?), refusing"**, absent/blank ⇒ `null` = today's behavior. Read fresh on every invocation that needs it (never cached into `workspace.json` as authority — the block's `url` is provenance only).

Value validation, throw-before-any-spawn:
- scheme must be `http` or `https` — **the load-bearing refusal** (`file:`, `data:`, `javascript:` are refused);
- full-match against a printable URL charset allowlist (`^https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$`) — allowlist, never a denylist (conventions.md 2026-08-01; qa-notes.md 2026-08-05);
- length ≤ 2048.

Refusal messages name the reason and the scheme, **never the full value** — a dev URL can carry a token query param, same hygiene class as the env-file refusals (`dispatch.mjs:173-186`). The URL rides argv (never `sendLine`, whose charset refuses `?`/`&` anyway), so there is no shell-injection path.

**Who starts the dev server: the coder, in its own pane, per its own spec.** The dispatcher never starts a server — that would be a new execution surface with no permission model. The consequence is accepted and handled: the browser is very likely created before the server listens, so the first paint is a connection error. `browser-verify` therefore always runs `errors clear` → `goto <configured url>` → `wait --load-state complete` → `errors list`, which both re-navigates and gives a clean, attributable error window that excludes the pre-server failed load.

> **Rejected:** a `handover-spec.schema.json` field. A root-schema contract edit (deep-review class), a workflow-mode coupling, and every lead would have to author it — for a value that is a property of the *project*, not the *task*.

---

## 5. Architecture / behavior summary

```
workspace  ──► workspace.json { tier, window_id, workspace_id, initial_*, [env_file], [browser] }
                                                                            ▲          │
dispatch(frontend coder spec)                                               │ stamp    │ carry
   … sendLine → mountDocTab                                                 │ (verbatim, in `carried`)
   └─ ensurePreviewBrowser()  ── fresh tree ─► reuse | adopt | create | ambiguous:skip
        create: cmux browser open <url> --workspace <ws> --focus false
                → tree-diff recoverNewId → renameTab 'dev-team preview' → stamp
   … setPhase('building')

gate: orchestrator ──► dispatch.mjs browser-verify --task <slug>
        resolve preview from workspace.json + fresh tree  (absent → exit 0, preview_present:false)
        errors clear → goto <cmux_preview_url> → wait --load-state complete → errors list → screenshot --out
        raw errors stdout ──► browser-evidence.reduceBrowserErrors ──► {clean,count,shape}
        stdout JSON: { surface_id, url, console_errors, screenshot_path, warnings }
   ──► orchestrator composes ONE additive gate-report line.  Verdict branches on {verdict,findings} ONLY.

teardown: existing flatMap(panes→surfaces)→closeSurface sweeps the preview; stateDir sweep removes screenshots.
```

---

## 6. Interface contracts

**IC-1 — `workspace.json.browser`** (written by slice B, read by B and C). Shape in D4. Rules: omitted-when-absent; joins `carried` (`dispatch.mjs:779`); carried verbatim by `workspaceCmd`; **every consumer corroborates against a fresh tree and checks `workspace_id` equality before use**; only `workspaceCmd` and `dispatchCmd` write it — `browser-verify` is read-only on it.

**IC-2 — cmuxctl browser wrappers** (slice A produces; B and C consume). All take ids explicitly and **throw before any spawn** on a missing/malformed id (conventions.md 2026-08-06). All degrade loudly — one stderr line, `null`/`false` return — and **never throw** on a cmux failure (the `setStatus`/`readScreen` shape).

```
browserOpen(url, { workspaceId })   -> { surfaceId, paneId, placement } | null   // --focus false; tree-diff id recovery
browserGoto(surfaceId, url)         -> boolean
browserWaitLoad(surfaceId, { timeoutMs = 20000 }) -> boolean                     // --load-state complete --timeout-ms N
browserErrorsClear(surfaceId)       -> boolean
browserErrorsList(surfaceId)        -> string | null    // RAW page bytes — sole legal consumer: reduceBrowserErrors
browserScreenshot(surfaceId, outPath) -> boolean        // caller confirms via existsSync, never the OK line
PREVIEW_TAB_TITLE                   = 'dev-team preview'   // exported frozen literal, single definition site
```

**IC-3 — `browser-evidence.mjs`** (slice C). Shape in D5. Zero repo imports; never imported by `ladder.mjs`/`triage.mjs`/`contract.mjs`; firewall asserted by source-text test.

**IC-4 — `browser-verify` stdout JSON** (slice C produces; `references/qa-gate.md` documents for the orchestrator):

```json
{ "preview_present": true, "surface_id": "…", "url": "https://…",
  "console_errors": { "clean": true, "count": 0, "shape": "clean" },
  "screenshot_path": "/abs/…/verify-20260806T142530123Z.png",
  "warnings": [] }
```
Absent-preview form: `{ "preview_present": false, "reason": "preview_disabled" | "no_preview_recorded" | "preview_surface_gone" | "preview_surface_ambiguous", "warnings": [] }`.
**Exit code discipline:** exit 0 whenever the verb ran, including a dirty console and including `preview_present:false` — the verb reports, it never judges. Exit 1 only on operational failure (no workspace bound, unreadable preflight, cmux unreachable); exit 2 on usage error.

---

## 7. Execution plan

**Three slices, two PRs.** The issue says "one coder, one PR"; #11's precedent establishes that a design may propose otherwise. Justification: every `scripts/cmux/*.mjs` edit routes the PR to the 3-reviewer adversarial panel, and the panel is per-PR. One PR would put ~700 lines across 12 files — mixing frozen-allowlist widening, dispatch-lifecycle wiring, and a prompt-injection byte boundary — under a single panel. Splitting gives the ADR-002 boundary (the highest-judgment content) its own undivided review. Two panels, not three: slices A and B are meaningless apart and share one panel.

### PR 1 — live preview (`feat: cmux 4b browser preview singleton; bump 0.1.63`)

#### Slice `be-12-01` — cmuxctl browser family + fixture (backend, worktree)

`files_in_scope`: `scripts/cmux/cmuxctl.mjs`, `test/fixtures/fake-cmux.mjs`, `test/cmux-dispatch.test.mjs`

Work: `VERBS += 'browser'` (`:25-30`); the `BROWSER_SUBVERBS` frozen allowlist + `browserVerb()` throw-before-spawn guard; the six IC-2 wrappers + `PREVIEW_TAB_TITLE`; a comment at the `VERB_METHODS` definition site (`:58-63`) stating **why** `browser` is excluded, in the decision-not-omission voice the existing comment uses. Fake-cmux: a new `case 'browser'` handling `open|goto|wait|errors|screenshot`, unknown sub-verb → `fail('bad_args')`.

**Fixture doctrine (E-P1, non-negotiable):** `open` prints `OK surface=surface:<n> pane=pane:<n> placement=split` with **positional** refs, exactly as live — so any implementation that parses the printed id instead of tree-diffing produces a non-UUID and fails the schema pattern. Second open in the same workspace prints `placement=reuse` and creates a **second** surface, mirroring the probe. `errors list` prints the frozen `No browser errors` unless `_simulateBrowserErrors: ["…","…"]` is pre-seeded in state, in which case `[error] <msg>` lines. `errors clear` empties it. `screenshot --out <p>` writes a real byte to `<p>` and prints `OK <p>`. `wait` succeeds unless `_simulateBrowserWaitTimeout` is seeded. **All hostile/degraded cases are `_simulate*` state flags, never new env switches.**

Tests (in `test/cmux-dispatch.test.mjs`): positives first (each wrapper's happy path, argv asserted element-by-element with exact counts); `--focus false` present on `browserOpen`'s argv; each wrapper throws before spawn on a missing id with **zero** logged invocations; an out-of-allowlist sub-verb throws before spawn; a cmux failure degrades to `null`/`false` without throwing; `browserOpen` under `_simulateConcurrentCreate` surfaces the `recoverNewId` ambiguity rather than guessing.

`validation_commands`: `node --test test/cmux-dispatch.test.mjs test/cmux-preflight.test.mjs test/cmux-contract.test.mjs`

#### Slice `be-12-02` — config key, singleton, dispatch wiring (backend, worktree; `depends_on: be-12-01`)

`files_in_scope`: `scripts/cmux/dispatch.mjs`, `test/cmux-dispatch.test.mjs`, `.claude-plugin/plugin.json` (→ `0.1.63`)

Work: `readCmuxPreviewUrl` + `PREVIEW_URL_LINE_RE` + the D8 validator, placed beside `readCmuxEnvFile` (`dispatch.mjs:123-137`); `ensurePreviewBrowser({ paths, workspaceId, url, cachedMethods })` implementing D4's resolution; the `dispatchCmd` hook with the four-part D7 trigger, inside a `try/catch` that logs and continues, sited between `mountDocTab` (`:1100`) and `setPhase('building')` (`:1107`); the preflight-cache read in `dispatchCmd` mirroring `teardownCmd:1953`; `carried` at `:779` gains verbatim `browser` carry-forward with the "why this does not refuse like `env_file`" comment; a comment at `:764` recording that `initial_pane_id` has no reader today.

Tests: **A/B on the same fixture, flipping only the key** — with `cmux_preview_url` absent, a frontend dispatch issues **zero** `browser` invocations and writes no `browser` key; with it set, exactly one `browser open` with the exact argv. `makeSpecFile(ctx, sliceId, {domain:'frontend'})` vs the default `'backend'`. Then: reuse issues zero creates on a second frontend dispatch; a stale recorded `surface_id` re-creates; a `workspace_id` mismatch re-creates; two title-matching surfaces → zero creates + the ambiguity log; a rung-2 doc-tab browser in a worker pane is **not** adopted; `workspaceCmd` re-run preserves the block; `closeCmd`'s doc-tab collapse decision is unchanged with a preview present; `teardownCmd` closes the preview surface; a `browser open` failure leaves the dispatch `code: 0`; two `cmux_preview_url:` lines refuse with zero cmux invocations; a `file://` / `javascript:` URL refuses before any spawn.

`validation_commands`: `node --test test/cmux-dispatch.test.mjs test/cmux-preflight.test.mjs test/cmux-contract.test.mjs`

### PR 2 — gate evidence (`feat: cmux 4b browser-verify gate evidence, ADR-019; bump 0.1.64`)

#### Slice `be-12-03` — evidence reducer, `browser-verify` verb, full doc footprint (backend, worktree; `depends_on: be-12-02`)

`files_in_scope`: `scripts/cmux/browser-evidence.mjs` **(new)**, `scripts/cmux/dispatch.mjs`, `references/qa-gate.md`, `references/cmux-dispatch.md`, `commands/onboard.md`, `.claude/dev-team/config.md`, `test/cmux-browser-evidence.test.mjs` **(new)**, `test/cmux-dispatch.test.mjs`, `test/cmux-dispatch-doc.test.mjs`, `.claude-plugin/plugin.json` (→ `0.1.64`)

Work: `browser-evidence.mjs` (IC-3); `browserVerifyCmd` + CLI wiring + `MUTATING_VERBS` at `:585`; screenshot siting/`mkdirSync`/`existsSync` confirmation.

Docs: `references/qa-gate.md` gains the TRD-promised browser-verify row — the invocation, the three report-line shapes, and the explicit **"this is evidence, never a verdict input; the gate still branches on the parsed `{verdict, findings}` enum alone"** sentence, sited beside the `cmux diff` section (`:79-81`) which it mirrors. `references/cmux-dispatch.md` gains a `| browser <sub> …` §2 row, a §2 footer note that `browser` is not capabilities-gated and why, a §1 paragraph on the preview singleton + `browser-verify` + the `state save/load` non-goal, and `browser-verify` added to the lifecycle-order line. `commands/onboard.md` + `.claude/dev-team/config.md` document `cmux_preview_url` (fenced examples only — the reader strips fences, and this repo's key stays **unset**, so the feature is provably inert here). `test/cmux-dispatch-doc.test.mjs` pins the new rows/prose.

**No A9 guard change:** `onboard.md` was admitted to `CMUX_WIRED_SURFACES` at #7 — confirmed at `test/cmux-contract.test.mjs:618`.

Tests: reducer positives first (clean literal → `{true,0,'clean'}`), then negatives (1/3/N `[error]` lines → exact counts; a page-authored line *containing* the clean literal as a substring must NOT read clean — anchored/trimmed-equality, killing an `includes()` implementation; garbage → `'unrecognized'`, `clean:false`). Import-firewall source-text test (no repo imports out; no imports in from `ladder`/`triage`/`contract`). **Mutation-grade leak test:** with `_simulateBrowserErrors: ['<secret-marker> at foo.js:1']`, assert that marker appears in **neither** the verb's stdout JSON **nor** its captured stderr. End-to-end: verb argv order is exactly `errors clear → goto → wait → errors list → screenshot`; the screenshot file exists; `preview_present:false` with each of the four reasons exits 0; a dirty console still exits 0; `browser-verify` refuses under `execution_mode: agent-tool`; a `cmux_preview_url` differing from the recorded block's `url` navigates to the configured one and emits a warning without rewriting `workspace.json`.

`validation_commands`: `node --test test/cmux-browser-evidence.test.mjs test/cmux-dispatch.test.mjs test/cmux-dispatch-doc.test.mjs test/commands.test.mjs test/cmux-contract.test.mjs`

**Ship-time only:** `node --test` (full suite) runs once at `/dev-team:ship`, never in a slice lane.

---

## 8. Acceptance criteria (package-level)

1. With `cmux_preview_url` **absent**, every existing behavior is byte-identical: zero `browser` invocations on any dispatch, no `browser` key in `workspace.json`, and the A/B test proves it on the same fixture with only the key flipped.
2. `contract.mjs` is byte-identical across all three slices; `CMUX_ALLOWS` remains the two-element list.
3. A second frontend dispatch in the same workspace issues **zero** `browser open` calls; two title-matching browser surfaces produce zero creates plus a `preview_surface_ambiguous` log line.
4. A rung-2 doc-tab browser surface is never adopted as the preview.
5. Every `browser open` argv contains `--focus false`; no browser wrapper issues any focus verb (source-text assertion).
6. The preview's surface id is never sourced from cmux stdout — `browserOpen` recovers via `recoverNewId`; a fixture printing positional refs proves the parse path would fail.
7. No page-controlled byte reaches the `browser-verify` JSON, stderr, or disk (outside the screenshot PNG) — proven by the seeded-marker leak test, not by inspection.
8. Browser evidence never appears in any control-flow branch; `references/qa-gate.md` states so explicitly, and `browser-verify` exits 0 on a dirty console.
9. `teardownCmd` closes the preview surface with **zero** teardown-specific new code.
10. `closeCmd`'s collapse decision and `reconcile`'s rows are unchanged in the presence of a live preview (regression tests).
11. Doc footprint complete: `references/cmux-dispatch.md` §2 row + §1 prose, `references/qa-gate.md` browser-verify row (discharging TRD `:252`), `commands/onboard.md` + `config.md` key docs, `test/cmux-dispatch-doc.test.mjs` pins.
12. Both PRs bump `.claude-plugin/plugin.json` and end their commit message with `; bump 0.1.NN`.

---

## 9. Proposed ADR — ADR-019

> **ADR-019 — The task-workspace browser is a singleton preview surface, dispatcher-created and dispatcher-driven; its page bytes are reduced before they exist as evidence, and they never gate a verdict.**
> **Status:** proposed · **Date:** 2026-08-06 · **Scope:** cmux execution mode, Phase 4b (issue #12, epic #15 D8) · **Supersedes:** nothing; refines TRD D8 (`docs/trd-cmux-execution-mode.md:565`) and discharges the `:252` qa-gate promise. **Number:** 019 — 014/015/016 claimed by parked epic #23; 017/018 ratified in this epic.
>
> **Opt-in, off by default.** One config key, `cmux_preview_url`, read with the ADR-018 reader doctrine (fenced-block-stripped, one line or refuse-as-ambiguous, absent = today's behavior exactly). Scheme restricted to `http`/`https` by allowlist; refusals name the reason and the scheme, never the value. A preview is created only when the key is set **and** the spec's `domain` is `frontend` **and** the role's isolation is `worktree` **and** the cached preflight's methods include `browser.open` — so backend-only tasks are structurally incapable of spawning one.
>
> **`browser` enters `VERBS` as a single entry guarded by a frozen sub-verb allowlist** (`open goto wait errors screenshot` — no `eval`, `state`, `console`, `snapshot`, or interaction verbs), and **never enters `VERB_METHODS`**: that map is one-verb-to-one-method and cannot represent a five-method family, and the preview is non-load-bearing, so it must degrade loudly rather than hard-stop preflight for every dispatch including the ones that will never open a browser. Availability is read at the point of use from the already-cached `preflight.json` methods array, the way teardown reads `close_workspace_available`.
>
> **The created id comes from a tree diff, never from stdout.** `cmux browser open` prints `OK surface=surface:N pane=pane:N placement=split` — a *positional* ref, which this repo may not persist. `placement` is logged and discarded. `browser open` is chosen over `new-surface --type browser --url` because it is live-verified for an `http` URL while the latter is unverified even for `file://`.
>
> **Singleton = a `workspace.json` `browser` block (record) + a fresh tree (authority) + a frozen tab title (fallback), failing closed on ambiguity.** The block joins `carried`, is workspace-id-scoped, and is omitted when absent. Resolution is reuse / adopt / create / **skip-on-ambiguous** — two title-matching surfaces create nothing and log, because ambiguous is not absent. The title fallback exists because `mountDocTab` rung 2 creates legitimate browser-typed surfaces, so a type-only scan is wrong. Unlike `env_file`, a reuse mismatch **does not refuse the dispatch**: an env file is a security ingress that cannot be retroactively applied, a dead preview is cosmetic and simply re-creates.
>
> **The dispatcher is the only invoker, at both ends.** `dispatchCmd` creates (in the cosmetic zone — a preview failure never fails a dispatch). A new orchestrator-invoked `dispatch.mjs browser-verify` verb collects evidence at the gate. No worker ever runs a `cmux browser` verb; `contract.mjs` and `CMUX_ALLOWS` are byte-identical; ADR-013's freeze holds. The issue's "driven by the validator" is reinterpreted: the dispatcher drives the surface by UUID and the reduced evidence reaches the validator's bundle as data — the validator itself has no cmux reach, and the reverted pane flip is not a dependency. An Agent-tool validator running the verbs itself was rejected on the merits: it pipes unreduced page bytes into the context of the agent that emits the verdict enum the gate branches on.
>
> **ADR-002 boundary, extended from screen frames to page bytes.** `browser errors list` output is task-controlled, prompt-injection-class text. `scripts/cmux/browser-evidence.mjs` reduces it in-process to `{clean, count, shape}` — a count and a closed three-value shape enum, never a message — and is import-firewalled from `ladder.mjs`/`triage.mjs`/`contract.mjs` by test, exactly as `triage.mjs` is. Unrecognized output fails toward *not clean*. The raw bytes never reach JSON, a log line, or disk. The screenshot lands in `stateDir` (parent-side, never `--add-dir`'d, swept by teardown), and its existence is confirmed by an independent read, never by cmux's `OK` line. **The evidence is additive and never gates the verdict** — the gate branches on the parsed `{verdict, findings}` enum alone (D17). The orchestrator may exercise judgment after reading it; that is judgment, not a mechanical branch, and the distinction is stated in both `references/qa-gate.md` and the code.
>
> **`browser state save`/`state load` does not ship.** The same surface persists build→gate in one cmux instance, so the live session already carries auth; the verbs add value only across a restart. Against that, state files are cookies and localStorage on disk in a `stateDir` reachable by a same-uid worker subprocess (G13), which is precisely the residual risk ADR-005's addendum names — authenticated browser surfaces near worker panes. Shipping it would make this slice's largest delta a secrets-on-disk surface for an unobserved recovery case. *Re-entry condition:* an observed cmux restart between build and gate that lost an expensive login; at that point the design owes a mode-0600 file, an unlink-on-teardown path, a never-log rule, and a `state save` origin guard (it throws `SecurityError` on `about:blank`), as its own slice.
>
> **`snapshot` is a named non-goal** — a large page-controlled blob with no reduction that is both non-vacuous and non-injecting.
>
> **Placement is cmux's default; no `move-surface` is issued.** No anchor-pane argument exists, and moving the preview into the coder's pane would stack it as a tab and destroy the simultaneous visibility that is the point. Adjacency stays a human concern (the issue's own words); `--focus false` on create; the reported `placement` is logged for live acceptance.
>
> **Teardown needs no new code:** `teardownCmd` already closes every surface in every pane of the bound workspace, and the `stateDir` sweep removes the screenshots. The preview is invisible to `reconcile`/`paneAlive` (record-driven) and to `closeCmd`'s collapse (pane-scoped), so no record-level invisibility mechanism is needed — only regression tests pinning those non-interactions.
>
> *Why:* D8's ratified record was one line, and the three under-specified parts each had a wrong-looking obvious answer — gate the family on one RPC method, let the validator drive the browser, save the session to disk. Each is recorded here with its rejection reason so a future slice does not re-derive them.

---

## 10. Proposed conventions.md deltas

> - **2026-08-06** — **A cmux verb family whose sub-verbs are argv tokens enters `VERBS` as ONE entry and is guarded by its own frozen sub-verb allowlist one level down; it never enters `VERB_METHODS`.** `VERB_METHODS` is a one-verb→one-RPC-method map, so a family (`browser` → `browser.open|goto|wait_for|errors|screenshot`) cannot be represented in it without gating five capabilities on one name. A single `VERBS` entry would otherwise unlock the whole family — including `eval` and `state` — so the wrapper module asserts membership in a frozen `<FAMILY>_SUBVERBS` array and throws before any spawn, mirroring `runVerb`'s own check. Availability is read at the point of use from the cached `preflight.json` `methods` array (the `close_workspace_available` shape), never by widening the preflight gate. *Why:* extends the 2026-08-06 cosmetics rule from a policy argument (non-load-bearing verbs should degrade) to a structural one (the map physically cannot express a family), and closes the over-widening the single entry would otherwise create. Source: ADR-019, issue #12 (`be-12-01`).
> - **2026-08-06** — **A created object's id is recovered by tree diff even when cmux prints one — printing an id is not a reason to skip `recoverNewId`.** `cmux browser open` is the one creation verb that prints its result (`OK surface=surface:6 pane=pane:5 placement=split`), and the printed ids are **positional refs**, which this repo may never persist. Parse such a line only for non-identifying tokens (`placement`), log them, and discard. A fixture modelling such a verb must print the positional form verbatim, so an implementation that parses the id instead of diffing produces a non-UUID and fails. *Why:* the 2026-08-02 "all created-object id recovery goes through a tree diff" rule was justified by "no verb prints its id"; one now does, and the rule survives for a different reason (UUID-only persistence) that a future reader would otherwise not reconstruct. Source: ADR-019, issue #12 (`be-12-01`).
> - **2026-08-06** — **Every family of task-controlled bytes gets its own import-firewalled reducer module, and the "raw bytes never leak" claim is proven by a seeded-marker mutation test, never by inspection.** `triage.mjs` established the shape for screen frames; `browser-evidence.mjs` repeats it for browser console output. Rules: the reducer imports nothing from the repo and is imported by no decision module (`ladder`/`triage`/`contract`), asserted by a source-text test; exactly one wrapper returns the raw bytes and its JSDoc names its single legal consumer; the reduction is a count plus a closed enum, never a message; an unrecognized shape fails toward the *unsafe* reading, never the clean one; and a test seeds a unique marker into the hostile fixture and asserts it appears in neither the produced JSON nor the captured stderr. *Why:* "never logs the untrusted bytes" is vacuous unless a removal of the reducer fails a test (2026-08-02 mutation rule), and the second instance of a pattern is where it becomes a convention rather than a one-off. Source: ADR-019, issue #12 (`be-12-03`).

---

## 11. Open unknowns & assumptions

*(A1–A4, A7, A8, U1, U4 resolved by the orchestrator 2026-08-06 — see the header note and `u2-scout-findings.md`. Remaining live items below.)*

- **A5** — `No browser errors` stable across cmux versions: verified on 0.64.22, unverified as a contract. `shape:'unrecognized'` arm fails toward not-clean.
- **A6** — `--config` sidecar rejected as the key's home: verified by inspection.
- **A9** — `MUTATING_VERBS` drift guard: unverified; one test line if it exists, coder sees it red immediately.
- **U3** — qa-lead consult: 2-PR/2-panel split confirmation.
- **U5** — this repo cannot dogfood the feature (no dev server; `cmux_preview_url` stays unset here). No live end-to-end acceptance of #12 in this repo — record in the PR; re-check on first consumer-project frontend task. L1–L4 precedent applies.

**Non-goals, stated so they are not re-litigated:** `state save`/`state load` (D6); `snapshot` as evidence (D5); anchored/adjacent placement (D7); any browser evidence gating a verdict (D5); any worker-side `cmux browser` capability (D3).

---

## 12. Recommended team dispatch

- ~~Live cmux scout (U2)~~ **done** (orchestrator, 2026-08-06).
- **qa-lead consult** — (i) 2-PR/2-panel split (U3); (ii) PR-2 lens swap (ADR-002 data-plane boundary replacing permission-boundary); (iii) seeded-marker leak test + anchored-vs-includes() negative as the reducer's mutation bar.
- **backend-lead consult** — confirm `ensurePreviewBrowser` belongs in `dispatch.mjs` (policy, reads workspace.json) vs `cmuxctl.mjs` (pure enumerated boundary).
- **architect second opinion** — D3 (new `browser-verify` verb vs alternatives) and D6 (state save/load descope against the issue body).
- **plan-reviewer** on this package before any dispatch.
- **PR 1 gate** — test-engineer first and alone, then 3-reviewer adversarial panel (lenses: permission-boundary / cmux-surface-discipline / contract-coherence; blocking overrides: any contract.mjs/CMUX_ALLOWS diff, any focus verb, any persisted positional ref, any fail-open on singleton ambiguity).
- **PR 2 gate** — same wave order; lenses: ADR-002 data-plane boundary / cmux-surface-discipline / doc-contract-coherence; blocking override: any page-controlled byte reaching JSON, a log line, or disk outside the screenshot PNG.
- **Mutations for test-engineer:** delete `reduceBrowserErrors` and pass raw stdout; drop the fresh-tree corroboration; drop the `workspace_id` equality check; drop `--focus false`; change the ambiguity arm from skip to create-anyway; replace anchored equality with `includes()`.

---

## 13. Proposed memory deltas

| Target | Entry | Status |
|---|---|---|
| `architecture-notes.md` | ADR-019 (§9) | proposed → ratify at plan approval |
| `conventions.md` | 3 entries (§10) | proposed |
| `backend-notes.md` | `ensurePreviewBrowser` siting + `initial_pane_id`-has-no-reader | post-ship |
| `qa-notes.md` | positional-ref fixture anti-vacuity device; U5 no-live-acceptance gap | post-ship |
| `frontend-notes.md` | first real content if the preview runs against a consumer project | post-ship |
