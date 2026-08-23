# h1-lifecycle reproductions

Every program here is self-contained and runs against a **scratch `git archive HEAD`
copy of the repo** plus a scratch state dir. None of them reads or writes the
checkout. Set the scratch copy once:

    mkdir -p /tmp/h1repo && (git archive HEAD) | tar -x -C /tmp/h1repo
    export H1_SCRATCH_REPO=/tmp/h1repo

Then, from this directory:

    node r6-crewjson-two-durability-contracts.mjs  # F1  corrupts-state
    node r4-torn-envelope-permanent-orphan.mjs     # F2  wrong-answer
    node r7-proven-kill-recorded-unproven.mjs      # F3  wrong-answer
    node r2-daemon-adopts-reused-pid.mjs           # F4  wrong-answer / refuses-wrongly
    node r1-unproven-root-never-retried.mjs        # F5  hangs-or-leaks
    node r3-teardown-aborts-before-sweep.mjs broken    # F6 hangs-or-leaks
    node r3-teardown-aborts-before-sweep.mjs healthy   # F6 control
    node r5-enqueue-while-dying.mjs                # F7  hangs-or-leaks
    node n-negatives.mjs                           # attacks the code SURVIVED

Each exits 0 when the defect reproduced (r3 healthy: 0 = the control behaved),
non-zero if it did not. `*.out` holds the run recorded in findings.md, measured on
Darwin 25.5.0 / node v26.5.1 at HEAD 5a8d76a.

Every program kills what it spawned and removes its scratch dir on the way out.
r5's fork seam is injected with a stand-in sleeper so no crew child is ever run.
