---
name: review-procedure
description: Run a crew review end to end — conformance then correctness — loading the repo's do-not-flag guidelines before writing findings.
---

# Review procedure

Procedure only. The judgment guidance lives in the repo as data
(`crew/guidelines/review-do-not-flag.md`); this skill loads it and never
restates it.

1. Read `plan.md` in the task dir, then `git diff` / `git status`, then every
   changed file in full.
2. Run the plan's validation lane yourself. Never trust a reported pass.
3. Load the guidelines: run `scripts/load-guidelines.mjs` from THIS skill's
   directory — inside this plugin's own checkout that is
   `node .agents/skills/review-procedure/scripts/load-guidelines.mjs`, and from
   any other repository it is that same path made absolute. The loader resolves
   its data from its own location, so the working directory does not matter, and
   it exits 0 in every reachable case. There are exactly two outcomes and the
   loader says which:
   - **Guidelines loaded** — the bytes on stdout are the list. A copy of
     `crew/guidelines/review-do-not-flag.md` in the repository under review
     OVERRIDES the plugin's bundled copy; with no copy there, the bundled one is
     printed.
   - **`no reviewer guidelines were loaded`** — the statement names the file it
     looked for. The do-not-flag list is then an EMPTY list, and that is a blind
     spot to state in the review, never a clear and never a claim that the
     checkout under review is defective.
4. Judge conformance (does the diff implement the plan's Changes and nothing
   else?), then correctness (do the acceptance criteria hold?).
5. Write `review.md` in the task dir: verdict line first, then findings with
   severity, `file:line` and a concrete failure scenario.

## Verifying on a seat

- pi: `pi --print --skill .agents/skills/review-procedure -- 'list your available skills'`
  (pi 0.84.2 discovers `<cwd>/.agents/skills` on its own; crew's pi transport
  currently boots seats with `--no-skills`, so the flag above is how you see it
  today).
- claude: `claude -p 'list your available skills'` — claude 2.1.233 discovers
  project skills under `.claude/skills` only and does NOT read `.agents/`, so
  this probe is expected to NOT list this skill on that build. Do not report it
  as loading on a claude seat.
