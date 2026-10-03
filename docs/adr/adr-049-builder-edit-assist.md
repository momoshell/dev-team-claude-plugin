# ADR-049 — Builder edits: answer a failed edit with the file's own text before adding a new edit tool

**Status:** *ratified* 2026-09-29, operator decision (answers in "Operator decisions" below) · **Owner:**
operator · **Relates to:** ADR-045 (scope is context, not enforcement), ADR-046 (a policy decision is a ledger fact),
ADR-048 (ordered build steps)

A builder seat edits with pi's built-in `edit` tool, an exact-text replace: `oldText` must occur exactly once in the
file. The question is whether builders should get a structured edit (symbol-anchored, line- and hash-anchored, or an
AST rewrite) instead, and what evidence would decide it.

Every repository `file:line` below was read at `5666385a`. pi paths are read from the installed pi 0.87.1
(`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/`).

## What the failures are (measured 2026-09-29)

**Source.** Every pi builder seat's `stream.jsonl` under `~/.crew` modified since 2026-09-20. `~/.crew` holds this
repository's lanes and the_power's lanes. Seats are split by the files they edit (`.rs`/`.toml` = the_power).

**Two derivations, and a correction.** The first count took every `toolResult` message line and reported 11,416 edit
calls and 1,244 failures. A single edit's result appears in both a `message_start` and a `message_end` frame, so that
count is doubled. The second derivation counts `tool_execution_end` frames, one per call:

| Repository | Builder seats | `edit` calls | Failed | Rate |
|---|---|---|---|---|
| dev-team | 129 | 1,922 | 195 | 10.1% |
| the_power | 165 | 3,801 | 429 | 11.3% |
| **Both** | **294** | **5,723** | **624** | **10.9%** |

The rate agrees with the first count. The absolute numbers are the second derivation's.

**By cell (dev-team).** muse-spark-1.3 high fails 48 of 700 edits (6.9%), gpt-6-luna high 105/955 (11.0%), gpt-6-luna
medium 15/86 (17.4%), gpt-5.6-terra high 23/137 (16.8%), muse-spark-1.3 medium 4/44 (9.1%). The cells differ by up to
2.5×, so any comparison must be stratified by cell.

**By cause (dev-team, 195 failures).** A failed edit is classified by comparing its `oldText` with every tool output
the seat received earlier in the same assignment:

| Cause | Count | Share | What it means |
|---|---|---|---|
| not unique | 86 | 44% | `oldText` occurs more than once |
| never seen | 52 | 27% | `oldText` appears in no earlier tool output: written from memory or from the plan |
| partly seen | 22 | 11% | its first long line was seen; the rest differs |
| other | 16 | 8% | validation errors, no-op edits, overlapping edits, empty `oldText` |
| indentation only | 9 | 5% | matches a seen output once leading whitespace is ignored |
| seen exactly, no edit since | 7 | 4% | the text was seen and the seat had not edited the file since |
| stale after own edit | 3 | 2% | the text was seen, then the seat's own edit changed it |

the_power's 429 split the same way: never seen 150, not unique 126, partly seen 77, other 46, stale 15, indentation 8,
seen exactly 7. Only 3 of dev-team's 74 never-seen or partly-seen failures were on a file whose full read was replaced
by the skeleton index, so they are not an artifact of `crew/pi/extensions/skeletonread.ts`. The classification is
approximate: `fff_grep` output carries `path:line:` prefixes, so a multi-line match seen only through grep reads as
"partly seen". The classifier is a stream reader, not a shipped instrument.

**What pi already forgives.** `normalizeForFuzzyMatch` (`core/tools/edit-diff.js:31-50`) strips trailing whitespace
and folds smart quotes, Unicode dashes and special spaces before matching. It does not forgive leading indentation,
and nothing can forgive text that is not in the file.

**What it costs.** Each failure is one tool round-trip, so at most one turn. At the measured ~14.6 s of model latency
per turn, dev-team's 195 failures cost at most ~47 minutes over 129 seats and nine days, about 1.5 failed edits per
seat. Whether a failure also triggers extra re-reads is unmeasured. **The prize is modest.** It does not justify a new
tool vocabulary on its own, but it does justify a cheap fix and an instrument.

## What exists today

- **The builder's result hook.** `crew/pi/extensions/builderloop.ts` is granted to every pi builder (`crew/capabilities.json`,
  `roles.builder.by_agent.pi.extensions`). It runs fenced tests after a successful edit or write, and its eligibility
  check skips failed edits (`eligible`, `crew/pi/extensions/builderloop.ts:808-812`). Extensions already rewrite results through
  `pi.on('tool_result', …)` (`attachBuilderLoop`, `crew/pi/extensions/builderloop.ts:822`; `attachReadGate`, `crew/pi/extensions/readgate.ts:620`).
- **Changing a call's arguments.** pi's `ToolCallEventResult` says "To modify arguments, mutate `event.input` in place"
  (`core/extensions/types.d.ts:887-888`). No extension in this repository does that yet.
- **A symbol index.** `exportEntries` (`scripts/factory/make-brief.mjs:2248`) lists **exported** symbols only
  (`exportedSymbolEntries`, `scripts/factory/make-brief.mjs:2174`). The skeleton reader's `retrieve` tool serves a
  symbol only when its row has one body span (`crew/pi/extensions/skeletonread.ts:621-628`).
- **Registering a tool.** Four extensions do it (`crew/pi/extensions/submit.ts:83`, `fff.ts:273`, `skeletonread.ts:757`,
  `lab.ts:1602`), so a new edit tool is possible as an extension. It is not core-only.
- **Everything keyed on the name `edit`.** The census classes a call as an edit by name (`EDIT_TOOLS` in
  `classifyToolCall`, `crew/headless.mjs:510-516`). The ACP permission gate maps tool names to kinds
  (`TOOL_KINDS`, `crew/pi/extensions/acp-server.ts:94`). builderloop's eligibility checks `toolName` for `edit` or `write`
  (`crew/pi/extensions/builderloop.ts:810`).
- **An operator codemod.** `.agents/skills/ast-grep-codemod` proposes a structural rewrite and applies it only with a
  human `--resolve` reason. It shells out to the `ast-grep` binary
  (`.agents/skills/ast-grep-codemod/scripts/codemod.mjs:7-9`).

## Options

**(a) A symbol-anchored `edit_symbol` tool** built on `exportEntries`.
- *Mechanism:* the seat names a symbol and supplies its new body.
- *Fixes:* the not-unique cases where the duplicates sit in different exported symbols.
- *Does not fix:* never-seen text. Tests (`test(...)` blocks), non-exported helpers and code inside a function are
  outside the index, and replacing the whole body of a large exported function to change one line costs more output
  than today's miss.
- *Dependency:* none.
- *Touches:* the three consumers keyed on `edit` above, the pi `--tools` allowlist, and a new builder grant in
  `crew/capabilities.json`, which is on the protected floor.

**(b) A line- and hash-anchored `edit_lines` tool.** This is OMP's approach, and it is portable as an extension.
- *Mechanism:* the seat names a line range and the hash of those lines as it last read them. A stale hash is refused
  with the current lines.
- *Fixes:* not unique, because line numbers disambiguate. It turns never-seen and partly-seen failures into
  refusals that carry the right text, because the seat must quote a hash from something it read.
- *Cost:* the seat needs line numbers, and pi's `read` output carries none, so reads need a numbered mode or a
  companion tool.
- *Touches:* the same consumers and the same protected grant as (a).

**(c) The ast-grep codemod as a seat tool.** Rejected on two grounds. It needs a binary, and the runtime ships zero
dependencies (the `CLAUDE.md` rule, pinned by `crew/acp-client.test.mjs`). Its whole design is a human `--resolve`
gate, which is the opposite of a seat tool. It stays an operator skill.

**(d) Answer the failure, keep the tool.** A builder-only edit assist inside `builderloop.ts`:
- **D1, not unique:** append to the failed result each occurrence's line number with two lines of context.
- **D2, not found:** append the best-matching window of the current file (anchored on the longest `oldText` line
  that occurs in it) with line numbers, or say plainly that none of the lines occur in the file.
- **D3, indentation only:** when `oldText` matches exactly one place in the file once leading whitespace is ignored,
  append that place's exact text with its line numbers to the failed result. It is a hint, never a rewrite of
  `event.input` (operator decision 3), so the model makes every correction and the failure stays measured.
- **D4, the instrument:** journal every failed edit with a closed cause from the table above, so stage 2 is decided on
  shipped data rather than a stream reader.
- *Fixes:* no hint removes the failed turn; D1, D2 and D3 aim to make the next attempt the last one, which today is
  unmeasured.
- *Dependency:* none.
- *Touches:* no new tool name, so the census, the ACP gate and builderloop's eligibility are unchanged, and no new
  grant, because builderloop is already granted.

## Decision

Adopt **(d)** as stage 1. Defer **(b)** to a stage 2 that runs only if stage 1's measurement says so. Reject **(a)**
and **(c)**.

Stage 1 lands in `crew/pi/extensions/builderloop.ts` and its test, and changes that file's own header comment, which
today says failed edits are left untouched (`crew/pi/extensions/builderloop.ts:1-5`). It runs behind an environment
switch the dispatcher can set per lane, so the A/B below needs no roster change.

## Measurement that decides stage 2

- **Arms:** alternate edit assist on and off at dispatch, stratified by builder cell.
- **Floor:** 12 builder seats per arm per cell (`CELL_RATE_FLOOR`, `scripts/factory/ledger.mjs:427`). A cell below
  the floor reads unmeasured.
- **Primary metric:** failed-edit round-trips per 100 edits, and round-trips from a failed edit to the next successful
  edit of the same file. Each is reported with its denominator.
- **Secondary:** builder turns per assignment, and the cause mix from D4.
- **Stage 2 goes ahead** only if the assist arm's anchor-failure rate (not-unique, never-seen, partly-seen and
  indentation causes, per 100 edits, with its denominator) stays **above 5%** in a cell at or above the floor
  (operator decision 4). **Stage 1 is deleted** if the assist arm is not better than control on the primary metric.

## Mutation declarations and the scope gate

**Mutation declarations (#998).** The planner declares gate-check mutations as find/replace text against code the
builder has not written yet. That is the same never-seen failure class, but on the planner's side. No builder edit
tool fixes it. The existing repair is the builder's `mutation_corrections` (`crew/drive.mjs:9598`). D4's cause
classes could later classify declaration drift too. That is out of scope here.

**The scope gate.** Under ADR-045 scope is context, and option (d) changes no path or tool name the gate or the fence
reads. Options (a) and (b) would each need every consumer keyed on `edit` updated (the census, the ACP permission
gate, builderloop eligibility, the pi tool allowlist), plus a grant change on the protected floor.

## Out of scope

- Claude builder seats. They edit with Claude Code's own `Edit` tool, and their failure rate is unmeasured here.
- The planner's predicted text in mutation declarations (see above).
- Any change to pi itself.

## Operator decisions (2026-09-29)

1. **(d) is stage 1.** (b) waits for the measurement; (a) and (c) are rejected.
2. **D1–D4 live in `builderloop.ts`.** No new extension, so no grant change on the protected floor.
3. **No silent rewrite.** D3 is a hint appended to the failed result; the model makes every correction, so every
   failure stays visible to D4.
4. **Stage 2 threshold:** go to (b) only if the assist arm leaves the anchor-failure rate above 5% per 100 edits in
   a cell with at least 12 builder seats per arm.

## Reverses if

The A/B shows edit assist is no better than control on the primary metric, in which case stage 1 is deleted. Or a
pi release adds indentation-tolerant or line-anchored editing upstream, in which case this ADR is re-measured against
that release.
