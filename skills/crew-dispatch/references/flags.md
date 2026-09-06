# CLI flags

The first block is a subset of the runtime's per-verb allow-list. Flag names
are written without the leading `--`; role-prefixed names are accepted only on
`boot`.

```json
{
  "boot": ["task", "checkout", "tier", "roles", "fences", "lane", "headless-all", "max-turns-planner", "max-turns-tech-lead", "max-turns-builder", "max-turns-reviewer", "max-turns-lead", "model-reviewer", "effort-reviewer", "agent-reviewer"],
  "run":  ["task", "checkout", "brief-file", "variant", "files-in-scope", "validation-lane", "plan-rounds", "build-rounds", "review-rounds", "wait-planner", "wait-tech-lead", "wait-builder", "wait-reviewer", "wait-lead", "suite", "keep"],
  "boot_only": ["fences", "lane", "max-turns-planner", "max-turns-tech-lead", "max-turns-builder", "max-turns-reviewer", "max-turns-lead"]
}
```

`KNOWN_FLAGS` is an allow-list for each verb, not one global option bag. The
role-prefixed families `model-`, `agent-`, `effort-`, and `allow-shortfall-`
are a boot-only extension; a concrete suffix such as `model-reviewer` must
still be non-empty. `boot_only` is `fences`, `lane`, then the five
`max-turns-<role>` ceilings in role order: planner, tech-lead, builder,
reviewer, lead.

The per-role wait budgets default to `WAITS_S` and are the flag lever 9 names;
they are `run` flags, not boot flags.

`--max-turns-<role>` is the #870 turn ceiling and is BOOT-only for the same
reason `--fences` is: boot persists it into `crew.json` and journals it at
`run-configuration`, so it is the run's single source of ceiling truth and
cannot be raised mid-run. It is spelled out per role rather than
prefix-matched — the five names are literal members of `KNOWN_FLAGS.boot`, not
a `ROLE_FLAG_PREFIXES` family, so an unknown role suffix refuses as an unknown
option instead of being silently accepted. Absent the flag there is no ceiling
and the journal is byte-identical.

The ceiling is enforced AFTER a seat's envelope returns: over budget, the
driver journals `seat-turn-ceiling` with the count and the budget and bounces
with the count. It does not pre-empt a seat in flight — that is #908. A lead
over its ceiling escalates rather than bouncing, because `askLead` maps every
non-`done` lead envelope straight to escalation and there is no second lead
assignment to carry the count.

## Batch dispatch: the dispatch-batch flag family

`parseCliArgs` accepts these `dispatch-batch` flags:

- Value flags: `--batch --fences --checkout --parent --out --tier --variant --wave --plan-rounds --build-rounds --review-rounds --wait-builder --wait-planner --wait-reviewer --wait-lead --wait-tech-lead --validation-lane --suite --baseline --memory-dir --memory-backend --memory-budget-bytes`.
- Boolean flags: `--dry-run --force --no-keep --headless-all --panes`.
- Repeatable: `--adopt`.
- Prefix-matched per-seat forms: `--agent-<role> --model-<role> --effort-<role> --allow-shortfall-<role>`.

`--batch` and `--fences` are required. Anything else refuses
`unknown option: --<name>`. `--adopt` is accepted by `dispatch-batch` alone —
`crew.mjs` and `make-brief.mjs` have no such flag; see the plan-adoption section
below for its archive contract.

The runtime's misplaced-flag refusal is:

> `crew.mjs <verb> does not read --fences: this is a BOOT-time flag — pass it to \`crew.mjs boot\`, which persists it into crew.json (lane_name/lane_fence) and it is the run's single source of fence truth`

That precision matters. `--lane` on `run` is legal and means the validation
lane, not the boot fence. The misplaced-flag refusal for `--lane` applies to
`handoff`, `wait`, `status`, and `teardown`; it is not a refusal on `run`. A
run that silently treats an intended fence as absent can drive unfenced
(b88-b91). If both `--fences` and `--lane` reach `resolveValidationLane`,
`--fences` suppresses the requested `--lane`, and it returns
`{lane: null, source: 'none'}` silently. Therefore pass the fence to boot and
use the run's `--validation-lane` (or its legal `--lane` meaning) deliberately.

A fenced tier boot supplies both checkout and the fence at boot:

```sh
node crew/crew.mjs boot --task <slug> --checkout <dir> --tier build --fences <fences.json> --lane <lane>
```

A reviewed run supplies its brief, scope, and validation lane explicitly:

```sh
node crew/crew.mjs run --task <slug> --checkout <dir> --brief-file <path> --variant directed --files-in-scope skills/crew-dispatch/ --validation-lane <lane> --plan-rounds 1 --build-rounds 1 --review-rounds 1 --suite "npm test"
```

Do not move `--fences` into that run line. It is persisted by `boot` into
`crew.json` as `lane_name` and `lane_fence`, the run's single source of fence
truth.

## Batch dispatch: plan adoption

The flag form is `--adopt <lane>=<archive-dir>`. Repeat it once for each adopting
lane. A lane request may carry an `adopt` key instead; when both name the same
lane, `--adopt` wins.

The archive is a crew directory: the dispatcher reads its `task/` subdirectory.
Naming the `task` directory itself also works. `plan.md` and `gate.mjs` are
required. If either is missing, dispatch refuses `plan-adopt-unreadable` having
copied nothing. An optional `plan-check.md` carrying `VERDICT: revise` adds the
findings clause to the adopting brief. The adopted plan's `files_in_scope` is
capped by the dispatched write surface, so a narrower current fence wins over
the archived declaration. If a required file is gone at copy time, not only at
`resolveAdoptions`, dispatch refuses `plan-adopt-unreadable` by name with nothing
copied.

The dispatcher writes a `plan-adopted` journal row with the archive path and a
sha256 of the adopted plan.

## Batch dispatch: what `--dry-run` is and is not for

A dry run is not a step of the dispatch recipe. On 2026-09-06 it was invoked
six times and changed no decision once: `external-fence-abandoned`,
`cross-batch-collision` (twice) and `worktree-exists` all refused in the LIVE
dispatch, and the three operator fence errors that day were found by lanes, not
by a dry run. Six invocations on one day is the whole sample — the claim is that
it caught nothing on the day it was measured, never that it has never caught
anything.

A green dry run is cheap to mistake for diligence. The flag says so itself, in
the line it prints last:

> BLIND SPOT — nothing booted, so every check that reads booted state is
> unreachable from here: fence arrival and the sibling count in a lane
> crew.json, boot and workspace failures, compiler refusals, and every journal
> or run outcome. A green dry run is not a validated dispatch.

It cannot see a compiler refusal for a concrete reason: the dry-run branch
returns before `measureBatchBaseline` and before any lane is compiled at all.

Nor is a dry run what keeps a bad register from leaving branches behind.
`checkFences` (with `crossBatchCollisions` inside it) and `resolveAdoptions`
all run before `createWorktrees`, and `resolveAdoptions` says why in its own
comment: a partial adoption is worse than none, so a refusal there has copied
nothing anywhere. Every check capable of catching something already fires
before a worktree exists.

So reach for it only where the branch-creation itself is the thing you are not
ready for:

- a register whose paths you do not trust, when you want the planned worktrees
  echoed back before anything is created;
- a foreign checkout, where creating branches is unwelcome;
- the first run after `onboard`, before this checkout has been dispatched into
  once.

Nothing about the flag changed: it is still an accepted boolean flag of
`dispatch-batch` and still prints exactly what it printed before.
