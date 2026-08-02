#!/usr/bin/env bash
# return-gate.sh — Stop-hook enforcement of the worker return contract.
#
# Runs on EVERY Stop event, including turns where the agent never intended to
# finish (that is exactly why the block counter exists: worst case is a few
# wasted turns, never a wedged or lost session). It is NEVER the signal of
# record — the parent re-derives completion from the ladder (ladder.mjs) on
# every wake, so nothing this script does or fails to do can produce a false
# completion or a lost dispatch.
#
# EXPLICIT DEVIATION from this repo's usual `set -euo pipefail`: this script
# uses no `set -e` / `set -o pipefail`. Every external call is best-effort
# (`|| true` or an explicit fallback), every failure is logged, and the
# script always reaches its own `exit 0` (or the one deliberate block-JSON
# emission). A hook that dies mid-way is precisely the failure mode this
# design exists to prevent.
#
# Fail OPEN on every dependency/env problem: missing DEVTEAM_* env, missing
# CLAUDE_PLUGIN_ROOT, missing node, an unreadable/schema-invalid record, or a
# failing cmux call all log and exit 0 — never block.
#
# Sidecars, all derived from DEVTEAM_GATE_COUNTER (no ninth env key exists):
#   ${DEVTEAM_GATE_COUNTER}        decimal block count (tmp+rename writes only)
#   ${DEVTEAM_GATE_COUNTER}.mode   "enforce" | "observe" (written by gate-mode.sh)
#   ${DEVTEAM_GATE_COUNTER}.log    one line per swallowed failure
#   ${DEVTEAM_GATE_COUNTER}.claim.<n>  atomic block-slot claims (exclusive create)
#
# The block counter is allocated by claiming ${DEVTEAM_GATE_COUNTER}.claim.<n>
# slots with an exclusive (noclobber) create — never a read-modify-write race
# on the human-readable counter file, which this script only ever WRITES,
# never reads back to decide anything (a corrupt/unreadable counter can
# therefore never wedge the gate).
#
# stop_hook_active is read ONLY as an extra early-exit guard. It is
# undocumented and reported broken upstream, so the bound above (the claim
# slots) must and does hold with it permanently false.
#
# Never emits anything on stdout except the single deliberate block decision
# line `{"decision":"block","reason":"..."}` (return-lint's own --block-json
# output, passed through byte-for-byte — this script never re-types it).
# Never reads, writes, or logs the completion nonce; the gate has no access
# to it by construction.
#
# SECURITY NOTE for the adversarial panel (code-reviewer-deep): this is a
# turn-blocking hook that also writes a ReturnEnvelope on the agent's
# behalf (the exhaustion path, via return-lint.mjs's writeBlockedReturn) —
# flag for review as part of this slice's panel.
set -u

# ---------------------------------------------------------------------------
# Drain stdin (the hook JSON) unconditionally and first, before any guard can
# short-circuit and leave the pipe unread.
# ---------------------------------------------------------------------------
INPUT=$(cat 2>/dev/null || true)

# No DEVTEAM_GATE_COUNTER -> nowhere to derive sidecars or log to. Fail open
# silently; this is the one guard with no log destination of its own.
COUNTER="${DEVTEAM_GATE_COUNTER:-}"
[ -n "$COUNTER" ] || exit 0

LOG="${COUNTER}.log"

log() { # <message>
  printf '%s\n' "$*" >>"$LOG" 2>/dev/null || true
}

RECORD="${DEVTEAM_DISPATCH_RECORD:-}"
if [ -z "$RECORD" ]; then
  log "fail-open: missing DEVTEAM_DISPATCH_RECORD"
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  log "fail-open: missing CLAUDE_PLUGIN_ROOT"
  exit 0
fi

LINT="${PLUGIN_ROOT}/hooks/return-lint.mjs"
if [ ! -r "$LINT" ]; then
  log "fail-open: return-lint.mjs not found at $LINT"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  log "fail-open: node not found on PATH"
  exit 0
fi

CMUX_BIN="${CMUX_BIN:-cmux}"

# ---------------------------------------------------------------------------
# stop_hook_active — extra early exit ONLY. Never the bound (the claim slots
# below are, and must hold with this permanently false).
# ---------------------------------------------------------------------------
stop_active=$(printf '%s' "$INPUT" | node -e '
  const fs = require("fs");
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (e) { /* no stdin */ }
  let active = false;
  try { active = JSON.parse(raw).stop_hook_active === true; } catch (e) { /* malformed hook JSON */ }
  process.stdout.write(active ? "1" : "0");
' 2>>"$LOG")
[ "$stop_active" = "1" ] && exit 0

# ---------------------------------------------------------------------------
# Lint the return: return-lint.mjs's own main() is invoked directly via a
# dynamic import, rather than run as `node return-lint.mjs --block-json ...`.
# main()'s CLI contract (argv, exit codes, stdout) is unchanged; the reason
# this uses an import rather than the on-disk CLI form is that
# return-lint.mjs's invokedDirectly guard compares resolvePath(process.argv[1])
# against resolvePath(fileURLToPath(import.meta.url)) — Node's ESM loader
# resolves import.meta.url through any symlink in the path while argv[1]
# stays literal, so a --plugin-dir snapshot reached through a symlinked
# path component (routine on macOS: TMPDIR itself is /var -> /private/var)
# silently makes invokedDirectly false and skips main() entirely, exiting 0
# with no output. Calling main() directly sidesteps that path-identity
# fragility altogether. Exit codes: 0 valid, 1 invalid (stdout carries the
# block-json line), 2 usage/record error (unreadable path or schema-invalid
# record) — all fail-open cases collapse to exit code 2 here.
# ---------------------------------------------------------------------------
run_lint_block_json() {
  LINT_PATH="$LINT" RECORD_PATH="$RECORD" node -e '
    const fs = require("fs");
    (async () => {
      const mod = await import(process.env.LINT_PATH);
      const chunks = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
      let code = 2;
      try {
        code = mod.main(["--block-json", process.env.RECORD_PATH]);
      } finally {
        process.stdout.write = origWrite;
      }
      if (chunks.length > 0) process.stdout.write(chunks.join(""));
      process.exitCode = code;
    })().catch((err) => {
      process.stderr.write(String((err && err.stack) || err) + "\n");
      process.exitCode = 2;
    });
  ' 2>>"$LOG"
}

OUT=$(run_lint_block_json)
LINT_CODE=$?

if [ "$LINT_CODE" != "0" ] && [ "$LINT_CODE" != "1" ]; then
  log "fail-open: return-lint exited $LINT_CODE (record unreadable or schema-invalid)"
  exit 0
fi

# read_record_fields -> two lines on stdout: attn_parent, gate.max_blocks.
# One node call, plain JSON.parse — never a hand-rolled parser. This is an
# INDEPENDENT re-read of RECORD (worker-writable, G13), not a reuse of the
# lint pass's already-validated parse above: the record can be mutated or
# go unreadable between the two reads, so this is best-effort and emits an
# empty line per field it cannot recover (never a hand-rolled default) —
# callers must treat an empty field distinctly from a genuine value (an
# empty gate.max_blocks fails open; a genuine 0 does not, see below).
read_record_fields() {
  node -e '
    const fs = require("fs");
    try {
      const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const max = (r.gate && r.gate.max_blocks != null) ? r.gate.max_blocks : "";
      process.stdout.write(String(r.attn_parent || "") + "\n" + String(max) + "\n");
    } catch (e) {
      process.stdout.write("\n\n");
    }
  ' "$RECORD" 2>>"$LOG"
}

signal_attn() { # <attn-token>
  local attn=$1
  if [ -z "$attn" ]; then
    log "fail-open: attn_parent unreadable from record"
    return 0
  fi
  "$CMUX_BIN" wait-for -S "$attn" >/dev/null 2>>"$LOG" || log "cmux wait-for -S failed for $attn"
}

if [ "$LINT_CODE" = "0" ]; then
  # Valid return: signal the attention channel (best-effort by construction —
  # never completion evidence) and exit clean. No stdout, no block, no
  # counter claim.
  fields=$(read_record_fields)
  attn=$(printf '%s\n' "$fields" | sed -n '1p')
  signal_attn "$attn"
  exit 0
fi

# --- LINT_CODE = 1: invalid return -----------------------------------------

MODE_FILE="${COUNTER}.mode"
mode=$(cat "$MODE_FILE" 2>/dev/null || true)
if [ "$mode" = observe ]; then
  # Observe mode: never block, never claim a slot. Exact match only — a
  # mode file containing e.g. "observedX" or "xobserve" (never written by
  # gate-mode.sh, but the file is worker-writable, G13) must not match.
  exit 0
fi

fields=$(read_record_fields)
attn=$(printf '%s\n' "$fields" | sed -n '1p')
max=$(printf '%s\n' "$fields" | sed -n '2p')

# An empty max is an UNREADABLE gate.max_blocks (read_record_fields's own
# re-read failed or the field was absent) — never a genuine 0. Fail open:
# log, exit 0, no block, no counter claim, no exhaustion write. A genuine
# max_blocks: 0 is numeric and falls through to the existing exhaustion
# path below (the claim loop below runs zero iterations, same as any other
# exhausted max).
if [ -z "$max" ]; then
  log "fail-open: gate.max_blocks unreadable from record"
  exit 0
fi
case "$max" in
  *[!0-9]*)
    log "fail-open: gate.max_blocks non-numeric ($max)"
    exit 0
    ;;
esac

claim() { ( set -o noclobber; : > "$1" ) 2>/dev/null; }

slot=0
n=1
while [ "$n" -le "$max" ]; do
  if claim "${COUNTER}.claim.${n}"; then
    slot=$n
    break
  fi
  n=$((n + 1))
done

if [ "$slot" -gt 0 ]; then
  tmp="${COUNTER}.${$}.tmp"
  if printf '%s' "$slot" >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$COUNTER" 2>/dev/null || log "fail-open: could not persist gate counter"
  else
    log "fail-open: could not stage gate counter write"
  fi
  # Guard against an empty $OUT (a LINT_CODE=1 path that yielded no
  # block-json output, e.g. return-lint's own stdout capture came back
  # empty): a bare newline on a Stop hook's stdout is stray hook output,
  # never emit it — log fail-open instead.
  if [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
  else
    log "fail-open: return-lint produced no block-json output"
  fi
  exit 0
fi

# --- Exhausted: every claim slot 1..max_blocks is already taken (or
# max_blocks is a genuine 0, in which case there was never a slot to
# claim — an unreadable max_blocks already exited above, fail-open, before
# reaching here). Never a wedge — the turn is always allowed to end. -----

lastmsg=$(printf '%s' "$OUT" | node -e '
  const fs = require("fs");
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (e) { /* no stdin */ }
  try {
    process.stdout.write(JSON.parse(raw).reason || "");
  } catch (e) {
    process.stdout.write(raw);
  }
' 2>>"$LOG")

reason="agent ended ${max} turns without a contract-valid return; last lint failure: ${lastmsg}"

# writeBlockedReturn is imported directly (not the CLI's own --write-blocked,
# which composes a generic reason) so the exhaustion reason above can be
# passed through verbatim. Env vars carry the paths/reason so nothing needs
# to land in process.argv[1] — return-lint.mjs's own invokedDirectly check
# compares process.argv[1] to its own file path, and would otherwise re-run
# its CLI main() on import.
RECORD_PATH="$RECORD" LINT_PATH="$LINT" REASON="$reason" node -e '
  const fs = require("fs");
  import(process.env.LINT_PATH).then((mod) => {
    const record = JSON.parse(fs.readFileSync(process.env.RECORD_PATH, "utf8"));
    mod.writeBlockedReturn(record, process.env.REASON);
  }).catch((err) => {
    process.stderr.write(String((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
' >>"$LOG" 2>&1 || log "fail-open: writeBlockedReturn invocation failed"

signal_attn "$attn"
exit 0
