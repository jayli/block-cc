'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLsofLine,
  parseLsofOutput,
  isLoopbackHost,
  classifyRecords,
  sampleNetwork,
} = require('../claude-check/monitor');

test('parseLsofLine extracts TCP and UDP connection details', () => {
  const tcpLoopback = parseLsofLine(
    'claude 123 user 42u IPv4 0x0 0t0 TCP 127.0.0.1:50000->127.0.0.1:61234 (ESTABLISHED)'
  );
  const tcpExternal = parseLsofLine(
    'claude 123 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->18.238.1.2:443 (ESTABLISHED)'
  );
  const udpExternal = parseLsofLine(
    'claude 123 user 44u IPv4 0x0 0t0 UDP 192.168.1.5:55555->8.8.8.8:53'
  );

  assert.deepEqual(tcpLoopback, {
    command: 'claude',
    pid: 123,
    protocol: 'TCP',
    localAddress: '127.0.0.1',
    localPort: 50000,
    remoteAddress: '127.0.0.1',
    remotePort: 61234,
    state: 'ESTABLISHED',
    raw: 'claude 123 user 42u IPv4 0x0 0t0 TCP 127.0.0.1:50000->127.0.0.1:61234 (ESTABLISHED)',
  });
  assert.equal(tcpExternal.remoteAddress, '18.238.1.2');
  assert.equal(tcpExternal.remotePort, 443);
  assert.equal(udpExternal.protocol, 'UDP');
  assert.equal(udpExternal.remoteAddress, '8.8.8.8');
  assert.equal(udpExternal.remotePort, 53);
});

test('parseLsofOutput drops unparsable lines', () => {
  const records = parseLsofOutput([
    'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'claude 123 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->18.238.1.2:443 (ESTABLISHED)',
    '',
  ].join('\n'));

  assert.equal(records.length, 1);
  assert.equal(records[0].pid, 123);
});

test('isLoopbackHost recognizes localhost forms', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('api.localhost'), true);
  assert.equal(isLoopbackHost('18.238.1.2'), false);
});

test('classifyRecords allows proxy and loopback traffic but flags external TCP and UDP', () => {
  const records = parseLsofOutput([
    'claude 123 user 42u IPv4 0x0 0t0 TCP 127.0.0.1:50000->127.0.0.1:61234 (ESTABLISHED)',
    'claude 123 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->18.238.1.2:443 (ESTABLISHED)',
    'claude 123 user 44u IPv4 0x0 0t0 UDP 192.168.1.5:55555->8.8.8.8:53',
    'claude 123 user 45u IPv4 0x0 0t0 UDP 127.0.0.1:55555->127.0.0.1:53',
  ].join('\n'));

  const result = classifyRecords(records, {
    proxyHost: '127.0.0.1',
    proxyPort: 61234,
  });

  assert.equal(result.suspicious.length, 2);
  assert.equal(result.suspicious[0].remoteAddress, '18.238.1.2');
  assert.equal(result.suspicious[1].protocol, 'UDP');
  assert.equal(result.allowed.length, 2);
});

test('sampleNetwork scopes lsof records to the spawned PID tree', () => {
  const calls = [];
  const records = sampleNetwork({
    rootPid: 123,
    run(command, args) {
      calls.push({ command, args });
      if (command === 'ps') {
        return {
          stdout: [
            '  PID  PPID',
            '  123     1',
            '  124   123',
            '  125   124',
            '  999     1',
          ].join('\n'),
        };
      }
      assert.equal(command, 'lsof');
      return {
        stdout: [
          'claude 124 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->18.238.1.2:443 (ESTABLISHED)',
          'claude 999 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->8.8.8.8:443 (ESTABLISHED)',
        ].join('\n'),
      };
    },
  });

  assert.deepEqual(records.map((record) => record.pid), [124]);
  assert.deepEqual(calls.map((call) => call.command), ['ps', 'lsof']);
});

test('monitorClaudeNetwork stops polling when shouldStop returns true', async () => {
  const { monitorClaudeNetwork } = require('../claude-check/monitor');
  let samples = 0;
  let stopped = false;

  const result = await monitorClaudeNetwork({
    rootPid: 123,
    proxyHost: '127.0.0.1',
    proxyPort: 61234,
    durationMs: 10000,
    intervalMs: 1000,
    shouldStop: () => stopped,
    sleep: async () => {
      stopped = true;
    },
    run(command) {
      if (command === 'ps') {
        return { stdout: '123 1\n' };
      }
      samples += 1;
      return { stdout: '' };
    },
  });

  assert.equal(samples, 1);
  assert.equal(result.stopped, true);
});
