#!/usr/bin/env bash
# Start three backends on :3001, :3002, :3003.
# Ctrl-C stops all of them.
set -uo pipefail
cd "$(dirname "$0")"

pids=()
cleanup() {
  echo
  echo "stopping backends..."
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for i in 1 2 3; do
  BACKEND_ID="$i" PORT="300$i" node backend.js &
  pids+=($!)
done

echo "three backends up. try:  curl -s localhost:3001 | jq"
wait
