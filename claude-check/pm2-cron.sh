#!/bin/sh
set -u

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

next_sleep_seconds() {
  node "$ROOT_DIR/claude-check/scheduler.js" next-sleep
}

should_run_now() {
  node "$ROOT_DIR/claude-check/scheduler.js" should-run-now
}

while :; do
  next_sleep="$(next_sleep_seconds)"
  echo "$(timestamp) next claude_check in ${next_sleep}s"
  sleep "$next_sleep"

  if ! should_run_now; then
    echo "$(timestamp) skipped missed 07:00 window"
    continue
  fi

  echo "$(timestamp) starting claude_check"
  (
    cd "$ROOT_DIR"
    npm run claude_check
  )
  status=$?
  echo "$(timestamp) finished claude_check status=$status"
done
