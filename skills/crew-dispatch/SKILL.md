---
name: crew-dispatch
description: >-
  Load when dispatching a crew lane: choosing a variant, preparing its
  worktree, compiling and verifying fences, selecting tier, or writing boot
  and run flags that must execute against the current CLI.
---

# Crew dispatch

This skill is the operator's routing layer for a new lane. Use the references
below for the closed CLI contracts and for the measured failure modes that make
a parsed brief or a green-looking dispatch insufficient evidence.

## Routing

| Doing… | Read | Rule |
|---|---|---|
| Choosing a lane shape | `references/variants.md` | Match the trigger and supply every context source the variant declares. |
| Measuring convergence and plan cost | `references/convergence.md` | Use the nine measured levers to settle the brief and seat budget. |
| Dispatching a batch | `references/batch.md` | Follow the refusal-aware sequence and verify fence arrival. |
| Choosing shell invocation | `references/shell.md` | Keep shell for invocation and node for logic, at the measured boundary. |
| Writing boot or run arguments | `references/flags.md` | Treat `KNOWN_FLAGS` as per-verb, and keep boot-only fence state at boot. |
| Compiling and checking a fence | `references/fences.md` | Check both compiler passes, consumers, and arrival in the live lane. |
| Choosing tier for a protected surface | `references/tier.md` | Apply the floor at plan-accept and settle the pane tier at boot. |
| Isolating and closing the checkout | `references/worktree.md` | Use a real worktree, detect dirty symlinks, and rebase before the PR. |

## Critical rules

- Verify a fence through its consumers, not by reading the register alone (#145).
- `--fences` is a BOOT-time flag; the run that silently treats its fence as absent drives unfenced (b88-b91).
- A protected-path hit on a pane lane means `--tier judge` AT BOOT (#507, b80-handle).
- When a protected hit is separable, split the lane instead of dragging the whole surface through the floor (#507).
- A design left in a build brief is the largest measured cost (#588 lever 1); settle it before dispatch.
- The protected floor is the resolved union, not the authored constant.
- Compile the fence register twice: first to discover coupled sources, then to acknowledge exactly them (#145).
- Verify that the fence ARRIVED in `crew.json` and `journal.jsonl`, not merely that it parsed (b88-b91).
- Rebase the lane onto `main` before opening the PR (#500).

## Key references

- [`references/variants.md`](references/variants.md) — closed variant shapes and their context sources.
- [`references/convergence.md`](references/convergence.md) — nine measured levers and plan-cost evidence.
- [`references/batch.md`](references/batch.md) — refusal-aware batch dispatch and arrival checks.
- [`references/shell.md`](references/shell.md) — measured shell invocation boundaries.
- [`references/flags.md`](references/flags.md) — per-verb flags, boot-only flags, and worked invocations.
- [`references/fences.md`](references/fences.md) — two-pass compilation, consumer checks, and fence arrival.
- [`references/tier.md`](references/tier.md) — protected-path floor, pane seating, and split-lane cost.
- [`references/worktree.md`](references/worktree.md) — worktrees, the symlinked dependency trap, and rebase.
