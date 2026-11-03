---
name: red-for-the-right-reason
description: A named test must fail because the behaviour is missing, never because the test throws
metadata:
  type: feedback
---

The loop runs each test the builder names on the old source and on the build. A test proves a change when it is red on the old source and green on the build. Red must come from the missing behaviour, not a wrong call signature or a missing required argument. Exercise the real module through its public entry points and pass every required argument.
