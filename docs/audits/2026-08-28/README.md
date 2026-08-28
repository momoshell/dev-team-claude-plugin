# 2026-08-28 — pane boot race

One scout lane, dispatched live while three build lanes were running, to explain
a failure that had just cost all three of them their first assignment.

| lane | question | outcome |
|---|---|---|
| `b302-bootrace` | why did `sendLine`'s echo verification pass when the assignment never landed? | [`scout-b302-bootrace.md`](scout-b302-bootrace.md) |

**Committed here because `~/.crew` is not durable.** #536's index says its hunt
registers are "preserved at `~/.dev-team/factory/preserved/hunt-2026-08-23/`";
that directory no longer exists on the machine that produced it, and the only
reason those findings are still usable is that copies were committed under
`docs/audits/`. This report is the design for two future lanes, so it is
committed rather than left in a state directory.

## The short version

A pane seat is **born mid-turn** — the boot brief is the argv prompt baked into
the pane's launch command, not typed in — and `crew/crew.mjs`'s readiness
predicate accepts *chrome* (the TUI's own painted footer) as evidence of
readiness. Painting precedes the model's first token by tens of seconds, so the
driver assigns into a seat that is still working, and the input is swallowed.

`crew/driver.mjs`'s `sendLine` did not fail — it passed. It proves the needle
reached the pane's **screen**, then sends `enter` and returns with no post-enter
check at all. A swallowed submit and a consumed one are byte-identical to it.

Measured across four consecutive lanes: **18 of 18 `seat-ready` rows carried
`signal: "chrome"`, and `ready-reply` has never once been recorded** — the
primary predicate is dead code in practice. Two lanes also recorded chrome
matching ~150 ms after boot, which is faster than a `claude` process can start
and paint, and remains unexplained.

The fix is two halves in two files: prove **submission** rather than echo
(`crew/driver.mjs`), and require the seat's own `ready: <role>` reply on a fresh
boot (`crew/crew.mjs`). The report sizes both and names what it could not settle
by reading.
