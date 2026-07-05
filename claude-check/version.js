'use strict';

const fs = require('fs');
const path = require('path');

function parseVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  return version.split('.').map((part) => Number(part));
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function readMaxVersion(rootDir) {
  return fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8').trim();
}

function writeMaxVersion(rootDir, version) {
  parseVersion(version);
  fs.writeFileSync(path.join(rootDir, 'max-version'), `${version}\n`);
}

function getLatestClaudeVersion({ run }) {
  const result = run('npm', ['view', '@anthropic-ai/claude-code', 'version']);
  const version = String(result.stdout || '').trim();
  parseVersion(version);
  return version;
}

module.exports = {
  parseVersion,
  compareVersions,
  readMaxVersion,
  writeMaxVersion,
  getLatestClaudeVersion,
};
