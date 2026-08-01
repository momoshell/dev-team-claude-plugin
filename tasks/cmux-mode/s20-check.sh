#!/bin/bash
# S20 restart-durability check — run ONCE, in a cmux terminal, AFTER a full cmux quit+relaunch.
# Do not run before the restart (the token waiter is consume-once — running it early destroys the test).

TOKEN="devteam-s20-restart-probe-4063"

echo "=================================================================="
echo "S20 — restart durability check"
echo "=================================================================="

echo ""
echo "--- Part 1: wait-for latch survival ---"
echo "A token was latched (cmux wait-for -S \$TOKEN) BEFORE the restart."
echo "Arming one waiter now with a 4s timeout..."
START=$(python3 -c 'import time;print(time.time())')
if cmux wait-for "$TOKEN" --timeout 4 >/dev/null 2>&1; then
  END=$(python3 -c 'import time;print(time.time())')
  DUR=$(python3 -c "print(f'{$END-$START:.2f}')")
  echo "RESULT: token RELEASED in ${DUR}s  => LATCH SURVIVED THE RESTART (persistent store)"
else
  echo "RESULT: token TIMED OUT  => LATCH DID NOT SURVIVE (in-memory only, lost on restart)"
  echo "        (This is the EXPECTED / designed-for outcome: rank-0 file-watch is the recovery path.)"
fi

echo ""
echo "--- Part 2: moved doc-tab panel survival ---"
echo "Before the restart, pane holding two sibling tabs existed: a terminal +"
echo "a markdown panel for /tmp/s20-doc.md (moved in via markdown open + move-surface)."
echo "Current tree:"
cmux tree --all 2>&1
echo ""
echo "CHECK: is there still a pane with a [markdown] surface titled 's20-doc.md'?"
if cmux tree --all 2>&1 | grep -q "s20-doc.md"; then
  echo "  -> markdown surface s20-doc.md IS present in the tree."
  echo "     GUI eyeball: confirm the doc tab renders and live-reloads (edit /tmp/s20-doc.md, watch it update)."
  echo "     If both: moved-panel persistence PASSES."
else
  echo "  -> markdown surface s20-doc.md is ABSENT."
  echo "     Moved-panel persistence FAILED (session-restore did not rebuild the moved doc tab)."
  echo "     On-no per design: doc tab is re-opened by the dispatcher on resume from files; not a blocker."
fi

echo ""
echo "=================================================================="
echo "Paste this entire output back into a fresh Claude session in this repo"
echo "(it will record the S20 result in tasks/cmux-mode/spike-findings.md)."
echo "=================================================================="
