'use strict';

const http = require('http');
const net = require('net');

function createConnectProxy({ log } = {}) {
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, portText] = String(req.url || '').split(':');
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || port <= 0) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(port, host);
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      if (log) log(`CONNECT ${host}:${port}`);
    });

    upstream.once('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      clientSocket.destroy();
    });

    clientSocket.once('error', () => upstream.destroy());
  });

  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        server,
        host: '127.0.0.1',
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

module.exports = { createConnectProxy, listen };
