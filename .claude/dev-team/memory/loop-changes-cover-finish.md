---
name: loop-changes-cover-finish
description: A plan that changes the lane loop states what happens on a finish pass and on a planning resume
metadata:
  type: feedback
---

A finish pass (`crew finish --return`) and a planning resume run through the same `crew/loop.mjs` as a standard run, and skip or replace steps behind `isFinish`, which appears 51 times in that file at cc431b41. In the devteam lanes started from 2026-11-12 to 2026-11-20, 6 of the 49 distinct must-fix review findings were defects on the finish or resume path that the standard path did not have, in 6 of the 30 lanes with a changes-needed review. When a plan changes the loop, a check, or what a seat is told, write one criterion for the finish pass and one for the planning resume, or say why the change cannot reach them.
