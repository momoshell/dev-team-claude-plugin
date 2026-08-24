# Batch dispatch

Dispatch a batch in this order, and record what refuses at each boundary:

1. Create one worktree per lane.
2. Boot with **one shared fence register for the whole batch**. Boot writes the
   other lanes' files, so every write lane must be known before any seat boots.
3. Run the two-pass compile. Generate the `reads` list from the compiler's own
   refusal text: **`coupled-source-unfenced`** and the reverse spare-ack refusal
   **`stale-read-ack`**. A `where` path that does not exist refuses
   **`missing-path`** (`scripts/factory/make-brief.mjs:108`, `COUPLED_SOURCE_UNFENCED = 'coupled-source-unfenced'`; `scripts/factory/make-brief.mjs:109`, `STALE_READ_ACK = 'stale-read-ack'`).
4. Verify through **`validateScopeEntries`** and **`scopeMatcher`** for own-file
   coverage and zero sibling leaks.
5. Check the protected floor with **`protectedHitsIn`** over
   **`resolveProtectedPaths`** (`crew/protected-paths.mjs:24`, `export function resolveProtectedPaths(extra)`); the floor evidence is in
   `references/tier.md`.
6. Boot the lanes, then background `run`.
7. Check **arrival, not parsing**: `crew.json` carries `lane_name` for the own
   lane and `lane_fence` for siblings (a count of batch total minus own); the
   journal carries the `lane-fence` event. **`fence=NONE`** in a write lane means
   a boot-only flag went to the wrong verb.

Parallelise on file-set disjointness, never on workspace count. The compiler
runs the full suite on every compile, so sequence compiles and never nest a
waiter inside another background call. Arm the watcher on the run log: `run`
emits exactly one terminal `{"status":…}` line, while a pid is only a proxy.
Merge the batch branches in a scratch worktree and run the suite before handing
them over. Size a scout brief to the **write-up**, not the reading: forbid
subagent fan-out explicitly on a read-everything sweep and ask for incremental
findings, because two scouts finished measuring and escalated with the envelope
unwritten.

## Parked conditions go stale

**`parked`** names a trigger, and triggers can be met silently, so **`audit the trigger against the code`** before repeating it. **`#291`** had both halves met
and **`#379`** had two of three; a body stale about its trigger is stale about
its steps too. Verify every clause you are about to brief, not just the blocking
one.
