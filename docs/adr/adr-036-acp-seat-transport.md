# ADR-036: ACP is the headless seat transport; the envelope stays the record

**Status:** WRITTEN 2026-08-31 · **Source:** issue #792 · **Record:** `docs/trd-acp-adoption.md` §4.2, §4.3, §4.5, §6 Wave 0, §9, §10

This record is written, not ratified; no Wave 1 lane starts before the operator ratifies it.

## 1. Context — what already ships

This record starts from the transport and outcome boundaries already present in the checkout, rather than making the protocol responsible for facts it does not own.

- `crew/seat-io.mjs:35-36` names the two bespoke headless transports already shipped: `headless-json` and `headless-rpc`. The pane transport is a separate mode.
- `crew/drive.mjs:627` contains the `validEnvelope` check whose `assignment_id` comparison prevents a stale return from satisfying a new assignment. That anti-replay boundary belongs to the envelope, not to a transport.
- The Pi adapter documents its `tool_deny` capability at `crew/adapters/adapter-pi.mjs:20-24`; its `translateDeny` seam is the adapter boundary that maps the roster's Claude-named deny list into Pi names.
- The bespoke signal dance is visible at `crew/headless-rpc.mjs:33-35` for the exit-marker window and repeated TERM delivery, and `crew/headless-rpc.mjs:36` for FIFO retries. It is operational machinery of the retiring transport, not an outcome record.
- ADR-029 keeps the rule that `idle ≠ success` (`docs/adr/adr-029-headless-observability-interjection.md:23`, `docs/adr/adr-029-headless-observability-interjection.md:146`). A screen, stream, heartbeat or process state may be transport and observability, but the envelope and durable task records remain authoritative.

The ACP facts in this record are attributed to the TRD's reading of upstream protocol and adapter documentation. This lane did not boot an ACP adapter; the Wave 0 spike is the place to verify the upstream behaviours that are explicitly named as gaps below.

## 2. Decision 1 — ACP is the headless seat transport

Every headless seat speaks ACP: JSON-RPC 2.0 over stdio, protocol version 1. `acp` is a fourth transport beside `pane`, `headless-json`, and `headless-rpc`.

The envelope stays the record. **ADR-029 is unchanged**: the stream is transport and observability, `idle ≠ success`, and a seat still writes its envelope to its `returnPath`. ACP changes how the driver runs and observes a headless seat, not how the seat answers. `validEnvelope`'s `assignment_id` anti-replay check remains untouched.

The lifecycle is the protocol client's responsibility: initialize, create or resume a session, prompt, fan out updates, and await the protocol's turn result. `stopReason` and update events are recorded alongside the envelope, but neither can make an absent or invalid envelope authoritative. These are the TRD §1, §1.1 and §4.1 decisions, not a live measurement from this lane.

## 3. Decision 2 — the client is hand-rolled

The plugin ships zero runtime dependencies. `@agentclientprotocol/sdk` would be the first runtime dependency, and it is not adopted.

The used protocol surface is small and fixed. A hand-rolled client is approximately 150 lines of NDJSON framing plus JSON-RPC request/response correlation; its types come from the published schema and are pinned by test. The zero-dependency rule has paid for itself in installability, while the SDK's client API is documented only by example. Those §4.2 reasons outweigh the convenience of importing schema types and a connection helper.

The client therefore owns only the protocol surface the crew has measured or explicitly requires: framing, correlation, the session lifecycle, update dispatch, permission responses, cancellation, and process reaping. Draft protocol features are read when present but are never required for a seat to finish.

*Revisit if:* a draft extension, including `fs` / `terminal` delegation, becomes required by the fixed client surface.

## 4. Decision 3 — permission is a decision, not a denylist

A permission request is a lead decision: the roster's `deny` becomes a policy, not a second outcome authority. What the policy settles is journaled as `{policy:'roster'}`.

What the policy does not settle is a closed-enum decision to the lead over the four ACP option kinds: `allow_once`, `allow_always`, `reject_once`, and `reject_always`. The selected option and the decision are journaled as `{policy:'lead'}`. The lead chooses by option id from the request; the client does not invent an option or silently approve an unrecognised one.

With no lead seated, the request is answered `reject_once` and journaled as `{policy:'no-lead'}`. This preserves the unattended boundary: absence of a judge is not consent. The policy and its disposition are durable facts even when the protocol request itself is transient.

## 5. Decision 4 — provider fallback is one-shot and journaled

A `refusal` (or a typed quota/limit failure) on a turn that produced no envelope is cause `budget`, never `transport`. There is one fallback per assignment.

The switch is journaled as `seat-fallback` with `from`, `to`, and `cause`. The same `assignment_id` is re-asked on the next roster entry. A second refusal escalates with cause `budget`; it does not silently cycle through providers or reinterpret the refusal as a broken wire.

This is the §4.5 and §9 policy. The fallback path is deliberately bounded so a provider outage remains visible in the journal and cannot become an unbounded retry loop.

## 6. Decision 5 — when the two bespoke transports retire

The retirement criterion is: retire `headless-json` and `headless-rpc` only after at least 10 lanes over `acp` across both agents with no transport-caused escalation.

`reclaim.mjs` is kept. The criterion is gated on the measurement, not the calendar. Until it is met, both existing paths stay pinned byte-identical; ACP is additive and does not make an unmeasured replacement authoritative. Wave 5 may remove the old parser and supervisor only after the comparison is recorded.

## 7. Decision 6 — the machinery budget is an ask-user finding

R2's machinery budget is an `ask-user` finding, not a refusal. The R9 evidence settles this disposition: the cap, not convergence, ends most judge-tier planning, and unbounded rounds are not the same as wrong rounds. The finding therefore goes to the lead or operator instead of being auto-rejected by machinery.

**Re-open condition:** a measured slop count, not a round count, shows that the adopted budget is producing unwanted surface. Until that measurement exists, round volume alone is insufficient evidence for turning the finding into a refusal.

## 8. Measured evidence — R9

The issue comment is reproduced verbatim:

```text
## R9 measured (Wave 0) — tech-lead rounds by seat model, 2026-08-28 → 08-30

**Method.** Counted distinct `"stage":"plan:rN"` / `"check:rN"` rows per lane journal under `~/.crew`. The ledger cannot answer this today: `phases.name` carries no round names (0 matches on `check:%`/`plan:%` across 45 sessions) — a gap for #787.

**Denominator:** 34 lanes with a journal; 11 judge-tier lanes seated `openai/gpt-5.6-sol` as tech-lead; 23 build/mechanical lanes with no tech-lead.

| tech-lead seat | lanes | plan rounds | check rounds | hit the plan cap (3) |
|---|---|---|---|---|
| **gpt-5.6-sol** | 11 | 3,3,3,3,4,3,1,3,0,2,3 | 3,3,3,3,4,3,0,3,0,1,3 | **8 of 11** (b318 went to 4/4) |
| none | 23 | 1 in every lane | 0 | 0 of 23 |

Per lane (sol): b295 3/3 · b304 3/3 · b306 3/3 · b312 3/3 · b318 4/4 · b321 3/3 · b322 1/0 · b324 3/3 · b325 0/0 (escalated at gate) · b329 2/1 · b330 3/3 · b332 3/3*.

* b332's journal merges the escalated run and today's re-dispatch (same crew dir, #711's shape), so its count is contaminated; excluding it the cap rate is 7 of 10.

**Reading.** With a tech-lead adversary the plan goes to the round cap in ~75% of lanes; without one it never exceeds one round. That is consistent with kunchenguid's 2026-08-30 claim (adversarial loops over-engineer; sol named) — but **round count is not slop count**: b306 and b312 merged clean after 3/3. What the numbers prove is that the cap, not convergence, ends most judge-tier planning. The lever the TRD proposes (R5: one tech-lead round for an adopted plan) targets exactly the case measured on b330 and b332.

**For the ADR:** decision 6 (machinery budget as refusal vs `ask-user`) should stay `ask-user` on this evidence — the adversary's rounds are not shown to be wrong, only unbounded.
```

> **Source consistency note.** The quoted per-lane list names 12 sol lane IDs while its denominator, table row, and value arrays report 11; this record preserves the issue comment verbatim and does not guess which named lane is outside that denominator.

plan growth by seat model is unmeasured — the R9 run reported rounds only; #787 is the ledger gap that keeps it unmeasurable today.

## 9. Named gaps

The TRD §9 limitations are named gaps, not losses hidden by this record.

- **Pi permission requests.** pi-acp does not implement `session/request_permission`. The verified adapter-side boundary remains `--exclude-tools` (`crew/adapters/adapter-pi.mjs:130`), so Pi seats keep that tool exclusion and Pi permission escalation is out of scope until upstream lands it. The protocol limitation is TRD-attributed and was not live-verified by this lane.
- **Claude SDK mapping.** `@agentclientprotocol/claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk`, not the `claude` CLI. The effort flag, `--append-system-prompt`, per-seat settings files, and the `"<synthetic>"` refusal shape are CLI behaviours; each needs an SDK equivalent pinned by a Wave 0 fixture before a Claude ACP seat is trusted at judge tier. This mapping is also TRD-attributed rather than a live boot result here.

## 10. Alternatives rejected

- **Depend on the published ACP SDK.** Rejected: the fixed protocol surface does not justify adding a runtime dependency, and the installability rule is a deliberate constraint rather than an incidental absence.
- **Adopt acpx itself.** Rejected: acpx brings a session store and flow runtime the crew already has in its journal, ledger and driver; adopting its client would duplicate ownership instead of adopting the wire protocol.
- **Keep two bespoke transports and add ACP only for new agents.** Rejected: that preserves two wait, signal and observability contracts and leaves the headless fleet without one transport boundary.
- **Make the no-lead default `allow_once`.** Rejected: an unattended request must not become approval merely because no lead is seated.
- **Allow unlimited fallback.** Rejected: repeated provider refusal would become an unbounded retry loop and hide a systemic budget failure.
- **Retire on a calendar date instead of on the measurement.** Rejected: transport stability must be demonstrated across real lanes, not inferred from elapsed time.
- **Make R2 a refusal.** Rejected: the R9 result measures unbounded adversarial rounds, not wrong rounds or a measured slop count.

## 11. Consequences

Waves 1–5 inherit these boundaries:

- Wave 1 hand-rolls the client with zero runtime dependencies and tests only recorded protocol sessions. Recorded sessions in `test/fixtures/acp/` are the only agent any ACP test talks to; no ACP test boots a live Claude or Pi adapter.
- Wave 2 adds the `acp` seat path and the lead permission policy without changing the envelope contract. No lane may hold `crew/seat-io.mjs` before b334/#777 lands. The pane path and the two bespoke paths remain unchanged until their measured retirement condition is met.
- Wave 3 records protocol usage and stop reasons in the ledger. An absent `usage_update` is recorded `unpriced`, never zero; a known cost remains distinct from an unmeasured cost. A budget fallback carries the same assignment id and its journaled cause.
- Wave 4 carries the machinery-budget finding to the lead or operator as `ask-user` and prefers simplification over auto-adding surface. Its round evidence must not be presented as a slop measurement.
- Wave 5 retains `reclaim.mjs` and removes the bespoke parser and supervisor only after the cross-agent lane threshold and no-transport-escalation condition have both been measured. The calendar cannot substitute for that evidence.

The operator ratifies this record before Wave 1. Until then, these are recorded decisions and named gaps, not permission to begin implementation.
