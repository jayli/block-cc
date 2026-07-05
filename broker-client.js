'use strict';

const net = require('net');

function sendBrokerRequest(port, payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('broker request timed out'));
    }, timeoutMs);
    timer.unref();

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('invalid broker response'));
      }
    });
  });
}

module.exports = { sendBrokerRequest };
