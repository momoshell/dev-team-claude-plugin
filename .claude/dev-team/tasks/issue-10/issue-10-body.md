**End of Phase 3, via dev-team:doc-writer. One PR** (`docs: … ; bump 0.1.NN`).

**Source material: the comments on epic #15** carry the complete design record verbatim (design ledger · plugin-internals digest · package v1 · both v1 reviews · package v2 · v2 re-review · v2.1 final amendment). Nothing depends on local files.

## Deliverables

1. **`docs/trd-cmux-execution-mode.md`** — the TRD assembled from package v2 + the v2.1 amendment (epic comments 6 and 8; v2 §3 incorporates v1 §3.1–3.3 by reference — pull those from comment 3).

2. **`RECREATION-SPEC.md`** — one new section, "Execution substrate: Agent-tool vs. pane adapters," framed as an **optional layer** so the spec stays harness-agnostic: roster (role → agent/model/profile), adapter contract (capabilities + run <record>; always a return file + exactly one signal), file data plane / socket control plane, the four-rank completion ladder, workspace-per-task lifecycle.

3. **`.claude/dev-team/memory/architecture-notes.md`** — commit the eleven ADRs (full texts in the epic-#15 comments; summaries):
   - **ADR-001** Custom cmux adapter; `cmux claude-teams` rejected (experimental tmux shim, Claude-only, partial verb coverage — can't carry a roster, permission model, or return contract).
   - **ADR-002** Filesystem = data plane; socket = control/signaling only; structured returns are the contract in both directions — the orchestrator branches on enums, never prose.
   - **ADR-003** Completion = four-rank ladder (file watch · events-as-rescan-only · EXIT sentinel+token · bounded Stop-gate for contract enforcement); events can wake a join but never close one; agent self-signal dropped.
   - **ADR-004** Role-station panes: the return file IS the doc tab (viewing surface; approval happens in the orchestrator pane); UUIDs only; focus-don't-close; tmp+rename never rm.
   - **ADR-005** Security: default cmuxOnly socket, orchestrator-inside-cmux enforced by the identify preflight, allowlist-shaped worker profiles under dontAsk with one scoped return grant, workers denied all cmux, no bypass modes ever; for pane dispatches the profile REPLACES frontmatter tool policy.
   - **ADR-006** roster.json committed; tasks/ gitignored via self-contained tasks/.gitignore; additive optional schema fields don't bump version.
   - **ADR-007** Workflow mode stays on the Workflow tool's agent() dispatch — "never the Agent tool" is scoped to conversational dispatch.
   - **ADR-008** cmux is an environment prerequisite (like git): preflight failure = precise remediation + hard stop, never silent substrate swap; `execution_mode: cmux | agent-tool`.
   - **ADR-009** Pane system prefixes are byte-stable per role (static role file + static addendum + static worker plugin); per-dispatch payload = expanded literals in the first user message; env vars serve shell-side consumers only.
   - **ADR-010** Machine-readable verdicts at both ends of the pipe: reviewer markdown carries a fenced {verdict, findings[{severity,file,line,summary}]} block, shape-validated only; the gate branches on the enum.
   - **ADR-011** One shared noise-glob definition applied at read points only (bundle, diff view, handover guidance); never at the git scope check; never to a files_in_scope path; every filtered bundle names what it excluded.

4. **`.claude/dev-team/memory/conventions.md`** — the 15 cmux-mode conventions (full texts in the epic comments), including: dispatch only via dispatch.mjs · read-screen is diagnostics only · single-source role prompts (substrate addenda under scripts/, never forks) · one reference file per subsystem · persist UUIDs never positional refs · UI-backing files tmp+rename never delete-recreate · worker profiles allowlist-shaped under a non-prompting mode · hooks own their loop bounds (never rely on stop_hook_active) · prerequisites fail loudly with remediation · byte-stable pane prefixes · enforcement models don't merge · a doorbell that can't name the sleeper only wakes, never decides · filters apply to what humans read, never to what checks verify.

Memory commits follow the existing ship convention (separate `chore: reconcile dev-team memory deltas` commit).
