# Audit register — skills/devops + skills/pr-review

Checkout `/Users/x/Development/dt-s3-prose`, branch `audit-s3-prose`, HEAD `5a8d76a`. Read-only run; no repo file created, edited or deleted.

**Verdict vocabulary used here**
- **true** — verified; the cited line (or a line inside the cited range) exhibits the claim.
- **stale** — the claim's substance still holds but the anchor no longer lands on the exhibiting statement (or the exhibit moved). The correct line is named.
- **false** — an agent acting on it would do the wrong thing: the cited code does the opposite, the mechanism named does not exist, or the number/label is not what the source carries.

## Files read in full

| file | lines |
|---|---|
| `skills/devops/SKILL.md` | 43 |
| `skills/devops/references/daemon.md` | 60 |
| `skills/devops/references/evidence.md` | 85 |
| `skills/devops/references/gh.md` | 59 |
| `skills/devops/references/lane-branches.md` | 58 |
| `skills/devops/references/processes.md` | 59 |
| `skills/devops/references/worktrees.md` | 55 |
| `skills/devops/exhibits.test.mjs` | 70 |
| `skills/pr-review/SKILL.md` | 62 |
| `skills/pr-review/references/divergence.md` | 32 |
| `skills/pr-review/references/evidence.md` | 35 |
| `skills/pr-review/references/findings-shape.md` | 37 |
| `skills/pr-review/references/posture.md` | 12 |
| `skills/pr-review/references/rubric.md` | 65 |
| `skills/pr-review/findings-shape.test.mjs` | 97 |
| `crew/roles/reviewer.md` (supporting) | 75 |
| `crew/guidelines/review-do-not-flag.md` (supporting) | 46 |

Verification sources: `crew/daemon.mjs` (1438 lines), `crew/drive.mjs` (3250), `crew/crew.mjs`, `crew/arms.mjs`, `crew/seat-io.mjs`, `crew/escalation-policy.mjs`, `crew/protected-paths.mjs`, `crew/capabilities.json`, `crew/pi/agents/scout.json`, `crew/README.md`, `scripts/factory/{ci-watch,intake,probe-repo,reap-stale}.mjs`, `scripts/pr-review-window.sh`, `package.json`, `commands/`, sibling skills, `gh --help` / `git --help` (2.97.0 / system git), and the preserved register `/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md`.

Both tripwire suites pass at HEAD: `node --test skills/devops/exhibits.test.mjs` → 4/4; `node --test skills/pr-review/findings-shape.test.mjs` → 4/4.

---

## Per-document register

### `skills/devops/SKILL.md` — 22 checkable claims · 18 true · 2 stale · 2 false

**FALSE**

> `skills/devops/SKILL.md:29` — "Create worktrees with Git's registration command, **remove them with `git worktree remove`**, and gate teardown on the run outcome. Exhibit: `crew/arms.mjs:661` and `crew/crew.mjs:1879`."

Evidence: no code in this checkout ever runs `git worktree remove`. `grep -rn "worktree" crew/crew.mjs` returns **zero hits** — the crew loop never touches worktrees at all. The only `git worktree` invocation is `crew/arms.mjs:672` (`['worktree', 'add', '-b', plan.branch, plan.dir, setPin]`), and `crew/arms.test.mjs:331` asserts the opposite of removal: `assert.ok(seen.every((argv) => !['push', 'remove', 'prune'].some((word) => argv.includes(word))))`. The teardown the second anchor points at is a **rename, not a removal**: `crew/crew.mjs:2085-2086` — `` const archived = `${paths.dir}.archive-${new Date().toISOString()...}` `` then `renameSyncFn(paths.dir, archived)`. `crew/crew.mjs:1879` is the comment `//   done       -> auto-teardown (archive the record, close the view),` about the **crew state dir**, not a git worktree. An agent following this rule would look for (or invent) a `git worktree remove` step in the crew lifecycle that does not exist, and would mistake the archive rename for a worktree unregistration.

> `skills/devops/SKILL.md:30` — "…never assume its stash or object metadata is lane-local. Exhibit: `scripts/factory/ci-watch.mjs:237` and **`crew/seat-io.mjs:1655`**."

Evidence: `crew/seat-io.mjs:1655` is `if (raw === staleRaw) return null` and `:1656` is `return readEnvelopeFile(returnPath, { existsSync, readFileSync, role })` — the **envelope-staleness check inside `readEnvelope`**, with no relation to stash or the common git dir. The real exhibit is 25 lines later: `crew/seat-io.mjs:1680-1682` — "`// The stash stack is NOT per-worktree: git rev-parse --git-path refs/stash`", "`// resolves to the SAME file in the common git dir from every linked worktree,`", "`// so git stash pop restores whatever lane pushed LAST (#471).`". Counted false rather than stale because the cited line exhibits an unrelated mechanism, and the same wrong anchor is repeated twice in `worktrees.md` (see below).

**STALE**

> `skills/devops/SKILL.md:29` — "Create worktrees with Git's registration command… Exhibit: `crew/arms.mjs:661`."
Evidence: `crew/arms.mjs:661` is the *refusal* (`return spawnRefusal('worktree-exists', …)`); creation is `crew/arms.mjs:670-672`. `worktrees.md:4` cites 670 for the same fact, so the SKILL and its reference disagree on the anchor.

> `skills/devops/SKILL.md:31` — "Give `gh` an absolute `--body-file` … Exhibit: `scripts/factory/intake.mjs:533`."
Evidence: `intake.mjs:533-535` is `d.spawnSync('gh', ['pr','list','--head',…], { cwd: root, … })` — a read-only query with an explicit cwd and **no `--body-file` anywhere**. `evidence.md:8-18` concedes the body-file half is unbacked, so the SKILL's line asserts as exhibited what its own register calls operator-measured.

**TRUE (compact)**
- `name: devops` matches the directory — `skills/devops/SKILL.md:2`.
- Routing rows name six files that all exist — `SKILL.md:20-25` vs `ls skills/devops/references/` (daemon, evidence, gh, lane-branches, processes, worktrees).
- Key-references list matches the same six — `SKILL.md:38-43`.
- "gate teardown on the run outcome" — `crew/crew.mjs:1879-1888` (`if (result.status === 'done' && !args.keep) … teardownCore`).
- "detect it with `--git-common-dir`" — flag exists (`git rev-parse --help` → `--git-common-dir`), used at `scripts/factory/ci-watch.mjs:237`.
- `#471` is the stash issue — `crew/seat-io.mjs:1682`.
- `--body-file` is a real `gh` flag — `gh issue create --help` → `-F, --body-file file`; same on `gh pr create`.
- `GH_BIN` seam — `scripts/factory/probe-repo.mjs:739` (`spawnSync(process.env.GH_BIN || 'gh', args, …)`).
- `git push origin --delete` is a real invocation — `git push --help` → `[-d | --delete]`.
- Worker-path refusal — `scripts/factory/ci-watch.mjs:262-265` (`const worker = isWorkerPath(…)`; `if (worker.worker) return { ok:false, reason:'worker-path' … }`).
- Dry-run default until `--reclaim` — `scripts/factory/reap-stale.mjs:251-253`.
- Boot prints a reclaim command instead of killing — `crew/crew.mjs:664-666`.
- `proven` / `failed` / `unproven` — `REAP_ACCOUNTING` at `scripts/factory/reap-stale.mjs:75`.
- `#473` is the archived-lane leak — `scripts/factory/reap-stale.mjs:74,105`.
- Nine daemon commands at `crew/daemon.mjs:113`; default root `~/.crew/daemon` at `crew/daemon.mjs:371`.
- "no launchd service" — `grep -rni "launchd|launchctl|LaunchAgents|.plist"` over the tree: the only non-skill hit is `tasks/cmux-mode/spike-findings.md:58`.

---

### `skills/devops/references/daemon.md` — 24 checkable claims · 20 true · 4 stale · 0 false

**STALE**

> `daemon.md:6-7` — "Its Unix socket is `daemon.sock`. Exhibit: `crew/daemon.mjs:371`."
Evidence: `crew/daemon.mjs:371` is `const root = resolvePath(options.root || join(homedir(), '.crew', 'daemon'))`. The socket is one line later: `:372` `const socketPath = join(root, 'daemon.sock')`. (The adjacent pidfile claim at `daemon.md:9-10` cites `:373` and is exactly right — `const pidPath = join(root, 'daemon.json')` — so the socket line is a one-off slip, not a whole-block shift.)

> `daemon.md:12-13` — "A per-run journal is written as `journal.jsonl`. Exhibit: `crew/daemon.mjs:451`."
Evidence: `crew/daemon.mjs:451` is `artifacts: [join(run.crew_dir, 'journal.jsonl')],` inside the **death-record escalation envelope** — the daemon never writes the journal. The writer is the crew loop: `crew/crew.mjs:1518` (`const journalPath = join(paths.dir, 'journal.jsonl')`), `crew/crew.mjs:1642` and `:2104` (`logLine(join(paths.dir, 'journal.jsonl'), …)`). The daemon only *polls* it (`crew/daemon.mjs:711`).

> `daemon.md:49-50` — "An empty journal is no run evidence; inspect the envelope separately. Exhibit: `crew/daemon.mjs:713`."
Evidence: `:713` is `if (!line.trim()) continue` — a blank-**line** skip inside `pollJournal`'s loop, not a statement about an empty journal or about the envelope. The envelope-vs-projection separation is at `crew/README.md:218` ("`state()` … carries no outcome … its outcome is read separately through `result()`").

> `daemon.md:58-60` — "The cost of confusing state with result is reporting a live projection as an outcome. Exhibit: `crew/README.md:216`."
Evidence: `crew/README.md:216` is the socket/pidfile/command-set paragraph. The state-vs-result sentence is `crew/README.md:218`.

**TRUE (compact)**
- Default root `~/.crew/daemon` — `crew/daemon.mjs:371`; pidfile `daemon.json` — `:373`.
- Journal path polled after startup — `crew/daemon.mjs:710-711` (`function pollJournal(run) { const path = join(run.crew_dir, 'journal.jsonl') }`).
- Closed vocabulary of exactly nine names, in the documented order — `crew/daemon.mjs:113`: `DAEMON_COMMANDS = Object.freeze(['ping','enqueue','list','state','result','tail','untail','stop','send'])`; independently corroborated by `crew/README.md:216` and pinned by `skills/devops/exhibits.test.mjs:15-23`.
- Each per-verb sentence (`daemon.md:22-35`, six claims) names only verbs present in that frozen list — `crew/daemon.mjs:113`.
- "no launchd service; plain Node process" — negative grep above; start path is `daemon({root}).start()` per `crew/README.md:224`.
- "There is no plist or launchctl recipe in this checkout" — same grep, zero hits outside the skill and `tasks/cmux-mode/spike-findings.md:58`.
- "An absent socket is unavailable, not a successful ping" — `crew/daemon.mjs:1239-1241` (`socket = net.connect(socketPath)`; `socket.on('error', () => finish(false))`).
- "An interrupted daemon read must preserve an indeterminate state" — `crew/daemon.mjs:615-620` (`cursorLines` guards `!exists(path)` and a truncated `size < cursor.offset`).
- Cross-reference to the co-located tripwire — `skills/devops/exhibits.test.mjs:15` is indeed the closed-command-set test.
- Register cross-references at `daemon.md:41,44` resolve to `skills/devops/references/evidence.md:65-80`.

---

### `skills/devops/references/evidence.md` — 12 checkable claims · 10 true · 2 stale · 0 false

**STALE**

> `evidence.md:10-11` — "The pre-skill whole-tree search for `body-file`, `body_file`, and `bodyFile` found **zero hits**."
Evidence: it is no longer zero. `grep -rn -- "body-file|body_file|bodyFile" .` now hits `commands/commands.test.mjs:33` — `'--body-file',` inside `PROCEDURE_TOKENS`, the list of "Procedure content the skills own" that the commands must not repeat (`commands/commands.test.mjs:22-34`). That file arrived with `a3f66f2 feat(commands): add dispatch, status and close-out crew commands`, i.e. after the register was written. The *substantive* half ("no `gh pr create`/`gh issue create` implementation") still holds: the only other hit is a forbidden-token assertion, `test/factory-intake.test.mjs:1079-1085`.

> `evidence.md:20` — "The nearby `gh` calls are read-only queries or seam examples. Exhibit: `scripts/factory/intake.mjs:533-535`."
Evidence: the range is right for the read-only query, but the *seam example* half lives in a different file — `scripts/factory/probe-repo.mjs:736-740`. Minor, and the register is otherwise the most accurate document in the family.

**TRUE (compact)**
- No `gh pr create` / `gh issue create` implementation — grep: only `test/factory-intake.test.mjs:1081` (forbidden-token list) and the skill's own prose.
- `deleteBranchOnMerge` is a probed repo setting only — `scripts/factory/probe-repo.mjs:799` (inside `gatherPrConventions`'s `fields`).
- No branch-deletion implementation anywhere — grep for `push … --delete`: the only `--delete` in the tree is `crew/pi/extensions/lab.ts:528` (`symbolic-ref --delete`), unrelated.
- Linked-worktree probe catches a failed `rev-parse` and sets `linked = false` — `scripts/factory/ci-watch.mjs:240-242` (inside the cited 241-244 range).
- No local removal implementation ties the failed probe to teardown — corroborated by the zero-hit `git worktree remove` grep above.
- `guardedKill` pid/pgid guard is backed at `scripts/factory/reap-stale.mjs:56-61` (cited 56-60; the `throw err` is at 61).
- No dedicated test isolates an EPERM/interrupted kill — no such case in `crew/reclaim*.test.mjs` or `scripts/factory` tests.
- launchd negative search and its single incidental hit `tasks/cmux-mode/spike-findings.md:58` — verified verbatim (the cmux ancestry line).

---

### `skills/devops/references/gh.md` — 18 checkable claims · 15 true · 1 stale · 2 false

**FALSE**

> `gh.md:44-45` — "If `gh` is unavailable, preserve that as unavailable rather than as API failure. Exhibit: `scripts/factory/intake.mjs:545`."
Evidence: `scripts/factory/intake.mjs:545` is the closing `}` of `defaultPullRequestFor`, and the function it closes does **exactly what the rule forbids**: `:536-537` `} catch { return null }`, `:539` `if (!result || result.error || result.status !== 0) return null`, `:541` `catch { return null }` — an unavailable `gh`, a rejected request and a malformed payload all collapse to the same `null`. The code that actually preserves the distinction is in another file: `scripts/factory/probe-repo.mjs:733` `return 'gh_request_rejected'` versus `:741` `return { ok: false, reason: 'gh_unavailable' }`, with the comment at `:744-745` ("No exit status means the tool did not run to completion … that is absence, not a rejected request"). An agent citing `intake.mjs:545` as the exhibit would be citing a counter-example.

> `gh.md:47-48` — "If the cwd is missing, refuse before asking the CLI to resolve relative data. Exhibit: `scripts/factory/intake.mjs:533-535`."
Evidence: the cited function does not refuse a missing cwd — it silently substitutes one. `scripts/factory/intake.mjs:530`: `const root = typeof checkout === 'string' && checkout.length > 0 ? checkout : process.cwd()`, and there is no `existsSync` check before `:533`'s `spawnSync`. The refusal the rule describes exists elsewhere: `scripts/factory/ci-watch.mjs:258-259` — `if (typeof checkout !== 'string' || checkout.length === 0 || !d.existsSync(checkout)) { return { ok: false, reason: 'checkout-missing', … } }`.

**STALE**

> `gh.md:23-24` — "The intake helper supplies its **repository root** directly to `spawnSync`. Exhibit: `scripts/factory/intake.mjs:533-535`."
Evidence: it supplies `root`, which is the caller-supplied `checkout` **or `process.cwd()`** (`intake.mjs:530`) — a fallback, not a repository root. The cwd is explicit in the `spawnSync` options (`:535` `{ cwd: root, encoding: 'utf8' }`), which is the part the rule needs; the "repository root" wording overstates it.

**TRUE (compact)**
- `--body-file` exists on the create verbs — `gh issue create --help` → `-F, --body-file file`; `gh pr create --help` → same. gh 2.97.0.
- `gh issue list --repo OWNER/REPO` is valid — `gh issue list --help` → `-R, --repo [HOST/]OWNER/REPO`; `--json`, `-L/--limit` present.
- Eight `Status: … unbacked …; see evidence.md` markers (`gh.md:4,7,11,15,36,39,42,51`) all resolve to a matching section of `skills/devops/references/evidence.md:8-26`.
- "A compound `cd` can change what a relative `--body-file` means. Exhibit in kind: `skills/qa-test-writing/references/tooling.md:89`" — exact: line 89 is "and a compound `cd` that silently changed what a relative path meant."; same anchor reused at `gh.md:56`, also exact.
- "Use the process API's `cwd` option instead of embedding a shell `cd`" — `scripts/factory/intake.mjs:535`.
- `GH_BIN` injectable seam and its argv/cwd observability — `scripts/factory/probe-repo.mjs:739-740`.
- "The source exhibits cover explicit cwd and GH_BIN only, not remote creation" (`gh.md:53`) — corroborated by the zero-hit create grep.

---

### `skills/devops/references/lane-branches.md` — 16 checkable claims · 13 true · 3 stale · 0 false

**STALE** — three claims share one over-reused anchor, `scripts/factory/ci-watch.mjs:262`, which is `const worker = isWorkerPath({ checkout, crewRoot, deps: d })`:

> `lane-branches.md:25-26` — "A missing checkout refuses publication instead of guessing its location. Exhibit: `scripts/factory/ci-watch.mjs:262`."
Evidence: that refusal is at `:258-259` (`!d.existsSync(checkout)` → `reason: 'checkout-missing'`), four lines before the anchor.

> `lane-branches.md:28-29` — "An unresolved branch refuses publication instead of pushing a default. Exhibit: `scripts/factory/ci-watch.mjs:262`."
Evidence: that refusal is at `:272-273` and `:277-278` (`reason: 'branch-unresolved'`), ten to sixteen lines after the anchor.

> `lane-branches.md:22-23` — "A checkout under the crew root is also treated as a worker path. Exhibit: `scripts/factory/ci-watch.mjs:237`."
Evidence: `:237` is the `rev-parse` argv (the *linked* probe). The crew-root test is `:244-249` (`underCrew = isUnder(realPathOr(d, crewRoot), realPathOr(d, checkout))`) and the disjunction is `:250`.

**TRUE (compact)**
- "Never publish from a worker path" and "the gate runs before branch resolution or construction of push argv" — `scripts/factory/ci-watch.mjs:262-265`, with the code's own comment at `:263-264`: "This gate must precede branch resolution and the construction of any argv containing `push`".
- "The linked-worktree probe compares the two Git directory locations" — `:237` (`['rev-parse','--path-format=absolute','--git-dir','--git-common-dir']`), verdict computed at `:239`.
- "An empty branch name is an invalid publication input. Exhibit: `:277`" — exact: `:277-278` `if (typeof runBranch !== 'string' || runBranch.length === 0) { return … 'branch-unresolved' }`.
- "Keep lane work and host publication as separate lifecycle stages" / "The cost of worker-path publishing is a lane writing to the host remote" — `:262-265`, plus the module header at `scripts/factory/ci-watch.mjs:6`.
- Five `Status: … unbacked …` markers (`:4,8,11,35,38,41,51`) all resolve to `skills/devops/references/evidence.md:28-42`.
- `git push origin --delete` is a real invocation (`git push --help` → `-d, --delete`), and no implementation of it exists here (grep).

---

### `skills/devops/references/processes.md` — 20 checkable claims · 17 true · 3 stale · 0 false

**STALE**

> `processes.md:33-34` — "A missing root is a refusal, not an empty proof of cleanliness. Exhibit: `scripts/factory/reap-stale.mjs:257`."
Evidence: `:257` is the `USAGE` constant. The missing-root refusal is at `:265-268` — `if (!d.existsSync(root)) { d.stderr(\`reap: no crew root at ${root} [reason: absent-root]\n\`); return 2 }`. (The *other* claim citing `:257`, `processes.md:49-50` "Keep the destructive flag visible in every human-facing reclaim instruction", is exactly right: `USAGE = 'usage: npm run crew:reap -- [--reclaim] [--dry-run] [--root <crew-root>] (default: dry run — nothing is signalled without --reclaim)'`.)

> `processes.md:42-44` — "An empty descendant list means no records were found, not that every process was inspected. Exhibit: `scripts/factory/reap-stale.mjs:105-107`."
Evidence: `:105-107` is the archived-dir comment tail plus `const dir = join(root, repo.name, task.name)`. The skip that produces an empty list is `:109` — `if (!d.existsSync(join(taskDir, DESCENDANT_DIR))) continue`.

> `processes.md:27-31` — "Archived lanes are swept rather than skipped / The archived set was the likely leak location (#473). Exhibit: `scripts/factory/reap-stale.mjs:105-107`."
Evidence: substance verified, anchor one line short at the head: the comment runs `:103-106` ("An archived dir is ENUMERATED, not excluded … the excluded dirs were exactly the ones most likely to hold a leak (#473)") and the enumeration itself is `:102` (`for (const task of tasks.filter((e) => e.isDirectory())…)`). Cited range starts inside the comment and ends on unrelated code.

**TRUE (compact)**
- "Offer a reclaim command; never kill … unasked" and "Boot refuses stale descendants and prints the command for a human to run" — `crew/crew.mjs:661-670` (`refuseStaleDescendants`), message at `:666`: "Reclaim them with `npm run crew:reap -- --reclaim`".
- `npm run crew:reap` exists — `package.json:21` `"crew:reap": "node scripts/factory/reap-stale.mjs"`.
- `--reclaim`, `--dry-run`, `--root`, `--help/-h` are the parsed flags — `scripts/factory/reap-stale.mjs:239-243`.
- "The sweep is dry-run by default until `--reclaim`" and "An explicit `--dry-run` wins even when `--reclaim` appears too" — `:251-253`, `flags.dryRun = explicitDryRun || !reclaim`, with the `#439` comment.
- `proven` / `failed` / `unproven` accounting, and "cannot be proven dead remains `unproven`" — `REAP_ACCOUNTING` at `:75`, comment `:71-74`.
- "`guardedKill` refuses absolute pid or pgid values 0 and 1" and "applies in both signal directions, including negative group ids" — `:58` `if (!Number.isSafeInteger(pid) || (pid < 0 ? -pid : pid) <= 1)`.
- "Three-state liveness preserves `null` for an unreadable pane" / "only observed `false` contributes to a dead verdict" — `crew/README.md:237-240`, verbatim: "**Liveness is three-state, deliberately.** `paneAlive()` returns `true`, `false`, or `null` — `null` meaning *indeterminate* … the wait loop counts only `false` toward its dead-seat verdict".
- The one `Status: … unbacked` marker (`:47`, kill-error edge) resolves to `evidence.md:56-63`.

---

### `skills/devops/references/worktrees.md` — 18 checkable claims · 14 true · 2 stale · 2 false

**FALSE**

> `worktrees.md:24-25` — "The common Git directory is shared by linked lanes. Exhibit: `crew/seat-io.mjs:1655`."
> `worktrees.md:27-28` — "Stash entries are consequently not isolated per worktree (#471). Exhibit: `crew/seat-io.mjs:1656`."

Evidence (one finding, two lines): `crew/seat-io.mjs:1655` is `if (raw === staleRaw) return null` and `:1656` is `return readEnvelopeFile(returnPath, { existsSync, readFileSync, role })` — both inside `readEnvelope`, about not re-reading a stale return file. Neither mentions git, the common dir, or the stash. The real exhibit is `crew/seat-io.mjs:1680-1682`: "`// The stash stack is NOT per-worktree: git rev-parse --git-path refs/stash`" / "`// resolves to the SAME file in the common git dir from every linked worktree,`" / "`// so git stash pop restores whatever lane pushed LAST (#471).`" — with the enforcement at `:1695-1698` (refusing to restore a stash entry that is not provably ours). An agent sent to `:1655` to understand the `#471` hazard reads a completely different mechanism and cannot verify the rule.

**STALE**

> `worktrees.md:30-31` — "Use `git worktree remove` for teardown so Git unregisters the worktree. Exhibit: `skills/qa-test-writing/references/tooling.md:65-66`."
Evidence: the anchor is exact (`tooling.md:65-66`: "A detached worktree **shares the object store and must be removed** with `git worktree remove` — you cannot simply `rm -rf` it and forget."), and `git worktree remove` is a real subcommand (`git worktree --help` → `git worktree remove [-f] <worktree>`). Stale only in that this "teardown" is the qa scratch-worktree procedure, while the two crew teardown paths this skill also documents do something else entirely — `crew/crew.mjs:2085-2086` renames the state dir to `.archive-<iso>`, and `crew/arms.test.mjs:331` asserts arms never issues `remove`. Nothing in the crew lifecycle unregisters a worktree.

> `worktrees.md:47-48` — "An unknown Git probe is not permission to remove a checkout. Status: this fail-closed removal rule is unbacked here."
Evidence: honestly marked and resolves to `evidence.md:44-53` — but note the probe it describes fails **open**, not closed: `scripts/factory/ci-watch.mjs:240-242` sets `linked = false` on a thrown `rev-parse`, so an unknown probe reads as "not linked". The reference states the desired rule without noting that the local probe contradicts it.

**TRUE (compact)**
- "Create a lane through Git's worktree registry" / "The creation command is `git worktree add -b` with an explicit branch and path" — `crew/arms.mjs:670-672`; flag confirmed by `git worktree --help` (`(-b | -B) <new-branch>`).
- "Refuse an existing target before asking Git to create it" — `crew/arms.mjs:657-661` (`d.existsSync(plan.dir)` → `spawnRefusal('worktree-exists', …)`), with fail-closed `catch { exists = true }` at `:659`.
- "A linked worktree's `.git` is a file, not a directory" / "A directory-only `.git` search therefore finds primary checkouts only" — `scripts/pr-review-window.sh:61-62` ("Linked worktrees have a .git *file*, so `-type d` naturally skips them and only finds primary checkouts"), and the `find … -type d -name .git` it describes is at `:73`.
- "Probe linked status by comparing `--git-dir` with `--git-common-dir`" / "Different values identify a linked checkout" — `scripts/factory/ci-watch.mjs:237,239`.
- "A completed run may auto-teardown its workspace" — `crew/crew.mjs:1879` (comment) and `:1885-1888` (code).
- "An escalated run retains its workspace as human-readable context" — `crew/crew.mjs:1881-1882`.
- "Do not reproduce the node_modules symlink recipe here. Exhibit/pointer: `skills/qa-test-writing/references/tooling.md:13-16`" — exact (that is the symlink trap paragraph).
- "An interrupted `git worktree add` needs its partial result inspected" — `crew/arms.mjs:673-679` (`spawnPartial({… phase: 'worktree', reason: 'worktree-failed' …})`).

---

### `skills/pr-review/SKILL.md` — 26 checkable claims · 23 true · 1 stale · 2 false

**FALSE**

> `skills/pr-review/SKILL.md:53` — "| 9 | stale comments, docs, charters | F12 | **0 must-fix in 23** |"
Evidence: the register carries no "23" for that class. F12 (`/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md:222-228`) lists five disjointly-labelled instruments: "location is a `.md`/README file: **0 must-fix in 16**", "summary is about a stale comment/prose claim: **0 must-fix in 7**", "explicitly carried forward from a prior round: **0 must-fix in 10**", "classifier `stale-prose` + `out-of-plan`: **0 must-fix in 23**", "`docs/` + `docs/adr/`: **0 must-fix in 8**". The 23 is `stale-prose` (18) **plus `out-of-plan` (5)** — and the 5 out-of-plan is already row 8 of the same table (`SKILL.md:52`), so the table double-counts its own row and relabels the result as "docs, charters". The skill's own reference gets this right (`references/rubric.md:59-61` uses 16 / 7 / 10), so SKILL.md and rubric.md disagree.

> `skills/pr-review/SKILL.md:33` — "**Two reviewers disagreeing on the same line is itself a finding**; record both positions and resolve it using `references/divergence.md`."
Evidence: as written, and as `references/divergence.md:14-25` renders it, this instructs the reviewer to record a divergence in the **scout** shape (`claim` / `evidence` / `confidence`). The runtime rejects that: on a panel round the driver requires the *reviewer* shape from both reviewers — `crew/drive.mjs:2764-2766` ("Report typed findings in details.findings (id, severity …, location …, summary)") — fuses them on file+overlapping-line-range (`crew/escalation-policy.mjs:73-79 findingsMatch`), and takes the adjudicator's verdict in a third shape, `crew/drive.mjs:2821`: `{"adjudications":[{"id":"<divergence id>","disposition":"uphold"|"dismiss","reason":"..."}],"class_invariant":"...","closes_class":true|false}`. A finding submitted with `claim`/`evidence`/`confidence` keys carries none of `id`/`severity`/`location`, so `findingEntry` drops it and `fuseFindings` never sees it. This also collides with the skill's own rule at `references/findings-shape.md:28`, "Never fill one shape with the other's keys."

**STALE**

> `skills/pr-review/SKILL.md:13-15` — "The plugin skill is the knowledge layer; the existing `.agents/skills/review-procedure` skill is the procedure layer and remains the place that runs the review flow."
Evidence: the path exists (`.agents/skills/review-procedure/`), and `crew/roles/reviewer.md:30-31` does route through it ("load the do-not-flag guidelines (`crew/guidelines/review-do-not-flag.md`, via the `review-procedure` skill)"). Stale in that the split is now three-way, not two: since `842ea51` (2026-08-15) the **driver** runs the panel review flow in code (`crew/drive.mjs:2758-2900`, `crew/drive.mjs:3151`), so "the place that runs the review flow" is no longer only the procedure skill.

**TRUE (compact)** — every rubric number in `SKILL.md:45-54` was re-derived against the preserved register:
- 74% must-fix (95 of 129) vs 20% (25 of 125) — register F10 table (`findings.md:186-190`).
- 60% (30 of 50) indeterminate-as-definite; 63% (20 of 32) lifecycle-clobber; 77% (10 of 13) degraded-path; 57% (12 of 21) input-boundary; 71% (10 of 14) render-join; 24% (11 of 46) false-green; 0 must-fix in 5 out-of-plan — register F9 table (`findings.md:159-170`), all exact including the ordering by must-fix share.
- 0 must-fix in 10 carried-forward — F12 (`findings.md:226`).
- Routing table's five reference files all exist; key-references list matches.
- "`confidence` is mandatory on every finding" — `crew/pi/agents/scout.json` prompt: "`confidence` is not optional, because a finding nobody marked is a finding nobody can trust".
- "the reviewer envelope's finding is a different object, `{id, severity, location, summary}`, at `crew/roles/reviewer.md:37-42` and optional at `crew/roles/reviewer.md:49`" — both anchors exact (`:39-42` is the `findings` array shape; `:49` is "`findings` is optional: omit it and the run behaves exactly as before.").
- "The gate is a floor and review is the filter (F6, F19)" — F6 `findings.md:112-113` (65 of 188), F19 `findings.md:327` (`gate:r1` 203 rows / 196 pass).

---

### `skills/pr-review/references/rubric.md` — 24 checkable claims · 24 true · 0 stale · 0 false

Every measured number in this file reproduces the preserved register exactly. Compact list:
- 95 of 129 / 74%, 25 of 125 / 20% — F10, `findings.md:186-190`.
- must-fix median **143** characters (n=120), consider median **273** (n=83) — F11, `findings.md:212-215`.
- 60% (30 of 50), 63% (20 of 32), 77% (10 of 13), 57% (12 of 21), 71% (10 of 14) — F9, `findings.md:159-168`; the file's ordering matches the register's ordering.
- "acceptance gate is green on 196 of 203 first build rounds (F19)" — `findings.md:327` (`gate:r1` | 203 | 196 | 7).
- "a reviewer finds a must-fix in 65 of 188 green-gate runs (F6)" — `findings.md:112-113`.
- "140 of 269 reviews correctly find nothing (F5)" — `findings.md:102-104` ("over the 269 envelopes that carry a `details.findings` array … 140 (52%) carry an empty array … All 140 are `pass`").
- "no `contract-drift` category … nearest instrument is `contract-literal`, with 4 must-fix of 7 (F9)" — `findings.md:165`.
- vacuity: "46 of 254 findings (18%)", "19 of 51 should-fixes", "24% (11 of 46)", "47% corpus baseline (120 of 254)", "28% (7 of 25)" — F13 `findings.md:236-239` and F8 severity counts `findings.md:150-151` (must-fix 120, should-fix 51, consider 83).
- scope: "0 must-fix in 5 (F12)", "25% (5 of 20) (F10)", "0 must-fix in 16", "0 of 7", "0 of 10" — `findings.md:168`, `findings.md:200`, `findings.md:223-227`.
- `crew/roles/reviewer.md:14` for "Out-of-plan edits are findings" — exact ("nothing else? Out-of-plan edits are findings even when harmless."); the register cites the same anchor at `findings.md:230`.
- The worked contract-drift instance (`rubric.md:34-36`) is real: `crew/pi/agents/scout.json` exists, `references/findings-shape.md` restates it, and `skills/pr-review/findings-shape.test.mjs:54-70` holds both against literals it declares itself (`TOP_KEYS`, `FINDING_KEYS`, `CONFIDENCE_ENUM`, `MANDATORY`, `CLOSED`).
- `crew/guidelines/review-do-not-flag.md` exists and does own the out-of-scope-remedy judgment — `review-do-not-flag.md:42-46`.

### `skills/pr-review/references/findings-shape.md` — 12 checkable claims · 12 true · 0 stale · 0 false

- "The findings definition is `crew/pi/agents/scout.json`" — file exists (1639 bytes); its `prompt` carries the block verbatim.
- Pin named — `skills/pr-review/findings-shape.test.mjs` exists and passes (4/4).
- Top keys `summary` / `findings` / `gaps`, finding keys `claim` / `evidence` / `confidence`, enum `"verified" | "assumed"`, "`confidence` is not optional", "No other keys are permitted" — all five present in the scout prompt and asserted at `findings-shape.test.mjs:56-60` and `:65-69`.
- "its enum bar is deliberate and means this illustrative block is not valid JSON" — true, and the test tolerates it: `findings-shape.test.mjs:84` `try { parsed = JSON.parse(match[1]) } catch { continue }`.
- Reviewer-envelope contrast (`:26-30`) — `crew/roles/reviewer.md:37-42` and `:49`, both exact.

### `skills/pr-review/references/divergence.md` — 9 checkable claims · 6 true · 1 stale · 2 false

**FALSE**

> `divergence.md:28-29` — "Nothing in the corpus records two reviewers on one line."
Evidence: true of the b152 *corpus*, but false of this checkout, which is what an agent will act in. `crew/drive.mjs:2800-2805` fuses two reviewers' typed findings and emits `structuredDivergences` with `{id, source, severity, location, summary}`; `crew/escalation-policy.mjs:73-79` matches them on same file with **overlapping line ranges**, so two reviewers on one line is exactly the object the code produces. Dismissed divergences are recorded as dissents with `kind: 'panel-divergence'` (`crew/drive.mjs:2859-2872`) into `S.dissents` (`crew/drive.mjs:1478`, surfaced in the envelope at `crew/drive.mjs:3245`). Read as "the mechanism does not exist", this sends an agent to invent a record the driver already writes.

> `divergence.md:14-25` — the JSON example recording a divergence in the scout shape.
Evidence: same finding as `SKILL.md:33` above — the panel path requires `details.findings` with `{id, severity, location, summary}` (`crew/drive.mjs:2764-2766`) and the adjudicator envelope shape at `crew/drive.mjs:2821`. The example is also self-contradictory with `findings-shape.md:28` ("Never fill one shape with the other's keys"), since a divergence is a reviewer artifact, not a scout answer. Note the tripwire actively *blesses* this example: `findings-shape.test.mjs:77-96` validates it as a conforming worked example of the scout shape.

**STALE**

> `divergence.md:30-31` — "the only re-adjudication record is `accept_decisions` with **8 rows** (F24)."
Evidence: the 8 rows are confirmed (`findings.md:405-424`, "All 8 rows, every recorded column"), but "the only re-adjudication record" no longer holds: `adjudicatePanel` (`crew/escalation-policy.mjs:128`) plus the `dissents[]` array on every driver envelope (`crew/drive.mjs:1779`, `:2072`, `:3245`) are a second, structurally richer re-adjudication record.

**TRUE (compact)**
- "the two questions the charter separates at `crew/roles/reviewer.md:12-18`" — exact: `:12` "Judge two separate questions, in order:", `:13` CONFORMANCE, `:15` CORRECTNESS.
- "Attribution is present on **64 of 274** review rows and only from 2026-08-20 (F26)" — `findings.md:449` ("Review attribution: 64 of 274 rows carry an agent, 34 carry a provider") and `:462` ("all post-08-20").
- Confidence semantics (`assumed` for inferred, `verified` after re-reading) match `crew/pi/agents/scout.json`.
- Example evidence anchors are real lines in a scope-matcher context: `crew/drive.mjs:1388` is `export function scopeMatcher(entries) {` and `:2040` is inside the empty-scope gate (`const outOfScope = outOfScopeFiles(io.changedFiles(), scopeMatcher([]))`).
- Cross-reference to `references/evidence.md` resolves (`evidence.md:28-29`).

### `skills/pr-review/references/posture.md` — 8 checkable claims · 4 true · 1 stale · 3 false

**FALSE**

> `posture.md:5-7` — "That panel flow is **parked**: its trigger is the **verdict-fusion** capability existing, and this file is the panel's knowledge layer, **not its implementation**. Do not describe a parked capability as if it had already run."
Evidence: the panel flow is implemented and wired. `crew/drive.mjs:2758` `const panelReview = (n, panel) => {…}`; two independent reviewers briefed at `:2768` and `:2781` (`assignAndWait('reviewer', …)`, `assignAndWait(panel.partner, …)`); fusion at `:2800` via `fuseFindings` (`crew/escalation-policy.mjs:81`); adjudication at `:2827` via `adjudicatePanel` (`crew/escalation-policy.mjs:128`); seat selection at `crew/drive.mjs:311-319` `panelSeats`; invoked at `crew/drive.mjs:3151` — `const review = panel ? panelReview(roundNo, panel) : assignAndWait('reviewer', revBrief, 'review')`. Shipped in `842ea51 feat(crew): fuse a blind cross-vendor review panel on the regrant rung`, **2026-08-15**, before this skill was written. Separately, no capability named `verdict-fusion` exists anywhere in the tree (`grep -rni fusion` → only `crew/drive.mjs:2381`, `:2876` comments and this skill), so the stated trigger cannot be evaluated at all.

> `posture.md:3` — "A write surface touching the **protected floor** boots the lane at the **judge** tier… **Judge-tier and protected-floor changes use more than one independent reviewer**."
Evidence: the panel is gated on continuation, not on tier or protected scope — `crew/drive.mjs:2950`: `const panel = ctx.continuation === true ? panelSeats(seatList) : null`. A protected-floor hit does something different: it demands the judge tier's reviewer **cell** at plan-accept and escalates if it cannot seat it — `crew/drive.mjs:2371-2378` (`const floorHits = protectedHits(scopeFiles, ctx.protectedPaths)` … `escalate('sensitivity-floor', …)`). A judge-tier lane that is not a continuation gets exactly one reviewer.

> `posture.md:8` (same sentence as above) — "and record any disagreement according to `references/divergence.md`."
Evidence: the driver already records it, in its own shape — `crew/drive.mjs:2859-2872` (`kind: 'panel-divergence'`, `disposition: 'dismissed'`, `reason`), and demands `{"adjudications":[…],"class_invariant","closes_class"}` from the adjudicator (`crew/drive.mjs:2821`). Following `divergence.md` instead produces an artifact the driver cannot read.

**STALE**

> `posture.md:3` — "compute that before dispatch, never after."
Evidence: sound operator advice and consistent with `skills/crew-dispatch/references/tier.md:16-17`, but the mechanism named ("boots the lane at the judge tier") is only half the story in code: `crew/drive.mjs:2371-2378` evaluates the floor at **plan-accept**, and `sameFloorCell` short-circuits when the boot already seated the judge cell (described at `skills/crew-dispatch/references/tier.md:19-23`).

**TRUE (compact)**
- "the first review bounces **68 of 194** ledger lanes (F3), and **42 of those 68** pass at round 2" — `findings.md:71` and `:76` ("Of the **68** lanes that bounced at round 1, **42 (61.8%)** passed at round 2").
- "The acceptance gate is green on **196 of 203** first rounds (F19)" — `findings.md:327`.
- "One reviewer is the standing posture" — `crew/drive.mjs:3151` (single `assignAndWait('reviewer', …)` off the panel path).
- The protected-path constant exists — `crew/protected-paths.mjs:8` `export const PROTECTED_PATHS = Object.freeze([…])`, re-exported at `crew/drive.mjs:135`.

### `skills/pr-review/references/evidence.md` — 17 checkable claims · 15 true · 0 stale · 2 false

**FALSE**

> `evidence.md:30-31` — "**Panel posture — no exhibit:** the verdict-fusion flow is **parked and has never run**, so the tier-scaled panel is not measured."
Evidence: same as `posture.md:5-7` — implemented since `842ea51` (2026-08-15) at `crew/drive.mjs:2758-2900` / `crew/escalation-policy.mjs:81,128`, reached from `crew/drive.mjs:3151`. "Not measured *in the b152 corpus*" would be defensible; "parked and has never run" is a claim about the system, and it is wrong for the code and unverifiable for the runs (the register's corpus predates nothing — the panel shipped a week before the corpus was mined).

> `evidence.md:28-29` — "**Divergence-as-signal — no exhibit:** nothing in the corpus records two reviewers on one line; the rule is design guidance."
Evidence: as at `divergence.md:28`. The corpus half may stand; the framing "design guidance, no exhibit" is false against `crew/escalation-policy.mjs:73-79` + `crew/drive.mjs:2800-2805`, which is a working exhibit of exactly this object.

**TRUE (compact)** — the denominators are the strongest-verified block in either skill:
- Register path `/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md` exists (32,676 bytes, 2026-08-22). *Caveat, not a defect in the claim: it is an absolute path in the operator's home, outside the repo, so a shipped skill's evidence base is unreachable from any other machine.*
- **274** `review_outcomes` rows, **278** JSONL records, **339** reviewer envelopes, **254** extracted findings, **227** disk lanes — `findings.md:18-23` (F0 corpus table) and `:79`.
- **228** lanes — `findings.md:138`.
- **194** ledger lanes — `findings.md:35` ("only **194** have any `review_outcomes` row").
- **1,879** `gate_results` rows — `findings.md:319`, corroborated at `:347`.
- "`must_fix ≥ 1 ⟺ changes-needed` holds on **273 of 274** rows (F2)" — `findings.md:59`.
- "**92 of 124** `changes-needed` envelopes (F8)" — `findings.md:146`.
- "**94 of 254** findings match more than one category and **48** match none (F9)" — `findings.md:172`.
- "The ledger cannot name a finding's kind (F7, F20)" — `findings.md:18-21` (the two "can it name a finding's *kind*?" = **no** rows) and F20 at `:346-347` ("`violations_json` is the literal string `[]` on **all 1,879 rows**").
- F28's confound, quoted faithfully — `findings.md:502-508`.
- "**Contract drift as an axis — no exhibit:** … `contract-literal`, **4 must-fix of 7** (F9)" — `findings.md:165`.
- "**A second reviewer buys the most where the gate is quietest — no exhibit**" — correctly marked; the register has no panel comparison (F6 is a gate-vs-review gap, `findings.md:108-113`).

---

## Format compliance

Rules judged as ratified in epic #497: R1 description = trigger surface; R2 routing table up front; R3 critical rules as imperatives carrying the reason AND a named exception; R4 progressive disclosure; R5 posture declared; R6 boundary (optional orchestrator procedure, not always-on seat behaviour; seats boot `--no-skills`).

### `skills/devops/SKILL.md`

| rule | verdict | line | justification |
|---|---|---|---|
| R1 | **pass** | `:3-10` | Nine trigger surfaces enumerated as intents ("creating or removing a Git worktree… invoking `gh`… publishing from a checkout… investigating stray processes… reclaiming an orphan… operating the crew daemon… choosing dry-run versus reclaim… recording an operational rule whose checkout has no local exhibit"). Gap worth noting, not a fail: `factoryctl` — the actual operator client for the daemon (`crew/README.md:222-226`, `crew/factoryctl.mjs`) — appears in no description, routing row or reference, though "operating the crew daemon" routes readers to `daemon.md`, which documents only the socket verbs. |
| R2 | **pass** | `:16-25` | Routing table is the first section after a two-line preamble; six rows, each `intent → rule → references/<file>.md`, and all six files exist. |
| R3 | **fail** | `:27-34` | The six rules are imperatives and each carries its reason as an explicit `Cost:` clause (e.g. `:29` "Cost: deleting a directory alone leaves Git's registration behind."), which is the R3 reason half done well. **No rule carries a named exception.** The nearest is `:33` "Offer a reclaim command but never kill or signal unasked" — an unconditional never. The "Never X, with one exception: Y — because Z" shape appears nowhere in the file. |
| R4 | **pass** | `:1-43` | SKILL.md is 43 lines; depth is in six references of 55-85 lines. The critical-rules block does restate each reference's headline (see Overlap), but the SKILL never carries a procedure. |
| R5 | **pass (weak)** | `:13-14` | "Every rule here is a measured lifecycle boundary. The references separate safe mechanics from rules whose evidence is explicitly absent in this checkout." Measurement-first posture is declared in substance and operationalised by `references/evidence.md`; the ratified vocabulary ("retrieval-first" / "measurement-first") is never used, so a reader must infer the label. |
| R6 | **fail** | — (no line) | Nothing in `SKILL.md` or any reference states that the skill is an optional orchestrator-session procedure, or that seats boot `--no-skills`. Verified as a real boundary the doc omits: `crew/adapters/adapter-pi.mjs:253` `...(skills.length ? skills.flatMap((skill) => ['--skill', …]) : ['--no-skills'])`, with the comment at `:187` "`--no-skills` is the matching closed posture when no skill is granted", and `crew/headless-rpc.mjs:84` `'--no-context-files', '--no-extensions', '--no-skills'`. Family-wide gap: `skills/crew-dispatch/SKILL.md` and `skills/crew-recovery/SKILL.md` omit it too. |

### `skills/pr-review/SKILL.md`

| rule | verdict | line | justification |
|---|---|---|---|
| R1 | **pass (weak)** | `:3-6` | "reviewing a change for correctness, contract drift, vacuity and scope, the typed findings shape, and divergence… deciding findings, grades, or reviewer posture" — covers five of the six intents the body serves. Two loadable intents are absent from the trigger surface: **gate triage** (`crew/roles/reviewer.md:53-62`, a review-seat assignment with its own closed enum `{"defect": "build"|"gate"}`) and **sizing a claim / naming a denominator**, which is a routing row (`:25`) but not a description trigger. |
| R2 | **pass** | `:19-25` | Routing table is up front (after a 5-line framing paragraph); five rows, `intent → references/<file>.md → rule`; all five files exist. Column order is inverted relative to `devops` (Read before Rule) — cosmetic, but the two skills in one family disagree. |
| R3 | **fail** | `:29-39` | Rules are imperative and reasoned (`:34-35` "Never report a rate without its denominator. A measured yield is a claim about the corpus and its denominator" — reason attached), but no rule carries a named exception. `:29-31` offers an alternative grade ("or grade it a consider"), not an exception. The one exception-shaped clause in the whole skill is in a reference and is also unconditional: `references/findings-shape.md:28` "Never fill one shape with the other's keys." |
| R4 | **fail** | `:41-54` | The SKILL is 62 lines and **13 of them are a 10-row rubric table that duplicates `references/rubric.md` wholesale** — every exhibit id and every measured number appears in both, and where they diverge the SKILL is the wrong one (`:53`, the "0 must-fix in 23" false claim). Progressive disclosure is defeated: a reader who loads only SKILL.md gets the entire yield ordering, so `rubric.md` is only reachable for prose. |
| R5 | **pass** | `:11-13` | "This skill is **measured, not asserted**: every ordering rule cites its exhibit from the b152 register, and rules without an exhibit are listed as such in `references/evidence.md`." Explicit measurement-first declaration, and `references/posture.md` + `references/evidence.md` implement it. |
| R6 | **partial → fail** | `:13-15` | A layering boundary *is* declared — "The plugin skill is the knowledge layer; the existing `.agents/skills/review-procedure` skill is the procedure layer" — which is more than `devops` does. But the R6 boundary proper (optional orchestrator procedure; seats boot `--no-skills`) is never stated, and the file it names as the procedure layer is loaded **by a seat** (`crew/roles/reviewer.md:30-31`), which is precisely the always-on-seat-behaviour confusion R6 exists to prevent. Marked fail on the ratified rule, with credit for the half that is present. |

---

## Contradictions

### 1. The two `references/evidence.md` files are different genres under one filename

Compared line by line, they share only the word "evidence".

- `skills/devops/references/evidence.md:1-4`: "This register separates local exhibits from operator measurements and negative repository searches." → a **negative-search log**: what was grepped, what was found, and the boundary of the claim (`:82` "Unknown, empty, or interrupted searches stay indeterminate until rerun.", `:84-85` "This register records what was searched, what was found, and the boundary of the claim.").
- `skills/pr-review/references/evidence.md:8-12`: "The evidence register is `/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md`. F0 records the corpus and its denominators…" → a **denominator table** frozen against a file outside the repo.

Concrete divergence in instruction for the same situation — *what do I do when the evidence is absent?*
- devops: mark it inline at the point of use and re-run the search. `gh.md:4` "Status: this path rule is unbacked in the checkout; see `evidence.md`." (that marker is repeated 8× in `gh.md`, 7× in `lane-branches.md`, 1× in `processes.md`, 1× in `worktrees.md`), plus `evidence.md:82` "stay indeterminate **until rerun**".
- pr-review: list it once in `evidence.md`'s "Rules with no exhibit" (`:26-35`) and otherwise keep using the rule. There is no re-measure instruction anywhere in the skill, and the register it depends on is machine-local and immutable.

An agent that loads both skills gets two incompatible conventions for annotating an unbacked rule. Recommended single rule: keep devops's inline `Status:` marker (it survives the reference being read alone) and adopt pr-review's requirement that the register name its denominator.

### 2. Divergence recording: scout shape vs reviewer envelope vs the driver's adjudication shape

- `skills/pr-review/references/divergence.md:14-25` records a divergence with keys `claim` / `evidence` / `confidence`.
- `skills/pr-review/references/findings-shape.md:28-30`: "**Never fill one shape with the other's keys.** The scout shape is for one narrow, cited answer; the reviewer shape is the optional finding entry in a review envelope."
- `crew/roles/reviewer.md:39-42`: `"findings": [ { "id": …, "severity": "must-fix"|"should-fix"|"consider", "location": "<file:line>", "summary": … } ]`.
- `crew/drive.mjs:2821`: `'{"adjudications":[{"id":"<divergence id>","disposition":"uphold"|"dismiss","reason":"..."}],"class_invariant":"...","closes_class":true|false}'`.

Three shapes, and the skill teaches the one the runtime cannot consume for this purpose.

### 3. "Parked panel" vs a panel that ships

- `skills/pr-review/references/posture.md:5-7`: "That panel flow is **parked**: its trigger is the **verdict-fusion** capability existing, and this file is the panel's knowledge layer, not its implementation."
- `crew/drive.mjs:3151`: `const review = panel ? panelReview(roundNo, panel) : assignAndWait('reviewer', revBrief, 'review')`, with `crew/drive.mjs:2950` `const panel = ctx.continuation === true ? panelSeats(seatList) : null`.

Also a trigger contradiction: `posture.md:3` ties the second reviewer to **judge tier / protected floor**, while the code ties it to **continuation rounds** (`crew/drive.mjs:2950`), and the protected floor instead upgrades the reviewer cell (`crew/drive.mjs:2371-2378`). Sibling skill agrees with the code, not with posture.md: `skills/crew-dispatch/references/tier.md:3-6` "The protected-path floor is evaluated from the planner's declared `files_in_scope` at `plan-accept`… A protected hit is therefore a **seating requirement**, not a post-hoc review label."

### 4. `rubric.md` restates a guideline that declares itself un-restatable

- `crew/guidelines/review-do-not-flag.md:3-4`: "Repo-owned judgment data. The reviewer's procedure loads this file; the charter names it and **does not restate it**."
- `skills/pr-review/references/rubric.md:63-65`: "A remedy needing a file outside `files_in_scope` can only produce a scope bounce, so it is a consider; cite `crew/guidelines/review-do-not-flag.md` as the owner of that judgment **rather than restating its entries**."

The sentence restates entry 5 of the guideline (`review-do-not-flag.md:42-46` "A remedy that cannot be built in this slice… Write it as a `consider` naming the deferred work.") in the same breath as telling the reader not to. The guideline is also the live one — its defense cites `crew/drive.mjs:1663-1673`, and the scope gate is real (`crew/drive.mjs:2040` uses `scopeMatcher`) — so the duplicate can drift without any test noticing.

### 5. Worktree teardown vs crew teardown

- `skills/devops/SKILL.md:29`: "remove them with `git worktree remove`, and gate teardown on the run outcome. Exhibit: `crew/arms.mjs:661` and `crew/crew.mjs:1879`."
- `skills/crew-recovery/references/closeout.md:26-31`: "`node crew/crew.mjs teardown --task <slug> --checkout <dir>` … Teardown archives by renaming the state directory to `${paths.dir}.archive-${iso}`."

devops binds "teardown" to a git operation the repo never performs; crew-recovery binds it to the rename the repo does perform (`crew/crew.mjs:2085-2086`). One word, two referents, and devops's version cites the crew-recovery mechanism as its exhibit.

### 6. Lane-branch deletion is owned twice

- `skills/devops/references/lane-branches.md:3-4`: "Never run `git push origin --delete` on a lane branch while its PR is open. Status: the open-PR deletion rule is unbacked here."
- `skills/crew-dispatch/references/worktree.md:53-54`: "Never delete the lane branch while its PR is open; the branch remains the review and recovery handle until the PR is merged or explicitly closed."

Not a conflict in substance, but crew-dispatch states it as settled while devops ships it as explicitly unbacked. Two skills, two epistemic statuses for one rule.

---

## Overlap

| duplicated prose | where it lives | proposed single home |
|---|---|---|
| The nine daemon verbs and the socket/pidfile/default-root paragraph | `skills/devops/references/daemon.md:3-35` ≈ `crew/README.md:216` (which lists the same nine verbs in the same order and both paths) | `crew/README.md:216` is the code-adjacent original; `daemon.md` should keep only the *operator* rules (ping ≠ outcome, state ≠ result, absent socket ≠ ping) and cite README + `crew/daemon.mjs:113`. The exhibit test already pins the verb list to source, so the restatement earns nothing. |
| Three-state liveness ("`null` is unknown; only observed `false` counts") | `skills/devops/references/processes.md:36-40` · `skills/crew-recovery/references/liveness.md:3-5,26-27` · `crew/README.md:237-240` | `skills/crew-recovery/references/liveness.md` — that skill owns seat liveness end-to-end (status vs pane vs journal recency). devops should cite it and keep only reap accounting. |
| Worktree creation recipe (`git worktree add -b <branch> <path>`) | `skills/devops/references/worktrees.md:3-9` · `skills/crew-dispatch/references/worktree.md:3-9` (with the runnable two-line recipe) | `skills/crew-dispatch/references/worktree.md` — it is the dispatch-time act and already carries the runnable form. devops keeps registration/removal consequences only, which is what `worktrees.md:33-39` already promises ("The sibling reference owns scratch-worktree mechanics; this file owns the lifecycle consequences") — the promise just is not kept for creation. |
| "Never delete the lane branch while its PR is open" | `skills/devops/references/lane-branches.md:3-11` · `skills/crew-dispatch/references/worktree.md:53-54` | `skills/devops/references/lane-branches.md` (it owns publication boundaries); crew-dispatch should link. |
| The `node_modules` symlink trap | `skills/qa-test-writing/references/tooling.md:13-16` · `skills/crew-dispatch/references/worktree.md:17-41` (fully reproduced, with both measured arms) | `skills/qa-test-writing/references/tooling.md` — and note `skills/devops/references/worktrees.md:36-37` explicitly declines to reproduce it and points at the qa file, which is the right pattern; crew-dispatch is the one that broke it. |
| Per-line `Status: this rule is unbacked in the checkout; see evidence.md` | 17 occurrences across `gh.md` (8), `lane-branches.md` (7), `processes.md` (1), `worktrees.md` (1) | Keep one marker per *rule cluster* (i.e. per `evidence.md` section) rather than per sentence; `gh.md` currently spends 8 of its 59 lines on the same sentence. |
| The pr-review rubric ordering table (all 10 rows, all exhibits, all numbers) | `skills/pr-review/SKILL.md:41-54` · `skills/pr-review/references/rubric.md:5-61` | `references/rubric.md`. SKILL.md should carry the ordered *names* only. This duplicate is where the one false number lives (`SKILL.md:53` vs `rubric.md:59-61`), which is exactly the failure mode duplication predicts. |
| The scout-vs-reviewer shape contrast, verbatim twice | `skills/pr-review/SKILL.md:36-39` · `skills/pr-review/references/findings-shape.md:26-30` (both quote `{id, severity, location, summary}` and both cite `crew/roles/reviewer.md:37-42` + `:49`) | `references/findings-shape.md` — it is the pinned document; SKILL.md should say "`confidence` is mandatory; the reviewer envelope's finding is a different object — see `references/findings-shape.md`". |
| Divergence-as-signal statement | `skills/pr-review/SKILL.md:32-33` · `references/divergence.md:1-6` | `references/divergence.md`. |
| Out-of-scope remedy → consider | `skills/pr-review/references/rubric.md:63-65` · `crew/guidelines/review-do-not-flag.md:42-46` | `crew/guidelines/review-do-not-flag.md` (repo-owned judgment data, per its own header). |
| Protected floor → judge tier | `skills/pr-review/references/posture.md:3` · `skills/crew-dispatch/SKILL.md:29` · `skills/crew-dispatch/references/tier.md:1-36` | `skills/crew-dispatch/references/tier.md` — it is accurate about plan-accept vs boot, `sameFloorCell`, and the `proposalTierAfterRaise` band limit; posture.md's version is the one that is wrong. |

---

## What the tripwire tests pin

### `skills/devops/exhibits.test.mjs` (70 lines, 4 tests, all passing)

**Pinned — drift is caught**
- The nine daemon verbs, by count and by name: `:17-22` parses `DAEMON_COMMANDS = Object.freeze([...])` out of `crew/daemon.mjs`, asserts `verbs.length === 9`, then requires `` `\`${verb}\`` `` to appear in `daemon.md`. Renaming or adding a verb in source turns the doc red. (Note: it does not assert the doc lacks a verb the source dropped — a removed verb leaves stale prose behind, since the loop iterates source verbs only.)
- The three reap accounting states, by exact array **order**: `:29-34`, `assert.deepEqual(states, ['proven','failed','unproven'])`, then each must appear backticked in `processes.md`.
- The three daemon path literals, at source level: `:41-43` asserts `join(homedir(), '.crew', 'daemon')`, `join(root, 'daemon.sock')`, `join(root, 'daemon.json')` still exist in `crew/daemon.mjs`, and `:45` that `daemon.md` names the three tokens. Moving the paths breaks the test.
- Anchor **existence and range**: `:50-69` walks `SKILL.md` + all six references, and for every `path:line` under `crew|scripts|test|docs|skills|visualizer|tasks|.github` asserts the file exists, is not a directory, and `1 ≤ line ≤ EOF`. Floor of 12 anchors (`:69`).

**Not pinned — drift is silent**
- **Whether an anchor points at the right line.** This is the single largest silent-drift surface, and it is where every stale/false verdict in the devops half lives: `crew/seat-io.mjs:1655` (envelope staleness cited for the stash hazard), `crew/daemon.mjs:371` for the socket (off by one), `crew/daemon.mjs:451` for journal writing, `crew/daemon.mjs:713` for empty-journal evidence, `crew/README.md:216` for state-vs-result, `scripts/factory/reap-stale.mjs:257` for the missing-root refusal, `scripts/factory/ci-watch.mjs:262` for two different refusals, `scripts/factory/intake.mjs:545` for `gh` unavailability. Every one of these passes the anchor test.
- **Whether the cited code supports the claim at all** — `intake.mjs:545` returns `null` for every failure mode, the opposite of the rule it exhibits.
- **Whether the rule exists in the repo**: nothing checks that `git worktree remove` (SKILL.md:29) is ever invoked, or that `--body-file` appears anywhere.
- **The evidence register's negative searches** — no test re-runs the `body-file` / `launchd` / branch-deletion greps, which is why `evidence.md:10-11`'s "zero hits" went stale the moment `commands/` landed.
- **All `Status: … unbacked` markers**, the routing table, the key-references list, and the `Cost:` clauses: pure prose.
- Anchors outside the eight allowlisted roots (`:55,60`) are skipped entirely — e.g. any future `~/…` or bare-filename citation.

### `skills/pr-review/findings-shape.test.mjs` (97 lines, 4 tests, all passing)

**Pinned — drift is caught**
- The scout contract from **both** sides against literals the test declares itself (`:15-19`): top-level key order `['summary','findings','gaps']` and finding key order `['claim','evidence','confidence']`, extracted at fixed brace depth (`keysAtDepth`, `:22-37`) from `crew/pi/agents/scout.json`'s `prompt` (`:54-61`) and from the fenced block in `references/findings-shape.md` (`:63-70`). Either side moving alone is red.
- Three literal strings on both sides: `'"verified" | "assumed"'`, `` '`confidence` is not optional' ``, `'No other keys are permitted'` (`:58-60`, `:67-69`). This is why `findings-shape.md:37` reads as it does — that sentence exists to satisfy `CLOSED` and `CONFIDENCE_ENUM`.
- The pin's own self-naming: `:72-75` requires the doc to name `crew/pi/agents/scout.json` and `skills/pr-review/findings-shape.test.mjs`.
- **Every parseable fenced JSON example across SKILL.md and all references** (`:77-96`): no key outside the contract, `summary` a string, finding keys exactly the three, `evidence` a non-empty array, `confidence` ∈ {verified, assumed}. At least one example required.

**Not pinned — drift is silent**
- **Every measured number.** All 40-odd rates and denominators in `rubric.md`, `posture.md`, `evidence.md` and `SKILL.md:45-54` are pure prose against a register **outside the repo** (`/Users/x/.dev-team/…`), so nothing here can go red — including the false `SKILL.md:53` "0 must-fix in 23", which contradicts `rubric.md:59-61` inside the same skill.
- **The reviewer envelope shape.** `{id, severity, location, summary}` and the `crew/roles/reviewer.md:37-42` / `:49` anchors are asserted by no test; there is no pr-review equivalent of the devops anchor-resolution test, so *no* `path:line` in this skill is checked to exist — `crew/drive.mjs:1388`, `:2040`, `crew/roles/reviewer.md:12-18`, `:14` are all unverified by CI.
- **Which shape belongs to which artifact.** `:77-96` validates the divergence example as *conforming*, so the test actively certifies the example this audit grades false: a reviewer-produced artifact written in the scout shape is exactly what the checker rewards.
- **Posture claims about the runtime** — "parked", "has never run", "verdict-fusion capability", "judge-tier changes use more than one reviewer": nothing compares them to `crew/drive.mjs` or `crew/escalation-policy.mjs`, which is why a 2026-08-15 feature could be documented as parked a week later without any signal.
- The routing tables, key-reference lists and critical-rule prose of both skills.
