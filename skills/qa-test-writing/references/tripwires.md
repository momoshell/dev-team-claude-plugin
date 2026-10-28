# Tripwires and scope

A **tripwire** is a test that pins something inside a lane's write surface. Find
them before you edit, so you know what the change will break.

## The rule that costs the most when missed

**A change that alters a DETECTOR owns whatever that detector newly flags.**

A detector is anything that scans the tree and reports hits: a drift guard, a
lint-shaped check, a source grep, a schema validator. Widen it, and it starts
flagging files nobody asked you to touch. Those files belong in the plan's
`files_in_scope`, or the builder either leaves the suite red or edits outside
the declared surface.

This is computable **before the build**: run the widened detector, list what it
newly flags, and put those files in `files_in_scope`.

## Source-grep tripwires when code moves

When a change moves code between modules, declare the **source-grep** tripwires
in `files_in_scope`, not just the behavioural tests. A test that greps for a
symbol's location fails when the symbol relocates, even though behaviour is
unchanged.

## Directory entries

List files, not bare directories, in `files_in_scope` unless the whole directory
is meant. A directory entry that the builder reads as a single file leaves an
empty write surface.

## New files

A plan that creates files declares them in `files_in_scope` like any other. Name
the existing files the work relates to beside them, so the builder starts from
code that already exists.

## Protected paths

A change that touches the loop's own enforcement (`crew/loop.mjs`,
`crew/checks.mjs`, `crew/acp/grants.mjs`, `hooks/`) belongs at the judge tier.
Decide that when you plan, not after the build.
