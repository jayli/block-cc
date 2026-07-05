'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SAMPLE_LIMIT = 20;
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

  const tail = stderrTail(result.stderr);
  if (tail) {
    lines.push(`  stderr_tail ${tail}`);
  }

  if (result.error) {
    lines.push(`  error ${String(result.error).replace(/\r?\n/g, ' | ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function appendResultRecord(rootDir, result) {
  fs.appendFileSync(path.join(rootDir, 'backdoor-version'), formatResultRecord(result));
}

module.exports = { formatResultRecord, appendResultRecord };
