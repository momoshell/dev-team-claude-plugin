# Citation discipline

## Cite a file by path and a code site by symbol

A line number rots on the next insertion above it, and nothing in the lean loop
re-checks a prose citation. Write ``crew/checks.mjs (CHECK_REASONS)`` or just
``crew/checks.mjs``; do not write ``crew/checks.mjs:9``. A symbol names what the
text relies on and survives an unrelated edit. The `prose-plain` skill states
the same rule for skill prose.

A comment that cites another file follows the same rule: name the symbol and
drop the line number.

## Every cited path must name a tracked file

A path written in the text (``crew/``, ``scripts/``, ``visualizer/``, ``skills/``,
``test/``, ``hooks/`` or ``bin/`` prefix, ending in a source or doc extension)
must exist on the lane tree. Check it before you return: a citation to a
deleted file teaches a rule that nothing enforces any more.

## A stale citation moves; the file does not

- If a citation goes stale the CITATION moves. Holding a file's line count
  constant is never a goal.
- When the cited code is gone, repoint the citation to a kept file that shows
  the same thing, or drop the claim.
- Do not keep a citation for a mechanism that no longer exists. Say what the
  lean gate or the kill-mutation proof (`crew/checks.mjs`) checks instead.
