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

## What is not proven

`dispatch-batch.mjs` has not been measured against a `--checkout` outside this
repository. The worktree, fence and protected-path machinery is written against
a git checkout in general rather than this one specifically, but "should work"
is not a measurement. Treat a foreign-checkout dispatch as unproven until it
has been run and recorded, and say so rather than implying coverage that has
not been demonstrated.
