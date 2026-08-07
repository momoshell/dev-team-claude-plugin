# Architecture Package v1.1 — AMENDMENT (delta to `architecture-package-v1.md`)

**Date:** 2026-08-06/07 · **Trigger:** U2 live scout, cmux 0.64.22 (`u2-scout-findings.md`)
**Scope:** amends D4, D5, D8, IC-2, IC-4, §7 slice contents, §8 acceptance criteria, §9 ADR-019 text, §11 unknowns. **Unchanged:** D1, D2, D3, D6, D7, §10 conventions, the two-PR split, version numbers (0.1.63 / 0.1.64).

Headline: the scout **strengthened** the design's core (fail-closed singleton) and **falsified one mechanism** (the frozen tab title). Nothing in the decision set reverses; one arm is rebuilt on trusted state instead of page-controlled text.

## A1 — D4 amended: the adopt arm is rebuilt on record-derived pane topology, not on a title

**Deleted:** `PREVIEW_TAB_TITLE`, the `renameTab` call after create, and the entire title-scan fallback. A3 falsified both halves — `rename-tab` returns `not_found` on a browser surface, and a browser surface's `tree` title tracks the page **hostname**, i.e. it is navigation-controlled, page-influenced text. Selecting a topology target with page-controlled bytes would violate this package's own D5 boundary; that alone would disqualify a title heuristic even if `rename-tab` had worked.

**v1 said the design was "safe if A3 is false" because the record key carries the steady state.** That escape is now the design — but the scout's stacked-surfaces finding removes the option of leaving the fallback arm empty. Two browser surfaces in one pane leave **both undrivable** (`js_error: Timed out waiting for the browser document to become ready`, blank screenshot), verified in both directions. So "record lost, live preview still present → create a second" is no longer a cosmetic duplicate; it is a **self-inflicted total loss of the feature for the remainder of the task**. The fallback arm must exist and must fail closed.

**Reachability of the lost-record state:** a corrupted/deleted `workspace.json` makes `dispatch` refuse (`no workspace bound`), forcing a `workspace` re-run, which rewrites the file wholesale from a null `priorState` — the `browser` block is gone while the live preview surface survives in the reused workspace.

### D4 (amended) — resolution order

Unchanged steps 1–2 (read `workspace.json` + a fresh `tree`; recorded `surface_id` present, browser-typed, `workspace_id` matching both the record and the live binding → **reuse**, zero creates, nothing re-stamped). This still carries essentially all traffic.

Step 3 is replaced. Compute **candidate panes** in the bound workspace from parent-side trusted state only — no surface titles, no URLs, no page bytes:

> A pane is a **candidate** iff (a) `pane.id !== workspace.json.initial_pane_id`, **and** (b) `pane.id` is not the `surface.pane_id` of **any** dispatch record in `paths.dispatchDir` — including terminated records, since a collapsed doc-tab browser outlives its dispatch — **and** (c) it holds ≥1 browser-typed surface.

Then, in order:

1. **Any candidate pane holds ≥2 browser-typed surfaces → fail closed** (`preview_pane_stacked`). Create nothing, adopt nothing, log one loud line, skip the preview. This is the verified-undrivable state: creating would compound it, adopting would hand `browser-verify` a surface that times out and screenshots white.
2. Otherwise the **adopt set** = candidate panes holding **exactly one surface**, that surface browser-typed.
   - exactly 1 → **adopt** (stamp its ids; no create, no rename).
   - 0 → **create** (D2, unchanged).
   - ≥2 → **fail closed** (`preview_surface_ambiguous`). Ambiguous is not absent.

Clause (b) is what the title key was actually protecting against: `mountDocTab` rung 2 creates browser-typed surfaces inside worker panes, and ADR-004's collapse-on-close can reduce such a pane to *only* that browser surface — which the old "exactly one surface, browser-typed" shape alone would have adopted. Every worker pane is named by a record, so record-derived exclusion covers the collapsed case exactly, with zero page bytes and zero heuristics.

> **Rejected (explicitly, on this package's own rules):** discriminating the preview by `http(s)://` vs `file://` in the surface title. The title is navigation-controlled — a page that navigates can steer it — so it is task-controlled text selecting a topology target. D5/ADR-002 forbids exactly that. It is available, it would mostly work, and it is the wrong kind of correct.

**New, from A10:** `browserOpen` returns the recovered `paneId`. If that pane equals `initial_pane_id` or any record's `surface.pane_id`, log `preview_landed_in_worker_pane` loudly and **stamp anyway** — the record key still drives every consumer; only future adoption is forfeited. No orphan-close (closing could take a worker pane's surface with it).

## A2 — IC-2 / D8 amended: `complete`, `js_error`, no rename

**IC-2 (replaces the v1 block):**

```
BROWSER_LOAD_STATE = 'complete'          // frozen; 'load' is INVALID on 0.64.22 (accepted: interactive|complete)
browserOpen(url, { workspaceId })     -> { surfaceId, paneId, placement } | null
browserGoto(surfaceId, url)           -> boolean
browserWaitReady(surfaceId, { timeoutMs = 20000 }) -> boolean   // --load-state complete --timeout-ms N
browserErrorsClear(surfaceId)         -> boolean
browserErrorsList(surfaceId)          -> string | null           // RAW page bytes; sole consumer reduceBrowserErrors
browserScreenshot(surfaceId, outPath) -> boolean
```

- `browserWaitLoad` → **renamed `browserWaitReady`** so no caller can re-introduce the `load` literal by name association. `BROWSER_LOAD_STATE` is a single-definition-site frozen export; the literal `'load'` must appear nowhere in `scripts/cmux/`.
- **`PREVIEW_TAB_TITLE` and the post-create `renameTab` are deleted.** The preview surface is never renamed.
- **`js_error` is an expected error code, never an exception.** Browser sub-verb failures arrive as `Error: js_error: <detail>` (exit 1), which parses under `ERROR_LINE_RE` (`cmuxctl.mjs:155`) to `{ code: 'js_error', message: <detail> }`. Every wrapper treats it as an ordinary degrade — one stderr line, `false`/`null` return, never a throw.
- **New: `safeDetail(msg)` — bounded error-detail logging.** A `js_error` detail can carry page-influenced text, and `dispatch.mjs`'s stderr IS an orchestrator-context ingress. Wrappers log `js_error` + the sub-verb verbatim, and the detail only through `safeDetail`: collapse `[\r\n]+` to a space, drop non-printable-ASCII, truncate to 120 chars. It never enters any JSON output. Consistent with the markdown-reason sanitizer precedent (backend-notes.md 2026-08-02).

**D8** — the `browser-verify` sequence is now `errors clear → goto <configured url> → wait --load-state complete --timeout-ms 20000 → errors list → screenshot --out <path>`; a `wait` failure sets `load_state_confirmed: false` and the verb still proceeds and still exits 0.

## A3 — D5 / IC-4 amended: the blank-screenshot caveat is structural, not prose advice

A4's caveat is the load-bearing new fact: `screenshot` returned `OK` and wrote a **full-size pure-white PNG** on a surface that never became ready. `existsSync` cannot detect blankness. A gate-report line presenting a screenshot path as evidence of a rendered app would be capable of lying with a file on disk to back it up — the "reviewer passes a diff it never saw" failure family (`references/qa-gate.md:55`) transplanted into visual evidence.

**IC-4 gains one field:**

```json
{ "preview_present": true, "surface_id": "…", "url": "https://…",
  "load_state_confirmed": true,
  "console_errors": { "clean": true, "count": 0, "shape": "clean" },
  "screenshot_path": "/abs/…/verify-20260806T142530123Z.png",
  "warnings": [] }
```

`load_state_confirmed` is the `browserWaitReady` return, verbatim — **orthogonal** to `console_errors.clean` (never merged: "loaded with 3 errors" ≠ "never loaded").

**Gate-report line composition (normative, in `references/qa-gate.md`):**
- `load_state_confirmed: false` → the caveat **leads** and the clean claim is **suppressed**:
  `browser-verify: page never reached load-state complete (wait timed out) — console-error and screenshot evidence are UNRELIABLE for this run · screenshot <abs path>`
- confirmed + clean: `browser-verify: page reached load-state complete · console errors clean (0) · screenshot <abs path>`
- confirmed + dirty: `browser-verify: page reached load-state complete · 3 console error(s) · screenshot <abs path>`
- Skipped forms carry the D4 reason enum, now including `preview_pane_stacked`.

**Prohibited wording, stated verbatim in the doc:** the line never says "verified", "renders correctly", or "the app works". Screenshot success means a file exists, nothing more.

Everything else in D5 stands: the reducer, the import firewall, the seeded-marker leak test, `stateDir` siting, `snapshot` non-goal, and **browser evidence still never gates the verdict** (`load_state_confirmed: false` is not a gate failure; exit 0).

## A4 — Slice, test, and acceptance-criteria deltas

### `be-12-01` (cmuxctl + fixture) — additions

**Fixture fidelity (all live-derived, no new env switches):**
1. **`rename-tab` fails on non-terminal surfaces** — `fail('not_found', 'Tab not found')` when target `type !== 'terminal'`. General fidelity fix; production renames only `createPane`'s terminal surface.
2. **A browser surface's `title` tracks the URL hostname**, set on `open`, updated on `goto` — so no test can depend on a stable title and a future title-keyed heuristic fails immediately.
3. **Stacked-pane undrivability modeled from topology, not a flag:** second `browser open` into a workspace with an existing preview pane → `placement=reuse`, second surface in the same pane; thereafter `wait`/`errors` on ANY surface in a pane holding ≥2 browser-typed surfaces → `fail('js_error', 'Timed out waiting for the browser document to become ready')`, while `screenshot` still succeeds and writes a file. `_simulateBrowserWaitTimeout` retained for the single-surface wait-timeout path (the only way to exercise `load_state_confirmed: false` in isolation).

**New tests:** `--load-state complete` in `browserWaitReady` argv + literal `'load'` absent from `scripts/cmux/` (source-text); `rename-tab` on a browser surface fails + no production call site does it (source-text); `js_error` degrades without throw, one stderr line; `safeDetail` collapses newlines, strips non-printables, truncates at 120.

### `be-12-02` (singleton) — replaced test set for the fallback arm

- 1 candidate pane (one browser surface, pane in no record, not `initial_pane_id`) → **adopt**, zero opens, block stamped.
- 0 candidates → create.
- 2 candidates → zero creates, `preview_surface_ambiguous` logged.
- A candidate pane holding 2 browser surfaces → zero creates, `preview_pane_stacked` logged (**the regression that matters most**).
- A rung-2 doc-tab browser in a worker pane is not a candidate (pane in a record's `surface.pane_id`).
- **A collapsed doc-tab pane** (terminal closed per ADR-004, browser surface alone) is not a candidate — must be pinned explicitly.
- `initial_pane_id` never a candidate.
- `preview_landed_in_worker_pane` logs and still stamps on `browserOpen` pane collision.

### `be-12-03` (evidence + docs) — additions

- `load_state_confirmed` in the JSON for both arms; `false` on wait failure; verb still exits 0, still emits `screenshot_path`.
- Suppression rule behavioral: JSON carries `load_state_confirmed: false` alongside `console_errors` (both facts, never merged).
- `test/cmux-dispatch-doc.test.mjs` pins the qa-gate.md caveat sentence + three composed-line shapes.
- `references/cmux-dispatch.md` §2 `browser` row states the `complete` literal + the `js_error` shape.

### §8 acceptance-criteria deltas

- **AC3 replaced:** a second frontend dispatch issues zero `browser open` calls; a second candidate pane, or any candidate pane holding ≥2 browser surfaces, produces zero creates plus the corresponding loud line.
- **AC4 replaced:** a rung-2 doc-tab browser is never adopted — including after ADR-004 collapse leaves it alone in its pane.
- **New AC13:** no production code calls `renameTab` on a non-terminal surface; fixture fails it if any does.
- **New AC14:** `--load-state complete` in every `browserWaitReady` argv; literal `'load'` nowhere in `scripts/cmux/`.
- **New AC15:** `js_error` degrades without throwing; logged detail is one line, printable-ASCII, ≤120 chars.
- **New AC16:** `browser-verify` returns `load_state_confirmed`; `references/qa-gate.md` states the white-PNG caveat and forbids "verified"/"renders correctly" phrasing — both pinned by the doc test.

## A5 — ADR-019 text amendments (for doc-writer)

1. **Singleton paragraph** — replace "a frozen tab title (fallback)" with: *"and, when the record is lost, a fallback that identifies the preview pane from parent-side state alone — a pane in the bound workspace that is neither the reserved initial pane nor any dispatch record's pane, holding exactly one browser-typed surface. Surface titles are never used: a browser surface's title tracks the page hostname, so it is navigation-controlled text, and selecting a topology target with page-controlled bytes is the boundary violation this ADR exists to prevent (live-verified: `rename-tab` also does not work on a browser surface at all)."*
2. **Add to the same paragraph** — *"The singleton is an operational requirement, not hygiene: two browser surfaces stacked in one pane leave **both** undrivable (`js_error: Timed out waiting for the browser document to become ready`; blank screenshot), live-verified in both directions on 0.64.22. Every ambiguous state therefore fails closed — create nothing, adopt nothing, log — because a second `browser open` destroys the feature for the rest of the task rather than merely duplicating it."*
3. **ADR-002 boundary paragraph** — append: *"Screenshot success is not evidence of a rendered page: on a surface that never became ready, `screenshot` returns `OK` and writes a full-size white PNG. `browser-verify` therefore reports `load_state_confirmed` alongside the console reduction, and the gate report suppresses any clean claim when it is false. The verdict is still untouched — an unconfirmed load state is evidence, not a failure, and the verb still exits 0."*

Also add to the frozen-literals note: `--load-state complete` (`load` invalid on 0.64.22; accepted set `interactive|complete`).

## A6 — §11 unknowns, updated

A1 VERIFIED · A2 CORRECTED→`complete` · A3 FALSIFIED (mechanism deleted, replaced) · A4 VERIFIED w/ blank-PNG caveat (mitigated by `load_state_confirmed`) · A5 unchanged · A7/U1 CONFIRMED (ADR-019 free) · A8 CONFIRMED (`test/cmux-contract.test.mjs:618`) · A9 still unverified (one-line fix if red) · U4 RESOLVED (`test/cmux-preflight.test.mjs:242-255`, expected red, lane covers).

**New:**
- **A10 (unverified):** first `browser open` in a workspace always yields `placement=split` (new pane) — "first open with idle initial pane" wasn't isolated. Handled, not flagged: `browserOpen` returns `paneId`; collision → `preview_landed_in_worker_pane`, stamp anyway, forfeit future adoption only. No new scout needed.
- **A11 (verified):** `Error: js_error: <detail>` parses cleanly under existing `ERROR_LINE_RE`. No regex change.
- **U5 (sharper):** this repo cannot dogfood — the cmux mechanics are scout-covered; the *composition* (real app, real dev server, real gate) stays unexercised until the first consumer-project frontend task. Record in PR 2.

**No new blocking scout.**

## A7 — Unchanged, restated

D1, D2, D3, D6, D7, the three conventions deltas, two-PR/two-panel split, test-engineer-first-and-alone, PR-2 lens swap. **Panel brief addition:** any fail-open on singleton ambiguity is now a blocking-class finding regardless of majority (the scout turned the singleton from hygiene into correctness), alongside the existing overrides.
