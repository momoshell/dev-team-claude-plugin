# crew

**A team runtime: agents do the work, code keeps it correct.**

One brief goes in; a lean lane comes out. `crew start <brief.md>` makes a
worktree and a journal, then plays four seats over ACP: a **planner** explores
the code and writes the plan and an acceptance gate, a **builder** edits the
repo, a **reviewer** gives a verdict, and a **lead** answers escalations with
one closed decision. Code only checks the result: the gate is red at baseline
and green after the build, each gate check has a mutation that kills it, the
full suite is green, and commit, rebase and PR happen only on green. A stopped
lane is picked up again with `crew finish`. Every seat's full session is
recorded, so any lane can be inspected afterwards, and the visualizer reads
those journals and session files.

The design is [ADR-052](docs/adr/adr-052-agents-do-the-work.md) and
[`docs/plan-lean-runtime.md`](docs/plan-lean-runtime.md).

**→ [crew/README.md](crew/README.md)** for the loop, the seats, the contracts
and where each piece lives.

```bash
crew start /abs/path/brief.md          # worktree + journal + a detached lane
crew lanes                              # list lanes from their journals
crew show <lane> [<role>]               # read a seat's recorded session
crew finish <lane>                      # finish a stopped lane; stops committed and rebased
crew finish <lane> --accept | --return <file> | --abandon
crew record-pr <lane> --pr <url>        # record a PR you finished by hand
crew closeout <lane>                    # remove a merged lane's worktree and branch
crew viz                                # serve the visualizer
crew where | crew update                # the crew home; fast-forward it
```

From a clone without the launcher, run the same verbs as `node bin/crew.mjs <verb>`.

## Install

```
/plugin marketplace add momoshell/dev-team-claude-plugin
/plugin install dev-team@dev-team
```

This brings the skills and the `/dispatch`, `/close-out`, `/status`,
`/onboard` and `/review` commands into any project. An installed copy is a
snapshot of the commit at install or update time; it moves only on a plugin
update, not with each push. `ref: main` in `.claude-plugin/marketplace.json`
names what an update fetches, not a tag. A link-mode install is the
exception: link mode loads the plugin in place so it does follow its source
directory, but link mode refuses a top-level entry that is a symlink pointing
outside the plugin directory.

There are two ways to use it:

- **Skills only.** Nothing else to set up. The knowledge skills (`pr-review`,
  `qa-test-writing`, `backend-node`, `frontend-svelte`, `ui-design`, `devops`, `ux`, `code-less`, `prose-plain`)
  work in any repo. Most repos stop here. The plugin registers no hooks.
- **The crew runtime.** Lanes need one clone of this repo, node 26 or newer
  (`engines` in `package.json`), and a crew root (`~/.crew`, or
  `DEVTEAM_CREW_ROOT`). Run the runtime from the clone and point it at the
  target with `--checkout`. Seats run over ACP; no terminal
  multiplexer is needed.

You do not need the operator's pinned worktree or a `crew` launcher on your
PATH (`bin/crew.mjs`). Both are the operator's own setup for running lanes from
a frozen copy. A clone run with `node bin/crew.mjs` is enough.

An optional operator setup keeps a stable worktree at ~/Dev/dev-team-stable installed user-scope through a local link-mode marketplace, with ~/.local/bin/crew linked to its bin/crew.mjs; `crew update`, which fast-forwards that home to origin/main, rebuilds what changed, and refuses unless it is on branch stable and clean and, without --force, runs no process.

[`skills/crew-onboard/`](skills/crew-onboard/SKILL.md) covers the rest:
deciding what a target can use, and profiling and ratifying a foreign checkout
before its first lane.

## What's in this repo

- **`crew/`** — the runtime: `start.mjs` (lane start), `lean.mjs` and
  `loop.mjs` (the loop), `checks.mjs` (gate, mutation proof, suite, commit,
  PR), `agents.mjs` and `protocols.mjs` (seat definitions and the closed
  protocols), `acp/` and `acp-client.mjs` (the ACP seat transport), and the
  verbs `show`, `finish`, `record-pr`, `closeout` and `lanes`. Seat definitions
  are in `crew/agents/`; charters are in `crew/roles/`.
- **`skills/`, `commands/`** — the operating knowledge as Claude Code surfaces.
  The knowledge skills (`pr-review`, `qa-test-writing`, `backend-node`,
  `frontend-svelte`, `ui-design`, `devops`, `ux`, `code-less`, `prose-plain`)
  work in any repo the moment the plugin is installed; the runtime skills
  (`lane-brief`, `crew-recovery`) drive the crew CLI and need
  this source tree. `crew-onboard` owns the split and the foreign-checkout
  procedure. Commands are thin entry points that name the skill owning each
  procedure: `/dispatch`, `/close-out`, `/status`, `/onboard`, `/review`.
- **`bin/crew.mjs`** — the crew launcher: start, show, record-pr, finish,
  closeout, lanes, viz, where, update.
- **`hooks/`** — the skill-map selector (`hooks/skill-gate.mjs`); the plugin
  registers no hook.
- **`visualizer/`** — the local visualizer over lane journals (see Visualizer
  below).
- **`docs/`** — the live design record: [`docs/adr/`](docs/adr/) is the
  architecture decision register (**grep it before minting an ADR number**);
  [`docs/decisions-needed.md`](docs/decisions-needed.md) is the open
  owner-decision register; [`docs/conventions.md`](docs/conventions.md) the
  cross-cutting conventions. `docs/archive/` holds design records of the
  retired driver.
  [`CLAUDE.md`](CLAUDE.md) is the operating brief a session should read first —
  it carries only the rules that are expensive to rediscover and points at
  everything else.

## Versioning

**Bump on release, not per commit.** Earlier history bumped
`.claude-plugin/plugin.json` on essentially every feature commit; with several
crews landing multi-file features in a day, that convention stopped paying for
itself and was missed five times in two days (#137). Feature commits no longer
carry a `; bump x.y.z` subject suffix.

What is enforced instead is the thing that actually shipped wrong metadata:
`plugin.json` and `.claude-plugin/marketplace.json` must always agree.
`test/version-agreement.test.mjs` asserts it, so it fails in the same
`node --test` run that gates every crew commit — bump both files or neither.

## Visualizer

The local visualizer reads its Artificial Analysis catalog key from
the process environment. To keep it across restarts without committing it,
copy `.env.example` to `.env.local`, set `ARTIFICIAL_ANALYSIS_API_KEY`, then
start the server normally:

```bash
cp .env.example .env.local
npm run viz:build
npm run viz:serve
```

`.env.local` and other environment files are ignored by Git; `.env.example`
is the only committed template. The roster UI can save or replace this one
variable in `.env.local`, or connect with a temporary key for the current
server process. Clearing a temporary key restores the saved environment key.
