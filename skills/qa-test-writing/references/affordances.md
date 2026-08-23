# Test affordances

**IF YOU CANNOT EXPRESS THE MALFORMED INPUT, YOU HAVE NOT TESTED THE GUARD.**

The 2026-08-23 defect hunt filed eight defects, and every one ended with the
same sentence: *no existing test can reach this line*. That was not
carelessness; it was a missing affordance for the input class. A test can only
prove a guard if its harness can produce the hostile or malformed value that
reaches the guard.

This batch names five affordances:

1. **Raw-socket client (`net.Socket`)** — produces a literal request line and
   an arbitrary `Host` header. `fetch` normalises the target and writes its own
   `Host`, so this serves the request-target and Host input class in defects
   #543/#544. It is built in `test/helpers.mjs` and exercised by
   `test/helpers.test.mjs`.
2. **second process writer harness** — produces two independent processes
   writing one file, including the interleaving and truncation-window input
   class. It serves the durability and concurrent-reader defects and is
   generalised from
   `docs/audits/2026-08-23/hunt/h1/repro/r6-crewjson-two-durability-contracts.mjs`.
   It is built in `test/helpers.mjs`.
3. **torn-file fixture** — produces bytes that exist but do not parse, then
   publishes the complete artefact and exercises recovery. It serves malformed
   file and parser-recovery defects. It is built in `test/helpers.mjs` and
   exercised by `test/helpers.test.mjs`.
4. **An argv matrix over `KNOWN_FLAGS`** — would produce unsupported, missing,
   and combined flag input classes for flag-guard defects. It is not built
   here; it lands as tests in place elsewhere in this batch.
5. **A fixture-symmetry lint** — would produce the input class where one side
   of a mirrored fixture is missing or asymmetric, serving fixture-drift
   defects. It is not built here; it lands as tests in place elsewhere in this
   batch.

The first three are input-producing helpers, while the last two are planned
checks. The shared rule is to make the input class expressible before claiming
that its guard is tested. `skills/qa-test-writing/references/vacuity.md`
covers the detector side ("the detector's key is the only guard"); this file is
the same lesson on the **input** side.
