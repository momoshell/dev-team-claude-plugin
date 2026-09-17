# Variant routing

The variant is a closed set. Choose by the work's trigger, then supply the
context sources named by that shape; do not invent a shape or infer a missing
lane from the checkout.

```json
{
  "full":     { "trigger": "a diagnosed defect",            "ctx": [] },
  "scout":    { "trigger": "a read-only question",          "ctx": [] },
  "review_only": { "trigger": "a declared base/head code review", "ctx": [] },
  "review_panel": { "trigger": "a read-only three-seat base/head code review", "ctx": [] },
  "repair":   { "trigger": "CI red",                        "ctx": ["--validation-lane"] },
  "directed": { "trigger": "an orchestrator-authored plan", "ctx": ["--validation-lane"] },
  "verify_only": { "trigger": "a declared behavior to verify", "ctx": [] }
}
```

| Variant | Use when | Seats | Writes | Context |
|---|---|---|---|---|
| `full` | There is a diagnosed defect and the crew must plan, check, build, gate, review, and converge. | The requested tier's seats. | `planned`. | No declared `sources` context is required. |
| `scout` | The question is read-only reconnaissance. | The `planner` seat only. | `none`. | Boot `--roles lead,planner` with no `--tier` and no fence (`--fences` or `--lane`). |
| `review_only` | A declared base/head change set needs a structured code review. | The `reviewer` seat only; an optional tech-lead may be booted for rigorous assurance. | `none`. | Read-only validation; no checkout writes. |
| `review_panel` | A declared base/head change set needs an independent three-seat code review. | `reviewer`, `tech-lead`, and `lead`; reviewer and tech-lead are blind, then lead adjudicates fused divergences. | `none`. | Immutable base/head identity, separate per-seat coverage, one shared changed-files denominator, fused actionable findings, and retained dismissed provenance; no checkout writes or commit. |
| `verify_only` | A declared behavior needs independent verification evidence. | The `reviewer` seat only. | `none`. | Read-only validation; no lane context and no checkout writes. |
| `repair` | CI is red and the failing run already supplies the bounded scope and validation lane. | The requested tier's seats. | `planned`. | Inherited scope plus `--validation-lane`; its lane source is `ctx`. |
| `directed` | An orchestrator-authored plan already declares the gate and write surface. | `builder` and `reviewer`. | `planned`. | The brief supplies scope and gate; `--validation-lane` supplies the `ctx` lane. |

`full` is the default reviewed shape. A `scout` run is an envelope run: it
must not edit the checkout, and its planner writes notes in the task
workspace. A `repair` run is triage, not a shortened planning loop: it carries
the failing scope and lane into one bounded fix. A `directed` run treats the
brief as the plan and never asks a seat to author a gate it did not receive.

A `review_only` run is an envelope run: it returns the declared base/head identity, a closed outcome, structured findings (or an explicitly measured no-findings empty list), `reviewed_files` paths, and `unreviewable_files` `{path, reason}` rows. Unreviewable reasons are closed to `binary`, `generated`, `too-large`, and `out-of-context`; both lists must be bounded to the base/head change set and remain disjoint. The driver accepts it only with the unchanged zero-write scope proof; there is no commit.

A `review_panel` run is a read-only envelope run: reviewer and tech-lead independently return the review-only fields against the immutable base/head pair, and lead returns exact one-to-one uphold/dismiss adjudications for collision-safe divergences plus its own coverage. The driver keeps each seat's coverage separate, carries the immutable changed-files denominator once, fuses matching findings, reattaches complete origin fields for actionable findings, and retains dismissed findings as provenance while excluding them from `details.findings`. The checkout remains zero-write and no commit is made.

A `verify_only` run is an envelope run for reviewer-only verification: it returns complete target, assumption, product-verdict, check-matrix, environment, and blocker evidence. It has no lane context, writes nothing to the checkout, and accepts ephemeral build/test artifacts only while checks run; those artifacts must be removed before return so the final checkout is clean.

A minimal scout boot is executable as:

```sh
node crew/crew.mjs boot --task <slug> --checkout <dir> --roles lead,planner
```

There is deliberately no `--tier`, `--fences`, or `--lane` on that scout boot;
a read-only question has no write fence to claim. For `repair` and `directed`,
the validation lane belongs on the run invocation as `--validation-lane
<lane>`, exactly as the machine-checked contract declares.
