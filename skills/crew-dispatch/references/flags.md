# CLI flags

The first block is a subset of the runtime's per-verb allow-list. Flag names
are written without the leading `--`; role-prefixed names are accepted only on
`boot`.

```json
{
  "boot": ["task", "checkout", "tier", "roles", "fences", "lane", "headless-all", "model-reviewer", "effort-reviewer", "agent-reviewer"],
  "run":  ["task", "checkout", "brief-file", "variant", "files-in-scope", "validation-lane", "plan-rounds", "build-rounds", "review-rounds", "wait-planner", "wait-tech-lead", "wait-builder", "wait-reviewer", "wait-lead", "suite", "keep"],
  "boot_only": ["fences", "lane"]
}
```

`KNOWN_FLAGS` is an allow-list for each verb, not one global option bag. The
role-prefixed families `model-`, `agent-`, `effort-`, and `allow-shortfall-`
are a boot-only extension; a concrete suffix such as `model-reviewer` must
still be non-empty. `boot_only` is exactly `fences`, then `lane`.

The per-role wait budgets default to `WAITS_S` and are the flag lever 9 names;
they are `run` flags, not boot flags.

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
