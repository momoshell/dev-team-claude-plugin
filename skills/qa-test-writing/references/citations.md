# Citation discipline

## Prose citations are pinned by content

A `path:line` citation in a skill's prose declares an expected substring in that
skill's `anchors.json`. The shared `skills/qa-test-writing/anchor-pin.mjs`
mechanism makes the exhibits test assert that substring at the cited line, and
refuses an expectation that is short or that the target repeats. The
`skills/backend-node/anchors.json` and `skills/devops/anchors.json` files are
the declarations consumed by their respective exhibits.

The old pin cost **220 citations** guarded by existence and range alone. Eleven
of those citations pointed at a blank line or a repeated closing brace, and all
of them stayed green (#550). Content is the claim: the line must carry the
substring the prose relies on, not merely exist.

## A comment that cites another file names the symbol, not the line

The text must contain the literal `(SYMBOL)` and the phrase **drop the line number**. Write ``crew/daemon.mjs (DAEMON_COMMANDS)``, not
``crew/daemon.mjs:127``. A symbol names what the comment relies on and cannot
rot when an insertion moves code; a line number rots on the next insertion
above it. This round measured **34 wrong anchors out of 40** in
`scripts/factory/` and **13** in `crew/`.

**b161** did exactly this in `crew/daemon.mjs`, dropping the line number rather
than guessing a new one. This rule is guidance, not a detector: nothing
enforces it on comments today, and building that detector is a separate lane.

## A stale citation moves; the file does not

The measured cases show why line counts must not drive citation choices: #596 held `crew/daemon.test.mjs` at 3304 lines; #599 re-anchored five `ledger.mjs` anchors by hand; and #579 deleted four comment blocks to hold 4600.

- The line number is advisory and the CONTENT is the identity — #550's rule applied to code-to-code citations.
- If a citation goes stale the CITATION moves, and holding a file's line count constant is never a goal.
- Repair is opt-in: `node skills/qa-test-writing/anchor-pin.mjs --repair <skillDir>` rewrites the key and the prose; checking never rewrites, so CI still sees real drift.
- The ambiguous cases refuse rather than guess: content on more than one line has no unique home, and content on no line is rot a human reads.

## Three outcomes: pinned, shifted, rotted

A citation is pinned by CONTENT. The line number is a convenience that may go
stale, and a shift is not a failure.

- **pinned** — the declared substring is on the cited line. Green.
- **shifted** — the substring is in the target exactly once, at a different
  line. Green, and REPORTED: the check names the line the citation claims and
  the line the text now occupies, and `node
  skills/qa-test-writing/anchor-pin.mjs --repair <skillDir>` moves the key and
  the prose in a lane that owns the skill.
- **rotted / ambiguous** — the substring appears nowhere, or on more than one
  line. Both are still hard errors, because neither has a unique home a repair
  could move to.

A cited line past the end of the file is not fatal by itself: the content
decides. Found once, that is a shift; found nowhere, that is rot.

Therefore holding a file's line count constant is not a goal. #579 deleted four
rationale comment blocks to hold `ledger.mjs` at 4600 lines, #586 paid the
reverse tax to put eight back, and #592 froze `crew/daemon.test.mjs` at 3304 —
three lanes each inventing the same non-rule. An unrelated edit may move any
cited line; the citation follows the content.
