'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
