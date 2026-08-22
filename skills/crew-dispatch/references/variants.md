# Variant routing

The variant is a closed set. Choose by the work's trigger, then supply the
context sources named by that shape; do not invent a fifth shape or infer a
missing lane from the checkout.

```json
{
  "full":     { "trigger": "a diagnosed defect",            "ctx": [] },
  "scout":    { "trigger": "a read-only question",          "ctx": [] },
  "repair":   { "trigger": "CI red",                        "ctx": ["--validation-lane"] },
  "directed": { "trigger": "an orchestrator-authored plan", "ctx": ["--validation-lane"] }
}
```

| Variant | Use when | Seats | Writes | Context |
|---|---|---|---|---|
| `full` | There is a diagnosed defect and the crew must plan, check, build, gate, review, and converge. | The requested tier's seats. | `planned`. | No declared `sources` context is required. |
| `scout` | The question is read-only reconnaissance. | The `planner` seat only. | `none`. | Boot `--roles lead,planner` with no `--tier` and no fence (`--fences` or `--lane`). |
| `repair` | CI is red and the failing run already supplies the bounded scope and validation lane. | The requested tier's seats. | `planned`. | Inherited scope plus `--validation-lane`; its lane source is `ctx`. |
| `directed` | An orchestrator-authored plan already declares the gate and write surface. | `builder` and `reviewer`. | `planned`. | The brief supplies scope and gate; `--validation-lane` supplies the `ctx` lane. |

`full` is the default reviewed shape. A `scout` run is an envelope run: it
must not edit the checkout, and its planner writes notes in the task
workspace. A `repair` run is triage, not a shortened planning loop: it carries
the failing scope and lane into one bounded fix. A `directed` run treats the
brief as the plan and never asks a seat to author a gate it did not receive.

A minimal scout boot is executable as:

```sh
node crew/crew.mjs boot --task <slug> --checkout <dir> --roles lead,planner
```

There is deliberately no `--tier`, `--fences`, or `--lane` on that scout boot;
a read-only question has no write fence to claim. For `repair` and `directed`,
the validation lane belongs on the run invocation as `--validation-lane
<lane>`, exactly as the machine-checked contract declares.
