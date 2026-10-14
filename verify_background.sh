#!/usr/bin/env bash
# Proves the two things that were broken:
#   1. a task runs without stealing focus from whatever window you are using
#   2. the generated file still lands in results/
set -uo pipefail
cd "$(dirname "$0")"

front() { osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null; }

PROMPT="${1:-a blue mug on a desk}"
BEFORE=$(front)
echo "frontmost before: ${BEFORE:-unknown}"

BODY=$(python3 -c 'import json,sys;print(json.dumps({"prompt":sys.argv[1],"mode":"textToImage","model":"Nano Banana 2.1","aspectRatio":"1:1"}))' "$PROMPT")
TASK=$(curl -s -X POST --max-time 10 "http://127.0.0.1:9876/api/generate?probe=1" \
  -H 'Content-Type: application/json' -d "$BODY" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -z "$TASK" ] && { echo "FAIL: could not queue a task"; exit 1; }
echo "  task: $TASK"

echo "watching focus for up to 180s (task $TASK)..."
STEAL=""
status="pending"
for i in $(seq 1 60); do
  NOW=$(front)
  [ "$NOW" != "$BEFORE" ] && [ -n "$NOW" ] && STEAL="$STEAL $NOW"
  read -r status files < <(curl -s --max-time 5 "http://127.0.0.1:9876/api/queue/$TASK?probe=1" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"),len(d.get("result_files") or []))')
  case "$status" in completed|failed|cancelled) break ;; esac
  sleep 3
done

echo
echo "status=$status files=$files"
if [ -z "$STEAL" ]; then
  echo "PASS: focus never left '${BEFORE}' — ran in the background"
else
  echo "FAIL: focus was stolen by:${STEAL}"
fi

if [ "$files" -gt 0 ] 2>/dev/null; then
  echo "PASS: $files file(s) in results/$TASK"
else
  echo "FAIL: no file landed in results/$TASK"
fi