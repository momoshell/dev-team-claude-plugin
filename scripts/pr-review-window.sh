#!/usr/bin/env bash
# pr-review-window.sh — gh-dash → new Ghostty window → worktrunk PR worktree → claude /dev-team:pr-review
#
# Stage 1 (the gh-dash keybinding calls this):
#   pr-review-window.sh open <repo-path> <owner/repo> <pr-number>
#   Spawns a new Ghostty window running stage 2 and returns immediately, so gh-dash stays up.
#   <repo-path> may be empty/unresolved — stage 2 discovers the checkout itself.
#
# Stage 2 (runs inside the new window):
#   pr-review-window.sh run <repo-path> <owner/repo> <pr-number>
#   Resolves the local checkout (gh-dash repoPaths value → cache → scan of the search
#   roots → offer to clone), checks the PR out into its own worktree (wt switch pr:N),
#   runs claude's /dev-team:pr-review on it, and removes the worktree when the session
#   ends or the window closes. Removal never uses --force: a worktree with uncommitted
#   changes is kept and reported, not destroyed.
#
# Extra:
#   pr-review-window.sh discover <owner/repo>
#   Prints the resolved local checkout path (same logic stage 2 uses). Handy for debugging.
#
# Discovery roots default to ~/Development and ~/Work; override with a space-separated
# PR_REVIEW_SEARCH_ROOTS. Hits are cached in ~/.claude/dev-team/repo-paths.cache and
# re-validated against the remote on every use, so a moved checkout just triggers a rescan.
#
# Requires: worktrunk (wt), claude, gh (used by wt for pr:N and for cloning), Ghostty (macOS).
set -euo pipefail

CACHE_FILE="$HOME/.claude/dev-team/repo-paths.cache"
SEARCH_ROOTS="${PR_REVIEW_SEARCH_ROOTS:-$HOME/Development $HOME/Work}"

usage() {
  echo "usage: $(basename "$0") open|run <repo-path> <owner/repo> <pr-number>" >&2
  echo "       $(basename "$0") discover <owner/repo>" >&2
  exit 2
}

# Does this directory's origin point at the slug? (matches ssh + https, with/without .git)
remote_matches() { # <dir> <owner/repo>
  local url slug_re
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  slug_re=$(printf '%s' "$2" | sed 's/[.[\*^$+?(){}|]/\\&/g')
  printf '%s' "$url" | grep -qE "[:/]${slug_re}(\.git)?/?$"
}

cache_put() { # <owner/repo> <dir>
  mkdir -p "$(dirname "$CACHE_FILE")"
  { [ -f "$CACHE_FILE" ] && awk -F'\t' -v s="$1" '$1 != s' "$CACHE_FILE"; printf '%s\t%s\n' "$1" "$2"; } \
    > "$CACHE_FILE.tmp" && mv "$CACHE_FILE.tmp" "$CACHE_FILE"
}

discover_repo_path() { # <owner/repo> → prints path, rc 1 if not found
  local slug=$1 hit root gitdir dir
  # 1. cache, re-validated (checkout may have moved or been re-pointed)
  if [ -f "$CACHE_FILE" ]; then
    hit=$(awk -F'\t' -v s="$slug" '$1 == s { print $2; exit }' "$CACHE_FILE")
    if [ -n "$hit" ] && [ -d "$hit" ] && remote_matches "$hit" "$slug"; then
      printf '%s\n' "$hit"
      return 0
    fi
  fi
  # 2. scan the roots. Linked worktrees have a .git *file*, so `-type d` naturally
  #    skips them and only finds primary checkouts.
  echo "searching for a local checkout of $slug ..." >&2
  for root in $SEARCH_ROOTS; do
    [ -d "$root" ] || continue
    while IFS= read -r gitdir; do
      dir=${gitdir%/.git}
      if remote_matches "$dir" "$slug"; then
        cache_put "$slug" "$dir"
        printf '%s\n' "$dir"
        return 0
      fi
    done < <(find "$root" -maxdepth 4 -type d -name .git -not -path '*/node_modules/*' 2>/dev/null)
  done
  return 1
}

case ${1:-} in
  discover)
    [ $# -eq 2 ] || usage
    discover_repo_path "$2" || { echo "no local checkout of $2 under: $SEARCH_ROOTS" >&2; exit 1; }
    exit 0
    ;;
esac

[ $# -eq 4 ] || usage
stage=$1
repo_path=${2/#\~/$HOME}
repo=$3
pr=$4

# gh-dash renders a missing RepoPath as the literal "<no value>" (via {{index . "RepoPath"}}
# under missingkey=error) — normalize it to empty; stage 2's discovery takes over.
[ "$repo_path" = "<no value>" ] && repo_path=""

case $stage in
  open)
    # Don't resolve the path here — stage 1 blocks the gh-dash TUI, so anything slow
    # (the discovery scan, a clone prompt) belongs in the window, not here.
    # --window-save-state=never: without it, macOS state restoration resurrects the
    # previous launcher instance's window as an extra empty tab next to the -e one.
    exec open -na Ghostty --args --window-save-state=never \
      --title="pr-review #$pr — $repo" \
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

# Resolve the checkout: explicit path from gh-dash repoPaths wins; otherwise discover.
if [ -z "$repo_path" ] || [ ! -d "$repo_path" ]; then
  if ! repo_path=$(discover_repo_path "$repo"); then
    root=${SEARCH_ROOTS%% *}
    echo "no local checkout of $repo found under: $SEARCH_ROOTS" >&2
    read -r -p "clone it into $root/$(basename "$repo")? [y/N] " ans || ans=""
    case $ans in
      [Yy]*)
        repo_path="$root/$(basename "$repo")"
        gh repo clone "$repo" "$repo_path" || { hold "error: clone failed"; exit 1; }
        cache_put "$repo" "$repo_path"
        ;;
      *) exit 0 ;;
    esac
  fi
fi
echo "using checkout: $repo_path" >&2

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
