# s3b-skills — per-document register: `skills/` and `commands/`

Read-only vertical inspection of every `.md` file under `skills/` and `commands/`,
read sequentially and in full by one seat (no fan-out). Every verdict below carries
the command or `file:line` that established it.

- **Checkout**: `/Users/x/Development/dt-s3-prose`, branch `audit-s3-prose`, HEAD `5a8d76a`
- **Documents**: `find skills commands -name '*.md' | wc -l` → **52** = 52 register rows below
- **Suite**: `FORCE_COLOR=0 npm test -- --test-reporter=tap` → `# pass 2171 / # fail 0`
- **Narrow lane** (brief's 19 files) → `# pass 1380 / # fail 0`
- **Checkout unchanged**: `git status --porcelain` → empty
- **Anchor resolution**: all **421** `file:line` anchors in the 52 documents resolve to an
  existing file and an in-range line (0 dangling) — script preserved at
  `queries/anchors.mjs`, raw output at `queries/anchors-resolved.txt`

Out of bounds per the brief: `crew/roles/`, `crew/guidelines/`, `crew/pi/agents/` (sibling scout).
Those trees are *read* here only where a skill anchors into them.

---

## 0. Headline

Nine claims are **false** — refuted by the checkout, not merely mis-anchored — and two
of them are refuted by prose sitting a few lines away in the same file. Two more are
**anchor clusters**: sixteen citations in `backend-node/references/import-firewall.md`
and `devops/` point at parser internals and an envelope reader rather than the
assertions and comments they name.

The reason none of this is red is itself the most important finding: the only
mechanical pin on these anchors
(`skills/backend-node/exhibits.test.mjs:49`, `skills/devops/exhibits.test.mjs:50`)
asserts `existsSync(target)` and `1 <= line <= lines.length` and **never compares the
anchored line's content to the prose**. That is exactly the failure shape
`skills/qa-test-writing/references/vacuity.md:75-90` names — "the detector's key is the
only guard" — applied to this repo's own documentation.

Against that, `skills/ui-design/references/tokens.md` and the `T2` leak inventory in
`state-colour.md` are the most accurate prose in the tree: 105 declarations, 55 unique
names, every raw token's line *and* hex value, and a 34-literal inventory that
reproduces per-file and per-literal on a fresh grep. Accuracy here is not uniform; it
is per-author.

---

## 1. FALSE — the claim is refuted by this checkout

Ranked first per the brief. Each carries the quote and the command or `file:line` that refutes it.

### F1 · `closed-enums.md` — the reference's headline exhibit is an enum nobody consults

`skills/backend-node/references/closed-enums.md:3-4`:
> "Declare a finite vocabulary as data that callers actually consult.
> Exhibit: `crew/drive.mjs:124`."

and `:9-13`:
> "The driver reads the set when it validates a decision. Exhibit: `crew/drive.mjs:137`.
> The data object, rather than a type comment, is what constrains runtime input."

**Refuted.** `grep -rn "DECISIONS" crew/ scripts/ test/ visualizer/ docs/`:

```
crew/drive.mjs:124:export const DECISIONS = Object.freeze(['bounce', 'accept', 'escalate'])
crew/drive.test.mjs:19    (import)
crew/drive.test.mjs:4073  test('DECISIONS and LIMITS are the frozen public contract')
crew/drive.test.mjs:4074  assert.ok(Object.isFrozen(DECISIONS) && Object.isFrozen(LIMITS))
crew/drive.test.mjs:4075  assert.deepEqual([...DECISIONS], ['bounce', 'accept', 'escalate'])
docs/adr/adr-030-acceptance-authorship.md:329
```

`DECISIONS` is declared, exported, and read by **no production code** — only by its own
test. It is the exact opposite of "data that callers actually consult". And
`crew/drive.mjs:137` is `// #251 — blueprint variants: a CLOSED enum of run shapes over
this one driver.` — a comment about `VARIANTS`, not a `DECISIONS` read.

A working exhibit exists and is not used: `CI_DECISIONS`
(`scripts/factory/ledger.mjs:165`) *is* consulted, at `scripts/factory/ledger.mjs:1834`
via `requireEnum(input.decision, CI_DECISIONS, …)`.

### F2 · `T1` is claimed 21/21 and refuted by `T3` in the same file

`skills/ui-design/references/contract.md:7`:
> "It must not name a raw `--ink-*`, `--paper-*`, `--spot-*`, role `-dark`/`-light`
> half, `--serious`, or `-raw` status token. A `var(--…)` census over the 21 components
> obeys T1 at **21/21**"

`skills/ui-design/SKILL.md:29` repeats it: "T1 (name only Tier-2 aliases) is obeyed 21/21".

**Refuted**, and refuted by `contract.md:15` eight lines later, which records the same
violation it denies:
> "T3 has one file-level violation … `visualizer/web/src/App.svelte:201–202` reads
> `--serious` for the rail"

Measured — `grep -n -- "--ink-\|--paper-\|--spot-\|-dark)\|-light)\|--serious\|-raw"` over
all 21 `.svelte` files returns exactly two hits:

```
App.svelte:201  .rail { … border:1px solid var(--serious); … }
App.svelte:202  .rail h2 { margin:0; color:var(--serious); }
```

`--serious` is on T1's own forbidden list. **T1 is 20/21, not 21/21.**

### F3 · the fence rules cite an issue about pi fan-out

`skills/crew-dispatch/SKILL.md:27` and `:31`:
> "Verify a fence through its consumers, not by reading the register alone (#145)."
> "Compile the fence register twice: first to discover coupled sources, then to
> acknowledge exactly them (#145)."

`gh issue view 145` → **"pi: fan-out discovery for the scout-commander charters"**,
CLOSED. Its body (`gh issue view 145 --json body`) is about `crew/adapters/adapter-pi.mjs:75-79`
having no subagent tool; two incidental occurrences of the word "fence" do not make it
the fence-compilation issue.

The likely intended reference is **#282** — "The brief compiler discovers the callers a
fence is about to break, then discards them" — or **#378**, "the fence machinery
validates shape but not sanity". Both found via
`gh issue list --search "coupled-source in:title,body" --state all`.

### F4 · the source-grep tripwire rule cites an issue about missing coverage

`skills/qa-test-writing/references/tripwires.md:26-29`:
> "When a change moves code between modules, declare the **source-grep** tripwires in
> `files_in_scope` … A test that greps for a symbol's location fails when the symbol
> relocates, even though behaviour is unchanged (#139)."

`gh issue view 139` → **"realIo has no test coverage: a ReferenceError on every pane
assignment passed a 314-test suite"**. Body opens "Found while shipping #138
(`briefFile is not defined` …)". Grepping its body and comments for
`source.grep|reloc[a-z]*|tripwire[a-z]*` returns **zero** matches. There is no PR #139
either (`gh pr view 139` → not found).

The *rule* is sound and is independently pinned by this repo's history; the citation is not.

### F5 · `onback` is passed 11 lines from where the doc says

`skills/frontend-svelte/references/components.md:13`:
> "`visualizer/web/src/App.svelte:124` passes `onback` to `RunDetail`."

`sed -n '124p' visualizer/web/src/App.svelte` → `<nav aria-label="Views">`.
The pass is at **`App.svelte:135`**:
`<RunDetail run={selectedRun} phase={route.phase} onback={backToFleet} />`.

### F6 · "four recessed sites", two named, two measured

`skills/ui-design/SKILL.md:38`:
> "Use `var(--bg)` for a surface recessed inside a panel … The four recessed sites are
> `visualizer/web/src/lib/IntakePanel.svelte:122` and
> `visualizer/web/src/lib/RosterPanel.svelte:187`"

Internally inconsistent (four, then a two-item list) *and* refuted by measurement.
`grep -l "var(--bg)"` over all 21 components returns exactly those two files;
`grep -c` returns **1 each — 2 sites in total**, not four.

### F7 · "the seven plain modules" — there are eight

`skills/frontend-svelte/references/structure.md:17` and `SKILL.md:20,37`:
> "Keep data acquisition, route parsing, drains, shaping, layout, and trace
> interpretation in the seven existing plain modules"

`ls visualizer/web/src/lib/*.js`:

```
api.js  drain.js  envelope-diff.js  fleet.js  panels.js  route.js  timeline.js  trace.js
```

**Eight.** `envelope-diff.js` (45 lines) is a plain deterministic module —
`const FIELDS = ['status','summary','artifacts','details']` plus a structural
comparator — added 2026-08-13 in `4287314` ("feat(visualizer): L2 — phase Gantt,
envelope inspector, filterable event stream"). It is absent from the seven-row table at
`structure.md:19-27`, so a lane told to keep deterministic logic "in the relevant plain
module" has no row for envelope diffing.

### F8 · the "inverse direction" exhibit is the refusal direction

`skills/backend-node/references/cli-flags.md:19-20`:
> "Pin the inverse direction so accepted window flags still work.
> Exhibit: `test/factory-ledger.test.mjs:2326`."

`sed -n '2326p'` → `test('#443: every window subcommand refuses the misspelled flag', …)`
— the refusal direction, i.e. the same direction as `:2318`. The accepted-flag
direction is at **`:2266`**: `const accepted = run(['run-set', '--since', …, '--until', …])`
followed by `assert.equal(accepted.status, 0)`. (The file cites `:2266` correctly at
`cli-flags.md:45,48` — so the reference contains both the right and the wrong anchor for
the same fact.)

### F9 · anchor cluster — every `crew/daemon.test.mjs` anchor in `import-firewall.md` misses

`skills/backend-node/references/import-firewall.md` carries 17 anchors, all into
`crew/daemon.test.mjs`. The real test is `IMPORT FIREWALL: daemon.mjs carries no
top-level import of the runner`, opening at **213**; lines 217-233 are its
import-*parser*; the assertions are at 238-242 and 246/248/250.

| doc site | claim | anchored line's actual content | correct anchor |
|---|---|---|---|
| `:4`, `:7`, `:22`, `:36`, `:39`, `:50`, `:60` and `backend-node/SKILL.md:31` | "the daemon import list … allowlist assertion" | `:221` = `const line = lines[i].trim()` | **238-242** (`assert.equal(imports.every(…))`) |
| `:10`, `:13`, `:26`, `:36`, `:47`, `:56` and `evidence.md:50` | "`crew/slug.mjs` must stay import-free" | `:228` = `if (j > i && isImportStart(lines[j].trim())) break` | **246** |
| `:16` | "`crew/escalation-policy.mjs` must stay import-free" | `:230` = `if (from) { imports.push(from[2]); … }` | **248** |
| `:19` | "`crew/variants.mjs` must stay import-free" | `:232` = `if (!found) imports.push(null)` | **250** |
| `:29`, `:53` | "Do not replace the leaves with a barrel import" / "protects daemon startup from accidental runner coupling" | `:195` = `function stageRpcSeat(f, role) {` | **213** (the test title) |
| `:32` | "also counts dynamic imports and keeps one computed adapter load" | `:238` = the allowlist `assert.equal(` | **219** (`isDynamicStart`) |

The prose *rules* are all true of the code; not one of the twelve line numbers points at
the thing named. Note also that the code's own comment at `crew/daemon.test.mjs:234`
says the allowlist "admits two first-party modules" while the assertion at `:239` admits
four (`./headless-rpc.mjs`, `./slug.mjs`, `./escalation-policy.mjs`, `./variants.mjs`) —
the skill's `import-firewall.md:6` ("a small first-party set") is the more accurate of the two.

### F10 · anchor cluster — the shared-git-dir/stash exhibits point at an envelope reader

| doc site | claim | `crew/seat-io.mjs` line cited | what is there |
|---|---|---|---|
| `devops/SKILL.md:30` | "Treat a linked checkout as shared Git state … Cost: a lane can restore another lane's stash entry (#471)" | `:1655` | `if (raw === staleRaw) return null` |
| `devops/references/worktrees.md:25` | "The common Git directory is shared by linked lanes." | `:1655` | same |
| `devops/references/worktrees.md:28` | "Stash entries are consequently not isolated per worktree (#471)." | `:1656` | `return readEnvelopeFile(returnPath, …)` |

Both lines sit inside `waitForEnvelope`'s changed-bytes `readEnvelope` closure. The real
exhibit — found with `grep -n "git-common-dir\|stash" crew/seat-io.mjs` — is
**`crew/seat-io.mjs:1680-1698`**:

```
1680  // The stash stack is NOT per-worktree: `git rev-parse --git-path refs/stash`
1682  // so `git stash pop` restores whatever lane pushed LAST (#471). The entry a
1686  const stashEntries = () => {
1687    const list = spawnSync('git', ['stash', 'list', '--format=%H %gs'], …)
1698    throw new Error(`runClean: refusing to restore a stash entry that is not provably ours …`)
```

`#471` is genuine and matches: *"runClean pops a stash stack shared by every worktree"* (CLOSED).

---

## 2. CONTRADICTIONS — two skills instructing differently for one situation

### C1 · `validateScopeEntries` — two skills, two incompatible call shapes, neither naming its module

There are **two exported functions with this name**:

| module | signature | on failure |
|---|---|---|
| `crew/drive.mjs:1250` | `validateScopeEntries(entries)` — an **array** | *returns* `[{entry, why}, …]` |
| `scripts/factory/make-brief.mjs:865` | `validateScopeEntries({ checkout, files = [] })` — an **object** | *throws* `BriefUsageError` |

`skills/crew-dispatch/references/fences.md:44-52` prescribes the array form and names
its module:
> "Run the same predicates the driver uses … `import { validateScopeEntries,
> SCOPE_DIR_MIN_SEGMENTS } from './crew/drive.mjs'; console.log({ errors:
> validateScopeEntries(['skills/crew-dispatch/']), … })`"

`skills/qa-test-writing/references/tripwires.md:40-49` prescribes the object form and
names **no module at all**:
> "Before dispatch, run the write surface through the code that will enforce it:
> `validateScopeEntries({ checkout, files })   // refuses unslashed directories`
> `const match = scopeMatcher(files)` … `protectedHitsIn(files, PROTECTED_PATHS)`"

That snippet mixes three functions from **two different modules** — `scopeMatcher` is
`crew/drive.mjs:1388` and `protectedHitsIn` is `crew/protected-paths.mjs:38`, while the
object-form `validateScopeEntries` is `make-brief.mjs`'s — and gives the reader no way
to know which import to write.

Measured both cross-applications:

```
$ node --input-type=module -e "import { validateScopeEntries } from './crew/drive.mjs';
    console.log(validateScopeEntries({ checkout: process.cwd(), files: ['crew/roles'] }))"
THREW: TypeError entries is not iterable

$ node --input-type=module -e "import { validateScopeEntries } from './scripts/factory/make-brief.mjs';
    console.log(validateScopeEntries(['crew/roles']))"
result: []                       ← SILENT: validates nothing, reports no error

$ node --input-type=module -e "import { validateScopeEntries } from './scripts/factory/make-brief.mjs';
    console.log(validateScopeEntries({ checkout: process.cwd(), files: ['crew/roles'] }))"
THREW: BriefUsageError  scope entry resolves to a directory and can only match with a
                        trailing slash: crew/roles (write "crew/roles/")
```

The dangerous arm is the silent one: `make-brief`'s destructuring defaults `files = []`,
so the array form returns `[]` and reads as "no scope errors" on a scope that is in fact
unslashed and empty-matching — the precise defect
`tripwires.md:31-38` warns about ("a lane then runs with a gate-green tree and an empty
write surface"). And `tripwires.md` is the file whose snippet an agent runs *before
dispatch*.

### C2 · `T1 21/21` versus `T3`'s recorded violation — inside one file
See **F2**. `skills/ui-design/references/contract.md:7` vs `:15`, with
`skills/ui-design/SKILL.md:29` propagating the wrong half.

### C3 · "four recessed sites" versus its own two-item list
See **F6**. `skills/ui-design/SKILL.md:38`.

### C4 · the hairline rule and its exhibits disagree on the property

`skills/ui-design/SKILL.md:39`:
> "Divide sibling rows with `border-top:1px solid var(--line)`, not an empty gap … exhibit
> `visualizer/web/src/lib/RunCard.svelte:59` and `visualizer/web/src/lib/FleetTable.svelte:31`."

Both anchored lines are the *chassis*, using `border:` not `border-top:`:

```
RunCard.svelte:59    .card { background:var(--panel); border:1px solid var(--line); … }
FleetTable.svelte:31 table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); }
```

`grep -n "border-top" lib/RunCard.svelte lib/FleetTable.svelte` puts the actual
`border-top:1px solid var(--line)` at **`RunCard.svelte:70`** and
**`FleetTable.svelte:32`** — one line past the cited anchor in the second case.

### C5 · `tooling.md` and `vacuity.md` publish a baseline the suite has outgrown
Not a disagreement between skills but between a skill and the tree; recorded here
because both files state it as *the* baseline. See **S16**.

Two apparent contradictions that are **not** contradictions, recorded so nobody re-spends them:

- `crew-dispatch/references/worktree.md:23-34` and `qa-test-writing/references/tooling.md:13-16`
  both cover the `node_modules` symlink trap. `devops/references/worktrees.md:36-37`
  explicitly defers ("Do not reproduce the node_modules symlink recipe here.
  Exhibit/pointer: `skills/qa-test-writing/references/tooling.md:13-16`"). The two
  statements agree and the ownership is declared.
- `qa-test-writing/references/gates.md` and `crew-recovery/references/mutation-proof.md`
  both cover commit-before-revert; both say commit first, and `mutation-proof.md` adds the
  `completeCheckProof` mechanics. Consistent.

---

## 3. STALE — right in kind, wrong line, count, or currency

| # | site | claim | measured | command |
|---|---|---|---|---|
| S1 | `devops/references/daemon.md:6-7` | "Its Unix socket is `daemon.sock`. Exhibit: `crew/daemon.mjs:371`" | `:371` is `const root = resolvePath(options.root \|\| join(homedir(), '.crew', 'daemon'))`; `socketPath` is **`:372`** | `sed -n '368,378p' crew/daemon.mjs` |
| S2 | `devops/references/daemon.md:12-13` | "A per-run journal is **written** as `journal.jsonl`. Exhibit: `crew/daemon.mjs:451`" | `:451` is `artifacts: [join(run.crew_dir, 'journal.jsonl')]` inside a *death record* payload; nothing writes the journal there | `sed -n '445,455p' crew/daemon.mjs` |
| S3 | `devops/references/daemon.md:49-50` | "An empty journal is no run evidence. Exhibit: `crew/daemon.mjs:713`" | `:713` is `if (!line.trim()) continue` — skipping blank **lines** inside `pollJournal` | `sed -n '705,720p' crew/daemon.mjs` |
| S4 | `devops/references/daemon.md:52-53` | "An interrupted daemon read must **preserve an indeterminate state**. Exhibit: `crew/daemon.mjs:615`" | `cursorLines` opens at `:615` and its first act is `if (!path \|\| !exists(path)) return []` — it *collapses* unknown into empty. The anchor is closer to a counter-example than an exhibit | `sed -n '608,625p' crew/daemon.mjs` |
| S5 | `devops/references/gh.md:44-45` | "If `gh` is unavailable, preserve that as unavailable … Exhibit: `scripts/factory/intake.mjs:545`" | `:545` is a bare `}`. The `catch { return null }` is at **536-538** | `sed -n '530,560p' scripts/factory/intake.mjs` |
| S6 | `backend-node/references/closed-enums.md:21-22` | "Pin immutability independently with `Object.isFrozen`. Exhibit: `crew/drive.test.mjs:4075`" | `:4074` is the `Object.isFrozen` assertion; **`:4075`** is the `deepEqual` | `sed -n '4073,4076p' crew/drive.test.mjs` |
| S7 | `backend-node/references/closed-enums.md:24-25` | "The **paired** assertions catch value drift and freeze drift. Exhibit: `crew/drive.test.mjs:5538`" | the pair is **5537** (`Object.isFrozen`) + 5538 (`deepEqual`); one anchor cannot carry a pair | `sed -n '5536,5539p' crew/drive.test.mjs` |
| S8 | `backend-node/references/closed-enums.md:15-16`, `:46-48` | "Keep the refusal message derived from the same set. Exhibit: `crew/drive.mjs:244`" | `:244` is the `ENVELOPE_FIELD_KINDS` refusal — a *different* closed enum than the `DECISIONS` the file is about | `sed -n '244p' crew/drive.mjs` |
| S9 | `frontend-svelte/references/components.md:29` | "`$state(` **53** times in 12 files" | **63** occurrences in 12 files | node census over `find visualizer/web/src -name '*.svelte'` |
| S10 | `frontend-svelte/references/components.md:21` | "`{@render` **27** times in 5 components" | **35** occurrences in 5 files | same |
| S11 | `frontend-svelte/references/components.md:25` | "`onclick=` … **16** across 10 components" | **18** across 10 files | same |
| S12 | `frontend-svelte/references/components.md:17,29` | "the **one** measured `$bindable(` use" | one *site* (`Filters.svelte:2`) but **two** `$bindable(` calls on that line | `grep -nF '$bindable('` |
| S13 | `ui-design/SKILL.md:37` | "The chassis appears in **12** components" | **11** files carry the exact string `background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem` | `grep -l "<chassis>" $(find . -name '*.svelte') \| wc -l` |
| S14 | `ui-design/references/contract.md:19` | "only the theme selectors in `visualizer/web/src/lib/theme.css:36,67,98`" | the `[data-theme='paper']` selector is at **`:37`**; `:36` is the bare `:root,` half. (`contract.md:23` describes the 36-37 span correctly) | `grep -n "data-theme" visualizer/web/src/lib/theme.css` |
| S15 | `crew-dispatch/references/tier.md:18-20` | "`sameFloorCell` **returns** `{applied: true, already: true}`" | `sameFloorCell` (`crew/seat-io.mjs:1951-1954`) is a boolean `const`; the block it guards (`:1955-1961`) returns that object. The behaviour is right, the attribution is not | `sed -n '1940,1975p' crew/seat-io.mjs` |
| S16 | `qa-test-writing/references/tooling.md:52`, `references/vacuity.md:31` | the b150 scratch table's `git worktree add --detach` row reads **2084 / 0**, presented as "the real baseline" | current baseline is **2171 / 0** (measured this run). The measurement is dated (`b150-permprobe`, 2026-08-22) and the *ordering* it proves still holds; the absolute number no longer identifies a green tree | `FORCE_COLOR=0 npm test -- --test-reporter=tap` |
| S17 | `crew-dispatch/references/flags.md:20-22` | quotes "The runtime's misplaced-flag refusal" verbatim | verbatim for the one-flag case (`crew/crew.mjs:2165`), but for `run` carrying **both** `--fences` and `--lane` the runtime appends `" and --fences is SUPPRESSING the --lane you asked for: with both present resolveValidationLane returns no lane at all"` (`:2166-2168`). The quote is a strict prefix of what an operator will see | `sed -n '2157,2176p' crew/crew.mjs` |
| S18 | `crew-dispatch/references/flags.md:10` | the `run` array omits `lane`, while `:26` asserts "`--lane` on `run` is legal" | both true — the block is declared "a subset" at `:3` — but the block is the artefact a reader copies, and `KNOWN_FLAGS.run` does contain `lane` (`crew/crew.mjs:2140`) | `sed -n '2138,2145p' crew/crew.mjs` |
| S19 | `ui-design/SKILL.md:41`, `references/state-colour.md:62` | "the ratified boundary is ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`" for the honest-blank idiom | `:23` is inside §2 (opens `:21`) ✓, but states the *screen-is-never-the-record* rule; it does not state the em-dash / `title` / dashed-underline idiom. Adjacent in spirit, not the anchor for the rule | `sed -n '21,23p' docs/adr/adr-029-*.md` |
| S20 | `devops/references/worktrees.md:9-10` | "The creation command is `git worktree add -b` … Exhibit: `crew/arms.mjs:670`" | `:670` opens `const spawnResult = git(`; the argv `['worktree', 'add', '-b', plan.branch, plan.dir, setPin]` is at **`:672`**. The statement spans 670-673 | `sed -n '655,680p' crew/arms.mjs` |
| S21 | `frontend-svelte/references/components.md:21` | "`AcceptPanel.svelte:10–23` does the same for evidence blocks" | `{#snippet markdown(blocks)}` is at `:11` ✓, but `{#snippet runs(items)}` is at **`:6`**, outside the cited range | `grep -n "{#snippet" lib/AcceptPanel.svelte` |
| S22 | `devops/references/daemon.md:46-47` | "An absent socket is unavailable, not a successful ping. Exhibit: `crew/daemon.mjs:1239`" | `:1239` is `socket = net.connect(socketPath)`; the `finish(false)` arms are `:1241-1243`. In-kind, off by 2-4 | `sed -n '1230,1250p' crew/daemon.mjs` |
| S23 | `crew-recovery/references/closeout.md:35-36` | "Only `.archive-` is recognised by **status, wait**, and the stale reaper: `ARCHIVE_RE = /\.archive-\d{4}-\d{2}-\d{2}T/`" | `ARCHIVE_RE` exists only in `scripts/factory/reap-stale.mjs:15`. `status`/`wait` follow archives via `archivedReturn` (`crew/crew.mjs:1990-1999`), which filters on the bare **prefix** `.archive-` with no date shape — so a hand rename to `.archive-foo` *is* visible to those two and invisible to the reaper. The operational advice (leave escalated work under its live name) is unaffected | `grep -rn "ARCHIVE_RE" crew/ scripts/`; `sed -n '1990,1999p' crew/crew.mjs` |

---

## 4. User-absolute path sweep

Known finding, extended: **11 sites** across **6 files**, citing **2 distinct paths**.
Both exist on this machine (`ls /Users/x/.dev-team/factory/preserved/scout-b151-viztokens/`
→ `conventions-register.md`, 42500 bytes, 2026-08-22) and on **no other**. `skills/` is
shipped plugin content, so every reader outside this laptop gets a dead citation.

| file:line | path cited | what it is cited as | what it should cite instead |
|---|---|---|---|
| `skills/ui-design/SKILL.md:12` | `…/preserved/scout-b151-viztokens/conventions-register.md` | "the measured register … as evidence" | the in-repo sources it summarises — `visualizer/web/src/lib/theme.css` plus the four `references/*.md` that already restate it. The register's *conclusions* are already in-tree; only the provenance is off-machine |
| `skills/ui-design/SKILL.md:46` | same | "The measurements above are preserved, not re-derived, in …" | replace with the repo-relative measurement recipe (the greps in this register reproduce every count), or a `docs/adr/` note if provenance must ship |
| `skills/ui-design/references/contract.md:3` | same, "§2 and §8" | "the checkable boundary recorded in …" | `visualizer/web/src/lib/theme.css:2-32,36-127` (already cited at `:7`) + the four suite pins already listed at `:29-33` |
| `skills/ui-design/references/limits.md:3` | same, "§§6, 8–10" | "This reference preserves the limits in …" | the contrast table is arithmetic over `theme.css` literals — cite `theme.css:2-31` and state the formula; the §9/§10 absences are already restated in full at `:32-51` |
| `skills/ui-design/references/state-colour.md:3` | same, "§§5–7" | "the measured R1–R5 decisions and L1–L12 departures" | the per-row `file:line` exhibits the table already carries (all 57 verified in-range); the register adds no fact the table lacks |
| `skills/ui-design/references/tokens.md:3` | same, "§§0–2" | "The preserved evidence is …" | `visualizer/web/src/lib/theme.css` alone — every one of the 63 anchors in this file resolves against it, exactly |
| `skills/ui-design/references/tokens.md:91` | same | "The canonical measured source for this table is `theme.css` **and** …" | drop the second conjunct: `theme.css` is sufficient and verified sufficient (§6 below) |
| `skills/frontend-svelte/SKILL.md:31` | same | "The preserved measurements live at …" | the counts are reproducible in-tree (see S9-S12); cite the census command, not the artefact |
| `skills/frontend-svelte/references/structure.md:3` | same, "§3–4" | "These facts are measured on this checkout and recorded in …" | the seven (eight — F7) module rows already carry their own `lib/*.js:1–N` exhibits |
| `skills/frontend-svelte/references/components.md:3` | same, "§4 and the rune census" | "The source evidence is the checkout described in …" | `visualizer/web/src/` plus the census command; the rune numbers are stale anyway (S9-S11) |
| `skills/pr-review/references/evidence.md:8` | `…/preserved/scout-b152-reviewmine/findings.md` | "The evidence register is …" | this is the hardest of the eleven: the F0-F28 rates exist **only** in that file (`gh` has no corpus). Either vendor the denominator table into `references/evidence.md` (it is already summarised at `:9-24`) or mark every F-number as an off-repo citation the reader cannot follow |

Sibling observations from the same sweep, for completeness:
- `skills/devops/references/daemon.md:3` uses `~/.crew/daemon`, a *portable* home-relative
  path matching `crew/daemon.mjs:371` (`join(homedir(), '.crew', 'daemon')`). Correct as written.
- No `$HOME`, no other `/Users/` occurrence: `grep -rn "/Users/" skills/ commands/` returns
  exactly the 11 rows above.

---

## 5. Format compliance (ratified rules), one row per skill

Rules checked: description enumerates triggers · routing table up front · critical rules
as imperatives with reason and named exception · depth in `references/` · posture declared.

| skill | description enumerates triggers | routing table first `##` | critical rules: imperative + reason | named exception | depth in `references/` | posture declared | co-located test |
|---|---|---|---|---|---|---|---|
| `backend-node` | yes — 3 "Use when …" clauses, ~76 w | yes (`:16`) | yes — each of 6 rules carries `Exhibit:` + `Cost:` | yes ("unless an explicit first-party allowlist admits an exception", `:30`) | 7 files | yes (`:13` "Every rule here is an observed response to a backend failure") | `exhibits.test.mjs` (4 tests) |
| `crew-dispatch` | yes — enumerates 5 triggers, ~34 w | yes (`:15`) | yes — 7 rules, each with issue/batch citation | yes ("When a protected hit is separable, split the lane", `:30`) | 5 files | yes (`:11` "the operator's routing layer for a new lane") | `cli-contract.test.mjs` (4 tests) |
| `crew-recovery` | yes — 5 triggers, ~33 w | yes (`:15`) | yes — 6 rules, each citing an issue/batch | yes ("never before closeout", `:27`) | 4 files | yes (`:11` "evidence-preserving closeout, not cleanup by instinct") | **none** |
| `devops` | yes — 3 "Use when …" clauses, ~83 w | yes (`:16`) | yes — 6 rules, all `Exhibit:` + `Cost:` | partial — rules are absolute; the *exceptions* live in `references/evidence.md` as "unbacked" | 6 files | yes (`:13` "Every rule here is a measured lifecycle boundary") | `exhibits.test.mjs` (4 tests) |
| `frontend-svelte` | yes — 4 triggers, ~77 w | yes (`:14`) | **`## Operating rules`, not `## Critical rules`** — 3 paragraphs, not imperative bullets; no per-rule reason line | no named exception | 4 files | yes (`:12` "retrieval-first repo skill, not a Svelte API manual") | **none** |
| `pr-review` | yes — 3 triggers, ~36 w | yes (`:17`) | yes — 5 rules; F-numbers supply the reason | yes ("or grade it a consider", `:29-30`) | 5 files | yes (`:11` "measured, not asserted") | `findings-shape.test.mjs` (4 tests) |
| `qa-test-writing` | yes — 6 triggers, ~113 w (the longest) | yes (`:24`) | yes — 9 rules, all `Never`/`Always` + measured exhibit | yes ("Escalate to must-fix only when the unprotected behaviour is itself a boundary", `rubric.md:50`) | 6 files | yes, **explicitly labelled** (`:19` "The posture is **measurement-first**") | **none** |
| `ui-design` | yes — 4 triggers, ~74 w | yes (`:14`) | yes — 7 bullets + 5 statements, each with exhibits | yes ("Permit `1px` only for hairlines, `999px` for the measured pill idiom …", `:40`) | 4 files | yes (`:12` "This is the boundary an agent designs inside") | **none** |

Compliance notes, ranked:

1. **`frontend-svelte` is the one structural miss.** Its rules section is
   `## Operating rules` (`:23`) and its three entries are prose paragraphs
   (`:25`, `:27`, `:29`) rather than imperatives carrying a reason and a named
   exception. Every sibling skill uses `## Critical rules` with per-rule reason.
2. **Four of eight skills have no co-located test**: `crew-recovery`,
   `frontend-svelte`, `qa-test-writing`, `ui-design`. The two most rule-dense
   documents in the tree (`qa-test-writing/SKILL.md`, 110 lines; `ui-design/SKILL.md`,
   53 lines with 17 anchors) are the two with zero mechanical pin — and `ui-design`
   is where **F2** and **F6** live. `crew-recovery`'s 18-row escalation table
   (`references/escalations.md:9-28`) is likewise unpinned, though it verifies
   fully true (§6).
3. **H1 heading is inconsistent** and no ratified rule covers it: `crew-dispatch`,
   `crew-recovery`, `pr-review` open with an H1; `backend-node`, `devops`,
   `frontend-svelte`, `qa-test-writing`, `ui-design` go straight from frontmatter to
   prose. Cosmetic; recorded so a later lane does not "fix" half of them.
4. **The two anchor tests are the wrong instrument** for what they are trusted to do —
   see §0 and finding **X1** below. This is the single change that would have caught
   F9, F10, S1-S8 and S20-S22 at authoring time.

### X1 · why the false anchors are green — the pin is existence-only

`skills/backend-node/exhibits.test.mjs:49-68` and its twin
`skills/devops/exhibits.test.mjs:50` are the only mechanical guard on any anchor in
this tree. Their whole adjudication is:

```js
assert.ok(existsSync(target), `${file}: missing ${rel}`)
assert.equal(statSync(target).isDirectory(), false, …)
const lines = readFileSync(target, 'utf8').split('\n').length
assert.ok(Number(number) >= 1 && Number(number) <= lines, …)
```

plus `assert.ok(anchors >= 12)`. Content is never read. Both tests pass; so do all 421
anchors, including every one of the sixteen in F9/F10 that names a line whose content is
unrelated to the claim. The comment above the test says
"Mutation killed: changing any documented `path:line` to a nonexistent line must make
this skill's exhibit index fail" — which is exactly, and only, what it does.

Its sibling `exhibits.test.mjs:16` ("import-free leaves agree with the firewall") checks
that `import-firewall.md` *names* each leaf module string; it never checks the line
numbers beside them, which is why `:228`/`:230`/`:232` survive.

This is `vacuity.md`'s shape 3 verbatim: *"A drift guard that greps for a literal is
blind to every spelling that is not that literal"* — here, blind to every line number
that is merely in range.

---

## 6. Commands versus their skills

`commands/` is three files, 34 lines total, and is the cleanest surface in this audit:
**zero false, zero stale, zero contradictions**. Pinned by `commands/commands.test.mjs`
(7 tests, green).

| command | frontmatter `description` | `argument-hint` | passes `$ARGUMENTS` | skill(s) named | skill exists + declares that `name:` | thin? | verdict |
|---|---|---|---|---|---|---|---|
| `dispatch.md` | "Dispatch a crew lane for an issue or a request." | `<issue-number-or-request>` — matches the body's "Dispatch a crew lane for: $ARGUMENTS" | yes (`:6`) | `crew-dispatch` | `skills/crew-dispatch/SKILL.md`, `name: crew-dispatch` ✓ | 10 lines, no procedure token | **true** |
| `close-out.md` | "Close out a crew lane by name." | `<lane-name>` — matches "Close out the crew lane: $ARGUMENTS" | yes (`:6`) | `crew-recovery` | `skills/crew-recovery/SKILL.md`, `name: crew-recovery` ✓ | 10 lines | **true** |
| `status.md` | "Report factory and crew state read-only — worktrees, lanes, PRs, orphans, and the suite baseline." | **absent, correctly** — `commands.test.mjs:74-80` requires `status.md` to declare none and to reference no `$ARGUMENTS`/`$1`/`$2` | n/a | `devops` **and** `crew-recovery` | both ✓ | 13 lines | **true** |

Cross-checks run:

- **Routing is right, both directions.** `commands.test.mjs:82-98` pins
  `dispatch→crew-dispatch`, `close-out→crew-recovery`, `status→{devops, crew-recovery}`,
  and resolves each named skill to a `SKILL.md` whose frontmatter `name:` equals the
  cited name. Verified independently: `status.md:8-10` routes worktrees/PRs/orphans to
  `devops` (which owns `references/worktrees.md`, `gh.md`, `processes.md`) and lane state
  to `crew-recovery` (which owns `references/liveness.md`) — the split matches what each
  skill actually contains.
- **Thinness is pinned, not asserted.** `commands.test.mjs:100-122` bans nine
  procedure tokens (`--fences`, `--tier`, `--validation-lane`, `KNOWN_FLAGS`,
  `crew.mjs teardown`, `cp -a`, `.archive-`, `git worktree remove`, `--body-file`) from
  every command body *and* frontmatter, then — the non-vacuous half — asserts each token
  really is skill-owned content, reading `crew-dispatch/references/flags.md`,
  `crew-recovery/references/closeout.md`, `devops/references/worktrees.md`,
  `devops/references/gh.md`. Confirmed by hand: all nine appear in those four files.
- **`status.md`'s read-only posture is pinned.** `commands.test.mjs:124-132` requires
  the word `read-only` and bans `teardown|push|commit|boot|kill|delete` as whole words —
  the whole-word rule being deliberate, since "skills" contains "kill". `status.md:12-13`
  ("This command authorizes no change of any kind: gather, report what you find, and
  stop.") satisfies it.
- **Path form.** All three commands cite their skill as a repo path
  (`skills/<name>/SKILL.md`) *and* by name (`` `crew-recovery` skill ``). The name form
  is what `citedSkills()` (`commands.test.mjs:54-56`) matches and what an installed
  plugin resolves; the path form is a reader convenience that happens to be correct here.
  No action, recorded for context.

---

## 7. Verified-true, recorded so no later lane re-spends it

Everything below was checked and holds. This is roughly 85% of the 745 checkable claims.

**Closed contracts (all exact):**
- `KNOWN_FLAGS` boot/run subsets, `BOOT_ONLY_FLAGS = ['fences','lane']`,
  `ROLE_FLAG_PREFIXES = ['model-','agent-','effort-','allow-shortfall-']`, and the
  "concrete suffix must be non-empty" rule — `crew/crew.mjs:2138-2171`
  (`crew-dispatch/references/flags.md:7-18`).
- `--lane` on `run` is legal and means the validation lane; the misplaced-flag refusal
  applies to `handoff`, `wait`, `status`, `teardown` — `KNOWN_FLAGS` per-verb arrays
  (`flags.md:24-26`).
- `resolveValidationLane` returns `{lane: null, source: 'none'}` when `--fences` is
  present with `--lane` — `crew/crew.mjs:418-440`, the `fences === undefined` pairing
  test (`flags.md:28-31`).
- `VARIANTS` — four shapes, triggers and `ctx` exactly as tabulated; `scout` boots
  `--roles lead,planner` with no `--tier`/`--fences`/`--lane` — `crew/variants.mjs:7-48`
  (`crew-dispatch/references/variants.md`).
- `TIER_NAMES = ['mechanical','build','judge']` and `proposalTierAfterRaise` moving one
  band — `scripts/factory/make-brief.mjs:63,1038-1041`. A one-file protected hit prints
  `build` because `JUDGE_PROTECTED_FLOOR = 2` (`:84,1053`) — `tier.md:32-35`.
- `PROTECTED_PATHS` includes the authored `docs/adr/` and `.github/workflows/` floor —
  `crew/protected-paths.mjs:8-14` (`fences.md:62-63`).
- `SCOPE_DIR_MIN_SEGMENTS = 2`; `scopeMatcher`'s rule is exactly
  `entry.endsWith('/') ? path.startsWith(entry) : path === entry` —
  `crew/drive.mjs:1249,1388-1392` (`fences.md:44-60`).
- `coupled-source-unfenced` / `stale-read-ack` refusal reasons —
  `scripts/factory/make-brief.mjs:108-109` (`fences.md:30-38`).
- `SCOPE_DIRECTORY_UNSLASHED` refusal — `scripts/factory/make-brief.mjs:112,877`
  (`tripwires.md:37`).
- `DAEMON_COMMANDS` is a closed list of exactly **nine** names, in the documented order —
  `crew/daemon.mjs:113` (`daemon.md:18-19`).
- `PARK_STATES` (`crew/reclaim.mjs:11`), `REAP_ACCOUNTING = ['proven','failed','unproven']`
  (`scripts/factory/reap-stale.mjs:75`) — `closed-enums.md:27-31`.
- `checkFailureLine`'s bare-line-or-single-colon rule, including the
  `FAIL cache` ≠ `FAIL cache-v2` prefix guard — `crew/drive.mjs` `checkFailureLine`
  (`mutation-proof.md:18-21`).
- `completeCheckProof` mutates in place and restores from the exact bytes read in a
  `finally` — `crew/drive.mjs:2503-2545` (`mutation-proof.md:25-30`).
- `SHADOW_ABSENT`'s four reason strings, quoted **verbatim** including
  `USAGE_ABSENT_CAUSES.pane` reuse — `crew/crew.mjs:874-879` (`absence.md:15-24`).
- `foldRpcUsage` exists at `crew/headless-rpc.mjs:131` and is called at `:319`
  (`captures.md:8`). `NO_FANOUT` is the builder's `deny` (`crew/crew.mjs:111,116`)
  (`qa-test-writing/SKILL.md:44`).

**Escalation stages — the whole 18-row table is real.**
`crew-recovery/references/escalations.md:9-28` lists 18 tokens.
`grep -o "escalate('[a-z-]*'" crew/drive.mjs | sort -u` gives 14 literal stages
(build, envelope, gate, lane, plan, plan-carve, plan-check, refuted-must-fix, review,
scope, sensitivity-floor, suite, triage, triage-scope) and
`escalate(variant, …)` at `crew/drive.mjs:2047,2049,2187,2191` supplies the four
variant-named ones (full, scout, repair, directed) — exactly as the file's own note at
`:4-6` claims. `stage(\`escalate:${where}\`)` is `crew/drive.mjs:1934`.

**Teardown and closeout:**
- archive path `${paths.dir}.archive-${iso}` with a full timestamp — `crew/crew.mjs:2085`.
- JSON output `{archived, seats:{seats, proven, failed, unproven, recorded, record_failed}}`
  and `process.exitCode = 1` when `proven !== seats` — `crew/crew.mjs:2110-2119`
  (`closeout.md:28-33`).
- `seatLiveness(crew, probe = paneAlive)` — `crew/crew.mjs:2028`; `paneAlive` is
  three-state `true | false | null` — `crew/seat-io.mjs:1446` (`liveness.md:3-5`).
- the journal's two `at` shapes: `crew.mjs` writes ISO strings, driver rows write
  `io.now()` epoch ms (`crew/drive.mjs:1465` `now() -> ms`) (`liveness.md:9-12`).
- `details.envelope.fields` records field *names* only —
  `crew/drive.mjs:2074` `envelope: { seat, fields: observedFields, files_changed: 0 }`
  (`liveness.md:14-19`, `tooling.md:77-80`).

**Tier and floor:**
- the pane-transport refusal is quoted **verbatim**, including its own stale
  in-string anchor — `crew/seat-io.mjs:1967`. `tier.md:14-17`'s meta-claim that
  `crew/crew.mjs:265` is stale is **correct**: `:265` is inside a tripwire-manifest
  builder. The live bake `paneCommand` is at `crew/crew.mjs:1315-1329`, as stated.
- `protectedHits(scopeFiles, ctx.protectedPaths)` runs at plan-accept and
  `escalate('sensitivity-floor', …)` follows — `crew/drive.mjs:2371-2378`
  (`tier.md:26-30`).

**Executable snippets — every one in `fences.md` runs and prints what the doc says:**
```
$ node --input-type=module -e "…validateScopeEntries(['skills/crew-dispatch/'])…"
  { errors: [], SCOPE_DIR_MIN_SEGMENTS: 2 }
$ node --input-type=module -e "…scopeMatcher(['skills/crew-dispatch/'])…"
  { child: true, directoryWithoutSlash: false }
$ node --input-type=module -e "…protectedHitsIn(['skills/crew-dispatch/'], PROTECTED_PATHS)…"
  []
```
`make-brief.mjs`'s flag set accepts every flag in the documented invocation
(`--request --checkout --fences --lane --out --force`) — `scripts/factory/make-brief.mjs:1438-1439`.

**`ui-design/references/tokens.md` — exact, all 63 anchors:**
`theme.css` has **105** custom-property declarations and **55** unique names
(`grep -oE '^\s*--[a-z0-9-]+\s*:' | wc -l` / `| sort -u | wc -l`), matching `:7`.
The 30 raw declarations occupy lines 2-32 — 31 lines of which `:27` is the
operational-status comment, exactly as `:46` says. Every raw token's line number *and*
hex value checks out (`--ink-ground #17171a` at `:2` … `--status-skipped-raw #77747d` at
`:31`, `--mono` at `:32`), and every Tier-2 alias's paper/ink line pair checks out
(`--bg` at 40/71 … `--lane-7` at 64/95). The cascade anchors `:36`, `:67`, `:97-98` and
the radius resets `:129`,`:131` are right.

**`ui-design` T2 leak inventory — exact, per file and per literal.**
`state-colour.md:29-43` claims "34 colour literals in 10 of 21 components: 33 hex plus
one named `white`". A fresh census over `find visualizer/web/src -name '*.svelte'`
returns 33 hex in exactly the ten files listed, with the per-file counts and the literal
values matching every row (GateChips 4, AcceptPanel 4, PhasePanel 6, PhaseGantt 4,
IntakePanel 6, CellHealthPanel 3, RunSetPanel 3, RunDetail 1, EnvelopeInspector 1+`white`,
RosterEditor 1), plus `color:white` at `EnvelopeInspector.svelte:48`. The documented
grep traps are real: `#123` at `EventStream.svelte:29`, `#83` at `MetricsStrip.svelte:19`.

**Other `ui-design` counts and anchors that hold:** 19 `background:var(--panel)` and 45
`var(--line)` sites (SKILL.md:31,37, exact); T4's sole `data-theme` writer at
`App.svelte:48-49` inside the cited 46-51; `App.svelte:200` `var(--status-fail)` vs
`:201-202` `--serious` vs `:208` `--status-escalated` vs `:209` `.chip.quiet` (D4/L2/D6,
all four exact); `fleet.js:53-61` `deriveStatus` returning
`tone ∈ {serious, ok, fail, quiet, busy}` with queued→quiet at `:58` and unknown→quiet at
`:60`; `FleetTable.svelte:37-40` mapping four tones and omitting `.quiet` (D6, exact);
L6's `.status-dot` pair at `FleetTable.svelte:36` and `:42` (exact); `TeardownPanel.svelte:54`
`unproven { color:var(--status-running)` (D5, exact); `trace.js:3` `ROLE_ORDER` with six
roles; `theme.css:57-64` bounding lanes at 0-7; `PhaseGantt.svelte:40` passing
`'unlinked'` (L10); L11's "theme.css sets no `color-scheme`" — the sheet's only
occurrence is `@media (prefers-color-scheme: dark)` at `:97`, a media query and not the
property, and `visualizer/web/index.html:2` carries none.

**Suite-pin descriptions in `contract.md:29-33` and `limits.md:26-28` are honest:**
`test/visualizer-shape.test.mjs:286-292` is a 6-role loop with 2 assertions each = the
claimed **12 name-presence regexes**, inspecting no value; the four-file role/lane
blocklist is at `test/visualizer-panels.test.mjs:660-662` with `TeardownPanel` added at
`test/visualizer-teardown.test.mjs:201` and `RosterPanel` at
`test/visualizer-server.test.mjs:1396`; the FleetTable pins at
`visualizer-panels.test.mjs:627,629` and the PhaseGantt locals at `:845-847` are exact.

**`frontend-svelte` — the non-census claims are exact:**
20 `.svelte` files under `lib/` (21 with `App.svelte`); the seven named modules' line
counts are perfect (`api.js` 26, `route.js` 40, `drain.js` 49, `fleet.js` 174,
`panels.js` 785, `timeline.js` 84, `trace.js` 459); zero `on:click`, zero `export let`,
zero `$:`, zero `{@html}`; `$derived` 40/16, `$props()` 14/14, `$effect` 15/10 all
exact; **17** `readFileSync` sites reading `.svelte` under `test/visualizer-*.test.mjs`,
exact; no `vitest`/`jsdom`/`testing-library` anywhere in `package.json`, whose
devDependencies are exactly `svelte`, `vite`, `@sveltejs/vite-plugin-svelte`, and whose
test script is `node --test --test-timeout=30000`; `main.js:1-5` imports the token sheet
then mounts; `App.svelte:44-51` applies `data-theme` after start;
`RunCard.svelte:18-20`'s `state_referenced_locally` comment; the `:global(p)` uses at
`AcceptPanel.svelte:36` / `PhasePanel.svelte:62` and the resets at `App.svelte:187-188`;
`RunDetail.svelte:33`'s grid gap; `PhasePanel.svelte:19-32` defining both `runs` (`:20`)
and `markdown` (`:25`).

**`pr-review` — every cross-tree anchor resolves and matches:**
`crew/roles/reviewer.md:12-18` is the conformance/correctness split; `:37-42` is exactly
`{id, severity, location, summary}`; `:49` is "`findings` is optional"; `:14` is
"Out-of-plan edits are findings even when harmless";
`crew/guidelines/review-do-not-flag.md` exists; `.agents/skills/review-procedure` exists;
`crew/pi/agents/scout.json` carries the documented shape **verbatim**, including
`"confidence": "verified" | "assumed"` and "No other keys are permitted anywhere in the
object"; `crew/drive.mjs:1388` is `scopeMatcher` and `:2040` a scope-diff call, both fit
the worked example. Internal arithmetic is consistent: `SKILL.md:53`'s "0 must-fix in 23"
= `rubric.md:59-60`'s 16 + 7, and the 196-of-203 gate figure agrees across
`SKILL.md`/`rubric.md:25`/`posture.md:11`. `findings-shape.test.mjs` (4 tests) pins the
skill against `scout.json` using a literal it holds itself — the coupling
`rubric.md:32-36` claims. `posture.md:5-7` correctly labels the panel flow **parked**.

**`qa-test-writing` — the repo-facing mechanics:**
`npm test` is `node --test --test-timeout=30000`; the brief compiler's
`BASELINE_TIMEOUT_MS = 300_000` and whole-suite baseline
(`scripts/factory/make-brief.mjs:61,783`); `FORCE_COLOR` beating `NO_COLOR`
(reproduced this run); the three verified negatives — `shape.mjs:220` is
`billed_cost_usd: null` and `reap-stale.mjs:58` is the `guardedKill` pid/pgid predicate,
both exactly as `vacuity.md:96-100` records; `crew/factoryctl.test.mjs` exists
(`tripwires.md:19`); the "new files are not existence-checked in a fence register while
`where` is" rule (`tripwires.md:59-64`) matches `make-brief.mjs`'s split handling.
Issues **#153, #168, #240, #443, #471, #473, #476, #493, #496 (MERGED PR), #119** all
resolve with titles that state the cited lesson.

**`backend-node` — the true remainder:**
`VERB_FLAGS` at `scripts/factory/ledger.mjs:3340` and the `refuse(…unknown flag…)` at
`:3372` inside `refuseUnknownFlags` (defined `:3364`); the unknown-**verb** refusal at
`:4304`; the `#443` `--untill` exhibit and its exit-2 assertions at
`test/factory-ledger.test.mjs:2261-2266` and `test/factory-emit.test.mjs:1403`;
`emit.mjs:1341`'s mirroring comment; `subagent.ts:5-9`'s erasable-syntax header and
`subagent.test.mjs:174,175` grepping `enum` and `namespace` but **not** parameter
properties or decorators — the gap `evidence.md:22-42` declares, and which
`exhibits.test.mjs:37` actively pins by asserting `doesNotMatch(source, /parameter properties/)`;
`docs/conventions.md:45` carrying `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`;
`docs/conventions.md:122` carrying the frozen-enum drift-guard convention;
`subagent.ts:394` (`usage: () => (measured ? billed : null)`), `:396` (the
`totals.cost += usage.cost.total` unconditional-dereference comment), `:525`
("Complete or absent — never partial, never a fabricated zero"), and
`subagent.test.mjs:456,468` (`Object.hasOwn(absent.result, 'usage') === false`);
`test/factory-ci-watch.test.mjs:205` and `test/factory-intake.test.mjs:1078`'s
first-party allowlists. `erasable-ts.md:48`'s "first fourteen lines" is not arbitrary —
`exhibits.test.mjs:27` slices exactly `.slice(0, 14)`.

**`devops` — the true remainder:**
`crew/arms.mjs:661` (refuse an existing target); `crew/crew.mjs:1879`/`:1881`
(done→auto-teardown, escalation→never); `scripts/factory/ci-watch.mjs:237` (the
`--git-dir`/`--git-common-dir` probe), `:241-244` (the `linked = false` catch), `:262`
(`isWorkerPath`), `:277` (empty branch name); `scripts/factory/intake.mjs:533-535`
(explicit `cwd`, no shell `cd`); `scripts/factory/probe-repo.mjs:739`
(`process.env.GH_BIN || 'gh'`), `:799` (`deleteBranchOnMerge` as a probed setting);
`scripts/factory/reap-stale.mjs:56-60`, `:71-75`, `:105-107`, `:251-254`, `:257`
(guard, accounting, archived sweep, dry-run default, `USAGE`); `crew/README.md:216`
(Unix-socket control surface, no launchd) and `:237` (three-state liveness);
`scripts/pr-review-window.sh:61-62` (a linked worktree's `.git` is a *file*);
`tasks/cmux-mode/spike-findings.md:58` (the single incidental `launchd` ancestry line);
`crew/daemon.mjs:373` (`daemon.json`). `references/evidence.md`'s five negative searches
reproduce: no `gh pr create`/`gh issue create`, no branch-deletion implementation, no
launchd service definition, no kill-error fixture, no repo-wide import scan. Recording
an unbacked rule *as* unbacked is the practice this skill is strongest at.

---

## 8. Per-document register — all 52 rows

Counting rule (mechanical, script preserved at `queries/claimcounts.txt`): a checkable
claim is one `file:line[-line]` anchor, one `#NNN` issue reference, one quoted
flag/constant/function/command literal, or one numeric assertion of the form
`N of M` / `N/M` / `**N**` / `N times|sites|components|files|occurrences|rows|declarations|hairlines|uses`.
`stale` and `false` counts are the findings adjudicated above, attributed to the file
that carries the wording. The counter is mechanical and therefore **undercounts prose
claims that carry no citable token** — "the seven plain modules" (F7) and the
`ARCHIVE_RE` sentence (S23) are real claims their files score 0 for, so rows 19 and 30
are set to 1 by hand. Two rows carry a finding without losing a true claim:
`pr-review/references/evidence.md:8` is *true but unfollowable* (§4) and counts as true,
and `state-colour.md`'s S19 is shared wording with `ui-design/SKILL.md`.

| # | document | claims | true | stale | false | notes |
|---:|---|---:|---:|---:|---:|---|
| 1 | `commands/close-out.md` | 0 | 0 | 0 | 0 | thin, routes to `crew-recovery`, hint matches; §6 |
| 2 | `commands/dispatch.md` | 0 | 0 | 0 | 0 | thin, routes to `crew-dispatch`, hint matches; §6 |
| 3 | `commands/status.md` | 0 | 0 | 0 | 0 | no `argument-hint` by design, read-only posture pinned; §6 |
| 4 | `skills/backend-node/SKILL.md` | 13 | 11 | 1 | 1 | F9 (`daemon.test.mjs:221`); S-cluster shares F9's line table |
| 5 | `skills/backend-node/references/cli-flags.md` | 22 | 21 | 0 | 1 | F8 (`:2326` is the refusal, not the inverse) |
| 6 | `skills/backend-node/references/closed-enums.md` | 21 | 15 | 3 | 3 | F1 (`:3`,`:10`,`:13`); S6, S7, S8 |
| 7 | `skills/backend-node/references/erasable-ts.md` | 17 | 17 | 0 | 0 | "first fourteen lines" is pinned by `exhibits.test.mjs:27` |
| 8 | `skills/backend-node/references/evidence.md` | 9 | 8 | 1 | 0 | `:50` shares F9's stale `daemon.test.mjs:228` |
| 9 | `skills/backend-node/references/import-firewall.md` | 17 | 5 | 0 | 12 | F9 — every `daemon.test.mjs` line number misses; the prose rules are true |
| 10 | `skills/backend-node/references/usage-records.md` | 19 | 19 | 0 | 0 | producer-seam anchors all exact |
| 11 | `skills/backend-node/references/zero-dep.md` | 14 | 13 | 1 | 0 | `:49` shares F9's `daemon.test.mjs:221` |
| 12 | `skills/crew-dispatch/SKILL.md` | 7 | 5 | 0 | 2 | F3 — `#145` twice (`:27`, `:31`) |
| 13 | `skills/crew-dispatch/references/fences.md` | 1 | 1 | 0 | 0 | every snippet executed and matched; C1 is `tripwires.md`'s omission, not this file's |
| 14 | `skills/crew-dispatch/references/flags.md` | 10 | 8 | 2 | 0 | S17 (quote is a prefix), S18 (`run` array omits `lane`) |
| 15 | `skills/crew-dispatch/references/tier.md` | 7 | 6 | 1 | 0 | S15 (`sameFloorCell` attribution). The 1208-line/32-check/68-minute #507 measurement is **unverifiable here** — not in the repo, not in `preserved/b153-lab/` (brief only), not in the issue |
| 16 | `skills/crew-dispatch/references/variants.md` | 8 | 8 | 0 | 0 | matches `crew/variants.mjs` exactly |
| 17 | `skills/crew-dispatch/references/worktree.md` | 1 | 1 | 0 | 0 | dirty-checkout refusal and `changedFiles()`'s `-uall -z` both confirmed |
| 18 | `skills/crew-recovery/SKILL.md` | 4 | 4 | 0 | 0 | #512, #387, #330, #500 all resolve to matching titles |
| 19 | `skills/crew-recovery/references/closeout.md` | 1 | 0 | 1 | 0 | S23 (`ARCHIVE_RE` is the reaper's only; status/wait use a bare prefix) |
| 20 | `skills/crew-recovery/references/escalations.md` | 1 | 1 | 0 | 0 | all 18 tokens real — 14 literal + 4 variant-named; §7 |
| 21 | `skills/crew-recovery/references/liveness.md` | 0 | 0 | 0 | 0 | `seatLiveness`, `paneAlive`, both `at` shapes, `envelope.fields` all confirmed |
| 22 | `skills/crew-recovery/references/mutation-proof.md` | 2 | 2 | 0 | 0 | `checkFailureLine` and `completeCheckProof` described precisely |
| 23 | `skills/devops/SKILL.md` | 15 | 13 | 0 | 2 | F10 (`seat-io.mjs:1655`); one `arms.mjs:670` span (S20) |
| 24 | `skills/devops/references/daemon.md` | 18 | 13 | 5 | 0 | S1, S2, S3, S4, S22 — the nine-command set and README anchors are exact |
| 25 | `skills/devops/references/evidence.md` | 6 | 6 | 0 | 0 | all five negative searches reproduce |
| 26 | `skills/devops/references/gh.md` | 12 | 11 | 1 | 0 | S5 (`intake.mjs:545` is `}`) |
| 27 | `skills/devops/references/lane-branches.md` | 9 | 9 | 0 | 0 | every `ci-watch.mjs` anchor lands; unbacked rules labelled unbacked |
| 28 | `skills/devops/references/processes.md` | 22 | 22 | 0 | 0 | the cleanest anchor set in `devops` |
| 29 | `skills/devops/references/worktrees.md` | 18 | 15 | 1 | 2 | F10 (`:25`, `:28`); S20 |
| 30 | `skills/frontend-svelte/SKILL.md` | 1 | 0 | 0 | 1 | F7 ("seven plain modules", `:20`,`:37`); format: `## Operating rules` (§5) |
| 31 | `skills/frontend-svelte/references/components.md` | 33 | 27 | 5 | 1 | F5 (`App.svelte:124`); S9, S10, S11, S12, S21 |
| 32 | `skills/frontend-svelte/references/routing.md` | 0 | 0 | 0 | 0 | MCP tool names (`list-sections`, `get-documentation`, `svelte-autofixer`, `playground-link`) all exist on the connected server |
| 33 | `skills/frontend-svelte/references/structure.md` | 15 | 14 | 0 | 1 | F7. All seven module line ranges exact |
| 34 | `skills/frontend-svelte/references/testing.md` | 4 | 4 | 0 | 0 | 17 `readFileSync` sites, devDeps, and both test pins exact |
| 35 | `skills/pr-review/SKILL.md` | 10 | 10 | 0 | 0 | rubric table internally consistent with `rubric.md` |
| 36 | `skills/pr-review/references/divergence.md` | 6 | 6 | 0 | 0 | `reviewer.md:12-18` and both `drive.mjs` anchors fit; rule correctly labelled design-not-measurement |
| 37 | `skills/pr-review/references/evidence.md` | 11 | 11 | 0 | 0 | F28 caveat is exemplary. `:8` is the one **unfollowable** citation (§4) |
| 38 | `skills/pr-review/references/findings-shape.md` | 2 | 2 | 0 | 0 | matches `scout.json` verbatim; pinned by `findings-shape.test.mjs` |
| 39 | `skills/pr-review/references/posture.md` | 2 | 2 | 0 | 0 | parked panel correctly labelled parked |
| 40 | `skills/pr-review/references/rubric.md` | 21 | 21 | 0 | 0 | all rates carry denominators; `reviewer.md:14` and the guideline pointer resolve |
| 41 | `skills/qa-test-writing/SKILL.md` | 10 | 10 | 0 | 0 | #476/#493/#496/#119 all resolve to matching titles |
| 42 | `skills/qa-test-writing/references/absence.md` | 0 | 0 | 0 | 0 | `SHADOW_ABSENT` quoted verbatim |
| 43 | `skills/qa-test-writing/references/captures.md` | 4 | 4 | 0 | 0 | #493/#496 exact; `foldRpcUsage` located |
| 44 | `skills/qa-test-writing/references/gates.md` | 6 | 6 | 0 | 0 | #153/#168/#240 exact; `GATE-SUMMARY` shape matches `crew/drive.mjs` |
| 45 | `skills/qa-test-writing/references/tooling.md` | 7 | 6 | 1 | 0 | S16 (2084/0 → 2171/0). `BASELINE_TIMEOUT_MS`, ANSI rule, `returns/d1.planner.json` all exact |
| 46 | `skills/qa-test-writing/references/tripwires.md` | 2 | 1 | 0 | 1 | F4 (`#139`); **C1** — the unmoduled `validateScopeEntries({checkout, files})` snippet |
| 47 | `skills/qa-test-writing/references/vacuity.md` | 6 | 5 | 1 | 0 | S16. Both verified negatives (`shape.mjs:220`, `reap-stale.mjs:58`) confirmed |
| 48 | `skills/ui-design/SKILL.md` | 23 | 20 | 1 | 2 | F2 (`:29` 21/21), F6 (`:38` four sites); S13 (12 vs 11 chassis); C4 (`:39` border-top exhibits); S19 |
| 49 | `skills/ui-design/references/contract.md` | 45 | 42 | 1 | 2 | F2 (`:7`) + C2 (self-refuted by `:15`); S14. The suite-floor description (`:29-33`) is exact |
| 50 | `skills/ui-design/references/limits.md` | 25 | 25 | 0 | 0 | the eight contrast ratios are declared as arithmetic over `theme.css` literals, and the §9/§10 absences are restated in full in-tree |
| 51 | `skills/ui-design/references/state-colour.md` | 71 | 70 | 1 | 0 | the 34-literal L1 inventory reproduces exactly; R1-R5, L2/L3/L6/L10/L11, D4/D5/D6/D10 all confirmed. S19 shared with SKILL.md |
| 52 | `skills/ui-design/references/tokens.md` | 169 | 169 | 0 | 0 | **the most accurate document in the tree** — 105/55/30 counts and every token line-and-value exact |
| | **TOTAL** | **747** | **689** | **27** | **31** | 8 distinct false claims (F1-F8) + 2 anchor clusters (F9, F10) spanning 15 sites; 23 stale entries across 27 sites |

Counts are per *site*, so one finding cited in several files appears in several rows
(F9's twelve sites span rows 4, 8, 9, 11; F10's three span rows 23, 29; F2's two span
rows 48, 49; F7's three span rows 30, 33; S16's two span rows 45, 47; S19's two span
rows 48, 51).

---

## 9. What a follow-up lane would fix, cheapest first

1. **Replace the two existence-only anchor tests with content-asserting ones** (X1).
   One change; it converts F9, F10 and eleven of the stale rows from invisible to red.
   The shape: for each `path:line`, assert the line matches a per-anchor expectation
   (a literal substring declared beside the anchor), not merely that the line exists.
2. **Fix the sixteen anchor-cluster line numbers** (F9, F10) — mechanical, the correct
   lines are in the tables above.
3. **Name the module in `tripwires.md:45`** and pick one `validateScopeEntries` (C1).
   The silent-`[]` arm is the live hazard.
4. **Correct `T1 21/21` → `20/21`** or narrow its census definition (F2), and reconcile
   `SKILL.md:29` with `contract.md:15`.
5. **Re-run the four drifted counts** (S9-S13) and add `envelope-diff.js` to the module
   table (F7) — all reproducible with the commands in §8's counting rule.
6. **Re-cite `#145` and `#139`** (F3, F4) — `#282`/`#378` are the fence candidates.
7. **Decide the `/Users/x` question once** (§4). Ten of the eleven sites can be replaced
   with in-repo anchors that are already present; only `pr-review/references/evidence.md:8`
   holds facts that exist nowhere else and needs a vendoring decision.
8. **Add co-located tests to the four skills without one** (§5 note 2) — `ui-design`
   first, since both remaining false claims live there.
