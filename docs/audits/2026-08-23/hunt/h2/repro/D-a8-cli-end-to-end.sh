#!/bin/sh
# A8: the same two escapes through the make-brief CLI (exit code 0, brief written).
set -e
REPO=$(mktemp -d)/repo
SECRET=$(mktemp -d)
printf "const t = 'ghp-9f2c1a-live-token'\nexport const readToken = () => t\n" > "$SECRET/creds.mjs"
mkdir -p "$REPO/crew" "$REPO/lib" "$REPO/docs/adr"
printf 'export function scopeMatcher() { return 1 }\n' > "$REPO/crew/drive.mjs"
printf '# adr\n' > "$REPO/docs/adr/0001-shape.md"
printf 'export function widget() { return 1 }\n' > "$REPO/lib/widget.mjs"
ln -s "$SECRET/creds.mjs" "$REPO/lib/outside.mjs"
( cd "$REPO" && git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm b >/dev/null )
BRIEF=/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/scripts/factory/make-brief.mjs

echo "### 1. where = a symlink pointing OUTSIDE the checkout"
printf '{"ask":"rename the widget helper","where":["lib/outside.mjs"],"done_means":"green","out_of_scope":"nothing"}\n' > "$REPO/req1.json"
node "$BRIEF" --request "$REPO/req1.json" --checkout "$REPO" --out "$REPO/b1.md" && echo "exit=0 (ACCEPTED)"
grep -n 'ghp-9f2c1a\|files_in_scope' "$REPO/b1.md" | head -3

echo
echo "### 2. where = a MIS-CASED protected path"
printf '{"ask":"rename the widget helper","where":["Crew/Drive.mjs"],"done_means":"green","out_of_scope":"nothing"}\n' > "$REPO/req2.json"
node "$BRIEF" --request "$REPO/req2.json" --checkout "$REPO" --out "$REPO/b2.md" && echo "exit=0 (ACCEPTED)"
sed -n '/## Proposed tier/,/^## Where/p' "$REPO/b2.md" | grep -i 'proposed\|protected'

echo
echo "### 2b. control: the same file spelled correctly"
printf '{"ask":"rename the widget helper","where":["crew/drive.mjs"],"done_means":"green","out_of_scope":"nothing"}\n' > "$REPO/req3.json"
node "$BRIEF" --request "$REPO/req3.json" --checkout "$REPO" --out "$REPO/b3.md" >/dev/null
sed -n '/## Proposed tier/,/^## Where/p' "$REPO/b3.md" | grep -i 'proposed\|protected'

echo
echo "### 3. where = an unslashed DIRECTORY (no fence register)"
printf '{"ask":"rename the widget helper","where":["lib"],"done_means":"green","out_of_scope":"nothing"}\n' > "$REPO/req4.json"
node "$BRIEF" --request "$REPO/req4.json" --checkout "$REPO" --out "$REPO/b4.md" && echo "exit=0 (ACCEPTED)"
grep -n 'files_in_scope' "$REPO/b4.md"
