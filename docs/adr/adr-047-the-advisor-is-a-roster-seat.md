# ADR-047 — The advisor is a roster seat: its model is picked from the roster and consulted through an adapter

**Status:** *ratified* 2026-09-27, operator decision (answers in "Operator decisions" below) · **Owner:** operator · **Relates to:** ADR-032 (the
breaker refuses and never reroutes), ADR-035 (seat allocation is its own axis), ADR-037 (local models), ADR-046
(a cell is stamped as written)

The operator's direction, 2026-09-27, verbatim: *"same as the rest of the roster, advisor model should be picked
from the list and it should behave the same way; no matter if its local or provider."*

This record works out what that direction means in code, recommends one shape, and names what it does not decide.
Every `file:line` below was read at `46594dad`.

## What the advisor is today

**Two layers, one extension.** `crew/pi/extensions/advisor.ts` watches a pi seat's tool boundaries.

- **Tier 0** is deterministic and has no model: `TIER0_KINDS` = `scope-breach`, `tripwire-touch`,
  `repeated-failure`, `growth-divergence` (`advisor.ts:48-52`), fired from `processCall`/`processResult`.
- **Tier 1** is a model judgment over a scrubbed delta of the seat's recent reads and edits. Each entry is scrubbed by
  `redactDelta` (`advisor.ts:513`) at the one point every delta source passes through (`advisor.ts:845`). A consult
  runs on a tier-0 note or every `CADENCE_CALLS` = 25 tool calls (`advisor.ts:60`). The cap is `TIER1_MAX_CONSULTS` = 20
  consults per epoch (`advisor.ts:61`), and each one times out after `CONSULT_TIMEOUT_MS` = 20 s (`advisor.ts:75`). The
  system prompt comes from the role: `BUILDER_SYSTEM_PROMPT` / `PLANNER_SYSTEM_PROMPT` (`advisor.ts:671-676`).

**Advice has no authority.** A note carries no verdict, no interruption severity, no automatic resume and no
mid-turn poke; it is delivered only at a tool boundary (`advisor.ts:13-16`), as a `steer` message
(`advisor.ts:998`), and a delivery failure is swallowed (`advisor.ts:999-1000`).

**Tier 1 already has two transports, chosen by one environment variable.** The brief this record was drafted from
described one. The code has two:

| | HTTP channel | pi-child channel ("model-only") |
|---|---|---|
| selected when | `CREW_ADVISOR_ENDPOINT` is non-empty (`advisor.ts:1059`) | it is empty (`advisor.ts:1089`) |
| call | `POST <endpoint>/chat/completions` (`advisor.ts:667-669`) with `headers: { 'content-type': 'application/json' }` and nothing else (`advisor.ts:1060-1063`) | `pi -p --mode json --no-session --model <CREW_ADVISOR_MODEL> --tools read,grep,find,ls --exclude-tools edit,write,bash --no-extensions --no-skills` (`advisor.ts:1098-1099`) |
| auth | none, so a provider API cannot be reached | pi's own, inherited from the seat's environment |
| model check | `SAFE_MODEL` only (`advisor.ts:596`) | must be a `provider/id` key of the roster `models` catalog, passed in `CREW_ADVISOR_MODELS` (`advisor.ts:573-581`, `:600-606`) |
| priced usage | none: `advisor_consult`/`advisor_usage` spend is written only when the endpoint is unset (`advisor.ts:1207`, `:1214-1220`); `ADVISOR_SPEND_COVERAGE` says so (`scripts/factory/ledger.mjs:1879`) | an `advisor_usage` row per consult (`scripts/factory/ledger.mjs:1541-1556`) |

So option (a) below is already half built, for pi and for pi only.

**Configuration is four environment variables, not the roster.** `CREW_ADVISOR` is the activation flag
(`advisor.ts:32`, checked at `:1271`). `CREW_ADVISOR_ENDPOINT` and `CREW_ADVISOR_MODEL` are operator exports that
`advisorBootRecord` reads from the boot environment (`crew/crew.mjs:353-371`). `CREW_ADVISOR_MODELS` is the catalog
the boot hands down. The pi adapter writes all four into the seat's environment: the rpc/acp launch at
`crew/adapters/adapter-pi.mjs:279-284` and the pane command at `:420-426`. At boot the endpoint is probed
(`crew/crew.mjs:411-423`). The journal gets a projection with host and port only (`crew/crew.mjs:376-384`), and the
#809 comment records that the endpoint's host is not part of the safety boundary. Only the scheme, the absence of
credentials and `SAFE_MODEL` are closed (`crew/crew.mjs:315-322`).

**The grant is per seat and is off everywhere.** `crew/capabilities.json` carries `"advisor": false` on all five
seats: lead `:54`, planner `:77`, builder `:112`, reviewer `:152`, tech-lead `:173`. The boot admits a grant only on
the roles in `ADVISED_ROLES` = builder, planner (`crew/crew.mjs:294`, `:405`; the extension's own copy is at
`advisor.ts:46`). It also admits it only on a pi adapter (`adapter-unsupported`, `crew/crew.mjs:407`), because the
extension is loaded with pi's `-e` (`crew/adapters/adapter-pi.mjs:265`, `:273`).

**Nothing that resolves a seat ever sees the advisor.** The roster's tiers seat lead, planner, builder, reviewer
and tech-lead (`crew/roster.json:4-92`). No tier has an advisor cell, so none of these reach it: the tier floor,
the ratified ladder (`crew/crew.mjs:1165-1169`), the `--model-<role>`/`--agent-<role>`/`--effort-<role>` overrides
(`crew/crew.mjs:1083-1085`), the routing policy (`crew/routing-policy.json`) or the adapter's model translation
(`resolveSeatModels`, `crew/crew.mjs:1128-1140`). Three results:

- **Model spelling differs from a seat's.** A seat's cell is translated by its adapter, and pi spells `openai` as
  `openai-codex` and `meta` as `openrouter/meta` (`PI_PROVIDERS`, `crew/adapters/adapter-pi.mjs:105`). The pi-child
  channel passes the roster key raw to `pi --model` (`advisor.ts:1098`). *Not measured here:* whether
  `openai/gpt-6-sol` resolves inside pi. The seat path exists because nobody assumes that it does.
- **The breaker cannot see the advisor.** A dead endpoint records a synthetic cell
  `{agent: 'advisor', provider: 'local', id: <model>}` (`crew/crew.mjs:416-420`). No roster cell can equal it, because
  the breaker keys on `(provider, id, agent, effort)` (`crew/breaker.mjs:76`).
- **The record is incomplete.** `crew.json` carries the advisor record (`crew/crew.mjs:3310`), but no `run_seats`
  row names an advisor cell, so no ledger query can join advisor spend to a seat.

**The advisor child reads the checkout, not only the delta.** The pi child is granted `read,grep,find,ls` and runs
with `cwd` set to the seat's worktree (`advisor.ts:1098-1099`). `redactDelta` therefore bounds what the consult is
*sent*, not what the child can *read*. The boundary a provider advisor would have is the one every seat on that
provider already has. It is not a new, narrower one.

## Decision

### 1. `advisor` is a roster role, resolved at boot like every seat

- Every tier in `crew/roster.json` may carry an `advisor` cell `{provider, id, agent, effort}`, and the same shape
  goes into `crew/roster.schema.json`. `null` or absent means no model channel. Tier 0 still runs wherever the seat is
  granted, because it needs no model.
- `resolveTier` resolves it with every other seat. That includes `--model-advisor`, `--agent-advisor`, `--effort-advisor` and
  the per-stage effort dial, the ladder's tier floor through `bandForMember`/`bandForRaw` (refuse, never downgrade), the
  routing policy (which may narrow and order, as it does for seats), and `assertCellsClosed`. An open advisor cell
  refuses the boot as ADR-032 requires. It is never rerouted.
- The resolved cell is recorded like a seat's: `crew.json` `seats.advisor`, the boot journal's run configuration,
  and a `run_seats` row with role `advisor`. It is translated by its adapter's `modelString`, never passed raw.
- **It is a consult cell, not a process.** Under the recommended transport (§2) nothing is spawned at boot for it.
  It is not in `ROLE_ORDER` (`crew/crew.mjs:165`), so pane layout, the daemon's seat count and the turn census are
  unchanged.

### 2. A consult is a one-shot adapter print, the same path for local and provider

Three transports were weighed. A consult happens at a tool boundary, is bounded (20 per epoch, 20 s each), and its
answer is asynchronous advice nobody waits on. So latency matters less than identical behaviour does.

- **(a) One-shot adapter print per consult — recommended.** For `agent: pi` this is the existing child
  (`advisor.ts:1098-1099`) with its `--model` taken from the cell's adapter translation, not the raw key. For
  `agent: claude` it is `claude -p --output-format json`, which is new. **The child gets no tools** (operator decision 5): it answers from the scrubbed delta it is sent, so `redactDelta` bounds everything the advisor can see. The existing pi child's `read,grep,find,ls` grant is removed. Auth,
  model spelling and provider selection are whatever the adapter does for a seat. Pricing comes from the stream
  reducer that already produces `advisor_usage` (`advisor.ts:1100`, `:1214-1220`). A llama-swap cell and a provider cell
  differ only in their roster entry. The cost is a process spawn and a cold context per consult (`--no-session`), and
  the 20 s timeout was sized for a LAN model. It is unmeasured against a provider model; it stays 20 s until the first model-channel lane measures it (operator decision 6).
- **(b) The adapter hands endpoint and credentials to the extension's HTTP client — rejected.** The builder seat's
  environment would then hold a provider credential that its own `bash` tool can read. The client would
  re-implement per-provider request shapes and usage parsing that the adapters already own. It also cannot use
  subscription auth: pi's `openai-codex` route is the ChatGPT login, not an API key.
- **(c) A long-lived advisor seat over ACP — deferred.** This buys session cache reuse and makes the advisor a seat
  in every sense, including the census and the turn ceiling. It costs a process for the whole lane, a driver-side
  consult route (the extension runs inside the builder's process, and the driver does not), and it inherits the ACP
  turn-census gap that `57647f5c` answered by leaving ACP seats unceilinged. Reconsider it only if (a) measures badly
  on latency or cost.

**Which builders can be advised.** The extension loads only into a pi seat (`crew/adapters/adapter-pi.mjs:265`), so
the *advised* seat must be pi. The *advisor cell* may be pi or claude, because under (a) the pi extension spawns
whichever print command the cell names. Every tier seats its builder on pi today (`crew/roster.json`), so this
excludes only a `--agent-builder claude` override. The boot keeps refusing that grant with `adapter-unsupported`.
Advising a claude seat would need a Claude Code hook with the same predicates. It is out of scope.

**What "behave the same" means under failure.** A provider failure (429/529/401) is classified exactly as it is for
a seat, and it counts on the advisor cell's breaker window. Its *consequence* differs on purpose: advice has no
authority, so a failed consult ends that consult (`transport-failed`, recorded) and never the lane. That is the one
place the advisor does not behave like a seat, and it follows from the invariant in §4.

### 3. Which seats are advised

- **Builder: yes.** Grant it per seat in `crew/capabilities.json`, which stays on the protected floor
  (`crew/protected-paths.mjs:12`). The grant is its own decision. This record does not flip it.
- **Planner: not yet.** A plan already passes the planner's own gate baseline, plan-check and the lead. The planner is
  the quota cost: `docs/decisions-needed.md:27` puts its fixed overhead at 169 s per assignment, 19.4 h over 414
  assignments. `PLANNER_SYSTEM_PROMPT` and planner admission stay in code, ungranted.
- **Reviewer, lead, tech-lead, scout: no.** They are judgment seats whose output is already reviewed or adjudicated.
  An advisor there advises the adjudicator.

### 4. Ledger and authority

- `advisor_usage` gains the cell as written (`provider`, `model_id`, `agent`, `effort`), stamped by the consult,
  never re-joined, as ADR-046 Amendment 1 requires. Rows written before the change are ingested with a null cell and
  the reason `pre-adr-047`.
- The HTTP channel and its unpriced consults are retired, which makes `ADVISOR_SPEND_COVERAGE`'s "the HTTP advisor
  channel writes none" clause history.
- **Invariant, unchanged and restated:** a note has no verdict, no interruption, no resume and no escalation path. It
  is steer text at a tool boundary. No gate, stage or envelope reads an advisor note. The kill-mutation for this
  lane: make any driver stage branch on an `advisor_note` row, and a test must go red.

### 5. What the environment variables become

- `CREW_ADVISOR_ENDPOINT` and `CREW_ADVISOR_MODEL` stop being operator configuration. **Recommended:** `bootCmd`
  refuses a boot whose environment sets either one, with a new closed refusal `advisor-env-retired` naming
  `--model-advisor`. Silently ignoring them was rejected: a stale shell export would then disagree with the boot record
  and nobody would see it. Kill-mutation: delete the check, and an env-configured endpoint receives the delta again.
- The cell reaches the extension through `advisor-manifest.json` (`crew/crew.mjs:3713-3737`), which already sits in
  the task dir and which the extension already re-reads each epoch. The manifest gains the resolved cell and its
  adapter's command. `CREW_ADVISOR_MODELS` goes, because the manifest carries the one translated model.
  `CREW_ADVISOR=1` may stay as the adapter's activation signal.
- Consequence: today a granted run with no `Tripwire tests:` section in its brief refuses
  (`advisor-manifest-unavailable`, `crew/crew.mjs:427-456`). Once the manifest carries the cell, an empty tripwire
  list must become a valid manifest. Otherwise the model channel stays hostage to tier 0's inputs.

## Measurement plan

The instrument exists: `docs/advisor-ab-protocol.md` and `node scripts/factory/ledger.mjs advisor-ab`, with a floor of
12 review dispatches per arm. Ratify-or-delete stays the operator's, taken only from a complete readout.

1. **First lane, tier 0 only** (advisor cell overridden to `null` with `--model-advisor none`, builder granted). This measures what the deterministic layer
   does on its own at zero model cost.
2. **Then the model channel**, one cell at a time. Changing the cell between arms is a new arm.

What "the advisor helped" means in ledger terms, each with its denominator:

| measure | numerator / denominator | available today? |
|---|---|---|
| notes per builder assignment | injected `advisor_note` rows / builder assignments (`seat_turn_census`) | yes, from the journal |
| tier-1 yield | injected tier-1 notes / consults (`advisor_consult` rows), with the rejected and suppressed codes broken out | yes |
| acted-on rate | notes whose target file is edited, or whose failing check next passes, within K = 5 tool calls / injected notes | **no**: notes carry no tool-call ordinal. The extension must stamp `call_ordinal` on each note. Until it does, this cell is `null` with reason `ordinal-unstamped` |
| rounds saved | build rounds per run (`build:r<n>`), arm B vs arm A, matched by assurance preset and builder cell | yes (`advisor-ab-protocol.md` §1) |
| note-to-finding overlap | findings with a resolved injected note / review findings | yes (`advisor-ab`) |
| cost | priced `advisor_usage` spend / lane spend on the same lanes | from this ADR onward. Earlier HTTP-channel spend is uncounted, never zero |

A local cell's zero cost is counted and never reported as a saving (ADR-037). A readout below the floor is `thin`,
not a result.

## Migration: two lanes

1. **Roster, boot, manifest.** `crew/roster.json` and its schema gain the advisor cell. The **build tier ships `anthropic/claude-sonnet-5`**; the mechanical and judge tiers ship
   `null` (operator decision 2). `--model-advisor none` is the explicit override to `null`. `resolveTier` and the override flags, the ladder floor,
   the breaker, `crew.json`/journal/`run_seats`, the manifest writer and the `advisor-env-retired` refusal come with
   it. It touches the protected floor, so it runs rigorous with a kill-mutation on each changed behaviour. The lane
   still writes the environment the extension reads, so nothing breaks between the two lanes.
2. **Extension reads the manifest.** `advisor.ts` takes the cell from the manifest, spawns the cell's adapter print
   command (pi today, `claude -p` new), drops the HTTP channel, and stamps the cell and `call_ordinal`. The pi adapter
   stops writing the retired variables.

## Out of scope

Advising a claude seat. An ACP advisor seat. Flipping any grant. The planner grant. Any interrupting or blocking
advice. Changing the tier-0 predicates or the system prompts. The ship-by-default decision. The LAN trust boundary for
local cells, which stays ADR-037's.

## Operator decisions (2026-09-27)

1. **Breaker:** a consult's provider failure counts toward opening the advisor cell, exactly as a seat's does.
   The consequence stays advisory: a failed consult ends that consult, never the lane.
2. **Default cell:** the build tier ships `anthropic/claude-sonnet-5`; mechanical and judge ship `null`.
3. **Advised seats:** the builder only. The planner is not advised yet; revisit with builder data. Reviewer, lead,
   tech-lead and scouts are never advised.
4. **Retired variables:** a boot that sets `CREW_ADVISOR_ENDPOINT` or `CREW_ADVISOR_MODEL` refuses with
   `advisor-env-retired`, naming the variable. Ignoring them would report a configured advisor while another ran.
5. **Advisor tools:** none. The child answers from the scrubbed delta only, so a provider cell never reads the
   checkout. Read tools are reconsidered only if measured advice shows it lacks context.
6. **Timeout:** stays 20 s. A timed-out consult is recorded as unmeasured, never as advice and never as "no issue".
   The first model-channel lane records p50/p95 consult latency; any change is taken from that.
7. **Breaker row (2026-09-28):** the advisor cell gets its OWN breaker row and verdict. With no history it reads
   `unmeasured`, never a guessed `closed`. The seats' aggregate verdict is computed exactly as before, over the seats
   alone, so an unmeasured advisor never changes it. An OPEN advisor row still refuses the boot (decision 1).
8. **Availability (2026-09-28):** the boot refuses an unavailable advisor agent ONLY when some seat is granted
   `advisor: true` AND the cell is non-null, that is, when a consult will actually happen. A null cell,
   `--model-advisor none`, or no granted seat never blocks a boot.
9. **Default grant (2026-09-28):** lane 1 ships the builder's `advisor` grant OFF in `crew/capabilities.json`, so no
   lane loads or consults the advisor after lane 1 merges. Lane 2 lands delta-only consults and recorded consult
   failures; then the grant is flipped, and the tier-0 arm (measurement step 1) runs first.
   Flipped 2026-09-29 after lane 2 merged (PR #1614).
10. **Advisor floor and strength arms (2026-09-29):** the advisor writes nothing, so its cell is held to its own
    floor, `ADVISOR_FLOOR_BAND = 'basement'` (`crew/crew.mjs`), not the tier's; every seat keeps the tier floor.
    The operator wants concrete numbers on advisor strength, so the model channel runs four arms, one cell each,
    rotated on ordinary build-tier lanes at dispatch with `--model-advisor`: `none` (tier 0),
    `anthropic/claude-haiku-4-5` (basement), `anthropic/claude-sonnet-5` (workhorse, the shipped default) and
    `anthropic/claude-opus-5-5` (frontier). Each arm needs the protocol's floor of 12 before it is read.

## Reverses if

The tier-1 channel, run on the roster path over a complete `advisor-ab` readout at the floor, shows no overlap and no
saved rounds, with a real cost. Then the model channel is deleted and tier 0 stays. That is the ratify-or-delete call
the protocol already reserves for the operator.
