---
name: journal-rows-reach-readers
description: A plan that adds a journal row or changes the last rows of a run names every reader that derives lane state from them
metadata:
  type: feedback
---

Readers derive a lane's state from the order of its journal rows. `stateless` in `crew/lean-journal-order.mjs` lists the rows that never count as the last state row; every other row does, so a new row written after the terminal row makes an ended run read as died. `crew/run-pid.mjs`, `crew/record-pr.mjs`, `crew/closeout.mjs` and `crew/lean-source.mjs` take that last state row, and `crew/finish.mjs` and `crew/closeout.mjs` look up the last stop, `finish-ready`, `finish-decision`, `commit` and `pr` rows by name. In the devteam lanes started from 2026-11-12 to 2026-11-20, 6 of the 49 distinct must-fix review findings were a reader misreading a lane after a change added a row or changed which rows end a run, in 4 of the 30 lanes with a changes-needed review. When a plan adds a journal row or changes the last rows of a run, write a criterion for `stateless` and for each of those readers, or say why the row cannot reach them.
