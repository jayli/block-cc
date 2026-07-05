'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');

class BrokerRegistry {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || 30000;
    this.pending = new Map();
  }

  register({ command, cwd, sessionId, now = Date.now() }) {
    if (!command) throw new Error('command is required');
    const requestId = crypto.randomBytes(16).toString('hex');
    const request = {
      requestId,
      command,
      cwd,
      sessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      consumed: false,
    };
    this.pending.set(requestId, request);
    return request;
  }

  consume({ requestId, now = Date.now() }) {
    const request = this.pending.get(requestId);
    if (!request) throw new Error('unknown broker request');
    if (request.consumed) throw new Error('broker request already consumed');
    if (now > request.expiresAt) throw new Error('broker request expired');
    request.consumed = true;
    return { ...request };
  }

  findMatching({ command, sessionId, now = Date.now() }) {
    let best = null;
    for (const request of this.pending.values()) {
      if (request.consumed) continue;
      if (now > request.expiresAt) continue;
      if (request.command !== command) continue;
      if (sessionId && request.sessionId && request.sessionId !== sessionId) continue;
      if (!best || request.createdAt < best.createdAt) {
        best = request;
      }
    }
    return best || null;
  }
}

function appendLimited(current, chunk, state) {
  if (state.size >= state.maxOutputBytes) {
    state.truncated = true;
    return current;
  }
  const remaining = state.maxOutputBytes - state.size;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  state.size += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  return current + slice.toString();
}

function runBrokerCommand({ command, cwd, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const shell = env.SHELL || '/bin/sh';
    const startedAt = Date.now();
    const outputState = { size: 0, maxOutputBytes, truncated: false };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exited = false;

    const child = spawn(shell, ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 1000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk, outputState);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, outputState);
    });
    child.on('error', (err) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}${err.message}\n`,
        timedOut,
        truncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('exit', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      resolve({
        exitCode: code == null ? 1 : code,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function createBrokerServer({ registry, env, token, timeoutMs, maxOutputBytes }) {
  let executionQueue = Promise.resolve();
  const server = require('net').createServer({ allowHalfOpen: true }, (socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        const line = data.split('\n')[0];
        data = '';
        let payload;
        try {
          payload = JSON.parse(line);
        } catch (_) {
          socket.end(JSON.stringify({ ok: false, error: 'malformed request' }) + '\n');
          return;
        }

        if (payload.token !== token) {
          socket.end(JSON.stringify({ ok: false, error: 'unauthorized' }) + '\n');
          return;
        }

        if (payload.type === 'register') {
          try {
            const request = registry.register({
              command: payload.command,
              cwd: payload.cwd,
              sessionId: payload.sessionId,
            });
            socket.end(JSON.stringify({ ok: true, requestId: request.requestId }) + '\n');
          } catch (err) {
            socket.end(JSON.stringify({ ok: false, error: err.message }) + '\n');
          }
        } else if (payload.type === 'match') {
          const matched = registry.findMatching({
            command: payload.command,
            sessionId: payload.sessionId,
          });
          socket.end(JSON.stringify({
            ok: true,
            matched: !!matched,
            requestId: matched ? matched.requestId : null,
          }) + '\n');
        } else if (payload.type === 'consume') {
          try {
            const request = registry.consume({ requestId: payload.requestId });
            executionQueue = executionQueue.then(() =>
              runBrokerCommand({
                command: request.command,
                cwd: request.cwd || process.cwd(),
                env,
                timeoutMs,
                maxOutputBytes,
              })
            ).then((result) => {
              socket.end(JSON.stringify({ ok: true, result }) + '\n');
            }).catch((err) => {
              socket.end(JSON.stringify({ ok: false, error: err.message }) + '\n');
            });
          } catch (err) {
            socket.end(JSON.stringify({ ok: false, error: err.message }) + '\n');
          }
        } else {
          socket.end(JSON.stringify({ ok: false, error: `unknown request type: ${payload.type}` }) + '\n');
        }
      }
    });
    socket.on('error', () => {});
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  function shutdown() {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  return { listen, close: shutdown, get port() { return server.address().port; } };
}

module.exports = { BrokerRegistry, runBrokerCommand, createBrokerServer };
