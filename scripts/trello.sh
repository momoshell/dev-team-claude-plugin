#!/usr/bin/env bash
# Trello task-source helper for the dev-team plugin.
#
# Credentials are resolved internally (env → macOS Keychain → ~/.config/trello/credentials).
# The TOKEN is never printed on any code path. The auth header is passed to curl on stdin
# so secrets stay out of the process list. Callers must always go through this script
# rather than running curl/security directly, so the token never lands in the session
# transcript. Exception: `auth-url` necessarily embeds the KEY (the semi-public half —
# useless without the token) in the printed authorize URL; that's inherent to the OAuth
# handshake, not a leak.
set -euo pipefail

API="https://api.trello.com/1"
CRED_FILE="${TRELLO_CRED_FILE:-$HOME/.config/trello/credentials}"
KEYCHAIN_SERVICE="trello-api"

usage() {
  cat <<'EOF'
usage: trello.sh <command> [args]

  check                       validate credentials (prints the Trello username)
  auth-url                    print the one-click token-authorize URL for the stored key
  board <shortlink>           board name + url (shortlink = token after /b/ in the board URL)
  lists <shortlink>           lists on the board, one per line: <id>	<name>
  cards <shortlink>           all open cards on the board, one per line: <list-name>	<name>
  next-card <list-id>         top card of the list as JSON {id,name,url}, or the word EMPTY
  card <card-id>              full card JSON: name, desc, labels, due, checklists, comments
  move <card-id> <list-id>    move a card to a list
  comment <card-id> <text>    add a comment to a card

credentials (resolved in this order; the token is never printed, `auth-url` prints the key):
  1. TRELLO_KEY / TRELLO_TOKEN environment variables
  2. macOS Keychain:  security add-generic-password -s trello-api -a key   -w '<key>'
                      security add-generic-password -s trello-api -a token -w '<token>'
  3. KEY=... / TOKEN=... lines in ~/.config/trello/credentials (chmod 600)
EOF
}

err() { printf '%s\n' "$*" >&2; }

keychain_read() {
  [[ "${TRELLO_NO_KEYCHAIN:-}" == 1 ]] && return 0
  command -v security >/dev/null 2>&1 || return 0
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null || true
}

cred_file_read() {
  [[ -f "$CRED_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$CRED_FILE" | head -n 1
}

resolve_key() {
  KEY="${TRELLO_KEY:-$(keychain_read key)}"
  KEY="${KEY:-$(cred_file_read KEY)}"
}

setup_help() {
  err "No Trello credentials found (checked TRELLO_KEY/TRELLO_TOKEN, Keychain '$KEYCHAIN_SERVICE', $CRED_FILE)."
  err "One-time setup (run the 'security' commands in your own terminal, not in-session):"
  err "  1. Get an API key: https://trello.com/power-ups/admin → create a Power-Up → API key"
  err "  2. Store it:   security add-generic-password -s $KEYCHAIN_SERVICE -a key -w '<key>'"
  err "  3. Run '$(basename "$0") auth-url', open the URL, click Allow, copy the token"
  err "  4. Store it:   security add-generic-password -s $KEYCHAIN_SERVICE -a token -w '<token>'"
}

resolve_creds() {
  resolve_key
  TOKEN="${TRELLO_TOKEN:-$(keychain_read token)}"
  TOKEN="${TOKEN:-$(cred_file_read TOKEN)}"
  if [[ -z "$KEY" || -z "$TOKEN" ]]; then
    setup_help
    exit 2
  fi
}

# api <method> <path> [extra curl args...] — auth header via stdin config (-K -)
api() {
  local method="$1" path="$2"; shift 2
  local tmp status
  tmp="$(mktemp)"
  status="$(curl -sS -X "$method" -o "$tmp" -w '%{http_code}' -K - "$@" "$API$path" <<EOF
header = "Authorization: OAuth oauth_consumer_key=\"$KEY\", oauth_token=\"$TOKEN\""
EOF
)" || { rm -f "$tmp"; err "Trello API unreachable ($path)."; exit 1; }
  if [[ "$status" == "401" ]]; then
    rm -f "$tmp"
    err "Trello rejected the credentials (401) — the token may be expired or revoked."
    err "Regenerate: open the URL from '$(basename "$0") auth-url', click Allow, then update the stored token."
    exit 3
  fi
  if [[ "$status" != 2?? ]]; then
    err "Trello API error $status on $path:"
    cat "$tmp" >&2
    rm -f "$tmp"
    exit 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || { err "jq is required (it is already a plugin dependency)."; exit 1; }
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
  help | -h | --help)
    usage
    ;;
  auth-url)
    [[ $# -eq 0 ]] || { err "usage: trello.sh auth-url"; exit 2; }
    resolve_key
    if [[ -z "$KEY" ]]; then
      setup_help
      exit 2
    fi
    printf 'https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=dev-team&key=%s\n' "$KEY"
    ;;
  check)
    [[ $# -eq 0 ]] || { err "usage: trello.sh check"; exit 2; }
    resolve_creds
    require_jq
    api GET "/members/me?fields=username" | jq -r '"authenticated as " + .username'
    ;;
  board)
    [[ $# -eq 1 ]] || { err "usage: trello.sh board <shortlink>"; exit 2; }
    resolve_creds
    require_jq
    api GET "/boards/$1?fields=name,url" | jq -r '.name + "\t" + .url'
    ;;
  lists)
    [[ $# -eq 1 ]] || { err "usage: trello.sh lists <shortlink>"; exit 2; }
    resolve_creds
    require_jq
    api GET "/boards/$1/lists?fields=name" | jq -r '.[] | .id + "\t" + .name'
    ;;
  cards)
    [[ $# -eq 1 ]] || { err "usage: trello.sh cards <shortlink>"; exit 2; }
    resolve_creds
    require_jq
    cards_tmp="$(mktemp)"
    trap 'rm -f "$cards_tmp"' EXIT
    api GET "/boards/$1/cards?fields=name,idList" >"$cards_tmp"
    api GET "/boards/$1/lists?fields=name" |
      jq -r --slurpfile cards "$cards_tmp" '
        map({key: .id, value: .name}) | from_entries as $lists
        | $cards[0][] | ($lists[.idList] // .idList) + "\t" + .name'
    ;;
  next-card)
    [[ $# -eq 1 ]] || { err "usage: trello.sh next-card <list-id>"; exit 2; }
    resolve_creds
    require_jq
    api GET "/lists/$1/cards?fields=name,url" | jq -r 'if length == 0 then "EMPTY" else .[0] | tojson end'
    ;;
  card)
    [[ $# -eq 1 ]] || { err "usage: trello.sh card <card-id>"; exit 2; }
    resolve_creds
    require_jq
    api GET "/cards/$1?fields=name,desc,due,labels,url&checklists=all&checklist_fields=name&actions=commentCard&actions_limit=20" |
      jq '{id, name, desc, due, url,
           labels: [.labels[].name],
           checklists: [.checklists[] | {name, items: [.checkItems[] | {name, state}]}],
           comments: [.actions[] | {who: .memberCreator.username, text: .data.text}]}'
    ;;
  move)
    [[ $# -eq 2 ]] || { err "usage: trello.sh move <card-id> <list-id>"; exit 2; }
    resolve_creds
    require_jq
    api PUT "/cards/$1?idList=$2" | jq -r '"moved \"" + .name + "\""'
    ;;
  comment)
    [[ $# -eq 2 ]] || { err "usage: trello.sh comment <card-id> <text>"; exit 2; }
    resolve_creds
    require_jq
    api POST "/cards/$1/actions/comments" --data-urlencode "text=$2" | jq -r '"commented on \"" + .data.card.name + "\""'
    ;;
  '')
    usage
    exit 2
    ;;
  *)
    err "unknown command: $cmd"
    usage >&2
    exit 2
    ;;
esac
