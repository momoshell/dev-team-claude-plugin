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

## Critical rules

- Create worktrees with Git's registration command, remove them with `git worktree remove`, and gate teardown on the run outcome. Exhibit: `crew/arms.mjs:661` and `crew/crew.mjs:1881`. Cost: deleting a directory alone leaves Git's registration behind.
- Treat a linked checkout as shared Git state: detect it with `--git-common-dir`, and never assume its stash or object metadata is lane-local. Exhibit: `scripts/factory/ci-watch.mjs:237` and `crew/seat-io.mjs:1679`. Cost: a lane can restore another lane's stash entry (#471).
- Give `gh` an absolute `--body-file` and an explicit cwd, then list the output; never a relative path. Exhibit: `scripts/factory/intake.mjs:533` and `scripts/factory/probe-repo.mjs:739`. Cost: a compound `cd` changed the meaning of a relative file twice.
- Keep an open lane PR intact and refuse publishing from a worker path; do not run `git push origin --delete` against a live lane branch. Exhibit: `scripts/factory/ci-watch.mjs:265`. Cost: the deletion behavior is recorded as unbacked in `references/evidence.md`.
- Offer a reclaim command but never kill or signal unasked; default orphan work to a dry run and report `proven`, `failed`, or `unproven`. Exhibit: `scripts/factory/reap-stale.mjs:251` and `crew/crew.mjs:664`. Cost: an unknown process is not evidence of death (#473).
- Operate the daemon from its measured Unix-socket surface, and record that this repository has no launchd service rather than inventing one. Exhibit: `crew/daemon.mjs:113` and `crew/daemon.mjs:388`. Cost: a control command aimed at an assumed service can target nothing or the wrong process.

## Key references

- `references/worktrees.md` — registration, linked-worktree probes, shared state, and teardown.
- `references/gh.md` — absolute body files, cwd, confirmation, and GH_BIN.
- `references/lane-branches.md` — open PR preservation and worker-path refusal.
- `references/processes.md` — dry-run reclaim, proof states, and kill guards.
- `references/daemon.md` — daemon paths, command vocabulary, journal, and negative launchd fact.
- `references/evidence.md` — rules searched for but not exhibited locally.
