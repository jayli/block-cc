'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  compareVersions,
  readMaxVersion,
  writeMaxVersion,
  getLatestClaudeVersion,
} = require('./version');
const { installClaudeVersion } = require('./install');
const { createConnectProxy, listen } = require('./proxy');
const { monitorClaudeNetwork } = require('./monitor');
const { appendResultRecord } = require('./result');
const { gitApproveVersion } = require('./git');

const DEFAULT_DURATION_MS = 180000;
const DEFAULT_INTERVAL_MS = 1000;
const STDERR_LIMIT = 64 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd,
    env: options.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(`${command} exited with status ${result.status}`);
    err.status = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildCheckEnv({ baseEnv, proxyUrl, homeDir, tmpDir }) {
  const env = {};
  for (const key of ['PATH', 'USER', 'LOGNAME', 'TERM', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }

  env.HOME = homeDir;
  env.TMPDIR = tmpDir;
  env.HTTP_PROXY = proxyUrl;
  env.HTTPS_PROXY = proxyUrl;
  env.ALL_PROXY = proxyUrl;
  env.http_proxy = proxyUrl;
  env.https_proxy = proxyUrl;
  env.all_proxy = proxyUrl;
  env.NO_PROXY = 'localhost,127.0.0.1,::1';
  env.no_proxy = env.NO_PROXY;
  env.CLAUDE_DISABLE_AUTOUPDATER = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CI = '1';
  return env;
}

function defaultStartProxy() {
  const server = createConnectProxy();
  return listen(server).then((info) => ({
    ...info,
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
}

function defaultSpawnClaude({ env, cwd }) {
  return spawn('claude', [], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function captureStderr(child) {
  let stderr = '';
  if (!child || !child.stderr || !child.stderr.on) {
    return () => stderr;
  }
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`;
    if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
  });
  return () => stderr;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (!child || !child.once) {
      resolve(null);
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ error }));
  });
}

async function closeProxy(proxyInfo) {
  if (!proxyInfo) return;
  if (typeof proxyInfo.close === 'function') {
    await proxyInfo.close();
  } else if (proxyInfo.server && typeof proxyInfo.server.close === 'function') {
    await new Promise((resolve) => proxyInfo.server.close(resolve));
  }
}

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultKillProcessGroup(pid, { sleep = defaultSleep } = {}) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return;
    throw err;
  }
  await sleep(1000);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

async function runClaudeCheck({ rootDir = path.join(__dirname, '..'), env = process.env, deps = {} } = {}) {
  const commandRunner = deps.run || run;
  const log = deps.log || console.log;
  const latestVersion = (deps.getLatestClaudeVersion || getLatestClaudeVersion)({ run: commandRunner });
  const maxVersion = readMaxVersion(rootDir);

  if (compareVersions(latestVersion, maxVersion) <= 0) {
    log(`Claude Code latest version ${latestVersion} is not newer than max-version ${maxVersion}; skip claude_check.`);
    return { checked: false, version: maxVersion, latest: latestVersion };
  }

  const durationMs = readPositiveInteger(env.CLAUDE_CHECK_DURATION_MS, DEFAULT_DURATION_MS);
  const intervalMs = readPositiveInteger(env.CLAUDE_CHECK_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const skipPush = env.CLAUDE_CHECK_SKIP_PUSH === '1' || env.CLAUDE_CHECK_SKIP_PUSH === 'true';
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || defaultSleep;
  const rmTemp = deps.rmTemp || ((tempBase) => fs.rmSync(tempBase, { recursive: true, force: true }));
  const killProcessGroup = deps.killProcessGroup || defaultKillProcessGroup;
  const startProxy = deps.startProxy || defaultStartProxy;
  const spawnClaude = deps.spawnClaude || defaultSpawnClaude;
  const runMonitor = deps.monitorClaudeNetwork || monitorClaudeNetwork;
  const approve = deps.gitApproveVersion || gitApproveVersion;
  const appendResult = deps.appendResultRecord || appendResultRecord;

  let tempBase = null;
  let proxyInfo = null;
  let child = null;
  let getStderr = () => '';
  let rootPid = null;
  let exitInfo = null;
  let monitorPromise = null;
  let stopMonitor = false;

  function resultBase(result, extra = {}) {
    return {
      timestamp: now(),
      version: latestVersion,
      latest: latestVersion,
      result,
      durationMs,
      intervalMs,
      suspicious: [],
      stderr: getStderr(),
      ...extra,
    };
  }

  try {
    (deps.installClaudeVersion || installClaudeVersion)(latestVersion, { run: commandRunner });

    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-claude-check-'));
    const homeDir = path.join(tempBase, 'home');
    const workDir = path.join(tempBase, 'work');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    proxyInfo = await startProxy();
    const proxyUrl = proxyInfo.url || `http://${proxyInfo.host}:${proxyInfo.port}`;
    const checkEnv = buildCheckEnv({
      baseEnv: env,
      proxyUrl,
      homeDir,
      tmpDir: tempBase,
    });

    monitorPromise = Promise.resolve(runMonitor({
      getRootPid: () => rootPid,
      proxyHost: proxyInfo.host,
      proxyPort: proxyInfo.port,
      durationMs,
      intervalMs,
      run: commandRunner,
      sleep,
      shouldStop: () => stopMonitor,
    }));

    child = spawnClaude({ env: checkEnv, cwd: workDir, detached: true });
    rootPid = child.pid;
    getStderr = captureStderr(child);

    const exitPromise = waitForExit(child).then((info) => {
      exitInfo = info;
      stopMonitor = true;
      return { kind: 'exit', info };
    });
    const monitorResult = await Promise.race([
      monitorPromise.then((value) => ({ kind: 'monitor', value })),
      exitPromise,
    ]);

    if (monitorResult.kind === 'exit') {
      const record = resultBase('inconclusive', {
        durationMs: 0,
        error: monitorResult.info && monitorResult.info.error
          ? monitorResult.info.error.message
          : `claude exited early code=${monitorResult.info ? monitorResult.info.code : 'unknown'} signal=${monitorResult.info ? monitorResult.info.signal : 'unknown'}`,
      });
      appendResult(rootDir, record);
      return { checked: true, version: latestVersion, latest: latestVersion, result: 'inconclusive' };
    }

    const observed = monitorResult.value || {};
    if (observed.suspicious && observed.suspicious.length > 0) {
      appendResult(rootDir, resultBase('backdoor', {
        durationMs: observed.durationMs || durationMs,
        suspicious: observed.suspicious,
      }));
      return { checked: true, version: latestVersion, latest: latestVersion, result: 'backdoor' };
    }

    if ((observed.durationMs || 0) < durationMs) {
      await new Promise((resolve) => process.nextTick(resolve));
      appendResult(rootDir, resultBase('inconclusive', {
        durationMs: observed.durationMs || 0,
        suspicious: observed.suspicious || [],
        error: `observation window incomplete duration_ms=${observed.durationMs || 0}`,
      }));
      return { checked: true, version: latestVersion, latest: latestVersion, result: 'inconclusive' };
    }

    if (exitInfo) {
      appendResult(rootDir, resultBase('inconclusive', {
        error: `claude exited early code=${exitInfo.code} signal=${exitInfo.signal}`,
      }));
      return { checked: true, version: latestVersion, latest: latestVersion, result: 'inconclusive' };
    }

    appendResult(rootDir, resultBase('pass', {
      durationMs: observed.durationMs || durationMs,
      suspicious: [],
    }));
    writeMaxVersion(rootDir, latestVersion);
    approve(latestVersion, { run: commandRunner, skipPush });
    return { checked: true, version: latestVersion, latest: latestVersion, result: 'pass' };
  } catch (err) {
    appendResult(rootDir, resultBase('inconclusive', { error: err.message }));
    return { checked: true, version: latestVersion, latest: latestVersion, result: 'inconclusive', error: err };
  } finally {
    stopMonitor = true;
    if (child && child.pid) {
      await killProcessGroup(child.pid, { sleep });
    }
    await closeProxy(proxyInfo);
    if (tempBase) rmTemp(tempBase);
  }
}

async function main() {
  const result = await runClaudeCheck();
  if (result.result === 'backdoor' || result.result === 'inconclusive') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = {
  runClaudeCheck,
  main,
  buildCheckEnv,
};
