# Choosing an affected-only lane suite

Use this guide while onboarding a checkout whose full suite is slow enough to
matter. The project's script owns dependency selection; the plugin cannot infer
it across toolchains. Do not change this plugin repository's suite for this
purpose, or another project's configuration from this checkout.

## Offer it only with full CI

Time the full suite on a clean tree. Record the command, elapsed time and result;
do not infer savings from test counts. Confirm that CI runs the full suite on
every pull request. Without that CI, keep the lane suite full. Propose the script
and measured trials to the operator, and get approval before onboarding it.
A project that keeps its current command changes nothing.

Keep the three levels separate:

- Proof runs the exact named tests on old source and build, as it already does.
- The lane suite may select affected crates or packages and their transitive
  dependents. Do not narrow the suite to individual modules or files; proof
  already does exact-test selection.
- CI runs everything on every PR, including checks the lane selector might miss.

Keep `builderChecks` narrower than the suite: touched code or one package, not
workspace-wide checks. They do not replace the suite gate.

## Read the lane change from Git

On the first lane or finish suite invocation, the change is uncommitted over the
base commit at `HEAD`. Pre-check base moves and build, judge and finish
publishing-rebase rechecks soft-reset to the new base before checks too. No lane
commits sit above that base at suite time. The loop stages measured lane paths,
but the script must account for staged, unstaged and nonignored untracked paths.

There is one exception: a mechanical publishing-rebase recheck runs on the clean,
committed rebased head. A clean tree must run everything. That fallback also
makes onboarding and hand runs safe when there is no lane change.

From the checkout root, union tracked changes against `HEAD` with nonignored
untracked paths. For example, read `git diff --name-status -z HEAD --` and
`git ls-files --others --exclude-standard -z`. Parse NUL-delimited records, not
lines or whitespace: paths can contain spaces and newlines. Name-status records
have status fields and, for renames, two paths. Consider both sides of a rename
and the former package of a deletion; if either cannot be mapped safely, run
fully. Do not use only `git diff` without `HEAD` (it misses staged changes),
compare branches, or expect a base or changed-path environment variable.

## Select conservatively

Map each changed path to its owning crate or package. Select the union of those
owners and everything that depends on them, transitively, using the project's
actual dependency graph. Include cross-language dependents where the project has
them. If the mapping or graph cannot be established, run everything.

Run everything for a clean tree, or when any shared input changes:

- Lockfiles and root or workspace manifests.
- Toolchain, runner and CI configuration.
- Migrations and shared fixtures.
- The suite script itself and `.crew/project.json`.
- Any unknown path or path that cannot be mapped to a crate or package.

A package-local manifest must update the graph or trigger a full run if the
script cannot establish its effects. Do not silently ignore documentation or
other paths unless the project has an explicit safe mapping; unknown means full.

Print the changed paths, selected crates or packages and selection reason, or
`full: <reason>`, before running checks. These diagnostics let a caller inspect
scope. They are not guaranteed to survive a green lane run: current green checks
keep only bounded journal tails and save no full-output artifact. Non-green
checks save captured output within the runner's output limit. Record trial
output separately when presenting the script for approval. The plugin's commit
and PR suite lines name the configured command, not a claim of full coverage.

## Check the installed tool

Read the installed tool's own help before choosing flags; do not use flags from
memory. A runner selecting dependencies is not necessarily selecting reverse
(transitive dependent) packages.

- **Cargo:** inspect `cargo metadata --help` for the workspace graph and
  `cargo test --help` or `cargo nextest run --help` for the runner actually used.
  Compute reverse dependencies before choosing packages. Preserve the project's
  feature, target and doctest policy; if those cannot be scoped safely, run fully.
- **npm or pnpm workspaces:** inspect `npm help run-script` and `npm help
  workspaces`, or `pnpm --help` and `pnpm --filter --help`, on the installed
  version. Confirm whether filters include dependents, their transitive closure
  and the selected package itself. Preserve required build and setup steps.
- **Python:** there is no universal package-dependency selector. Inspect the
  installed runner's help (for example, `python -m pytest --help`) and the
  project's manifests and import/test layout. Establish a project-specific
  dependency-to-test mapping that includes dependents. File paths or `-k` alone
  do not prove that mapping. If the graph is unknown, keep the full suite.

## Trial runs before approval

Use a disposable checkout and restore each trial before the next. Save command,
scope diagnostics, result and elapsed time for each of these four runs:

1. Clean tree: runs everything. This is also the onboarding behavior.
2. One-file change in a leaf crate or package: runs a subset that includes it.
3. Change in a crate or package others depend on: includes all transitive
   dependents, not just the owner or direct consumers.
4. Lockfile change: runs everything.

Compare with the measured full run, and state any unmeasured savings rather than
guessing. Present the script, scope rules, CI confirmation and timings for
operator approval. Configure `suite` as a whitespace-split executable and
arguments, such as `sh tools/crew-suite.sh`; put shell logic inside the script,
not the command field. Follow the remaining steps in `skills/crew-onboard/SKILL.md`
to calibrate and commit onboarding. Changing `suite` requires onboarding again.
