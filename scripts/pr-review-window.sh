#!/usr/bin/env bash
# pr-review-window.sh — gh-dash → new Ghostty window → worktrunk PR worktree → claude /dev-team:pr-review
#
# Stage 1 (the gh-dash keybinding calls this):
#   pr-review-window.sh open <repo-path> <owner/repo> <pr-number>
#   Spawns a new Ghostty window running stage 2 and returns immediately, so gh-dash stays up.
#
# Stage 2 (runs inside the new window):
#   pr-review-window.sh run <repo-path> <owner/repo> <pr-number>
#   Checks the PR out into its own worktree (wt switch pr:N), runs claude's
#   /dev-team:pr-review on it, and removes the worktree when the session ends or the
#   window closes. Removal never uses --force: a worktree with uncommitted changes is
#   kept and reported, not destroyed.
#
# Requires: worktrunk (wt), claude, gh (used by wt for pr:N), Ghostty (macOS).
set -euo pipefail

usage() { echo "usage: $(basename "$0") open|run <repo-path> <owner/repo> <pr-number>" >&2; exit 2; }

[ $# -eq 4 ] || usage
stage=$1
repo_path=${2/#\~/$HOME}
repo=$3
pr=$4

# gh-dash renders a missing RepoPath as the literal "<no value>" (via {{index . "RepoPath"}}
# under missingkey=error) — normalize it to empty so the error message stays clean.
[ "$repo_path" = "<no value>" ] && repo_path=""

case $stage in
  open)
    if [ -z "$repo_path" ] || [ ! -d "$repo_path" ]; then
      echo "error: no local checkout for $repo (got: '${2:-}') — add a repoPaths mapping in ~/.config/gh-dash/config.yml" >&2
      exit 1
    fi
    exec open -na Ghostty --args --title="pr-review #$pr — $repo" \
      -e "${BASH_SOURCE[0]}" run "$repo_path" "$repo" "$pr"
    ;;
  run) ;;
  *) usage ;;
esac

# ---------- stage 2: inside the Ghostty window ----------

hold() { # surface an error and keep the window open long enough to read it
  echo "" >&2
  echo "$*" >&2
  read -r -p "press enter to close " || true
}

command -v wt >/dev/null 2>&1 || { hold "error: worktrunk (wt) not on PATH"; exit 1; }
command -v claude >/dev/null 2>&1 || { hold "error: claude not on PATH"; exit 1; }

cd "$repo_path"

# wt's shell integration normally handles the cd; a script has to ask for the directive
# file explicitly and follow it by hand.
cd_file=$(mktemp)
if ! WORKTRUNK_DIRECTIVE_CD_FILE="$cd_file" wt switch "pr:$pr" --yes; then
  rm -f "$cd_file"
  hold "error: wt switch pr:$pr failed (branch already checked out elsewhere? PR closed?)"
  exit 1
fi
wt_dir=$(<"$cd_file")
rm -f "$cd_file"
if [ ! -d "$wt_dir" ]; then
  hold "error: wt did not report a worktree path"
  exit 1
fi

cleanup() {
  cd "$repo_path" || return
  # No --force: wt refuses to remove a dirty worktree, so uncommitted work survives a
  # window close. Merged branches are deleted by wt; unmerged ones are kept locally.
  if ! wt remove "$wt_dir" --yes --foreground; then
    hold "worktree kept (uncommitted changes?): $wt_dir — inspect and remove with: wt remove $wt_dir"
  fi
}
# Route signals through exit so cleanup runs exactly once, including on window close (HUP).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

cd "$wt_dir"
claude "/dev-team:pr-review https://github.com/$repo/pull/$pr"
