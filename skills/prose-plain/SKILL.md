---
name: prose-plain
description: Use when writing or editing docs, ADRs, skill prose, PR bodies or commit messages in this repo; plain house style, no AI slop.
---

# prose-plain

Write the plain version first: say the thing, name the number, stop.

## House style (this repo, worked examples)

- A rate carries its denominator. Write "1 of 50 PR bodies", never "rarely" (CLAUDE.md, honesty doctrine).
- Unknown is null with one closed reason, never a guessed zero. State the blind spot instead of omitting it: what was not measured, and why.
- Be concrete: names, counts, dates and mechanisms beat abstractions. If a sentence could move unchanged into another repo's docs, cut it or replace it with a fact about this one.
- Plain register is the local norm: docs/adr/adr-050-seat-skills-are-granted-not-pasted.md uses 3 em dashes in 213 lines; older docs are em-dash dense (3,747 em-dash lines across 128 markdown files, measured at fc578690). Use commas, periods or parentheses; keep at most two em dashes in a document.
- Cut banned filler and recap endings. The mechanical list lives in the lint below, not in your memory.
- Commit subjects are conventional: `feat(crew):`, `fix(factory):`, `docs(adr):`. No version-bump suffix and no co-author trailer (CLAUDE.md, commit conventions).
- PR bodies report what was measured, each rate with its denominator, and name what the change does not cover.

## Before you finish

Run `node scripts/factory/prose-lint.mjs <file>` on each prose file you wrote or edited (no argument reads stdin). Fix banned words and recap endings; cut em dashes down to two unless the extra ones earn their place. The lint is report-only: a clean run is not proof the prose is good, only that the mechanical patterns are absent.

Cite files by path, never by path-and-line, so this skill needs no anchors manifest.

Derived from no-ai-slop by Peter Yang (MIT).