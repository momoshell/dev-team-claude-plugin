---
name: crew-onboard
description: >-
  Load when installing this plugin somewhere new, or when pointing it at a repo
  that is not this one: what installs with no setup, what needs the source tree,
  and how to profile and ratify a foreign checkout before a lane runs in it.
---

# Onboarding a checkout

This skill exists because the surfaces this plugin ships **do not all travel the
same way**. The knowledge skills work in any repo the moment the plugin is
installed. The crew runtime needs the source tree and a ratified profile of the
target. Confusing the two is the failure this skill prevents.

`commands/onboard.md` names this skill; the procedure lives here.

## Routing

| Doing… | Read | Rule |
|---|---|---|
| Deciding what a target repo can actually use | `references/portability.md` | Split "needs the plugin" from "needs the source tree" before promising anything. |
| Bringing the plugin to a repo that is not this one | `references/foreign-checkout.md` | Probe read-only, ratify by hand, and never let a heuristic ratify itself. |

## Critical rules

- **Installing the plugin requires no setup at all.** Zero runtime
  dependencies, no hooks to register, no config file. Anything a procedure asks
  you to create beyond that is the *runtime's* requirement, not the plugin's.
- **The probe proposes; a human ratifies.** `scripts/factory/probe-repo.mjs` is
  read-only and never writes into the target checkout. Every fresh field it
  emits is `proposed` or `unknown`. Ratification is an act, not an inference.
- **Unknown is never a guess and never a zero.** A field the probe could not
  measure carries `null` and one closed reason, so an unmeasured target never
  looks like a cleared one.
- **Install tracks `main`, not a tag.** `.claude-plugin/marketplace.json`
  declares `ref: main`, so an installed copy follows HEAD. There is no pinning
  today — say so rather than implying a version was chosen.
- **Never run this repo's scripts from the installed cache when working on this
  repo.** The cache path is version-pinned and drifts from `main`. See
  `CLAUDE.md`; this is the single most expensive onboarding mistake recorded.

## Installing

```
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

That is the whole install. It brings the skills and the `/dispatch`,
`/close-out`, `/status` and `/onboard` commands into any project.

## What onboarding actually decides

Onboarding a new repo is one question asked in order:

1. **Skills only, or the runtime too?** Most repos want the knowledge layer and
   nothing else. `references/portability.md` settles it.
2. **If the runtime: is the target profiled and ratified?**
   `references/foreign-checkout.md` runs the probe and names what a human must
   confirm before a lane boots against it.
3. **If the runtime: which transport?** Headless is the default and needs no
   cmux. Panes need cmux present and are for watching a lane, not for
   throughput.

Stop after step 1 unless the target genuinely needs lanes. A repo that only
wants better reviews is finished at step 1.
