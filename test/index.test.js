'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const { buildClaudeEnv } = require('../index');

const BROKER_TOKEN = 'tok-test';

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

test('buildClaudeEnv injects proxy settings for common env readers', () => {
  const env = buildClaudeEnv({
    baseEnv: {
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://upstream:8080',
      https_proxy: 'http://upstream:8080',
      NO_PROXY: 'claude.ai,localhost',
      no_proxy: 'claude.ai,localhost',
      NODE_EXTRA_CA_CERTS: '/tmp/original-ca.pem',
    },
    proxyUrl: 'http://127.0.0.1:34567',
    caCertPath: '/tmp/block-cc-ca.pem',
  });

  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:34567');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:34567');
  assert.equal(env.http_proxy, 'http://127.0.0.1:34567');
  assert.equal(env.https_proxy, 'http://127.0.0.1:34567');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(env.no_proxy, 'localhost,127.0.0.1,::1');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/original-ca.pem:/tmp/block-cc-ca.pem');
  assert.match(env.GIT_SSH_COMMAND, /^ssh -o ProxyCommand="/);
  assert.match(env.GIT_SSH_COMMAND, /ssh-proxy '127\.0\.0\.1' '34567' %h %p/);
  assert.doesNotMatch(env.GIT_SSH_COMMAND, /\bnc\b/);
});

test('buildClaudeEnv preserves existing Git SSH command', () => {
  const env = buildClaudeEnv({
    baseEnv: {
      GIT_SSH_COMMAND: 'ssh -i /tmp/custom-key',
    },
    proxyUrl: 'http://127.0.0.1:45678',
    caCertPath: '',
  });

  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i /tmp/custom-key');
});

test('ssh-proxy command tunnels bytes through HTTP CONNECT proxy', async () => {
  let connectRequest = '';
  const proxy = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      connectRequest = chunk.toString();
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nhello');
      socket.end();
    });
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const child = spawn(process.execPath, [
      path.join(__dirname, '..', 'index.js'),
      'ssh-proxy',
      '127.0.0.1',
      String(proxy.address().port),
      'ssh.github.com',
      '443',
    ], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    assert.equal(code, 0, stderr);
    assert.match(connectRequest, /^CONNECT ssh\.github\.com:443 HTTP\/1\.1\r\n/);
    assert.match(connectRequest, /Host: ssh\.github\.com:443\r\n/);
    assert.equal(stdout, 'hello');
  } finally {
    proxy.close();
  }
});

test('claude version check runs with proxy environment already injected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-index-'));
  const binDir = path.join(dir, 'bin');
  const homeDir = path.join(dir, 'home');
  const logPath = path.join(dir, 'claude-env.jsonl');
  fs.mkdirSync(binDir);
  fs.mkdirSync(homeDir);

  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    'fs.appendFileSync(process.env.BLOCK_CC_TEST_ENV_LOG, JSON.stringify({',
    '  argv: process.argv.slice(2),',
    '  HTTPS_PROXY: process.env.HTTPS_PROXY,',
    '  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,',
    '  sandboxed: process.env.BLOCK_CC_TEST_SANDBOXED === "1",',
    '  sandboxProfile: process.env.BLOCK_CC_TEST_SANDBOX_PROFILE,',
    '}) + "\\n");',
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.chmodSync(fakeClaude, 0o755);

  const fakeSandboxExec = path.join(binDir, 'sandbox-exec');
  fs.writeFileSync(fakeSandboxExec, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    'const profileIndex = args.indexOf("-f") + 1;',
    'const profile = fs.readFileSync(args[profileIndex], "utf8");',
    'const commandIndex = profileIndex + 1;',
    'const command = args[commandIndex];',
    'const commandArgs = args.slice(commandIndex + 1);',
    'const result = spawnSync(command, commandArgs, {',
    '  stdio: "inherit",',
    '  env: {',
    '    ...process.env,',
    '    BLOCK_CC_TEST_SANDBOXED: "1",',
    '    BLOCK_CC_TEST_SANDBOX_PROFILE: profile,',
    '  },',
    '});',
    'if (result.error) throw result.error;',
    'process.exit(result.status || 0);',
    '',
  ].join('\n'));
  fs.chmodSync(fakeSandboxExec, 0o755);

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), 'claude'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      BLOCK_CC_TEST_ENV_LOG: logPath,
      HOME: homeDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records[0].argv, ['--version']);
  assert.match(records[0].HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(records[0].NODE_EXTRA_CA_CERTS, /ca\.crt$/);
  if (process.platform === 'darwin') {
    const proxyPort = new URL(records[0].HTTPS_PROXY).port;
    assert.equal(Number.isInteger(Number(proxyPort)), true);
  }
});

function startFakeBroker(handler) {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        const line = data.split('\n')[0];
        const payload = JSON.parse(line);
        const response = handler(payload);
        socket.end(JSON.stringify(response) + '\n');
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

test('hook user-prompt-submit registers explicit command with broker', async () => {
  const indexJs = path.join(__dirname, '..', 'index.js');

  const received = [];
  const server = await startFakeBroker((payload) => {
    received.push(payload);
    return { ok: true, requestId: 'test-req-id' };
  });
  const brokerPort = server.address().port;

  try {
    const child = spawn(process.execPath, [indexJs, 'hook', 'user-prompt-submit', String(brokerPort), BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: '!echo ok',
      session_id: 's1',
      cwd: '/tmp',
    }));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'register');
    assert.equal(received[0].command, 'echo ok');
    assert.equal(received[0].token, BROKER_TOKEN);
    assert.match(stderr, /registered/);
  } finally {
    server.close();
  }
});

test('hook pre-tool-use matches and prints updatedInput', async () => {
  const indexJs = path.join(__dirname, '..', 'index.js');

  const server = await startFakeBroker((payload) => {
    if (payload.type === 'match' && payload.command === 'echo ok') {
      return { ok: true, matched: true, requestId: 'matched-req-id' };
    }
    return { ok: true, matched: false, requestId: null };
  });
  const brokerPort = server.address().port;

  try {
    const child = spawn(process.execPath, [indexJs, 'hook', 'pre-tool-use', String(brokerPort), BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
      session_id: 's1',
    }));
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
    const response = JSON.parse(stdout);
    assert.equal(response.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(response.hookSpecificOutput.updatedInput.command, /broker-run/);
    assert.match(response.hookSpecificOutput.updatedInput.command, /matched-req-id/);
    assert.match(stderr, /matched/);
  } finally {
    server.close();
  }
});

test('hook pre-tool-use exits 0 on non-match', async () => {
  const indexJs = path.join(__dirname, '..', 'index.js');

  const server = await startFakeBroker(() => {
    return { ok: true, matched: false, requestId: null };
  });
  const brokerPort = server.address().port;

  try {
    const child = spawn(process.execPath, [indexJs, 'hook', 'pre-tool-use', String(brokerPort), BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'something-else' },
    }));
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
    assert.equal(stdout, '');
  } finally {
    server.close();
  }
});

test('hook pre-tool-use exits 0 when broker is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-hook-test-'));
  const indexJs = path.join(__dirname, '..', 'index.js');

  try {
    const child = spawn(process.execPath, [indexJs, 'hook', 'pre-tool-use', '1', BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
    }));

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('block-cc claude rejects --settings flag', () => {
  const indexJs = path.join(__dirname, '..', 'index.js');
  // Test standalone --settings
  const r1 = spawnSync(process.execPath, [indexJs, 'claude', '--settings', '/tmp/custom-settings.json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /--settings is reserved/);

  // Test --settings=path
  const r2 = spawnSync(process.execPath, [indexJs, 'claude', '--settings=/tmp/custom-settings.json'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /--settings is reserved/);
});

test('full broker flow: register, match, broker-run without Claude', async () => {
  const indexJs = path.join(__dirname, '..', 'index.js');

  // 1. Start a broker server using the real createBrokerServer
  const { BrokerRegistry, createBrokerServer } = require('../broker');
  const registry = new BrokerRegistry({ ttlMs: 10000 });
  const server = createBrokerServer({
    registry,
    env: process.env,
    token: BROKER_TOKEN,
    timeoutMs: 10000,
    maxOutputBytes: 1024,
  });
  await server.listen();
  const brokerPort = server.port;

  try {
    // 2. Simulate UserPromptSubmit hook: register !echo broker-e2e-ok
    const registerChild = spawn(process.execPath, [indexJs, 'hook', 'user-prompt-submit', String(brokerPort), BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    registerChild.stdin.end(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: '!echo broker-e2e-ok',
    }));
    let registerStderr = '';
    registerChild.stderr.on('data', (chunk) => { registerStderr += chunk.toString(); });
    await new Promise((resolve) => registerChild.on('exit', resolve));
    assert.match(registerStderr, /registered/);

    // 3. Simulate PreToolUse hook: match against registered command
    const matchChild = spawn(process.execPath, [indexJs, 'hook', 'pre-tool-use', String(brokerPort), BROKER_TOKEN], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    matchChild.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo broker-e2e-ok' },
    }));
    let matchStdout = '';
    matchChild.stdout.on('data', (chunk) => { matchStdout += chunk.toString(); });
    await new Promise((resolve) => matchChild.on('exit', resolve));

    // 4. Parse updatedInput.command from PreToolUse response
    const hookResponse = JSON.parse(matchStdout);
    assert.equal(hookResponse.hookSpecificOutput.hookEventName, 'PreToolUse');
    const brokerRunCmd = hookResponse.hookSpecificOutput.updatedInput.command;
    assert.match(brokerRunCmd, /broker-run/);
    assert.ok(brokerRunCmd.includes(String(brokerPort)));
    assert.ok(brokerRunCmd.includes(BROKER_TOKEN));

    // 5. Execute the broker-run command directly (simulates Bash tool executing it)
    const shell = process.env.SHELL || '/bin/sh';
    const runChild = spawn(shell, ['-lc', brokerRunCmd], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    runChild.stdin.end();
    let runStdout = '';
    runChild.stdout.on('data', (chunk) => { runStdout += chunk.toString(); });
    let runStderr = '';
    runChild.stderr.on('data', (chunk) => { runStderr += chunk.toString(); });
    const runCode = await new Promise((resolve) => runChild.on('exit', resolve));
    assert.equal(runCode, 0, runStderr);
    assert.match(runStdout, /broker-e2e-ok/);

    // 6. Verify reuse fails
    const reuseChild = spawn(shell, ['-lc', brokerRunCmd], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    reuseChild.stdin.end();
    let reuseStderr = '';
    reuseChild.stderr.on('data', (chunk) => { reuseStderr += chunk.toString(); });
    const reuseCode = await new Promise((resolve) => reuseChild.on('exit', resolve));
    assert.notEqual(reuseCode, 0);
    assert.match(reuseStderr, /already consumed/);
  } finally {
    await server.close();
  }
});
