# Conventions — dev-team-claude-plugin

Cross-cutting conventions that bind the lean runtime. Earlier-runtime history is in
`docs/archive/conventions-earlier-runtimes.md`.

> The binding entries are **2026-08-02 (concurrency: `linkSync` exclusive creates,
> `wx` locks, a corrupt lock is stale and never a wedge)**, **2026-08-01
> (structural impossibility over test assertion; whitelist over blacklist)**,
> **2026-08-02 (a literal NUL makes a source file unsearchable to grep)**,
> **2026-08-08
> (use the local checkout for this repo's tooling)**, **2026-09-15
> (the runtime stays dependency-free; visualizer build dependencies are named)**,
> and **2026-11-03 (seats and suites run with the operator's environment)**.
> The token-fenced locks in `crew/reclaim.mjs` inherit the concurrency entry.

## Implementation files

The still-binding entries above govern the lean runtime's files:

- `crew/loop.mjs`
- `crew/checks.mjs`
- `crew/agents.mjs`
- `crew/reclaim.mjs`

## Format

- **YYYY-MM-DD** — decision/convention. *Why:* reason. [deprecated — supersedes: <prior entry>]

## Entries

- **2026-08-01** — Prefer structural impossibility to a test assertion, and a whitelist to a blacklist. Encode a rule so violating it yields an *invalid document* (closed enum, absent property, `additionalProperties: false`); keep the test only as a meta-check that the constraint hasn't been widened. Where a constraint must be enumerated, enumerate what is **allowed**. *Why:* 1a's plan review found two stale blacklists (a shell-metachar refusal list missing `(`/`)`/quotes; a conditional-keyword list missing four banned keywords) and zero stale whitelists.
- **2026-08-02** — Concurrency-unsafe check-then-act on files is a defect class the panel found four times in one slice: use `writeFileSync(tmp)` + `linkSync(tmp, dest)` (EEXIST = loser) for exclusive creates, a `'wx'`-created lock file `{pid, started_at}` verified-before-unlink for RMW transitions, and treat a corrupt lock as stale, never a wedge. `existsSync`-then-`rename` is always a TOCTOU (rename clobbers unconditionally). *Why:* 1b's record lifecycle (writeRecord/terminateRecord/worktrees.json) shipped all three shapes before review.
- **2026-08-02** — A raw control character (e.g. a literal `NUL`) written as a string-literal separator makes the source file "binary" to BSD grep/`rg`/diff and many editors — they silently match nothing. Always use the escape (`'\0'`, `'\x00'`) so the source stays ASCII while the runtime string is identical; at the gate, a `grep` that unexpectedly returns *nothing* for a symbol you know exists is the tell — confirm with `tr -cd '\0' | wc -c` / a Python NUL scan. *Why:* an earlier-runtime subagent shipped two literal NUL join-separators in `adapter-claude.mjs`; tests passed (node tolerates it) but every grep-based gate check came back empty and nearly masked a real inspection.
- **2026-08-08** — **When this repo (dev-team's own source) is running its own orchestration, invoke the repo's own script tooling from the LOCAL checkout, never from `${CLAUDE_PLUGIN_ROOT}`/the installed plugin cache path — the two can diverge by dozens of versions.** During issue #25 planning, the installed copy of `spec-lint.mjs` (since retired) (installed at `0.1.43`) reproduced a "double-extension bare-mention" false positive that backend-notes.md's 2026-08-05 entry already documents as fixed (via span exclusion) — because the fix shipped in this repo's own HEAD (`0.1.74` at the time), 31 versions ahead of the stale installed cache. Re-running the identical spec against the repo-local copy passed clean, confirming the fix is real and the cache was simply behind. *Why:* the plugin's own `SessionStart` hook injects rules from the installed cache path (announced at the top of every session as "Plugin root: .../<version>/"), so a session working on this repo's own dev easily grabs the wrong copy of a tool by reflex — the fix is to prefer the repo-relative path (the script's path from cwd) for any script this repo itself ships, and treat a cache-path invocation's findings as unverified until cross-checked against HEAD.
- **2026-09-15** — **The runtime stays dependency-free; the visualizer may take build-time dependencies, each named here with the page that needs it.** `package.json` has no runtime `dependencies`; the visualizer uses `svelte` for the UI, `vite` and `@sveltejs/vite-plugin-svelte` for its build, and `lucide-svelte` for UI icons. Historically the workflow graph and prompt editor used `@xyflow/svelte`, `@dagrejs/dagre`, `codemirror`, `@codemirror/lang-markdown` and `@codemirror/lang-json`; the operator approved removing these unused dependencies on 2026-10-31. The 2026-09-15 decision followed measurement of the hand-rolled SVG node editor alternative: the zero-dependency guarantee concerns the lane and plugin install, not the visualizer build. Supersedes the visualizer half of the 2026-08-01 dependency-free entry; the schema-validator half stands.
- **2026-11-03** — Seats and suites run with the operator's environment. For suites and per-test proof, `cleanEnv` in `crew/checks.mjs` sets `NO_COLOR=1` and drops only `FORCE_COLOR`, `CLICOLOR_FORCE`, `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID`. `piSeatSpawnEnv` in `crew/adapters/adapter-pi.mjs` withholds inherited `CREW_ADVISOR*` and `CREW_PI_AGENTS` keys unless the seat environment supplies them. Neither is a secrets boundary; a real boundary is one lane that scrubs both together. *Why:* review finding A14 (`~/.crew/reviews/codebase-2026-11-03.md`) and the operator decision of 2026-11-03.
