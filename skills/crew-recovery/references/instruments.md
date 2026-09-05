# Instruments lie

When a measurement surprises you, suspect the instrument first. Keep one short
case per measurement:

- `pgrep -f` can match **the WRAPPER SHELL** quoting its command, so a live compile looked dead; print the rows instead of quoting a count.
- A **lazily-opened** handle can report healthy before the query it reports on; an extraction fallback can have **invented a field** the payload never had.
- A concurrent **sibling lane polluted** a before/after count; isolate with `DEVTEAM_LEDGER_DIR=$(mktemp -d)`.
- A `cd` at the head of a **compound command** can apply to the whole command, so an A/B said “on main” while running in the branch.
- A **pid-tracking watcher** called a lane a silent death as it succeeded while the run-log tailer stayed correct; the run log is the authority.
- Verify a filter by match count and against a known-good name: `^.+[A-Za-z0-9]{6}$` matched anything ending in **six alphanumerics** and deleted a live shim.
- **`${PIPESTATUS[0]}`** is bash and prints empty under zsh (`${pipestatus[1]}`); `$?` after a pipe is the last command's status.
- A suppressed `git rebase` failure read as success from a downstream signal; a process being **alive now** says nothing about whether it died an hour ago, and the crash may be one log away.
- Checking **too early** looks exactly like an instrument lying. A zero from grep whose pattern guesses formatting is a fact about the pattern, not the result.
- An empty grep on a pipe may mean decoration: `function colourNeutralEnv(base = process.env)` (`scripts/factory/make-brief.mjs:793`) **deletes** `FORCE_COLOR` rather than only setting `NO_COLOR`.
- Probing the wrong **layer** reads exactly like a missing guard.
- **`load average`** is the wrong spare-capacity instrument: 16.97 on 16 cores looked saturated, while direct measurement showed 96.7% of 1600%, 2 runnable, and 893 sleeping. Measure `ps -Ao pcpu` and the runnable/sleeping split.
- An escalation is not proof that work failed: the envelope landed two minutes after the driver's 2400s budget (`crew/drive.mjs:52`, `builder: 2400, reviewer: 1800`), so read `returns/d*.json` and `git status` before rerunning.
- `node --test` can silently ignore a path that does not exist while exiting 0 with `# fail 0`; a green summary is not evidence that a test file ran.

Since PR #577, a seat that looks alive may have been refused: the runtime names
the refusal from the transport's typed frame, journals `seat-refusal`, and the
seat-refusal re-prompt is **one of three re-asks** sharing a single grace (see
liveness.md). It ends on a second rejection. Read the journal and returns rather
than the pane. Re-derive a surprising measurement **a second way** before
acting; a memory recording a MEASUREMENT is not overturned by another module's
intent — find the mechanism in code first.

- `rpc_exit_context` is emitted only by the `headless-rpc` transport and only for a
  turn that ended **WITHOUT** an envelope. Its `attribution` is the closed
  `EXIT_ATTRIBUTIONS` set `driver-retired | external-signal | self-exit | unknown`.
  The `headless-json` transport emits none, so its absence is not evidence.
- `provider_failure` is present only when a provider failure was classified. Its
  `kind` is the closed `PROVIDER_FAILURE_KINDS` set
  `rate_limit | authentication_failed | server_error | provider-unclassified`
  (including the hyphenated member), and it carries `status`. A non-finite status
  yields no kind at all rather than a guess.
