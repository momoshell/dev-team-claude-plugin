---
name: crew-onboard
description: >-
  Load when installing this plugin somewhere new, or when pointing lean crew
  lanes at a checkout: install the plugin, choose the checkout's suite command
  and put it in the brief suite field.
---

# Onboarding a checkout

The knowledge skills work in any repo the moment the plugin is installed. Lean
lanes need a git checkout and a brief that names how to prove it.

`commands/onboard.md` names this skill; the procedure lives here.

## Installing

```
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

For what the install brings and what the crew runtime needs, see the [README Install section](../../README.md#install).

If you only want the skills, stop here: no lane is needed.

## Onboarding a checkout for lean lanes

1. The target must be a git checkout; `crew start` refuses otherwise, or take
   `--checkout <dir>` (`crew/start.mjs`).
2. Pick the command that proves the checkout, for example `npm test` or
   `cargo test -p power-api`, and run it once by hand on a clean tree.
3. Put it in the brief's `suite:` field. Absent means `npm test`. The command is
   split on whitespace and run without a shell, so no pipes or `&&`.
4. Write the brief with the `lane-brief` skill (`skills/lane-brief/SKILL.md`).
5. Validate with `crew start <brief> --check`; it needs no checkout. Then
   `crew start <brief>` from inside the checkout starts the lane. `crew` on `PATH`
   is a launcher you set up; installing the plugin does not add one. Without it,
   run `node <dev-team clone>/bin/crew.mjs start <brief> --checkout <target>`.
