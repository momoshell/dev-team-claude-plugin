# Technical Requirements Document: Local Models in the Factory

**Status:** Proposed for implementation

**Date:** 2026-08-30

**Scope:** Where self-hosted models (deployed on the operator's second desktop, served over the LAN) enter the crew — which seams already exist, which uses pay, which uses are refused, and the lanes that close the gaps.

---

## 1. Executive decision

Local models enter through seams the runtime already ships; no new runtime is built. Three facts govern everything below, all measured in this repo on 2026-08-30:

1. **`crew/capabilities.json` already declares a `local_providers` register** (schema: `crew/capabilities.schema.json`): `{ "<provider>": { settings: <relpath>, pi_provider: <name>, base_url: "http(s)://…" } }`. `adapter-pi.modelString` resolves a roster seat `{provider, id}` through it, boot probes `base_url` and refuses `local-settings-missing` / a dead endpoint by name. **A local model can hold a pi seat today** by filling this register — the seam is finished, empty, and tested.
2. **The advisor cell exists and is local-first**: `CREW_ADVISOR_ENDPOINT` + `CREW_ADVISOR_MODEL` (`advisorBootRecord`, `crew/crew.mjs:200`), builder-only, pi-only, pane-transport-only, endpoint probed before boot, cell recorded as `local/<model>`. Its refusal text assumes a **loopback** endpoint — the one change a second-machine deployment needs.
3. **The model ladder gates seats by band** (`crew/model-ladder.json`, `assertBandFloors`): a model not in a band cannot take a seat with a band floor. Local models therefore cannot drift upward into judge seats by accident; admitting one to a band is a deliberate, protected-file change.

The Artificial Analysis catalog cannot confirm a local model. Its roster entry carries `source: "local"`, true costs (0 per token is the true marginal price; the tokens are still counted), and it is **expected** to appear in roster-refresh's "cannot confirm" section — that section existing is the design, not a defect.

## 2. The use map

Ranked by value ÷ integration cost. **Programmatic-over-model-tokens still wins**: any step code can do stays code — local tokens are cheap, not free, and never authoritative without review.

| # | use | seam | status |
|---|---|---|---|
| U1 | **Advisor cell on the builder** — consult arm during builds | exists; needs the LAN change (L1) | hours away |
| U2 | **Fresh-context screener panel** — N cheap adversarial read-passes over a diff *before* the paid reviewer seat; findings arrive as **proposals** with `disposition` (#800), adjudicated by the real reviewer. The no-mistakes result (68% of AI PRs caught) is this shape; local models make N free | scout variant + #502/#509 fusion | lane L2 |
| U3 | **Mechanical-tier seats** — utility/basement-band builder on gate-first lanes: docs lanes, anchor repairs, fixture regeneration. The gate + kill-mutations are the safety, not the model | `local_providers` + roster + ladder | operator L0, then a measured experiment |
| U4 | **Monitors and classifiers** — journal-anomaly summaries, escalation-stream triage (propose a cause where `escalationCause()` says `unclassified` — recorded as proposal, never as measurement), CI/build watch digests, #787 report prose | new consumer, off critical path | lane L3, after #786/#787 |
| U5 | **Codemode-lab runners** (#498) and batch-shape arms (#532) — N independent verdicts, re-runnable programs | those epics' own seams | when those epics run |

**Refused uses**, so they are decisions and not drift: judge-tier seats (band floor stands); PR bodies and commit messages (composed by code, ADR-034); test authoring (quality-critical); anything whose output lands unreviewed in a protected file.

## 3. What the desktop deployment must provide

- An **OpenAI-compatible endpoint** per served model family (vLLM / LM Studio / Ollama all qualify — pi's local provider expects a `base_url` it can probe), reachable at a **stable LAN URL**; `base_url` already accepts `http://`.
- One `pi_provider` name per server, lowercase (`^[a-z0-9-]+$`).
- A checkout-relative `settings` file per provider (the register refuses a missing one by name).
- Per model: a roster `models` entry `local-<provider>/<id>` with measured context, `source: "local"`, zero token costs, and a `cache_rate_source` note saying local serving has no billed cache; a **ladder band decision** (default: `basement` until measured against the reference set, `utility` after).

## 4. Lanes and operator steps

- **L0 (operator + judge lane):** fill `local_providers`, add roster model entries and ladder membership. `roster.json`, `capabilities.json`-adjacent files and `model-ladder.json` are on the protected floor — this is one small judge lane once the endpoints are live, with the liveness probe output pasted into the PR.
- **L1 (build):** advisor endpoint may be non-loopback: probe unchanged, refusal text updated, and the endpoint host recorded in the boot journal so a dead LAN box names itself. Fence: `crew/crew.mjs` advisor block + tests.
- **L2 (build, after #800/b336):** screener panel — a `scout`-variant pre-review pass seated on a local provider, findings emitted in the #800 disposition shape as proposals to the reviewer seat; measured by must-fix yield against the b152 rubric before it earns a standing place.
- **L3 (build, after #786):** classifier consumers over the ledger/journal — proposals only, `unclassified` stays `unclassified` unless a human ratifies.

## 5. Decisions reserved for an ADR (037 — 035 landed, 036 is #792)

1. LAN trust boundary: the advisor and screeners *read* task material; local endpoints see briefs and diffs. Acceptable on the home LAN; record it.
2. Band admission: what measurement moves a local model `basement → utility` (suggest: the #291 calibration set, whenever it exists; until then, manual ratification).
3. Cost accounting: tokens counted, cost 0 — reports must not let 0-cost arms make lanes look cheaper than their paid seats (report local tokens in their own column).
