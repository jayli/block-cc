'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

const { createConnectProxy, listen } = require('../claude-check/proxy');
const { formatResultRecord, appendResultRecord } = require('../claude-check/result');
const { gitApproveVersion } = require('../claude-check/git');
const { runClaudeCheck } = require('../claude-check');

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

function readUntil(socket, marker, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${marker.toString()}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(marker)) {
        cleanup();
        resolve(buffer);
      }
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

test('checker CONNECT proxy tunnels bytes to target', async () => {
  const target = net.createServer((socket) => {
    socket.write('ok');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');

  const proxy = createConnectProxy();
  const proxyInfo = await listen(proxy);

  try {
    const client = net.connect(proxyInfo.port, proxyInfo.host);
    await once(client, 'connect');

    client.write(
      `CONNECT 127.0.0.1:${target.address().port} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${target.address().port}\r\n\r\n`
    );

    const response = await readUntil(client, Buffer.from('\r\n\r\n'));
    assert.match(response.toString(), /^HTTP\/1\.1 200 Connection Established/);

    const payload = await readUntil(client, Buffer.from('ok'));
    assert.match(payload.toString(), /ok/);
    client.destroy();
  } finally {
    proxy.close();
    target.close();
  }
});

test('formatResultRecord writes pass summary with latest version', () => {
  const text = formatResultRecord({
    timestamp: new Date('2026-07-05T23:00:00.000Z'),
    version: '2.1.202',
    latest: '2.1.202',
    result: 'pass',
    durationMs: 180000,
    intervalMs: 1000,
    suspicious: [],
  });

  assert.equal(text, '2026-07-05T23:00:00.000Z version=2.1.202 latest=2.1.202 result=pass duration_ms=180000 interval_ms=1000 suspicious=0\n');
});

test('formatResultRecord caps suspicious samples and stderr tail', () => {
  const suspicious = Array.from({ length: 25 }, (_, index) => ({
    raw: `claude 123 user ${index}u IPv4 0x0 0t0 TCP 192.168.1.5:${50000 + index}->18.238.1.${index}:443 (ESTABLISHED)`,
  }));

  const text = formatResultRecord({
    timestamp: new Date('2026-07-05T23:00:00.000Z'),
    version: '2.1.202',
    latest: '2.1.202',
    result: 'inconclusive',
    durationMs: 1000,
    intervalMs: 100,
    suspicious,
    stderr: `${'x'.repeat(70000)}\nlast error`,
  });

  assert.match(text, /result=inconclusive/);
  assert.match(text, /samples=20/);
  assert.match(text, /  sample claude 123 user 0u/);
  assert.doesNotMatch(text, /  sample claude 123 user 20u/);
  assert.match(text, /  stderr_tail /);
  assert.match(text, /last error/);
});

test('appendResultRecord appends to backdoor-version', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-result-'));

  appendResultRecord(rootDir, {
    timestamp: new Date('2026-07-05T23:00:00.000Z'),
    version: '2.1.202',
    latest: '2.1.202',
    result: 'pass',
    durationMs: 180000,
    intervalMs: 1000,
    suspicious: [],
  });

  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /latest=2\.1\.202 result=pass/);
});

test('gitApproveVersion stages max-version and backdoor-version then commits and pushes', () => {
  const calls = [];

  gitApproveVersion('2.1.202', {
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['add', 'max-version', 'backdoor-version'] },
    { command: 'git', args: ['commit', '-m', 'chore(claude-check): approve Claude Code 2.1.202'] },
    { command: 'git', args: ['push'] },
  ]);
});

test('gitApproveVersion can skip push', () => {
  const calls = [];

  gitApproveVersion('2.1.202', {
    skipPush: true,
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls.map((call) => call.args[0]), ['add', 'commit']);
});

function createRootWithMaxVersion(version) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-flow-'));
  fs.writeFileSync(path.join(rootDir, 'max-version'), `${version}\n`);
  return rootDir;
}

function createMockChild({ pid = 123, exitSoon = false, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.kill = () => {};
  if (stderr) {
    process.nextTick(() => child.stderr.emit('data', Buffer.from(stderr)));
  }
  if (exitSoon) {
    process.nextTick(() => child.emit('exit', 1, null));
  }
  return child;
}

test('runClaudeCheck exits without checking when latest is not newer than max-version', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const calls = [];
  const logs = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      log: (message) => logs.push(message),
      getLatestClaudeVersion: () => '2.1.202',
      installClaudeVersion: () => calls.push('install'),
      monitorClaudeNetwork: () => calls.push('monitor'),
    },
  });

  assert.deepEqual(result, { checked: false, version: '2.1.202', latest: '2.1.202' });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, [
    'Claude Code latest version 2.1.202 is not newer than max-version 2.1.202; skip claude_check.',
  ]);
  assert.equal(fs.existsSync(path.join(rootDir, 'backdoor-version')), false);
});

test('runClaudeCheck approves passing newer version after monitoring starts before spawn', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const order = [];
  const gitCalls = [];

  const result = await runClaudeCheck({
    rootDir,
    env: { CLAUDE_CHECK_SKIP_PUSH: '1' },
    deps: {
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      getLatestClaudeVersion: () => '2.1.203',
      installClaudeVersion: () => order.push('install'),
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => order.push('proxy-close') }),
      monitorClaudeNetwork: async ({ getRootPid }) => {
        order.push(`monitor-start:${getRootPid() || 'none'}`);
        await Promise.resolve();
        order.push(`monitor-pid:${getRootPid()}`);
        return { suspicious: [], durationMs: 180000 };
      },
      spawnClaude: () => {
        order.push('spawn');
        return createMockChild();
      },
      gitApproveVersion: (version, options) => gitCalls.push({ version, skipPush: options.skipPush }),
      rmTemp: () => order.push('rm-temp'),
      sleep: async () => {},
      killProcessGroup: () => order.push('kill'),
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.result, 'pass');
  assert.deepEqual(order.slice(0, 4), ['install', 'monitor-start:none', 'spawn', 'monitor-pid:123']);
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.203\n');
  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /latest=2\.1\.203 result=pass/);
  assert.deepEqual(gitCalls, [{ version: '2.1.203', skipPush: true }]);
});

test('runClaudeCheck records backdoor without updating max-version or git approval', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const gitCalls = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      getLatestClaudeVersion: () => '2.1.203',
      installClaudeVersion: () => {},
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => {} }),
      monitorClaudeNetwork: async () => ({
        suspicious: [{ raw: 'claude 123 TCP 192.168.1.5:50001->18.238.1.2:443' }],
        durationMs: 1000,
      }),
      spawnClaude: () => createMockChild(),
      gitApproveVersion: () => gitCalls.push('git'),
      rmTemp: () => {},
      sleep: async () => {},
      killProcessGroup: () => {},
    },
  });

  assert.equal(result.result, 'backdoor');
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.202\n');
  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /result=backdoor/);
  assert.deepEqual(gitCalls, []);
});

test('runClaudeCheck treats early exit as inconclusive and cleans temp directory', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const cleanup = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      getLatestClaudeVersion: () => '2.1.203',
      installClaudeVersion: () => {},
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => cleanup.push('proxy') }),
      monitorClaudeNetwork: async () => {
        await Promise.resolve();
        return { suspicious: [], durationMs: 100 };
      },
      spawnClaude: () => createMockChild({ exitSoon: true, stderr: 'startup failed\nlast line' }),
      gitApproveVersion: () => cleanup.push('git'),
      rmTemp: (tempBase) => cleanup.push(`rm:${path.basename(tempBase)}`),
      sleep: async () => {},
      killProcessGroup: () => cleanup.push('kill'),
    },
  });

  assert.equal(result.result, 'inconclusive');
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.202\n');
  const record = fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8');
  assert.match(record, /result=inconclusive/);
  assert.match(record, /last line/);
  assert.equal(cleanup.includes('proxy'), true);
  assert.equal(cleanup.some((entry) => entry.startsWith('rm:block-cc-claude-check-')), true);
  assert.equal(cleanup.includes('git'), false);
});
