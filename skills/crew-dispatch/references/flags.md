# CLI flags

The first block is a subset of the runtime's per-verb allow-list. Flag names
are written without the leading `--`; role-prefixed names are accepted only on
`boot`.

```json
{
  "boot": ["task", "checkout", "tier", "roles", "fences", "lane", "headless-all", "model-reviewer", "effort-reviewer", "agent-reviewer"],
  "run":  ["task", "checkout", "brief-file", "variant", "files-in-scope", "validation-lane", "plan-rounds", "build-rounds", "review-rounds", "suite", "keep"],
  "boot_only": ["fences", "lane"]
}
```

`KNOWN_FLAGS` is an allow-list for each verb, not one global option bag. The
role-prefixed families `model-`, `agent-`, `effort-`, and `allow-shortfall-`
are a boot-only extension; a concrete suffix such as `model-reviewer` must
still be non-empty. `boot_only` is exactly `fences`, then `lane`.

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
