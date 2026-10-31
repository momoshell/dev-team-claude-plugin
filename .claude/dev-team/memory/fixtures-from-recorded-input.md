---
name: fixtures-from-recorded-input
description: Fixtures for anything that classifies seat or tool input must use the recorded shape, not the textbook one
metadata:
  type: feedback
---

Seats rarely issue a bare command. Claude seats prefix commands with cd <tree>; and chain an edit with a test run, so the exit status is the last command's. A detector tested only on bare commands misses nearly every real case. Base fixtures on recorded commands from session files, and test a chained case.
