'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { execFileSync } = require('child_process');

const { createProxy } = require('../proxy');

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

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${marker.toString()}`));
    }, 1000);

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

async function fetchDomainInfoViaProxy(proxy, hostname, ca) {
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
  });
  await once(tlsSocket, 'secureConnect');

  tlsSocket.write(
    'GET /api/web/domain_info?domain=b.consolelog.work HTTP/1.1\r\n' +
    `Host: ${hostname}\r\n` +
    'Connection: close\r\n\r\n'
  );

  const response = await new Promise((resolve, reject) => {
    let data = '';
    tlsSocket.on('data', (chunk) => { data += chunk.toString(); });
    tlsSocket.on('end', () => resolve(data));
    tlsSocket.on('error', reject);
  });

  const body = response.split('\r\n\r\n').at(-1);
  assert.match(response, /^HTTP\/1\.1 200 OK/);
  assert.deepEqual(JSON.parse(body), {
    domain: 'b.consolelog.work',
    can_fetch: true,
  });
}

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
      assert.deepEqual(logs, ['Faked domain check: b.consolelog.work']);
    } finally {
      proxy.close();
    }
  });
}
