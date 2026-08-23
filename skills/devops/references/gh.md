# GitHub CLI file and cwd discipline

Pass an absolute path to `--body-file` whenever `gh` reads a local body.
Status: this path rule is unbacked in the checkout; see `evidence.md`.

Never a relative path: resolve the file before constructing the argument list.
Status: this path rule is unbacked in the checkout; see `evidence.md`.

Write the body, invoke `gh`, then list the remote artifact and match its repo
and identity; listing the local file only proves a local write.
Status: the remote-confirmation step is unbacked in the checkout; see `evidence.md`.

For an issue, run `gh issue list --repo OWNER/REPO` and match its title or number;
for a pull request, use the corresponding remote listing before accepting.
Status: these create-and-list paths are unbacked here; see `evidence.md`.

A compound `cd` can change what a relative `--body-file` means.
Exhibit in kind: `skills/qa-test-writing/references/tooling.md:89`.

Use the process API's `cwd` option instead of embedding a shell `cd`.
Exhibit: `scripts/factory/intake.mjs:533-535`.

The intake helper supplies its repository root directly to `spawnSync`.
Exhibit: `scripts/factory/intake.mjs:533-535`.

Keep the binary seam injectable through `GH_BIN`.
Exhibit: `scripts/factory/probe-repo.mjs:739`.

A fake binary can then observe argv, cwd, and the body path without the network.
Exhibit: `scripts/factory/probe-repo.mjs:739`.

The pre-skill checkout has no local create or remote-list verification exhibit.
Register: `evidence.md` records the read-only query and seam boundaries.

Do not infer a successful write from exit status alone; list the remote artifact.
Status: this post-write rule is unbacked in the checkout; see `evidence.md`.

An empty body file is a write failure to diagnose, not a valid message.
Status: this failure-path rule is unbacked in the checkout; see `evidence.md`.

An interrupted command is neither a created issue nor a rejected request.
Status: this interrupted-path rule is unbacked in the checkout; see `evidence.md`.

If `gh` is unavailable, preserve that as unavailable rather than as API failure.
Exhibit: `scripts/factory/probe-repo.mjs:746`.

If the cwd is missing, refuse before asking the CLI to resolve relative data.
Exhibit: `scripts/factory/intake.mjs:533-535`.

Keep body-file construction and post-write confirmation in the same operation.
Status: the combined operation is unbacked in the checkout; see `evidence.md`.

The source exhibits cover explicit cwd, GH_BIN, and unavailable-tool handling, not remote creation.

The cost of a relative path is a silently missing or mislocated submission.
Exhibit in kind: `skills/qa-test-writing/references/tooling.md:89`.

The cost of an implicit cwd is a command that succeeds against the wrong repo.
Exhibit: `scripts/factory/intake.mjs:533-535`.
