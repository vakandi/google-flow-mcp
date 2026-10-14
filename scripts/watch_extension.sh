#!/usr/bin/env bash
# Live view of whether the Edge extension is actually talking to server.py.
#
#   ./watch_extension.sh
#
# Then reload the extension in Edge and switch server mode ON. This prints the
# first real client that reaches the server instead of guessing why nothing runs.
set -uo pipefail

SERVER="http://127.0.0.1:9876"

if ! lsof -nP -iTCP:9876 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "server.py is not listening on 9876 — start it first (or run any MCP flow_* call)."
  exit 1
fi

echo "Watching ${SERVER}. Reload the extension in Edge, then turn server mode ON."
echo "Waiting for a real client..."
echo

seen_before=""
while true; do
  body=$(curl -s --max-time 3 "${SERVER}/api/health?probe=1")
  state=$(printf '%s' "$body" | python3 -c 'import sys,json; print(json.load(sys.stdin)["client_state"])' 2>/dev/null)

  if [[ -z "$state" ]]; then
    echo "  server stopped answering"
  elif [[ "$state" != "$seen_before" ]]; then
    case "$state" in
      polling)
        echo "  CONNECTED — the extension is polling. Queue a task now." ;;
      reachable_but_not_polling)
        echo "  extension reached the server but never polls — turn server mode ON in the side panel." ;;
      no_contact)
        echo "  no client has reached the server."
        echo "    1. edge://extensions -> circular arrow on the extension card"
        echo "    2. if a permission warning appears, accept it"
        echo "    3. still nothing? check the service worker console for an Uncaught"
        echo "       error — a missing permission (e.g. \"alarms\") makes chrome.alarms"
        echo "       undefined and kills the worker on its first line, silently"
        echo "    4. last resort: quit Edge fully (Cmd+Q) and reopen" ;;
      *)
        echo "  ${state}" ;;
    esac
    seen_before="$state"
  fi

  if [[ "$state" == "polling" ]]; then
    echo
    echo "Done — the server side works end to end."
    exit 0
  fi
  sleep 2
done