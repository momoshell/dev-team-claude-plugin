# Daemon control surface

The daemon defaults its root beneath `.crew`, specifically `~/.crew/daemon`.
Exhibit: `crew/daemon.mjs@daemon-default-root`.

Its Unix socket is `daemon.sock`.
Exhibit: `crew/daemon.mjs@daemon-sock-path`.

Its pidfile is `daemon.json`.
Exhibit: `crew/daemon.mjs@daemon-json-path`.

A per-run journal is written as `journal.jsonl`.
Exhibit: `crew/daemon.mjs@run-journal-artifact`.

The same journal path is polled after startup.
Exhibit: `crew/daemon.mjs@journal-tail-path`.

The command vocabulary is a closed list of nine names:
`ping`, `enqueue`, `list`, `state`, `result`, `tail`, `untail`, `stop`, `send`.
Exhibit: `crew/daemon.mjs@daemon-commands`.

Use `ping` for reachability, not for an outcome claim.
Exhibit: `crew/daemon.mjs@daemon-commands`.

Use `enqueue` to admit work and `list` to inspect runs.
Exhibit: `crew/daemon.mjs@daemon-commands`.

Use `state` for projection and `result` for the recorded envelope.
Exhibit: `crew/daemon.mjs@daemon-commands`.

Use `tail` and `untail` for the live feed subscription.
Exhibit: `crew/daemon.mjs@daemon-commands`.

Use `stop` and `send` only through their named daemon boundaries.
Exhibit: `crew/daemon.mjs@daemon-commands`.

This repository runs no launchd service; the daemon is a plain Node process.
Exhibit in the control-surface description: `crew/README.md@daemon-owns-headless-runs`.

There is no plist or launchctl recipe in this checkout.
Register: `skills/devops/references/evidence.md` records the negative search.

Do not invent a launchd label when the Unix socket is the measured surface.
Register: `skills/devops/references/evidence.md` records this unbacked host-service rule.

An absent socket is unavailable, not a successful ping.
Exhibit: `crew/daemon.mjs@socket-probe-error`.

An empty journal is no run evidence; inspect the envelope separately.
Exhibit: `crew/daemon.mjs@journal-tail-path`.

An interrupted daemon read must preserve an indeterminate state.
Exhibit: `crew/daemon.mjs@runs-read-fallback`.

Keep the closed command names synchronized with the co-located exhibit test.
Exhibit: `crew/daemon.mjs@daemon-commands` and `skills/devops/exhibits.test.mjs@daemon-commands-documented`.

The cost of confusing state with result is reporting a live projection as an
outcome.
Exhibit: `crew/README.md@daemon-owns-headless-runs`.
