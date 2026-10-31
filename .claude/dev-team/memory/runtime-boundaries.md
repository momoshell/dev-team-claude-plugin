---
name: runtime-boundaries
description: Zero runtime dependencies, plugin-relative paths, enforcement files are high-tier
metadata:
  type: feedback
---

Nothing under crew/ or scripts/ imports a package. Only the visualizer has build-time devDependencies, and a node suite module must never import one (CI has no node_modules). Resolve plugin files from import.meta.url, never from process.cwd(). Changes to crew/loop.mjs, crew/checks.mjs, crew/acp/grants.mjs, hooks/ or docs/adr/ touch enforcement: keep them minimal and cite the ADR.
