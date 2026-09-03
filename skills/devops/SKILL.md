---
name: devops
description: >-
  Use when creating or removing a Git worktree, preparing a lane branch,
  invoking `gh`, publishing from a checkout, investigating stray processes,
  reclaiming an orphan, or operating the crew daemon. Use when a linked
  checkout might share Git state, when a command needs an absolute body file,
  when a pull request must remain open, or when liveness is uncertain. Use
  when choosing dry-run versus reclaim, reading daemon paths and verbs, or
  recording an operational rule whose checkout has no local exhibit.
---

Every rule here is a measured lifecycle boundary. The references separate
safe mechanics from rules whose evidence is explicitly absent in this checkout.

## Routing

| Doing… | Rule | Details |
|---|---|---|
| Creating or retiring a checkout | Register, use, then remove worktrees | `references/worktrees.md` |
| Calling GitHub CLI | Use absolute files, explicit cwd, and a fakeable binary | `references/gh.md` |
| Publishing a lane branch | Protect the open PR and worker-path boundary | `references/lane-branches.md` |
| Handling stray descendants | Offer reclaim, default to dry run, and preserve uncertainty | `references/processes.md` |
| Operating the long-lived control plane | Read the daemon's paths, verbs, and log | `references/daemon.md` |
| Stating an unmeasured operational rule | Keep the search result in the register | `references/evidence.md` |
| Stopping a live lane | Tear down, signal the driver by pid, then settle the session | `references/processes.md` |

## Critical rules

- Create worktrees with Git's registration command, remove them with `git worktree remove`, and gate teardown on the run outcome. Exhibit: `crew/arms.mjs:650` and `crew/crew.mjs:2212`. Cost: deleting a directory alone leaves Git's registration behind.
- Treat a linked checkout as shared Git state: detect linked status by comparing `--git-dir` with `--git-common-dir`, and never assume its stash or object metadata is lane-local. Status: no checkout implementation reachable from a production entry point performs that probe, so the detection half is unbacked here; see `references/evidence.md`. Exhibit (shared state only): `crew/seat-io.mjs:2822`. Cost: a lane can restore another lane's stash entry (#471).
- Give `gh` an absolute `--body-file` and an explicit cwd, then list the output; never a relative path. Exhibit: `scripts/factory/intake.mjs:533` and `scripts/factory/probe-repo.mjs:739`. Cost: a compound `cd` changed the meaning of a relative file twice.
- Keep an open lane PR intact and refuse publishing from a worker path; do not run `git push origin --delete` against a live lane branch. Status: no checkout implementation reachable from a production entry point publishes a branch, so both halves are unbacked here; see `references/evidence.md`. Cost: a lane writing to the host remote, and the deletion behavior recorded as unbacked in `references/evidence.md`.
- Offer a reclaim command but never kill or signal unasked; default orphan work to a dry run and report `proven`, `failed`, or `unproven`. Exhibit: `scripts/factory/reap-stale.mjs:251` and `crew/crew.mjs:801`. Cost: an unknown process is not evidence of death (#473).
- Stop a live lane by tearing it down, then signalling the driver by pid, then confirming its session reached a terminal row; do not expect SIGTERM to end a driver, because an armed exit-marker handler suppresses the default disposition while being unable to dispatch inside a synchronous nap. Exhibit: `crew/crew.mjs:1972` and `scripts/factory/ledger.mjs:4962`. Cost: a SIGKILLed driver lands no terminal row, so its session reads `running` forever — two were found in the live ledger, one 4.4 days old (#877).
- Operate the daemon from its measured Unix-socket surface, and record that this repository has no launchd service rather than inventing one. Exhibit: `crew/daemon.mjs:134` and `crew/daemon.mjs:478`. Cost: a control command aimed at an assumed service can target nothing or the wrong process.

## Key references

- `references/worktrees.md` — registration, linked-worktree probes, shared state, and teardown.
- `references/gh.md` — absolute body files, cwd, confirmation, and GH_BIN.
- `references/lane-branches.md` — open PR preservation and worker-path refusal.
- `references/processes.md` — dry-run reclaim, proof states, and kill guards.
- `references/daemon.md` — daemon paths, command vocabulary, journal, and negative launchd fact.
- `references/evidence.md` — rules searched for but not exhibited locally.
