# b302-bootrace — scout findings (read-only)

Every file:line below was read against the working tree at HEAD `1d03b8a`
(`git log -1` = `1d03b8a 2026-08-28 23:21:53 +0200 Merge pull request #729`).
Zero repo files were created, edited or deleted by this lane.

---

## F1 — the send path actually taken, call by call (question 1)

Verified, all pane transports (`crew.json`/journal boot row records
`"transports":{"lead":"pane","planner":"pane",...}` for every b299/b300/b301/b302 lane):

1. `crew/crew.mjs:1846` — `awaitSeatsReady(crew, 120, journal)` inside `runCmd`.
2. `crew/crew.mjs:1869` — `const io = seatIo(crew, paths, checkout, emitter, null, args)`.
3. `crew/crew.mjs` → `drive(ctx, io)`; `crew/drive.mjs:2005-2010` `assignAndWait`:
   - `:2006` `const { id, returnPath } = io.assign({ role, briefFile, note })`
   - `:2009` `io.log(recordRow({ at: io.now(), assign: id, role, brief: briefFile }))`
   - `:2010` `emit({ kind: 'assign', ... })`
4. `crew/seat-io.mjs:2292` `io.assign(spec)`; the pane branch falls through the
   non-DEFAULT_TRANSPORT early return at `:2302-2311` and reaches
   `crew/seat-io.mjs:2323`:
   `sendLine(m.surface_id, assignmentLine({ id, role, briefFile, returnPath, taskDir: paths.taskDir }))`
5. `crew/driver.mjs:147` `sendLine` — baseline read (`:157-163`), send (`:184`),
   echo poll (`:190-195`), enter (`:200`).

**(a) is FALSE.** The `assign` journal row is written at `crew/drive.mjs:2009`,
*after* `io.assign` returns (`:2006`), and `io.assign` calls `sendLine`
synchronously and re-throws every failure (`crew/seat-io.mjs:2322-2328`).
`sendLine` throws on: unreadable surface (`crew/driver.mjs:159`), failed
`cmux send` (`:185`), echo not verified exactly once over baseline (`:198`),
failed `send-key enter` (`:201`). Therefore the presence of
`{"at":1787953380095,"assign":"d1","role":"planner",...}` in
`~/.crew/dt-b299-cell/b299-cell/journal.jsonl` is **positive proof** that
`sendLine` ran to completion, that its echo verification PASSED, and that
`cmux send-key -- enter` returned ok.

**Timing corroboration.** `seat-ready` for `planner` is at
`2026-08-28T21:42:59.661Z`; the assign row is at `1787953380095` =
`21:43:00.095` — 434 ms later. `sendLine`'s minimum successful path is
`frameNeedleCount` (one `cmux read-screen`) + `cmux send` + `settle(250)` +
`frameNeedleCount` + `cmux send-key enter`, i.e. ~250 ms plus four `spawnSync`
round-trips. 434 ms is exactly a **first-attempt pass on the first poll
iteration**. No retype (`crew/driver.mjs:166-181`) occurred; no ctrl+u/ctrl+c
was sent.

**So the truth is (b) with (c) as its mechanism.** The guard did not fail to
fire — it fired and returned green. `sendLine` proves only that the needle
(`pickNeedle`, `crew/driver.mjs:142-145` → the return path, the longest of the
last 8 tokens) became visible on the pane **exactly once over baseline**. It
proves the characters reached the pane's screen. It proves nothing about the
agent having *consumed* them: `crew/driver.mjs:200-202` sends `enter` and
returns immediately, with **no post-enter check at all**. The seat's boot turn
was still running (the boot brief is not typed — it is the argv prompt baked
into the pane's launch command, `crew/crew.mjs:1563` → `paneCommand`
`crew/crew.mjs:1328-1342` → `crew/adapters/adapter-claude.mjs:130,151`
`` `"${bootBrief}"` `` — so a seat pane is *born mid-turn*), and it finished
~60 s later leaving an empty input box.

**What reading CANNOT settle**, and I will not guess: whether the TUI dropped
the submit at `enter`-time (input handler not yet accepting submits) or
accepted it into a queue that was reset when the boot turn ended. Both produce
the identical observed end-state. The measurement that settles it: boot one
pane whose argv prompt guarantees a ≥30 s turn, call `driver.mjs`'s own
`sendLine` into it at T+1 s, and capture `cmux read-screen --surface <id>
--lines 40` every 250 ms across the turn boundary. If the needle vanishes at
the `enter`, it is the submit being dropped; if it survives in the box and
vanishes only when the turn ends, it is the turn-end reset.

---

## F2 — READY_CHROME cannot distinguish a painted prompt from a replied seat (question 2)

`crew/crew.mjs:1989-1997`:

```js
export const READY_CHROME = Object.freeze([
  /bypass permissions|shift\+tab to cycle|❯/, // claude
  /\(sub\)|\s•\s/, // pi status line: "$0.000 (sub) … gpt-5.6-luna • high"
])
export function seatReadySignal(screen, role) {
  const s = String(screen || '')
  if (new RegExp(`ready:\\s*${role}\\b`, 'i').test(s)) return 'ready-reply'
  return READY_CHROME.some((re) => re.test(s)) ? 'chrome' : null
}
```

- Pattern 1 matches the claude TUI's **permission-mode footer**, its
  **shift+tab hint**, or a bare **`❯`** glyph. All three are *chrome painted by
  the terminal front-end*; none is emitted by the model. Pinned as such at
  `crew/crew.test.mjs:3968` (`'  ⏵⏵ bypass permissions on'` → `'chrome'`).
- Pattern 2 matches `(sub)` **or any line containing a space-bullet-space**.
  `/\s•\s/` is the loosest predicate in the file: any decorated status line,
  banner or tab strip anywhere in the 40 read lines satisfies it. Pinned at
  `crew/crew.test.mjs:3967`.
- The primary is `ready:\s*<role>\b`, case-insensitive
  (`crew/crew.mjs:1995`). It is NOT spoofable by the echoed boot brief, because
  the brief says the literal `your-role` (`crew/crew.mjs:1563`), pinned at
  `crew/crew.test.mjs:3970-3971`.

**Answer: no.** Chrome is evidence that a TUI painted, and the layering's own
comment says so (`crew/crew.mjs:1984-1988`). But that comment's cost estimate —
"a false positive costs one assignment typed a beat early" — is wrong by two
orders of magnitude, and the structure makes the fallback **unconditional**:
`seatReadySignal` evaluates chrome on the *same* screen read as the primary, so
on a cold boot chrome wins *every* time, because painting precedes the model's
first token by tens of seconds.

**Measured, 18 of 18 rows across four consecutive lanes** (`grep seat-ready` in
each `~/.crew/*/*/journal.jsonl`): b299-cell 5×`chrome`, b300-coldverify
5×`chrome`, b301-daemonid 4×`chrome`, b302-bootrace 4×`chrome`.
**`ready-reply` has never once been recorded.** The primary predicate is dead
code in practice.

**Sharper still — chrome matched impossibly early.** b301-daemonid's `boot` row
is `21:42:59.492Z` and its first `seat-ready` is `21:42:59.643Z`: **151 ms**.
b302-bootrace: boot `21:57:35.002Z`, first seat-ready `21:57:35.160Z` —
**158 ms**. A `claude` process cannot start, connect and paint its footer in
150 ms. So on at least those lanes `READY_CHROME` matched something that is not
the seat agent at all. I cannot say *what* from reading, and I will not guess.
The measurement that settles it: sample `cmux read-screen --surface <id>
--lines 40` at 100 ms intervals over the first 3 s of a freshly created seat
pane and record the first frame that satisfies each pattern, verbatim.

---

## F3 — the missing ordering guarantee, as one sentence a test could pin (question 3)

> No assignment line may be submitted to a pane seat until that seat has
> demonstrated it is **between turns** — evidenced by its own `ready: <role>`
> reply for the first assignment, and by the previous assignment's turn having
> ended for every later one — and a submitted line must be proved **consumed**
> (the input box returned to its pre-send baseline and the line entered the
> transcript), not merely **echoed**.

The sentence has two halves because the defect has two independent holes, and
each is pinnable on its own:

- **Ordering hole** — `crew/crew.mjs:1993-1997`: readiness is satisfied by
  chrome, which is orthogonal to turn state.
- **Proof hole** — `crew/driver.mjs:196-202`: `sendLine`'s only success
  criterion is `last === before + 1`, i.e. the needle is *on the screen*.
  After `send-key enter` it returns. It never re-reads. A swallowed submit and
  a consumed one are byte-identical to this function.

---

## F4 — recommended fix, and where it belongs (question 4)

Two halves, in two files, and only one of them is this lane's.

**(i) `crew/driver.mjs` — the submission proof. THIS LANE OWNS IT** (fence
register: `b302-bootrace owns crew/driver.mjs`). After `crew/driver.mjs:200`'s
`enter`, poll `frameNeedleCount(surfaceId, needle)` for a bounded window and
require the count to leave the post-send value — the input box clearing is the
observable difference between a submitted line and one still sitting unsent.
Today the function returns blind. Make the swallow **loud**, and bound a resend
around it (the existing retype ladder at `crew/driver.mjs:166-181` already
knows how to clear a box safely). Note the window arithmetic: the failure lasted
~60 s while `SEND_VERIFY_WINDOW_MS` is 3000 and `SEND_VERIFY_ATTEMPTS` is 3
(`crew/driver.mjs:72,75`) — a driver-side *resend* that actually recovers this
race needs a budget on the order of the boot turn, not 9 s. Sizing that budget
is a design call for the planner, not a fact I can read out of the tree.

**(ii) `crew/crew.mjs` — the readiness predicate. NOT THIS LANE'S FILE.** The
correct predicate is the one the brief names: require the seat's own
`ready: <role>` reply. The minimal shape is to stop treating chrome as
interchangeable with the reply — demand `ready-reply` on a **fresh** boot and
admit `chrome` only for a re-run against a pre-existing workspace, and/or only
after the reply has been absent for a floor interval. The seam is exactly
`seatReadySignal` / `awaitSeatsReady`, `crew/crew.mjs:1989-2027`.

> **`crew/crew.mjs` is held by a lane running RIGHT NOW** (the task brief says
> so, and `Out of scope` names `crew/crew.mjs`, `crew/seat-io.mjs`,
> `crew/drive.mjs`, `crew/daemon.mjs` as concurrently held). Half (ii) must NOT
> be attempted from a b302 build lane, and its current contents must not be
> assumed still current when any build lane starts. Sequence a `crew.mjs` build
> lane strictly **after** the lane that holds it lands. Half (i) is
> independently landable and is the half that converts a silent swallow into a
> reported failure, so it is worth landing first on its own.

**Coverage note (a real gap, not a nit):** `sendLine` has **no direct test**.
`crew/driver.test.mjs` pins `assignmentLine`, `assertSafeLine`, `pickNeedle`
and `surfaceProcessTree` (tests at `:15-92` and `:546-712`) and never once
mentions `enter` (`grep -n enter crew/driver.test.mjs` → no output). Every
other suite injects `sendLine` as a stub
(`crew/io-contract.test.mjs:42,94-95,109`;
`crew/seat-io-runclean.test.mjs:303,688,715,…`; `crew/crew.test.mjs:3537`).
The send/verify/enter sequence — the guard this whole task is about — is
currently unpinned in its entirety. A driver-half fix must arrive with its own
tests against a faked `cmux`.

---

## F5 — later assignments are exposed too, and one path is worse (question 5)

**Yes.** Every pane assignment travels the same unproved `sendLine`
(`crew/seat-io.mjs:2323`), so nothing about the first assignment is special
except the *size* of its window. Concretely:

- **Later assignments to an idle seat** (builder, reviewer, tech-lead, whose
  panes went idle minutes before their first work) are safe **by elapsed time
  alone**, not by any guarantee in the code. `awaitSeatsReady` runs exactly
  once, at `crew/crew.mjs:1846`; nothing re-checks turn state before any
  subsequent assign.
- **Assignments that follow a completed dispatch are structurally racy.**
  `waitForEnvelope` returns the instant the envelope file is readable
  (`crew/seat-io.mjs:1631,1639` — `const env = readEnvelope(); if (env != null)
  return env`). The seat writes its envelope **before** it prints its
  `CREW-DONE` line (the charter, and the assignment text composed at
  `crew/driver.mjs:125`, both order it that way). So the driver is free to type
  the next assignment into a seat that is *still mid-turn*, in the gap between
  the envelope's `Write` and the end of the turn. This is the same race with a
  window of milliseconds-to-seconds instead of 60 s — narrower, not absent, and
  it widens with any seat that writes its envelope early and then keeps working.
- **The re-ask / re-prompt paths are the most exposed of all**, because they
  deliberately send into a seat presumed stuck or busy:
  `crew/seat-io.mjs:1921` (silence re-prompt), `:2093` (refusal re-prompt) and
  `:2166` (re-ask). Each is a bare `sendLine` with the same non-proof, and each
  has a bounded re-send budget (`REASK_MAX`) that a swallowed line spends for
  nothing — a swallowed re-ask is charged against the seat as a refusal it
  never made.

The driver-half fix in F4(i) covers all three of these; the crew.mjs-half fix
in F4(ii) covers only the boot case.

---

## Anomaly worth recording (not load-bearing for any claim above)

b299-cell and b300-coldverify carry **byte-identical** `seat-ready` timestamps
(`.643 .661 .680 .698 .717`) and an identical `assign d1` epoch
(`1787953380095`), in two distinct inodes (2044359, 2044394) with distinct
brief paths. `scripts/factory/dispatch-batch.mjs:1821-1845` explains it without
mystery: the batch boots **every** lane in one sequential loop first
(`:1821-1845`), then spawns every lane's `crew.mjs run` **in the background**
in a second loop (`:1847-1876`), so all three run processes enter
`awaitSeatsReady` within microseconds of each other and issue the same fixed
sequence of `cmux read-screen` calls. It also means the panes of the
*earliest*-booted lane get ~1.2 s of life and the *latest* gets ~0.15 s before
being declared ready — which is F2's finding restated as a batch property: the
faster the batch, the more certainly chrome beats the reply.
