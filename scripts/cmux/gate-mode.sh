#!/usr/bin/env bash
# gate-mode.sh — UserPromptSubmit hook: self-disables return-gate.sh's
# enforcement the moment a human interjects mid-dispatch.
#
# The kickoff itself arrives as an argv positional and DOES fire
# UserPromptSubmit, so the FIRST invocation of this script (per dispatch) is
# the kickoff — it leaves the mode file containing "enforce". Every
# invocation after that is a human interjecting into a running dispatch, so
# it writes "observe", and observe is STICKY: once written, no later
# invocation ever reverts it back to "enforce".
#
# "First invocation" is decided with an atomic exclusive create (the same
# noclobber idiom return-gate.sh uses for its block-slot claims), never a
# read-then-write race.
#
# EXPLICIT DEVIATION from this repo's usual `set -euo pipefail`: no `set -e`
# / `set -o pipefail` — every external call is best-effort and the script
# always reaches its own unconditional `exit 0`. Emits no stdout, ever,
# including with missing env.
set -u

# Drain stdin unconditionally; this hook never reads the hook JSON's content.
cat >/dev/null 2>&1 || true

COUNTER="${DEVTEAM_GATE_COUNTER:-}"
[ -n "$COUNTER" ] || exit 0

MODE_FILE="${COUNTER}.mode"
SEEN_FILE="${COUNTER}.mode.seen"

claim() { ( set -o noclobber; : > "$1" ) 2>/dev/null; }

# claim_create(path, content) -> a noclobber exclusive CREATE: writes content
# only when path does not already exist, never clobbers. Used for the
# enforce write below so a raced observe write (from a concurrent human
# invocation that already claimed SEEN_FILE and wrote MODE_FILE before this
# invocation's own claim resolves) always wins and stays sticky.
claim_create() { ( set -o noclobber; printf '%s' "$2" > "$1" ) 2>/dev/null; }

write_atomic() { # <path> <content>
  local path=$1 content=$2 tmp
  tmp="${path}.${$}.tmp"
  printf '%s' "$content" >"$tmp" 2>/dev/null || return 1
  mv -f "$tmp" "$path" 2>/dev/null
}

if claim "$SEEN_FILE"; then
  claim_create "$MODE_FILE" 'enforce' || true
else
  write_atomic "$MODE_FILE" 'observe' || true
fi

exit 0
