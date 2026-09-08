# Decisions needed

This is the open owner-decision register. Decisions close only through an ADR link or a dated closure line. Entries are never deleted; history remains here. Currency is the operator's responsibility at closeout.

Line counts here use `split("\n").length`, which is one greater than `wc -l` for a newline-terminated file.

## 1. Split `crew/drive.mjs`?

- **Question:** Split `crew/drive.mjs`?
- **Measurement:** 7,522 lines at `72d87b6`. It is on the protected floor, so every judge lane is a drive.mjs lane; b533's builder fetched 4,730 distinct lines of it against 148 its plan cited, in 35 paged reads.
- **Options:** Split `crew/drive.mjs` through an ADR-sized migration; keep it intact.
- **Blocked:** #1033 and the seam report scoped from it; a split also reaches every import, every anchor manifest, every `allow_test_reach` naming the file, and the protected-floor list.
- **Raised:** 2026-09-08 (Split `crew/drive.mjs`?)

## 2. Effort per stage, not per seat?

- **Question:** Set effort per stage, rather than per seat?
- **Measurement:** The roster seats the builder at `effort=max` on both tiers, for a 53-edit first build and for a three-edit bounce alike. Build-round wall minus in-tool time over turns: 13–22 s/turn across b530/b531/b533/b534.
- **Options:** Set effort per stage; continue setting effort per seat.
- **Blocked:** #1028 ask 2; changing the roster's shape requires the owner.
- **Raised:** 2026-09-08 (Effort per stage, not per seat?)

## 3. Re-prove after a moved-base rebase (#1021)?

- **Question:** Re-prove after a moved-base rebase (#1021)?
- **Measurement:** The denominator is unswept: #1002 found 32 of 118 journals with the review-rebuild shape; the rebase shape has no count at all.
- **Options:** Re-prove after a moved-base rebase; retain the current proof sequencing.
- **Blocked:** Commit/rebase/publish sequencing and preservation of the post-rebase tree.
- **Raised:** 2026-09-08 (Re-prove after a moved-base rebase?)

## 4. Do prompt changes require a measured eval (#1031)?

- **Question:** Do prompt changes require a measured eval (#1031)?
- **Measurement:** `crew/roles/*.md` are prompts and today a lane changes one under an ordinary code review; b524 added two lines to `planner.md` and no cell moved to show what it did.
- **Options:** Require a measured eval for prompt changes; continue ordinary code review for prompt changes.
- **Blocked:** The review requirement for changes to `crew/roles/*.md`.
- **Raised:** 2026-09-08 (Do prompt changes require a measured eval?)

## 5. The builder turn-ceiling number (#1028 ask 1)

- **Question:** What should the builder turn-ceiling number be (#1028 ask 1)?
- **Measurement:** `TURN_CEILING_DEFAULTS` at `crew/drive.mjs:139` gives the builder `null`; measured first rounds this week were 99, 130, 151 and 40 turns. The number must come from the POST-fix distribution or the ceiling encodes today's waste.
- **Options:** Set a numeric ceiling from the POST-fix distribution; leave the builder ceiling unset.
- **Blocked:** #1028 ask 1; the decision itself is blocked on #1027 and #1026 landing.
- **Raised:** 2026-09-08 (The builder turn-ceiling number)

## 6. ACP via `claude-agent-acp` for the claude seat (#1034)

- **Question:** Use ACP via `claude-agent-acp` for the claude seat (#1034)?
- **Measurement:** Verified elsewhere on 2026-09-08 against the `claude-agent-acp` source, which is not in this checkout: its ACP agent implements `requestPermission`.
- **Options:** Adopt `claude-agent-acp` for the claude seat; continue the deferral until Grok/Antigravity are added.
- **Blocked:** The ACP transport choice for the claude seat (#1034); the owner deferred it until Grok/Antigravity are added.
- **Raised:** 2026-09-08 (ACP via `claude-agent-acp` for the claude seat)
