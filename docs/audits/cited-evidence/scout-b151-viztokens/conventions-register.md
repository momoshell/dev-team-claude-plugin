# Visualizer design-conventions register

Read-only recon for `b151-viztokens`. Source of truth is the checkout at
`/Users/x/Development/dt-b151-viztokens` at branch `b151-viztokens`. Nothing was edited.

Every claim below is marked **[V]** verified (I or a scout read the cited line) or
**[A]** assumed (stated inference, with the reason it is safe). Paths are
repo-relative. Where a `<style>` block is a single long line — the house style for
this codebase — the cited line number is that style line.

**Surface read in full:** `visualizer/web/src/lib/theme.css` (134 lines),
`visualizer/web/src/App.svelte`, all 20 components under `visualizer/web/src/lib/`,
`visualizer/web/index.html`, `visualizer/web/vite.config.mjs`,
`visualizer/web/src/main.js`. Plus scout sweeps of `test/`, `docs/`, `.claude/`,
`crew/`, `scripts/` and the git history of `theme.css`.

**This worktree has no `node_modules`.** Nothing was built or run. Every rendering
claim is derived from source; where a claim would need a running browser it is
marked **[A]** and says so.

---

## 0. Correction to the brief's measurement

The brief states theme.css holds **113** custom-property declarations. The measured
count is **105**. **[V]**

```
grep -c -E '\-\-[a-z0-9-]+\s*:' visualizer/web/src/lib/theme.css   -> 105
```

The arithmetic that reproduces it: **30 raw declarations** (theme.css:2–32, one per
line, plus `--mono` at :32) + **25 alias names × 3 theme blocks** (:36–65, :67–95,
:97–127) = 105. Unique property *names*: **55** (30 raw + 25 alias). The 8-unit gap
is likely `font-family` (:33), `color`/`background` (:38–39, :68–69, :99–100) — 8
non-custom declarations sitting inside the same blocks. **[A]** — arithmetic fits
exactly; I did not recover the original counting command.

This matters for a skill: a check written as "theme.css declares 113 properties"
is red at baseline against the file as it stands.

---

## 1. Token vocabulary — grouped by what it is FOR

The file has a strict two-tier shape that no comment states but every line obeys.

### Tier 1 — RAW tokens: literal values, theme-specific, **never read by a component**

Declared once, at `:root`, theme.css:2–32. **[V]** A component that reads one of
these has bypassed theming.

| Group | Tokens | file:line |
|---|---|---|
| ink (dark) surface ramp | `--ink-ground` `#17171a`, `--ink-panel` `#1e1e22`, `--ink-hairline` `#26262b`, `--ink-text` `#eae8ee`, `--ink-muted` `#9b99a3` | theme.css:2–6 |
| paper (light) surface ramp | `--paper-ground` `#efece5`, `--paper-panel` `#e7e3da`, `--paper-hairline` `#e2ded4`, `--paper-text` `#15140f`, `--paper-muted` `#55534a` | theme.css:7–11 |
| accent spot, per theme | `--spot-light` `#8839ef`, `--spot-dark` `#cba6f7` | theme.css:12–13 |
| role palette, dark half | `--role-{planner,builder,reviewer,tech-lead,lead,driver}-dark` | theme.css:14–19 |
| role palette, light half | `--role-{…}-light` | theme.css:20–25 |
| escalation | `--serious` `#ec835a` | theme.css:26 |
| operational status steps | `--status-{ok,fail,running,skipped}-raw` | theme.css:28–31 |
| type | `--mono` (font stack) | theme.css:32 |

The **only prose in the file** is theme.css:27 — `/* These status steps are
operational tokens, not part of the ratified role palette. */` **[V]** It draws the
one line the system itself insists on: the six role colours are ratified vocabulary;
the four status steps are operational and disposable.

Each ramp is a five-step scale with fixed semantics, and the two ramps are
positionally parallel: `ground` (page) → `panel` (raised surface) → `hairline`
(separator) → `text` → `muted`. **[V]** — read off theme.css:2–11 and confirmed by
the alias block's 1:1 mapping at :40–45 / :70–75.

### Tier 2 — ALIAS tokens: the component-facing vocabulary

25 names, redeclared identically in three blocks (theme.css:36–65 paper, :67–95 ink,
:97–127 media-dark). **[V]** These are the **only** names a component may name.

| Purpose | Alias | Resolves to (paper / ink) |
|---|---|---|
| page ground | `--bg` | `--paper-ground` / `--ink-ground` |
| raised surface | `--panel` | `--paper-panel` / `--ink-panel` |
| separator | `--line` | `--paper-hairline` / `--ink-hairline` |
| secondary text | `--muted` | `--paper-muted` / `--ink-muted` |
| interactive accent | `--accent` | `--spot-light` / `--spot-dark` |
| inert fill | `--neutral` | `--paper-muted` / `--ink-muted` |
| status | `--status-{ok,fail,running,skipped}` | the `-raw` value, **identical in both themes** |
| escalation | `--status-escalated` | `--serious`, **identical in both themes** |
| role | `--role-{planner,builder,reviewer,tech-lead,lead,driver}` | the `-light` / `-dark` half |
| lane | `--lane-0…--lane-5` | `--role-<n-th role in ROLE_ORDER>` |
| lane overflow | `--lane-6`, `--lane-7` | `--neutral`, `--muted` |

Two facts fall straight out of the table and both are load-bearing:

- **`--neutral` and `--muted` are the same colour in both themes** (theme.css:43+45,
  :73+75). Therefore **`--lane-6` and `--lane-7` are visually identical**
  (theme.css:63–64, :93–94) — the lane vocabulary advertises 8 slots and delivers 7
  distinguishable colours. **[V]** (computed ratio 1.00 in both themes).
- **Status and escalation colour do not change with theme.** Every `--status-*`
  alias points at the same raw in all three blocks. **[V]** That is a deliberate
  decision (a failure is the same red on both grounds) and §6 measures what it costs.

### Tier 3 — utility classes (global, not tokens)

theme.css:129–134. **[V]**

- `*, *::before, *::after { box-sizing:border-box; border-radius:0; }` (:129) — a
  **global square-corner reset**, restated for form controls at :131.
- `body { margin:0; background:var(--bg); color:inherit; overflow-x:hidden; }` (:130)
- `.wide { overflow-x:auto; }` (:132) — the sanctioned horizontal-scroll container.
- `.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }` (:133)
- `.micro { text-transform:uppercase; letter-spacing:.12em; font-size:.7rem; }` (:134)

`.mono` and `.micro` are the **entire** shared typographic vocabulary.

### Component-local custom properties — a third, legitimate pattern

Two distinct idioms, both in use, both intentional:

1. **Layout locals**, declared on the element that uses them:
   `--identity-column:15rem` and `--lane-gap:.6rem` on `.timeline-body`
   (PhaseGantt.svelte:59), consumed by `.lane`'s `grid-template-columns` and by
   `.bounce-layer`'s `left:calc(var(--identity-column) + var(--lane-gap))`. **[V]**
   Both literals **and** the `calc()` are pinned by test
   (`test/visualizer-panels.test.mjs:845–847`). **[V, via scout]**
2. **Indirection locals**, set from an inline `style` attribute so a runtime value can
   pick a token — see §5.

---

## 2. The theming contract — stated as a rule

### How the switch works

`App.svelte:17–21, 44–51, 130`. **[V]**

- A three-value control (`os` | `paper` | `ink`) is bound to `theme` (App.svelte:130).
- An `$effect` writes `document.documentElement.dataset.theme = theme` for `ink`/`paper`
  and **deletes the attribute** for `os` (App.svelte:48–49).
- The choice is persisted to `localStorage['dt-theme']`, read at boot inside
  `try/catch` (App.svelte:20, 50).
- theme.css then resolves in three cascading blocks:
  `:root, :root[data-theme='paper']` (:36) → `:root[data-theme='ink']` (:67) →
  `@media (prefers-color-scheme: dark) { :root:not([data-theme='paper']) }` (:97–98).

The cascade is well-formed: bare `:root` (specificity 0-1-0) is the floor, so **paper
is the default with no attribute and no media match**; `[data-theme='ink']` (0-2-0)
beats it; the media block (0-2-0, later in source) beats the ink block but sets
identical values, and its `:not([data-theme='paper'])` guard means an explicit paper
choice survives a dark OS. **[V]** — read from source; the specificity arithmetic is
standard CSS.

### The contract a component either obeys or violates

> **T1. A component may name only Tier-2 alias tokens.** Naming `--ink-*`,
> `--paper-*`, `--spot-*`, or a `--role-*-dark` / `--role-*-light` half is a
> violation.
> **Currently: 21/21 components obey.** **[V]** — a `var(--…)` census across all
> `.svelte` files returns only alias names, `--mono`, `--serious`, and the four
> component-locals.

> **T2. A colour a component paints must come from a token.** A component that hard-codes
> a colour renders identically in both themes and therefore violates the contract.
> **Currently: 10/21 components violate it, 34 times.** See §6, L1. This is the
> single most-broken rule in the system.

> **T3. `--serious` is a raw token; the alias is `--status-escalated`.**
> **Currently: violated in one file, which also obeys it three lines later** — see
> §6, L2.

> **T4. Nothing outside theme.css may set `data-theme`, and nothing outside
> `App.svelte:46–51` may write it.** **[V]** — grep for `data-theme` returns
> theme.css:37, 67, 98 and App.svelte:48–49 only, repo-wide.

**Not enforced anywhere.** No test greps a component for a hex colour, and no test
requires `var()` in a colour declaration. **[V, via scout]** — the only three literal
`var()` requirements in the whole suite are
`test/visualizer-panels.test.mjs:627, 629` (two exact FleetTable rules) and `:847`
(PhaseGantt's `calc()`). A component could hard-code `#ff00aa` today and the suite
stays green at 2084/0.

---

## 3. Layout and spacing conventions

### C1 — the panel chassis (the strongest convention in the codebase)

Every content region is a `<section class="panel">` whose rule is

```css
.panel { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem; }
```

**12 components declare `.panel`** — AcceptPanel:36, CellHealthPanel:61,
EnvelopeInspector:48, EventStream:33, IntakePanel:122, PhaseGantt:59, PhasePanel:62,
ReviewPanel:23, RosterEditor:71, RosterPanel:187, RunSetPanel:61, TeardownPanel:54.
**[V]** RunCard:59 uses the same three properties under the name `.card`, and
FleetTable:31 under `table`. **[V]**

Adherence to *the surface pairing itself* (`--panel` background + `1px solid --line`
border) is **100%: 19 `background:var(--panel)` sites, 45 `var(--line)` sites, zero
hard-coded surfaces or separators anywhere.** **[V]** Colour leaks are exclusively in
*state* colour, never in chrome — a sharp and useful boundary.

`padding:1rem` on the chassis is **12/12**. **[V]**

The chassis has three variants; see §7, D1.

### C2 — the recessed surface

An element inset *inside* a panel uses `background:var(--bg)` — the page ground,
one step below the panel. 4 sites: IntakePanel:122 (`.candidate`, `.actor input`),
RosterPanel:187 (`.chip`, `pre`). **[V]** Rule: `--bg` = recessed, `--panel` = raised.

### C3 — separators are always a hairline, never a gap

`border-top:1px solid var(--line)` divides sibling rows inside a panel — 
CellHealthPanel `.cell`, TeardownPanel `.run`, RunSetPanel `.row`,
ReviewPanel `.finding-groups article`, AcceptPanel `.accept-row`,
PhasePanel `.subpanel`/`.event`, EventStream `.event`, EnvelopeInspector `.role`,
RosterPanel `.band`, App `.rail-row`, RunCard `.events`, FleetTable `th,td`.
**[V]** `1px` appears 52 times and is *always* a hairline. **[V]**

### C4 — spacing is rem; px is reserved

Measured across all components: **`rem` for every gap, padding and margin without
exception.** `px` appears only as `1px` (hairline, ×52), `999px` (pill radius, ×3),
`720px`/`640px` (PhaseGantt minimum chart widths, ×2 each), `1200px` (page
max-width, ×2), and `18px`/`5px` inside the bounce SVG's user-unit coordinate space
(PhaseGantt:59). **[V]**

This is a checkable rule: *no px in a spacing property; px only for 1px borders, for
the pill radius, and inside SVG.*

### C5 — the spacing scale is real but unnamed

Gap values, by frequency: `1rem` ×10, `.25rem` ×6, `.4rem` ×5, `.45rem` ×5,
`.35rem` ×5, `.5rem` ×4, `.3rem` ×4, `.75rem` ×3, `.6rem` ×2, `.65rem` ×2,
`.2rem` ×2, `1.2rem` ×1, `.8rem` ×1, `.7rem` ×1. **[V]**

`1rem` is the module (panel padding, panel-to-panel gap, top-level flex gap). Below
it the codebase uses a **.05rem grid from .15rem to .8rem with no preferred steps** —
fourteen distinct values for what is visually one band. There is no spacing token
and no scale. This is a **preference, not a rule** — see §9.

### C6 — page shell

`App.svelte:196` — `.page { max-width:1200px; margin:auto; padding:1.5rem 1rem 3rem; }`
and `RunDetail.svelte:33` — `.detail { max-width:1200px; margin:auto; padding:1rem;
display:grid; gap:1rem; }`. **[V]** Two containers, same width, different padding and
— critically — only one of them is a grid. That difference is the root cause of D2.

### C7 — horizontal overflow is contained, never allowed to reach the body

`body { overflow-x:hidden }` (theme.css:130, restated App.svelte:188) plus the
`.wide { overflow-x:auto }` utility (theme.css:132) wrapping every wide thing:
FleetTable:4 (`<div class="wide">`), PhaseGantt:35 (`.wide chart`), RunCard:56
(`.events wide`), EventStream:30 (`.wide rows`). **[V]** FleetTable:30 redeclares
`.wide` locally; the other three rely on the global. **[V]**

### C8 — scoping discipline

Every component's `<style>` is Svelte-scoped. `:global()` appears **4 times total**:
App.svelte:187–188 (restating the reset — see §6, L7) and
`.evidence :global(p)` in AcceptPanel:36 and PhasePanel:62. **[V]** The rule the code
follows: *`:global` is for descendants produced by the markdown renderer, which the
compiler cannot see; nothing else.* Zero `{@html}` repo-wide. **[V]**

### C9 — the honest-blank idiom (a design convention, not just a data one)

An unmeasured value never renders as `0` or an empty cell. It renders as an em-dash
or a short `"<thing> unavailable — <why>"` sentence, in `var(--muted)`, carrying a
`title` with the reason; when it sits inline it also takes a
`border-bottom:1px dashed currentColor`. **[V]** — `.dashed`/`.mark` declared at
RunCard:73, FleetTable:43–44, AcceptPanel:36, PhasePanel:62, PhaseGantt:59; applied
at FleetTable:15–21 (6 columns), RunCard:53 (3 cells).

This is the visual form of the ratified rule in **ADR-029 §2**
(`docs/adr/adr-029-headless-observability-interjection.md:23`): *"The screen is never
the record. The visualizer may render richer views, but it must link back to
authoritative files and must not turn screen text into an outcome."* **[V, via scout]**
It is the one place where a ratified written decision and a visual convention line up,
and a `ui-design` skill should treat *dashed + muted + title-with-reason* as the
system's designated "not measured" mark.

---

## 4. Typography

There is **no ramp**. There is a font pair and two utility classes.

- **Families:** `font-family: system-ui, sans-serif` on `:root` (theme.css:33) and
  `--mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (theme.css:32).
  **[V]** No web font, no `<link>` in `index.html`. **[V]**
- **Monospace is semantic, not decorative:** it marks machine identifiers and
  aligned numerals, always via `.mono`, which pairs the family with
  `font-variant-numeric: tabular-nums` (theme.css:133). Applied to run labels,
  durations, token counts, cost, heartbeat (FleetTable:13–21 — 16 uses; RunCard:53;
  App.svelte:163). **[V]**
- **`.micro` is the only label style:** uppercase, `.12em` tracking, `.7rem`
  (theme.css:134). Two consumers: `App.svelte:160` (the Attention rail's `h2`) and
  every `th` in `FleetTable.svelte:9`. **[V]** The `th` markup — including the class
  name — is pinned by `test/visualizer-panels.test.mjs:623`. **[V, via scout]**
- **Sizes are ad-hoc.** Nine distinct `font-size` values across all components, none
  tokenised: `.75rem` ×5, `.8rem` ×4, `.9rem` ×3, `1.2rem`, `.95rem`, `.7rem`,
  `.78rem`, `.68rem`, `18px`. **[V]** Body text is unset (browser default 1rem);
  headings are unset (browser `h1`–`h5` defaults) apart from
  `MetricsStrip:21` (`.metrics b { font-size:1.2rem }`) and
  `ReviewPanel:23` (`.finding-groups h3 { font-size:.95rem }`). **[V]**
- **Weights: two.** `600` ×9 (every emphasised state line), `700` ×1
  (App.svelte:190, the brand). **[V]** No other weight is used anywhere. This *is* a
  rule and it is checkable.
- **Heading levels carry structure, not size:** `h1` page title, `h2` panel title
  (always `margin-top:0`, declared in 9 panels), `h3` sub-section, `h4`/`h5`
  markdown-rendered. **[V]** `h1 { margin:.2rem 0 }` in App.svelte:197 and
  RunDetail:33.
- `18px` (PhaseGantt:59, `.bounce-label`) is **not** a violation of the rem rule: it
  is inside an SVG with `viewBox="0 0 1000 …"` and `preserveAspectRatio="none"`, so
  the unit is a user unit, not a CSS pixel. **[V]** — read from PhaseGantt:52. Worth
  saying out loud because a naive "no px" checker flags it.

---

## 5. How status, role and lane colour are chosen — the rules

### R1 — Status colour: a `tone` string chosen by the data layer, mapped to a token by CSS class

`fleet.js:53–61` (`deriveStatus`) returns `{ key, word, tone, where, why }` where
`tone ∈ { serious, ok, fail, quiet, busy }`. **[V]** The component interpolates the
tone into a class — `class={`status ${status.tone}`}` (RunCard:52, FleetTable:14) —
and the stylesheet maps class → token:

```css
.status.ok      { color:var(--status-ok); }
.status.fail    { color:var(--status-fail); }
.status.busy    { color:var(--status-running); }
.status.serious { color:var(--status-escalated); }
```
(RunCard:65–68; FleetTable:37–40 identically.) **[V]**

**The rule: a component never decides colour; it renders a tone the shaper decided,
and a CSS class translates tone → token.** No component reads `run.status` to pick a
colour. **[V]**

The tone vocabulary is pinned as *distinct* by a cluster of shaper tests
(`visualizer-panels.test.mjs:280–282, 307–308, 387, 443–444, 500, 521–531, 715`;
`visualizer-teardown.test.mjs:119–120`) but **no test ever maps a tone to a colour**,
except the two literal FleetTable rules at `:627` and `:629`. **[V, via scout]**

### R2 — Role colour: name concatenation into a token, through an indirection local

`RoleTag.svelte:4` — `style={`--role-color: var(--role-${role})`}` — and
`RoleTag.svelte:9` — `.swatch { background:var(--role-color) }`. **[V]**

**The rule: the role string from the data must be spelled exactly like a token
suffix.** There is no map, no lookup table and no fallback — the role name *is* the
token name.

### R3 — Lane colour: the same idiom, with an index instead of a name

- `PhaseDots.svelte:5` — `style={… `--lane-color: var(--lane-${phase.lane})`}`, then
  `.lane-dot { background:var(--lane-color) }` (:8). **[V]**
- `PhaseGantt.svelte:48` — `style={`… --lane-color:var(--lane-${block.lane ?? 0})`}`,
  then `.block { background:var(--lane-color, var(--lane-0)) }` (:59). **[V]**

`--lane-N` is defined for N ∈ 0…7 only (theme.css:57–64). Lanes 0–5 alias the six
roles **in `ROLE_ORDER`** — `['planner','builder','reviewer','tech-lead','lead',
'driver']` (`visualizer/web/src/lib/trace.js:3`) — and that index↔role mapping is
**the only mechanically enforced token contract in the repo**
(`test/visualizer-shape.test.mjs:286–292`, which asserts `--role-<role>:` exists and
`--lane-<i>: var(--role-<role>)` for each index). **[V, via scout]**

### R4 — role/lane tokens are isolated by an enumerated allowlist, not by a principle

`test/visualizer-panels.test.mjs:660–662` asserts `--role-`/`--lane-\d` do **not**
appear in `App.svelte`, `FleetTable.svelte`, `RunCard.svelte`, `Filters.svelte`;
`:664` asserts they **do** appear in `RoleTag.svelte`.
`test/visualizer-teardown.test.mjs:201` adds `TeardownPanel.svelte` to the forbidden
list, `test/visualizer-server.test.mjs:1396` adds `RosterPanel.svelte`.
**[V, via scout]**

So the intended rule is *"a component that wants role colour delegates to
`<RoleTag>` / `<PhaseDots>` rather than naming the token"* — and RunCard obeys it by
composition (RunCard:53–54 renders both). **[V]** But `PhaseGantt.svelte:48` names
`--lane-` directly and is simply **not on the forbidden list**. The rule as
implemented is a hand-maintained blocklist of six filenames; **it does not
generalise to a component written tomorrow**, which is exactly what a skill needs to
know.

### R5 — the fallback discipline is inconsistent

`PhaseGantt.svelte:59` supplies one (`var(--lane-color, var(--lane-0))`);
`PhaseDots.svelte:8` and `RoleTag.svelte:9` supply none. **[V]** With no fallback an
unresolved custom property makes the declaration *invalid at computed-value time* —
`background` falls back to its initial value, `transparent` — so an unknown role or
an out-of-range lane paints **nothing**, silently. **[A]** on the painted result (no
browser here); **[V]** on the missing fallback and on CSS's specified behaviour.

---

## 6. Departures — where the codebase leaves its own system

Each entry is a place the next component will copy if the skill does not stop it.

### L1 — 34 hard-coded colour literals in 10 of 21 components **[V]**

All are *state* colours. All are theme-blind: they paint the same on ink and paper.

| file:line | literals |
|---|---|
| `lib/GateChips.svelte:13` | `#166534` `#dcfce7` `#991b1b` `#fee2e2` |
| `lib/AcceptPanel.svelte:36` | `#166534` `#dcfce7` `#991b1b` `#fee2e2` |
| `lib/PhasePanel.svelte:62` | `#166534` `#dcfce7` `#991b1b` `#fee2e2` `#92400e` `#fef3c7` |
| `lib/PhaseGantt.svelte:59` | `#fff` `#d8ffd9` `#ffd1d1` `#ffe4a3` |
| `lib/IntakePanel.svelte:122` | `#9b1c1c` ×3, `#7a3e9d` ×3 |
| `lib/CellHealthPanel.svelte:61` | `#7a3e9d` `#9a6700` `#176b3a` |
| `lib/RunSetPanel.svelte:61` | `#176b3a` `#9b1c1c` `#7a3e9d` |
| `lib/RunDetail.svelte:33` | `#b42318` |
| `lib/EnvelopeInspector.svelte:48` | `#b42318`, and the keyword `white` |
| `lib/RosterEditor.svelte:71` | `#b42318` |

The chip pairs (`#166534` on `#dcfce7`, `#991b1b` on `#fee2e2`, `#92400e` on
`#fef3c7`) are self-contained fg/bg pairs — a light-mode chip that keeps its own
internal contrast but sits as a bright block on the ink panel `#1e1e22`. **[A]** on
the visual result; **[V]** that the values are theme-invariant.

> **Grep trap for whoever writes the checker:** `EventStream.svelte:29` contains
> `#123` — an issue reference in body copy (`"predate phase linkage (#123)"`), not a
> colour. **[V]** A naive `#[0-9a-f]{3,6}` sweep false-positives on it, and
> `#83` appears the same way at `MetricsStrip.svelte:19`. **[V]** Restrict the
> pattern to CSS property values, or to 6-digit forms plus a `#fff`-style allowlist.

### L2 — `--serious` read directly where `--status-escalated` is the alias **[V]**

`App.svelte:201` (`.rail { border:1px solid var(--serious) }`) and `:202`
(`.rail h2 { color:var(--serious) }`) reach past the alias — while the **same file**,
six lines later, uses it correctly: `:208` `.chip.serious { color:var(--status-escalated) }`.
Also `RosterPanel.svelte:187` (`.drift`) uses the alias correctly. **[V]**
No visual difference today (`--status-escalated: var(--serious)`), so this is a
naming-discipline break, not a rendering bug — which is precisely why it will not be
caught by looking at the screen.

### L3 — a hairline token used as a surface **[V]**

`RosterEditor.svelte:71` — `pre { … background:var(--line) }`. Every other `pre` in
the codebase uses `var(--bg)` (RosterPanel:187) or no background. `--line` is the
separator step of the ramp; using it as a fill inverts the token's role.

### L4 — untokenised layout magic numbers **[V]**

`max-width:1200px` (App.svelte:196, RunDetail.svelte:33 — the page width, stated
twice); `min-width:720px` ×2 and `minmax(640px,1fr)` / `+ 640px` ×2
(PhaseGantt.svelte:59 — the chart's minimum legible width);
`max-height:30rem` (EventStream:33), `20rem` (RosterPanel:187), `6rem`/`5rem`
(EventStream:33, PhasePanel:62 — the pre-block clamp, duplicated), `2.6rem`/`2.1rem`
(PhaseGantt track and block heights), `30rem` (IntakePanel:122 `.actor` max-width),
`16rem`/`12rem` (RosterPanel:187 grid minmax). None is named; several are repeated
across files.

### L5 — inline `style` attributes: 4 sites, two different justifications **[V]**

Sanctioned (the token-indirection idiom of R2/R3): `RoleTag.svelte:4`,
`PhaseDots.svelte:5`, and the `--lane-color` half of `PhaseGantt.svelte:48`.
Computed geometry with no token possible: `PhaseGantt.svelte:45` and the
`left:…%;width:…%` half of `:48`. A skill should permit the first two categories
explicitly rather than banning inline style outright.

### L6 — a dead declaration **[V]**

`FleetTable.svelte:36` declares `.status-dot { … background:var(--neutral); … }`;
`FleetTable.svelte:42` re-declares `.status-dot { background:currentColor; }`.
Same specificity, later wins — the `--neutral` reference never paints. Two rules for
one selector in one 17-line stylesheet.

### L7 — the global reset restated in a component **[V]**

`App.svelte:187` `:global(*) { box-sizing:border-box; }` duplicates theme.css:129;
`App.svelte:188` `:global(body) { margin:0; overflow-x:hidden; }` duplicates
theme.css:130. `App.svelte:192` also restates `border-radius:0` for buttons and
selects, duplicating theme.css:131. Three restatements of the same three rules.

### L8 — global utility classes shadowed by local copies **[V]**

`.mono` is defined globally at theme.css:133 and **re-defined identically** at
`App.svelte:211` and `RunCard.svelte:72`. `FleetTable.svelte` uses `.mono` (16 times)
and `.micro` (9 times) with **no** local declaration and renders correctly from the
global. So the local copies are provably unnecessary — FleetTable is the proof.

### L9 — `--lane-6` and `--lane-7` are the same colour **[V]**

theme.css:63–64 and :93–94, given :43+45 / :73+75. Any run with 7 or 8 concurrent
lanes shows two lanes it cannot tell apart, and lane ≥ 8 resolves to nothing at all
(no `--lane-8`, and only PhaseGantt supplies a fallback — see R5).

### L10 — the role palette does not cover the live role vocabulary **[V]**

theme.css declares six roles. The crew's actual role strings, counted in `crew/*.mjs`:
`builder` 480, `reviewer` 217, `planner` 182, `lead` 156, `tech-lead` 52,
**`scout` 32**, **`advisor` 3**, `driver` 2. **[V]** `scout` and `advisor` have **no**
`--role-*` token. Additionally `PhaseGantt.svelte:40` passes the literal string
`'unlinked'` into `<RoleTag role=…>` when no identity resolves, producing
`var(--role-unlinked)` — undefined. **[V]** With no fallback at `RoleTag.svelte:9`,
each of these renders an invisible swatch. **[A]** on the render, **[V]** on the
token's absence.

### L11 — nothing declares `color-scheme`, and the theme is applied after first paint **[V]**

`visualizer/web/index.html:2` carries no `color-scheme` meta, no inline style and no
`data-theme`; theme.css never sets the `color-scheme` property. **[V]** Consequences,
both **[A]** (they need a browser to observe, and the reasoning is standard UA
behaviour): UA-painted surfaces — scrollbars, the caret, `<select>` and
`<input type="date">` internals — keep their light rendering under the ink theme;
and because `data-theme` is written by a post-mount `$effect` (App.svelte:46–51),
the first paint uses the bare-`:root` default (paper) before switching, so an ink
user sees a light flash on every load.

### L12 — theme-invariant status colours fail contrast on paper **[V, computed]**

Contrast ratios (WCAG 2.x relative luminance) of each status token against each
ground it can appear on:

| token | on `--ink-ground` | on `--ink-panel` | on `--paper-ground` | on `--paper-panel` |
|---|---|---|---|---|
| `--status-ok` `#2f9e62` | 5.27 | 4.90 | **2.88** | **2.65** |
| `--status-fail` `#c94f58` | **4.04** | **3.75** | **3.75** | **3.46** |
| `--status-running` `#c38b18` | 5.99 | 5.56 | **2.53** | **2.33** |
| `--status-skipped` `#77747d` | **3.90** | **3.62** | **3.89** | **3.58** |
| `--status-escalated` / `--serious` `#ec835a` | 6.78 | 6.30 | **2.24** | **2.06** |

Bold = below 4.5:1. By contrast the **theme-paired** tokens all clear it on their own
ground: `--ink-text` 14.72/13.67, `--ink-muted` 6.37/5.92, `--spot-dark` 8.81/8.18,
`--paper-text` 15.63/14.40, `--paper-muted` 6.54/6.02, `--spot-light` 4.59/4.23.
**[V]** — computed from the literals in theme.css:2–31.

That is the measurable price of the decision at theme.css:27–31 to keep status
theme-invariant: the four status steps and `--serious` were evidently tuned against
the ink ground, and paper inherits them. Every ratio above is a fact about the
declared values, independent of any browser.

Related: `PhaseGantt.svelte:59` paints `.block { color:#fff }` on a lane colour.
Against the **paper** role palette that gives 2.17 (`tech-lead`), 2.69 (`lead`),
2.82 (`reviewer`), 3.20 (`builder`), 4.42 (`planner`), 8.56 (`driver`); against the
ink palette, 3.07–3.94 across all six. **[V, computed]** Only one of twelve
combinations clears 4.5:1.

---

## 7. Divergences — both behaviours reported, with the majority named

### D1 — the panel chassis has three forms **[V]**

| form | count | files |
|---|---|---|
| `background/border/border-radius:.6rem/padding:1rem` | **7 (majority)** | AcceptPanel:36, CellHealthPanel:61, EnvelopeInspector:48, EventStream:33, PhaseGantt:59, PhasePanel:62, ReviewPanel:23 |
| …the same **plus `margin:1rem 0`** | 4 | IntakePanel:122, RosterEditor:71, RunSetPanel:61, TeardownPanel:54 |
| …the same **minus `border-radius`** | 1 | RosterPanel:187 |

### D2 — who owns the gap between panels **[V]**

Two behaviours, and the split is *not* arbitrary — it tracks the container:

- Panels rendered inside `RunDetail` get their spacing from the parent:
  `.detail { display:grid; gap:1rem }` (RunDetail.svelte:33). Those panels carry no
  margin. **Majority (7).**
- Panels rendered directly under `App`'s `.page` must space themselves, because
  `.page` (App.svelte:196) is **not** a grid and sets no gap. Four of them do
  (`margin:1rem 0`). **(4)**
- **Two panels are under `.page` and carry neither** — `CellHealthPanel`
  (mounted App.svelte:143, 180) and `RosterPanel` (mounted App.svelte:151). **[V]**
  They abut their neighbours. **[A]** on the visual result.

The correct statement of the convention is therefore *"spacing between panels is the
container's job; a panel that may be mounted in a non-grid container carries
`margin:1rem 0`"* — and two components fall through the gap between the two halves.

### D3 — pill radius: a genuine three-way tie, **no majority** **[V]**

- `border-radius:1rem` — GateChips:13, AcceptPanel:36, PhasePanel:62 **(3)**
- `border-radius:999px` — CellHealthPanel:61, RunSetPanel:61, TeardownPanel:54 **(3)**
- no radius (square) — RosterPanel:187 `.chip` **(1)**

`1rem` and `999px` are visually near-identical at these sizes; the divergence is in
the idiom, not the pixels. **[A]** Report both; do not pick one.

### D4 — the `.error` colour: the majority is the violation **[V]**

- hard-coded `#b42318` — RunDetail:33, EnvelopeInspector:48, RosterEditor:71 **(3, majority)**
- `var(--status-fail)` — App.svelte:200, RosterPanel:187 **(2)**

The token-correct form is the minority. Worth saying plainly: "follow the majority"
is the wrong instruction here, which is why a skill must encode the *rule*, not the
prevailing habit.

### D5 — one tone name, four different colour policies **[V]**

`unproven` renders as:
- `#92400e` on `#fef3c7` (amber chip) — PhasePanel:62
- `var(--muted)` on `color-mix(in srgb, var(--muted) 16%, transparent)` — GateChips:13
- `#ffe4a3` (pale amber text, no background) — PhaseGantt:59
- `var(--status-running)` — TeardownPanel:54

No majority (1/1/1/1). The same is true of `proven` (`#166534`+`#dcfce7` in
GateChips:13, AcceptPanel `held`:36 and PhasePanel:62 → **3, majority**; `#d8ffd9` in
PhaseGantt:59; `var(--status-ok)` in TeardownPanel:54) and of `failed`
(`#991b1b`+`#fee2e2` ×3 majority; `#ffd1d1`; `var(--status-fail)`). **[V]**

`GateChips.svelte:13` is the interesting case: it uses tokens for `unproven` and hex
for `proven`/`failed`, in one rule block — so the leak is not a component-level
decision but a per-tone one.

### D6 — the `quiet` tone has a rule in one component of three **[V]**

`deriveStatus` emits `tone:'quiet'` for `queued` and `unknown`
(`fleet.js:58, 60`). Only `App.svelte:209` defines `.chip.quiet { color:var(--muted) }`.
`RunCard.svelte:65–68` and `FleetTable.svelte:37–40` define `ok`/`fail`/`busy`/`serious`
and **not** `quiet` — so a queued run's status word renders at inherited body colour
in both. **Majority: no rule (2 of 3).** **[V]** A skill's checkable form of this:
*every tone a shaper can emit must have a rule in every component that renders it.*

### D7 — button treatment **[V]**

- Outline: `border:1px solid var(--line); background:var(--panel); color:inherit`
  — App.svelte:192, RunCard:71, IntakePanel:122 **(3, majority)**
- Filled: `background:var(--accent); border:1px solid var(--line); color:var(--panel)`
  — RosterPanel:187 **(1)**

RosterPanel's filled form uses `--panel` — a *surface* token — as a foreground colour.
It happens to read (panel is near-ground in both themes, accent is saturated), but it
inverts the token's declared role, and `--panel` on `--accent` is not a pairing the
ramp was designed for. **[A]** on legibility, **[V]** on the role inversion.

### D8 — `.mono` local vs global **[V]**

Local re-declaration: App.svelte:211, RunCard:72 **(2, majority)**. Global only:
FleetTable **(1)**. `.micro` is never re-declared — both consumers use the global
**(2/2)**. See L8.

### D9 — status-dot geometry **[V]**

`.55rem` square filled with `currentColor` — RunCard:64, FleetTable:36/42 **(2)**.
`.75rem` circle (`border-radius:50%`) — PhaseDots:8 **(1)**. Different components,
different meanings (run status vs per-phase), so this may be intentional; reported
because nothing states it is.

### D10 — the global square-corner reset vs actual practice **[V] — the largest divergence**

theme.css:129 sets `border-radius:0` on `*, *::before, *::after`; theme.css:131
repeats it for form controls; App.svelte:192 repeats it again. Against that,
**20 `border-radius` declarations in 11 components** re-introduce corners: `.6rem` ×11
(the panel chassis), `1rem` ×3, `999px` ×3, `.25rem` and `.2rem` (PhaseGantt blocks
and gate markers), `50%` (PhaseDots). **[V]**

Both behaviours are the system: the reset is what the stylesheet *declares*, rounded
panels are what the app *is*. There is no majority to name — the reset is one rule
that loses to twenty. A skill must decide which is the boundary and say so, because
today an agent reading theme.css alone would conclude "square corners" and be wrong
about every panel it writes.

### D11 — chip chrome **[V]**

`border:1px solid currentColor` — App.svelte:207, TeardownPanel:54 **(2)**;
`border:1px solid var(--line)` — CellHealthPanel:61, RunSetPanel:61, RosterPanel:187 **(3, majority)**;
no border, background fill instead — GateChips:13, AcceptPanel:36, PhasePanel:62 **(3, tie)**.
Two of the three forms tie at 3. The tie is not incidental: the bordered forms are
token-coloured and the fill form is the hard-coded one, so D11 and L1 are the same
split seen from two angles.

---

## 8. What is already mechanically enforced (the floor a skill inherits)

The suite is 2084 tests. Its coverage of *design* is thin and specific.
**[V, via scout]**

1. **`test/visualizer-shape.test.mjs:286–292`** — the only test that reads
   `theme.css` at all. For each role in `ROLE_ORDER` it asserts `--role-<role>:` is
   declared and `--lane-<i>: var(--role-<role>)`. 12 presence regexes; **no value is
   ever inspected**, no count, no ordering beyond the index mapping.
2. **`test/visualizer-panels.test.mjs:627, 629`** — two exact CSS rules in
   `FleetTable.svelte`, whitespace and semicolon included
   (`.stale { color:var(--status-escalated); }`). The strongest colour pin in the
   suite, and it covers one file.
3. **`test/visualizer-panels.test.mjs:845–847`** — PhaseGantt's `--identity-column:15rem`,
   `--lane-gap:.6rem` and the `calc()` that consumes them, as literal substrings.
4. **`:660–665`, `visualizer-teardown:201`, `visualizer-server:1396`** — the
   role/lane allowlist of R4.
5. **`test/visualizer-shape.test.mjs:750–751`** — the only *blanket* rule over every
   `.svelte` file under `visualizer/`: no `export let`, no `$:`. Runes only.
6. **`test/visualizer-panels.test.mjs:752–754`** — no `{@html}` in six named files.
7. **`:623`** — FleetTable's exact `th` markup, column order **and** the `micro` class.

**Explicitly absent, repo-wide:** any hex-colour ban; any general "colour must be a
token" rule; any count or value assertion over theme.css; any `data-theme` or
`prefers-color-scheme` assertion; any typography assertion; any spacing-scale
assertion; any assertion that the `--status-*` tokens are defined at all — even
though `test/visualizer-panels.test.mjs:627` *requires a consumer to reference*
`--status-escalated`. **[V, via scout]** Deleting `--status-escalated` from theme.css
leaves the suite green.

---

## 9. Conventions that resist mechanical enforcement

The brief asks which conventions can only be stated as preferences. These:

- **The spacing scale (C5).** Fourteen distinct sub-1rem values on a .05rem grid.
  A checker can enforce "rem, not px" (C4 — checkable) and "panel padding is 1rem"
  (checkable), but not "pick the right small gap", because no scale exists to check
  against. Enforceable only after someone *decides* the scale.
- **The type ramp (§4).** Nine ad-hoc sizes and no tokens. `font-weight ∈ {600,700}`
  **is** checkable; `.micro` for column labels **is** checkable; size is not.
- **Corner radius (D10).** Checkable only after the reset-vs-practice contradiction
  is resolved by a decision. Until then any checker contradicts either theme.css:129
  or eleven components.
- **Pill radius idiom (D3).** A 3–3 tie with no principle behind it; enforceable only
  by fiat.
- **Which container owns panel spacing (D2).** The rule depends on where a component
  is *mounted*, which a per-file grep cannot see. Enforceable only as the weaker
  "a panel that sets no margin must be mounted in a grid container" — needing a
  cross-file check of App.svelte's mount sites.
- **Tone→colour completeness (D6).** Checkable *in principle* (enumerate the tones a
  shaper emits, require a rule per consumer) but it needs the shaper's tone
  vocabulary as an input; there is no manifest of tones today — they are string
  literals scattered through `fleet.js`, `panels.js` and `trace.js`.

By contrast these **are** mechanically checkable today, cheaply, by grep:
T1 (no raw tokens named), T2 (no hex in a colour property, with the `#123` copy trap
handled), T3 (`--serious` only in theme.css), C1 (`.panel` chassis text), C4 (no px
in spacing), the two-weight rule, no `{@html}`, runes-only, and `:global` only inside
`.evidence`.

---

## 10. What I could not establish

1. **Where the "ratified role palette" was ratified.** theme.css:27 asserts a
   ratification exists; **no file in the repo records it.** `git log --all --grep`
   for `palette|theme|typography|design system` returns nothing, and no deleted file
   in history matches a UI/theme design-doc name. **[V, via scout]** The only durable
   trace is `test/visualizer-shape.test.mjs:286–292`. **[A]** the decision was made
   in issue #287 (the Refs trailer on `3e7367a`, the commit that finished the shell)
   or in conversation — I could not confirm which, and did not query GitHub.
2. **Why role colours were chosen as they were** — no rationale in any commit body.
   `theme.css` has exactly three commits (`da8a217`, `78a5d7a`, `3e7367a`); the only
   design-adjacent phrase in any of them is `3e7367a`'s subject, *"un-inverted spot
   accent"*. **[V, via scout]**
3. **Anything requiring a rendered page.** No `node_modules` here, so every claim in
   L10, L11, D2 and the contrast *consequences* is a source-derived inference. The
   ratios in L12 are arithmetic on declared literals and need no browser; what those
   ratios *look like* does.
4. **Whether the visualizer's data ever carries `scout`/`advisor` as a `role`.**
   I verified those strings are live in `crew/*.mjs` (32 and 3 uses) and that no
   `--role-scout`/`--role-advisor` token exists. I did **not** trace whether the
   ledger's `agent_sessions.role` column can hold them — that needs
   `visualizer/server`, which is out of scope for this recon.
5. **Whether `--status-skipped` is used at all.** One consumer: `PhaseDots.svelte:8`.
   **[V]** Whether a phase ever carries `status: 'skipped'` with `lane == null` — the
   only condition under which that class is applied (PhaseDots.svelte:5) — I did not
   establish.

---

## 11. One-paragraph answer, for a skill author in a hurry

The visualizer has a real, disciplined design system in exactly one dimension —
**surface and chrome**. Panel background, hairline, muted text and accent come from
five theme-paired alias tokens, and adherence there is 100% across 21 components with
zero exceptions. It has a second, half-built system for **identity colour**: six
ratified role colours reached by spelling a role name into a token
(`var(--role-${role})`), aliased into eight lane slots of which two are the same
colour, isolated from most components by a hand-maintained allowlist of six
filenames. And it has **no system at all for state colour**: 34 hard-coded hex
literals across 10 components render the same on both themes, four different colour
policies serve the single tone name `unproven`, and the token-correct form of
`.error` is in the minority 2–3. Typography is a font pair and two utility classes;
spacing is rem-with-a-1rem-module and fourteen improvised smaller values; the
stylesheet's global `border-radius:0` is contradicted by twenty declarations in
eleven components. The boundary a `ui-design` skill should draw is not a new palette
— it is the rule the chrome already obeys, extended to the state colours that never
did: **every colour a component paints resolves to a Tier-2 alias token; a component
never names a raw token, and never names a colour.**
