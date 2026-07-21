'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');

const { createProxy, shouldBlock } = require('../proxy');

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

function createSelfSignedContext(hostname) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-test-'));
  const keyPath = path.join(dir, 'server.key');
  const certPath = path.join(dir, 'server.crt');

  execFileSync('openssl', ['genrsa', '-out', keyPath, '2048']);
  execFileSync('openssl', [
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    keyPath,
    '-sha256',
    '-days',
    '1',
    '-out',
    certPath,
    '-subj',
    `/CN=${hostname}`,
    '-addext',
    `subjectAltName=DNS:${hostname}`,
  ]);

  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);

  return {
    cert,
    secureContext: tls.createSecureContext({ key, cert }),
  };
}

function readUntil(socket, marker, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${marker.toString()}`));
    }, timeoutMs);

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

    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function fetchViaProxy(proxy, hostname, ca, reqPath, opts = {}) {
  const socket = net.connect(proxy.address().port, '127.0.0.1');
  await once(socket, 'connect');

  socket.write(
    `CONNECT ${hostname}:443 HTTP/1.1\r\n` +
    `Host: ${hostname}:443\r\n\r\n`
  );

  const connectResponse = await readUntil(socket, Buffer.from('\r\n\r\n'));
  assert.match(connectResponse.toString(), /^HTTP\/1\.1 200 Connection Established/);

  const tlsSocket = tls.connect({
    socket,
    servername: hostname,
    ca,
    rejectUnauthorized: true,
    ALPNProtocols: opts.ALPNProtocols,
  });
  await once(tlsSocket, 'secureConnect');

  const requestTarget = opts.requestTarget || reqPath;
  tlsSocket.write(
    `GET ${requestTarget} HTTP/1.1\r\n` +
    `Host: ${hostname}\r\n` +
    'Connection: close\r\n\r\n'
  );

  const response = await new Promise((resolve, reject) => {
    let data = '';
    tlsSocket.on('data', (chunk) => { data += chunk.toString(); });
    tlsSocket.on('end', () => resolve(data));
    tlsSocket.on('error', reject);
  });

  return response;
}

async function connectTlsViaProxy(proxy, hostname, ca, opts = {}) {
  const socket = net.connect(proxy.address().port, '127.0.0.1');
  await once(socket, 'connect');

  socket.write(
    `CONNECT ${hostname}:443 HTTP/1.1\r\n` +
    `Host: ${hostname}:443\r\n\r\n`
  );

  const connectResponse = await readUntil(socket, Buffer.from('\r\n\r\n'));
  assert.match(connectResponse.toString(), /^HTTP\/1\.1 200 Connection Established/);

  const tlsSocket = tls.connect({
    socket,
    servername: hostname,
    ca,
    rejectUnauthorized: true,
    ALPNProtocols: opts.ALPNProtocols,
  });
  await once(tlsSocket, 'secureConnect');
  return tlsSocket;
}

function waitForSocketClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for socket close'));
    }, 1500);

    function cleanup() {
      clearTimeout(timer);
      socket.off('close', onClose);
      socket.off('end', onClose);
      socket.off('error', onError);
    }

    function onClose() {
      cleanup();
      resolve();
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    socket.once('close', onClose);
    socket.once('end', onClose);
    socket.once('error', onError);
  });
}

async function fetchDomainInfoViaProxy(proxy, hostname, ca) {
  const response = await fetchViaProxy(
    proxy,
    hostname,
    ca,
    '/api/web/domain_info?domain=b.consolelog.work'
  );
  const body = response.split('\r\n\r\n').at(-1);
  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.deepEqual(JSON.parse(body), {
    domain: 'b.consolelog.work',
    can_fetch: true,
  });
}

test('blocks status.claude.com', () => {
  assert.equal(shouldBlock('status.claude.com'), true);
});

test('blocks statsig.anthropic.com', () => {
  assert.equal(shouldBlock('statsig.anthropic.com'), true);
});

test('tunnels allowed CONNECT requests through configured upstream HTTP proxy', async () => {
  let upstreamRequest = '';
  const upstream = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      upstreamRequest = chunk.toString();
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nfrom-upstream');
      socket.end();
    });
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const logs = [];
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    upstreamProxyUrl: `http://127.0.0.1:${upstream.address().port}`,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  const socket = net.connect(proxy.address().port, '127.0.0.1');

  try {
    await once(socket, 'connect');
    socket.write(
      'CONNECT example.com:443 HTTP/1.1\r\n' +
      'Host: example.com:443\r\n\r\n'
    );

    const response = await new Promise((resolve, reject) => {
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

    assert.match(response, /^HTTP\/1\.1 200 Connection Established\r\n\r\nfrom-upstream/);
    assert.match(upstreamRequest, /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
    assert.match(upstreamRequest, /Host: example\.com:443\r\n/);
    assert.deepEqual(logs, [
      'Tunnel via upstream: example.com:443',
    ]);
  } finally {
    socket.destroy();
    proxy.close();
    upstream.close();
  }
});

test('MITM returns blocked for api.anthropic.com v1 requests', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('api.anthropic.com');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const response = await fetchViaProxy(
      proxy,
      'api.anthropic.com',
      cert,
      '/v1/messages'
    );
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
    assert.equal(response.split('\r\n\r\n').at(-1), 'blocked');
    assert.deepEqual(logs, [
      'MITM: api.anthropic.com:443 path=CONNECT',
      'Blocked API request: api.anthropic.com:443 path=/v1/messages',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM blocks api.anthropic.com event logging requests', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('api.anthropic.com');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const response = await fetchViaProxy(
      proxy,
      'api.anthropic.com',
      cert,
      '/api/event_logging/v2/batch'
    );
    assert.match(response, /^HTTP\/1\.1 204 No Content/);
    assert.equal(response.split('\r\n\r\n').at(-1), '');
    assert.deepEqual(logs, [
      'MITM: api.anthropic.com:443 path=CONNECT',
      'Blocked event logging request: api.anthropic.com:443 path=/api/event_logging/v2/batch',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM blocks api.anthropic.com event logging requests with query params', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('api.anthropic.com');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const response = await fetchViaProxy(
      proxy,
      'api.anthropic.com',
      cert,
      '/api/event_logging/v2/batch?client=claude-code'
    );
    assert.match(response, /^HTTP\/1\.1 204 No Content/);
    assert.equal(response.split('\r\n\r\n').at(-1), '');
    assert.deepEqual(logs, [
      'MITM: api.anthropic.com:443 path=CONNECT',
      'Blocked event logging request: api.anthropic.com:443 path=/api/event_logging/v2/batch?client=claude-code',
    ]);
  } finally {
    proxy.close();
  }
});

for (const hostname of ['claude.ai', 'api.anthropic.com']) {
  test(`MITM fakes ${hostname} domain_info responses`, async () => {
    const logs = [];
    const { cert, secureContext } = createSelfSignedContext(hostname);
    const proxy = createProxy({
      log: (msg) => logs.push(msg),
      getSecureContext: () => secureContext,
    });

    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');

    try {
      await fetchDomainInfoViaProxy(proxy, hostname, cert);
      assert.deepEqual(logs, [
        `MITM: ${hostname}:443 path=CONNECT`,
        'Faked domain check: b.consolelog.work path=/api/web/domain_info?domain=b.consolelog.work',
      ]);
    } finally {
      proxy.close();
    }
  });
}

test('MITM fakes domain_info for absolute-form request targets', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('claude.ai');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const response = await fetchViaProxy(
      proxy,
      'claude.ai',
      cert,
      '/api/web/domain_info?domain=b.consolelog.work',
      { requestTarget: 'https://claude.ai/api/web/domain_info?domain=b.consolelog.work' }
    );
    const body = response.split('\r\n\r\n').at(-1);
    assert.match(response, /^HTTP\/1\.1 200 OK/);
    assert.deepEqual(JSON.parse(body), {
      domain: 'b.consolelog.work',
      can_fetch: true,
    });
    assert.deepEqual(logs, [
      'MITM: claude.ai:443 path=CONNECT',
      'Faked domain check: b.consolelog.work path=/api/web/domain_info?domain=b.consolelog.work',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM closes oversized headers without hanging', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('claude.ai');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const tlsSocket = await connectTlsViaProxy(proxy, 'claude.ai', cert);
    tlsSocket.write(
      'GET /api/web/domain_info?domain=b.consolelog.work HTTP/1.1\r\n' +
      `X-Fill: ${'a'.repeat(70 * 1024)}`
    );
    await waitForSocketClose(tlsSocket);
    assert.deepEqual(logs, [
      'MITM: claude.ai:443 path=CONNECT',
      'Blocked oversized MITM header: claude.ai:443 path=unknown',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM closes incomplete headers after timeout', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('claude.ai');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
    headerTimeoutMs: 20,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const tlsSocket = await connectTlsViaProxy(proxy, 'claude.ai', cert);
    tlsSocket.write('GET /api/web/domain_info?domain=b.consolelog.work HTTP/1.1\r\n');
    await waitForSocketClose(tlsSocket);
    assert.deepEqual(logs, [
      'MITM: claude.ai:443 path=CONNECT',
      'Blocked incomplete MITM header: claude.ai:443 path=unknown',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM fails closed for malformed request lines', async () => {
  const logs = [];
  const { cert, secureContext } = createSelfSignedContext('claude.ai');
  const proxy = createProxy({
    log: (msg) => logs.push(msg),
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const tlsSocket = await connectTlsViaProxy(proxy, 'claude.ai', cert);
    tlsSocket.write('BROKEN\r\nHost: claude.ai\r\n\r\n');
    await waitForSocketClose(tlsSocket);
    assert.deepEqual(logs, [
      'MITM: claude.ai:443 path=CONNECT',
      'Blocked malformed MITM request: claude.ai:443 path=unknown',
    ]);
  } finally {
    proxy.close();
  }
});

test('MITM only negotiates http/1.1 over ALPN', async () => {
  const { cert, secureContext } = createSelfSignedContext('claude.ai');
  const proxy = createProxy({
    getSecureContext: () => secureContext,
  });

  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const tlsSocket = await connectTlsViaProxy(proxy, 'claude.ai', cert, {
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    assert.equal(tlsSocket.alpnProtocol, 'http/1.1');
    tlsSocket.destroy();
  } finally {
    proxy.close();
  }
});
