# Onboarding a checkout that is not this repo

The runtime refuses to act on an unratified profile. That refusal is the
design, not an obstacle: a lane driven from a guessed test command or a guessed
protected-path set is worse than no lane. This is the sequence that turns a
foreign checkout into one a lane may run against.

## 1. Probe, read-only

```bash
node scripts/factory/probe-repo.mjs --checkout /path/to/target
```

Run it from a checkout of **this** repo, with `--checkout` naming the target.
The probe never writes into the target. It is offline and deterministic by
default: filesystem inspection plus allowlisted read-only git.

Flags:

| Flag | Effect |
|---|---|
| `--checkout <dir>` | Required. The repo being profiled. |
| `--baseline` | Additionally run the proposed test command to record a baseline. Costs whatever the suite costs. |
| `--gh` | Consult `gh` for default branch, PR conventions and the intake board. Off by default — the probe is offline unless you ask. |
| `--out <path>` / `--save` | Where the profile is written. Mutually exclusive. A writer refuses a path **inside** the checkout. |

Exit codes: `0` a profile, `1` an unexpected throw, `2` usage.

## 2. Read what it proposed

The profile carries `repo_key`, `repo_slug` and these fields:

`toolchain` · `test_command` · `baseline` · `ci` ·
`protected_paths_candidates` · `conventions` · `default_branch` ·
`pr_conventions` · `intake_board`

Every cell carries one of exactly three statuses — **`ratified`**,
**`proposed`**, **`unknown`** — and a fresh probe emits only the latter two. An
`unknown` cell carries `null` and one closed reason, never a zero and never a
plausible-looking default. That is what keeps an unmeasured target from
reading like a cleared one.

## 3. Ratify by hand

**A human ratifies; the probe never ratifies itself.** Read each proposed cell
against the target repo and promote the ones you can vouch for. Consuming an
unratified field refuses by name, and the refusal tells you which field and
where to ratify it.

The two worth the most attention:

- **`test_command`** — the whole gate rests on it. A wrong command produces a
  green lane that proved nothing.
- **`protected_paths_candidates`** — these set the tier floor. Under-ratifying
  lets a lane edit a protected surface at build tier; over-ratifying drags
  every lane through judge.

## 4. Only then, dispatch

With a ratified profile, a lane can be dispatched against the target using
`--checkout`. Follow `crew-dispatch` for the dispatch itself; nothing about
fences, tiers or flags changes because the checkout is foreign.

Two things that do change:

- The worktree is created beside the **target**, not beside this repo.
- The crew root is still the operator's (`~/.crew`, or `DEVTEAM_CREW_ROOT`), so
  lanes from several repos share one root and their names must not collide.

## Honesty note

A foreign-checkout dispatch has not been measured. The machinery is written
against git checkouts in general, but that is an argument, not evidence. The
first time this is run end-to-end against another repo, record what happened —
and until then, describe it as unproven rather than supported.
