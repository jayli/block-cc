'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const { createProxy } = require('../proxy');

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
  });
}

test('forwards plain HTTP absolute-form requests to IP targets', async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;

  const logs = [];
  const proxy = createProxy({ log: (msg) => logs.push(msg) });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const response = await new Promise((resolve, reject) => {
      // Use http.request with absolute URL through the proxy (standard HTTP_PROXY behavior)
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.address().port,
        path: `http://127.0.0.1:${backendPort}/v1/messages`,
        method: 'GET',
        headers: { 'Host': `127.0.0.1:${backendPort}` },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, { ok: true, path: '/v1/messages' });
    assert.ok(logs.some((l) => l.includes('Forward HTTP')));
  } finally {
    proxy.close();
    backend.close();
  }
});

test('blocks plain HTTP requests to blocked domains', async () => {
  const logs = [];
  const proxy = createProxy({ log: (msg) => logs.push(msg) });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const socket = net.connect(proxy.address().port, '127.0.0.1');
    await once(socket, 'connect');

    socket.write(
      'GET http://sentry.io/api/123/envelope/ HTTP/1.1\r\n' +
      'Host: sentry.io\r\n' +
      'Connection: close\r\n\r\n'
    );

    const result = await new Promise((resolve) => {
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('end', () => resolve(data));
      socket.on('error', () => resolve('error'));
      socket.on('close', () => resolve(data || 'closed'));
    });

    // Connection should be destroyed (blocked)
    assert.ok(!result.includes('HTTP/1.1 200'));
    assert.ok(logs.some((l) => l.includes('Blocked')));
  } finally {
    proxy.close();
  }
});

test('forwards plain HTTP POST requests with body', async () => {
  let receivedBody = '';
  const backend = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200);
      res.end('received');
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;

  const proxy = createProxy({ log: () => {} });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    const payload = JSON.stringify({ model: 'test', messages: [] });
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.address().port,
        path: `http://127.0.0.1:${backendPort}/v1/messages`,
        method: 'POST',
        headers: {
          'Host': `127.0.0.1:${backendPort}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(payload);
    });

    assert.equal(response.statusCode, 200);
    assert.equal(receivedBody, payload);
  } finally {
    proxy.close();
    backend.close();
  }
});
