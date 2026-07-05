#!/bin/sh
set -u

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

next_sleep_seconds() {
  node -e '
const now = new Date();
const next = new Date(now);
next.setHours(7, 0, 0, 0);
if (next <= now) {
  next.setDate(next.getDate() + 1);
}
const seconds = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
process.stdout.write(String(seconds));
'
}

should_run_now() {
  node -e '
const now = new Date();
const target = new Date(now);
target.setHours(7, 0, 0, 0);
const elapsed = now.getTime() - target.getTime();
process.exit(elapsed >= 0 && elapsed <= 5 * 60 * 1000 ? 0 : 1);
'
}

while :; do
  sleep "$(next_sleep_seconds)"

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
