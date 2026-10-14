#!/usr/bin/env bash
# End-to-end proof that the extension really downloads generated media.
#
#   ./verify_download.sh
#
# Checks the thing that matters: a real image file on disk, not a task that merely
# reports success. A task marked "completed" with zero files is the exact failure
# this whole pipeline is meant to catch, so this script fails loudly in that case.
set -uo pipefail

cd "$(dirname "$0")"
PROMPT="${1:-a green apple on a wooden table}"

note() { echo "  $1"; }

echo "1. waiting for the extension to poll..."
for i in $(seq 1 30); do
  state=$(curl -s --max-time 3 "http://127.0.0.1:9876/api/health?probe=1" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("client_state",""))' 2>/dev/null)
  [[ "$state" == "polling" ]] && { note "connected"; break; }
  [[ $i -eq 30 ]] && { echo "FAIL: extension never reached the server."; exit 1; }
  sleep 2
done

echo "2. queueing an image generation..."
TASK=$(python3 -c 'import json,sys;print(json.dumps({"prompt":sys.argv[1],"mode":"textToImage","model":"Nano Banana 2.1","wait":False}))' "$PROMPT" \
  | curl -s -X POST --max-time 10 "http://127.0.0.1:9876/api/generate?probe=1" \
      -H 'Content-Type: application/json' -d @- \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))')

if [[ -z "$TASK" ]]; then echo "FAIL: server refused the task."; exit 1; fi
note "task $TASK"

echo "3. waiting for it to finish (a real generation takes 60-90s)..."
status="pending"
for i in $(seq 1 120); do
  read -r status files started completed < <(curl -s --max-time 5 "http://127.0.0.1:9876/api/queue/$TASK?probe=1" \
    | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(d.get("status","unknown"), len(d.get("result_files") or []),
      d.get("started_at") or 0, d.get("completed_at") or 0)')
  case "$status" in
    completed|failed|cancelled) break ;;
  esac
  sleep 3
done
elapsed=$(python3 -c "print(f'{($completed-$started):.0f}')" 2>/dev/null || echo 0)
note "status=$status files=$files elapsed=${elapsed}s"

if [[ "$status" == "completed" && "$files" -eq 0 ]]; then
  echo "FAIL: reported completed with zero files after ${elapsed}s."
  [[ "$elapsed" -lt 45 ]] && echo "  Settled in under 45s - the automation is declaring the media ready before Flow has finished generating it."
  exit 1
fi

echo "4. verifying a real media file on disk..."
ok=1
while IFS= read -r f; do
  size=$(stat -f '%z' "$f" 2>/dev/null || echo 0)
  kind=$(file -b "$f" 2>/dev/null | cut -c1-40)
  if [[ "$size" -lt 1024 ]]; then
    note "FAIL: $(basename "$f") is $size bytes - too small to be media"
    ok=0
  elif echo "$kind" | grep -qiE 'HTML|text'; then
    note "FAIL: $(basename "$f") is $kind - a login page, not media"
    ok=0
  else
    note "OK: $(basename "$f") - $size bytes - $kind"
  fi
done < <(find "results/$TASK" -type f 2>/dev/null)

[[ $ok -eq 1 ]] && [[ -n "$(find "results/$TASK" -type f 2>/dev/null)" ]] || {
  echo "FAIL: no file landed in results/$TASK"
  [[ "$status" == "completed" ]] && echo "  (task claimed success with zero files - that is the bug we fixed)"
  exit 1
}

echo
echo "PASS: real media downloaded to results/$TASK"