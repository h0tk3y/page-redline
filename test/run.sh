#!/usr/bin/env bash
# Runs test/smoke.html in headless Chrome and prints PASS/FAIL lines.
# Chrome does not always exit after --dump-dom, so it is killed once the dump lands.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
DUMP="$PROFILE/dump.html"
trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --allow-file-access-from-files --user-data-dir="$PROFILE" \
  --dump-dom "file://$HERE/smoke.html" > "$DUMP" 2>/dev/null &
PID=$!
for _ in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  if grep -q '</html>' "$DUMP" 2>/dev/null; then sleep 1; break; fi
  sleep 1
done
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
RESULT="$(python3 -c 'import re,sys,html
m=re.search(r"<pre id=\"out\">(.*?)</pre>", open(sys.argv[1]).read(), re.S)
print(html.unescape(m.group(1)) if m else "NO OUTPUT")' "$DUMP")"
printf '%s\n' "$RESULT"
printf '%s' "$RESULT" | grep -q FAIL && exit 1
printf '%s' "$RESULT" | grep -q DONE || exit 1
exit 0
