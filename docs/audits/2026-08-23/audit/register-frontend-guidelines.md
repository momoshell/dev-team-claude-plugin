# Audit register — frontend-svelte, ui-design, crew guidelines, scout.json

Checkout: `/Users/x/Development/dt-s3-prose` · branch `audit-s3-prose` · HEAD `5a8d76a` · 2026-08-23
Read-only run. No file inside the checkout was created, edited or deleted.

## Files read in full

| File | Lines |
|---|---:|
| `skills/frontend-svelte/SKILL.md` | 38 |
| `skills/frontend-svelte/references/components.md` | 39 |
| `skills/frontend-svelte/references/routing.md` | 25 |
| `skills/frontend-svelte/references/structure.md` | 33 |
| `skills/frontend-svelte/references/testing.md` | 23 |
| `skills/ui-design/SKILL.md` | 53 |
| `skills/ui-design/references/contract.md` | 37 |
| `skills/ui-design/references/limits.md` | 52 |
| `skills/ui-design/references/state-colour.md` | 62 |
| `skills/ui-design/references/tokens.md` | 91 |
| `crew/guidelines/review-do-not-flag.md` | 47 |
| `crew/guidelines/seat-pre-return-checklist.md` | 79 |
| `crew/pi/agents/scout.json` | 6 |
| **Total** | **585** |

Supporting reads (not part of the family, read to establish evidence): `visualizer/web/src/App.svelte`, all 20 `visualizer/web/src/lib/*.svelte`, `visualizer/web/src/lib/theme.css`, `visualizer/web/src/main.js`, `visualizer/web/index.html`, the eight `visualizer/web/src/lib/*.js` modules, `package.json`, `package-lock.json`, `test/visualizer-{shape,panels,server,teardown}.test.mjs`, `test/factory-make-brief.test.mjs`, `crew/drive.mjs`, `crew/drive.test.mjs`, `crew/crew.mjs`, `crew/daemon.mjs`, `crew/capabilities.json`, `crew/capabilities.test.mjs`, `crew/adapters/adapter-pi.mjs`, `crew/pi/extensions/subagent.ts`, `crew/roles/{builder,planner,reviewer}.md`, `.agents/skills/review-procedure/**`, `skills/pr-review/**`, `scripts/factory/make-brief.mjs`, `docs/adr/adr-029-headless-observability-interjection.md`.

---

## Per-document register

### `skills/frontend-svelte/SKILL.md`

Checkable claims: **11** — true **7**, stale **3**, false **1**.

**FALSE**

1. `skills/frontend-svelte/SKILL.md:29` — *"run `svelte-autofixer` over changed Svelte code before returning it"*
   `svelte-autofixer` is only reachable as `mcp__plugin_svelte_svelte__svelte-autofixer`, served by the user-global plugin MCP server `plugin:svelte:svelte`. The repo declares **no** MCP config (`find . -name '.mcp.json'` → nothing; no `mcpServers` key anywhere outside the fixture `tasks/headless-worker/captures/g-accept-edits.jsonl:3`). A crew seat is booted with `--no-extensions` and `--no-skills` (`crew/adapters/adapter-pi.mjs:251,253`) and `crew/capabilities.json` grants `"skills": []` and `"extensions": []` to every role. An agent obeying this instruction inside a seat cannot run the tool at all; it can only be run by an orchestrator session that happens to have the plugin installed. The instruction is unconditional and names no such precondition.

**STALE**

2. `skills/frontend-svelte/SKILL.md:20` — *"Follow the app shell and seven-module split"*
   There are **eight** plain modules under `visualizer/web/src/lib/`: `api.js` (26), `route.js` (40), `drain.js` (49), `fleet.js` (174), `panels.js` (785), `timeline.js` (84), `trace.js` (459) **and `envelope-diff.js` (45)**. `envelope-diff.js` exists at HEAD and is absent from the split. Evidence: `ls visualizer/web/src/lib/*.js`, `wc -l`. (Same defect at `references/structure.md:17` and `:19-27`.)

3. `skills/frontend-svelte/SKILL.md:31` — *"The preserved measurements live at `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md`"*
   The path exists (`-rw-r--r-- 42500 Aug 22 19:29`) but is **outside the checkout and outside any seat's workspace**. Nothing in the repo copies, tests or ships it; a seat cannot open it from a linked worktree, and it is the sole cited source for ~40 measured numbers in this skill family. Stale as an *operational* citation, true as a filesystem fact.

4. `skills/frontend-svelte/SKILL.md:12` and `:25,:27` — the two sentences at `:12` are repeated **verbatim** at `:25` and `:27` inside the same 38-line file. Not a factual error; a real R4 defect (see Format compliance).

**TRUE**

- `:2` `name: frontend-svelte` matches the directory `skills/frontend-svelte/` — `ls skills/`.
- `:18-21` all four routed reference files exist — `ls skills/frontend-svelte/references/` → `components.md routing.md structure.md testing.md`.
- `:29` *"Keep component props in one destructuring line"* — `visualizer/web/src/lib/RunCard.svelte:8`, `FleetTable.svelte:2`, `PhasePanel.svelte:3`, `PhaseGantt.svelte:5`, `Filters.svelte:2`, `RoleTag.svelte:2`, `PhaseDots.svelte:2` all one line.
- `:29` *"keep deterministic logic in `visualizer/web/src/lib/*.js`"* — 8 such modules exist, all pure/`export function`.
- `:12` *"retrieval-first repo skill"* — posture declared; `grep -rln 'retrieval-first'` over `skills/` matches only this file.
- `:35-38` the four Key-references paths resolve.
- `:3-9` frontmatter `description` is a `>-` block and parses.

---

### `skills/frontend-svelte/references/components.md`

Checkable claims: **31** — true **23**, stale **6**, false **2**.

**FALSE**

1. `components.md:13` — *"`visualizer/web/src/App.svelte:124` passes `onback` to `RunDetail`"*
   `App.svelte:124` is `  <nav aria-label="Views">`. The only `onback` in the file is at **`App.svelte:135`**: `<RunDetail run={selectedRun} phase={route.phase} onback={backToFleet} />` (`grep -n 'onback' visualizer/web/src/App.svelte`). An agent following the anchor reads markup that has nothing to do with the claim.

2. `components.md:25` — *"Exhibits include `visualizer/web/src/App.svelte:130`"* (for native `onclick=`)
   `App.svelte:130` is `<label class="theme">Theme <select bind:value={theme}>…` — a `bind:value`, not an `onclick`. The `onclick` exhibits in App.svelte are at **`:125,:126,:127`** (nav buttons) and `:137,:162`. Anchor points at the wrong idiom entirely.

**STALE**

3. `components.md:29` — *"`$state(` 53 times in 12 files"*
   Measured **63** in 12 files: `grep -o '\$state(' App.svelte lib/*.svelte | wc -l` → 63; `grep -l` → 12. File count true, occurrence count 10 low.

4. `components.md:29` — *"`{@render` 27 times in 5 components"*
   Measured **35** in 5 files. File count true, occurrence count 8 low.

5. `components.md:25` — *"the census found 16 [`onclick=`] across 10 components"*
   Measured **18** across 10 files. File count true, occurrence count 2 low.

6. `components.md:29` — *"`$bindable(` once in `Filters.svelte:2`"*
   Measured **2** occurrences, both on `Filters.svelte:2` (`filters` and `viewFilters`). The line is right; "once" is wrong, and `:17` on the same page correctly says *"`filters` and `viewFilters` are bindable props"* — the two statements disagree with each other about the count.

7. `components.md:3` — cites the preserved register `§4 and the rune census` as source evidence; that file is outside the checkout (see SKILL.md:31 above).

8. `components.md:21` — *"`visualizer/web/src/lib/PhasePanel.svelte:19–32` defines `runs` and `markdown` snippets"*
   `:19` is `</script>`; the snippets start at `:20` (`{#snippet runs(items)}`) and `markdown` runs `:25-` past `:32` (the block does not close until later). Range is off by one at the head and truncated at the tail.

**TRUE**

- `:9` `let { run, taskEnvelope = null, onopen = () => {} } = $props()` — `RunCard.svelte:8` **exact match**.
- `:10` `let { rows = [], onopen = () => {} } = $props()` — `FleetTable.svelte:2` **exact match**.
- `:11` `let { run, phase = null, returns = {}, events = [] } = $props()` — `PhasePanel.svelte:3` **exact match**.
- `:13` `PhaseGantt.svelte:5` uses `onselectphase` — `let { run, events = [], onselectphase = () => {} } = $props()`.
- `:17` `Filters.svelte:2` is the one measured `$bindable(` **file**; `hiddenLine = ''` is an ordinary defaulted prop — `Filters.svelte:2`.
- `:21` `{#snippet` 9 times in 5 components — measured 9 / 5.
- `:21` `AcceptPanel.svelte:10–23` — `{/snippet}` at 10, `{#snippet markdown}` 11-19, panel markup 20-23. Range holds.
- `:25` zero `on:click` — `grep -o 'on:click'` → 0.
- `:25` `RunCard.svelte:52–56` onclick exhibits — `:55` carries three `onclick=`.
- `:25` `PhasePanel.svelte:53` onclick exhibit — `onclick={() => expandedWhy[event.id] = …}`.
- `:25` existing form bindings are `bind:value` and `bind:checked` — `grep -o 'bind:[a-z]*'` yields only those two.
- `:29` `$derived` 40 times in 16 files — measured 40 / 16.
- `:29` `$props()` 14 times in 14 files — measured 14 / 14.
- `:29` `$effect` 15 times in 10 files — measured 15 / 10.
- `:29` no legacy `export let` or `$:` — measured 0 / 0.
- `:29` `test/visualizer-shape.test.mjs:750–751` checks those strings across every `.svelte` file — `assert.doesNotMatch(source, /^\s*export\s+let\s/m)` / `/^\s*\$:\s/m` inside `if (file.endsWith('.svelte'))` at `:749`.
- `:31` `RunCard.svelte:18–20` carries the `state_referenced_locally` comment; `previousRunning` left undefined at `:21` — exact.
- `:35` `.evidence :global(p)` at `AcceptPanel.svelte:36` — present in that style line.
- `:35` `.evidence :global(p)` at `PhasePanel.svelte:62` — present.
- `:35` `:global(*)` and `:global(body)` at `App.svelte:187–188` — exact.
- `:35` zero `{@html}` — `grep -o '{@html'` → 0.
- `:39` `RunCard.svelte:53–54` composes `PhaseDots`, `GateChips` (`:53`) and `RoleTag` (`:54`).
- `:39` `RoleTag.svelte:4` and `PhaseDots.svelte:5` own role/lane colour indirection — `--role-color: var(--role-${role})` / `--lane-color: var(--lane-${phase.lane})`.

---

### `skills/frontend-svelte/references/routing.md`

Checkable claims: **9** — true **8**, stale **0**, false **1**.

**FALSE**

1. `routing.md:9,:19` — *"use `svelte-autofixer` after writing"* / *"Run `svelte-autofixer` over the code, then address its result before returning it."*
   Same defect as `SKILL.md:29`: unconditional instruction naming no MCP precondition, unrunnable in a seat (`crew/adapters/adapter-pi.mjs:251,253`; `crew/capabilities.json` grants no extensions/skills to any role; repo has no MCP config).

**TRUE** (all tool and agent names verified against the live plugin registration)

- `:3,:21` the MCP server is named `svelte:svelte` — live server name `plugin:svelte:svelte`, connected.
- `:9,:16` `list-sections` — real tool `mcp__plugin_svelte_svelte__list-sections`.
- `:9,:17` `get-documentation` — real tool `mcp__plugin_svelte_svelte__get-documentation`.
- `:9,:19` `svelte-autofixer` — real tool `mcp__plugin_svelte_svelte__svelte-autofixer` (name correct; availability is the false part above).
- `:21` `playground-link` — real tool `mcp__plugin_svelte_svelte__playground-link`.
- `:21` `svelte:svelte-code-writer` skill exists — registered skill of that exact name.
- `:21` `svelte:svelte-file-editor` agent exists — registered agent of that exact name.
- `:10-12,:25` the three routed reference files exist.

---

### `skills/frontend-svelte/references/structure.md`

Checkable claims: **19** — true **17**, stale **1**, false **1**.

**FALSE**

1. `structure.md:17` and the table at `:19-27` — *"Keep data acquisition, route parsing, drains, shaping, layout, and trace interpretation in the seven existing plain modules"*
   There are **eight**. `visualizer/web/src/lib/envelope-diff.js` (45 lines, exports the envelope-diff shaper) exists at HEAD and appears in no row. An agent told "the seven existing plain modules" and handed a diff-shaping task will either invent an eighth module that already exists, or push diff logic into one of the seven. Evidence: `ls visualizer/web/src/lib/*.js`.

**STALE**

2. `structure.md:7` — *"`App.svelte` owns … and top-level view composition (`visualizer/web/src/App.svelte:1–130`)"*
   The `<script>` block ends at `App.svelte:120`; `:121-132` is `<svelte:head>` + the `<header>` chrome; view composition runs `:133-185`. The cited range covers the script plus the topbar and stops **before** the view composition it claims to exhibit. Same defect at `:29`.

**TRUE**

- `:7` `main.js` imports the token sheet and mounts `App` into `#app` — `main.js:1-5`: `import { mount } from 'svelte'` / `import App from './App.svelte'` / `import './lib/theme.css'` / `mount(App, { target: document.getElementById('app') })`.
- `:7` App owns hash route state — `App.svelte:17` `let route = $state(parseHash(location.hash))`, `:44` `$effect(() => subscribeHash(...))`.
- `:7` App owns the `os`/`paper`/`ink` theme choice — `App.svelte:19-21,46-51,130`.
- `:9` **"main.js is the only importer of theme.css"** — `grep -rn 'theme.css' visualizer/` → exactly one non-CSS hit, `visualizer/web/src/main.js:3`.
- `:11` the stylesheet is loaded before the mount call in `main.js:1–5` — import at `:3`, `mount` at `:5`.
- `:11` `App.svelte:44–51` applies the selected `data-theme` after the component starts — `$effect` at `:46-51` writes/deletes `document.documentElement.dataset.theme`.
- `:13` **"There are 20 `.svelte` components under `visualizer/web/src/lib/`"** — `ls visualizer/web/src/lib/*.svelte | wc -l` → 20.
- `:13` `App.svelte:143,151,180` mounts panels directly under `.page` — `:143 <CellHealthPanel />`, `:151 <RosterPanel />`, `:180 <CellHealthPanel />`, each inside `<main class="page">` opened at `:140/:149/:155`.
- `:13` `RunDetail.svelte:33` owns a grid gap for its children — `.detail { … display:grid; gap:1rem; }`.
- `:21` `api.js:1–26` — file is exactly 26 lines, one `request` wrapper plus endpoint thunks.
- `:22` `route.js:1–40` — exactly 40 lines.
- `:23` `drain.js:1–49` — exactly 49 lines.
- `:24` `fleet.js:1–174` — exactly 174 lines.
- `:25` `panels.js:1–785` — exactly 785 lines.
- `:26` `timeline.js:1–84` — exactly 84 lines.
- `:27` `trace.js:1–459` — exactly 459 lines; owns `ROLE_ORDER` at `trace.js:3`.
- `:29` `FleetTable.svelte:1–2` demonstrates the component boundary — `<script>` + the one props line.
- `:33` deferral to `references/testing.md` — that file exists.

---

### `skills/frontend-svelte/references/testing.md`

Checkable claims: **12** — true **12**, stale **0**, false **0**. *(Cleanest document in the family.)*

- `:3` **"no vitest, no jsdom, no testing-library"** — `grep -rn 'vitest\|jsdom\|testing-library' package.json package-lock.json` → zero hits.
- `:5` logic lives in plain `.js` modules under `visualizer/web/src/lib/` — 8 such modules.
- `:5` tested with `node --test` — `package.json:8` `"test": "node --test --test-timeout=30000"`.
- `:11` the package declares `svelte`, `vite`, `@sveltejs/vite-plugin-svelte` as devDependencies — `package.json:23-27` (`svelte ^5.0.0`, `vite ^6.0.0`, `@sveltejs/vite-plugin-svelte ^5.0.0`). Installed svelte is **5.56.9** (`package-lock.json`), so the Svelte-5/runes premise of the whole family is correct.
- `:11` runs `node --test --test-timeout=30000` from `package.json` — `package.json:8`, exact string.
- `:11` **"17 `readFileSync` sites read `.svelte` files under `test/visualizer-*.test.mjs`"** — `grep -n readFileSync test/visualizer-*.test.mjs | grep -c svelte` → **17** (14 in `-panels`, 1 in `-server`, 2 in `-teardown`).
- `:15` `test/visualizer-panels.test.mjs:623` pins FleetTable's header — `assert.match(table, /duration<\/th><th class="micro">tokens<\/th>…/)`.
- `:15` `:627` pins the stale rule — `assert.match(table, /\.stale \{ color:var\(--status-escalated\); \}/)`.
- `:15` `:629` pins the escalation rule — `assert.match(table, /\.status\.serious\s*\{\s*color:var\(--status-escalated\)/)`.
- `:15` `:845–847` pins PhaseGantt's layout locals — `--identity-column:15rem`, `--lane-gap:.6rem`, the `calc()`.
- `:15` `test/visualizer-shape.test.mjs:750–751` covers the runes-only source rule — exact.
- `:17` the `qa-test-writing` skill exists and owns the vacuity method — `skills/qa-test-writing/SKILL.md:19-22` declares posture **measurement-first** and `references/vacuity.md` exists.

---

### `skills/ui-design/SKILL.md`

Checkable claims: **21** — true **16**, stale **3**, false **2**.

**FALSE**

1. `skills/ui-design/SKILL.md:29` — *"T1 (name only Tier-2 aliases) is obeyed 21/21"*
   T1's own definition (`references/contract.md:7`) says a component *"must not name a raw `--ink-*`, `--paper-*`, `--spot-*`, role `-dark`/`-light` half, **`--serious`**, or `-raw` status token."* `visualizer/web/src/App.svelte:201` (`border:1px solid var(--serious)`) and `:202` (`color:var(--serious)`) name `--serious`. Measured T1 conformance is therefore **20/21**, not 21/21 — and this same file records the violation two lines later at `references/contract.md:15` under T3. An agent told "21/21" concludes the raw-token rule is fully enforced by practice and will not look for the App exception. Command: `grep -n 'var(--ink-\|var(--paper-\|var(--spot-\|var(--serious)\|-raw)\|--role-[a-z-]*-\(dark\|light\)' App.svelte lib/*.svelte` → two hits, both App.svelte.

2. `skills/ui-design/SKILL.md:39` — *"exhibit `visualizer/web/src/lib/RunCard.svelte:59` and `visualizer/web/src/lib/FleetTable.svelte:31`"* (for *"Divide sibling rows with `border-top:1px solid var(--line)`"*)
   Neither anchor contains a `border-top`. `RunCard.svelte:59` is `.card { background:var(--panel); border:1px solid var(--line); padding:1rem; display:grid; gap:.8rem; }` — the file's only `border-top` is at **`RunCard.svelte:70`**. `FleetTable.svelte:31` is `table { … border:1px solid var(--line); }` — its `border-top` is at **`FleetTable.svelte:32`** (`th, td { border-top:1px solid var(--line); … }`). Both anchors point at a full box border, i.e. the exact thing the rule says *not* to use for a row divider.

**STALE**

3. `skills/ui-design/SKILL.md:37` — *"The chassis appears in 12 components"*
   The literal chassis string `background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1rem;` appears in **11** files: `AcceptPanel, CellHealthPanel, EnvelopeInspector, EventStream, IntakePanel, PhaseGantt, PhasePanel, ReviewPanel, RosterEditor, RunSetPanel, TeardownPanel`. (Under the looser *panel+line+padding* reading it is 13, adding `RunCard.svelte:59` and `RosterPanel.svelte:187`. No reading yields 12.)

4. `skills/ui-design/SKILL.md:35` / `:44` — *"Role and lane isolation is a hand-maintained six-filename allowlist"*
   The **six** filenames are real (`App.svelte`, `FleetTable.svelte`, `RunCard.svelte`, `Filters.svelte` at `test/visualizer-panels.test.mjs:660-661`; `TeardownPanel.svelte` at `test/visualizer-teardown.test.mjs:201`; `RosterPanel.svelte` at `test/visualizer-server.test.mjs:1396`) — but it is a **blocklist**, not an allowlist: each assertion is `assert.doesNotMatch(…, /--role-|--lane-\d/)`, i.e. those six files are *forbidden* from naming role/lane tokens. `references/contract.md:32` calls it a "role/lane isolation list", `references/state-colour.md:21` calls it "allowlist", and `references/limits.md:41` calls it a "blocklist". The word is wrong in SKILL.md and inverts the rule's direction on a first read.

5. `skills/ui-design/SKILL.md:12,:46` — the preserved register `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md` is outside the checkout (see frontend-svelte SKILL.md:31). It is the sole cited source for every count in this skill and for six of the eight §-references.

**TRUE**

- `:25` every colour a component paints resolves to a Tier-2 alias — stated rule, matches `references/contract.md:7` T1.
- `:27` **"Both ramps are positionally parallel five-step scales: ground -> panel -> hairline -> text -> muted"** — `theme.css:2-6` (`--ink-ground/-panel/-hairline/-text/-muted`) and `:7-11` (`--paper-*`, same five in the same order).
- `:29` **"T2 … is violated in 10 of 21 components, 34 times"** — 21 `.svelte` files total (`find visualizer/web/src -name '*.svelte' | wc -l` → 21); 10 carry colour literals; 33 hex + 1 named `white` = 34. Full per-file breakdown verified below under `state-colour.md` L1.
- `:31` **"19 `background:var(--panel)` sites and 45 `var(--line)` sites"** — `grep -o 'background:var(--panel)' … | wc -l` → **19**; `grep -o 'var(--line)' … | wc -l` → **45**.
- `:31` **"zero hard-coded surfaces or separators"** — every one of the 34 literals is a state colour (chip pairs, `.error`, gantt block/marker); none is a background surface or a border/separator.
- `:33` a shaper returns a tone and CSS maps class → token — `fleet.js:51-61` `deriveStatus` returns `tone`; `RunCard.svelte:65-68` / `FleetTable.svelte:37-40` map class → alias.
- `:33` **"no component reads `run.status` to pick a colour"** — `grep -n 'run.status' visualizer/web/src/**/*.svelte`: no colour selection; components interpolate `status.tone` into a class.
- `:37` the chassis declaration string is exact — verified verbatim in 11 files.
- `:38` **"The four recessed sites are `IntakePanel.svelte:122` and `RosterPanel.svelte:187`"** — `background:var(--bg)` appears **twice on each** of those two lines (`IntakePanel:122` `.candidate` + `.actor input`; `RosterPanel:187` `.chip` + `pre`) = 4 sites, and they are the only ones in the tree.
- `:40` `1px` hairline permit — 52 `1px` occurrences across the components; the register's "52 one-pixel hairlines" reproduces exactly (`grep -o '1px' App.svelte lib/*.svelte | wc -l` → 52).
- `:40` `999px` measured pill idiom — exactly 3 (`CellHealthPanel`, `RunSetPanel`, `TeardownPanel`).
- `:40` `720px`/`640px`/`1200px` measured layout bounds — `PhaseGantt.svelte:59` (720 ×2, 640 ×2), `App.svelte:196` (1200), `RunDetail.svelte:33` (1200). No other px layout value exists.
- `:40` the `18px`/`5px` SVG user-unit exception at `PhaseGantt.svelte:59` — `.bounce-label { … font-size:18px; … stroke-width:5px; … }`, exact.
- `:41` honest-blank exhibits — `RunCard.svelte:53` (`mode {run.mode || '—'}` with `title={run.pending.mode}` and `class:dashed`), `FleetTable.svelte:15–21` (seven `{@render mark(...)}` cells), `AcceptPanel.svelte:36` (`.dashed { border-bottom:1px dashed currentColor; }`).
- `:41` **ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`** — `:21` is `## 2. Decision 1 — observability: the pane-parity matrix`, `:23` is the prose. Exact.
- `:42` `.evidence :global(p)` at `AcceptPanel.svelte:36` and `PhasePanel.svelte:62`; App resets at `App.svelte:187–188`. Exact.
- `:43` `App.svelte:17–21,44–51,130` owns the `os`/`paper`/`ink` choice — `:19-21` read `localStorage` into `theme`, `:46-51` write/delete `data-theme`, `:130` is the `<select bind:value={theme}>` with the three options.
- `:43` `theme.css:36,67,97–98` owns the cascade — `:36-37` `:root, :root[data-theme='paper']`, `:67` `:root[data-theme='ink']`, `:97-98` `@media (prefers-color-scheme: dark) { :root:not([data-theme='paper']) {`.
- `:44` R2/R3 indirection at `RoleTag.svelte:4,9`, `PhaseDots.svelte:5,8`, `PhaseGantt.svelte:48,59` — all six anchors exact.

---

### `skills/ui-design/references/tokens.md`

Checkable claims: **62** — true **62**, stale **0**, false **0**. *(The most accurate document audited; every token name, hex value and line number reproduces exactly.)*

- `:7` **"105 custom-property declarations: 30 raw tokens plus 25 aliases repeated in three theme blocks, 55 unique names"** — recomputed: `:root` lines 2-32 minus the `:27` comment = **30**; paper `:40-64` = 25; ink `:70-94` = 25; media `:101-125` = 25; 30+75 = **105**; unique = 30+25 = **55**. Exact on all four numbers.
- `:7` the 30 raw declarations are in the opening `:root` block at lines 2–32, including `--mono` — `theme.css:32` `--mono: ui-monospace, …`.
- `:15-44` **all 30 Tier-1 rows** — every token name, every hex value, and every line anchor matches `theme.css` byte-for-byte: `--ink-ground #17171a :2`, `--ink-panel #1e1e22 :3`, `--ink-hairline #26262b :4`, `--ink-text #eae8ee :5`, `--ink-muted #9b99a3 :6`, `--paper-ground #efece5 :7`, `--paper-panel #e7e3da :8`, `--paper-hairline #e2ded4 :9`, `--paper-text #15140f :10`, `--paper-muted #55534a :11`, `--spot-light #8839ef :12`, `--spot-dark #cba6f7 :13`, `--role-planner-dark #3987e5 :14`, `--role-builder-dark #d95926 :15`, `--role-reviewer-dark #199e70 :16`, `--role-tech-lead-dark #c98500 :17`, `--role-lead-dark #d55181 :18`, `--role-driver-dark #9085e9 :19`, `--role-planner-light #2a78d6 :20`, `--role-builder-light #eb6834 :21`, `--role-reviewer-light #1baf7a :22`, `--role-tech-lead-light #eda100 :23`, `--role-lead-light #e87ba4 :24`, `--role-driver-light #4a3aa7 :25`, `--serious #ec835a :26`, `--status-ok-raw #2f9e62 :28`, `--status-fail-raw #c94f58 :29`, `--status-running-raw #c38b18 :30`, `--status-skipped-raw #77747d :31`, `--mono :32`.
- `:46` **"The only prose in the sheet is the operational-status comment at `theme.css:27`"** — `theme.css:27` `/* These status steps are operational tokens, not part of the ratified role palette. */`; it is the file's only comment.
- `:54-78` **all 24 Tier-2 alias rows** — every alias name and both cascade anchors verified: `--bg :40,71`, `--panel :41,72`, `--line :42,73`, `--muted :43,74`, `--accent :44,75`, `--neutral :45,76`, `--status-ok :46,77`, `--status-fail :47,78`, `--status-running :48,79`, `--status-skipped :49,80`, `--status-escalated :50,81`, `--role-planner :51,82`, `--role-builder :52,83`, `--role-reviewer :53,84`, `--role-tech-lead :54,85`, `--role-lead :55,86`, `--role-driver :56,87`, `--lane-0 :57,88` … `--lane-7 :64,95`. Every resolved value matches too.
- `:80` `--neutral` and `--muted` are the same colour in both themes — paper `:43,45` both `var(--paper-muted)`; ink `:73,75` both `var(--ink-muted)`, so `--lane-6`/`--lane-7` are indistinguishable.
- `:80` **"The lane vocabulary ends at N ∈ 0…7; there is no `--lane-8`"** — `grep -c 'lane-8' theme.css` → 0.
- `:80` status aliases and `--status-escalated` are identical in paper and ink — `:46-50` and `:76-80` resolve to the same `-raw`/`--serious` names.
- `:84` paper block is `:root, :root[data-theme='paper']` at `:36`; ink at `:67`; media-dark starts at `:97–98`. Exact.
- `:84` the media block is guarded so an explicit paper choice survives a dark OS — `:98` `:root:not([data-theme='paper'])`.
- `:84` `App.svelte:17–21, 44–51, 130` supplies the choice and writes or deletes `data-theme` — `:48` writes, `:49` `delete`s.
- `:88` `--identity-column:15rem` and `--lane-gap:.6rem` at `PhaseGantt.svelte:59`, with the `calc()` pinned by `test/visualizer-panels.test.mjs:845–847` — all three asserts present, `:847` pins `left:calc(var(--identity-column) + var(--lane-gap))`.
- `:89` `RoleTag.svelte:4` sets `--role-color` from a role alias; `PhaseDots.svelte:5` sets `--lane-color`; `PhaseGantt.svelte:48` supplies the lane indirection — all three exact.

---

### `skills/ui-design/references/contract.md`

Checkable claims: **24** — true **22**, stale **1**, false **1**.

**FALSE**

1. `contract.md:7` — *"A `var(--…)` census over the 21 components obeys T1 at **21/21**"*
   Same defect as `SKILL.md:29`, and here it sits eight lines above its own refutation. T1's forbidden list on the same line includes `--serious`; `App.svelte:201-202` names it; `contract.md:15` (T3) states that fact explicitly. Measured T1 conformance is **20/21**. The "measured component-local layout and indirection exceptions in `references/tokens.md`" escape clause does not cover `--serious` — `tokens.md:86-89` permits only layout locals and token-indirection locals, and `tokens.md:46` explicitly forbids a component from reading `--serious`.

**STALE**

2. `contract.md:32` — *"The role/lane isolation list is pinned by `test/visualizer-panels.test.mjs:660–665`"*
   `:660-661` is the four-file loop and its `doesNotMatch`; `:663-665` is the **positive** case (`RoleTag.svelte` *must* match `/--role-|--lane-/`). Folding the positive assertion into the "isolation list" range reads as if six files were pinned there. The blocklist proper is `:660-662`, as `references/state-colour.md:21` correctly says.

**TRUE**

- `:7` the T1 alias vocabulary — `--bg`, `--panel`, `--line`, `--muted`, `--accent`, `--neutral`, the `--status-*` aliases, `--status-escalated`, six `--role-*`, `--lane-0`…`--lane-7`: every one declared in `theme.css:40-64`.
- `:7` exhibit `theme.css:2–32, 36–127` — raw block ends `:32`(+`:33-34`), cascade `:36-127`. Correct.
- `:11` **"violates this in 10 of 21 components, 34 times"** — verified (see L1 below).
- `:11` exhibits `GateChips.svelte:13`, `AcceptPanel.svelte:36`, `PhasePanel.svelte:62` — all three carry hex chip pairs on those exact lines.
- `:11` **"The suite currently has no general hex ban and no general requirement that a colour declaration use `var()`"** — no such assertion exists in `test/visualizer-*.test.mjs`; the only CSS-value assertions are the two FleetTable pins at `:627,629`.
- `:15` `App.svelte:201–202` reads `--serious` for the rail — `.rail { … border:1px solid var(--serious); … }` / `.rail h2 { margin:0; color:var(--serious); }`.
- `:15` `App.svelte:208` reads `--status-escalated` for `.chip.serious` — exact.
- `:15` `RosterPanel.svelte:187` uses the same alias — `.drift { color:var(--status-escalated); }`.
- `:19` **"Only `App.svelte:46–51` may write `document.documentElement.dataset.theme`"** — `grep -rn 'dataset.theme' visualizer/` → `App.svelte:48` and `:49` only.
- `:19` `App.svelte:17–21, 44–51, 130` reads the persisted value, writes for the two explicit themes, deletes for `os`, persists — `:20` `localStorage.getItem('dt-theme')`, `:48` write, `:49` delete, `:50` `localStorage.setItem`.
- `:19` **"The repo-wide grep found only the theme selectors in `theme.css:36,67,98`"** — `:36-37` paper, `:67` ink, `:98` media-guarded. Exact.
- `:23` the three blocks are a cascade — bare `:root, :root[data-theme='paper']` at `:36` is the paper default; `:root[data-theme='ink']` at `:67`; guarded media block at `:97-98`. Exact.
- `:29` **"`test/visualizer-shape.test.mjs:286–292` checks 12 role/lane name-presence regexes against `theme.css`"** — the loop over `ROLE_ORDER` (6 entries, `trace.js:3`) runs two `assert.match` per role = **12** regexes. It inspects no colour value or count — confirmed by reading `:289-290`.
- `:30` `test/visualizer-panels.test.mjs:627,629` pins two exact FleetTable CSS strings including the stale and escalation status rules — exact.
- `:31` `:845–847` pins PhaseGantt's `--identity-column`, `--lane-gap` and their `calc()` — exact.
- `:32` `TeardownPanel.svelte` added by `test/visualizer-teardown.test.mjs:201` — `assert.doesNotMatch(component, /--role-|--lane-/)`.
- `:32` `RosterPanel.svelte` added by `test/visualizer-server.test.mjs:1396` — `assert.doesNotMatch(panel, /--role-|--lane-\d/)`.
- `:33` the blanket rule at `test/visualizer-shape.test.mjs:750–751` bans `export let` and `$:` in every `.svelte` file — exact.
- `:35` **"There is no suite rule banning a hex colour, requiring every painted colour to be a token, counting declarations in `theme.css`, checking theme values, checking `data-theme`, or checking `prefers-color-scheme`"** — grepped `test/visualizer-*.test.mjs` for each; zero hits for all six.
- `:35` `EventStream.svelte:29` contains `#123` in `(#123)` — `…predate phase linkage (#123)`.
- `:35` `MetricsStrip.svelte:19` contains `#83` in `(#83)` — `…awaiting the metering daemon (#83)`.
- `:37` the floor inherited by a new component is the six-filename list, the two FleetTable rules, the PhaseGantt locals and the runes-only rule — that is exactly the set of `.svelte` assertions in the suite.

---

### `skills/ui-design/references/state-colour.md`

Checkable claims: **48** — true **46**, stale **2**, false **0**.

**STALE**

1. `state-colour.md:7` — *"`visualizer/web/src/lib/fleet.js:53–61` (`deriveStatus`)"*
   `deriveStatus` is declared at **`fleet.js:51`**; `:52` reads `escalation`. The cited range starts inside the body. The tone returns it points at (`:54,56,57,58,59,60`) are all inside `53-61`, so the claim survives, but the function anchor is two lines late.

2. `state-colour.md:21` — *"The current hand-maintained six-filename **allowlist**"*
   It is a **blocklist**: the four files at `test/visualizer-panels.test.mjs:660-662` and the two additions are the files *forbidden* to name `--role-`/`--lane-N`. `references/limits.md:41` uses "blocklist" correctly. Same wording defect as `SKILL.md:35`.

**TRUE**

- `:7` `deriveStatus` returns `{ key, word, tone, where, why }` with `tone ∈ { serious, ok, fail, quiet, busy }` — `fleet.js:54` `serious`, `:56` `ok`, `:57` `fail`, `:58` `quiet`, `:59` `busy`, `:60` `quiet`. Exactly five tones, exactly those five keys.
- `:7` `class={\`status ${status.tone}\`}` at `RunCard.svelte:52` — exact string.
- `:7` the equivalent row at `FleetTable.svelte:14` — `class={\`status ${row.status.tone}\`}`.
- `:7` CSS maps class to an alias at `RunCard.svelte:65–68` and `FleetTable.svelte:37–40` — `.status.ok/.fail/.busy/.serious` → `var(--status-ok/-fail/-running/-escalated)` in both, four rules each, exactly those line ranges.
- `:9` tone vocabulary pinned by shaper tests at `test/visualizer-panels.test.mjs:280–282,307–308,387,443–444,500,521–531,715` and `test/visualizer-teardown.test.mjs:119–120` — all ranges contain tone assertions.
- `:9` **"no broad test proves every tone-to-token mapping"** — no such test exists.
- `:13` `RoleTag.svelte:4` sets `--role-color: var(--role-${role})`; `:9` paints `.swatch { background:var(--role-color) }` — exact, both lines.
- `:17` `PhaseDots.svelte:5` sets `--lane-color: var(--lane-${phase.lane})` and `:8` paints it — `:8` `.lane-dot { background:var(--lane-color); }`.
- `:17` `PhaseGantt.svelte:48` sets the lane variable and `:59` supplies `var(--lane-color, var(--lane-0))` — exact on both.
- `:17` lanes 0–5 follow `ROLE_ORDER` from `trace.js:3` — `['planner','builder','reviewer','tech-lead','lead','driver']` maps to `theme.css:57-62` in that order.
- `:17` `--lane-N` exists only for N ∈ 0…7 in `theme.css:57–64` — exact.
- `:21` the four forbidden files at `test/visualizer-panels.test.mjs:660–662` — `['App.svelte','lib/FleetTable.svelte','lib/RunCard.svelte','lib/Filters.svelte']`.
- `:21` `TeardownPanel.svelte` at `test/visualizer-teardown.test.mjs:201`; `RosterPanel.svelte` at `test/visualizer-server.test.mjs:1396` — exact.
- `:21` `RoleTag.svelte` is the positive case — `test/visualizer-panels.test.mjs:663-665`.
- `:21` **"`PhaseGantt.svelte:48` names `--lane-` directly while simply not being on the list"** — `PhaseGantt.svelte` is in neither the four-file loop nor the two additions, and `:48` writes `--lane-color:var(--lane-${block.lane ?? 0})`.
- `:25` `PhaseGantt.svelte:59` has a `var(--lane-color, var(--lane-0))` fallback; `PhaseDots.svelte:8` and `RoleTag.svelte:9` do not — exact (`background:var(--lane-color)` / `background:var(--role-color)`, no fallbacks).
- `:29-43` **the complete L1 leak inventory** — every row reproduces exactly:

  | Claimed | Measured (`grep -o '#[0-9a-fA-F]\{3,8\}\b'`) | Verdict |
  |---|---|---|
  | `GateChips.svelte:13` — `#166534 #dcfce7 #991b1b #fee2e2` (4) | line 13, those four | true |
  | `AcceptPanel.svelte:36` — same four (4) | line 36, those four | true |
  | `PhasePanel.svelte:62` — those four + `#92400e #fef3c7` (6) | line 62, those six | true |
  | `PhaseGantt.svelte:59` — `#fff #d8ffd9 #ffd1d1 #ffe4a3` (4) | line 59, those four | true |
  | `IntakePanel.svelte:122` — `#9b1c1c ×3, #7a3e9d ×3` (6) | line 122, exactly that multiset | true |
  | `CellHealthPanel.svelte:61` — `#7a3e9d #9a6700 #176b3a` (3) | line 61, those three | true |
  | `RunSetPanel.svelte:61` — `#176b3a #9b1c1c #7a3e9d` (3) | line 61, those three | true |
  | `RunDetail.svelte:33` — `#b42318` (1) | line 33 | true |
  | `EnvelopeInspector.svelte:48` — `#b42318`, `white` (2) | line 48: `#b42318` + `color:white` | true |
  | `RosterEditor.svelte:71` — `#b42318` (1) | line 71 | true |
  | **Total 33 hex + one named = 34, in 10 of 21** | 33 + 1 = **34**, in **10** files | true |

- `:45` `EventStream.svelte:29` has `#123` in an issue reference; `MetricsStrip.svelte:19` has `#83` — exact, and these are the only two non-colour `#` matches in the tree.
- `:49` **L2** — `App.svelte:201–202` uses `--serious`, `:208` uses `--status-escalated`, `RosterPanel.svelte:187` correct — exact.
- `:50` **L3** — `RosterEditor.svelte:71` paints `pre` with `background:var(--line)` — `…}pre { overflow:auto; …; background:var(--line); …`. Exact.
- `:51` **L6** — `FleetTable.svelte:36` gives `.status-dot` `background:var(--neutral)`, `:42` replaces it with `background:currentColor` — exact, both lines, in that order.
- `:52` **L10** — `scout` **32** uses and `advisor` **3** uses in `crew/*.mjs` (`grep -o "'scout'" crew/*.mjs | wc -l` → 32; `'advisor'` → 3) with no `--role-*` token for either (`grep -c 'role-scout\|role-advisor' theme.css` → 0); `PhaseGantt.svelte:40` passes `'unlinked'` (`<RoleTag role={identity.role || 'unlinked'} …>`); `RoleTag.svelte:9` has no fallback. All four sub-claims exact.
- `:53` **L11** — `visualizer/web/index.html:2` has no `color-scheme` metadata (the whole document is two lines; `<head>` carries only charset, viewport, title); `theme.css` sets no `color-scheme` property (its one `color-scheme` string is the `prefers-color-scheme` media feature at `:97`); `App.svelte:46–51` applies the theme after mount. Exact.
- `:57` **D4** — `.error` hard-coded `#b42318` in `RunDetail.svelte:33`, `EnvelopeInspector.svelte:48`, `RosterEditor.svelte:71` (3) vs `var(--status-fail)` at `App.svelte:200` and `RosterPanel.svelte:187` (2). Exact 3–2 split.
- `:58` **D5** — `unproven` has four policies: amber chip `#92400e` on `#fef3c7` at `PhasePanel.svelte:62`; muted text with a `color-mix` fill at `GateChips.svelte:13` (`.chip.unproven { color:var(--muted); background:color-mix(in srgb, var(--muted) 16%, transparent); }`); pale `#ffe4a3` at `PhaseGantt.svelte:59` (`.gate-marker.unproven`); `var(--status-running)` at `TeardownPanel.svelte:54`. All four exact.
- `:59` **D6** — `deriveStatus` emits `quiet` for queued and unknown at `fleet.js:58,60`; only `App.svelte:209` defines `.chip.quiet`; `RunCard.svelte:65–68` and `FleetTable.svelte:37–40` omit it. Exact on all four anchors.
- `:60` **D10 part 1** — `theme.css:129,131` globally reset `border-radius:0` (`*, *::before, *::after` and `button, input, select, textarea`); `App.svelte:192` repeats the form reset (`button, select { … border-radius:0; … }`). Exact.
- `:62` C9's honest blank — `RunCard.svelte:53`, `FleetTable.svelte:15–21`, ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`. Exact.

**One arithmetic caveat inside a true claim** — `:60` **D10 part 2**: *"20 radius declarations in 11 components"*. The **20** is exact (`grep -o 'border-radius:[^;}]*' … | grep -v ':0' | wc -l` → 20), and the breakdown is exact (`.6rem ×11`, `1rem ×3`, `999px ×3`, plus `.25rem`, `.2rem`, `50%`). But those 20 declarations live in **13** files, not 11: `AcceptPanel, CellHealthPanel, EnvelopeInspector, EventStream, GateChips, IntakePanel, PhaseDots, PhaseGantt, PhasePanel, ReviewPanel, RosterEditor, RunSetPanel, TeardownPanel`. **11** is the count of files carrying `.6rem` specifically. Marking the file-count half **stale** (11 → 13); the rule it supports is unaffected.

---

### `skills/ui-design/references/limits.md`

Checkable claims: **28** — true **28**, stale **0**, false **0**. *(Every contrast ratio recomputed independently from `theme.css` literals with the WCAG relative-luminance formula; all sixteen reproduce to the stated 2 d.p.)*

- `:7` all four status steps and `--serious` fall below 4.5:1 on the paper ground — verified below.
- `:13-16` the contrast table:

  | Alias | Claimed ink / paper | Recomputed ink / paper |
  |---|---|---|
  | `--status-escalated` / `--serious` `#ec835a` | 6.78 / 2.24 | **6.78 / 2.24** |
  | `--status-running` `#c38b18` | 5.99 / 2.53 | **5.99 / 2.53** |
  | `--status-ok` `#2f9e62` | 5.27 / 2.88 | **5.27 / 2.88** |
  | `--status-fail` `#c94f58` | 4.04 / 3.75 | **4.04 / 3.75** |

- `:18` `--status-skipped` is 3.90 on ink and 3.89 on paper — recomputed **3.90 / 3.89**.
- `:18` `--ink-text` 14.72 — recomputed **14.72** (on `--ink-ground`).
- `:18` `--paper-text` 15.63 — recomputed **15.63** (on `--paper-ground`).
- `:18` `--ink-muted` 6.37 — recomputed **6.37**.
- `:18` `--paper-muted` 6.54 — recomputed **6.54**.
- `:18` `--spot-dark` 8.81 — recomputed **8.81**.
- `:18` `--spot-light` 4.59 — recomputed **4.59**. (And "every theme-paired token clears 4.5:1 on its own ground" holds: min is 4.59.)
- `:20` `PhaseGantt.svelte:59` uses `.block { color:#fff }` — exact.
- `:20` **"The six paper role combinations range from 2.17 to 8.56 and the six ink combinations from 3.07 to 3.94"** — recomputed paper: planner 4.42, builder 3.20, reviewer 2.82, tech-lead **2.17**, lead 2.69, driver **8.56**; ink: planner 3.64, builder 3.88, reviewer 3.41, tech-lead **3.07**, lead **3.94**, driver 3.13. Both ranges exact.
- `:20` **"only 1 of 12 lane/ground combinations clears 4.5:1"** — recomputed: exactly one (`driver` paper, 8.56). Exact.
- `:26` `test/visualizer-shape.test.mjs` checks 12 name-presence regexes over `theme.css` and inspects no value, so deleting `--status-escalated` leaves the suite green — verified: `:286-292` never names `--status-escalated`, and no other test does.
- `:28` the test at `:286–292` checks role declarations and lane-to-role names only — exact.
- `:28` a consumer pin at `test/visualizer-panels.test.mjs:627,629` makes one FleetTable rule exact but does not prove the token exists — correct: both are `assert.match` on the FleetTable source text, never on `theme.css`.
- `:34` fourteen sub-1rem values / no preferred scale (C5) — register-sourced; the tree does carry 14+ distinct sub-`1rem` values, consistent.
- `:35` nine ad-hoc type sizes, two weights, `.micro` checkable — `.micro` exists at `theme.css:134`; `font-weight` appears with exactly two values (`600`, `700`).
- `:36-39` corner radius (D10), pill radius (D3, a 3–3 tie), panel-spacing ownership (D2), tone completeness (D6) — each traces to a real, verified divergence above.
- `:41` the §8 floor covers role/lane mapping, two exact FleetTable strings, PhaseGantt layout locals, no `export let`/`$:`, and selected source pins; it does **not** cover a general colour-token rule — matches the suite exactly.
- `:47` **"No repo file establishes where the ratified role palette was ratified; the durable trace is `test/visualizer-shape.test.mjs:286–292` and the comment in `theme.css`"** — `grep -rn 'ratified role palette\|role palette' docs/ crew/` → only `theme.css:27`. True.
- `:50` the recon did not trace whether the ledger can carry `scout`/`advisor` in `agent_sessions.role` — no such assertion exists anywhere.

---

### `crew/guidelines/review-do-not-flag.md`

Checkable claims: **14** — true **7**, stale **2**, false **5**. **Every one of the five false claims is a defense anchor** — the exact thing `crew/drive.test.mjs:619-622` exists to guarantee is non-empty, and which it checks only by regex shape, never by resolution.

**FALSE**

1. `crew/guidelines/review-do-not-flag.md:24` — *"the task dir is `~/.crew/<repo>/<task>/task` (`crew/crew.mjs:97-101`)"*
   `crew/crew.mjs:97-101` is a prose comment about why only the planner requires the `subagents` capability: *"// Only the PLANNER requires `subagents`, and the asymmetry is // deliberate: its charter is "domain lead + architect + scout-commander"…"*. It says nothing about paths. The **path claim is correct** — `crew/crew.mjs:283-287`, `function pathsFor`, `:285` `const dir = join(homedir(), '.crew', repo, taskSlug)` and `:286` `taskDir: join(dir, 'task')` — but the anchor is wrong by ~186 lines. A reviewer told to verify the defense reads an unrelated comment and cannot confirm it.

2. `crew/guidelines/review-do-not-flag.md:26-27` — *"the scope gate diffs `git status --porcelain` against `files_in_scope` (`crew/drive.mjs:1663-1673`)"*
   `crew/drive.mjs:1663-1673` is gate-custody escalation: `:1664` `const gateAuthoredOutside = shape.sources?.gate === 'brief'`, `:1665` `noGateCustodian`, `:1666-1672` `gateCustodyEscalate`. No scope logic at all. The real mechanism is `scopeMatcher` at **`crew/drive.mjs:1388-1396`**, `io.changedFiles()` documented as `git status --porcelain` paths at **`crew/drive.mjs:1456`**, and the bounce at **`crew/drive.mjs:2040`** (`outOfScopeFiles(io.changedFiles(), scopeMatcher([]))`) / **`:2985-2993`** (`escalate('scope', 'out-of-scope edits persisted: …')`).

3. `crew/guidelines/review-do-not-flag.md:44-45` — *"the scope gate bounces any edit outside `files_in_scope` (`crew/drive.mjs:1663-1673`)"*
   The identical wrong anchor, repeated in the fifth bullet's defense. Two of the five defenses in this file rest on the same non-existent seam.

4. `crew/guidelines/review-do-not-flag.md:34` — *"In run `45-breaker` the lead refuted exactly this with the sole caller cited at `crew/crew.mjs:926`"*
   `crew/crew.mjs:926` is `}` — the closing brace of `[...byKey.values()].sort(compareShadowCell)`'s enclosing function; `:928` begins `function shadowNumber(value)`. There is no call site there. The archived run is not in this checkout, so the claim is unresolvable as written.

5. `crew/guidelines/review-do-not-flag.md:40` — *"the lead refuted this at `crew/daemon.mjs:606-660` in run `205-regrant`"*
   `crew/daemon.mjs:606-660` spans a partial-read loop (`:606-610` `while (got < buf.length) { const n = readAt(...) }`), a worker-record constructor (`:640-651`), and `rpcPid` (`:653-659`). It contains no registry append, no fork, and no two-statement kill window — the exact seam the defense claims it exhibits.

**STALE**

6. `crew/guidelines/review-do-not-flag.md:8-9` — *"Seeded from 49 archived runs' review findings and the 13 lead accepts that refuted one."*
   Unverifiable on this checkout: no archived runs are present (`~/.crew/*/*/journal.jsonl` is outside the repo and outside a seat's workspace). The denominator is stated, satisfying `skills/pr-review/SKILL.md:34`, but nothing in the repo can confirm or refresh it.

7. `crew/guidelines/review-do-not-flag.md:19-20` — *"Six archived runs ended with the lead refuting a must-fix as already closed on disk."*
   Same: no in-repo evidence, and no test pins the number.

**TRUE**

- `:3-4` *"The reviewer's procedure loads this file; the charter names it and does not restate it"* — `crew/roles/reviewer.md:30-31` names it and carries no `## Do not flag` section (pinned by `crew/drive.test.mjs:623-624`).
- `:6` the `## Do not flag` heading exists and is found by `crew/drive.test.mjs:605`.
- `:10-12` *"where one of these still worries you in a specific diff, write it as a `consider`"* — matches `crew/roles/reviewer.md:32-33` verbatim in substance, and is consistent with `skills/pr-review/references/rubric.md:63-65`.
- `:14-15` *"Re-read the line you are about to cite before you cite it"* / *"Method step 1 of `crew/roles/reviewer.md`"* — `.agents/skills/review-procedure/SKILL.md:12-13` step 1 is *"Read `plan.md` in the task dir, then `git diff` / `git status`, then every changed file in full."* Consistent.
- `:18` *"the plan's validation lane runs against that same tree"* — `crew/roles/builder.md:48` and `crew/drive.mjs` suite stage. Consistent.
- Structural: **five** `- **`-prefixed entries, each carrying a `Defense:` line, each defense matching `/crew\/[\w.-]+|files_in_scope|\.crew\/|#\d{2,}/` — this is exactly what `crew/drive.test.mjs:615-622` asserts, and the file passes. **The test proves the defense mentions a path-shaped string; it never opens it.** That is why all five false anchors above are green.
- `:46` runs `83-headless-io` → **#125**, `46-tier-boot` → **#193** — issue numbers are well-formed and satisfy the `#\d{2,}` branch of the regex; the issues themselves are not in this checkout.

**Consistency with `skills/pr-review/`** — checked rule by rule; **no contradiction found**:
- `:42-46` *"A remedy that cannot be built in this slice … Write it as a `consider`"* ↔ `skills/pr-review/references/rubric.md:63-65` *"A remedy needing a file outside `files_in_scope` can only produce a scope bounce, so it is a consider; cite `crew/guidelines/review-do-not-flag.md` as the owner of that judgment rather than restating its entries."* Explicit, matching cross-ownership.
- `:21-27` task-dir drift ↔ `skills/pr-review/SKILL.md:53` row 9 *"stale comments, docs, charters — 0 must-fix in 23"* and `rubric.md:59-61` (*"Doc or markdown locations were 0 must-fix in 16, stale prose was 0 of 7"*; 16+7 = 23 ✓). Agreeing, and arithmetically consistent.
- `:28-34` *"a failure reachable only through a caller that does not exist … Not a must-fix"* ↔ `skills/pr-review/SKILL.md:29-30` *"State a finding as state → wrong observable in one sentence, or grade it a consider"*. Agreeing.
- Every rate in this file carries its denominator (49 runs, 13 accepts, six runs), satisfying `skills/pr-review/SKILL.md:34`.

---

### `crew/guidelines/seat-pre-return-checklist.md`

Checkable claims: **26** — true **21**, stale **3**, false **2**.

**FALSE**

1. `crew/guidelines/seat-pre-return-checklist.md:64` — *"the driver enforces exactly this at baseline (`crew/drive.mjs:230-236`)"* (P2, the baseline GATE-SUMMARY)
   `crew/drive.mjs:230-236` is a comment introducing `shapeDefect` — *"// Can this driver honour the declaration at all? A shape it cannot execute is // REFUSED with a reason…"* — followed by `:237 export function shapeDefect(shape, variantName)`. Nothing about gates or baselines. The real enforcement is **`crew/drive.mjs:601-605`** (`baselineGateDefect`, *"// Why a baseline is not acceptable as red. null = it is acceptable."*), **`:2689-2693`** (`stage('gate-baseline')` → `runGate` → `if (baseline.ok) … gate-baseline:green-bounce`), and **`:2475-2476`** (the "STILL green at baseline" escalation). A planner following the anchor to check the contract finds a shape validator.

2. `crew/guidelines/seat-pre-return-checklist.md:71` — *"the whole-gate false positive — a gate that is red overall while some individual check adjudicates nothing (#330, `crew/drive.mjs:851-914`)"* (P3)
   `crew/drive.mjs:851-914` is generic plumbing: `:848-852` a prototype check, `:854-856` `textOf`, `:858-` `safeArrayLength`, and `:905-916` a question-id/cap dedupe loop. The real per-check machinery is **`crew/drive.mjs:1305`** (`MUTATIONS_MAX = 32`), **`:1313`** (`CHECK_FAIL_PREFIX = 'FAIL'`), **`:1351-1386`** (`validateMutations`), **`:2392-2403`** (validation at plan-accept), **`:2510`** (the per-mutation application loop) and **`:2536-2545`** (the `FAIL <check>` delimiter refusal).

**STALE**

3. `crew/guidelines/seat-pre-return-checklist.md:3-6` — *"the charters name this file and do not restate it"*
   Both charters **do partially restate it**: `crew/roles/builder.md:44-49` gives the three builder families one line each (*"- **Edge paths** — every new error path you wrote answers EPERM, unknown, interrupted and empty."* etc.), and `crew/roles/planner.md:160-165` does the same for P1-P3. The intent (no full restatement) holds; the literal claim does not. Contrast `crew/roles/reviewer.md:30-33`, which genuinely does not restate.

4. `crew/guidelines/seat-pre-return-checklist.md:10-13` — *"this is the tier-0 predicate set the #294 advisor will fire mid-round"*
   `#294` is a future/parked issue; `grep -rn '294' crew/ scripts/` finds no advisor implementation, and `crew/capabilities.json` sets `"advisor": false` for all five roles. The A/B baseline this paragraph justifies does not exist yet on this checkout.

5. `crew/guidelines/seat-pre-return-checklist.md:15-20` — the measured block (*"164 archived lanes on 2026-08-19 (`~/.crew/*/*/journal.jsonl` plus `returns/*.json`): 220 first reviews, 94 bounced … Of the 93 recorded must-fix findings"*)
   Unverifiable on this checkout — `~/.crew/*/*/journal.jsonl` is outside the repo. The **arithmetic is internally sound** (94/220 = 42.7% ≈ 43% ✓; 18/93 = 19.4% ≈ 19% ✓; 12/93 = 12.9% ≈ 13% ✓) and `crew/roles/builder.md:41-44` repeats the same figures consistently. No test pins any of them.

**TRUE**

- `:5-6` *"the shape follows `crew/guidelines/review-do-not-flag.md`"* — both are `## `-sectioned lists of `- **Id — imperative.**` entries with a trailing rationale sentence. Structurally identical.
- `:22` / `:49` the two seat sections are exactly `## Builder — before you return` and `## Planner — before you return`.
- **`B1`** (`:24`) defined; cited by `crew/roles/builder.md:40` (`` `B1`-`B3` ``) and restated at `builder.md:45-46`.
- **`B2`** (`:34`) defined; cited by the same range; restated at `builder.md:47`.
- **`B3`** (`:42`) defined; cited by the same range; restated at `builder.md:48-49`.
- **`P1`** (`:51`) defined; cited by `crew/roles/planner.md:157` (`` `P1`-`P3` ``); restated at `planner.md:161`.
- **`P2`** (`:59`) defined; cited by the same range; restated at `planner.md:162-163`.
- **`P3`** (`:61`) defined; cited by the same range; restated at `planner.md:164-165`.
- `:46-47` *"the charter already requires the run (`crew/roles/builder.md`)"* — `crew/roles/builder.md:48-49` requires the lane re-run and its counts in the envelope. Correct (file-level anchor, no line, so it cannot drift).
- `:56-58` *"lane `b37-percheck-proof` spent five plan rounds, its tech-lead's round-1 check having 'reviewed every cited code anchor and falsified the claimed post-green seam'"* — external lane, not in checkout; quoted as a quotation, denominator-free but not a rate.
- `:72-74` the machine-applied entry shape `{ "check", "file", "find", "replace" }` — enforced at `crew/drive.mjs:1360-1363` (`check` non-empty and matching `CHECK_LABEL`), `:1373-1376` (`file` non-empty, repo-relative, `inScope`), `:1377-1378` (`find` non-empty literal, `replace` a string).
- `:74-75` *"or, for a check no single edit can kill, exactly a `check` plus `exempt` and nothing else"* — `crew/drive.mjs:1368-1372`: `exempt` present together with any of `file`/`find`/`replace` → `'an exemption declares no mutation'`; empty `exempt` → `'an exemption must carry its reason'`.
- `:76` *"Never both shapes in one entry"* — `crew/drive.mjs:1369`, exact.
- `:76-77` *"never a prose field, which `validateMutations` refuses"* — a bare string entry is refused at `crew/drive.mjs:1358` (`'entry must be an object'`). **Caveat:** `validateMutations` does **not** reject an *extra* key alongside a valid mutation (no `Object.keys` allowlist anywhere in `:1351-1386`), so if "a prose field" means an added `why`/`note`, the claim overstates the refusal. Read as "a prose *entry*", true at `:1358`.
- `:77-78` *"The label is a `stable token` the gate prints verbatim on its `FAIL <check>` line"* — `crew/drive.mjs:1313` `CHECK_FAIL_PREFIX = 'FAIL'`, `:1319/:1341` `const want = \`${CHECK_FAIL_PREFIX} ${check}\``, `:2589` the brief text. Pinned by `test/factory-make-brief.test.mjs:767` (`assert.ok(p3.includes(\`${CHECK_FAIL_PREFIX} <check>\`))`) — a live import-coupled pin.
- `:78` *"`find` and `replace` must differ"* — `crew/drive.mjs:1379-1380`, `'find and replace are identical — that mutates nothing'`.
- `:79` *"Every compiled brief repeats the full contract under `## Per-check mutations`"* — `scripts/factory/make-brief.mjs:1421` emits the literal `'## Per-check mutations'` heading; `test/factory-make-brief.test.mjs:664,673,677,686,707,730,1131` pin the section and its contents. Also stated at `crew/roles/planner.md:194`.
- `:24-33` **B1**'s enumeration (EPERM, ENOENT, unknown, interrupted/partial write, empty) is well-formed and self-consistent with the 19%/18-finding figure.
- `:34-41` **B2**'s verdict vocabulary (`proven`/`unknown`/`failed`) matches the repo's own gate vocabulary — `TeardownPanel.svelte:54` and `test/visualizer-teardown.test.mjs:198-200` use exactly `.proven`/`.failed`/`.unproven`.
- `:51-58` **P1**'s remedy (`sed -n` or `Read` each anchor before returning) is exactly the discipline this audit found violated in the two skills and both guideline files.

---

### `crew/pi/agents/scout.json`

Checkable claims: **17** — true **16**, stale **1**, false **0**.

**STALE**

1. `crew/pi/agents/scout.json:5` — *"you may not edit, write or run commands, and **the seat that spawned you** enforces that"*
   The enforcement is not the seat's: it is `crew/pi/extensions/subagent.ts:63` `export const SUBAGENT_DENY = ['edit', 'write', 'bash']`, pushed as `--exclude-tools` at `:287` on the **child** process the extension spawns, plus `--no-extensions --no-skills` at `:288`. The extension runs inside the seat's process, so the sentence is defensible by proximity, but an agent taking it literally looks for a seat-level guard that does not exist. The boundary is documented at `subagent.ts:61-62`: *"--exclude-tools beats --tools on pi's filter, so this is the real read-only line; the definition's `tools` is an activator."*

**TRUE** (the entire return contract reproduces against `crew/pi/extensions/subagent.ts`)

- `"name": "scout"` — read at `subagent.ts:267-268`, which **refuses** unless `definition.name === grant.name`; the grant is `{ "name": "scout", "def": "crew/pi/agents/scout.json" }` at `crew/capabilities.json:23`. Pinned by `crew/capabilities.test.mjs:61`.
- `"tools": ["read","grep","find","ls"]` — read at `subagent.ts:273`, used at `:286` (`args.push('--tools', def.tools.join(','))`). Identical to the built-in default `['read','grep','find','ls']` on the same line, so the declaration is redundant-but-correct.
- `"prompt"` — read at `subagent.ts:270-271` (refused if absent or blank), written to `agent-prompt.md` at `:603-604` and passed as `--append-system-prompt` at `:289`.
- *"You answer exactly ONE narrow question"* — matches the tool's `task` parameter description at `subagent.ts:93`: *"The one narrow question the scout must answer."*
- *"Cite it as file:line"* / *"Mark each finding `verified` … `assumed`"* — `confidence: { enum: ['verified','assumed'] }` at `subagent.ts:137`, enforced at `:209-210`.
- *"Return ONLY a JSON object, with no prose before or after it (a single ```json fenced block is also accepted)"* — `subagent.ts:223` (raw `{`) and `:229-232` (exactly one ```` ```json ```` fence; `:231` refuses more than one).
- *"`summary` and `findings` are required"* — `required: ['summary','findings']` at `subagent.ts:124`, enforced at `:194-196`.
- *"`findings` must not be empty"* — `minItems` semantics enforced at `subagent.ts:195` (`value.findings.length < 1` → `findings-not-a-non-empty-array`).
- *"Every finding requires `claim`, `evidence` … and `confidence`"* — `required: ['claim','evidence','confidence']` at `subagent.ts:133`, enforced at `:203-210`.
- *"`evidence` (a non-empty list of non-empty strings)"* — `subagent.ts:136` and `:204-207`.
- *"`confidence` is not optional"* — `subagent.ts:209-210`, error code `finding-confidence-invalid` at `:178`.
- *"`gaps` is optional"* — `subagent.ts:141` (not in `required`), `:214-215` validates only when present.
- *"No other keys are permitted anywhere in the object"* — `additionalProperties: false` at `subagent.ts:123,132`, enforced imperatively at `:191-192` (`unknown-key`) and `:200-201` (`finding-unknown-key`).
- *"a payload carrying one is refused and your work is thrown away"* — `subagent.ts:781`: `refused: the child's findings violated the contract (…)`; `findings` stays `null` and only the refusal text reaches the parent.
- `"description"` field — syntactically valid JSON, present. **Read by nothing** (see the scout.json section below).
- The file parses as JSON — `node -e "JSON.parse(...)"` clean; `crew/capabilities.test.mjs:157-160` pins that a malformed/wrong-name/no-prompt definition raises `agent-def-invalid`.

---

## Format compliance

Judged against the epic #497 ratified rules. Comparators used to establish the ratified shape: `skills/backend-node/SKILL.md` (45 lines), `skills/qa-test-writing/SKILL.md` (110), `skills/pr-review/SKILL.md` (62).

### `skills/frontend-svelte/SKILL.md` — 4 pass, 2 fail

| # | Rule | Verdict | Line | Justification |
|---|---|---|---|---|
| **R1** | Description = trigger surface | **PASS** | `:3-9` | Enumerates five distinct intents: *"before creating or editing a visualizer component, changing the app shell, adding a plain-module shaper, or deciding how a source-level test should pin Svelte code"*, plus the coverage sentence at `:7-9`. Every intent maps to a routing row. One gap worth noting, not a fail: the description never says "Svelte 5" or "runes", so a query phrased as *"how do I use `$derived` here"* has no lexical hook beyond the bare word "Svelte". |
| **R2** | Routing table up front | **PASS** | `:14-21` | `## Routing` is the first section after the intro, a 3-column `intent → rule → details` table whose Details column is exactly `` `references/<file>.md` `` for all four rows, and all four files exist. |
| **R3** | Critical rules as imperatives carrying reason AND a named exception | **FAIL** | `:23-31` | The section is titled `## Operating rules`, not `## Critical rules` (both comparators use the ratified heading: `backend-node:28`, `qa-test-writing:39`). It contains **no named exception anywhere** — no "with one exception", no "unless", no "except". It carries **no reason** attached to any imperative: `backend-node` appends a `Cost:` clause to every rule (`:30-35`); this file appends nothing. And two of its four paragraphs (`:25`, `:27`) are **verbatim copies of `:12`**, so the section's actual novel content is one paragraph (`:29`) plus a preserved-path pointer (`:31`). |
| **R4** | Progressive disclosure | **FAIL** | `:12`, `:25`, `:27` | SKILL.md is 38 lines — the smallest in `skills/` and well inside budget — but the *mechanism* is broken: the file duplicates itself. `:12` states two sentences; `:25` repeats the first verbatim; `:27` repeats the second verbatim. Separately, the `## Routing` table at `:16-21` is a near-duplicate of the table at `references/routing.md:7-12` (same four intents, same four targets, one differing wording) — so the reference the routing sends you to opens by re-serving the routing you just read. Depth is not being pushed down; surface is being repeated at two levels. |
| **R5** | Posture declared | **PASS** | `:12` | *"This is a **retrieval-first** repo skill, not a Svelte API manual."* First sentence of the body, matching the epic's requirement that frontend-svelte be retrieval-first. `grep -rln 'retrieval-first' skills/` matches this file only. |
| **R6** | Boundary: optional orchestrator procedure, not always-on seat behaviour | **FAIL** | `:29`, `references/routing.md:9,19` | The skill never states the boundary, and three of its instructions **assume seat execution and cannot hold there**. `:29` *"run `svelte-autofixer` over changed Svelte code before returning it"* — "before returning it" is seat vocabulary (a seat returns a ReturnEnvelope), yet a seat is booted `--no-extensions --no-skills` (`crew/adapters/adapter-pi.mjs:251,253`), `crew/capabilities.json` grants `"skills": []` and `"extensions": []` to every one of the five roles, and the repo carries no MCP configuration at all. `.agents/skills/review-procedure/SKILL.md:26-33` shows the ratified way to state this — it names the flag, the pi version, and the claude build that cannot see the skill. `skills/frontend-svelte` carries no such section. |

### `skills/ui-design/SKILL.md` — 4 pass, 2 fail

| # | Rule | Verdict | Line | Justification |
|---|---|---|---|---|
| **R1** | Description = trigger surface | **PASS** | `:3-9` | Enumerates the intent surface twice over — by subject (*"theme-paired chrome, Tier-2 alias tokens, explicit status and identity colour routing, panel and spacing idioms, honest absence marks, and known contrast and enforcement limits"*) and by action (*"before designing or reviewing a Svelte component, choosing a colour, adding a panel, or deciding how state, role, lane, and unmeasured values should appear"*). Every one of the four routing rows is reachable from a listed trigger. Strongest R1 of the two. |
| **R2** | Routing table up front | **PASS** | `:14-21` | `## Routing` immediately after the two-sentence intro; `Doing… → Rule that governs it → Details`; all four Details cells are `` `references/<file>.md` ``; all four files exist and hold what the row claims. |
| **R3** | Critical rules as imperatives carrying reason AND a named exception | **PASS** | `:23-44` | Correct heading `## Critical rules`. Named exceptions with their reason are present and specific: `:40` *"Permit `1px` only for hairlines, `999px` for the measured pill idiom, `720px`/`640px`/`1200px` for measured layout bounds, and the `18px`/`5px` SVG user-unit exception at `PhaseGantt.svelte:59`; do not turn the exception into CSS spacing"*; `:42` *"Keep `:global` for descendants produced by markdown rendering, **which a component cannot scope**"* (reason) *"the two App reset restatements … are a recorded divergence, not a license for global selectors"* (bounded exception); `:38` *"do not reverse the C2 roles"*; `:35` names the allowlist's own expiry condition. Every bullet from `:37` carries a file:line exhibit. This is the ratified shape. |
| **R4** | Progressive disclosure | **FAIL** | `:29-44` | 53 lines, second-longest in `skills/` after `qa-test-writing` (110) — size alone would pass. What fails is the layering: `:29` (*T1 21/21, T2 10 of 21 / 34*), `:31` (*19 panel-background sites, 45 separator sites*), `:35` (*six-filename allowlist*), `:37` (*chassis in 12 components, 19 + 45*), `:39` (*52 hairlines*) are **measured counts** — the exact material the epic pushes into `references/`. Each is restated in its reference with the same numbers (`contract.md:7,11`, `state-colour.md:21,29`, `tokens.md`), so SKILL.md is carrying a second copy of the measurement layer rather than the decision layer. Compare `backend-node/SKILL.md:30-35`, which carries only rule + exhibit + cost and leaves every count downstairs. Two numbers in this duplicated layer have already drifted apart from their references (the `21/21` at `:29` vs the `--serious` reading at `contract.md:15`; the chassis `12` at `:37` vs the measured 11). |
| **R5** | Posture declared | **FAIL** | — | **No posture statement anywhere in the file.** `grep -rn 'retrieval-first\|measurement-first' skills/ui-design/` → zero hits. The epic leaves ui-design's posture to its own call, but it must *declare* one; this file declares none. The body's actual behaviour is measurement-first — `:12` *"Treat the measured register … as evidence"*, `:46` *"The measurements above are preserved, not re-derived"* — so the posture exists in practice and is simply unnamed. Its sibling `skills/qa-test-writing/SKILL.md:19-22` shows the ratified form: *"The posture is **measurement-first**: this domain is *this repo*, not a moving external API."* Note also that "preserved, not re-derived" is a *weaker* posture than measurement-first and is the direct cause of the four stale counts found above; whichever posture is declared should say which side of that line it sits on. |
| **R6** | Boundary: optional orchestrator procedure, not always-on seat behaviour | **FAIL** | `:12`, `:46` | No boundary statement. Worse, the skill's central evidentiary claim is unreachable from a seat: `:12` and `:46` route the reader to `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md`, an **absolute path outside the checkout and outside any seat workspace**, cited a further six times across the references (`contract.md:3`, `limits.md:3`, `state-colour.md:3`, `tokens.md:3,91`, and `frontend-svelte`'s `SKILL.md:31`, `components.md:3`, `structure.md:3`). A seat instructed to *"read the references before adding a rule that the suite does not enforce"* (`:46`) cannot open the source those references defer to. Like frontend-svelte, no `## Verifying on a seat` section exists. |

**Cross-cutting, both skills:** neither is registered anywhere in the repo (`grep -rn 'frontend-svelte\|ui-design' .` outside their own directories → **zero hits**) and neither has an exhibits test. `skills/backend-node/exhibits.test.mjs`, `skills/devops/exhibits.test.mjs`, `skills/crew-dispatch/cli-contract.test.mjs` and `skills/pr-review/findings-shape.test.mjs` pin their skills' anchors; `skills/frontend-svelte/` and `skills/ui-design/` contain no `.test.mjs`. That is the mechanical reason all 9 false and 16 stale claims in these two families survived: **~200 file:line anchors, zero of them pinned.**

---

## Guidelines wiring

### `crew/guidelines/review-do-not-flag.md`

**What code loads it**

| Path | What it does |
|---|---|
| `.agents/skills/review-procedure/scripts/load-guidelines.mjs:7` | `const REL = 'crew/guidelines/review-do-not-flag.md'` — the only loader in the repo. |
| `.agents/skills/review-procedure/scripts/load-guidelines.mjs:9-18` | Walks up from `process.cwd()` for a dir holding both `package.json` and `REL`; `:14` errors `expected ${REL}, found nothing, at ${cwd}` and exits 1. |
| `.agents/skills/review-procedure/scripts/load-guidelines.mjs:20` | `process.stdout.write(readFileSync(join(dir, REL), 'utf8'))` — prints it verbatim. |
| `.agents/skills/review-procedure/SKILL.md:15-18` | Step 3 of the procedure invokes that script. |
| `crew/roles/reviewer.md:30-31` | *"Before writing findings, load the do-not-flag guidelines (`crew/guidelines/review-do-not-flag.md`, via the `review-procedure` skill)."* — the charter names the file and the route. |

**`crew/drive.mjs` does not load it.** `grep -rn 'review-do-not-flag' crew/drive.mjs` → zero hits. `grep -rn 'guidelines' --include='*.mjs'` across the repo returns only the loader, the two test files, and `crew/drive.test.mjs`. There is no runtime path from the driver to this file.

**The load is conditional and currently unreachable on a booted seat.** `crew/adapters/adapter-pi.mjs:253` — `...(skills.length ? skills.flatMap((skill) => ['--skill', \`"${skill}"\`]) : ['--no-skills'])`. `crew/capabilities.json` gives `"skills": []` to **all five roles** (`:9,17,31,39,47`), so `skills.length` is 0 for every seat and every pi seat boots `--no-skills`. The `review-procedure` SKILL.md states this itself at `:26-29` (*"crew's pi transport currently boots seats with `--no-skills`, so the flag above is how you see it today"*) and at `:30-33` records that a claude seat discovers only `.claude/skills` and does **not** read `.agents/`, so the skill does not load there either. **Net: the reviewer charter instructs a seat to load a file via a skill that no seat is granted.** The charter's phrasing — *"load the do-not-flag guidelines … via the `review-procedure` skill"* — is the only thing that reaches the seat; a reviewer that reads its charter can still `cat` the path directly, which is presumably what happens in practice.

**What test pins it**

| Test | What it pins |
|---|---|
| `crew/drive.test.mjs:602-625` | The file has a `## Do not flag` section (`:605-606`); it holds **≥ 4** `- **`-prefixed entries (`:615`); **every** entry contains `Defense:` (`:620`); every defense matches `/crew\/[\w.-]+\|files_in_scope\|\.crew\/\|#\d{2,}/` (`:621`); `crew/roles/reviewer.md` does **not** carry its own `## Do not flag` heading (`:623`) and **does** name the guideline path (`:624`). |
| `crew/drive.test.mjs:742-748` | Runs `load-guidelines.mjs` as a subprocess and asserts `result.stdout` **byte-equals** `readFileSync(crew/guidelines/review-do-not-flag.md)` — pins the loader's fidelity end to end. |

**The pin's blind spot, measured:** `:621` asserts each defense *mentions* a repo-path-shaped or issue-shaped string. It never resolves one. All five defenses pass; **four of the five carry a wrong anchor** (`crew.mjs:97-101`, `drive.mjs:1663-1673` ×2, `crew.mjs:926`, `daemon.mjs:606-660`). A `sed -n` on each cited range at test time would have caught every one.

**Ids defined vs cited:** this file defines **no ids** — its five entries are unlabelled bullets (`- **A defect the current working tree no longer contains.**`, `- **Task-dir drift …**`, `- **A failure reachable only through a caller that does not exist**`, `- **A fault needing a second, independent failure …**`, `- **A remedy that cannot be built in this slice**`). No charter cites an id from it; `crew/roles/reviewer.md:30-33` refers to it wholesale ("its classes"). **Nothing orphaned in either direction**, but the asymmetry with its stated sibling is worth naming: `seat-pre-return-checklist.md:5-6` says *"the shape follows `crew/guidelines/review-do-not-flag.md`"*, yet the checklist labels every item and this file labels none, so `crew/drive.test.mjs:615`'s "at least 4 entries" is positional and an entry cannot be cited, deprecated or A/B'd by name.

### `crew/guidelines/seat-pre-return-checklist.md`

**What code loads it — nothing.**

The task's premise is **false**: `grep -n 'checklist\|guideline' scripts/factory/make-brief.mjs` → **zero hits** across all 1582 lines. `scripts/factory/make-brief.mjs` never reads, inlines, or names this file. `grep -rn 'seat-pre-return-checklist' .` returns exactly three hits repo-wide:

| Path | Kind |
|---|---|
| `test/factory-make-brief.test.mjs:755` | test read (direct `readFileSync`, not through make-brief) |
| `crew/roles/builder.md:39` | charter prose |
| `crew/roles/planner.md:156` | charter prose |

There is **no loader script** (no counterpart to `load-guidelines.mjs`) and **no runtime read**. The only delivery path is charter prose: `crew/crew.mjs:1308/1317` merges the role card into `${taskDir}/role-${role}.md` and it is passed as `--append-system-prompt` (`crew/adapters/adapter-pi.mjs:254`). The seat therefore receives the *instruction to read* `crew/guidelines/seat-pre-return-checklist.md` and must open it itself from its workspace — which works, since the path is repo-relative and the seat's cwd is the checkout. That is a strictly weaker guarantee than the reviewer guideline's (which at least has a loader), and it is invisible to any test.

**What test pins it**

| Test | What it pins |
|---|---|
| `test/factory-make-brief.test.mjs:753-768` (*"the charter and the checklist state the contract the driver enforces"*) | Reads `crew/roles/planner.md` and the checklist. On the **charter**: presence of `"check"`, `"file"`, `"find"`, `"replace"`, `"exempt"`, `files_in_scope`, `#330` (`:756-758`); a JSON-shaped `{"check": "<token>"` (`:759`); a `// MUTATION <token>:` comment (`:761`); the literal `MUTATIONS_MAX` value imported from `crew/drive.mjs` (`:762`). On the **checklist**: slices from `- **P3` to end (`:763`) and asserts that slice contains `` `find` ``, `` `replace` ``, `` `exempt` ``, `files_in_scope`, `stable token` (`:764-766`) and `` `${CHECK_FAIL_PREFIX} <check>` `` (`:767`). |

**Coverage gap:** the pin touches **P3 only**. B1, B2, B3, P1 and P2 are pinned by nothing — no test asserts they exist, that the ids are the ones the charters cite, or that their anchors resolve. That is exactly where the two false anchors landed (P2's `crew/drive.mjs:230-236` and P3's `crew/drive.mjs:851-914` — note P3 *is* partially pinned, but only for token presence, never for anchor resolution).

**Ids defined vs cited — complete cross-check**

| Id | Defined at | Cited by a charter | Restated by the charter | Pinned |
|---|---|---|---|---|
| `B1` | `:24` | `crew/roles/builder.md:40` (`` `B1`-`B3` ``) | `builder.md:45-46` | no |
| `B2` | `:34` | `crew/roles/builder.md:40` | `builder.md:47` | no |
| `B3` | `:42` | `crew/roles/builder.md:40` | `builder.md:48-49` | no |
| `P1` | `:51` | `crew/roles/planner.md:157` (`` `P1`-`P3` ``) | `planner.md:161` | no |
| `P2` | `:59` | `crew/roles/planner.md:157` | `planner.md:162-163` | no |
| `P3` | `:61` | `crew/roles/planner.md:157` | `planner.md:164-165` | `test/factory-make-brief.test.mjs:763-767` |

- **Ids cited by a charter but not defined by the checklist: none.**
- **Ids defined by the checklist but cited nowhere: none.**
- Both charters cite by **range** (`` `B1`-`B3` ``, `` `P1`-`P3` ``), never individually, so no test or grep can detect the day a seventh item is added or `B2` is deleted. A range citation makes the id set uncheckable by construction.
- **Namespace collision to be aware of:** `crew/drive.mjs:1665,2186,2334` carry inline anchor comments `⚓ B3/B4/B5`, `⚓ B2`, `⚓ B1`, and `crew/drive.mjs:3020` says *"Gate B2 (mechanical)"*. These are drive.mjs's own anchors and have nothing to do with the checklist's `B1`-`B3`. `scripts/factory/intake.mjs:42` holds a third `P0`/`P1`/`P2` namespace (issue priority). Any future grep-based pin on `\bB2\b` or `\bP1\b` will collide across all three.

---

## scout.json vs the register

`crew/pi/agents/scout.json` declares four fields. The grant is `crew/capabilities.json:23` — `"agents": [{ "name": "scout", "def": "crew/pi/agents/scout.json" }]` under `roles.planner.by_agent.pi`.

| Field | Declared value | Who reads it | Granted by `capabilities.json`? |
|---|---|---|---|
| `name` | `"scout"` | `crew/pi/extensions/subagent.ts:267-268` — refuses the definition unless `definition.name === grant.name`; re-emitted into the loaded definition at `:274`; used to look up the grant at `:560` and to name the journal row at `:806` (`agent: agentName`). Clamped through `boundAgentName` at `:110,448,551`. | **Yes** — the name is half the grant tuple at `crew/capabilities.json:23`, and `crew/capabilities.test.mjs:61` pins `assert.deepEqual(grants.agents, [{ name: 'scout', def: join(REGISTER_ROOT, 'crew/pi/agents/scout.json') }])`. |
| `description` | `"Read-only recon: answers one narrow question about this checkout with cited, confidence-marked findings."` | **Nobody.** `crew/pi/extensions/subagent.ts:274` constructs the loaded definition as exactly `{ name, prompt, tools, model, thinking }` — `description` is dropped on the floor. `grep -n 'definition.description\|def\.description' crew/pi/extensions/subagent.ts crew/crew.mjs` → zero hits. The `description` the model actually sees is the hard-coded string at `subagent.ts:498` (*"Spawn a read-only scout subagent from the crew capability register and return its schema-validated findings."*), and the per-agent enum at `:110-116` exposes only **names**, never descriptions. | n/a — the register carries no description field either (`crew/capabilities.test.mjs:71` pins the grant key set as exactly `['tools','extensions','agents','skills','advisor','requires']`). **Declared and read by nothing.** |
| `tools` | `["read","grep","find","ls"]` | `crew/pi/extensions/subagent.ts:273` (`Array.isArray(definition.tools) && definition.tools.length ? … : ['read','grep','find','ls']`) then `:286` `args.push('--tools', def.tools.join(','))`. **Byte-identical to the built-in fallback on the same line**, so deleting the field changes nothing. And it is only an *activator*: the real read-only boundary is `SUBAGENT_DENY = ['edit','write','bash']` at `:63`, pushed as `--exclude-tools` at `:287`, which `:61-62` documents as beating `--tools` on pi's filter. | **Yes, transitively** — the planner holds `"tools": ["Task"]` (`crew/capabilities.json:14`) and `"requires": ["subagents"]` (`:19`), which is what lets the seat spawn at all. `crew/crew.mjs:161` refuses to boot a seat granted fan-out agents whose defaults deny fan-out. |
| `prompt` | the 1.5 KB return contract | `crew/pi/extensions/subagent.ts:270-271` — refused if not a non-empty string (`agent-def-invalid`, pinned at `crew/capabilities.test.mjs:160`); re-emitted at `:274`; written to `agent-prompt.md` mode `0o600` at `:603-604`; passed as `--append-system-prompt` at `:289`. | **Yes** — reached through the `def` path at `crew/capabilities.json:23`. |

**Fields the loader reads that scout.json does not declare** (both optional, both correctly omitted):

| Field | Read at | Effect of omission |
|---|---|---|
| `model` | `subagent.ts:274`, consumed at `:586` (`const model = def.model ?? parentModel`) | The scout inherits the parent seat's model. Deliberate and correct — a per-agent model here would silently escape the roster's cost ceiling. |
| `thinking` | `subagent.ts:274`, consumed at `:591` (`def.thinking ?? (def.model ? undefined : ctx?.thinkingLevel)`) | Inherits the parent's thinking level, because `def.model` is also undefined. Correct pairing. |

**Grants scout.json needs that `capabilities.json` does not carry: none.** Every capability the definition depends on is present: the `Task` tool (`:14`), the `subagents` requirement (`:19`), the `subagent.ts` extension (`:22`), and the agent grant itself (`:23`). `crew/capabilities.test.mjs:184` pins the closed refusal vocabulary, and `agent-def-invalid` is the code this definition would trip if its `name` or `prompt` drifted.

**Single finding: `description` is a declared field that nothing reads.** Either wire it (surface it in the `agent` enum at `subagent.ts:110-116`, where the model currently picks a name with no description to distinguish it) or drop it. As written, editing it changes nothing observable, and a second agent definition added tomorrow would give the model two bare names and no way to choose between them.

---

## Contradictions

Five places where two of these documents instruct differently for the same situation.

**1 — T1 conformance: 21/21 vs the `--serious` reading it forbids.**

> `skills/ui-design/SKILL.md:29`: *"T1 (name only Tier-2 aliases) is obeyed 21/21; T2 (every painted colour comes from a token) is violated in 10 of 21 components, 34 times."*

> `skills/ui-design/references/contract.md:7`: *"It must not name a raw `--ink-*`, `--paper-*`, `--spot-*`, role `-dark`/`-light` half, **`--serious`**, or `-raw` status token. A `var(--…)` census over the 21 components obeys T1 at **21/21**…"*

> `skills/ui-design/references/contract.md:15`: *"T3 has one file-level violation … `visualizer/web/src/App.svelte:201–202` reads `--serious` for the rail, while `App.svelte:208` reads `--status-escalated`…"*

> `skills/ui-design/references/state-colour.md:49`: *"**L2 — raw escalation read:** `visualizer/web/src/App.svelte:201–202` uses `--serious` for the rail…"*

`--serious` is on T1's own forbidden list, and `App.svelte:201-202` names it (verified). An agent asked *"does any component name a raw token?"* gets **no** from `SKILL.md:29` and `contract.md:7`, and **yes** from `contract.md:15` and `state-colour.md:49`. Measured answer: **20/21**. The number was preserved by moving one violation into a separate rule (T3) while leaving T1's forbidden list unchanged.

**2 — the role/lane list is an allowlist and a blocklist.**

> `skills/ui-design/SKILL.md:35`: *"Role and lane isolation is a hand-maintained six-filename **allowlist** and does not generalise to a component written tomorrow."*

> `skills/ui-design/references/state-colour.md:21`: *"The current hand-maintained six-filename **allowlist** is `visualizer/web/src/App.svelte`, `…/FleetTable.svelte`, `…/RunCard.svelte`, `…/Filters.svelte` (**forbidden** at `test/visualizer-panels.test.mjs:660–662`)…"*

> `skills/ui-design/references/limits.md:41`: *"The six-filename role/lane **blocklist**, the exact FleetTable rules, the PhaseGantt locals, and the runes-only rule are the floor…"* (also `contract.md:37`)

The code is unambiguous — `test/visualizer-panels.test.mjs:661` is `assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /--role-|--lane-\d/)`, so the six named files are **forbidden** to name role/lane tokens. `state-colour.md:21` contradicts itself inside one sentence ("allowlist … forbidden at"). An agent adding a component and reading "allowlist" concludes it must get itself added to the list to use role colour; the truth is the opposite — being on the list means it may not.

**3 — the checklist says the charters do not restate it; the charters restate it.**

> `crew/guidelines/seat-pre-return-checklist.md:3-6`: *"the two authoring seats — builder and planner — self-apply this list … the charters name this file and **do not restate it** (the shape follows `crew/guidelines/review-do-not-flag.md`)."*

> `crew/roles/builder.md:44-49`: *"The three families, one line each: - **Edge paths** — every new error path you wrote answers EPERM, unknown, interrupted and empty. - **Verdict honesty** — nothing you record is stronger than what you measured. - **Lane re-run** — the plan's lane ran green on the tree you are returning, and its counts are in your envelope."*

> `crew/roles/planner.md:160-165`: *"The three items, one line each: - **Anchors** — every file:line you cite resolves to what you say it does. - **Baseline GATE-SUMMARY** … - **Kill mutations** …"*

The claimed model is `crew/roles/reviewer.md:30-33`, which genuinely does not restate (and `crew/drive.test.mjs:623` pins that it does not). No equivalent pin exists for builder.md or planner.md, so their one-line restatements can drift from the checklist silently — and there are now two copies of each item's imperative with no test tying them together.

**4 — `--no-skills` vs three unconditional "run the tool" instructions.**

> `skills/frontend-svelte/SKILL.md:29`: *"…then read the repo reference that matches the question. Keep component props in one destructuring line, keep deterministic logic in `visualizer/web/src/lib/*.js`, and **run `svelte-autofixer` over changed Svelte code before returning it**."*

> `skills/frontend-svelte/references/routing.md:19`: *"4. **Run `svelte-autofixer`** over the code, then address its result before returning it."*

> `crew/adapters/adapter-pi.mjs:253`: `...(skills.length ? skills.flatMap((skill) => ['--skill', \`"${skill}"\`]) : ['--no-skills']),`

> `.agents/skills/review-procedure/SKILL.md:26-29`: *"pi 0.84.2 discovers `<cwd>/.agents/skills` on its own; **crew's pi transport currently boots seats with `--no-skills`**, so the flag above is how you see it today"*

`crew/capabilities.json` grants `"skills": []` and `"extensions": []` to all five roles, so `skills.length` is always 0 and every pi seat boots `--no-skills`; the repo has no MCP configuration, so `svelte-autofixer` (`mcp__plugin_svelte_svelte__svelte-autofixer`) does not exist in a seat's tool surface either. "before returning it" is seat vocabulary. `review-procedure` is the repo's own model for how to state this honestly; neither Svelte skill does.

**5 — the register is the evidence base and is unreachable from where it is read.**

> `skills/ui-design/SKILL.md:46`: *"The measurements above are preserved, not re-derived, in `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md`; **read the references before adding a rule that the suite does not enforce**."*

> `skills/frontend-svelte/SKILL.md:31`: *"The preserved measurements live at `/Users/x/.dev-team/factory/preserved/scout-b151-viztokens/conventions-register.md`; they describe this checkout and are **not a substitute for current MCP documentation**."*

> `crew/guidelines/seat-pre-return-checklist.md:51-54` (P1): *"**every file:line anchor you cite resolves to what you say it does.** Re-read each anchor … with `sed -n` or `Read` before you return, and correct the ones that have drifted; **an anchor you cannot resolve is `assumed`, never `verified`**."*

The register is an absolute path outside the checkout and outside every seat workspace, cited eight times across the two skills as the source of ~40 measured numbers. P1 is the repo's own ratified rule for exactly this: an unresolvable anchor is `assumed`. Both skills present register-sourced counts as verified fact with no confidence marking — and four of those counts (`$state(` 53, `{@render` 27, `onclick=` 16, chassis 12) have since drifted, which is precisely the failure P1 exists to prevent.

---

## Overlap

Prose duplicated elsewhere in the repo, with a proposed single home for each.

**1 — The `:global` markdown-descendant rule, near-verbatim in two skills.**

> `skills/frontend-svelte/references/components.md:35`: *"Reserve `:global` for descendants produced by markdown rendering, where the compiler cannot see the generated elements: `.evidence :global(p)` appears at `visualizer/web/src/lib/AcceptPanel.svelte:36` and `visualizer/web/src/lib/PhasePanel.svelte:62`. The `:global(*)` and `:global(body)` reset copies in `visualizer/web/src/App.svelte:187–188` are recorded duplication, not a pattern for ordinary component selectors."*

> `skills/ui-design/SKILL.md:42`: *"Keep `:global` for descendants produced by markdown rendering, which a component cannot scope. The measured uses are `.evidence :global(p)` at `visualizer/web/src/lib/AcceptPanel.svelte:36` and `visualizer/web/src/lib/PhasePanel.svelte:62`; the two App reset restatements at `visualizer/web/src/App.svelte:187–188` are a recorded divergence, not a license for global selectors."*

Same rule, same three exhibits, same caveat, differing only in wording. **Single home: `skills/ui-design`** — `:global` is a styling-scope decision and the ui-design family already owns the CSS surface (tokens, chassis, hairlines, radius). `frontend-svelte/references/components.md` should keep its `## Scoped styles` heading and one sentence deferring to it, the way `references/testing.md:17` already defers to `qa-test-writing`.

**2 — The `#123`/`#83` grep-trap warning, three times.**

> `skills/ui-design/references/contract.md:35`: *"A checker author must not mistake issue prose for a colour: `visualizer/web/src/lib/EventStream.svelte:29` contains `#123` in `(#123)`, and `visualizer/web/src/lib/MetricsStrip.svelte:19` contains `#83` in `(#83)`. Those are the measured grep traps; restrict a detector to CSS values."*

> `skills/ui-design/references/state-colour.md:45`: *"A naive hex sweep also sees copy, not colour: `visualizer/web/src/lib/EventStream.svelte:29` has `#123` in an issue reference and `visualizer/web/src/lib/MetricsStrip.svelte:19` has `#83`."*

Also implied by the L1 total at `state-colour.md:43`. **Single home: `skills/ui-design/references/contract.md:35`**, which is the one that frames it as a *detector-authoring* rule; `state-colour.md` should cite it rather than restate the two exhibits.

**3 — The PhaseGantt layout locals and their pin, twice inside ui-design.**

> `skills/ui-design/references/tokens.md:88`: *"Layout locals belong to the element that consumes geometry: `--identity-column:15rem` and `--lane-gap:.6rem` at `visualizer/web/src/lib/PhaseGantt.svelte:59`, with the `calc()` that consumes them pinned by `test/visualizer-panels.test.mjs:845–847`."*

> `skills/ui-design/references/contract.md:31`: *"`test/visualizer-panels.test.mjs:845–847` pins PhaseGantt's `--identity-column`, `--lane-gap`, and their `calc()` geometry."*

**Single home: `references/tokens.md:88`** — it is the "legitimate component-local custom property" rule, and `contract.md`'s enforcement list should cite the token rule instead of repeating the anchors.

**4 — The runes-only source rule, three times across both skills.**

`skills/frontend-svelte/references/components.md:29` (*"`test/visualizer-shape.test.mjs:750–751` checks those strings across every `.svelte` file"*), `skills/frontend-svelte/references/testing.md:15` (*"`test/visualizer-shape.test.mjs:750–751` covers the runes-only source rule"*), and `skills/ui-design/references/contract.md:33` (*"The blanket Svelte shape rule at `test/visualizer-shape.test.mjs:750–751` bans `export let` and `$:` in every `.svelte` file"*). **Single home: `skills/frontend-svelte/references/testing.md:15`** — it is a *test-floor* fact; the other two should cite it. `ui-design` has no business owning a Svelte-syntax rule at all.

**5 — The honest-blank / absence idiom, across four skills.**

`skills/ui-design/SKILL.md:41` and `references/state-colour.md:62` (muted em-dash, `title`, dashed underline, ADR-029 §2); `skills/qa-test-writing/references/absence.md` and `SKILL.md:34` (*"Asserting on a value nobody measured — Absent with a reason, never zero"*); `skills/backend-node/SKILL.md:35` and `references/usage-records.md` (*"omit the usage key when it is absent; never manufacture a partial zero"*); `skills/devops/SKILL.md`. **These are legitimate domain specialisations of one principle, not duplication to collapse** — UI rendering, test assertion, and record emission are three different surfaces. But the principle itself ("an unmeasured value is absent, never a measured-looking zero") is stated four times with four different phrasings and only one ratified source, **ADR-029 §2 at `docs/adr/adr-029-headless-observability-interjection.md:23`**. Propose: each skill keeps its surface-specific rule and cites the ADR line as the shared root; only `ui-design:41` and `state-colour.md:62` currently do.

**6 — The self-duplication inside `skills/frontend-svelte/SKILL.md`.**

`:12` states two sentences; `:25` repeats the first **verbatim**; `:27` repeats the second **verbatim**, inside a 38-line file. **Single home: `:12`** (the posture paragraph). The `## Operating rules` section should keep only `:29` and `:31`.

**7 — The `frontend-svelte` routing table vs `references/routing.md`.**

`skills/frontend-svelte/SKILL.md:16-21` and `skills/frontend-svelte/references/routing.md:7-12` are the same four-row intent table with near-identical wording; the second is the first thing you read after the first sends you there. **Single home: `SKILL.md:16-21`** (R2 requires it up front). `references/routing.md` should open at its `## The retrieval order` (`:14`), which is the content that actually justifies a separate file.

**8 — The `~/.crew/<repo>/<task>/task` path and the scope-gate mechanism.**

Stated in prose at `crew/guidelines/review-do-not-flag.md:24` and `:26-27`, and again at `:44-45`, each time with a hand-written anchor — and each of those three anchors is wrong (see the register above). The facts have single code homes already: `crew/crew.mjs:283-287` (`pathsFor`) and `crew/drive.mjs:1388-1396` + `:1456` + `:2985-2993`. **Proposal: cite the function name, not the line range** (`pathsFor` in `crew/crew.mjs`; `scopeMatcher`/`outOfScopeFiles` in `crew/drive.mjs`), which survives refactors — and extend `crew/drive.test.mjs:621` from *matches a path-shaped regex* to *the cited `file:line` range exists and contains the named symbol*. That single test change would have caught four of this audit's five false anchors.

---

## Appendix — verdict totals

| Document | Claims | true | stale | false |
|---|---:|---:|---:|---:|
| `skills/frontend-svelte/SKILL.md` | 11 | 7 | 3 | 1 |
| `skills/frontend-svelte/references/components.md` | 31 | 23 | 6 | 2 |
| `skills/frontend-svelte/references/routing.md` | 9 | 8 | 0 | 1 |
| `skills/frontend-svelte/references/structure.md` | 19 | 17 | 1 | 1 |
| `skills/frontend-svelte/references/testing.md` | 12 | 12 | 0 | 0 |
| **frontend-svelte total** | **82** | **67** | **10** | **5** |
| `skills/ui-design/SKILL.md` | 21 | 16 | 3 | 2 |
| `skills/ui-design/references/tokens.md` | 62 | 62 | 0 | 0 |
| `skills/ui-design/references/contract.md` | 24 | 22 | 1 | 1 |
| `skills/ui-design/references/state-colour.md` | 48 | 46 | 2 | 0 |
| `skills/ui-design/references/limits.md` | 28 | 28 | 0 | 0 |
| **ui-design total** | **183** | **174** | **6** | **3** |
| `crew/guidelines/review-do-not-flag.md` | 14 | 7 | 2 | 5 |
| `crew/guidelines/seat-pre-return-checklist.md` | 26 | 21 | 3 | 2 |
| **guidelines total** | **40** | **28** | **5** | **7** |
| `crew/pi/agents/scout.json` | 17 | 16 | 1 | 0 |
| **GRAND TOTAL** | **322** | **285** | **22** | **15** |
