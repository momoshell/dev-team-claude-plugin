# Tripwires and scope

A **tripwire** is a test that pins something inside a lane's write surface. The
brief compiler discovers them and lists them, so a lane knows what it will break
before it breaks it.

## The rule that costs the most when missed

**A change that alters a DETECTOR owns whatever that detector newly flags.**

A detector is anything that scans the tree and reports hits: a drift guard, a
lint-shaped check, a source grep, a schema validator. Widen it, and it starts
flagging files nobody asked you to touch — and those files are outside your
fence, so the lane escalates at the scope gate.

This is computable **before dispatch**: run the widened detector, list what it
newly flags, and put those files in the write surface. Missing it cost the b136
scope escalation — the **third** dispatch lost to one file
(`crew/factoryctl.test.mjs`).

**The scope gate checks the PLAN, not the brief.** A brief that names the right
files does not save a plan that declares the wrong ones.

## Source-grep tripwires when code moves

When a change moves code between modules, declare the **source-grep** tripwires
in `files_in_scope`, not just the behavioural tests. A test that greps for a
symbol's location fails when the symbol relocates, even though behaviour is
unchanged (#139).

## Directory entries need a trailing slash

A scope entry that resolves to an existing directory matches **only** with a
trailing slash. Without it the driver compares it as an exact file path and
every file under it falls out of scope — a lane then runs with a gate-green tree
and an empty write surface. The compiler now refuses this at compile time
(`SCOPE_DIRECTORY_UNSLASHED`), but know the shape: `crew/roles` is wrong,
`crew/roles/` is right.

## Verify a fence through its consumers, not by reading it

Before dispatch, run the write surface through the code that will enforce it:

```js
validateScopeEntries({ checkout, files })   // refuses unslashed directories
const match = scopeMatcher(files)           // probe: every intended path IN
                                            // and sibling paths OUT
protectedHitsIn(files, PROTECTED_PATHS)     // any hit ⇒ judge tier
```

Probe **negatives** as well as positives. A matcher that accepts everything
passes a positives-only check.

## Protected paths force the tier

Any write-surface hit on the protected floor means the lane boots at **judge**
tier or it escalates at plan-accept. Compute this before dispatch, not after.

## New files

A fence register's `files` are **not** existence-checked — new paths are legal
there. The request's `where` **is** checked and refuses a path that does not
exist. So a lane that creates files declares them in the fence register, and
anchors `where` on the existing files the work relates to.
