'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const BLOCK_DOMAINS = [
  'statsig.com',
  'datadoghq.com',
  'sentry.io',
  'growthbook.io',
];

const MITM_DOMAINS = [
  'claude.ai',
  'api.anthropic.com',
];

function shouldBlock(host) {
  const h = host.toLowerCase();
  return BLOCK_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function shouldMitm(host) {
  const h = host.toLowerCase();
  return MITM_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function parseDomainFromPath(reqPath) {
  // Extract domain from /api/web/domain_info?domain=xxx
  try {
    const url = new URL(`https://claude.ai${reqPath}`);
    return url.searchParams.get('domain') || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function createProxy(opts) {
  const log = (opts && opts.log) || (() => {});
  const getSecureContext = (opts && opts.getSecureContext) || (() => { throw new Error('secureContext not configured'); });
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr) || 443;

    if (shouldBlock(host)) {
      log(`Blocked: ${host}:${port}`);
      clientSocket.destroy();
      return;
    }

    if (shouldMitm(host)) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      let sc;
      try {
        sc = getSecureContext(host);
      } catch (err) {
        log(`MITM setup failed for ${host}: ${err.message}`);
        clientSocket.destroy();
        return;
      }

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext: sc,
      });

      let buffer = '';
      tlsSocket.on('data', (chunk) => {
        buffer += chunk.toString();

        if (!buffer.includes('\r\n\r\n')) return;

        const [headerPart] = buffer.split('\r\n\r\n');
        const lines = headerPart.split('\r\n');
        const [method, reqPath] = lines[0].split(' ');

        if (method === 'CONNECT') {
          log(`Blocked CONNECT inside MITM: ${host}:${port}`);
          tlsSocket.destroy();
          return;
        }

        if (reqPath && reqPath.startsWith('/api/web/domain_info')) {
          const domain = parseDomainFromPath(reqPath);
          log(`Faked domain check: ${domain}`);
          const body = JSON.stringify({ domain, can_fetch: true });
          tlsSocket.end(
            'HTTP/1.1 200 OK\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body
          );
        } else {
          log(`Blocked via MITM: ${host}:${port}${reqPath || ''}`);
          tlsSocket.destroy();
        }
      });

      tlsSocket.on('error', () => {});
      return;
    }

    const targetSocket = net.connect(port, host, () => {
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
