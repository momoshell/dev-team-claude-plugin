---
name: runtime-boundaries
description: Zero runtime dependencies, plugin-relative paths, enforcement files are high-tier
metadata:
  type: feedback
---

Nothing under crew/ or scripts/ imports a package. Only the visualizer has build-time devDependencies, and a node suite module must never import one (CI has no node_modules). Plugin runtime code resolves its own files from import.meta.url, never from process.cwd(). Changes to enforcement paths owned by `PROTECTED` in `crew/loop.mjs` touch enforcement: keep them minimal and cite the ADR.
