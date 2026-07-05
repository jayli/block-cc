'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBrokerEnv } = require('../broker-env');

test('buildBrokerEnv removes block-cc injected values absent from original env', () => {
  const env = buildBrokerEnv({
    originalEnv: { PATH: '/usr/bin' },
    claudeEnv: {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://127.0.0.1:1234',
      HTTPS_PROXY: 'http://127.0.0.1:1234',
      http_proxy: 'http://127.0.0.1:1234',
      https_proxy: 'http://127.0.0.1:1234',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      GIT_SSH_COMMAND: 'ssh -o ProxyCommand="node index.js ssh-proxy"',
      NODE_EXTRA_CA_CERTS: '/tmp/block-cc-ca.pem',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    },
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.no_proxy, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(env.DISABLE_AUTOUPDATER, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_UPDATE_CHECK, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, undefined);
});

test('buildBrokerEnv preserves original user proxy and Claude-related values', () => {
  const originalEnv = {
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://proxy.local:8080',
    NO_PROXY: 'internal.local',
    GIT_SSH_COMMAND: 'ssh -i ~/.ssh/custom',
    NODE_EXTRA_CA_CERTS: '/tmp/original.pem',
    DISABLE_AUTOUPDATER: 'user-value',
  };

  const env = buildBrokerEnv({
    originalEnv,
    claudeEnv: {
      ...originalEnv,
      HTTP_PROXY: 'http://127.0.0.1:1234',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      GIT_SSH_COMMAND: 'ssh -o ProxyCommand="node index.js ssh-proxy"',
      NODE_EXTRA_CA_CERTS: '/tmp/original.pem:/tmp/block-cc-ca.pem',
      DISABLE_AUTOUPDATER: '1',
    },
  });

  assert.equal(env.HTTP_PROXY, 'http://proxy.local:8080');
  assert.equal(env.NO_PROXY, 'internal.local');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i ~/.ssh/custom');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/original.pem');
  assert.equal(env.DISABLE_AUTOUPDATER, 'user-value');
});
