'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseVersion,
  compareVersions,
  readMaxVersion,
  writeMaxVersion,
  getLatestClaudeVersion,
} = require('../claude-check/version');
const { installClaudeVersion } = require('../claude-check/install');

test('compareVersions orders semver triples', () => {
  assert.equal(compareVersions('2.1.202', '2.1.201'), 1);
  assert.equal(compareVersions('2.1.201', '2.1.201'), 0);
  assert.equal(compareVersions('2.1.200', '2.1.201'), -1);
  assert.equal(compareVersions('2.2.0', '2.1.999'), 1);
});

test('parseVersion rejects unsupported version strings', () => {
  assert.throws(() => parseVersion('2.1'), /Invalid version/);
  assert.throws(() => parseVersion('latest'), /Invalid version/);
  assert.throws(() => parseVersion('2.1.3-beta.1'), /Invalid version/);
});

test('readMaxVersion and writeMaxVersion use repository max-version file', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-version-'));

  writeMaxVersion(rootDir, '2.1.202');

  assert.equal(fs.readFileSync(path.join(rootDir, 'max-version'), 'utf8'), '2.1.202\n');
  assert.equal(readMaxVersion(rootDir), '2.1.202');
});

test('getLatestClaudeVersion reads npm view output', () => {
  const calls = [];
  const latest = getLatestClaudeVersion({
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '2.1.202\n' };
    },
  });

  assert.equal(latest, '2.1.202');
  assert.deepEqual(calls[0], {
    command: 'npm',
    args: ['view', '@anthropic-ai/claude-code', 'version'],
  });
});

test('getLatestClaudeVersion rejects invalid npm output', () => {
  assert.throws(() => getLatestClaudeVersion({
    run() {
      return { stdout: 'latest\n' };
    },
  }), /Invalid version/);
});

test('installClaudeVersion falls back to npm global install', () => {
  const calls = [];

  installClaudeVersion('2.1.202', {
    run(command, args) {
      calls.push({ command, args });
      if (command === 'claude') {
        const err = new Error('install failed');
        err.status = 1;
        throw err;
      }
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls, [
    { command: 'claude', args: ['install', '2.1.202'] },
    { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@2.1.202'] },
  ]);
});

test('installClaudeVersion does not fall back when claude install succeeds', () => {
  const calls = [];

  installClaudeVersion('2.1.202', {
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls, [
    { command: 'claude', args: ['install', '2.1.202'] },
  ]);
});

test('installClaudeVersion includes both failures when install methods fail', () => {
  assert.throws(() => installClaudeVersion('2.1.202', {
    run(command) {
      throw new Error(`${command} failed`);
    },
  }), /claude failed.*npm failed/s);
});
