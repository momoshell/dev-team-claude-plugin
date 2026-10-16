# ADR-050 — Seat skills are selected at dispatch, granted lazily, and their loads are measured

**Status:** *ratified* 2026-10-16, operator decision (answers in "Operator decisions" below) · **Owner:** operator ·
**Relates to:** ADR-045 (scope is context, not enforcement), ADR-046 (a policy decision is a ledger fact),
ADR-047 (per-seat grants in `crew/capabilities.json`), ADR-048 (ordered build steps)

A crew seat receives plugin skills in two ways, and nearly all of the bytes go through the eager one. This
record decides how a skill is chosen for a seat on a task, how it reaches the seat, and how we learn whether
the seat used it. It also fixes how third-party skills enter the plugin.

Every repository `file:line` below was read at `be85b8c3`.

## How seats get skills today (measured 2026-10-16)

**Selection.** `skills/skill-map.json` holds rules keyed by role and by path glob. `resolveSeatSkills`
(`hooks/skill-gate.mjs:60`) returns the skills whose rule matches the seat's role and the lane's fenced files.
`reachableSeatSkills` (`hooks/skill-gate.mjs:69`) returns every skill a role could ever receive.

**Delivery, eager.** `renderSeatSkills` (`crew/crew.mjs:2890`) strips each selected skill's frontmatter and
pastes the whole body into the seat's system prompt (`role-<role>.md`), up to `SKILLS_BYTE_BUDGET = 32768`
(`crew/crew.mjs:2864`). It is called once per role at boot (`crew/crew.mjs:3456`).

**Delivery, native.** `crew/capabilities.json` grants `skills/lean-build/SKILL.md` to every role through
`by_agent.<agent>.skills`. pi receives it as `--skill <path>`; claude receives it through a per-role plugin
directory (`crew/adapters/adapter-claude.mjs:262`). A native grant puts only the skill's name and description
in context; the seat loads the body when it chooses to.

**Cost.** `rolePromptBytes()` (`crew/crew.mjs:5312`) reports the worst-case prompt per role, with every
reachable skill pasted:

| Role | Prompt bytes | Pasted skill bytes | Share |
|---|---|---|---|
| reviewer | 39,394 | 26,882 | 68% |
| builder | 31,294 | 21,917 | 70% |
| planner | 40,199 | 18,317 | 46% |
| tech-lead | 24,388 | 13,147 | 54% |
| lead | 15,792 | 1,747 | 11% |

On typical lanes (research measurement, same day): a visualizer-lane reviewer carries 23,282 bytes of pasted
skills and a backend-lane builder 11,782. A planner on any lane that fences a test file carries
`qa-test-writing` (7,093 bytes) whatever the task. `lean-build` reaches every seat twice: pasted by the
`roles` rule and granted natively.

By contrast, the operator's own session pays 4,212 bytes for all eleven skill descriptions and 614 bytes for
the SessionStart skill-gate text. Claude Code already loads skills lazily there. The seats are where context
is spent.

**Evidence that an optional affordance goes unused.** Of 281 seats granted the lab MCP server, 5 ever called
it (memory `lab-usage-unproven`, 2026-09-25). A skill that is granted but not pasted may go unused in the
same way, so this record does not assume lazy delivery works; it measures it.

## Decision

### 1. Selection stays in the skill map, with two new inputs

The skill map remains the only selector. It gains:

- **Delivery per rule.** Each rule carries `delivery: "inline" | "grant"` (section 2). Absent means `grant`.
- **A role slice.** A rule may name one reference of a skill, `<skill>#<reference>`, for example
  `dev-team:qa-test-writing#gates` for `skills/qa-test-writing/references/gates.md`. A slice is delivered on
  its own: inline, it pastes that one file; granted, the index line points the seat at that file.

The effective set per seat is recorded in `crew.json` and in one journal row (`seat-skills`), with the rule
that selected every entry (`map-role`, `map-path`).

Each seat therefore gets its own version of a skill without a fork: one source file, sliced by role. Forked
per-role copies were rejected because each copy carries its own anchor pins and exhibits, and two copies of a
rule drift.

**Deferred: a per-task override at dispatch** (`skills: { add, drop }` in the lane request). The map with role
slices covers every known case, including prose skills on docs paths. The override is built when a lane
needs a skill the map cannot express, the same second-consumer rule as issue 509. The A/B's arm assignment
(section 4) is its own request field and does not need it.

### 1a. Role packs

A seat's inline content is its role pack. Everything else that matches is granted.

| Seat | Inline (always applied) | Granted (loaded on demand) |
|---|---|---|
| planner | `qa-test-writing#gates` — the planner authors every lane's acceptance gate | path-matched skills, index line only |
| builder | `code-less`, `qa-test-writing#vacuity` | `backend-node`, `frontend-svelte`, `ui-design`, `ux`, `prose-plain`, the rest of `qa-test-writing`, by path |
| reviewer | `pr-review` | `code-less`, `qa-test-writing#vacuity`, path-matched skills |
| tech-lead | `pr-review#falsification` — plan-check is falsification | `qa-test-writing#gates` |
| lead | none | none |

The planner, lead and tech-lead lose `code-less`: the ladder itself is in `crew/roles/_shared.md:57` and every
seat already receives it. The planner's worst-case pasted skill bytes fall from 18,317 to about 6,000.

### 1b. `lean-build` is renamed `code-less`

`lean-build` named a mood, not a rule. The skill holds this repository's worked examples for the ladder, so it
is renamed `code-less`, paired with the prose skill `prose-plain` (section 6) so that a seat's index never
confuses code advice with writing advice. The `lean:` comment markers that `scripts/factory/lean-debt.mjs`
harvests keep their name: they are a code convention, not the skill's name.

### 2. Two delivery tiers

| Tier | What the seat receives | For |
|---|---|---|
| `inline` | The full body (or the one slice), pasted as today | The role pack (section 1a): rules the seat must apply on every assignment |
| `grant` | A native grant, plus one index line in the prompt: name, one-sentence trigger, and the globs it covers ("load before editing `visualizer/**/*.svelte`") | Every path-matched skill: `backend-node`, `qa-test-writing`, `frontend-svelte`, `ui-design`, `ux`, and new skills |

Skill `references/` keep loading only when read, as today.

Grants are materialized per lane and per seat at boot. For pi, one `--skill <path>` per granted skill. For
claude, the per-role plugin directory holds links to exactly the granted skills, not a fixed bundle. A skill
that is `inline` for a seat is never also granted to it, which ends the double delivery of `lean-build`
(now `code-less`).

The `## Plugin skills` section keeps its delivery status lines (`delivered`, `over-budget`, `unreadable`) and
adds `granted` for the new tier. A grant that could not be materialized is a status with a reason, never a
silent omission.

### 3. Loads are measured before anything is enforced

The driver writes a `skill-loaded` journal row when a seat loads a granted skill: a `Skill` tool call on a
claude seat, or a read of a granted `SKILL.md` path on a pi seat. The row names the role, the assignment, the
skill and the transport. A transport whose loads cannot be observed records the cell as unmeasured with a
closed reason, never as zero loads.

The ledger reports, per role and skill: seats granted, seats that loaded before their first edit to a covered
path, seats that edited a covered path without loading, and seats that never touched a covered path. Every
rate carries its denominator, and a cell below `CELL_RATE_FLOOR` reads `thin`.

### 4. An A/B decides whether grants become the default

Arm A pastes path-matched skills (today's behaviour); arm B grants them. Arms are assigned per lane and
recorded in the `seat-skills` row. Outcomes, stratified by role and builder cell:

- load rate in arm B (section 3);
- first-round review pass rate;
- reviewer findings whose category matches a granted skill's domain;
- system-prompt bytes and cache-read tokens per seat.

`grant` becomes the default for path-matched skills, per role, when both hold at `CELL_RATE_FLOOR` (12) lanes
per arm:

- arm B's first-round review pass rate is not lower than arm A's; and
- in arm B, at least **80%** of the seats that edit a covered path loaded the covering skill before their
  first such edit. Seats that never edit a covered path are outside the denominator, not misses.

80% is a policy choice, not a measurement: at that rate one seat in five edits without the skill. A role that
keeps its pass rate but misses 80% gets enforcement (section 5), not a return to pasting. A role whose pass
rate falls stays `inline`, and this record is amended.

### 5. Enforcement only where the load rate is too low

If a role's load rate is below the threshold, enforcement exists for both agents:

- **claude seats:** `hooks/skill-gate.mjs` already denies an edit to a mapped path until that path's skills
  are loaded; it is switched off for every worker (`hooks/skill-gate.mjs:151`, `DEVTEAM_WORKER=1`). The
  change is to keep it on for builder seats.
- **pi seats:** a builder extension does the same, alongside `crew/pi/extensions/builderloop.ts`.

Enforcement is a separate lane, dispatched only on the A/B's data.

### 6. Third-party skills are adapted, never vendored

A third-party skill enters the plugin the way ponytail did (commits 28804088, 0e2073b2, 3d2ee2e5, 52dc9a48,
069bc816): rules that every seat must apply go into a charter under `crew/roles/`, this repository's worked
examples go into a slim skill under `skills/`, and anything a script can check goes into a zero-dependency
script under `scripts/factory/`. The licence goes into `THIRD-PARTY-NOTICES.md` and `docs/licenses/`.

Applied to the two repositories read on 2026-10-16:

- **petergyang/no-ai-slop** (MIT, one 10,853-byte skill): a slim `prose-plain` skill, granted by a map rule on
  `docs/**/*.md`, `skills/**/*.md` and `crew/roles/*.md`; and a zero-dependency lint for its mechanical
  patterns (the banned-word list, em dashes, recap endings), run over PR and commit bodies. Not a charter rule:
  the charters stood at 48,780 of a 49,135-byte budget when ponytail landed.
- **jakubkrehel/skills** (MIT, fourteen skills): no skill is vendored. The "before you finish" tables of
  `better-accessibility` and `better-colors` are adapted into `skills/ux/references/` and
  `skills/ui-design/references/`, which load only when read. The rest need a browser, Figma or a
  component runtime this repository does not test against, or overlap `ux`, `ui-design` and `pr-review`.

## Estimated effect

With path-matched skills granted, a visualizer-lane reviewer goes from about 23 KB of pasted skills to about
7 KB, and a backend-lane builder from about 12 KB to about 2 KB, per seat per assignment. A seat that loads a
granted skill pays its body again, so the saving is real only for seats that do not need the skill on that
assignment. These figures are estimates from the research pass; the A/B measures them.

## Rejected

- **Raise or lower `SKILLS_BYTE_BUDGET`.** It moves the cut-off and changes nothing about what a seat needs.
- **Paste bodies only into the builder.** The reviewer carries the most skill bytes (68%), and its findings
  depend on the same rules.
- **Enforce first.** Enforcement without a measured load rate cannot say whether it is needed, and it adds a
  refusal path to every builder edit.
- **Vendor third-party skills whole.** No-ai-slop alone is larger than four of this repository's skills, and
  most of jakubkrehel's skills target surfaces this repository does not have.

## Lanes

1. **Delivery tiers and role packs.** `delivery` and `<skill>#<reference>` slices in the skill map, the role
   packs of section 1a, per-lane grant materialization for both agents, the `granted` status line, the
   `seat-skills` journal row, and the rename of `lean-build` to `code-less`.
2. **Load measurement.** The `skill-loaded` journal row and the ledger load-rate report.
3. **The A/B,** then enforcement only if section 5 applies.
4. **Third-party adaptations.** The `prose-plain` skill and lint, and the two reference tables.

Lanes 1 and 2 are independent; lane 3 needs both; lane 4 needs 1.

## Operator decisions (2026-10-16)

1. **Each seat gets its own version, by slicing, not forking.** `code-less` is inline for the builder and
   granted to the reviewer; the reviewer's lean judgement stays in `pr-review` and its charter. Planner, lead
   and tech-lead drop it.
2. **The planner keeps only the gates slice of `qa-test-writing`,** inline, because it writes every gate.
3. **The per-task override is deferred** until a lane needs a skill the map cannot express.
4. **The default flips at 80% loads before a covered edit, at 12 lanes per arm, with no loss of first-round
   pass rate;** a role below 80% gets enforcement rather than pasted bodies.
5. **Names:** `lean-build` becomes `code-less`; the no-ai-slop adaptation is `prose-plain`.
