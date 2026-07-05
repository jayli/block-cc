'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const REMOTE_URL = 'https://raw.githubusercontent.com/jayli/block-cc/refs/heads/main/max-version';
const CACHE_PATH = path.join(os.homedir(), '.config', 'block-cc', 'max-version');

function fetchRemoteVersion() {
  return new Promise((resolve, reject) => {
    https.get(REMOTE_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const version = data.trim();
        if (/^\d+\.\d+\.\d+$/.test(version)) {
          resolve(version);
        } else {
          reject(new Error(`Invalid version format: ${version}`));
        }
      });
    }).on('error', reject);
  });
}

function getCachedVersion() {
  try {
    const v = fs.readFileSync(CACHE_PATH, 'utf-8').trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
    return null;
  } catch {
    return null;
  }
}

function cacheVersion(version) {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, version);
}

function parseVersion(v) {
  const parts = v.split('.').map(Number);
  return parts[0] * 1000000 + parts[1] * 1000 + parts[2];
}

function getLocalClaudeVersion() {
  const result = spawnSync('claude', ['--version'], { stdio: 'pipe' });
  if (result.error || result.status !== 0) return null;
  const output = result.stdout.toString().trim();
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

async function checkVersion(log) {
  let remoteVersion;
  try {
    remoteVersion = await fetchRemoteVersion();
    cacheVersion(remoteVersion);
    log(`Fetched remote max-version: ${remoteVersion}`);
  } catch (err) {
    remoteVersion = getCachedVersion();
    if (!remoteVersion) {
      log(`Version check failed: no remote or cached version (${err.message})`);
      console.error('无法获取远端版本信息且本地无缓存，请检查网络连接。');
      process.exit(1);
    }
    log(`Using cached max-version: ${remoteVersion}`);
  }

  const localVersion = getLocalClaudeVersion();
  if (!localVersion) {
    log('Failed to get local Claude Code version');
    console.error('无法获取本地 Claude Code 版本。');
    process.exit(1);
  }
  log(`Local Claude Code version: ${localVersion}`);

  const localNum = parseVersion(localVersion);
  const remoteNum = parseVersion(remoteVersion);

  if (localNum <= remoteNum) {
    log(`Version check passed: ${localVersion} <= ${remoteVersion}`);
    return;
  }

  log(`Local version ${localVersion} > remote ${remoteVersion}, re-fetching...`);

  try {
    remoteVersion = await fetchRemoteVersion();
    cacheVersion(remoteVersion);
    log(`Re-fetched remote max-version: ${remoteVersion}`);
  } catch (err) {
    log(`Re-fetch failed: ${err.message}, using previous version`);
  }

  const newRemoteNum = parseVersion(remoteVersion);
  if (localNum <= newRemoteNum) {
    log(`Version check passed after re-fetch: ${localVersion} <= ${remoteVersion}`);
    return;
  }

  log(`Version check failed: ${localVersion} > ${remoteVersion}`);
  console.error(`当前 Claude Code 版本 (${localVersion}) 不被 block-cc 支持。`);
  console.error(`block-cc 支持的最高版本为 ${remoteVersion}。`);
  console.error('请等待 block-cc 更新后重试，或降级 Claude Code。');
  process.exit(1);
}

module.exports = { checkVersion };
