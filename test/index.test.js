'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const { buildClaudeEnv, parseCliArgs } = require('../index');
const { SANDBOX_ENABLE, isSandboxSupported } = require('../sandbox');

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

test('parseCliArgs accepts upstream proxy before claude and preserves claude args', () => {
  assert.deepEqual(parseCliArgs(['-x', 'http://127.0.0.1:1087', 'claude', '--print', 'hi']), {
    command: 'claude',
    upstreamProxyUrl: 'http://127.0.0.1:1087/',
    claudeArgs: ['--print', 'hi'],
  });
});

test('sandbox is disabled by default', () => {
  assert.equal(SANDBOX_ENABLE, false);
  assert.equal(isSandboxSupported(), false);
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

  // Pre-cache max-version so version check passes without network
  const cacheDir = path.join(homeDir, '.config', 'block-cc');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'max-version'), '2.1.201\n');

  const fakeClaude = path.join(binDir, 'claude');
  fs.writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    'const argv = process.argv.slice(2);',
    'if (process.env.BLOCK_CC_TEST_ENV_LOG) {',
    '  fs.appendFileSync(process.env.BLOCK_CC_TEST_ENV_LOG, JSON.stringify({',
    '    argv: argv,',
    '    HTTPS_PROXY: process.env.HTTPS_PROXY,',
    '    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,',
    '    sandboxed: process.env.BLOCK_CC_TEST_SANDBOXED === "1",',
    '    sandboxProfile: process.env.BLOCK_CC_TEST_SANDBOX_PROFILE,',
    '  }) + "\\n");',
    '}',
    "console.log('Claude Code v2.1.200');",
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
  // First record: version check call (no proxy env)
  assert.deepEqual(records[0].argv, ['--version']);
  // Second record: checkClaude call (with proxy env injected)
  assert.deepEqual(records[1].argv, ['--version']);
  assert.match(records[1].HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(records[1].NODE_EXTRA_CA_CERTS, /ca\.crt$/);
  assert.equal(records[1].sandboxed, false);
  assert.equal(records[1].sandboxProfile, undefined);
});
