'use strict';

const TARGET_HOUR = 7;
const TARGET_MINUTE = 0;
const TARGET_SECOND = 0;
const MISSED_WINDOW_MS = 5 * 60 * 1000;

function nextRunAt(now = new Date()) {
  const next = new Date(now);
  next.setHours(TARGET_HOUR, TARGET_MINUTE, TARGET_SECOND, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function secondsUntilNextRun(now = new Date()) {
  const ms = nextRunAt(now).getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 1000));
}

function shouldRunNow(now = new Date()) {
  const target = new Date(now);
  target.setHours(TARGET_HOUR, TARGET_MINUTE, TARGET_SECOND, 0);
  const elapsed = now.getTime() - target.getTime();
  return elapsed >= 0 && elapsed <= MISSED_WINDOW_MS;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'next-sleep') {
    process.stdout.write(String(secondsUntilNextRun()));
    return 0;
  }
  if (command === 'should-run-now') {
    return shouldRunNow() ? 0 : 1;
  }
  if (command === 'next-run-iso') {
    process.stdout.write(nextRunAt().toISOString());
    return 0;
  }
  process.stderr.write('Usage: node claude-check/scheduler.js <next-sleep|should-run-now|next-run-iso>\n');
  return 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  TARGET_HOUR,
  MISSED_WINDOW_MS,
  nextRunAt,
  secondsUntilNextRun,
  shouldRunNow,
  main,
};
