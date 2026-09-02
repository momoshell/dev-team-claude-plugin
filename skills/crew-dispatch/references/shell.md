# Shell discipline

Shell for **invocation**, node for **logic**. Measured control-flow failures
include bash-only `declare -A` with **`${!arr[@]}`**, which made the monitor die
with `bad substitution`; **zsh does not word-split** unquoted parameter
expansions, so `set -- $pair` sent `--tier` to `crew.mjs boot` without a value
on four lanes. A `for p in $PIDS; kill` loop passed the whole list as one
argument and killed nothing — use `xargs`. Nested `$( )` quoting broke a
watcher's `grep` and called a succeeding lane a silent death. Simple
git/gh/node/npm invocations are dialect-agnostic; a POSIX `while` polling for a
file is the one acceptable exception.

## The repo is already shell-independent

Do not harden correct code: **`shell: true`** has **`0 occurrences`**;
**`process.env.SHELL`** also has zero occurrences; npm scripts use bare `node …`
with `script-shell` unset. The only named shells are absolute and deliberate:
`/bin/sh -c` for gate commands and the headless worker wrapper, and
**`GATE_REAP_SHELL = '/bin/bash'`** (`crew/drive.mjs:343`), whose reason is in
the adjacent comment and which is tested against a missing shell
(`crew/drive.test.mjs:3036`, `'/path/that/does/not/exist'`). The `"name": "zsh"`
strings in the driver fixture are captured pane-tree data, not a dependency.

Write the claim exactly this narrowly. `crew/child.mjs` does run **`execSync`**
with a string command, so “no `shell: true`” must never widen into “no string
shell execution”.
