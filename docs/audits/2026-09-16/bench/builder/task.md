# Builder mechanical work item

Work from the repository root. This is a small mechanical edit; do not contact an endpoint, run a live model-evaluation bench, create a commit, or edit any file other than the tracked builder README named below.

## Authorized edit

Open `docs/audits/2026-09-16/bench/builder/README.md` and change only the contents of its fenced `BENCH_WORK_ITEM` block. The scaffold contains the unsorted duplicate integer input `[3, -1, 3, 2, -1]` and an explicit placeholder. Replace that block's contents with exactly the canonical ascending unique JSON array `[-1,2,3]`, preserving the opening and closing fence and every byte outside the block. Do not leave the placeholder in the finished block.

The mechanical gate checks B1 for one readable README and one work-item fence, B2 for the exact array result, and B3 for a git diff containing exactly the README. A missing, malformed, unreadable, or interrupted read or command is a failed check, not an error. No output artifact is authorized for this seat.
