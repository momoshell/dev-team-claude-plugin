# Team memory (read before any write to a memory file)

Three tiers: live files, archive files, git history. You are the single writer — leads only propose.

## Layout

- **Project memory (most of it):** `<project-root>/.claude/dev-team/memory/` — `conventions.md` (shared cross-cutting truth), `{frontend,backend,devops,qa}-notes.md` (domain-local), `architecture-notes.md` (ADR log). Resolve `<project-root>` as the repo/cwd root and pass the **absolute** project `<memory-dir>` to each lead on spawn (they append only the filename — never a second `dev-team/` segment). **Leads read only these live files — never an `*.archive.md` file** (below); the archive exists specifically so it costs nothing per spawn.
- **Global memory (sparse, cross-project):** `~/.claude/dev-team/memory/conventions.md` — durable preferences/conventions that hold across *all* projects. Pass this path too; leads read it as low-priority background.
- **Bootstrap:** if a `<memory-dir>` doesn't exist, create it + the files on the **first** commit there. Leads treat a missing file as an empty cache, not an error.

## Precedence & reconcile

- **Precedence: code > project memory > global memory.** A project convention overrides a global one; code overrides both. Mark contradicted entries `deprecated` (use `supersedes`) — see the archive step below for what happens to them next.
- **Single writer = you, strictly sequential.** Leads only **propose** deltas in their output; you reconcile and commit. **Never issue parallel `Edit`/`Write` to memory files** — one file at a time, read-modify-write, to avoid corruption.
- **Reconcile rule:** on conflicting deltas, the domain that owns the file/decision wins; for cross-cutting `conventions.md`, the architecture-lead's proposal wins, else surface the conflict to the user.

## Size triggers (real numbers, not vibes)

- Soft target ~150 lines per live file. **Hard trigger at ~300 lines** (check with `wc -l` right after writing a delta — cheap, no window): move every `deprecated` entry out of the live file into `<same-name>.archive.md` in the same memory-dir, in the same write. Leads never read the archive file, so this is a pure win — the live cache shrinks, nothing is lost.
- Also check the **combined** total a lead actually reads (`conventions.md` + its domain notes + global `conventions.md`) — several files each just under 300 lines still adds up to real per-spawn cost; if the combined total exceeds ~500 lines, prune harder even if no single file tripped its own trigger.

## Archive GC (git-gated deletion)

The archive is not "never delete" forever — it's git-gated deletion. An archive file is disk, not context (leads don't read it), so it's fine for it to grow *slowly* — but not unboundedly. When `<file>.archive.md` itself exceeds ~500 lines: check `git -C <project-root> log --oneline -- <memory-dir>/<file>.archive.md`. If that returns **at least one prior commit**, the content is already recoverable from git history — trim the **oldest** entries (top of the file; archive entries are appended chronologically, so this is a plain FIFO trim, no judgment call) back down to ~250 lines, and let the memory-delta commit capture the trim itself. If the archive file has **never been committed** (fresh write, or the project doesn't track `.claude/`), skip the trim this round — deleting content whose only copy is the uncommitted working tree would be the exact data loss "never delete" was protecting against. It'll become trimmable the next cycle once a commit exists.

**Memory deltas must actually reach git for the rule above to ever apply.** `/dev-team:ship` commits reconciled memory deltas (including any archive/trim from this pass) **before** the push, not after — see `ship.md`. An uncommitted memory file is invisible to `git log`, which would permanently block the archive-GC step from ever running.
