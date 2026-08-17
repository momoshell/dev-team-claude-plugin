# Reviewer guidelines — do not flag

Repo-owned judgment data. The reviewer's procedure loads this file; the
charter names it and does not restate it.

## Do not flag

Seeded from 49 archived runs' review findings and the 13 lead accepts that
refuted one. Each entry names the DEFENSE that makes its class safe to leave
alone; an entry whose defense stops being true comes off the list. This is not
silence — where one of these still worries you in a specific diff, write it as
a `consider` naming the defense you think fails.

- **A defect the current working tree no longer contains.** Re-read the line
  you are about to cite before you cite it; the fix may have landed after the
  evidence you are working from. Defense: the tree is the review's subject and
  it is one read away — `git diff` plus the file itself settle it (Method step
  1 of `crew/roles/reviewer.md`), and the plan's validation lane runs against
  that same tree. Six archived runs ended with the lead refuting a must-fix
  as already closed on disk.
- **Task-dir drift — `plan.md`, `gate.mjs` or an earlier `review.md`
  disagreeing with the built code.** Say it in your review's prose if it
  misleads the crew; it is not a finding against the build. Defense: the task
  dir is `~/.crew/<repo>/<task>/task` (`crew/crew.mjs:97-101`), outside the
  checkout, so nothing in it can reach a commit — the scope gate diffs `git
  status --porcelain` against `files_in_scope` (`crew/drive.mjs:1663-1673`)
  and the task dir never appears there.
- **A failure reachable only through a caller that does not exist** — a
  `Symbol` or `Proxy` argument, a hand-injected dependency, an exotic value no
  in-repo call site produces, in a module that is not public API. Not a
  must-fix. Defense: the call sites are enumerable — grep the module's exported
  name; if every caller is in this repo and none can produce that value, there
  is no failure to fix. In run `45-breaker` the lead refuted exactly this with
  the sole caller cited at `crew/crew.mjs:926`.
- **A fault needing a second, independent failure of the subsystem that would
  do the recovering** — the registry append failing while the fork succeeds, a
  kill inside a two-statement window followed by a restart. Not a must-fix.
  Defense: name the first fault's own consequence. Where it already leaves that
  subsystem's state unwritable, no handler could have recovered, so the missing
  handling changes nothing; the lead refuted this at `crew/daemon.mjs:606-660`
  in run `205-regrant`.
- **A remedy that cannot be built in this slice** — the fix needs a file
  outside the plan's `files_in_scope`, or a mechanism the plan or an ADR
  defers. Write it as a `consider` naming the deferred work. Defense: the scope
  gate bounces any edit outside `files_in_scope` (`crew/drive.mjs:1663-1673`),
  so a must-fix here can only produce a scope bounce or an escalation — never
  the fix you wanted (runs `83-headless-io` → #125, `46-tier-boot` → #193).
