#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { createProxy } = require('./proxy');
const { setupCA, getSecureContext } = require('./cert');
const { spawnClaude, spawnClaudeSync } = require('./sandbox');
const { parseExplicitCommand, buildPreToolUseResponse, getPromptFromUserPromptSubmit, getCommandFromPreToolUse, getSessionId, getCwd } = require('./hooks');
const { sendBrokerRequest } = require('./broker-client');
const { BrokerRegistry, createBrokerServer } = require('./broker');
const { buildBrokerEnv } = require('./broker-env');
const { createHookSettings } = require('./hook-settings');

const USAGE = 'Usage: npx block-cc claude';

const INSTALL_CMD = process.platform === 'win32'
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

function checkClaude(env) {
  const result = spawnClaudeSync(['--version'], env, {
    stdio: 'pipe',
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`Claude Code 未安装，请先执行: ${INSTALL_CMD}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Claude Code 未安装或已损坏 (exit code: ${result.status})，请执行: ${INSTALL_CMD}`
    );
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

function readStdinJson() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(input));
      } catch (_) {
        resolve(null);
      }
    });
    process.stdin.on('error', () => resolve(null));
    if (process.stdin.isTTY) resolve(null);
  });
}

const HOOK_LOG_DIR = path.join(os.homedir(), '.config', 'block-cc');
function hookLog(msg) {
  process.stderr.write(`[block-cc] ${msg}\n`);
  try {
    ensureDir(HOOK_LOG_DIR);
    fs.appendFileSync(path.join(HOOK_LOG_DIR, 'hook-debug.log'), `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch (_) {}
  try {
    // Backup log to /tmp — known writable inside sandbox
    fs.appendFileSync('/tmp/block-cc-backup.log', `${new Date().toISOString()} pid=${process.pid} ${msg}\n`);
  } catch (_) {}
}

async function runHookCommand(args) {
  const [subCommand, brokerPortStr, token] = args;
  const brokerPort = Number(brokerPortStr);
  if (!brokerPort || !token) {
    hookLog(`hook exit early: sub=${subCommand} port=${brokerPortStr} tok=${token ? 'yes' : 'no'}`);
    process.exit(0);
  }

  const event = await readStdinJson();
  if (!event) {
    hookLog(`hook ${subCommand}: no event on stdin`);
    process.exit(0);
  }
  hookLog(`hook ${subCommand}: event=${event.hook_event_name || event.hookEventName} prompt="${(event.prompt || '').slice(0, 80)}" tool=${event.tool_name} cmd="${(event.tool_input && event.tool_input.command || '').slice(0, 80)}"`);

  if (subCommand === 'user-prompt-submit') {
    const prompt = getPromptFromUserPromptSubmit(event);
    const command = parseExplicitCommand(prompt);
    if (!command) {
      hookLog('UserPromptSubmit: no explicit command parsed');
      process.exit(0);
    }
    hookLog(`UserPromptSubmit: parsed command="${command.slice(0, 100)}"`);
    try {
      const response = await sendBrokerRequest(brokerPort, {
        type: 'register',
        token,
        command,
        cwd: getCwd(event),
        sessionId: getSessionId(event),
      }, 1000);
      if (response.ok) {
        hookLog(`UserPromptSubmit: registered ${response.requestId}`);
      } else {
        hookLog(`UserPromptSubmit: broker error=${response.error}`);
      }
    } catch (err) {
      hookLog(`UserPromptSubmit: broker unavailable (${err.message})`);
    }
    process.exit(0);
  }

  if (subCommand === 'pre-tool-use') {
    const command = getCommandFromPreToolUse(event);
    if (!command) {
      hookLog('PreToolUse: not a Bash command');
      process.exit(0);
    }
    hookLog(`PreToolUse: command="${command.slice(0, 100)}"`);
    try {
      const response = await sendBrokerRequest(brokerPort, {
        type: 'match',
        token,
        command,
        sessionId: getSessionId(event),
      }, 1000);
      if (response.ok && response.matched) {
        hookLog(`PreToolUse: matched ${response.requestId}, writing updatedInput`);
        const hookResponse = buildPreToolUseResponse({
          nodePath: process.execPath,
          indexPath: __filename,
          brokerPort,
          token,
          requestId: response.requestId,
        });
        process.stdout.write(JSON.stringify(hookResponse));
      } else {
        hookLog(`PreToolUse: no match (ok=${response.ok}, matched=${response.matched})`);
      }
    } catch (err) {
      hookLog(`PreToolUse: broker unavailable (${err.message})`);
    }
    process.exit(0);
  }

  if (subCommand === 'post-tool-use') {
    process.exit(0);
  }
}

async function runBrokerCommand(args) {
  const [brokerPortStr, token, requestId] = args;
  const brokerPort = Number(brokerPortStr);
  if (!brokerPort || !token || !requestId) {
    process.stderr.write('Usage: block-cc broker-run <port> <token> <request-id>\n');
    process.exit(2);
  }

  try {
    const response = await sendBrokerRequest(brokerPort, {
      type: 'consume',
      token,
      requestId,
    }, 600000);
    if (!response.ok) {
      process.stderr.write(`broker-run: ${response.error}\n`);
      process.exit(1);
    }
    const result = response.result;
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.truncated) {
      process.stderr.write('\n[block-cc] output truncated\n');
    }
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`broker-run: ${err.message}\n`);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'ssh-proxy') {
    runSshProxy(args.slice(1));
    return;
  }

  if (args[0] === 'hook') {
    runHookCommand(args.slice(1));
    return;
  }

  if (args[0] === 'broker-run') {
    runBrokerCommand(args.slice(1));
    return;
  }

  if (args[0] !== 'claude') {
    console.error(USAGE);
    process.exit(1);
  }

  // Capture original env before block-cc injects proxy settings
  const originalEnv = { ...process.env };

  // Check for --settings conflict (both --settings <path> and --settings=<path>)
  const claudeArgs = args.slice(1);
  if (claudeArgs.some((a) => a === '--settings' || (typeof a === 'string' && a.startsWith('--settings=')))) {
    console.error('block-cc: --settings is reserved for broker mode. Remove --settings from your command and retry.');
    process.exit(1);
  }

  // Generate broker token for access control
  const brokerToken = crypto.randomBytes(16).toString('hex');

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

  // Placeholder — broker server created inside proxy.listen to have actual env
  let brokerServer;
  let hookSettings;
  let brokerPort;

  function cleanupBroker() {
    try { if (hookSettings) hookSettings.cleanup(); } catch (_) {}
    try { if (brokerServer) brokerServer.close(); } catch (_) {}
  }

  const proxy = createProxy({ log, getSecureContext: getContext });

  proxy.on('error', (err) => {
    log(`Proxy error: ${err.message}`);
    process.exit(1);
  });

  proxy.listen(0, '127.0.0.1', async () => {
    const port = proxy.address().port;
    const proxyUrl = `http://127.0.0.1:${port}`;
    const claudeEnv = buildClaudeEnv({ baseEnv: process.env, proxyUrl, caCertPath });

    // Broker env: restore original user env from Claude's proxy-injected env
    const brokerEnv = buildBrokerEnv({ originalEnv, claudeEnv });

    const registry = new BrokerRegistry({ ttlMs: 30000 });
    brokerServer = createBrokerServer({
      registry,
      env: brokerEnv,
      token: brokerToken,
      timeoutMs: 600000,
      maxOutputBytes: 1048576,
    });

    // Start broker server
    try {
      await brokerServer.listen();
      brokerPort = brokerServer.port;
      log(`Broker server started on port ${brokerPort}`);
    } catch (err) {
      log(`Broker server failed: ${err.message}`);
      cleanupBroker();
      proxy.close();
      process.exit(1);
    }

    hookSettings = createHookSettings({
      nodePath: process.execPath,
      indexPath: __filename,
      brokerPort,
      brokerToken,
    });

    log(`Hook settings path: ${hookSettings.settingsPath}`);
    const settingsContent = fs.readFileSync(hookSettings.settingsPath, 'utf8');
    log(`Hook settings (first 400 chars): ${settingsContent.slice(0, 400)}`);

    try {
      checkClaude(claudeEnv);
    } catch (err) {
      console.error(err.message);
      cleanupBroker();
      proxy.close();
      process.exit(1);
    }

    const allClaudeArgs = [...claudeArgs, '--settings', hookSettings.settingsPath];
    log(`Claude spawn args: ${JSON.stringify(allClaudeArgs).slice(0, 200)}`);
    const claude = spawnClaude(allClaudeArgs, claudeEnv, log);

    claude.on('error', (err) => {
      log(`Claude spawn failed: ${err.message}`);
      cleanupBroker();
      proxy.close();
      process.exit(1);
    });

    claude.on('exit', (code, signal) => {
      cleanupBroker();
      proxy.close();
      if (signal) {
        process.exit(code || 1);
      }
      process.exit(code || 0);
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildClaudeEnv, main };
