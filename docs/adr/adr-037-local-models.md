# ADR-037: Local models are LAN-trusted, band-admitted by ratified evidence, and counted at zero cost without ever reading as savings

**Status:** RATIFIED 2026-08-30 · **Source:** issue #807 · **Record:** `docs/trd-local-models.md` §5 reserves exactly these three decisions to this document.

## 1. Context — what already ships

Nothing below builds a runtime. Five facts, all verified in this checkout on
2026-08-30, are what these decisions govern:

- `crew/capabilities.schema.json:50-77` declares the `local_providers` register
  and types `base_url` with a pattern admitting both schemes and imposing no
  host restriction. That pattern is what decision 1 turns from an oversight into
  a decision.
- `classifyAdvisorCell` (`crew/crew.mjs:183-198`) admits an advisor endpoint only
  on `127.0.0.1`, `localhost` or `[::1]`. It tests scheme and locality first and
  the URL's credentials second, so the two refusals it can return are ordered,
  not interchangeable — decision 1 states that ordering exactly rather than
  paraphrasing it.
- `crew/model-ladder.json:5-41` declares four bands — `frontier`, `workhorse`,
  `utility`, `basement` — and `assertBandFloors` (`crew/crew.mjs:816-830`)
  refuses a seat only when its band ranks strictly **below** the tier floor.
  Every band at or above the floor is admitted.
- `crew/model-ladder.json:42-46` sets `tier_floors.judge` to `utility`. A judge
  seat therefore accepts `utility`, `workhorse` and `frontier` alike today.
- `scripts/factory/ledger.mjs:4776-4780` already separates *unpriced* from
  *free*: a cell with no rate carries a null cost and the absent reason
  `unpriced, never free`. Token volume is kept four ways — input, output,
  cache-read and cache-write (`scripts/factory/ledger.mjs:1790-1793`,
  `:1876-1879`) — and no aggregate column exists. Decision 3 is what keeps a
  local cell from counterfeiting the other side of that distinction.

## 2. Decision 1 — the LAN trust boundary

The advisor cell and any screener seat **read task material**: briefs, diffs,
plans, findings, and whatever the checkout contains. A local endpoint therefore
sits inside the same trust boundary as the operator's own working copy, and it
is admitted on exactly these terms and no wider.

- **Permitted.** An endpoint served by the operator's own machine, or by a
  second machine the operator administers, reachable
  only on a private home LAN the operator administers and trusts. It is not
  "being local" that admits the endpoint; it is being inside a network boundary
  the operator owns.
- **Plaintext transport is an accepted risk, not the absence of one.** Sending
  briefs, diffs and plans over unencrypted HTTP on that link is
  an explicitly accepted risk: any other peer on that LAN can observe or modify
  the task material in transit, and TLS is exactly what would prevent it. This
  record accepts that exposure only because the LAN is operator-administered and
  trusted, and it does not pretend the property disappears. Consequently
  HTTPS remains preferred wherever the served endpoint offers it. The schema's
  `^https?://` pattern is permissive by decision rather than by oversight, and
  what it does is *permit* the unencrypted scheme, never recommend it.
- **Refused.** An endpoint reachable from the public internet; an endpoint
  published through a third-party tunnel, relay or inference broker; and an
  endpoint served by a host the operator does not administer. Encrypting the hop
  makes none of the three acceptable, because the objection is to who can reach
  the endpoint, not to who can read the wire.
- **Credentials in an endpoint URL are
  refused for every endpoint, loopback or not.** A secret in a URL is logged,
  journaled and shell-historied wherever the URL is, and a local endpoint that
  needs one is asserting a trust boundary this record has already drawn
  elsewhere.
- **What the runtime enforces today, stated exactly and not paraphrased.**
  `classifyAdvisorCell`
  checks scheme and locality before credentials (`crew/crew.mjs:190-194`), so a
  non-loopback URL carrying credentials is refused as `endpoint-not-local`, and
  only an otherwise-acceptable loopback URL ever reaches `endpoint-credentials`.
  The prohibition in the bullet above is normative and wider than that check;
  when L1 widens the host set it must keep the credentials refusal reachable, or
  the normative rule loses its only enforcement point.
- **Not widened here.** The advisor stays loopback-only until lane L1 lands.
  This record authorises L1 to widen `classifyAdvisorCell`'s host set to the
  private LAN and requires the endpoint host to be journaled at boot so a dead
  LAN box names itself; it does not itself perform that widening.
- **"Private LAN" is an operator assertion, not a runtime check.** The runtime
  refuses only what it can see — a scheme outside the pattern, credentials in
  the URL, a dead endpoint. Public exposure is refused by this record; an
  operator who exposes the endpoint anyway has broken the decision rather than
  found a loophole, and no configuration key is added to let them declare
  otherwise.

*Reverses if:* the task material stops being operator-private — a shared or
hosted crew, or any deployment where
the endpoint's administrator and the checkout's owner are different parties.
Then the boundary is an authentication problem, plaintext on the link stops
being an acceptable risk, and this record does not cover either.

## 3. Decision 2 — band admission

A local model is admitted to `crew/model-ladder.json` by band, and band
membership is the only thing that lets it hold a seat with a floor.

- **The progression is `basement → utility → workhorse`, one step at a time.**
  A local model enters at `basement` — unmeasured against this repo's work is
  the default, never a courtesy band — and each step up is a separate,
  deliberate change to a protected file.
- **The measurement is
  manual ratification with the evidence in the PR.** Until something better
  exists, a promotion PR must carry the evidence that earned it: the lanes the
  model actually ran, their gate and review outcomes, and the seat it is being
  promoted for. A promotion with no evidence in the PR is refused at review; a
  band is never granted on a vendor's claim, a benchmark the repo did not run,
  or the fact that the endpoint is live.
- **The
  #291 calibration set is the intended successor** to manual ratification. When
  it exists, a promotion cites a calibration score against the reference set and
  manual ratification becomes the fallback for models the set does not cover,
  not the rule.
- **Frontier is closed.** A local model
  may never be admitted to the `frontier` band. That band's content is a
  measurement of a public model against a reference score, and the Artificial
  Analysis catalog cannot confirm a local model at all — a local `frontier`
  member would be an unmeasurable assertion in the one band whose whole content
  is measurement.
- **The closed frontier band
  does not by itself keep a local model out of a judge seat**, and this record
  says so rather than implying otherwise. `crew/model-ladder.json:42-46` sets
  `tier_floors.judge` to `utility`, and `assertBandFloors`
  (`crew/crew.mjs:816-830`) admits every band at or above the floor, so a local
  model promoted to `utility` or `workhorse` would already clear the judge floor
  with the `frontier` band still closed to it.
- **The prerequisite this record binds on L0.** Before any local model is
  admitted to `utility` or `workhorse`, L0
  must set `tier_floors.judge` to `frontier` — or land a source-aware rule
  mechanically equivalent to excluding every `source: local` model from judge
  tier. `workhorse` is not sufficient: it is above `utility` and this record
  permits local promotion into it, so a `workhorse` judge floor still admits a
  local judge. That ladder edit is L0's protected-file change and is
  deliberately not made here; what is made here is the requirement that it land
  first.

*Reverses if:* a local model is
measured against the same reference set the `frontier` band's scores come from,
on the same terms as a public model. The prohibition is grounded in
unmeasurability, so it ends when the measurement exists — and not before.

## 4. Decision 3 — cost accounting

Local tokens are **counted**, and their marginal price is **zero**. Both halves
are load-bearing, and reporting must never let the second one flatter a lane.

- **Counted, exactly as a paid seat's are.** A local arm emits the same billed
  token volumes as any other seat; the roster entry carries zero per-token rates
  with a `cache_rate_source` note saying local serving has no billed cache.
  Tokens are the work; the price is a separate fact about the work.
- **Reported in
  a dedicated local-token column of its own, never mixed into the paid-seat
  token columns.** Local volume is reported separately from paid volume so that
  the two are never read as one total. This record binds the *separation*, not a
  schema identifier: the ledger keeps volume four ways today — input, output,
  cache-read and cache-write — and what the field is called, and whether it is
  one column or four, is the reporting lane's design decision, not this
  record's.
- **Never a saving.** Local token volume is
  never folded into `cost_usd` as savings, and it is
  never subtracted from a paid seat's spend, and it is never used to compute a
  delta against a paid comparison. A lane that ran half its rounds locally is
  not a cheaper lane, it is a lane with a different mix, and a report that
  collapses those is lying about the comparison.
- **A known zero is a measurement; `null` stays unmeasured.**
  `scripts/factory/ledger.mjs` already refuses to read an absent price as a free
  one — its absent reason is literally `unpriced, never free`. A local cell is
  the mirror case: a
  known `0` is a measurement and is
  never written as `null`, and an unmeasured cell is
  never written as `0` because a local arm exists somewhere in the run. The two
  are distinct facts and are never merged, in storage or in any report derived
  from it.

*Reverses if:* local serving
acquires a marginal price the repo can measure — metered electricity, a rented
GPU, a per-token charge — at which point `0` stops being the true price and the
separate column stops being a special case.

## 5. Alternatives rejected

- **Require `https://` for every local endpoint.** Rejected as a *requirement*,
  not as a preference: it would make the schema's own pattern dead text and
  would refuse working deployments (LM Studio and Ollama serve plaintext by
  default) whose real risk is bounded by a LAN the operator administers. The
  preference stands — see decision 1 — and it is the reachability of the
  endpoint, not the encryption of the hop, that this record refuses on.
- **Let a live, fast endpoint earn a band.** Rejected: liveness and latency are
  not quality. That is precisely the promotion-on-no-evidence this record
  refuses, and the band floors exist so a cheap model cannot drift into a seat
  that judges work.
- **Rely on the closed `frontier` band alone to protect judge seats.** Rejected
  as measurably insufficient: the judge floor is `utility` and every band at or
  above a floor is admitted, so the ceiling and the floor must both move. This
  is why the L0 prerequisite is stated as a concrete band value rather than as
  "raise the floor".
- **Report local runs at a zero cost and call the difference a saving.**
  Rejected: it produces the one number this repo is most likely to act on and
  least able to defend. A saving is a comparison, and a comparison needs both
  arms measured on the same terms.
- **Report local cost as `null`.** Rejected for the opposite reason: `null`
  means unmeasured here, and this price *is* measured. Writing a known value as
  unknown corrupts the absent-marker vocabulary the ledger depends on.

## 6. Consequences

- `crew/capabilities.schema.json`'s scheme pattern needs no change; its
  permissiveness is now a recorded decision with a stated boundary and a stated
  accepted risk.
- Lane L1 may widen `classifyAdvisorCell` to a private-LAN host, must journal
  the endpoint host at boot, and must keep the credentials refusal reachable
  after the host set widens.
- **L0's ladder change must raise `tier_floors.judge` to `frontier` before** it
  admits any local model to `utility` or `workhorse` — or land the equivalent
  source-aware exclusion. Admitting a local model first and raising the floor
  afterwards is the ordering this record forbids.
- Any report or visualizer surface that aggregates spend reports local volume
  separately from paid volume, and gains no savings figure.
