# Daemon control surface

The daemon defaults its root beneath `.crew`, specifically `~/.crew/daemon`.
Exhibit: `crew/daemon.mjs:387`.

Its Unix socket is `daemon.sock`.
Exhibit: `crew/daemon.mjs:388`.

Its pidfile is `daemon.json`.
Exhibit: `crew/daemon.mjs:389`.

A per-run journal is written as `journal.jsonl`.
Exhibit: `crew/daemon.mjs:467`.

The same journal path is polled after startup.
Exhibit: `crew/daemon.mjs:750`.

The command vocabulary is a closed list of nine names:
`ping`, `enqueue`, `list`, `state`, `result`, `tail`, `untail`, `stop`, `send`.
Exhibit: `crew/daemon.mjs:113`.

Use `ping` for reachability, not for an outcome claim.
Exhibit: `crew/daemon.mjs:113`.

Use `enqueue` to admit work and `list` to inspect runs.
Exhibit: `crew/daemon.mjs:113`.

Use `state` for projection and `result` for the recorded envelope.
Exhibit: `crew/daemon.mjs:113`.

Use `tail` and `untail` for the live feed subscription.
Exhibit: `crew/daemon.mjs:113`.

Use `stop` and `send` only through their named daemon boundaries.
Exhibit: `crew/daemon.mjs:113`.

This repository runs no launchd service; the daemon is a plain Node process.
Exhibit in the control-surface description: `crew/README.md:216`.

There is no plist or launchctl recipe in this checkout.
Register: `skills/devops/references/evidence.md` records the negative search.

Do not invent a launchd label when the Unix socket is the measured surface.
Register: `skills/devops/references/evidence.md` records this unbacked host-service rule.

An absent socket is unavailable, not a successful ping.
Exhibit: `crew/daemon.mjs:1273`.

An empty journal is no run evidence; inspect the envelope separately.
Exhibit: `crew/daemon.mjs:750`.

An interrupted daemon read must preserve an indeterminate state.
Exhibit: `crew/daemon.mjs:669`.

Keep the closed command names synchronized with the co-located exhibit test.
Exhibit: `crew/daemon.mjs:113` and `skills/devops/exhibits.test.mjs:16`.

The cost of confusing state with result is reporting a live projection as an
outcome.
Exhibit: `crew/README.md:216`.
