# ADR-035: Run configuration is five independent axes; `--variant` and `--tier` retire after one release window

**Status:** RATIFIED 2026-08-30 · **Source:** issue #778 (epic #788) · **Record:** `docs/trd-task-configuration-and-run-state.md` §1, §3, §4, §13 decision 1

## 1. The decision

A run is described on **five independent axes**, and no value on one axis may
be read as a value on another:

1. **Task profile** — what outcome the user needs (`implementation`,
   `bug_fix`, `investigation`, `code_review`, `qa_verification`,
   `test_authoring`). Declared in `crew/task-profiles.mjs`.
2. **Execution shape** — which deterministic workflow the driver runs (`full`,
   `directed`, `scout`, `repair`, and the pending `review_only` and
   `verify_only`). Declared in `crew/variants.mjs`, with the two pending shapes
   named — and only named — in `crew/task-profiles.mjs` until #783/#784 make
   them executable.
3. **Assurance preset** — how much staffing and oversight the run receives
   (`quick`, `standard`, `rigorous`). Declared in `crew/assurances.mjs`.
4. **Seat allocation** — the actual agent, model, effort and transport used by
   each role. Owned by `crew/roster.json` and the runtime policy that reads it;
   no declaration leaf may name a seat.
5. **Override record** — where the effective configuration differs from a
   recommendation or a ratified default. It is a **distinct record of
   divergences**, landed in a later phase, and it is not the same thing as
   provenance: Phase 1's `{requested, effective, source}` per axis records how a
   value was chosen even when nothing diverged, so it supplies the *inputs* from
   which an override record is derived. Reading a `source` value as the override
   record would collapse axis five into axis one through three and contradict
   the independence this record establishes.

`mechanical`, `build` and `judge` were never task profiles: they are the legacy
names of the assurance presets `quick`, `standard` and `rigorous`. `full`,
`scout`, `repair` and `directed` were never assurance levels: they are
execution shapes. The overload is what this record ends.

## 2. Why the separation is worth a record

The old vocabulary answered three questions with one word, so the ledger could
not answer any of them. `tier` meant task shape, staffing, model strength and
display category at once; the compiler's `proposed shape` used the tier
vocabulary to describe a risk axis; the actual variant reached the task journal
but not the session row. Every consumer downstream — the visualizer above all —
was forced to *infer* concepts the ledger never measured, which is how
"1 open · 1 stale" came to be shown for one unsettled record whose runtime
state was simply unknown.

Separating the axes is what makes each fact recordable. Once profile,
execution, assurance, seats and overrides are distinct, "what was requested",
"which workflow ran", "how much assurance applied" and "which of those were
defaults" are five answerable questions instead of one ambiguous label.

## 3. Consequences

- Resolution is deterministic and provenanced: explicit canonical request,
  explicit compatibility alias, profile recommendation, migration default — and
  every axis reports `{requested, effective, source}`. The driver receives only
  `effective`; the ledger receives all three. This provenance is evidence for
  the override record, not the override record itself.
- `crew/variants.mjs` remains the sole owner of the executable execution shapes.
  The resolver is given `VARIANT_NAMES` and decides recognition and status from
  it; a shape the §3.3 compatibility matrix names and `crew/variants.mjs` does
  not yet declare resolves as `declared-pending`, never as unknown. No second
  shape catalog is created.
- An incompatible (profile, execution) pair **refuses** before state, panes or
  worktrees are created, naming the selected values and the allowed
  combinations.
- A task profile is **never inferred**. A compatibility entry point may record
  it as null with source `legacy_missing`; nothing may guess it from the brief,
  the title, the seat count or a compiler proposal.
- The declaration leaves import nothing. `crew/task-profiles.mjs`,
  `crew/assurances.mjs` and `crew/run-configuration.mjs` name and resolve; they
  do not staff, execute, read the filesystem or touch the ledger. The daemon's
  leaf allowlist in `crew/daemon.test.mjs` pins that posture.
- Assurance **names, the roster staffs**. Required seats, capability floors,
  effort, vendor diversity, reseat order and protected-path minimums stay where
  they are; renaming the ladder weakens none of them.

## 4. The deprecation window

`--variant` remains a deprecated alias for `--execution`, and
`--tier mechanical|build|judge` a deprecated alias for
`--assurance quick|standard|rigorous`. TRD §4.2 asks for "one full release
window" without saying what a release is here, and §13 decision 1 requires that
gap to be settled by record rather than guessed lane by lane. It is settled
here:

> The deprecation window is **one release window**, measured as the next tagged plugin release.

Concretely: the aliases keep working through the next `v*` tag published from
this repository — the tag *after* the one current when this record was
ratified, `v0.1.13`. They are removed in the release that follows it. Until
then, supplying an alias is accepted, warned about in CLI output, and recorded
in ledger provenance with source `alias`, so the removal lands against measured
usage rather than a guess.

Two rules hold for the whole window:

- **A canonical flag supplied together with its alias refuses, even when the
  values agree.** There is no precedence rule to remember and no silent winner.
- **The internal old keys remain readable indefinitely.** Retiring the *flags*
  does not retire the ability to read a historical row that used them; a value
  that was never recorded is displayed as **Not recorded** and is never
  reconstructed.

## 5. Alternatives rejected

- **Keep `tier` and add meanings.** Rejected: the overload is the defect. A
  fourth meaning would make the ledger less answerable, not more.
- **Infer the task profile from the brief.** Rejected explicitly by TRD §4.5:
  mechanical text classification is exactly the inference the visualizer was
  forced into, and moving it upstream only hides it.
- **Let the alias and the canonical flag coexist when they agree.** Rejected:
  "agree" is a judgement about two vocabularies mid-migration, and the moment
  they diverge the silent winner is unrecorded. Refusing is one rule.
- **An open-ended deprecation window.** Rejected: an alias with no removal date
  is a permanent second vocabulary, which is the state this record exists to
  end.

*Revisit if:* a sixth axis appears that is not seat allocation in disguise, or
the next tagged release arrives with alias usage still material.
