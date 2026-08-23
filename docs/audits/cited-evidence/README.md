# Evidence that shipped prose cites

Two earlier scout registers are cited by **shipped** skill content — `skills/`
travels to every plugin consumer, and both were cited by an absolute path on one
laptop (audit finding, issue #549: 11 such sites in 6 files).

| register | cited by | what only it holds |
|---|---|---|
| `scout-b151-viztokens/` | 10 sites across `skills/ui-design/` and `skills/frontend-svelte/` | the measured token census behind the UI contract; most of its conclusions are restated in-tree against `visualizer/web/src/lib/theme.css`, so the citations are replaceable |
| `scout-b152-reviewmine/` | `skills/pr-review/references/evidence.md:8` | **the F0–F28 review-outcome rates and their denominators exist nowhere else** — they were mined from the ledger and `gh` holds no equivalent corpus. This is the one citation #549 cannot simply repoint at in-repo code |

They are committed here so #549 can be fixed honestly: repoint each citation at
in-repo sources where they exist, and at this directory where they do not,
rather than deleting a claim because its evidence was unreachable.

Everything else under `~/.dev-team/factory/preserved/` is lane material from
earlier sessions — working state, not cited by shipped content, and deliberately
not committed.
