# Reviewer guidelines — do not flag

Repo-owned judgment data for the `/review` command's procedure only:
`commands/review.md` follows `.agents/skills/review-procedure/SKILL.md`, which
loads this file. No lane seat receives it; a lane reviewer works from
`crew/agents/reviewer.md`, which does not name it.

## Do not flag

Seeded from 49 archived runs' review findings and the 13 lead accepts that
refuted one. Each entry names the DEFENSE that makes its class safe to leave
alone; an entry whose defense stops being true comes off the list. This is not
silence — where one of these still worries you in a specific diff, write it as
a `consider` naming the defense you think fails.

- **A defect the current working tree no longer contains.** Re-read the line
  you are about to cite before you cite it; the fix may have landed after the
  evidence you are working from. Defense: the tree is the review's subject and
  it is one read away. `crew/agents/reviewer.md` requires reading the diff and
  every listed untracked file; the loop runs per-test proof and the suite on
  that tree. Six archived runs ended with the lead refuting a must-fix
  as already closed on disk.
- **Task-dir drift — `plan.md` or an earlier review disagreeing with the built
  code.** Say it in your review's prose if it misleads the crew; it is not a
  finding against the build. Defense: the task dir is `~/.crew/dt-<lane>/<lane>/task`,
  outside the checkout, so the loop never commits it.
- **A failure reachable only through a caller that does not exist** — a
  `Symbol` or `Proxy` argument, a hand-injected dependency, an exotic value no
  in-repo call site produces, in a module that is not public API. Not a
  must-fix. Defense: the call sites are enumerable — grep the module's exported
  name; if every caller is in this repo and none can produce that value, there
  is no failure to fix. In run `45-breaker` the lead refuted exactly this with
  the sole caller cited.
- **A fault needing a second, independent failure of the subsystem that would
  do the recovering** — the registry append failing while the fork succeeds, a
  kill inside a two-statement window followed by a restart. Not a must-fix.
  Defense: name the first fault's own consequence. Where it already leaves that
  subsystem's state unwritable, no handler could have recovered, so the missing
  handling changes nothing; the lead refuted this in run `205-regrant`.
- **A remedy needing a mechanism the plan or an ADR defers.** Write it as a
  `consider` naming the deferred work. Defense: the remedy is deferred, not
  invisible; read the complete diff, say what is wrong and name the deferred
  work (runs `83-headless-io` → #125, `46-tier-boot` → #193).
