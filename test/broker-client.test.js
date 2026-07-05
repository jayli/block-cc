'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { sendBrokerRequest } = require('../broker-client');

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

test('sendBrokerRequest sends JSON and parses response', async () => {
  const server = await startFakeBroker((payload) => {
    assert.equal(payload.type, 'register');
    return { ok: true, requestId: 'test-id' };
  });

  try {
    const response = await sendBrokerRequest(server.address().port, { type: 'register', command: 'echo ok' });
    assert.equal(response.ok, true);
    assert.equal(response.requestId, 'test-id');
  } finally {
    server.close();
  }
});

test('sendBrokerRequest rejects on connection error', async () => {
  await assert.rejects(() => sendBrokerRequest(1, { type: 'ping' }, 500));
});
