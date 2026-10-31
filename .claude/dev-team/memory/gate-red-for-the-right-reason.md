---
name: gate-red-for-the-right-reason
description: A baseline-red check must fail because the behaviour is missing, never because the gate throws
metadata:
  type: feedback
---

Before returning a plan, run the gate on the unchanged tree and read every FAIL reason. Each must name the missing behaviour. A gate that throws (a wrong call signature, a missing required argument) prints FAIL for every id and still passes the baseline check, then blocks the builder for good. Exercise the real module through its public entry points and pass every required argument.
