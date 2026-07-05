'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { BrokerRegistry, runBrokerCommand, createBrokerServer } = require('../broker');

const TOKEN = 'test-token';

function request(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('connect', () => {
      socket.end(JSON.stringify({ token: TOKEN, ...payload }) + '\n');
    });
  });
}

test('BrokerRegistry registers and consumes command once', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  const request = registry.register({
    command: 'npm test',
    cwd: process.cwd(),
    sessionId: 's1',
    now: 1000,
  });

  assert.equal(typeof request.requestId, 'string');
  const consumed = registry.consume({ requestId: request.requestId, now: 1001 });
  assert.equal(consumed.command, 'npm test');
  assert.throws(() => registry.consume({ requestId: request.requestId, now: 1002 }), /already consumed/);
});

test('BrokerRegistry rejects expired requests', () => {
  const registry = new BrokerRegistry({ ttlMs: 10 });
  const request = registry.register({
    command: 'npm test',
    cwd: process.cwd(),
    now: 1000,
  });

  assert.throws(() => registry.consume({ requestId: request.requestId, now: 1011 }), /expired/);
});

test('BrokerRegistry rejects unknown requests', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  assert.throws(() => registry.consume({ requestId: 'missing', now: 1000 }), /unknown/);
});

test('runBrokerCommand captures stdout stderr and exit code', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "console.log('out'); console.error('err')"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
  assert.equal(result.timedOut, false);
});

test('runBrokerCommand truncates large output', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "process.stdout.write('x'.repeat(2000))"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 100,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 160);
});

test('runBrokerCommand terminates on timeout', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "setTimeout(() => {}, 10000)"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 50,
    maxOutputBytes: 1024,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('createBrokerServer consumes registered command over TCP', async () => {
  const registry = new BrokerRegistry({ ttlMs: 5000 });
  const pending = registry.register({
    command: `${process.execPath} -e "console.log('broker-ok')"`,
    cwd: process.cwd(),
  });
  const server = createBrokerServer({
    registry,
    env: process.env,
    token: TOKEN,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  await server.listen();
  try {
    const response = await request(server.port, { type: 'consume', requestId: pending.requestId });
    assert.equal(response.ok, true);
    assert.equal(response.result.exitCode, 0);
    assert.match(response.result.stdout, /broker-ok/);
  } finally {
    await server.close();
  }
});

test('createBrokerServer rejects requests with wrong token', async () => {
  const registry = new BrokerRegistry({ ttlMs: 5000 });
  const server = createBrokerServer({
    registry,
    env: process.env,
    token: TOKEN,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  await server.listen();
  try {
    const resp = await request(server.port, { type: 'register', command: 'echo x', token: 'wrong-token' });
    assert.equal(resp.ok, false);
    assert.match(resp.error, /unauthorized/);
  } finally {
    await server.close();
  }
});

test('BrokerRegistry findMatching returns requestId without consuming', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  registry.register({
    command: 'echo ok',
    cwd: process.cwd(),
    sessionId: 's1',
    now: 1000,
  });

  const matched = registry.findMatching({ command: 'echo ok', sessionId: 's1', now: 1001 });
  assert.ok(matched);
  assert.equal(matched.command, 'echo ok');

  const consumed = registry.consume({ requestId: matched.requestId, now: 1002 });
  assert.equal(consumed.command, 'echo ok');
});

test('BrokerRegistry findMatching returns null for non-matching command', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  registry.register({
    command: 'echo ok',
    cwd: process.cwd(),
    now: 1000,
  });

  const matched = registry.findMatching({ command: 'different', now: 1001 });
  assert.equal(matched, null);
});

test('BrokerRegistry findMatching uses FIFO for repeated identical commands', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  const r1 = registry.register({ command: 'echo ok', cwd: process.cwd(), now: 1000 });
  const r2 = registry.register({ command: 'echo ok', cwd: process.cwd(), now: 1001 });

  const matched = registry.findMatching({ command: 'echo ok', now: 1002 });
  assert.equal(matched.requestId, r1.requestId);

  registry.consume({ requestId: r1.requestId, now: 1003 });
  const matched2 = registry.findMatching({ command: 'echo ok', now: 1004 });
  assert.equal(matched2.requestId, r2.requestId);
});

test('BrokerRegistry findMatching requires session id match when both present', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  registry.register({ command: 'echo ok', cwd: process.cwd(), sessionId: 's1', now: 1000 });

  const matched = registry.findMatching({ command: 'echo ok', sessionId: 's2', now: 1001 });
  assert.equal(matched, null);
});

test('BrokerRegistry findMatching allows match when matcher lacks session id', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  const r1 = registry.register({ command: 'echo ok', cwd: process.cwd(), sessionId: 's1', now: 1000 });

  const matched = registry.findMatching({ command: 'echo ok', now: 1001 });
  assert.ok(matched);
  assert.equal(matched.requestId, r1.requestId);
});

test('createBrokerServer handles register and match protocol over TCP', async () => {
  const registry = new BrokerRegistry({ ttlMs: 5000 });

  const server = createBrokerServer({
    registry,
    env: process.env,
    token: TOKEN,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  await server.listen();
  try {
    const regResp = await request(server.port, { type: 'register', command: 'echo test', cwd: process.cwd() });
    assert.equal(regResp.ok, true);
    assert.equal(typeof regResp.requestId, 'string');

    const matchResp = await request(server.port, { type: 'match', command: 'echo test' });
    assert.equal(matchResp.ok, true);
    assert.equal(matchResp.matched, true);
    assert.equal(matchResp.requestId, regResp.requestId);

    const noMatchResp = await request(server.port, { type: 'match', command: 'other' });
    assert.equal(noMatchResp.matched, false);
    assert.equal(noMatchResp.requestId, null);
  } finally {
    await server.close();
  }
});

test('createBrokerServer serializes concurrent consume requests', async () => {
  const registry = new BrokerRegistry({ ttlMs: 5000 });
  const r1 = registry.register({
    command: `${process.execPath} -e "setTimeout(() => console.log('first'), 100)"`,
    cwd: process.cwd(),
  });
  const r2 = registry.register({
    command: `${process.execPath} -e "console.log('second')"`,
    cwd: process.cwd(),
  });

  const server = createBrokerServer({
    registry,
    env: process.env,
    token: TOKEN,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  await server.listen();
  try {
    const [resp1, resp2] = await Promise.all([
      request(server.port, { type: 'consume', requestId: r1.requestId }),
      request(server.port, { type: 'consume', requestId: r2.requestId }),
    ]);

    assert.equal(resp1.ok, true);
    assert.match(resp1.result.stdout, /first/);
    assert.equal(resp2.ok, true);
    assert.match(resp2.result.stdout, /second/);
    assert.ok(resp2.result.durationMs < 1000);
  } finally {
    await server.close();
  }
});
