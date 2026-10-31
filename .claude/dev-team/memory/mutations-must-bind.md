---
name: mutations-must-bind
description: Each acceptance check needs a kill-mutation its own fixture distinguishes
metadata:
  type: feedback
---

Declare one mutation per check, with a find string that occurs exactly once in the file. Prefer flipping the core predicate. Removing a guard that another guard already covers is an equivalent mutant: it survives and the proof fails. Every acceptance id must be a top-level test(), and each test names its kill in a // MUTATION: comment.
