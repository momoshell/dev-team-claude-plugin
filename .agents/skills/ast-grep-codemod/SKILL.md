---
name: ast-grep-codemod
description: Rewrite code structurally with ast-grep metavariable patterns, staged as a proposal and applied only on an explicit resolve-with-reason.
---

# ast-grep codemod

Structural rewrites via metavariable patterns, in two steps. The mechanical
repeat carries its own accept gate: nothing is written until a human resolves
the staged proposal with a reason.

1. Propose (writes nothing to the tree):
   `node .agents/skills/ast-grep-codemod/scripts/codemod.mjs propose --pattern '<p>' --rewrite '<r>' [--lang js] [paths...]`
   Prints the hit count and diff and stages the proposal at `$CODEMOD_STAGE`
   (default `.agents/skills/ast-grep-codemod/.stage/proposal.json`). A
   zero-match proposal is a valid, successful proposal.
2. Apply, only with a reason:
   `node .agents/skills/ast-grep-codemod/scripts/codemod.mjs apply --resolve '<why this rewrite is right>'`
   Without `--resolve`, or with an empty reason, it refuses (exit 2) before it
   looks at the tree or runs the binary at all. It also refuses a stale stage —
   one whose recorded pattern/rewrite/paths no longer match what is staged.

Patterns are ast-grep metavariable patterns (`$A`, `$$$ARGS`), never regexes:
`console.log($A)` → `logger.debug($A)` rewrites the call, not the text.

The binary is a seam: `$AST_GREP_BIN` (default `ast-grep`, falling back to
`sg`). A `$AST_GREP_BIN` ending in `.mjs` is run with the current node
executable — that is how the offline test fixture is wired. When no binary
resolves, every verb exits 3 with install remediation and changes nothing.

## Verifying on a seat

- pi: `pi --print --skill .agents/skills/ast-grep-codemod -- 'list your available skills'`
  (pi 0.84.2 reads `<cwd>/.agents/skills`; crew's pi transport boots seats with
  `--no-skills` today, so pass the flag to see it).
- claude: `claude -p 'list your available skills'` — claude 2.1.233 reads
  `.claude/skills` only and never `.agents/`, so this skill is expected to be
  absent there on this build.
