# Lean memory injection

## Minimal changes
1. `crew/lean.mjs:46-62`: remove the unsupported-memory refusal (and now-unused `refuse` import). Return effective memory separately from the dispatched ACP definition; preserve the existing definition shape and tier precedence.
2. `crew/loop.mjs:163-164,214`: pass `{ emit }` as the second argument to `d.runSeat(asked, { emit })`. This reuses the existing best-effort, timestamped lane journal, including injected journals, rather than adding another journal writer.
3. `crew/lean.mjs:127-130`: receive that emitter. For ordinary assignments only, when effective memory is exactly true, use `openMemory({ dir }).context({ task: request.brief, role })` and `renderSection`. Resolve dir from `process.env.CREW_MEMORY_DIR || join(spec.cwd, '.claude', 'dev-team', 'memory')`, never the agent installation or task directory. Include a nonempty section in the assignment prompt (before Feedback/Return) and therefore its recorded prompt. Reuse that prompt on provider retries. Keep repair-only prompts unchanged.
4. If rendering yields no section, still dispatch ACP and await `emit('memory-empty', { role, id, reason: extract.reason ?? 'empty' })`. Do not read memory or add memory journal rows when effective memory is absent/false. Do not modify memory backends, verbs, stores, seat proposals, agent definitions or the bench.

## Tests and proof
5. Replace the memory-refusal test in `crew/start.test.mjs:471-499` with positive and missing-store coverage using real scratch stores and the existing fake ACP boundary. Retain/update the false/absent/tier-override coverage immediately following it. Preserve unrelated definition-shape assertions.
6. LM1: MEMORY.md links one entry; assert planner reaches ACP, its prompt and recorded prompt contain `## Team memory` and the entry body. Test base true, selected-tier true, false overridden by true, lane-default location, and CREW_MEMORY_DIR overriding a different lane store.
7. LM2: no directory and directory without MEMORY.md both reach ACP without a section, with journal reasons `no-dir`/`no-index` identifying the issued seat. Exercise injected journal and the real task/journal.jsonl default; also verify a missing override does not fall back to an existing lane store. Follow the existing backend/renderSection contract for empty extracts; do not change that contract.
8. LM3: with a populated store, absent/false memory, true overridden by false, and true only in an unselected tier inject nothing and emit no memory-empty observation. An undeclared seat must not gain memory through the environment either.
9. Validation lane: `node --test crew/start.test.mjs`. The supplied gate independently imports `crew/lean.mjs` from process.cwd(), makes real isolated stores, captures only the first planner dispatch, and intentionally stops there. It must be red before implementation and green afterward. The loop executes baseline, built-tree, mutation and suite stages; do not run those stages as planner.

## Built-tree mutation anchors
10. Keep these literal executable anchors in `crew/lean.mjs` (the declarations target the implementation, not tests):
    - LM1: `const section = renderSection(extract)` -> `const section = ''` (populated memory disappears).
    - LM2: `await emit('memory-empty', { role, id, reason: extract.reason ?? 'empty' })` -> `await emit('memory-empty', { role, id, reason: 'lost-reason' })` (missing-store reason is lost).
    - LM3: `if (memory === true)` -> `if (true)` (undeclared planners gain memory).

## Scope and artifact references
Builder may edit only `crew/lean.mjs`, `crew/loop.mjs`, and `crew/start.test.mjs`.
Implementation: plan.md:3-7. Proof: plan.md:9-15. Mutation anchors: plan.md:17-21.
Return plan_path must remain the bare absolute artifact path, as required by the loop's artifact validation; the line citations above refer inside that artifact.
