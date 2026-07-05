'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

function isSandboxSupported() {
  return process.platform === 'darwin';
}

function generateProfile(proxyPort) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error('valid proxy port is required for sandbox network access');
  }

  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
  ].join('\n');

  const profilePath = path.join(os.tmpdir(), `block-cc-sandbox-${process.pid}.sb`);
  fs.writeFileSync(profilePath, profile);
  return profilePath;
}

function spawnClaude(args, env, log, opts = {}) {
  if (isSandboxSupported()) {
    const profilePath = generateProfile(opts.proxyPort);
    log('Sandbox mode enabled (macOS)');

    const child = spawn('sandbox-exec', ['-f', profilePath, 'claude', ...args], {
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      try { fs.unlinkSync(profilePath); } catch (_) {}
    });

    return child;
  }

  log(`Sandbox not supported on ${process.platform}, using direct spawn`);
  return spawn('claude', args, {
    env,
    stdio: 'inherit',
  });
}

function spawnClaudeSync(args, env, opts = {}) {
  if (isSandboxSupported()) {
    const profilePath = generateProfile(opts.proxyPort);
    try {
      return spawnSync('sandbox-exec', ['-f', profilePath, 'claude', ...args], {
        env,
        stdio: opts.stdio || 'pipe',
      });
    } finally {
      try { fs.unlinkSync(profilePath); } catch (_) {}
    }
  }

  return spawnSync('claude', args, {
    env,
    stdio: opts.stdio || 'pipe',
  });
}

module.exports = { isSandboxSupported, spawnClaude, spawnClaudeSync };
