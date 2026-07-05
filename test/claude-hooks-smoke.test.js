'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runSmoke = process.env.BLOCK_CC_RUN_CLAUDE_SMOKE === '1';

test('Claude Code loads temporary hooks and applies PreToolUse updatedInput', { skip: !runSmoke }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-hook-smoke-'));
  const logPath = path.join(dir, 'events.jsonl');
  const hookPath = path.join(__dirname, 'fixtures', 'hook-smoke.js');
  const settingsPath = path.join(dir, 'settings.json');

  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} user ${JSON.stringify(logPath)}` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} pre ${JSON.stringify(logPath)}` }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} post ${JSON.stringify(logPath)}` }] }],
    },
  }));

  const result = spawnSync('claude', [
    '--settings', settingsPath,
    '--print',
    '--permission-mode', 'bypassPermissions',
    'Run this exact shell command: echo block-cc-smoke',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some((event) => event.hook_event_name === 'UserPromptSubmit'), true);
  assert.equal(events.some((event) => event.hook_event_name === 'PreToolUse'), true);
  assert.equal(events.some((event) => event.hook_event_name === 'PostToolUse'), true);
  assert.match(result.stdout + result.stderr, /block-cc-smoke|block-cc-rewritten/);
});
