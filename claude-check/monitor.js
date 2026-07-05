'use strict';

const { spawnSync } = require('child_process');

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}: ${result.stderr || result.stdout || ''}`);
  }
  return { stdout: result.stdout || '' };
}

function parseEndpoint(endpoint) {
  if (!endpoint) return null;
  const normalized = endpoint.replace(/^\[|\]$/g, '');
  const match = normalized.match(/^(.*):([^:]+)$/);
  if (!match) return { address: normalized, port: null };
  const port = Number(match[2]);
  return {
    address: match[1].replace(/^\[|\]$/g, ''),
    port: Number.isInteger(port) ? port : null,
  };
}

function parseLsofLine(line) {
  const raw = line;
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 9 || parts[0] === 'COMMAND') return null;

  const protocolIndex = parts.findIndex((part) => part === 'TCP' || part === 'UDP');
  if (protocolIndex === -1 || protocolIndex + 1 >= parts.length) return null;

  const command = parts[0];
  const pid = Number(parts[1]);
  if (!Number.isInteger(pid)) return null;

  const protocol = parts[protocolIndex];
  const nameParts = parts.slice(protocolIndex + 1);
  const stateMatch = nameParts.join(' ').match(/\(([^)]+)\)\s*$/);
  const state = stateMatch ? stateMatch[1] : '';
  const name = nameParts[0];
  const [localText, remoteText] = name.split('->');
  const local = parseEndpoint(localText);
  const remote = parseEndpoint(remoteText);

  return {
    command,
    pid,
    protocol,
    localAddress: local ? local.address : '',
    localPort: local ? local.port : null,
    remoteAddress: remote ? remote.address : '',
    remotePort: remote ? remote.port : null,
    state,
    raw,
  };
}

function parseLsofOutput(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(parseLsofLine)
    .filter(Boolean);
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '::1' ||
    value === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(value);
}

function isProxyRecord(record, { proxyHost, proxyPort }) {
  return record.remotePort === proxyPort &&
    (record.remoteAddress === proxyHost || isLoopbackHost(record.remoteAddress));
}

function classifyRecords(records, { proxyHost, proxyPort }) {
  const allowed = [];
  const suspicious = [];

  for (const record of records) {
    if (!record.remoteAddress) {
      allowed.push(record);
    } else if (isLoopbackHost(record.remoteAddress)) {
      allowed.push(record);
    } else if (record.protocol === 'TCP' && isProxyRecord(record, { proxyHost, proxyPort })) {
      allowed.push(record);
    } else {
      suspicious.push(record);
    }
  }

  return { allowed, suspicious };
}

function collectDescendantPids(rootPid, { run = runCommand } = {}) {
  const result = run('ps', ['-axo', 'pid=,ppid=']);
  const childrenByParent = new Map();

  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(pid);
  }

  const seen = new Set([Number(rootPid)]);
  const queue = [Number(rootPid)];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const childPid of childrenByParent.get(pid) || []) {
      if (!seen.has(childPid)) {
        seen.add(childPid);
        queue.push(childPid);
      }
    }
  }
  return seen;
}

function sampleNetwork({ rootPid, run = runCommand }) {
  const pids = collectDescendantPids(rootPid, { run });
  const result = run('lsof', ['-i', '-n', '-P']);
  return parseLsofOutput(result.stdout).filter((record) => pids.has(record.pid));
}

async function monitorClaudeNetwork({
  rootPid,
  getRootPid,
  proxyHost,
  proxyPort,
  durationMs,
  intervalMs,
  run = runCommand,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldStop = () => false,
}) {
  const startedAt = Date.now();
  const endAt = startedAt + durationMs;
  const records = [];
  const suspicious = [];

  while (Date.now() < endAt && !shouldStop()) {
    const pid = rootPid || (getRootPid ? getRootPid() : null);
    if (pid) {
      const sample = sampleNetwork({ rootPid: pid, run });
      records.push(...sample);
      const classified = classifyRecords(sample, { proxyHost, proxyPort });
      suspicious.push(...classified.suspicious);
    }
    await sleep(Math.min(intervalMs, Math.max(0, endAt - Date.now())));
  }

  return {
    records,
    suspicious,
    durationMs: Date.now() - startedAt,
    stopped: shouldStop(),
  };
}

module.exports = {
  parseLsofLine,
  parseLsofOutput,
  isLoopbackHost,
  classifyRecords,
  collectDescendantPids,
  sampleNetwork,
  monitorClaudeNetwork,
};
