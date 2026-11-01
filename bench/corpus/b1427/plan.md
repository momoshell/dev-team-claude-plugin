# Plan: pre-return whole-diff consult (PW1–PW4)

Subject: `feat(crew): give pre-return consult the whole diff and brief`

## Minimal changes

### 1. `crew/acp/seat.mjs` — brief acceptance items into the advisor manifest
- Add `briefAcceptanceItems(briefText)` beside `briefTripwires` (seat.mjs:170-181): scan the first
  `## Acceptance` section until the next `## ` heading, collect each `- (ID) text` line trimmed
  (bullet removed, id kept), ignoring other lines. No new imports; do not reuse `loop.mjs`'s
  unexported `acceptanceTexts`.
- In `laneContext`'s manifest object (seat.mjs:234), add exactly this field:
  `acceptance_items: briefAcceptanceItems(briefText),`

### 2. `crew/pi/extensions/advisor.ts` — manifest acceptance through `loadContext`
- In `manifestText`: accept `acceptance_items` only when it is an array of strings; keep non-empty
  trimmed items, each `boundText(item, 512)`, at most 32. Absent/invalid → `[]` (never invalidates
  the manifest or the cell).
- Return it from `manifestText`, and expose it as `acceptance_items` from both `loadContext`
  return shapes (absent-manifest shape included, as `[]`).

### 3. `crew/pi/extensions/advisor.ts` — whole-diff window for pre-return only
- Add exactly: `export const PRE_RETURN_DIFF_BUDGET_BYTES = 48 * 1024`
- `gitDiffLines`: keep collecting every grounded line per file internally (tracked hunks keep
  `path:newLine:` for `+`, old `path:oldLine: (removed)` for `-`; untracked files keep all rows,
  binary/oversize handling unchanged), but keep the returned `entries`/`text` exactly as today
  (first `EXCERPT_LINES` per file). Additively return `files: [{ path, lines }]` with all grounded
  lines (overflow/unknown shapes return `files: []`). Existing callers ignore `files`.
- Add exported `preReturnDiff({ cwd, deps = {}, budgetBytes = PRE_RETURN_DIFF_BUDGET_BYTES } = {})`:
  read `gitDiffLines(...).files` (when a `deps.diffLines` seam result has no `files`, treat each
  entry's lines as one file's lines, path from its first anchor). Pack grounded lines in order,
  one entry per included file segment, counting UTF-8 bytes of `entries.join('\n')`; never exceed
  `budgetBytes`. A file with any unincluded line appears once in `omitted_files` (including a
  partially shown file). Return exactly `return { entries, bytes, omitted_files: omittedFiles, lines }`.
- Add an uncapped grounded-entry builder (e.g. `entryFromText(text, cap)` with the existing
  512-byte default; pre-return passes no cap) so anchors survive past 512 bytes. The stored
  session `delta`, `appendDelta`, `entryFromText` default, `DELTA_ENTRIES` and
  `DELTA_ENTRY_CAP_BYTES` are untouched (PW4).

### 4. `crew/pi/extensions/advisor.ts` — consult wiring
- `preReturnVerdict`: do NOT `appendDelta` the diff. Call `preReturnDiff` (via the existing
  `diffLines` seam result when injected, else the real one), scrub each packed entry with
  `redactDelta` (merging counts into the consult's `redacted` tally), and pass
  `{ preReturn: { entries, bytes, omitted_files } }` to `consult('pre-return', ..., { inline: true, preReturn })`.
- `consult`: the effective snapshot is the scrubbed session-delta snapshot plus the pre-return
  entries (exact-text deduped); the `no-grounded-delta` skip tests the effective snapshot's
  anchors, so a whole diff alone can consult. Snapshot rebuild for pre-return entries uses the
  uncapped builder; other triggers keep today's rebuild. `TIER1_MAX_CONSULTS`, timeout/failure
  pass-through, high-severity blocking and `REPLY_CONTRACT` are unchanged.
- Child stdin: other triggers keep `JSON.stringify({ trigger, delta })`. Pre-return sends exactly
  `{ trigger, delta, acceptance_items: context.acceptance_items ?? [], omitted_files }`.
- Journal: reply contract and all rows unchanged except a pre-return `advisor_consult` row adds
  exactly `window_bytes` (the packed `bytes`), `window_entries` (`entries.length`) and
  `omitted_files`. Keep existing `delta_entries`.

## Tests (same files, existing harnesses)
- `crew/pi/extensions/advisor.test.mjs`: extend `triggerSeat` to record parsed child stdin
  payloads. Add: (PW1) a 250-line committed file changed at line 200 reaches the pre-return
  payload as `lib/big.mjs:200: …` with no prior grounding; (PW2) a manifest carrying
  `acceptance_items` reaches the pre-return payload verbatim; (PW3) files totalling over
  48 KB yield `bytes <= PRE_RETURN_DIFF_BUDGET_BYTES`, the left-out file named in both payload
  `omitted_files` and the consult row (`window_bytes`/`window_entries` matching the payload);
  (PW4) a captured diff-growth payload has `delta.length <= DELTA_ENTRIES` and every entry
  `<= DELTA_ENTRY_CAP_BYTES` despite 20 oversized source entries. Keep all existing tests green
  (adapt `triggerSeat`'s fake diff to the `files`-less seam path above rather than weakening them).
- `crew/acp/seat.test.mjs`: in the pi armLaunch manifest test, pass a brief with an
  `## Acceptance` section and assert `manifest.acceptance_items` deep-equals the items.

## Validation
- `node --test crew/pi/extensions/advisor.test.mjs crew/acp/seat.test.mjs`
- Gate: `node /Users/momoshell/.crew/dt-b1427-pre-return-whole-diff/b1427-pre-return-whole-diff/task/gate.mjs` (cwd = checkout)

## Acceptance map (plan sections)
- PW1: plan.md:22-55
- PW2: plan.md:7-21 and plan.md:47-55
- PW3: plan.md:22-55
- PW4: plan.md:33-35
