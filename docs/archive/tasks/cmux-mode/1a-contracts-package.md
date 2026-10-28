# Architecture Package — Slice 1a: cmux contracts freeze (issue #2)

**Author:** architecture-lead · **Date:** 2026-08-01 · **Revision:** v2.1 (v2 + re-review corrections N1–N9, applied by orchestrator per reviewer authorization) · **Status:** plan-reviewer verdict **APPROVE** (conditional corrections applied); pending user ratification
**Artifact decision:** **TRD/RFC + ADR + execution plan.** No PRD-lite (actors, workflow and success criteria are settled by epic #15 and v2). The TRD content is Section 2 (the frozen contract, now with complete per-schema property tables); Section 4 proposes one new ADR plus the six ratifications; Section 3 is execution-ready.

**Canonical sources cited throughout (all absolute):**
`/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/architecture-amendment-package-v2.md` (v2) · `/Users/x/Development/dev-team-claude-plugin/tasks/cmux-mode/spike-findings.md` · `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/architecture-notes.md` · `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/conventions.md` · `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/config.md`

**Governing principle for every scope call below (unchanged):**
> **1a freezes every artifact that crosses a process or trust boundary. Everything parent-internal stays with the slice that builds it.**

Under it: roster (human ↔ dispatcher), dispatch record (dispatcher → adapter → worker-side hooks), return envelope (worker → parent), signal record (worker → parent) are **in**. `task.json` and await-loop state are **out**. *(Revision: the plan review correctly applied this principle against my own draft — the Stop gate's block counter crosses into the worker's process tree, so it is now **in**; see finding 2.)*

**Second governing principle, unchanged:** **structural impossibility beats a test assertion.** Where a rule can be encoded so that violating it produces an *invalid document* rather than a *failing test*, encode it that way. *(Revision: extended by findings 7 and 12 — where a constraint must be enumerated, prefer a **whitelist** over a blacklist. Both defects the reviewer found in F-9 and E-4 were blacklists that had quietly gone stale.)*

---

## Findings resolution

Plan review: `REVISE`, 17 findings (9 MUST-FIX, 1 must-fix-if-not-deferred, 7 nice-to-have). Architect second opinion on R-B: **endorse Option B**, 4 riders + 1 optional carve-out. Every item below ends in adopted / amended / declined.

| # | Finding | Disposition | Landed in |
|---|---|---|---|
| **1** | `build-validator` cannot run a build under the two-profile taxonomy | **Adopted, amended** — a **third profile `validator`** (not the coordinator's "executor without worktree_write": grant sets are per-profile, so that phrasing *is* a third profile). F-3's rule is restated as *one profile per distinct grant-token set*, which **generates** this profile rather than being violated by it. Per-role grant subsets explicitly declined. | F-3, §2.5 roster tables, ADR-013 |
| **2** | Closed env set omits paths v2's worker-side hooks require; gate counter misclassified as parent-internal | **Adopted, both halves.** Env grows to **eight** keys — adds `DEVTEAM_SIGNAL_LOG` and `DEVTEAM_GATE_COUNTER` (not `DEVTEAM_STATE_DIR`: least privilege — hand each hook its one file, never the state root). The gate-block counter is **frozen as a contract** (parent-side file, format + forge bound stated). Key list is now derived from a complete inventory of worker-side hooks, which ADR-012 closes. | D-8, §2.5 record table, A10 |
| **3** | Section 2 is a delta table, not the complete interface contract | **Adopted** — the heart of this revision. **§2.5 publishes full property tables** (name / type / required / constraints / source-ruling) for all five schemas, paste-ready for be-1a-A. | §2.5 (new) |
| **4** | `signals_path` missing from the record | **Adopted** — required field; D-6's filesystem-path enumeration corrected. | D-6, §2.5 record table |
| **5** | `surface` collides with D-11's immutability redefinition | **Adopted** — record lifecycle is **three states, two permitted transitions** (`create` → `bind` → `terminate`), each atomic tmp+rename, monotone null→set. Moving `surface` parent-side declined: the record is the single source of truth for a dispatch's identity and recovery reads it alone. | D-11, §2.5 record table |
| **6** | Attention tokens published into a worker-readable file; residual unlisted | **Adopted, and fixed rather than merely disclosed** — **dispatch records move parent-side** to `~/.dev-team/state/<task-slug>/dispatch/<stem>.json`. Nothing required them under TASK_DIR: hooks read them as subprocesses via `DEVTEAM_DISPATCH_RECORD`, not as tool calls. Residual (Bash-subprocess reads, U-7 class) stated, and the "don't imply unforgeability" correction applied to my own package. Recorded as **rider C on ADR-006 Am. 1** — a layout tightening, not a reversal. | Section 1 row 3, D-7b, D-8, ADR-013 |
| **7** | `slice_id` unconstrained yet flows into rule strings and paths; F-9's charset is an incomplete blacklist | **Adopted, both** — `SLICE_ID_RE` frozen; F-9's blacklist replaced by a **whitelist** charset for validation commands. | F-5, F-9, §2.5 |
| **8** | E-1(c) reader-refusal has no implementation owner and no test | **Adopted** — `validate()` gains a named `schema_version_too_new` violation; exercised in A3. Interacts with the E-1 carve-out below, and both are adopted together. | E-1, A3, §3.2 |
| **9** | F-8 requires a keyword the R-A budget bans; union `type` unspecified | **Adopted** — non-empty is `pattern: "\\S"`, bounded length is a pattern quantifier (`minLength`/`maxLength` stay out); `type` may be a **string or an array of type names**, spelled out in R-A. | R-A |
| **10** | F-2 rules nothing for markdown returns (validation + doc-tab renderability) | **Adopted, both halves resolved (not deferred).** (a) The record's `return` object carries resolved `required_sections` + `verdict_block`; the section-presence rule and `SECTION_HEADING_RE` are frozen, implementation is 1b's. (b) **The parent renders `returns/<stem>.md` from the envelope after validation** — worker writes exactly one file, and the human's viewport becomes a file no worker can write. | F-2, §2.5 envelope table, A10 |
| **11** | v2 hard-rule citations off by one | **Adopted** — rules 4/5/6/7/8/9 = v2:109/110/111/112/113/114; the cmux-allow acceptance is **v2:561** (not 559); Stop gate rank-3 is **v2:356**. Two further off-by-ones found and fixed: signals grant is **v2:136**, doc correction is **v2:178**, `postcondition_ignore` is **v2:373**. | throughout |
| **12** | E-4 overstates enforcement (COND_KEYS ≠ the banned list) | **Adopted, amended to a positive check** — slice A adds an inline **budget allow-list walk** to `test/schema.test.mjs` (every key ∈ BUDGET ∪ annotations), which is strictly stronger than extending a blacklist, and doubles as slice A's executable acceptance (finding 14). | E-4, §3.2, A1b |
| **13** | Precedence level 1 (frontmatter) is dead, not gutted | **Adopted** — **collapsed to four levels.** Frontmatter is not a precedence layer in cmux mode at all; it stays authoritative for subagent mode and supplies the role-prompt body. A live-but-unreachable layer in a frozen contract is worse than none. | E-2 |
| **14** | Slice A has no executable acceptance | **Adopted** — resolved by finding 12's budget walk plus a structural shape test; `roster.default.json` semantic validation stays in B where the validator lives. | §3.2, A1b |
| **15** | `resolveRole` has no caller in 1a | **Adopted, partially** — the **precedence semantics and signature are frozen here** (that is a contract); the **implementation and its test defer to 1b**, its first and only consumer. `slugify` and `shouldArchive` stay in 1a (F-5 is security-relevant; v2:435 assigns the predicate test to 1a by name). | E-2, §3.1, A10 |
| **16** | A9 self-contradictory | **Adopted** — reworded to "no existing test's assertions change; the `agents.test.mjs` edit is an import-site change with the same alias list." | A9 |
| **17** | A6 hard-codes a Phase-1 value | **Adopted** — `PANE_ROLES` frozen constant; test asserts set equality. A Phase-2 flip is two one-line edits (roster + constant); an undefended invariant is the only alternative. | A6, §3.2 |
| **R1** | Architect: rename tokens capability-shaped | **Adopted, one amended** — `returns_write`, `signals_append`, `worktree_write`, and **`validation_commands`** (not `spec_validation_commands`): finding 1's `validator` profile draws its commands from `config.validate.full`, not from a spec, so the `spec_` prefix would be wrong at birth. This serves the rider's own intent — name it once, now, capability-shaped and source-neutral. | R-B, §2.5 |
| **R2** | Architect: ADR-013 states the layering; 1b exposes `expandGrants(agent, tokens, ctx)` | **Adopted** — named as a 1b interface obligation with `agent` as a parameter, not an assumption. | ADR-013, A10 |
| **R3** | Architect: record's `profile.allow` grammar is agent-specific, discriminated by `agent` | **Adopted and strengthened** — stated in the schema description, *and* the composed profile carries `grants` (the agent-neutral token list it expanded from) alongside `allow`, so a future adapter reads intent instead of parsing claude grammar. | §2.5 record table, ADR-013 |
| **R4** | Architect: ADR-013 names two consequences — dependency prep is dispatcher-side; the future escape hatch is a pre-approved prefix-list field | **Adopted** — both recorded. (i) also downgrades U-6 from an open hazard to a decided policy. | ADR-013, U-6 |
| **E-1 carve-out** | Architect: input-vocabulary enum additions don't bump; interpreted-outcome ones do | **Adopted, with a sharpened discriminator** — *adding a value to an enum bumps `schema_version` iff any consumer branches on that enum with a documented default/else path.* Classification frozen in E-1. Adopted **together with finding 8**, since reader-refusal is the only protection left for the bump class. | E-1 |

**Nothing re-opened:** R-B (grant tokens), F-3's collapse rule, and the six-item ratification slate stand. Section 1 gains one rider forced by finding 6; the governing principles are unchanged.

---

## Section 1 — Ratification slate

Six items are `proposed` (v2:603-608, architecture-notes.md:10-15) and v2:484 makes 1a "unblocked on ratification of this package."

| # | Item | Recommendation | Why |
|---|---|---|---|
| 1 | **ADR-003 Am. 1** — completion nonce, ladder-only completion, best-effort attention (v2:387-395) | **Ratify with amendment (2 riders)** | Load-bearing for 1a's token model. **Rider A:** S25b proved `wait-for` latches are **consume-once** (spike-findings.md:420-427) — v2 §7.3's two-phase await collapses to a single repeating phase-1; record that so 1b doesn't build the pessimistic loop. **Rider B (correction):** v2:257 claims the rank-2 EXIT sentinel is "sited parent-side so a worker tool call cannot forge it." True for *tool calls*, **false for subprocesses** — G13's vector (`Bash(npm test *)` → repo-controlled script) reaches `~/.dev-team/state/` with the same uid. The sentinel's integrity rests on the same bound as a forged token: one wasted loop iteration, because the ladder re-derives. Say that; don't imply unforgeability. S20's durable-token finding (architecture-notes.md:16) already turns ladder re-derivation from prudent into load-bearing — same rider. |
| 2 | **ADR-005 Am. 1** — identical `--tools`, profiles differ only in allow rules (v2:397-407) | **Ratify as-is** | The single largest input to `roster.schema.json`; it kills 6 of the 13 contradictions on its own. Extends (does not supersede) the already-ratified D9 entry at architecture-notes.md:8. One named consequence rides with it (Section 5, U-2): under the six-tool set, **judgment roles lose `WebFetch`/`WebSearch` in cmux mode** — a real capability regression for `architecture-lead`/`plan-reviewer`, accepted for Phase 1, revisited when S25d has measured the non-Bash permission surface. |
| 3 | **ADR-006 Am. 1** — task artifacts at `~/.dev-team/tasks/<repo-slug>/<task-slug>/` (v2:409-413) | **Ratify with amendment (rider C) + evidence upgrade** | Evidence upgrade: S25c PASSED at the real path (spike-findings.md:429-435) — the `.dev-team` dot-name is not protected and `Edit(//abs/**)` scopes correctly there. **Rider C (forced by plan-review finding 6):** `dispatch/<id>.json` **moves out of TASK_DIR** to `~/.dev-team/state/<task-slug>/dispatch/<stem>.json`, amending v2:218's layout line. Nothing required it worker-readable — hooks read it as subprocesses via an env-supplied path, not as tool calls — while siting it under an `--add-dir` root published every sibling dispatch's attention tokens and kickoff to every worker, falsifying v2:274. This is a tightening in the direction of ADR-006's own rationale, not a reversal of it. |
| 4 | **ADR-009 Am. 1** — byte-stability = prompt bytes; per-task plugin snapshot (v2:415-421) | **Ratify as-is** | Determines `role_prompt_path` semantics. The contract tightens it one notch (D-9): a **single pre-composed** role-prompt file per role in the snapshot, with `role_prompt_sha256` recorded, so byte-stability is auditable from records rather than asserted in prose. |
| 5 | **ADR-012** — CLI permission rules primary, hooks for what rules can't express (v2:423-427) | **Ratify as-is** | Two 1a consequences, both useful. Negative: no per-file `PreToolUse` hook in the default profile ⇒ the roster profile schema needs **no** hook-configuration surface. Positive: ADR-012 **closes the inventory of worker-side hooks** (SessionStart guard, PostToolUse attestation, Stop gate), which is what makes D-8's env key list complete-by-construction rather than guessed. Ratifying now also unblocks 1c. |
| 6 | **`--append-system-prompt-file` over `--system-prompt`** (v2:608, architecture-notes.md:15) | **Ratify as-is, with the S23 re-test recorded as a revisit trigger** | 1a-load-bearing: the record carries `role_prompt_path` (a path), which presumes the file flag. Flag existence is live-verified (S22g, used in anger in S22f). |

**Not on the slate — already ratified, do not re-litigate:** the D9 cmux allow-list mechanism (architecture-notes.md:8; v2:399 says ADR-005 Am. 1 *extends* it).

**Recommendation: ratify all six** (two with riders, one with an evidence upgrade). None is a coin-flip; the evidence moved in each one's favour since it was drafted.

---

## Section 2 — The freeze

### 2.0 Two rulings that govern the rest

**R-A · Schema keyword budget.** Issue #2 line 98 is correct that `test/schema.test.mjs:23` hardcodes two filenames and therefore does not police the new schemas — so conditionals are *permitted*. **We decline the permission.**

- **Budget (the complete allow-list):** `$schema`, `title`, `description`, `type`, `required`, `properties`, `additionalProperties` (boolean **or** a schema object), `items`, `enum`, `const`, `pattern`, `minimum`, `maximum`, `minItems`, `uniqueItems`.
- **`type` may be a string or an array of strings** (union), drawn from `object array string integer number boolean null`. *(finding 9)*
- **Non-empty string is `pattern: "\\S"`. Bounded length is a pattern quantifier** (e.g. `^.{1,200}$`). `minLength`/`maxLength` are deliberately **not** in the budget — one idiom, one code path. *(finding 9)*
- `title`/`description` are annotations the validator ignores. The validator **throws** on any key outside the budget, so a future schema edit that reaches for a new keyword fails loudly instead of silently going unchecked.
- **Keyword applicability under union types** *(re-review N3)*: `properties`/`required`/`additionalProperties` apply only when the instance is an object; `pattern` only when it is a string; `minimum`/`maximum` only when it is a number; `items`/`minItems`/`uniqueItems` only when it is an array; `enum`/`const`/`type` apply always. A `null` instance under `type: ["object","null"]` is therefore valid without its object keywords — the record's `create` state depends on this.
- **Banned (non-exhaustive by design — the check is the positive allow-list, not this list):** `allOf anyOf oneOf if then else $ref contains patternProperties dependentRequired dependentSchemas $defs definitions not propertyNames unevaluatedProperties minLength maxLength default format`.

*Why:* there is **no JSON-Schema validator in this repo and adding one breaks its stated dependency-free property** (README.md:243). The validator is hand-rolled, so every keyword is code someone must write, review and trust. A fixed budget keeps it ≈80 reviewable lines and keeps the new files stylistically identical to the existing two. Semantics needing conditionals are prose in `description` — the established convention (`coder-return.schema.json:11-12`).

**Enforcement (revised per finding 12):** slice A adds the four new schemas to `test/schema.test.mjs`'s hardcoded list **and** an inline **positive budget walk** — every key in every node must be in the budget. Extending the existing `COND_KEYS` blacklist would have missed `contains`, `patternProperties`, `dependentRequired` and `$defs`; a whitelist cannot go stale. Slice B's `contract.mjs` exports `BUDGET`, and `test/cmux-contract.test.mjs` asserts the two lists agree (drift guard).

**R-B · Grant tokens, not rule strings.** *(Endorsed by the architect second opinion; not re-opened. Recorded here with the strongest argument, which the first draft buried.)*

- **Option A (issue #2 as drafted):** roster `allow` holds permission-rule strings with `${PLACEHOLDER}` interpolation. *Optimizes* expressiveness. *Sacrifices:* hard rules 4, 5 and 6 (v2:109, v2:110, v2:111) become properties of hand-authored config that only a test can defend — and the issue's own draft already violated rule 6 in three places and rule 5's spirit in two.
- **Option B (adopted):** roster `allow` is an array of **enum-constrained capability tokens** — `returns_write`, `signals_append`, `worktree_write`, `validation_commands` — and the **builder** owns every literal rule string.
  - **Decisive argument (architect's, adopted):** *reversibility asymmetry.* Adding a token is additive and cheap; removing rule-string `allow` from a shipped roster is a breaking, migration-bearing change to config living in user and project repos. **A is a one-way door; B is not.**
  - **Second argument:** tokens are agent-neutral capability declarations. `Edit(//abs/**)` is claude-CLI grammar; a future codex/opencode adapter under Option A would have to *parse claude rule strings back into intent*. Recovering intent from an expression is strictly harder and lossier than expanding intent into an expression.
  - **Stated cost (architect's, adopted):** the only remaining channel for a bespoke `Bash(...)` grant moves from a human-authored file (roster) to an **agent-authored** one (the lead's handover spec `validation_commands`). That is a **trust-boundary relocation, not a neutral simplification.** It is bounded by F-9's whitelist charset and the `Bash(<c> *)` wrapping, and the lead is inside the trust boundary already — but it is said out loud, here and in ADR-013.
  - **Third option (`extra_allow` escape hatch) — declined for 1a.** In rule-string form it re-imports every hazard. In structured prefix-list form (`validation_command_prefixes: ["cargo test"]`) it is plausible and is *not* the reintroduction this package first called it — it is a breadth risk, not a shape risk. Still declined **now**, because under E-1a an additive optional field is free to add later on evidence, whereas tokens-vs-rule-strings is not free to revisit. **The deferral is recorded in ADR-013 as the pre-approved shape**, so the future answer is a designed field rather than an improvised one.

### 2.1 The 13 contradictions with issue #2's inline JSON

| # | Issue #2 says | **Ruling** | Citation |
|---|---|---|---|
| **D-1** | `"deny": ["Bash(cmux *)"]` in all three profiles + in the dispatch record | **Drop, and make it unrepresentable.** The roster profile object has **no `deny` key** and `additionalProperties: false`, so a future `deny: ["Bash(cmux *)"]` is a schema violation, not a test failure. Tool-name denies are **invariant, not per-profile**: the record carries top-level `disallowed_tools`, `items.enum: ["mcp__*","Task","Agent"]` — `Bash(cmux *)` is unrepresentable there too. Renamed from `deny` deliberately: the name collision with permission-rule denies is what produced this bug. | architecture-notes.md:8 (ratified); v2:111 (hard rule 6); v2:141; v2:160 (MF3) |
| **D-2** | No cmux allows anywhere | **Add — as builder-injected invariants, not roster config.** Exactly two byte-identical literals `Bash(cmux notify *)` / `Bash(cmux wait-for -S *)` in **every** composed profile, including judgment and validator. cmux is not in the token enum, so a roster can neither delete, duplicate nor widen them. The record's composed `profile.allow` must contain both — prose + test (`contains` is outside the budget). | v2:111; v2:174 |
| **D-3** | Per-profile `tools` diverge (planner ≠ reviewer ≠ executor) | **Identical for every role, and hoisted out of profiles.** `tools` is a **top-level roster field**, `items.enum: ["Read","Edit","Write","Glob","Grep","Bash"]`, `uniqueItems`. The profile object has no `tools` key ⇒ divergence is unrepresentable. `WebFetch`/`WebSearch` are **not representable** (permission surface under `dontAsk` unverified — U-2). Array-not-`const`, so a future widening is config, not a schema edit. | v2:169; v2:404 |
| **D-4** | `allow: ["Edit(${RETURNS_GLOB})"]` — signals grant missing | **Add `signals_append`. `returns_write` + `signals_append` are mandatory in every profile** (`minItems: 2` + test). Judgment = exactly those two; validator adds `validation_commands`; executor adds `worktree_write` too. | v2:136; v2:158 |
| **D-4b** | (grants are directory-wide `returns/**`) | **Narrow to the dispatch's own files.** `returns_write` → `Edit(//<TASK_DIR>/returns/<stem>.json)`; `signals_append` → `Edit(//<TASK_DIR>/signals/<stem>.jsonl)`, `<stem> = <slice_id>.<attempt>`. Closes cross-dispatch return forgery outright. **Exact-file rule matching is not yet live-verified** (S22a/S25c both used `**`) ⇒ **probe S25f** rides with 1c. If it fails, the *token expansion* widens to `returns/**` — one line in `expandGrants`, **no schema change** (see U-12 for the two conditions that claim rests on). This reversibility is R-B's concrete payoff. | v2:109-110; spike-findings.md:429-435 |
| **D-5** | `Bash(git status *)` / `git diff *` / `git log *` allows | **Drop as noise.** Same reasoning v2 gives for omitting `Read(//<TASK_DIR>/**)`: a rule that changes no behaviour teaches readers that the allow list is a capability description, which it is not. Replaced by a *positive* obligation: each profile carries a required `description`, and the roster test asserts **no profile description matches `/cannot run commands/i`** — v2:178's mandated documentation correction becomes machine-checked. | v2:69 (G5); v2:159; v2:178; conventions.md:21 |
| **D-6** | `//abs/task-dir/specs/…`, "task dir is in the primary checkout" | **Task dir is `~/.dev-team/tasks/<repo-slug>/<task-slug>/`, outside every checkout; subdir is `spec/` (singular).** The issue's parenthetical rationale is deleted as factually wrong post-ADR-006 Am. 1. **And the correction the issue gets wrong in the other direction:** `//` is *permission-rule* anchoring syntax, **not** filesystem-path syntax. Two distinct patterns. Filesystem fields — `task_dir`, `spec_path`, `return_path`, **`signals_path`** *(finding 4)*, `cwd`, `worktree.path`, `primary_checkout`, `role_prompt_path`, `return.schema_path`, and the four path-valued env vars — use `^/[^/]` (absolute, **not** double-slash; POSIX leaves `//foo` implementation-defined). Permission-rule strings inside `profile.allow` use `^(Edit|Read)\(//.+\)$` or `^Bash\(.+\)$`. *(Re-review N8: `task_artifacts_root` is charset-constrained to `^/[A-Za-z0-9._/-]+$` — every rule-feeding path descends from it, and a root containing `)` or a space would pass field validation yet break the composed `RULE` strings.)* | v2:215-217; v2:65 (G2); v2:109 |
| **D-7** | `signal_token` + `DEVTEAM_SIGNAL_TOKEN` in env | **Remove both.** Replaced by `attn_parent` and `attn_upstream`, both **required non-null**, both **kickoff literals, never env** (env delivery needs the untested `Bash(cmux wait-for -S "$VAR")` form). Pattern `^devteam-<uuid>-attn$`. For an orchestrator-initiated dispatch `attn_upstream == attn_parent` — no null branch. **Disclosure fixed at source** *(finding 6)*: the record now lives parent-side, so these tokens are no longer readable by a sibling worker's tool calls. | v2:265-272; U13 v2:549; v2:274 |
| **D-7b** | — (how the schema *states* the nonce prohibition) | **Three mechanisms, all three used.** (i) **Structural:** `additionalProperties: false` at *every* object level and no property anywhere that could hold a completion token ⇒ the nonce is unrepresentable in a valid record. (ii) **Prose,** in the top-level `description`: *"This record is written parent-side and is not reachable by a worker's tool calls; a Bash subprocess can nonetheless read parent-side state (G13). The completion nonce (ADR-003 Am. 1) MUST NOT appear in this record in any field, including free-text fields; it is delivered via `~/.dev-team/state/<task-slug>/<dispatch_id>.nonce`, mode 0600, read-and-unlinked by the adapter before `claude` exists."* (iii) **Mechanical:** `NONCE_PREFIX = 'devteam-done-'` is a frozen constant, so the record writer (1b) and the argv builder (hard rule 9) both assert by substring scan over serialized bytes. **The nonce path is also prohibited from the record.** | v2:245-246; v2:255; v2:114 |
| **D-8** | `DEVTEAM_GATE_DIR` | **Drop — no such concept** (the gate is a Stop hook, not a directory). **Env is a closed eight-key set**, `additionalProperties: false`, all required *(revised per finding 2)*. Each key is justified by exactly one worker-side hook consumer, and ADR-012 closes that inventory: `DEVTEAM_WORKER` (SessionStart neutralization guard, issue #5) · `DEVTEAM_ROLE`, `DEVTEAM_TASK_ID` (attestation/telemetry fields) · `DEVTEAM_DISPATCH_ID` (attestation identity) · `DEVTEAM_TASK_DIR` (PostToolUse path matcher) · `DEVTEAM_DISPATCH_RECORD` (Stop gate reads `gate.max_blocks`) · `DEVTEAM_SIGNAL_LOG` (PostToolUse append target) · `DEVTEAM_GATE_COUNTER` (Stop gate block counter). **`DEVTEAM_STATE_DIR` remains omitted** — handing a hook its one file is least privilege; handing it the state *root* discloses the nonce path, every sibling's sentinels and the plugin snapshot for no benefit. Adding a ninth key is a deliberate `schema_version` event, and that friction is the feature. | v2:356; v2:420; v2:328; v2:225 |
| **D-9** | `role_prompt_path` + `addendum_path` under `<plugin-root>/` | **One pre-composed file per role inside the per-task snapshot; `addendum_path` dropped.** `role_prompt_path` = `~/.dev-team/state/<task-slug>/worker-plugin/roles/<role>.txt` (role body + static profile addendum, frontmatter stripped, composed at snapshot time). Two files would require a **repeatable** `--append-system-prompt-file`, which is unverified (U-3). **`role_prompt_sha256`** (required, `^[0-9a-f]{64}$`) makes byte-stability auditable from records; the cross-dispatch stability test is 1b's (A10). *(Re-review N1: the static profile addendum must carry the return-envelope shape and state that `dispatch_id` arrives in the kickoff and that `slice_id`/`attempt` are derivable from the `return_path` stem — the record is parent-side, so the prompt is the worker's only instruction channel for the envelope contract.)* | v2:120-122; v2:305-309; v2:421 |
| **D-10** | `postcondition_ignore` missing | **Add.** Roster profile: optional array of globs, omission ⇒ `[]` (prose default — no `default`-keyword precedent in this repo). Record: **required, explicit** (may be `[]`) — v2:373 requires every entry be logged so an ignore never hides silently. **Explicit exception to D-6:** these globs filter `git status --porcelain`, which is repo-relative ⇒ the pattern forbids a leading `/` and any `..` segment. The `validator` profile is the one that will legitimately carry entries (build artifacts), which is a second coherence argument for finding 1's third profile. | v2:373 |
| **D-11** | `outcome` missing; "records are immutable once written" | **Add, and define the lifecycle** *(revised per finding 5)*. Enum exactly `{ok, exit_nonzero, no_return, invalid_return, refused_postcondition, timeout, aborted}`, type `["string","null"]`. **Three states, two permitted transitions, each written atomically (tmp + rename):** `create` (T0, before pane creation — required, because the pane is handed `DEVTEAM_DISPATCH_RECORD`) → `bind` (T1, after `cmux new-pane` returns ids: `surface` + `bound_at` set) → `terminate` (T2: `outcome` + `ended_at` set). **Immutability restated:** transitions are **monotone** (null → set; never set → null, never set → a different value); every other field is byte-identical across all three states; `dispatch_id` is never reused. Archive predicate is defined over `enum ∪ {null}` where **`null` ⇒ archive**, so a crash between any two transitions fails closed. | v2:431-435 |
| **D-12** | `isolation: "worktree"`, worktree keyed to `task_id` | **`isolation ∈ {worktree, primary}` and is declared per role in the roster; worktrees keyed to `slice_id`; rooted outside every checkout.** Keying to `task_id` serialises parallel executors and creates cross-slice interference no permission rule can see — the issue contradicts itself anyway (path keyed by task, branch `dt/be-02` keyed by slice). Frozen: path `<task_artifacts_root>/worktrees/<repo-slug>/<task-slug>/<slice_id>`, branch `dt/<task-slug>/<slice_id>`, reused across attempts of the same slice. `primary` ⇒ `worktree: null`, `cwd` = primary checkout (leads/planners). Reviewers and `build-validator` use `isolation: worktree` with `created_by_dispatcher: false` and **no** `worktree_write` grant. **Required `primary_checkout`** on every record — the §9.2 post-condition targets it and must be auditable, not re-derived. **Closes U14/S25e** (worktrees are no longer under `.claude/worktrees/`). Schema-expressible: absolute + no protected component. Not schema-expressible ⇒ prose + 1b builder test (A10): `worktree.path ≠ primary_checkout`; `task_dir` outside every checkout. | v2:113 (hard rule 8); v2:374-375; v2:504; conventions.md:23 |
| **D-13** | "never blanket Edit/Write deny alongside a scoped grant" | **Keep the intent; the assertion is subsumed by R-B and D-1** — with no `deny` field and an enum-constrained `allow`, the shape is unrepresentable. Replace the test with v2:561's stronger acceptance, applied to the **record's composed** profile: exactly the two cmux allows, zero `Bash(cmux` denies, every path rule `//`-anchored, every rule kind in `{Edit, Read, Bash}`. | v2:66; v2:402; **v2:561** |

### 2.2 Issue-only rules, unreviewed by v2

| # | Rule | **Ruling** |
|---|---|---|
| **E-1** | Schema evolution policy | **Bless, with four amendments.** (a) **`schema_version` in every file** (the issue used `version` in the roster, `schema_version` in the record). (b) **Start at 1, not 2** — "migrate 1→2" would name a migration that never existed. (c) **The reader's half, which the issue omits:** a reader encountering a **higher** `schema_version` than it knows **refuses**; it does not best-effort. Not theoretical — §7.5's per-task worker-plugin snapshot means a long task can run a snapshotted reader against a record written by an updated dispatcher. *(finding 8)* **Owner: `validate()`, as a distinctly named `schema_version_too_new` violation, exercised in A3.** (d) **Enum-addition carve-out** *(architect Q2c, adopted with a sharpened discriminator)*: *adding a value to an enum bumps `schema_version` **iff** any consumer branches on that enum with a documented default/else path.* Where no such path exists, an unknown value already fails validation closed with a precise error, and a bump is redundant belt. **Frozen classification — no bump:** `tools`, `profile.allow` grants, `permission_mode`, `isolation`, `agent`, `return.kind`. **Bump:** `outcome`, `level` (v2:329 gives it an explicit default: unknown ⇒ `progress`), `escalate_to`, `postcondition`. When in doubt, bump. Policy text lives verbatim in each schema's top-level `description`. |
| **E-2** | 5-level precedence chain | **Amend to four levels; frontmatter is not a layer** *(finding 13)*. Frozen chain (lowest→highest): `roster.default.json` → `~/.claude/dev-team/roster.json` → `<project>/.claude/dev-team/roster.json` → **session override (reserved)**. *Why frontmatter is out entirely:* letting it feed `tools`/`disallowedTools`/`permissionMode` would let `agents/code-reviewer.md`'s `disallowedTools: Edit, Write, NotebookEdit` re-introduce the exact blanket-deny-beside-scoped-grant shape ADR-005 Am. 1 forbids; and restricting it to `model`/`effort` leaves a layer that can never win, since `roster.default.json` supplies both for all 12 roles. A live-but-unreachable precedence layer in a frozen contract is worse than none. `agents/*.md` remains authoritative for **subagent/workflow mode** and supplies the role-prompt body (D-9). *Why level 4 stays reserved:* `/dev-team:team roster …` does not exist (verified: `commands/team.md` has no `roster` subcommand); 1a ships **no** command change but freezes the semantics now, because retrofitting precedence later is the expensive half. **Signature frozen here, implementation deferred to 1b** *(finding 15)*: `resolveRole(role, { plugin, user, project, session }) -> ResolvedRole`, last-writer-wins per property, deep-merge on `return`. |
| **E-3a** | `max_turns` reserved | **Keep.** `["integer","null"]`, `minimum: 1`, `null` = no cap. Maps to a real CLI flag and a Phase-3 consumer; one property now beats a version bump later. |
| **E-3b** | `verdict_block` reserved | **Keep.** Boolean, prose default `false`. Not an invention — it forward-wires ADR-010 (machine-readable verdicts), which the epic already carries. |
| **E-3c** | `gate.mode: "enforce"` reserved | **Drop.** No ADR defines a non-enforce mode; the Stop gate is unconditional under ADR-012. A reserved field with an undefined value set invites `"advisory"` to be invented at 1b time with no review. Keep `gate.max_blocks` only. |
| **E-4** | "conditionals are allowed in these two files" | **Correct, and declined** — see R-A. Enforcement is a **positive budget walk**, not an extension of `COND_KEYS`, because the blacklist had already gone stale against the budget *(finding 12)*. |

### 2.3 Rulings the issue does not raise but the freeze requires

| # | Item | **Ruling** |
|---|---|---|
| **F-1** | `dispatch_id` is overloaded (`"be-02.1"` vs v2:276's UUID) | **Three fields.** `dispatch_id` = **UUID** (used in `attn_parent`, `DEVTEAM_DISPATCH_ID`, and to key parent-side per-dispatch state files); `slice_id` = human label (`be-02`), **now pattern-constrained** *(finding 7)*; `attempt` = integer 1-99. **Task-dir artifacts are named `<slice_id>.<attempt>`** (`returns/`, `signals/`) — unique per attempt and human-readable in doc tabs and escalations. `spec/<slice_id>.json` carries no attempt (the spec is per slice, reused across attempts). |
| **F-2** | Return-schema alignment (v2:484) is impossible as stated: the ladder's clause (v) needs a `dispatch_id` inside the return, `coder-return.schema.json` cannot carry one, and 7 of 12 roles return markdown | **`return-envelope.schema.json`.** The worker writes `{schema_version, dispatch_id, slice_id, attempt, role, produced_at, body}`; `body` is `["object","string"]`. Validation is **two-step in code** (envelope, then `body` against `record.return.schema_path` for `kind: json`, or against `record.return.required_sections` for `kind: markdown`), needing no `$ref`. **Markdown rules frozen** *(finding 10a)*: a required section is present iff `body` contains a line matching `SECTION_HEADING_RE = /^#{1,6}\s+<section>\s*$/m`; implementation is 1b's. **Doc-tab renderability** *(finding 10b)*: after the ladder validates, **the parent** writes `returns/<stem>.md` from `body` and mounts the doc tab on it. The worker writes exactly one file; the `.md` sibling is **not** covered by any grant, so the human's viewport is a file no worker can write. *(Re-review N4: this guarantee holds only under D-4b's exact-file grant — if S25f fails and the expansion widens to `returns/**`, the parent-rendered file **moves outside `returns/`** to `render/<stem>.md`, keeping the viewport worker-unwritable. Condition added to U-12.)* Owner: 1b. **`coder-return.schema.json` and `handover-spec.schema.json` are not modified by 1a — an explicit non-goal**, keeping the workflow-mode contract and its deep-review blast radius (config.md:41) out of this PR. |
| **F-3** | Profile taxonomy | **The rule: one profile per distinct grant-token set — no more, no fewer.** ADR-005 Am. 1 makes `planner` and `reviewer` byte-identical, so they collapse. `build-validator`'s job is executing the validate lane, which is neither `judgment` (no command grant ⇒ it cannot run a build — *plan-review finding 1*) nor `executor` (a validator that can Edit the tree it validates is not a validator, and the post-condition could not tell its writes from an executor's). **Three profiles: `executor`, `validator`, `judgment`.** **Declined alternatives:** *(a) build-validator → executor* — grants write access to the artifact under test; *(c) per-role grant subsets* — re-introduces per-role divergence, which is what this ruling exists to prevent, and destroys the profile as the unit of security review. Each profile also declares `postcondition ∈ {clean, changes_expected}` (v2:374), which 1b must branch on and which was previously implicit in the profile's name. |
| **F-4** | `execution_mode: "cmux"` at roster top level | **Drop from the roster.** Shipping it would flip execution mode on for every installed copy the moment 1a merges. Mode selection is a `config.md` key (`execution_mode: subagent \| cmux`, default `subagent`). **Owner named** *(reviewer's gap)*: **#3 / slice 1b** — it is the first slice that can honour the switch (nothing before it can dispatch), and the change is one config key plus one branch at the dispatch entry point. If epic #15 carries a later integration sub-issue that fits better, that supersedes; orchestrator lookup, since I have no authenticated access. **"1a is inert" is an acceptance criterion** (A9). |
| **F-5** | Slug derivation unspecified, and it feeds filesystem paths | **Freeze `slugify()` in 1a** with traversal tests. `repo_slug` = basename of `primary_checkout`, slugified; `task_slug` = slugified task id/title, ≤60 chars; both `^[a-z0-9]+(-[a-z0-9]+)*$`. Security-relevant (path traversal into `~/.dev-team/`) ⇒ 1a, not 1b. |
| **F-6** | `permission_mode` | **`enum: ["dontAsk"]` — closed.** `plan` mode is unrepresentable, stronger than issue #2's "test asserts no profile uses plan mode." One meta-test asserts the enum is exactly `["dontAsk"]`, to catch a future widening. |
| **F-7** | `disable_slash_commands` / `--strict-mcp-config` as per-profile config | **Invariants, not config.** Removed from the roster; recorded at record top level as `flags: { strict_mcp_config: true, disable_slash_commands: true }` with `const: true` on each — auditable, unconfigurable. **Tested in A3** (a record with `flags.strict_mcp_config: false` must fail validation), not deferred. |
| **F-8** | `model` validation | **Schema types it `pattern: "\\S"`; the *test* enforces the alias whitelist** via `MODEL_ALIASES`. One source of truth beats duplicating an alias list into a regex that will drift. *(finding 9 resolved the keyword question.)* |
| **F-9** | `validation_commands` expansion rule | **Frozen, as a whitelist** *(finding 7)*. For each trimmed command `c`, emit `Bash(<c> *)`. `c` must match `^[A-Za-z0-9 _./:=@+-]{1,200}$` and contain no `..`. This bans `( ) ; | & $ < > \` " ' \ * ? { } [ ]` and newline in one stroke — the previous blacklist missed parentheses and quotes, any of which can terminate or blur a `Bash(...)` rule. Verified against real commands: `node --test`, `npm test -- items`, `npm run typecheck`, `pytest tests/foo -k thing`. **Source by profile:** `executor` ⇒ the dispatch's spec `validation_commands` (already narrow per handover-spec.md:15); `validator` ⇒ `config.validate.full`. **Refusal path** *(re-review N7)*: a source command failing `CMD_RE` ⇒ the dispatcher **refuses the whole dispatch and escalates** — it never silently drops the offending command (fail-closed; a validator running a subset of the lane would report a vacuous green). Per-repo `postcondition_ignore` entries for build artifacts belong in the project-level roster (E-2 level 3), not the shipped default. Residual R1 (repo-controlled scripts) restated in the schema description. |
| **F-10** | `roles` ↔ `agents/` relationship | **Partition, not subset.** `roles ∪ SUBAGENT_ONLY == listAgents()`, `SUBAGENT_ONLY = ['architect','trd-reviewer']`. A subset check silently tolerates a new agent nobody made a roster decision about; the partition forces the decision. |
| **F-11** | Parent-side sidecar file formats | **Prose only, in `dispatch-record.schema.json`'s description.** `<dispatch_id>.exit` = the child's decimal exit code. `<dispatch_id>.gate` = the Stop gate's decimal block counter *(new, finding 2)*. `<dispatch_id>.nonce` = mode 0600, read-and-unlinked. `<dispatch_id>.signal-log` = one attested JSON line per observed signal write. All four are subprocess-forgeable (U-7); each one's blast radius is bounded by ladder re-derivation — a forged `.gate` at most stops the gate from blocking, after which the dispatch terminates as `no_return`. Three sentences; not worth four schemas. |

### 2.4 Scope boundary

| Item | **Ruling** | Rationale |
|---|---|---|
| **Signal-record schema** | **IN #2.** Ships as `signal-record.schema.json` plus frozen `SIGNAL_LIMITS = { max_relayed_per_dispatch: 5, min_interval_s: 30, message_max_chars: 200 }` and the documented parent-side rules. | Pure worker→parent boundary contract; v2:484 and v2:563 both place it in 1a. |
| **v2:563's tests** | **Split.** 1a: schema + constants + a test that the constants match the schema's documented limits. **1b:** malformed/over-limit lines recorded-not-relayed. **1c:** "no path in the system emits a nudge from the hook." | A test cannot precede the code it exercises. |
| **argv builder** | **OUT of #2 — stays in #3/1b** (`scripts/cmux/dispatch.mjs`), per the issue decomposition. v2:486 called 1c "profiles/argv"; the issues are the execution reality. The 9 hard-rule tests ride with the builder; rules 6 and 9 are additionally asserted live in 1c's S25d smoke. | It is code, and 1a is a freeze. |
| **Gate-block counter** | **IN #2** *(revised, finding 2)* — the Stop gate runs in the worker's process tree, so the counter crosses the trust boundary and the governing principle puts it in the freeze. Frozen as a parent-side file + `DEVTEAM_GATE_COUNTER` + `gate.max_blocks`; the hook that consumes it is 1c's. | The reviewer applied my own principle against my draft; it holds. |
| **`resolveRole` implementation** | **OUT — semantics frozen here, code ships with 1b** *(finding 15)*. | Its only consumer is the dispatcher; uncalled code in a freeze is speculative. |
| **All 9 hard rules must be *expressible* from what 1a freezes** | **Proof obligation discharged below.** | This is the actual test of whether the freeze is sufficient. |

**Hard-rule expressibility from the 1a freeze** (citations corrected per finding 11):

| Hard rule | What 1a freezes that makes it checkable |
|---|---|
| 1 · bare `--` before kickoff (v2:106) | `kickoff` is a distinct record field ⇒ builder asserts `argv[-2] === '--'` |
| 2 · string array, no shell (v2:107) | `kickoff` pattern forbids `\n`/`\r`; the role prompt is a **path**, never bytes in argv |
| 3 · one element per rule (v2:108) | `profile.allow` is an array in the record ⇒ element-count assertion |
| 4 · `//`-absolute in rules (v2:109) | `profile.allow` item pattern requires `Edit(//` / `Read(//` — straight from the schema |
| 5 · rule-kind whitelist (v2:110) | same item pattern: `^(Edit\|Read)\(//.+\)$` or `^Bash\(.+\)$` |
| 6 · no cmux deny, exactly two allows (v2:111) | `disallowed_tools` `items.enum` excludes every `Bash(` form; `CMUX_ALLOWS` frozen as a two-element constant |
| 7 · `--append-system-prompt-file` exists (v2:112) | record shape presumes a file path (`role_prompt_path` + `role_prompt_sha256`); the probe is adapter-init (1c) |
| 8 · path assertions (v2:113) | `primary_checkout`, `task_dir`, `cwd`, `worktree.path` + `PROTECTED_PATH_COMPONENTS` + the absolute-path pattern; the two *relations* are prose + 1b builder test (A10) |
| 9 · nonce hygiene (v2:114) | `NONCE_PREFIX` frozen ⇒ substring scan; `env` is a closed eight-key object; the nonce has no representable field anywhere |

### 2.5 Complete property tables *(new — plan-review finding 3)*

**Conventions for every table:** `additionalProperties: false` on every object unless the row says otherwise. `req` = listed in `required`. Patterns are ECMA regex as JSON-string literals. Named patterns used repeatedly:

```
ABS       ^/[^/].*$                                    absolute filesystem path, single leading slash
UUID      ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$
ATTN      ^devteam-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-attn$
SLUG      ^[a-z0-9]+(-[a-z0-9]+)*$
SLICE     ^[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,15}){0,3}$   (finding 7)
STEM      ^[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,15}){0,3}\.[0-9]{1,2}$
ISO       ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$
SHA256    ^[0-9a-f]{64}$
RULE      ^(Edit|Read)\(//[^)]+\)$|^Bash\([^)]+\)$
RELGLOB   ^(?!/)(?!.*(^|/)\.\.(/|$)).+$                 repo-relative, no traversal
NONEMPTY  \S
CMD       ^[A-Za-z0-9 _./:=@+-]{1,200}$                 F-9 whitelist
```

#### A · `roster.schema.json` — title `Roster`

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `schema_version` | integer | ✔ | `const: 1` | E-1 |
| `tools` | array<string> | ✔ | `items.enum: ["Read","Edit","Write","Glob","Grep","Bash"]`, `uniqueItems`, `minItems: 1` | D-3 |
| `defaults` | object | ✔ | see A.1 | — |
| `profiles` | object | ✔ | `additionalProperties: <Profile>` (A.2); keys are profile names | F-3 |
| `roles` | object | ✔ | `additionalProperties: <Role>` (A.3); keys are role names | F-10 |

*No `execution_mode` (F-4). No `version` (E-1a).*

**A.1 `defaults`**

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `agent` | string | ✔ | `enum: ["claude"]` | — |
| `timeout_s` | integer | ✔ | `minimum: 60`, `maximum: 86400` | — |
| `icon` | string | ✖ | `pattern: "^[a-z0-9-]{1,32}$"` | cmux pane icon |
| `max_gate_blocks` | integer | ✔ | `minimum: 0`, `maximum: 10` | E-3c |
| `max_turns` | integer\|null | ✔ | `minimum: 1`; `null` = no cap | E-3a |
| `effort` | string | ✖ | `enum: ["low","medium","high","xhigh"]` | — |

*No `model` in defaults — `model` is required on every role, which removes an "either/or" the budget cannot express.*

**A.2 `Profile`** (value of each `profiles.<name>`)

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `description` | string | ✔ | `pattern: "\\S"`; test: must not match `/cannot run commands/i` | D-5, v2:178 |
| `permission_mode` | string | ✔ | `enum: ["dontAsk"]` | F-6 |
| `allow` | array<string> | ✔ | `items.enum: ["returns_write","signals_append","worktree_write","validation_commands"]`, `uniqueItems`, `minItems: 2` | R-B, R1 |
| `postcondition` | string | ✔ | `enum: ["clean","changes_expected"]` | F-3, v2:374 |
| `postcondition_ignore` | array<string> | ✖ | `items.pattern: RELGLOB`; omission ⇒ `[]` | D-10 |

*No `tools`, no `deny`, no `disable_slash_commands` — all structurally absent (D-1, D-3, F-7).*

**A.3 `Role`** (value of each `roles.<name>`)

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `pane` | boolean | ✔ | test: `{roles with pane:true} == PANE_ROLES` | finding 17 |
| `profile` | string | ✔ | `pattern: NONEMPTY`; test: must be a key of `profiles` | F-3 |
| `isolation` | string | ✔ | `enum: ["worktree","primary"]` | D-12 |
| `model` | string | ✔ | `pattern: "\\S"`; test: `MODEL_ALIASES` ∪ `/^claude-/` | F-8 |
| `agent` | string | ✖ | `enum: ["claude"]` | — |
| `effort` | string | ✖ | `enum: ["low","medium","high","xhigh"]` | — |
| `timeout_s` | integer | ✖ | `minimum: 60`, `maximum: 86400` | — |
| `max_turns` | integer\|null | ✖ | `minimum: 1` | E-3a |
| `doc_tab` | boolean | ✔ | — | — |
| `return` | object | ✔ | see A.4 | F-2 |

**A.4 `ReturnSpec`** (roster form)

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `kind` | string | ✔ | `enum: ["json","markdown"]` | F-2 |
| `schema` | string | ✖ | `pattern: "^[a-z0-9.-]+\\.schema\\.json$"` — plugin-root-relative filename. Prose: required when `kind: json` | F-2 |
| `required_sections` | array<string> | ✖ | `items.pattern: "\\S"`. Prose: used when `kind: markdown` | finding 10a |
| `verdict_block` | boolean | ✖ | reserved; prose default `false` | E-3b |

#### B · `roster.default.json` — the shipped zero-config roster

`schema_version: 1` · `tools: ["Read","Edit","Write","Glob","Grep","Bash"]` · `defaults: { agent: "claude", timeout_s: 1800, icon: "robot", max_gate_blocks: 2, max_turns: null }`

**Profiles (3):**

| name | allow | postcondition | description (abridged — must not claim "cannot run commands") |
|---|---|---|---|
| `executor` | `returns_write, signals_append, worktree_write, validation_commands` | `changes_expected` | "Writes code in its own worktree and runs the spec's validation commands. Cannot run state-changing commands outside those; the built-in read-only set executes in every mode regardless of rules." |
| `validator` | `returns_write, signals_append, validation_commands` | `clean` | "Runs the repo's declared validate lane against a worktree it cannot edit. Cannot run state-changing commands outside that lane; the built-in read-only set executes in every mode regardless of rules." |
| `judgment` | `returns_write, signals_append` | `clean` | "Reads, reasons and returns. Cannot run state-changing commands; the built-in read-only set (`git log`, `git diff`, `grep`, `cat`) executes in every mode regardless of rules." |

**Roles (12):** all `pane: false` except `coder` (Phase 1: `PANE_ROLES = ['coder']`).

| role | profile | isolation | model | effort | doc_tab | return | timeout_s |
|---|---|---|---|---|---|---|---|
| `coder` | executor | worktree | sonnet | medium | false | json → `coder-return.schema.json` | 1800 |
| `test-engineer` | executor | worktree | sonnet | — | false | json → `coder-return.schema.json` | — |
| `doc-writer` | executor | worktree | haiku | low | false | json → `coder-return.schema.json` | — |
| `build-validator` | **validator** | worktree | haiku | low | false | markdown → `["Verdict"]`, `verdict_block: true` | — |
| `code-reviewer` | judgment | worktree | sonnet | — | true | markdown → `["Verdict","Must-fix","Notes"]`, `verdict_block: true` | — |
| `code-reviewer-deep` | judgment | worktree | opus | high | true | markdown → `["Verdict","Must-fix","Notes"]`, `verdict_block: true` | — |
| `plan-reviewer` | judgment | primary | opus | high | true | markdown → `["Verdict"]` | — |
| `architecture-lead` | judgment | primary | opus | xhigh | true | markdown → `["Proposed memory deltas","Assumptions & unknowns"]` | 3600 |
| `backend-lead` | judgment | primary | opus | high | true | markdown → `["Handover Spec","Proposed memory deltas","Assumptions & unknowns"]` | 2400 |
| `frontend-lead` | judgment | primary | opus | high | true | (same as backend-lead) | 2400 |
| `devops-lead` | judgment | primary | opus | high | true | (same as backend-lead) | 2400 |
| `qa-lead` | judgment | primary | opus | high | true | (same as backend-lead) | 2400 |

*`architect` and `trd-reviewer` are deliberately absent: `SUBAGENT_ONLY` (F-10).*

#### C · `dispatch-record.schema.json` — title `DispatchRecord`

**Location (finding 6):** `~/.dev-team/state/<task-slug>/dispatch/<stem>.json`, parent-side, **not** under TASK_DIR.

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `schema_version` | integer | ✔ | `const: 1` | E-1 |
| `dispatch_id` | string | ✔ | `UUID` | F-1 |
| `slice_id` | string | ✔ | `SLICE` | F-1, finding 7 |
| `attempt` | integer | ✔ | `minimum: 1`, `maximum: 99` | F-1 |
| `task_id` | string | ✔ | `pattern: "\\S"` | — |
| `task_slug` | string | ✔ | `SLUG` | F-5 |
| `repo_slug` | string | ✔ | `SLUG` | F-5 |
| `role` | string | ✔ | `pattern: SLUG`; test: a roster role | — |
| `agent` | string | ✔ | `enum: ["claude"]` — **discriminates `profile.allow`'s grammar** | R3 |
| `model` | string | ✔ | `pattern: "\\S"` | F-8 |
| `effort` | string\|null | ✔ | `enum: ["low","medium","high","xhigh", null]` | — |
| `tools` | array<string> | ✔ | six-value `items.enum`, `uniqueItems` — invariant, hoisted | D-3 |
| `disallowed_tools` | array<string> | ✔ | `items.enum: ["mcp__*","Task","Agent"]`, `uniqueItems` — invariant, hoisted | D-1 |
| `flags` | object | ✔ | `{ strict_mcp_config: const true, disable_slash_commands: const true }`, both required | F-7 |
| `profile` | object | ✔ | see C.1 | — |
| `role_prompt_path` | string | ✔ | `ABS` — inside the per-task snapshot | D-9 |
| `role_prompt_sha256` | string | ✔ | `SHA256` | D-9 |
| `return` | object | ✔ | see C.2 | F-2 |
| `task_dir` | string | ✔ | `ABS`; prose: `<root>/tasks/<repo_slug>/<task_slug>` | D-6 |
| `spec_path` | string | ✔ | `ABS`; prose: `<task_dir>/spec/<slice_id>.json` | D-6 |
| `return_path` | string | ✔ | `ABS`; prose: `<task_dir>/returns/<stem>.json` | D-6 |
| `signals_path` | string | ✔ | `ABS`; prose: `<task_dir>/signals/<stem>.jsonl` | **finding 4** |
| `primary_checkout` | string | ✔ | `ABS`, no protected component | D-12 |
| `isolation` | string | ✔ | `enum: ["worktree","primary"]` | D-12 |
| `worktree` | object\|null | ✔ | see C.3; `null` iff `isolation: "primary"` (prose) | D-12 |
| `cwd` | string | ✔ | `ABS` | D-12 |
| `env` | object | ✔ | see C.4 — closed eight-key set | D-8 |
| `attn_parent` | string | ✔ | `ATTN` | D-7 |
| `attn_upstream` | string | ✔ | `ATTN` | D-7 |
| `kickoff` | string | ✔ | `pattern: "^[^\\n\\r]{1,4000}$"`; prose: must carry **`dispatch_id`** *(re-review N1 — the record is parent-side, so the kickoff is the worker's only reliable channel for it)*, `task_dir`, `spec_path`, `return_path`, `signals_path`, `attn_parent`, `attn_upstream` as literals, and must not contain `NONCE_PREFIX` | D-7b, N1 |
| `gate` | object | ✔ | `{ max_blocks: integer, min 0, max 10 }`, required | E-3c |
| `timeout_s` | integer | ✔ | `minimum: 60`, `maximum: 86400` | — |
| `max_turns` | integer\|null | ✔ | `minimum: 1` | E-3a |
| `surface` | object\|null | ✔ | see C.5; `null` in state `create`, set at `bind` | **finding 5** |
| `created_at` | string | ✔ | `ISO` | — |
| `bound_at` | string\|null | ✔ | `ISO` or null | **finding 5** |
| `ended_at` | string\|null | ✔ | `ISO` or null | D-11 |
| `outcome` | string\|null | ✔ | `enum: ["ok","exit_nonzero","no_return","invalid_return","refused_postcondition","timeout","aborted", null]` | D-11 |

**Top-level `description` must state, verbatim:** the E-1 evolution policy; the nonce prohibition (D-7b prose); the three-state lifecycle and its two monotone transitions (D-11); that `profile.allow`'s grammar is **agent-specific and discriminated by `agent`** (R3); the four parent-side sidecar formats (F-11); and that `returns/<stem>.md` is **parent-written and covered by no grant** (finding 10b).

**C.1 `profile`** (composed)

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `name` | string | ✔ | `pattern: SLUG`; test: a roster profile key | F-3 |
| `permission_mode` | string | ✔ | `enum: ["dontAsk"]` | F-6 |
| `grants` | array<string> | ✔ | four-value `items.enum`, `uniqueItems`, `minItems: 2` — the agent-neutral tokens this expanded from | R3 |
| `allow` | array<string> | ✔ | `items.pattern: RULE`, `minItems: 4`, `uniqueItems`; prose: must contain both `CMUX_ALLOWS` literals byte-identically | D-2, D-13 |
| `postcondition` | string | ✔ | `enum: ["clean","changes_expected"]` | F-3 |
| `postcondition_ignore` | array<string> | ✔ | `items.pattern: RELGLOB` (may be `[]`) | D-10 |

**C.2 `return`** (resolved)

| Property | Type | req | Constraints |
|---|---|---|---|
| `kind` | string | ✔ | `enum: ["json","markdown"]` |
| `schema_path` | string\|null | ✔ | `ABS`, inside the per-task snapshot; `null` when `kind: markdown` |
| `required_sections` | array<string> | ✔ | `items.pattern: "\\S"` (may be `[]`) — **finding 10a** |
| `verdict_block` | boolean | ✔ | — |

**C.3 `worktree`**

| Property | Type | req | Constraints |
|---|---|---|---|
| `path` | string | ✔ | `ABS`, no protected component; prose: ≠ `primary_checkout` |
| `branch` | string | ✔ | `pattern: "^dt/[a-z0-9-]+/[a-z0-9-]+$"` |
| `created_by_dispatcher` | boolean | ✔ | — |
| `source_slice_id` | string\|null | ✔ | `SLICE` or null; prose: `null` iff `created_by_dispatcher: true`. Names the slice whose worktree this dispatch inspects *(re-review N2 — reviewer/validator roles get `isolation: worktree` with `created_by_dispatcher: false`, and D-12's path derivation binds only to the slice that created it; the record's own `slice_id` still keys `return_path`/`signals_path` stems)* |

**C.4 `env`** — closed, all eight required, values are strings

| Key | Constraint | Consumer |
|---|---|---|
| `DEVTEAM_WORKER` | `const: "1"` | SessionStart neutralization guard (#5) |
| `DEVTEAM_ROLE` | `pattern: SLUG` | attestation / telemetry |
| `DEVTEAM_TASK_ID` | `pattern: "\\S"` | attestation / telemetry |
| `DEVTEAM_DISPATCH_ID` | `pattern: UUID` | attestation identity |
| `DEVTEAM_TASK_DIR` | `pattern: ABS` | PostToolUse path matcher (v2:420) |
| `DEVTEAM_DISPATCH_RECORD` | `pattern: ABS` | Stop gate reads `gate.max_blocks` |
| `DEVTEAM_SIGNAL_LOG` | `pattern: ABS` | PostToolUse append target (v2:225) |
| `DEVTEAM_GATE_COUNTER` | `pattern: ABS` | Stop gate block counter (finding 2) |

**C.5 `surface`**

| Property | Type | req | Constraints |
|---|---|---|---|
| `workspace_id` | string | ✔ | `UUID` |
| `pane_id` | string | ✔ | `UUID` |
| `surface_id` | string | ✔ | `UUID` |

*The UUID pattern makes a positional ref (`surface:9`) unrepresentable — issue #2's hard rule, enforced structurally.*

#### D · `signal-record.schema.json` — title `SignalRecord` (one JSONL line)

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `schema_version` | integer | **✖** | `const: 1`; omission ⇒ 1 | see note |
| `ts` | string | ✔ | `ISO` | v2:323 |
| `level` | string | ✔ | `enum: ["progress","blocked","question"]` | v2:325 |
| `message` | string | ✔ | `pattern: "^.{1,2000}$"` | v2:329 |
| `escalate_to` | string | ✔ | `enum: ["lead","orchestrator","user"]` | v2:326 |

**Note on the one optional field:** these lines are written *by a language model under prompt instruction*, and worker compliance is unverified. Every additional required field is a compliance risk. `schema_version` is therefore the single writer-lenient field in the entire freeze — coherent, because the parent-side rule for this file is already "malformed lines are recorded, not relayed." `dispatch_id` is deliberately **not** a field: the filename carries it, and the attestation log records it independently.

**Description must state:** the parent-side read-time rules — closed `level` enum enforced at read time and advisory at write time; unknown `level` ⇒ `progress`; ≤5 relayed per dispatch; ≥30 s apart; `message` truncated to 200 chars **before relay** (not at write); over-limit lines recorded and not relayed. Constants: `SIGNAL_LIMITS`.

#### E · `return-envelope.schema.json` — title `ReturnEnvelope`

| Property | Type | req | Constraints | Ruling |
|---|---|---|---|---|
| `schema_version` | integer | ✔ | `const: 1` | E-1 |
| `dispatch_id` | string | ✔ | `UUID` — ladder clause (v) | F-2 |
| `slice_id` | string | ✔ | `SLICE` | F-1 |
| `attempt` | integer | ✔ | `minimum: 1`, `maximum: 99` | F-1 |
| `role` | string | ✔ | `pattern: SLUG` | — |
| `produced_at` | string | ✔ | `ISO` | — |
| `body` | object\|string | ✔ | validated in step 2 against `record.return` | F-2 |

**Description must state:** the two-step validation rule; that `kind: markdown` ⇒ `body` is a string and every `required_sections` entry must appear as a markdown heading (`SECTION_HEADING_RE`); that `kind: json` ⇒ `body` is an object validated against `record.return.schema_path`; and that **the parent, not the worker, writes `returns/<stem>.md` for doc-tab display after validation** — no grant covers it.

---

## Section 3 — Execution plan

### 3.1 File list

**New — `scripts/cmux/` (5 data + 1 code):**

| Path | What |
|---|---|
| `scripts/cmux/roster.schema.json` | roster contract |
| `scripts/cmux/roster.default.json` | zero-config roster (3 profiles, 12 roles) |
| `scripts/cmux/dispatch-record.schema.json` | dispatcher ↔ adapter ↔ worker-side-hook contract |
| `scripts/cmux/signal-record.schema.json` | worker → parent signal line |
| `scripts/cmux/return-envelope.schema.json` | worker → parent return wrapper |
| `scripts/cmux/contract.mjs` | `validate`, `shouldArchive`, `slugify` + frozen constants |

**Siting:** all six under `scripts/cmux/`, not the repo root. The two root schemas are the *workflow-mode* contract referenced as `${CLAUDE_PLUGIN_ROOT}/handover-spec.schema.json` in prompts; cmux contracts are an execution-mode subsystem, and issue #2's own example path already puts cmux assets there.

**`contract.mjs`'s 1a surface** *(revised, finding 15 — `resolveRole` moved out)*:
`validate(schema, instance) -> Violation[]` (budget-only; throws on an unknown keyword; emits a distinctly named `schema_version_too_new` violation per E-1c) · `shouldArchive(task, dispatches) -> boolean` · `slugify(s) -> string` · constants `BUDGET`, `TOOLS`, `DISALLOWED_TOOLS`, `CMUX_ALLOWS`, `GRANT_TOKENS`, `OUTCOMES`, `NONCE_PREFIX`, `PROTECTED_PATH_COMPONENTS`, `SIGNAL_LIMITS`, `SECTION_HEADING_RE`, `MODEL_ALIASES`, `SUBAGENT_ONLY`, `PANE_ROLES`, `SLICE_ID_RE`, `CMD_RE`.

**Why it is runtime code, not a test helper:** (i) v2:435 assigns the archive-predicate unit test to 1a by name, and a test with no implementation is not a test; (ii) 1b needs a **runtime** validator for ladder clause (iv) — "validates against the return schema" (v2:259) — and a dependency would break the repo's dependency-free property (README.md:243); (iii) a prose predicate that 1b re-implements is exactly the drift 1a exists to prevent.

**Edited (5):**

| Path | Change |
|---|---|
| `test/schema.test.mjs` | add the four new schemas to the hardcoded list (`:23`); **add an inline positive budget walk** (finding 12); update the rationale comment (`:7-9`) |
| `test/helpers.mjs` | `export { MODEL_ALIASES } from '../scripts/cmux/contract.mjs'` |
| `test/agents.test.mjs` | delete the module-local `MODEL_ALIASES` (`:7`), import it instead |
| `README.md` | file tree (`:215-233`) gains `scripts/cmux/`; tests paragraph (`:243`) gains the roster/contract line |
| `.claude-plugin/plugin.json` | `version` → `0.1.44`; commit ends `; bump 0.1.44`. **Do not touch** `.claude-plugin/marketplace.json:6` |

**New tests (2):** `test/roster.test.mjs`, `test/cmux-contract.test.mjs`.

### 3.2 Coder slices — 2 sequenced coders, one PR

Single-domain backend work, ~13 files. **Two coders, strict sequence A→B, same branch, one PR.**
*Why not one:* a dispatch spanning JSON authoring, a hand-rolled validator and two test suites is large enough that an `insufficient` return costs a full re-plan — and 1a blocks two slices.
*Why not parallel:* B's tests read A's files.
*Why this boundary:* it is the data/code line, so the interface contract between slices **is §2.5's tables** — nothing either coder must invent.

| Slice | Deliverable | Depends on | Acceptance |
|---|---|---|---|
| **be-1a-A** — contracts | the five `scripts/cmux/*.json` files + `test/schema.test.mjs` (list extension **and** the budget walk) | — | A1, **A1b**, A9 |
| **be-1a-B** — runtime + tests | `scripts/cmux/contract.mjs`; `test/roster.test.mjs`; `test/cmux-contract.test.mjs`; `helpers.mjs`/`agents.test.mjs` edits; README; version bump | be-1a-A | A1–A9 (A7 excluded — deferred to 1b) |

**Interface contract A → B:** the R-A budget; §2.5's tables verbatim; `MODEL_ALIASES` defined in `contract.mjs` (B) and re-exported by `helpers.mjs`; the token enum `["returns_write","signals_append","worktree_write","validation_commands"]`; the outcome enum (7 + `null`); the constant list in §3.1. B additionally asserts that `contract.mjs`'s `BUDGET` equals the literal budget array A wrote into `test/schema.test.mjs` (drift guard).

### 3.3 Acceptance criteria

| # | Criterion | Source |
|---|---|---|
| **A1** | `node --test` green offline — no cmux, no model, no network, no new dependency, `node_modules` still absent | issue #2; README.md:243 |
| **A1b** | *(new — findings 12+14, slice A's executable acceptance)* every key in every node of the four new schemas is in the literal budget array; every schema has `$schema`/`title`/`description`/`type`/`required`/`additionalProperties`; all five files parse | R-A |
| **A2** | `validate()` accepts `roster.default.json` against `roster.schema.json`, plus one worked example instance per schema (record in each of its three lifecycle states, signal line, return envelope in both `kind`s) | issue #2; finding 5 |
| **A3** | **Negative cases** — at minimum: profile carrying `deny`; profile carrying `tools`; `permission_mode: "plan"`; an `allow` token outside the enum; a `//`-prefixed filesystem path; a relative path; `postcondition_ignore` entry starting `/` or containing `..`; env object with a ninth key; env missing `DEVTEAM_GATE_COUNTER`; a record containing `NONCE_PREFIX`; `flags.strict_mcp_config: false`; a positional `surface_id`; a `slice_id` containing `)`, space, `*` or `..`; a validation command failing `CMD_RE`; **`schema_version: 2` ⇒ a distinct `schema_version_too_new` violation**; *(re-review N5)* a composed `profile.allow` containing `Write(//x/**)` (rule-kind whitelist) and one containing single-slash `Edit(/x)` (`//`-anchoring); a malformed `attn_parent` | D-1, D-3, F-6, R-B, D-6, D-10, D-8, D-7b, F-7, finding 5, finding 7, F-9, **finding 8**, N5 |
| **A4** | `shouldArchive` unit test — one case per enum value **plus `null`** (8 cases) | **v2:562** |
| **A5** | Signal-record schema frozen; `SIGNAL_LIMITS` matches the schema's documented limits. *(Re-review N6: the two message bounds are deliberately different — the schema's `^.{1,2000}$` is the write-time bound, `SIGNAL_LIMITS.message_max_chars: 200` is the relay-time truncation; the test asserts both, never "fixes" one to match the other.)* | **v2:563**, 1a portion; N6 |
| **A6** | Roster tests: `roles ∪ SUBAGENT_ONLY == listAgents()`; every role's `profile` exists in `profiles`; every `model` passes `MODEL_ALIASES` ∪ `/^claude-/`; **`{roles with pane:true} == PANE_ROLES`** (finding 17); no profile description matches `/cannot run commands/i`; every profile's `allow` contains `returns_write` + `signals_append`; `build-validator.profile == "validator"` | issue #2; v2:178; **v2:561**; finding 1 |
| **A7** | ~~precedence test~~ — **deferred to 1b with `resolveRole`** | finding 15 |
| **A8** | `slugify` tests incl. `../`, leading `/`, unicode, >60 chars, empty | F-5 |
| **A9** | **Inertness:** nothing in `commands/`, `hooks/`, `orchestration.md` or `team-build.workflow.mjs` references the new files; **no existing test's assertions change** — the `agents.test.mjs` edit is an import-site change with the same alias list and the same assertions; total test count rises only by the new tests | F-4; **finding 16** |
| **A10** | **Deferral ledger** — see below | Section 2.4 |

**A10 · Deferral ledger** *(revised — the reviewer's four missing items added, plus owners for every item this package creates)*

| Deferred item | Owner |
|---|---|
| Builder tests, one per hard rule 1–9 (v2:561) | **1b** (#3) |
| `worktree.path ≠ primary_checkout`; `task_dir` outside every checkout (D-12 relations, not schema-expressible) | **1b** |
| Builder rejects `..` segments in every path field *(deep-review S5: the frozen `ABS` pattern admits `..`, and `ABSNP`'s protected-component ban is literal-component-only — `/abs/../../etc` passes both; not worker-exploitable today since the parent authors the record, but the builder must assert it)* | **1b** |
| Hard-rule-9 nonce scan targets **serialized record bytes only**, never the schema file or a schema+record blob *(deep-review re-pass: the M2 kickoff description now embeds the literal `devteam-done-` prefix inside `dispatch-record.schema.json`, so a scan that includes schema bytes self-trips)* | **1b** |
| Atomic tmp+rename write test for the three-state lifecycle, incl. "every other field byte-identical" (D-11 / finding 5) | **1b** |
| `role_prompt_sha256` cross-dispatch stability test (D-9) | **1b** |
| `resolveRole` implementation + four-layer precedence test (finding 15, E-2) | **1b** |
| `expandGrants(agent, tokens, ctx) -> string[]` as a named, separately-testable function (architect rider 2) | **1b** |
| Parent-side render of `returns/<stem>.md` + doc-tab mount (finding 10b) | **1b** |
| Markdown `required_sections` check using `SECTION_HEADING_RE` (finding 10a) | **1b** |
| Relay behaviour: malformed/over-limit signal lines recorded-not-relayed (v2:563) | **1b** |
| `execution_mode` config key + default `subagent` + the dispatch-entry branch (F-4) | **1b** (#3) — *orchestrator: confirm no later epic sub-issue fits better* |
| Dependency preparation in a fresh worktree, dispatcher-side (architect rider 4i; U-6) | **1b** |
| Dispatcher branches on the `profile.postcondition` discriminator (F-3) *(re-review N9)* | **1b** |
| Dispatcher resolves `config.validate.full` for the `validator` profile (F-9) *(re-review N9)* | **1b** |
| `.gate` counter file created/initialised at record `create` time (F-11) *(re-review N9)* | **1b** (creation); **1c** (consuming hook) |
| Stop-gate hook consuming `DEVTEAM_GATE_COUNTER` + `gate.max_blocks` (finding 2) | **1c** (#4) |
| PostToolUse attestation hook consuming `DEVTEAM_SIGNAL_LOG` (finding 2) | **1c** |
| "No path in the system emits a nudge from the hook" (v2:563) | **1c** |
| S25f — exact-file `Edit(//abs/dir/file.json)` rule probe (D-4b / U-1) | **1c** |
| S25d arm — `WebFetch`/`WebSearch` permission surface (U-2); sibling-artifact readability under `--add-dir` (U-11) | **1c** |
| `F-7` `flags` const assertion | **not deferred** — in A3 |

### 3.4 Validation & review route

**Validation:** `node --test` — `fast` and `full` are identical here (config.md:32-36, <1 s). Coder `validation_commands`: `node --test`.

**Gate: `dev-team:code-reviewer-deep`, mandatory, on the whole PR** (config.md:38-46 flags contract schemas for deep review; these additionally encode a security boundary). Plus `dev-team:build-validator` on `node --test`.

- **No `dev-team:test-engineer`** — the tests are the deliverable.
- **No `dev-team:qa-lead` plan** unless the deep reviewer flags coverage gaps. Two things to hand the reviewer explicitly: (1) **the hand-rolled validator is the highest-risk artifact in this PR** — a validator that silently under-checks makes every "validates against the schema" assertion vacuous; review A3 for *completeness*, not presence. (2) The **budget walk** in `test/schema.test.mjs` must be a positive allow-list, not a blacklist — that is the defect the plan review caught in the first draft.
- **Config delta with the PR:** add `scripts/cmux/*.schema.json` and `scripts/cmux/contract.mjs` to `config.md` `review_defaults`.

### 3.5 Handover Spec outlines (for the backend lead to finalise)

**be-1a-A — contracts** · `domain: backend` · `depends_on: []`
`files_in_scope:` the five `scripts/cmux/*.json` files + `/Users/x/Development/dev-team-claude-plugin/test/schema.test.mjs`
`constraints:` R-A budget (incl. the `pattern: "\\S"` idiom for non-empty and union `type` arrays); mirror `/Users/x/Development/dev-team-claude-plugin/handover-spec.schema.json` exactly (key order `$schema, title, description, type, required, additionalProperties, properties`; PascalCase `title`; one-line property objects; prose-in-`description`; no `$id`, no `default`)
`acceptance_criteria:` A1, A1b, A9, plus §2.5's tables reflected field-for-field
`validation_commands: [node --test]`
`discovery_context:` **paste §2.5 in full**, plus the two existing root schemas as the style pattern; note `test/schema.test.mjs:23` is a hardcoded array, not a glob, and `test/schema.test.mjs:12-21` is the recursive-walk pattern to mirror for the budget walk
`out_of_scope:` `contract.mjs`, any test beyond `schema.test.mjs`, README, version bump, `coder-return.schema.json`, `handover-spec.schema.json`
`interface_contract:` backend owns and produces it — the five schemas are what be-1a-B, #3 and #4 consume

**be-1a-B — contract runtime + tests** · `domain: backend` · `depends_on: [be-1a-A]`
`files_in_scope:` `scripts/cmux/contract.mjs`, `test/roster.test.mjs`, `test/cmux-contract.test.mjs`, `test/helpers.mjs`, `test/agents.test.mjs`, `README.md`, `.claude-plugin/plugin.json`
`constraints:` no dependencies, node builtins only; repo test style (no semicolons, single quotes, 2-space, top-level `test()`); Node 20 floor; the validator implements **only** the R-A budget and **throws** on an unknown keyword; `schema_version_too_new` is a distinctly named violation, not a generic `const` mismatch
`acceptance_criteria:` A1–A6, A8, A9 (A7 is deferred to 1b — do not implement `resolveRole`)
`validation_commands: [node --test]`
`discovery_context:` `MODEL_ALIASES` is at `test/agents.test.mjs:7`, module-local; `test/helpers.mjs:8,14` export `ROOT`/`listAgents()`; `test/schema.test.mjs:12-21` is the traversal pattern to mirror
`out_of_scope:` the schemas themselves; `resolveRole`; `expandGrants`; anything under `commands/`, `hooks/`, `orchestration.md`; the argv builder; `task.json`
`interface_contract:` consumes be-1a-A's schemas; exports the constants #3 and #4 import (§3.1)

---

## Section 4 — Proposed memory deltas

*(The orchestrator commits these; the lead never writes.)*

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/architecture-notes.md`**

1. **UPDATE — the five `proposed` ADR entries (`:10`–`:14`) and the `--append-system-prompt-file` entry (`:15`): `proposed` → `ratified 2026-08-01` (1a planning).** ADR-006 Am. 1 gains: *live-verified at the real path by S25c — the `.dev-team` dot-name is not protected.*
2. **UPDATE — ADR-003 Am. 1 (`:11`), two riders.** *(a)* S25b: `wait-for` latches are **consume-once**; v2 §7.3's two-phase loop collapses to a single repeating phase-1. *(b)* **Correction:** the rank-2 EXIT sentinel is unforgeable **by tool calls only** — a Bash subprocess reaches `~/.dev-team/state/` with the same uid (G13), so a forged `.exit` is possible; the blast radius is bounded exactly as a forged token's, because completion is re-derived from the ladder on every wake. Do not describe it as unforgeable. The same bound covers the new `.gate` counter.
3. **UPDATE — ADR-006 Am. 1 (`:10`), rider C.** `dispatch/<stem>.json` **moves out of TASK_DIR** to `~/.dev-team/state/<task-slug>/dispatch/`. *Why:* under `--add-dir`, reads never prompt, so a record under TASK_DIR published every sibling dispatch's attention tokens and kickoff to every worker — falsifying v2:274 ("no worker learns anything about its siblings") and mooting v2:276's UUID-based forgery resistance. Worker-side hooks read the record as **subprocesses** via `DEVTEAM_DISPATCH_RECORD`, not as tool calls, so nothing required it worker-readable. Residual: a Bash subprocess can still read it (U-7 class), bounded as above.
4. **NEW — ADR-013 (proposed): the cmux contract freeze is structural, not advisory.** *(text revised per findings 1/5/6 and architect riders 2–4)*
   - Roster `allow` lists are **enum-constrained capability tokens** — `returns_write`, `signals_append`, `worktree_write`, `validation_commands` — never permission-rule strings. Tokens are **agent-neutral capability declarations**; **expansion into rules is an adapter responsibility**, exposed by 1b as `expandGrants(agent, tokens, ctx) -> string[]` with `agent` a parameter, not an assumption.
   - Profiles carry **no `deny` key**, **no `tools` key** (hoisted to one top-level roster field), and `permission_mode: enum ["dontAsk"]`. **Exactly three profiles — `executor`, `validator`, `judgment` — generated by the rule *one profile per distinct grant-token set*.** `build-validator` is why `validator` exists: judgment cannot run a build, and executor could edit the artifact under test.
   - The dispatch record is **parent-side**, has a **closed eight-key `env`**, and follows a **three-state, two-transition** lifecycle (`create` → `bind` → `terminate`), each transition atomic and monotone. The completion nonce is **structurally unrepresentable** in it.
   - **Stated cost (do not let a future reader discover it):** the only remaining channel for a bespoke `Bash(...)` grant moves from a human-authored file to an **agent-authored** one (the lead's spec `validation_commands`). That is a trust-boundary relocation, bounded by a whitelist charset and `Bash(<c> *)` wrapping.
   - **Named consequence 1:** dependency preparation in a fresh worktree (`npm ci`, `cargo build`, `make deps`) is a **dispatcher-side action performed before spawn — never a worker grant and never a reason to widen the token enum.**
   - **Named consequence 2:** if a downstream repo ever needs a genuinely bespoke grant, the **pre-approved shape is a structured, pattern-restricted prefix-list field** (e.g. `validation_command_prefixes: ["cargo test"]`) — deferred, not forbidden, and explicitly **not** a rule-string `extra_allow`.
   - *Supersedes:* issue #2's inline roster/record JSON. Status: proposed.
5. **NEW — Return files are envelopes.** Workers write `{schema_version, dispatch_id, slice_id, attempt, role, produced_at, body}`; validation is two-step. For markdown returns the **parent** renders `returns/<stem>.md` after validation and mounts the doc tab on it — no grant covers that file, so the human's viewport cannot be written by a worker. `coder-return.schema.json` and `handover-spec.schema.json` are **unmodified**. Status: proposed.
6. **NEW — Worker worktrees are keyed to `slice_id` and sited outside every checkout** at `<task_artifacts_root>/worktrees/<repo-slug>/<task-slug>/<slice_id>`, branch `dt/<task-slug>/<slice_id>`, reused across attempts. *Side effect:* closes U14/S25e. Status: proposed.
7. **NEW — Scope rule for contract freezes:** freeze every artifact that crosses a process or trust boundary; leave parent-internal state to the slice that builds it. *Worked example of the rule biting its author:* the Stop gate's block counter looked parent-internal until the plan review observed that the Stop **hook runs inside the worker's process tree** — so the counter is frozen in 1a. Status: proposed.

**→ `/Users/x/Development/dev-team-claude-plugin/.claude/dev-team/memory/conventions.md`**

8. **NEW — This repo has no JSON-Schema validator and will not gain one.** New schemas stay inside a fixed keyword budget; enforcement is a **positive allow-list walk** in `test/schema.test.mjs`, and every new schema is added to its hardcoded list (a list, not a glob). Non-empty is `pattern: "\\S"`; bounded length is a pattern quantifier; `minLength`/`maxLength` are out of budget.
9. **NEW — `//` is permission-rule syntax, not filesystem-path syntax.** Inside `--allowedTools` a path needs a double leading slash; a *filesystem* path field must be single-slash absolute (POSIX leaves `//foo` implementation-defined). Two distinct patterns, never one.
10. **NEW — Prefer structural impossibility to a test assertion, and a whitelist to a blacklist.** Encode a rule so violating it yields an invalid document; keep the test as a meta-check that the constraint has not been widened. Where a constraint must be enumerated, enumerate what is *allowed* — this package's plan review found two stale blacklists (a shell-metacharacter refusal list missing `(`/`)`/quotes, and a conditional-keyword list missing four banned keywords), and zero stale whitelists.
11. **UPDATE — `config.md` `review_defaults`:** add `scripts/cmux/*.schema.json` and `scripts/cmux/contract.mjs`.

---

## Section 5 — Assumptions & unknowns

### Verified

| # | Assumption | Evidence |
|---|---|---|
| V-1 | `Edit(//abs/**)` scopes correctly under `dontAsk`; `Write(...)` rules accepted but never consulted | Live — S22a, S22b (conventions.md:19) |
| V-2 | `~/.dev-team/tasks/…` receives `dontAsk` worker writes; `.dev-team` not protected | Live — S25c (spike-findings.md:429-435) |
| V-3 | `.claude/**` hard-denies worker writes even with an exact-match allow | Live — U2 probe |
| V-4 | Omission from `--allowedTools` is denial outside the built-in read-only set | Live — Tests A/B, S22f |
| V-5 | `wait-for` latches are consume-once ⇒ single-phase await | Live — S25b |
| V-6 | `wait-for` tokens survive a cmux restart ⇒ ladder re-derivation is load-bearing | Live — S20 (architecture-notes.md:16) |
| V-7 | `--append-system-prompt-file` exists on 2.1.220 | Live — S22g, used in S22f |
| V-8 | Repo facts: no validator/deps/lockfile; `node --test` is both lanes (<1 s, 87 tests); `MODEL_ALIASES` module-local at `test/agents.test.mjs:7`; `test/schema.test.mjs:23` is a hardcoded two-element list; version-bump convention; Node 20 floor | Verified + digest A |
| V-9 | `/dev-team:team` has no `roster` subcommand — precedence level 4 is reserved, not live | Verified — `commands/team.md` |
| V-10 | 12 roster roles all have `agents/<role>.md`; `architect.md` + `trd-reviewer.md` are the only extras | Verified — digest A §4 |
| V-11 | Reads inside cwd + `--add-dir` never prompt under `dontAsk` — which is *why* finding 6's disclosure was real | v2:159 |

### Unverified — the design rests on these anyway

| # | Assumption | Exposure & route |
|---|---|---|
| **U-1** | An **exact-file** `Edit(//abs/dir/file.json)` rule matches (D-4b). Both live tests used `**`. | Low. **S25f** rides with 1c. Fallback widens the expansion — see U-12 for the two conditions. |
| **U-2** | `WebFetch`/`WebSearch` under `dontAsk` require an allow rule ⇒ excluded from `TOOLS`. **Judgment roles lose web research in cmux mode.** | Medium — a real capability regression. Route: S25d arm; widening `TOOLS` afterwards is a `roster.default.json` edit and, per E-1d, **no version bump** (input vocabulary). **Worth a user decision.** |
| **U-3** | `--append-system-prompt-file` is **not** repeatable — hence one pre-composed role file (D-9) | Low. The design avoids the question; confirming repeatability later makes splitting additive. |
| **U-4** | cmux `--id-format uuids` yields lowercase 8-4-4-4-12 hex (the frozen `UUID` pattern) | Low–Medium. Assumed, not observed. *(Re-review: `UUID` now gates `surface`, `dispatch_id`, `DEVTEAM_DISPATCH_ID` and `ATTN` — the `cmux tree` inspection **blocks 1b's first record write**, it is not merely scheduled during 1b.)* |
| **U-5** | `--max-turns` exists with that spelling (`max_turns` reserved, never emitted in Phase 1) | Low — reserved-only. |
| **U-6** | A git worktree at `~/.dev-team/worktrees/…` can run validation commands (a fresh worktree has no `node_modules`) | Medium — **now a decided policy, not an open hazard** (ADR-013 consequence 1: dependency prep is dispatcher-side before spawn). Residual: which prep command per repo. Route: backend-lead at 1b. |
| **U-7** | Parent-side state is readable — and `.exit`/`.gate` writable — by a worker's Bash **subprocess**; only the nonce is protected, by unlink-before-spawn | Accepted residual (G13, v2:261). Blast radius per file stated in F-11. Recorded as rider (b) on ADR-003 Am. 1. |
| **U-8** | ADR number **013** is free | **RESOLVED by orchestrator 2026-08-01** — epic #15's comments use ADR-010/011/012 only. |
| **U-9** | Issue #2's inline JSON is not superseded by a later comment | **RESOLVED by orchestrator 2026-08-01** — issue #2 has zero comments. |
| **U-10** | *(new, reviewer)* Worker-side hooks (Stop gate, PostToolUse) must read `DEVTEAM_DISPATCH_RECORD` JSON from static POSIX sh — v2:581 assumes `jq`, whose presence on the user's machine is **unverified** and which is not a dependency of this repo. | Medium for 1c, zero for 1a. **Recommendation to 1c: use `node -e` rather than `jq`** — node is already a hard dependency (the plugin ships `.mjs`; CI pins node 20), `jq` is not. The three path-valued env keys exist precisely to keep those scripts free of path arithmetic, so only one JSON read remains. Route: devops-lead consult at 1c. |
| **U-11** | *(new, reviewer)* Sibling-artifact readability under `--add-dir`: **moot for dispatch records** (finding 6 moved them parent-side) but still true for `returns/` and `signals/` — worker A can read worker B's return and signal content. | Low. All workers in one task are already trusted with that task's content; no token or credential lives in those files. Verifiable free at 1c alongside S25f. State as a residual in the record's description. |
| **U-12** | *(new, reviewer)* The claim "widening `returns_write` to `returns/**` on S25f failure is one line, no schema change" | Holds under exactly **three** conditions, all explicit: **(i)** the return-file name stays `<slice_id>.<attempt>.json` (the stem is what makes the widened grant still per-attempt-unique); **(ii)** ladder clause (v) matches on the **envelope's `dispatch_id` against the record**, never on the grant's narrowness; **(iii)** *(re-review N4)* the parent-rendered doc-tab file relocates to `render/<stem>.md`, outside the widened grant. (ii) is how F-2 is written, so the fallback is genuinely a change to `expandGrants` plus one render-path constant. |

### Decisions needed from the user, beyond the ratification slate

| # | Decision | Recommendation |
|---|---|---|
| **1** | **The grant-token model (R-B)** — roster `allow` becomes `["returns_write","signals_append"]` instead of permission-rule strings | **Adopt.** Independently endorsed by `dev-team:architect`; the decisive argument is reversibility asymmetry — Option A is a one-way door on config living in user repos. |
| **2** | **Three profiles, and `build-validator` gets its own** (`validator`) | **Adopt.** The two-profile draft left build-validator unable to run a build — caught by plan review, and this PR's own gate routes through that agent. |
| **3** | **Judgment roles lose `WebFetch`/`WebSearch`** in cmux mode (U-2) | **Accept for Phase 1**, revisit after S25d. Re-adding costs a roster edit and no version bump (E-1d). |
| **4** | **Dispatch records move parent-side** (rider C on ADR-006 Am. 1) | **Adopt.** Removes a cross-worker disclosure that made two v2 claims false, at the cost of one path. |
| **5** | **`schema_version` starts at 1**, not the issue's 2 | **Adopt.** |
| **6** | **Siting under `scripts/cmux/`** rather than the repo root | **Adopt.** |
| **7** | **Two coders sequenced** (§3.2) | **Two.** One PR either way. |
| **8** | Post §2.5's property tables + the findings-resolution table as a **comment on issue #2** before dispatch | **Do it** — issue #2 has zero comments, its inline JSON is now superseded in ~20 places, and #3/#4's coders will read the issue body first. |

---

## Recommended team dispatch

- **research:** none. Every residual question is a measurement (S25f, the S25d arms) or a user decision.
- **feasibility consults:**
  - **backend-lead** — the two-slice split; `contract.mjs`'s revised surface (`resolveRole` removed, `schema_version_too_new` added); validator throw-vs-collect; and confirmation that the A10 items assigned to 1b are accepted as inherited scope (they are eight items, which is a real load on #3).
  - **qa-lead** — one question: is A3's negative-case list sufficient to prove the hand-rolled validator is not vacuously passing?
  - **devops-lead** — **not for 1a**; queue U-10 (`node -e` vs `jq` in worker-side hooks) for 1c.
- **review gate:** `dev-team:plan-reviewer` re-review of this revision (author ≠ reviewer; the same reviewer is appropriate — this is a revision pass, not a redesign). **`dev-team:architect` is not needed again** — its R-B opinion is delivered, endorsed and folded in; the remaining calls are narrower than the round-trip is worth.
- **implementation gate:** `dev-team:code-reviewer-deep` (mandatory) + `dev-team:build-validator` on `node --test`.
