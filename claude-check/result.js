'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SAMPLE_LIMIT = 20;
const MAX_RESULT_LINES = 1000;
const STDERR_LIMIT = 64 * 1024;
const STDERR_TAIL_LINES = 12;

function normalizeTimestamp(timestamp) {
  if (timestamp instanceof Date) return timestamp.toISOString();
  if (timestamp) return new Date(timestamp).toISOString();
  return new Date().toISOString();
}

function stderrTail(stderr) {
  if (!stderr) return '';
  const capped = String(stderr).slice(-STDERR_LIMIT);
  return capped
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-STDERR_TAIL_LINES)
    .join(' | ');
}

function formatResultRecord(result) {
  const suspicious = result.suspicious || [];
  const sampleLimit = result.sampleLimit || DEFAULT_SAMPLE_LIMIT;
  const lines = [
    `${normalizeTimestamp(result.timestamp)} ` +
    `version=${result.version} ` +
    `latest=${result.latest} ` +
    `result=${result.result} ` +
    `duration_ms=${result.durationMs} ` +
    `interval_ms=${result.intervalMs} ` +
    `suspicious=${suspicious.length}`,
  ];

  if (suspicious.length > 0) {
    lines[0] += ` samples=${Math.min(sampleLimit, suspicious.length)}`;
    for (const sample of suspicious.slice(0, sampleLimit)) {
      lines.push(`  sample ${sample.raw || JSON.stringify(sample)}`);
    }
  }

  if (result.result === 'inconclusive') {
    const tail = stderrTail(result.stderr);
    if (tail) {
      lines.push(`  stderr_tail ${tail}`);
    }

    const stdoutTail = stderrTail(result.stdout);
    if (stdoutTail) {
      lines.push(`  stdout_tail ${stdoutTail}`);
    }
  }

  if (result.error) {
    lines.push(`  error ${String(result.error).replace(/\r?\n/g, ' | ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function appendResultRecord(rootDir, result) {
  const file = path.join(rootDir, 'backdoor-version');
  fs.appendFileSync(file, formatResultRecord(result));
  trimResultFile(file);
}

function trimResultFile(file, maxLines = MAX_RESULT_LINES) {
  const text = fs.readFileSync(file, 'utf8');
  const hadFinalNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  if (lines.length <= maxLines) return;
  fs.writeFileSync(file, `${lines.slice(-maxLines).join('\n')}\n`);
}

module.exports = { formatResultRecord, appendResultRecord, trimResultFile };
