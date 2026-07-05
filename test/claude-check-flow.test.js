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
const { nextRunAt, secondsUntilNextRun, shouldRunNow } = require('../claude-check/scheduler');
const { runClaudeCheck, buildClaudeSpawnSpec, defaultSpawnClaude } = require('../claude-check');

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
    durationMs: 60000,
    intervalMs: 1000,
    suspicious: [],
  });

  assert.equal(text, '2026-07-05T23:00:00.000Z version=2.1.202 latest=2.1.202 result=pass duration_ms=60000 interval_ms=1000 suspicious=0\n');
});

test('formatResultRecord omits stdout and stderr tails for passing checks', () => {
  const text = formatResultRecord({
    timestamp: new Date('2026-07-05T23:00:00.000Z'),
    version: '2.1.202',
    latest: '2.1.202',
    result: 'pass',
    durationMs: 60000,
    intervalMs: 1000,
    suspicious: [],
    stdout: 'interactive ui output',
    stderr: 'debug warning',
  });

  assert.doesNotMatch(text, /stdout_tail/);
  assert.doesNotMatch(text, /stderr_tail/);
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
    durationMs: 60000,
    intervalMs: 1000,
    suspicious: [],
  });

  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /latest=2\.1\.202 result=pass/);
});

test('appendResultRecord trims backdoor-version to at most 1000 lines', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-result-'));
  const file = path.join(rootDir, 'backdoor-version');
  const existing = Array.from({ length: 1005 }, (_, index) => `old-${index + 1}`).join('\n');
  fs.writeFileSync(file, `${existing}\n`);

  appendResultRecord(rootDir, {
    timestamp: new Date('2026-07-05T23:00:00.000Z'),
    version: '2.1.202',
    latest: '2.1.202',
    result: 'pass',
    durationMs: 60000,
    intervalMs: 1000,
    suspicious: [],
  });

  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], 'old-7');
  assert.match(lines[999], /latest=2\.1\.202 result=pass/);
});

test('gitApproveVersion pulls first then commits only max-version and backdoor-version', () => {
  const calls = [];

  gitApproveVersion('2.1.202', {
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls, [
    { command: 'git', args: ['pull', '--rebase'] },
    { command: 'git', args: ['add', 'max-version', 'backdoor-version'] },
    { command: 'git', args: ['commit', '-m', 'chore(claude-check): approve Claude Code 2.1.202', '--', 'max-version', 'backdoor-version'] },
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

  assert.deepEqual(calls.map((call) => call.args[0]), ['pull', 'add', 'commit']);
});

test('scheduler calculates the next future local 07:00', () => {
  assert.equal(nextRunAt(new Date(2026, 6, 6, 6, 59, 30)).getTime(), new Date(2026, 6, 6, 7, 0, 0).getTime());
  assert.equal(nextRunAt(new Date(2026, 6, 6, 7, 0, 0)).getTime(), new Date(2026, 6, 7, 7, 0, 0).getTime());
  assert.equal(nextRunAt(new Date(2026, 6, 6, 9, 0, 0)).getTime(), new Date(2026, 6, 7, 7, 0, 0).getTime());
});

test('scheduler only runs within five minutes after local 07:00', () => {
  assert.equal(shouldRunNow(new Date(2026, 6, 6, 6, 59, 59)), false);
  assert.equal(shouldRunNow(new Date(2026, 6, 6, 7, 0, 0)), true);
  assert.equal(shouldRunNow(new Date(2026, 6, 6, 7, 5, 0)), true);
  assert.equal(shouldRunNow(new Date(2026, 6, 6, 7, 5, 1)), false);
});

test('scheduler prints positive sleep seconds and validates commands', () => {
  const now = new Date(2026, 6, 6, 6, 59, 30, 1);
  assert.equal(secondsUntilNextRun(now), 30);
});

test('runClaudeCheck can skip git approval for local verification', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const gitCalls = [];
  const logs = [];

  const result = await runClaudeCheck({
    rootDir,
    env: { CLAUDE_CHECK_SKIP_GIT: '1' },
    deps: {
      log: (message) => logs.push(message),
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      installClaudeVersion: () => {},
      getInstalledClaudeVersion: () => '2.1.203',
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => {} }),
      monitorClaudeNetwork: async () => ({ suspicious: [], durationMs: 60000 }),
      spawnClaude: () => createMockChild(),
      gitApproveVersion: () => gitCalls.push('git'),
      rmTemp: () => {},
      sleep: async () => {},
      killProcessGroup: () => {},
    },
  });

  assert.equal(result.result, 'pass');
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.203\n');
  assert.deepEqual(gitCalls, []);
  assert.equal(logs.includes('CLAUDE_CHECK_SKIP_GIT=1; skipped git commit/push approval.'), true);
});

test('buildClaudeSpawnSpec uses script on macOS without requiring stdin TTY', () => {
  assert.deepEqual(buildClaudeSpawnSpec({ platform: 'darwin', ttyAvailable: true }), {
    command: 'script',
    args: ['-q', '/dev/null', 'claude'],
    stdio: ['ignore', 'pipe', 'pipe'],
    label: 'script -q /dev/null claude',
  });

  assert.deepEqual(buildClaudeSpawnSpec({ platform: 'darwin', ttyAvailable: false }), {
    command: 'script',
    args: ['-q', '/dev/null', 'claude'],
    stdio: ['ignore', 'pipe', 'pipe'],
    label: 'script -q /dev/null claude',
  });
});

test('buildClaudeSpawnSpec uses direct claude on non-macOS platforms', () => {
  assert.deepEqual(buildClaudeSpawnSpec({ platform: 'linux', ttyAvailable: false }), {
    command: 'claude',
    args: [],
    stdio: ['pipe', 'pipe', 'pipe'],
    label: 'claude',
  });
});

test('defaultSpawnClaude starts interactive claude without print probe or stdin dependency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-spawn-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "'use strict';",
    "require('fs').writeFileSync(process.env.BLOCK_CC_ARGV_LOG, JSON.stringify(process.argv.slice(2)));",
    'setTimeout(() => process.exit(0), 100);',
    '',
  ].join('\n'));
  fs.chmodSync(fakeClaude, 0o755);
  const argvLog = path.join(dir, 'argv.json');

  const child = defaultSpawnClaude({
    cwd: dir,
    platform: 'darwin',
    ttyAvailable: false,
    env: {
      ...process.env,
      BLOCK_CC_ARGV_LOG: argvLog,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
  });

  try {
    assert.equal(child.stdin, null, 'stdin should be ignored for macOS script mode');
    assert.ok(child.stdout, 'stdout should be captured for diagnostics');
    assert.ok(child.stderr, 'stderr should be captured for diagnostics');
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.deepEqual(argv, []);
    assert.equal(argv.includes('--print'), false);
  } finally {
    child.kill();
  }
});


function createRootWithMaxVersion(version) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-flow-'));
  fs.writeFileSync(path.join(rootDir, 'max-version'), `${version}\n`);
  return rootDir;
}

function createMockChild({ pid = 123, exitSoon = false, exitCode = 1, stderr = '', delayedExit = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = { end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  if (stderr) {
    process.nextTick(() => child.stderr.emit('data', Buffer.from(stderr)));
  }
  if (exitSoon) {
    const emitExit = () => child.emit('exit', exitCode, null);
    if (delayedExit) {
      setImmediate(emitExit);
    } else {
      process.nextTick(emitExit);
    }
  }
  return child;
}

test('runClaudeCheck installs latest then compares installed claude version before skipping', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const calls = [];
  const logs = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      log: (message) => logs.push(message),
      getLatestClaudeVersion: () => {
        calls.push('npm-view');
        return '9.9.9';
      },
      installClaudeVersion: (version) => calls.push(`install:${version || 'latest'}`),
      getInstalledClaudeVersion: () => {
        calls.push('version');
        return '2.1.202';
      },
      monitorClaudeNetwork: () => calls.push('monitor'),
    },
  });

  assert.deepEqual(result, { checked: false, version: '2.1.202', latest: '2.1.202' });
  assert.deepEqual(calls, ['install:latest', 'version']);
  assert.deepEqual(logs, [
    'Installing latest Claude Code before comparing with max-version...',
    'Claude Code 2.1.202 installed.',
    'Claude Code latest version 2.1.202 is not newer than max-version 2.1.202; skip claude_check.',
  ]);
  assert.equal(fs.existsSync(path.join(rootDir, 'backdoor-version')), false);
});

test('runClaudeCheck checks installed version when claude install latest fails', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const calls = [];
  const logs = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      log: (message) => logs.push(message),
      installClaudeVersion: (version) => {
        calls.push(`install:${version || 'latest'}`);
        throw new Error('download unavailable');
      },
      getInstalledClaudeVersion: () => {
        calls.push('version');
        return '2.1.202';
      },
      monitorClaudeNetwork: () => calls.push('monitor'),
    },
  });

  assert.deepEqual(result, { checked: false, version: '2.1.202', latest: '2.1.202' });
  assert.deepEqual(calls, ['install:latest', 'version']);
  assert.equal(logs.includes('claude install latest failed: download unavailable'), true);
  assert.equal(logs.includes('Installed Claude Code version: 2.1.202'), true);
  assert.equal(logs.includes('Using currently installed Claude Code version: 2.1.202'), true);
});

test('runClaudeCheck approves passing newer version after monitoring starts before spawn', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const order = [];
  const gitCalls = [];
  const logs = [];
  let spawnedHome = '';
  let spawnedCwd = '';

  const result = await runClaudeCheck({
    rootDir,
    env: { CLAUDE_CHECK_SKIP_PUSH: '1', HOME: '/Users/tester' },
    deps: {
      log: (message) => logs.push(message),
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      installClaudeVersion: () => order.push('install'),
      getInstalledClaudeVersion: () => '2.1.203',
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => order.push('proxy-close') }),
      monitorClaudeNetwork: async ({ getRootPid }) => {
        order.push(`monitor-start:${getRootPid() || 'none'}`);
        await Promise.resolve();
        order.push(`monitor-pid:${getRootPid()}`);
        return { suspicious: [], durationMs: 60000 };
      },
      spawnClaude: ({ env, cwd }) => {
        order.push('spawn');
        spawnedHome = env.HOME;
        spawnedCwd = cwd;
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
  assert.match(spawnedHome, /^\/tmp\/block-cc-claude-check-[^/]+\/home$/);
  assert.match(spawnedCwd, /^\/tmp\/block-cc-claude-check-[^/]+\/work$/);
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.203\n');
  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /latest=2\.1\.203 result=pass/);
  assert.deepEqual(gitCalls, [{ version: '2.1.203', skipPush: true }]);
  assert.equal(logs.includes('Installing latest Claude Code before comparing with max-version...'), true);
  assert.equal(logs.includes('Claude Code 2.1.203 installed.'), true);
  assert.equal(logs.includes('Claude Code latest version 2.1.203 is newer than max-version 2.1.202; running claude_check.'), true);
  assert.equal(logs.includes('Starting check proxy and network monitor for 60000ms...'), true);
  assert.equal(logs.some((line) => line.includes('Spawned interactive Claude pid=123')), true);
  assert.equal(logs.includes('Claude Code 2.1.203 passed network check; updating max-version and approving.'), true);
});

test('runClaudeCheck approves a clean zero-exit probe with no suspicious traffic', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const gitCalls = [];

  const result = await runClaudeCheck({
    rootDir,
    env: { CLAUDE_CHECK_SKIP_PUSH: '1' },
    deps: {
      log: () => {},
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      installClaudeVersion: () => {},
      getInstalledClaudeVersion: () => '2.1.203',
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => {} }),
      monitorClaudeNetwork: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return { suspicious: [], durationMs: 3000, stopped: true };
      },
      spawnClaude: () => createMockChild({ exitSoon: true, exitCode: 0 }),
      gitApproveVersion: (version, options) => gitCalls.push({ version, skipPush: options.skipPush }),
      rmTemp: () => {},
      sleep: async () => {},
      killProcessGroup: () => {},
    },
  });

  assert.equal(result.result, 'pass');
  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.203\n');
  assert.match(fs.readFileSync(path.join(rootDir, 'backdoor-version'), 'utf8'), /result=pass/);
  assert.deepEqual(gitCalls, [{ version: '2.1.203', skipPush: true }]);
});

test('runClaudeCheck records backdoor without updating max-version or git approval', async () => {
  const rootDir = createRootWithMaxVersion('2.1.202');
  const gitCalls = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      log: () => {},
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      installClaudeVersion: () => {},
      getInstalledClaudeVersion: () => '2.1.203',
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
  const logs = [];

  const result = await runClaudeCheck({
    rootDir,
    env: {},
    deps: {
      log: (message) => logs.push(message),
      now: () => new Date('2026-07-05T23:00:00.000Z'),
      installClaudeVersion: () => {},
      getInstalledClaudeVersion: () => '2.1.203',
      startProxy: async () => ({ host: '127.0.0.1', port: 61234, url: 'http://127.0.0.1:61234', close: () => cleanup.push('proxy') }),
      monitorClaudeNetwork: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { suspicious: [], durationMs: 100 };
      },
      spawnClaude: () => createMockChild({ exitSoon: true, delayedExit: true, stderr: 'startup failed\nlast line' }),
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
  assert.equal(logs.some((line) => line.includes('exited code=1 signal=null')), true, logs.join('\n'));
  assert.equal(logs.some((line) => line.includes('stderr_tail=') && line.includes('last line')), true, logs.join('\n'));
  assert.equal(cleanup.includes('proxy'), true);
  assert.equal(cleanup.some((entry) => entry.startsWith('rm:block-cc-claude-check-')), true);
  assert.equal(cleanup.includes('git'), false);
});
