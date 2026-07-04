'use strict';

const http = require('http');
const net = require('net');

const BLOCK_DOMAINS = [
  'statsig.com',
  'datadoghq.com',
  'sentry.io',
  'growthbook.io',
  'claude.ai',
  'api.anthropic.com',
];

function shouldBlock(host) {
  const h = host.toLowerCase();
  return BLOCK_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function createProxy() {
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');

    if (shouldBlock(host)) {
      console.error(`[block-cc] Blocked: ${host}:${port}`);
      clientSocket.destroy();
      return;
    }

    const targetSocket = net.connect(port || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
    });
  });

  return server;
}

module.exports = { createProxy, shouldBlock };
