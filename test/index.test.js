'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildClaudeEnv } = require('../index');

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
    '}) + "\\n");',
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.chmodSync(fakeClaude, 0o755);

  const fakeSandboxExec = path.join(binDir, 'sandbox-exec');
  fs.writeFileSync(fakeSandboxExec, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { spawnSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    'const commandIndex = args.indexOf("-f") >= 0 ? args.indexOf("-f") + 2 : 0;',
    'const command = args[commandIndex];',
    'const commandArgs = args.slice(commandIndex + 1);',
    'const result = spawnSync(command, commandArgs, {',
    '  stdio: "inherit",',
    '  env: { ...process.env, BLOCK_CC_TEST_SANDBOXED: "1" },',
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
    assert.equal(records[0].sandboxed, true);
  }
});
