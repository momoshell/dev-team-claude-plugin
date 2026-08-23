# Cross-cutting findings (planner-authored)

Findings that no single-family read produces, because each is only visible when the whole
agent-steering surface is held at once. Checkout `/Users/x/Development/dt-s3-prose`,
HEAD `5a8d76a`. Repo verified unchanged by this audit (`git status --porcelain` empty).

---

## X1 — **FALSE at every install but this one**: three shipped skills anchor their evidence to one operator's `$HOME`

Eleven sites across three skills cite `/Users/x/.dev-team/factory/preserved/...` as the
register that makes the skill "measured, not asserted":

| file:line | cited path |
|---|---|
| `skills/ui-design/SKILL.md:12` | `…/scout-b151-viztokens/conventions-register.md` |
| `skills/ui-design/SKILL.md:46` | same |
| `skills/ui-design/references/contract.md:3` | same, §2 and §8 |
| `skills/ui-design/references/limits.md:3` | same, §§6, 8–10 |
| `skills/ui-design/references/tokens.md:3` | same, §§0–2 |
| `skills/ui-design/references/tokens.md:91` | same ("the canonical measured source") |
| `skills/ui-design/references/state-colour.md:3` | same, §§5–7 |
| `skills/frontend-svelte/SKILL.md:31` | same |
| `skills/frontend-svelte/references/structure.md:3` | same, §3–4 |
| `skills/frontend-svelte/references/components.md:3` | same, §4 |
| `skills/pr-review/references/evidence.md:8` | `…/scout-b152-reviewmine/findings.md` |

Both registers exist **on this machine** — verified:

```
/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md   42500 bytes
/Users/x/.dev-team/factory/preserved/scout-b152-reviewmine/findings.md
```

Neither is in the repository. `~/.dev-team/` is the factory's runtime home, outside every
checkout, and `git ls-files` does not carry it. The plugin, meanwhile, is distributed:
`.claude-plugin/marketplace.json` publishes source
`https://github.com/momoshell/dev-team-claude-plugin.git` @ `main`, and `skills/` sits at
the repo root, so it ships.

Consequence, and it is the reason this is a false claim rather than a stale one: on the
author's machine every one of these anchors resolves and the skill is exactly what it
claims to be. On any other install — the only reason to publish a marketplace entry — the
anchors resolve to nothing, and the load-bearing sentence of three skills
(*"Treat the measured register at … as evidence"*, `skills/ui-design/SKILL.md:12`) instructs
the agent to read a file that is not there. `skills/ui-design/references/tokens.md:91` is
the sharpest case: *"values not present in either source do not belong in this reference"* —
a rule that, off this machine, can never be satisfied.

The repo-internal half of each citation is fine and does resolve
(`visualizer/web/src/lib/theme.css`, cited alongside the register at `tokens.md:91`), which
is the shape of the fix: cite the checkout, and either vendor the register under
`skills/<name>/references/` or drop the claim to what the checkout can prove.

---

## X2 — the `--no-skills` boundary is mechanically airtight, and one charter crosses it anyway

Epic #497's ratified boundary rule: *"charters are always-on seat behaviour; skills are
optional procedures. Seats keep booting `--no-skills`; discipline reaches seats through the
brief. Skills serve the orchestrator session and any skills-standard agent."*

Verified mechanically, and it holds without exception in the register:
`crew/capabilities.json` gives **every** role `skills: []` — lead, planner, builder,
reviewer, tech-lead. So every seat takes the closed branch at
`crew/adapters/adapter-pi.mjs:253`:

```js
...(skills.length ? skills.flatMap((skill) => ['--skill', `"${skill}"`]) : ['--no-skills']),
```

pinned by `crew/adapter-pi.test.mjs:170`. On the claude side a grant is not merely absent
but unrepresentable: `crew/adapters/adapter-claude.mjs:66-68` throws `grant-unsupported`
rather than boot a seat that silently loses a skill.

Two consequences the audit should hold together:

1. **Nothing under `skills/` is ever loaded by a crew seat.** Every skill in this repo
   serves the orchestrator session alone. Any skill sentence written in the second person
   to a *seat* is addressed to a reader it will never have.
2. **`crew/roles/reviewer.md:30-31` is the one place the boundary is crossed** — it routes
   the reviewer to load the do-not-flag guidelines *"via the `review-procedure` skill"*.
   Full evidence in `register-charters.md`; the short form is that the route cannot exist
   on either adapter, and the brief does not carry the guidelines either (`grep -n
   "guidelines\|do-not-flag" crew/drive.mjs` and the same over
   `scripts/factory/make-brief.mjs` both return zero hits).

So the boundary's second clause — *"discipline reaches seats through the brief"* — is
**aspirational for the two files in `crew/guidelines/`**. Neither
`review-do-not-flag.md` nor `seat-pre-return-checklist.md` is injected into any brief by
any code path. Both reach a seat only because a charter names their path and the seat opens
them itself. That works (every seat has `Read`/`Bash`), but it means the guidelines are
delivered by convention, not by mechanism, and the one charter that named a mechanism named
one that does not run.

---

## X3 — measured numbers are the repo's differentiator and they are not re-measurable

Epic #497 states the differentiator explicitly: *"nearly every rule we ship has a PR number
and a paid cost behind it — measured rules, not generic best practice."* Three headline
numbers in the always-on documents were re-derived today against
`~/.dev-team/factory/ledger.db` (read-only). Each derivation was run twice, by different
queries, because a surprising count from an instrument is not yet a fact.

| claim | file:line | re-measured today | verdict |
|---|---|---|---|
| "Measured over **164 archived lanes**, **43%** of first reviews bounce" | `crew/roles/builder.md:41-42` | **204** runs carry a recorded review; first-review `changes-needed` = **73/204 = 35.8%** | **stale** — population and rate both moved, and the sentence carries no as-of date |
| "unhandled edge paths (**19%**) and over-claimed verdicts (**13%**)" | `crew/roles/builder.md:43-44` | **not derivable** — `.schema` over the whole ledger has no column classifying a review finding into a family; the only `classification` column is `ci_cycles.classification`, which classifies CI failures | **unreproducible** — true or false cannot be established by anyone but the author |
| "Seeded from **49 archived runs**' review findings and the **13 lead accepts** that followed" | `crew/guidelines/review-do-not-flag.md:8` | as of the file's own commit day (`git log`: 2026-08-17), the ledger held **92** runs with reviews and **6** lead accepts; `accept_decisions` has held at most **6** `accepted` rows in its entire history (8 rows total, 2 `escalated`), spanning 2026-08-15 → 2026-08-21 | **49: plausible, unverifiable** ("archived runs" is a narrower population than "runs with a review" — `~/.dev-team/factory/preserved/` holds 79 today). **13: unreproducible** — the typed table has never recorded 13 accepts |

Queries, so the next reader does not have to reinvent them:

```sh
db=~/.dev-team/factory/ledger.db
sqlite3 -readonly $db "select count(distinct adw_id) from review_outcomes;"
sqlite3 -readonly $db "with f as (select adw_id, verdict,
  row_number() over (partition by adw_id order by created_at, id) rn
  from review_outcomes) select verdict, count(*) from f where rn=1 group by 1;"
# second derivation, same answer (73 / 131):
sqlite3 -readonly $db "select r.verdict, count(*) from review_outcomes r
  join (select adw_id, min(id) mid from review_outcomes group by adw_id) f
  on r.id=f.mid group by 1;"
sqlite3 -readonly $db "select outcome, count(*) from accept_decisions group by 1;"
```

One corroboration worth recording: `crew/guidelines/review-do-not-flag.md:19` says *"Six
archived runs ended with the lead refuting a must-fix"* — and `accept_decisions` holds
exactly **6** `accepted` rows. That the countable claim in the same file matches the ledger
exactly is what makes the uncountable one (13) worth flagging rather than assuming.

The pattern: every number in these documents that the ledger *can* reproduce, it does;
every number it cannot reproduce is the one that has drifted or cannot be checked. The
differentiator is real and the shipped numbers have no mechanism keeping them true.

---

## X4 — no check anywhere verifies a `file:line` anchor, and two independent anchors for one symbol are both wrong

`GATE_SUMMARY_PREFIX` is defined at **`crew/drive.mjs:325`**. It is cited by line twice, and
neither citation is right:

- `scripts/factory/make-brief.mjs:148-149` — "``GATE-SUMMARY {…}`` (`GATE_SUMMARY_PREFIX`,
  `crew/drive.mjs:70`)". `crew/drive.mjs:70` is inside `resolveWait()`, an unrelated flag
  parser. This text is `ACCEPTANCE_GATE_BLOCK`, stamped into **every compiled brief**
  (`scripts/factory/make-brief.mjs:1419-1420`) — including this task's own brief, where it
  is the first thing a planner reads about the gate.
- `crew/drive.mjs:1308` — "exactly as it already dictates `GATE_SUMMARY_PREFIX` (`:204`)".

Two authors, two different wrong lines, same symbol. That is not carelessness; it is the
absence of a mechanism. `crew/drive.test.mjs:752-762` proves the repo knows how to build
one — `implementation-file sections name existing files in both docs` reads
`## Implementation files` sections and asserts every named file exists. Nothing does the
equivalent for `path:line`.

This is exactly the class the repo's own checklist puts first:
`crew/guidelines/seat-pre-return-checklist.md:51` — **P1**, *"every file:line anchor you cite
resolves to what you say it does"* — a rule the always-on documents apply to seats and not
to themselves.

Anchors verified for this audit that **do** resolve, for contrast (so the finding is about
absence of enforcement, not about general rot): `crew/drive.mjs:700-701` → `crew/roles/reviewer.md:19-21` ✓;
`crew/roles/tech-lead.md:24` → `crew/drive.mjs:2217` ✓ and its reciprocal
`crew/drive.mjs:2217` → `crew/roles/tech-lead.md:22` ✓;
`docs/conventions.md:44` → `crew/adapters/adapter-claude.mjs:65-72` ✓.

---

## X5 — issue citations are load-bearing and unchecked

The charters and skills justify expensive discipline by naming the issue that paid for it.
Verified with `gh issue view` on every number cited in `crew/roles/`:

| cited | at | actual title | verdict |
|---|---|---|---|
| #330 | `crew/roles/planner.md:195` | Gate discrimination is whole-gate only: vacuous individual checks pass the proof | ✓ on point |
| #294 | `crew/roles/planner.md:154`, `crew/roles/builder.md:37` | pi arc 4: two-tier advisor on the builder seat | ✓ on point |
| **#193** | `crew/roles/planner.md:82` | SF-7b: batch/queue inside the daemon — autonomous factory as a mode, not a babysat loop | ✗ **unrelated** |
| **#199** | `crew/roles/planner.md:82` | a run's task envelope is per crew dir, so a crew dir cannot honestly be run twice | ✗ **unrelated** |

Neither #193 nor #199 is a PR either (`gh pr view 193` / `199` → *"Could not resolve to a
PullRequest"*). The issues that actually record the claim, found by searching the tracker
for its own subject, are **#222** (*"the planner charter says what files_in_scope is, never
how to discover it — twice now that cost a dispatch"* — the literal "twice" the sentence
means) and **#232** (*"the planner's discovery rule can't find a test that pins a config
file — it only greps code-shaped keys"* — the rule at `planner.md:74-75`).

The same numbers appear in the compiled brief's standing blocks, so the wrong citation
travels into every task. Issue numbers cited in the four brief-side blocks (#153, #168,
#240) were checked and all three are on point.

---

## X6 — one register grant is undiscoverable from the charters, one is adapter-blind

Not a contradiction, but the register-versus-charter gap that a seat pays for. Detail and
the full table are in `register-charters.md`; the cross-cutting shape:

- `crew/capabilities.json` grants `reviewer.tools: ["Task"]` (pinned `crew/crew.test.mjs:4226`,
  and `:4240` confirms `SEAT_DEFAULTS.reviewer.tools` is not the source). `crew/roles/reviewer.md`
  never mentions subagents. The planner charter spends a whole section on the same grant.
- `crew/roles/planner.md:13` names subagent types `"Explore"` and `"general-purpose"` — CLAUDE
  types. The register's pi overlay grants a differently-named agent:
  `capabilities.json` → `roles.planner.by_agent.pi.agents[0]` = `{"name": "scout", "def":
  "crew/pi/agents/scout.json"}`. A pi planner reading its charter is told to request
  subagent types it does not have.

---

## X7 — the one duplication that is already byte-identical, and therefore already a liability

`diff <(sed -n '64,75p' crew/roles/reviewer.md) <(sed -n '34,45p' crew/roles/tech-lead.md)`
returns **empty**: the entire "Perspective assignments" block, 12 lines, exists twice
verbatim. It describes a driver-issued assignment shape (`crew/drive.mjs:1856` reads
`details.recommendation`) that is identical for both seats and belongs in
`crew/roles/_shared.md`, which is already the mechanism for text every seat must follow.

The other duplications found (the mutation contract split between `crew/roles/planner.md:168-195`
and `MUTATION_CONTRACT_BLOCK`; the GATE-SUMMARY contract in three places; the two "Before you
return" sections) have **already drifted in wording** while still agreeing in substance —
which is the state just before they stop agreeing. Proposed single homes are in
`register-charters.md` § Overlap.
