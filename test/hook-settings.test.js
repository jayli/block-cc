'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createHookSettings } = require('../hook-settings');

test('createHookSettings writes temporary settings with broker hooks', () => {
  const created = createHookSettings({
    nodePath: '/usr/local/bin/node',
    indexPath: '/repo/index.js',
    brokerPort: 12345,
    brokerToken: 'test-token-abc',
  });

  try {
    const settings = JSON.parse(fs.readFileSync(created.settingsPath, 'utf8'));
    assert.ok(settings.hooks.UserPromptSubmit);
    assert.ok(settings.hooks.PreToolUse);
    assert.ok(settings.hooks.PostToolUse);
    const serialized = JSON.stringify(settings);
    assert.match(serialized, /hook user-prompt-submit/);
    assert.match(serialized, /hook pre-tool-use/);
    assert.match(serialized, /hook post-tool-use/);
    assert.doesNotMatch(serialized, /npm test/);
  } finally {
    created.cleanup();
  }

  assert.equal(fs.existsSync(path.dirname(created.settingsPath)), false);
});
