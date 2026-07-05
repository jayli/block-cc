'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SANDBOX_ENABLE = false;

function isSandboxSupported() {
  return SANDBOX_ENABLE && process.platform === 'darwin';
}

function generateProfile() {
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join('\n');

  const profilePath = path.join(os.tmpdir(), `block-cc-sandbox-${process.pid}.sb`);
  fs.writeFileSync(profilePath, profile);
  return profilePath;
}

function spawnClaude(args, env, log) {
  if (isSandboxSupported()) {
    const profilePath = generateProfile();
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
    const profilePath = generateProfile();
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

module.exports = { SANDBOX_ENABLE, isSandboxSupported, spawnClaude, spawnClaudeSync };
