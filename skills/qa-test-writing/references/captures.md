# Vendor stream captures

**Rule: a test for a reducer over a vendor's event stream uses a recorded
capture. Never hand-build the frames.** A fixture encodes what you believe the
format is, but that belief is precisely what needs testing.

## Historical lesson

A retired usage reducer counted nested tool results as well as assistant usage;
hand-built frames omitted the role field that distinguished them. The suite
missed the over-count (#493, fixed in PR #496). No live exhibit. Existing
own-spend fixture tables are hand-built, not recorded vendor captures.

## Recording a capture

1. Run a real seat through the path you want to pin. Lean session records are
   at `task/lean/<role>/<id>.jsonl`; `crew/show.mjs` discovers them.
2. Inspect the session to establish what it preserves. These are session records,
   not automatically raw vendor frames. If the desired frames are absent,
   capture them separately at the actual vendor transport boundary.
3. Trim to the frames the test needs without editing their shape: drop whole
   lines, never fields. Preserve provenance and commit the fixture beside the test.

## What the test asserts

Pin both the frames carrying the subject's own data and real examples of frames
that must be excluded. Both directions prevent an over-count fix from becoming an
under-count. Capture and prove each vendor adapter separately; do not assume
formats agree. Where reducers share a rule, assert agreement behaviourally over
one fixture table, not just in a comment.
