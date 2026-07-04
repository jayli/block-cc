#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { createProxy } = require('./proxy');
const { setupCA, getSecureContext } = require('./cert');

const USAGE = 'Usage: npx block-cc claude';

const INSTALL_CMD = process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

function checkClaude() {
  const result = spawnSync('claude', ['--version'], {
    shell: true,
    stdio: 'pipe',
  });
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      `Claude Code 未安装，请先执行: ${INSTALL_CMD}`
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Claude Code 未安装或已损坏 (exit code: ${result.status})，请执行: ${INSTALL_CMD}`
    );
    process.exit(1);
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createLogger() {
  const logDir = path.join(os.homedir(), '.config', 'block-cc');
  ensureDir(logDir);
  const logPath = path.join(logDir, 'block-cc.log');

  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    let content = '';
    if (fs.existsSync(logPath)) {
      content = fs.readFileSync(logPath, 'utf-8');
    }
    content += line + '\n';

    const lines = content.split('\n').filter(Boolean);
    if (lines.length > 1000) {
      content = lines.slice(-1000).join('\n') + '\n';
    }

    fs.writeFileSync(logPath, content);
  };
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'claude') {
    console.error(USAGE);
    process.exit(1);
  }

  checkClaude();

  const log = createLogger();

  let caCertPath;
  try {
    const ca = setupCA();
    caCertPath = ca.caCertPath;
    if (ca.isNew) {
      log('Generated local CA certificate for claude.ai MITM');
    }
  } catch (err) {
    log(`Certificate setup warning: ${err.message}`);
  }

  const secureContexts = {};
  function getContext(hostname) {
    if (!secureContexts[hostname]) {
      secureContexts[hostname] = getSecureContext(hostname);
    }
    return secureContexts[hostname];
  }

  const proxy = createProxy({ log, getSecureContext: getContext });

  proxy.on('error', (err) => {
    log(`Proxy error: ${err.message}`);
    process.exit(1);
  });

  proxy.listen(0, '127.0.0.1', () => {
    const port = proxy.address().port;

    const extraCerts = caCertPath && process.env.NODE_EXTRA_CA_CERTS
      ? `${process.env.NODE_EXTRA_CA_CERTS}:${caCertPath}`
      : (caCertPath || process.env.NODE_EXTRA_CA_CERTS || '');

    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    };

    if (extraCerts) {
      env.NODE_EXTRA_CA_CERTS = extraCerts;
    }

    const claude = spawn('claude', args.slice(1), {
      env,
      stdio: 'inherit',
      shell: true,
    });

    claude.on('exit', (code, signal) => {
      proxy.close();
      if (signal) {
        process.exit(code || 1);
      }
      process.exit(code || 0);
    });
  });
}

main();
