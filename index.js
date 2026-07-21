#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { createProxy } = require('./proxy');
const { setupCA, getSecureContext } = require('./cert');
const { spawnClaude, spawnClaudeSync } = require('./sandbox');
const { checkVersion } = require('./version-check');

const USAGE = 'Usage: npx block-cc [-x http://127.0.0.1:1087] claude';

const INSTALL_CMD = process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

function checkClaude(env) {
  const result = spawnClaudeSync(['--version'], env, {
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
    if (lines.length > 1500) {
      content = lines.slice(-1500).join('\n') + '\n';
    }

    fs.writeFileSync(logPath, content);
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function doubleQuoteValue(value) {
  return String(value).replace(/["\\$`]/g, '\\$&');
}

function buildGitSshCommand(proxyUrl) {
  const proxy = new URL(proxyUrl);
  const proxyCommand = [
    shellQuote(process.execPath),
    shellQuote(__filename),
    'ssh-proxy',
    shellQuote(proxy.hostname),
    shellQuote(proxy.port),
    '%h',
    '%p',
  ].join(' ');
  return `ssh -o ProxyCommand="${doubleQuoteValue(proxyCommand)}"`;
}

function runSshProxy(args) {
  const [proxyHost, proxyPort, targetHost, targetPort] = args;
  if (!proxyHost || !proxyPort || !targetHost || !targetPort) {
    console.error('Usage: block-cc ssh-proxy <proxy-host> <proxy-port> <target-host> <target-port>');
    process.exit(2);
  }

  const socket = net.connect(Number(proxyPort), proxyHost);
  let buffer = Buffer.alloc(0);
  let connected = false;

  socket.on('connect', () => {
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n\r\n`
    );
  });

  socket.on('data', (chunk) => {
    if (connected) return;
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString();
    const rest = buffer.subarray(headerEnd + 4);
    const statusLine = header.split('\r\n')[0] || '';

    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
      console.error(`Proxy CONNECT failed: ${statusLine}`);
      socket.destroy();
      process.exit(1);
      return;
    }

    connected = true;
    socket.removeAllListeners('data');
    if (rest.length > 0) {
      process.stdout.write(rest);
    }
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on('error', (err) => {
    console.error(`Proxy connection failed: ${err.message}`);
    process.exit(1);
  });
}

function normalizeHttpProxyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(`Invalid proxy URL: ${value}`);
  }

  if (url.protocol !== 'http:') {
    throw new Error(`Only http proxy URLs are supported: ${value}`);
  }

  return url.href;
}

function parseCliArgs(args) {
  let upstreamProxyUrl = '';
  let index = 0;

  if (args[index] === '-x') {
    if (!args[index + 1]) {
      throw new Error('-x requires an http proxy URL');
    }
    upstreamProxyUrl = normalizeHttpProxyUrl(args[index + 1]);
    index += 2;
  }

  const command = args[index];
  if (command !== 'claude') {
    return { command, upstreamProxyUrl, claudeArgs: [] };
  }

  return {
    command,
    upstreamProxyUrl,
    claudeArgs: args.slice(index + 1),
  };
}

function buildClaudeEnv({ baseEnv, proxyUrl, caCertPath }) {
  const existingCerts = baseEnv.NODE_EXTRA_CA_CERTS || '';

  let extraCerts = existingCerts;
  if (caCertPath && !existingCerts.split(':').includes(caCertPath)) {
    extraCerts = existingCerts ? `${existingCerts}:${caCertPath}` : caCertPath;
  }

  const env = {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    GIT_SSH_COMMAND: baseEnv.GIT_SSH_COMMAND || buildGitSshCommand(proxyUrl),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  };

  if (extraCerts) {
    env.NODE_EXTRA_CA_CERTS = extraCerts;
  }

  return env;
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'ssh-proxy') {
    runSshProxy(args.slice(1));
    return;
  }

  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (parsed.command !== 'claude') {
    console.error(USAGE);
    process.exit(1);
  }

  const log = createLogger();

  await checkVersion(log);

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

  const proxy = createProxy({
    log,
    getSecureContext: getContext,
    upstreamProxyUrl: parsed.upstreamProxyUrl,
  });

  proxy.on('error', (err) => {
    log(`Proxy error: ${err.message}`);
    process.exit(1);
  });

  proxy.listen(0, '127.0.0.1', () => {
    const port = proxy.address().port;
    const proxyUrl = `http://127.0.0.1:${port}`;
    const env = buildClaudeEnv({ baseEnv: process.env, proxyUrl, caCertPath });

    checkClaude(env);

    const claude = spawnClaude(parsed.claudeArgs, env, log);

    claude.on('error', (err) => {
      log(`Claude spawn failed: ${err.message}`);
      proxy.close();
      process.exit(1);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(`block-cc fatal error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildClaudeEnv, main, parseCliArgs };
