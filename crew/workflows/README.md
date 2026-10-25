# Workflow seat maps

A named workflow assigns existing runtime roles to model-bearing stages. The stage sequence remains owned by `crew/variants.mjs` and its executor. The visualizer's Workflows page edits assignments for all nine implemented shapes; runtime-only checks and delivery steps have no model selectors.

Choose a workflow and assurance, select a stage, edit its harness/provider/model/effort, then save locally. Files are independent per assurance, such as `scout-standard.json` and `review-panel-rigorous.json`. Names use hyphens; native shape identifiers such as `review_panel` retain underscores. Saved maps do not change the roster or active tasks.

For example, add `--workflow scout-standard --assurance standard` to a Crew boot, then `--execution scout` to the run command. A new named boot records the workflow shape and refuses a different run execution. Other booted tier roles retain their roster assignments. Review panel requires reviewer, tech-lead and lead; the current roster seats all three under Rigorous. The editor explains missing roles and offers compatible presets without silently adding seats.

## Native format

Singleton stage entries keep the existing format:

```json
{
  "shape": "scout",
  "seats": {
    "scout": {
      "role": "planner",
      "agent": "pi",
      "provider": "openai",
      "id": "gpt-6.1-sol",
      "effort": "high",
      "skills": [],
      "extensions": []
    }
  }
}
```

The multi-role `review_panel` stage stores an array of those same native cells under `seats.review_panel`: one each for reviewer, tech-lead and lead. This extension requires a runtime with multi-role map support; older singleton maps remain valid. All panel assignments are saved together. Changing one role does not alter the others.

Export JSON downloads this native representation. **Saved preset** lists local named files; choose one to edit it. **Duplicate preset** creates an independent copy. **Import JSON** accepts a file or pasted native map, validates it against the selected assurance, and previews stage/role/field changes before saving. Existing destinations are explicitly marked as replacements. Changed files or policy revisions require a fresh preview. Built-in names are reserved; use a new lowercase hyphenated name. Imported files never start execution.

On **Tasks → New task**, select a saved workflow and a compatible assurance, then save the title and brief locally. Task preparations live under the configured Crew root in `prepared-tasks/<id>/`, separate from execution history. Launch details provide shell-quoted boot and run commands. Boot includes `--workflow-revision <sha256>` and rejects a changed preset before using its assignments; run selects the matching execution shape. The browser does not start agents. Current runtime checks, including checkout cleanliness and harness readiness, still apply.

Review workflows require full base/head commit IDs before launch commands can be generated. Directed workflows require a validation command. Repair and Finish need inherited task context: their briefs can be saved, but they must be resumed from the existing task through the CLI. Preparations do not track execution status.

Save refuses malformed stage maps, missing or duplicate required roles, unconfigured models, unsupported harness/provider pairs, ungranted requirements and stale file or policy revisions. It preserves the draft on failure. Export it before reloading if needed. Revert changes restores the loaded snapshot after confirmation. Changing a primary model, provider or harness drops that role's old roster fallback chain; changing only effort retains it. Grants and instructions remain runtime-managed.
