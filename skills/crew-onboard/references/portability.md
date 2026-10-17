# What travels, and what does not

The plugin ships two kinds of surface. They have different requirements, and
the difference is the whole of onboarding.

## Travels with the install — works in any repo

These need nothing but the installed plugin. No source tree, no `~/.crew`, no
node invocation, no configuration.

| Surface | What it gives a foreign repo |
|---|---|
| `pr-review` | The review rubric, the typed findings shape, divergence handling, reviewer posture |
| `qa-test-writing` | Test authoring doctrine and anchor pinning |
| `backend-node` | Node/backend conventions |
| `frontend-svelte`, `ui-design` | Svelte and UI conventions |
| `devops` | Worktrees, pull requests, orphan detection |
| `/status` | Read-only reporting; authorizes no change |

This is the answer for most repos. A project that wants sharper reviews and
better test discipline is fully served here and should stop.

## Needs the source tree — this checkout, or a clone of it

The crew runtime is executed, not merely read. Its entry points are
`node crew/crew.mjs`, `node crew/factoryctl.mjs` and
`node scripts/factory/dispatch-batch.mjs`, all invoked from a checkout of this
repository. An installed plugin gives you the *documents*, not a runnable tree
you should be invoking — and the cache path is version-pinned, so running from
it is how skew bites.

| Surface | Why it needs the tree |
|---|---|
| `crew-dispatch` | Its references cite `KNOWN_FLAGS`, fence compilation and `scripts/factory/*` as things you run |
| `crew-recovery` | Closeout and recovery drive the crew CLI directly |
| `/dispatch`, `/close-out` | Thin entry points onto the two skills above |

So the shape that works today is: **clone this repo, and point its tooling at
the target with `--checkout`.** The target repo does not need the plugin
installed for that; the operator's checkout does the work.

## Requirements, by transport

| | Headless (default) | Panes |
|---|---|---|
| node | yes | yes |
| a crew root (`~/.crew`, or `DEVTEAM_CREW_ROOT`) | yes | yes |
| cmux | no | yes |
| a workspace to watch | no — follow the journal and ledger | yes |

Headless is the software-factory mode and the default (ADR-033). Panes exist
for the interval in which a running lane has no other surface; they are for
watching, and they carry failure modes headless does not have at all.

## Measured outside this repository

`dispatch-batch.mjs` has run against one other checkout: vectora-foundry/the-power,
a Rust workspace whose ratified gate is `cargo test --workspace`. Measured on
2026-10-17:

- 472 lane directories (549 journals, counting recovery copies) name the-power's
  profile, dated 2026-09-22 to 2026-10-16. Every one of the 549 carries a
  `batch-dir` event, so each lane was dispatched by `dispatch-batch`.
- 336 pull requests from lane branches merged on the-power between 2026-09-30
  and 2026-10-16. A merged PR does not show that its lane reached done on its
  own: some were finished by hand after an escalation, and the PR list does not
  say which.
- The ledger has recorded a repo key only since 2026-10-10. Since then the-power
  has 127 sessions over 123 lanes: 68 ended `success`, 58 `escalated`, 1
  `aborted`. Sessions before 2026-10-10 carry no repo key, so their outcomes
  cannot be split by repo.

## What is not proven

- A third repository. The only other ratified profile is
  peer3to/state-channels-plus, gated by `yarn test:parallel:distributed`. Its 6
  sessions on 2026-10-12 all ended `escalated`; none reached done, and the cause
  was not measured.
- A gate that is neither `node --test` nor `cargo test`. The yarn gate above is
  the only attempt, and it has no success.
- A second operator. Every foreign lane ran from the operator's own clone, crew
  root and roster. A fresh machine with a fresh `~/.crew` has not been measured.

Say which of these a target falls under rather than implying coverage that has
not been demonstrated.
