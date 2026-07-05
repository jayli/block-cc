'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseExplicitCommand,
  buildPreToolUseResponse,
  matchPendingCommand,
  getPromptFromUserPromptSubmit,
  getCommandFromPreToolUse,
  getSessionId,
  getCwd,
} = require('../hooks');

test('parseExplicitCommand accepts single-line bang commands', () => {
  assert.equal(parseExplicitCommand('!git push'), 'git push');
  assert.equal(parseExplicitCommand('! git push'), 'git push');
  assert.equal(parseExplicitCommand('! npm test -- --grep network\n'), 'npm test -- --grep network');
});

test('parseExplicitCommand rejects non-explicit prompts', () => {
  assert.equal(parseExplicitCommand('please run !npm test'), null);
  assert.equal(parseExplicitCommand('!npm test\nthen summarize'), null);
  assert.equal(parseExplicitCommand('!'), null);
  assert.equal(parseExplicitCommand('!   '), null);
});

test('matchPendingCommand requires strict command equality and unused request', () => {
  const pending = {
    requestId: 'r1',
    command: 'npm test',
    sessionId: 's1',
    consumed: false,
    createdAt: Date.now(),
  };

  assert.equal(matchPendingCommand(pending, { command: 'npm test', sessionId: 's1', now: Date.now() }), true);
  assert.equal(matchPendingCommand(pending, { command: 'npm  test', sessionId: 's1', now: Date.now() }), false);
  assert.equal(matchPendingCommand({ ...pending, consumed: true }, { command: 'npm test', sessionId: 's1', now: Date.now() }), false);
});

test('buildPreToolUseResponse rewrites Bash command with broker-run request id', () => {
  const response = buildPreToolUseResponse({
    nodePath: '/usr/local/bin/node',
    indexPath: '/repo/index.js',
    brokerPort: 12345,
    token: 'tok-xyz',
    requestId: 'abc123',
  });

  assert.equal(response.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(response.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(response.hookSpecificOutput.updatedInput.command, /broker-run/);
  assert.match(response.hookSpecificOutput.updatedInput.command, /abc123/);
  assert.doesNotMatch(response.hookSpecificOutput.updatedInput.command, /npm test/);
});

test('hook event helpers extract prompt command session and cwd', () => {
  const userEvent = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 's1',
    cwd: '/tmp/work',
    prompt: '!echo ok',
  };
  const preEvent = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/tmp/work',
    tool_name: 'Bash',
    tool_input: { command: 'echo ok' },
  };

  assert.equal(getPromptFromUserPromptSubmit(userEvent), '!echo ok');
  assert.equal(getCommandFromPreToolUse(preEvent), 'echo ok');
  assert.equal(getSessionId(userEvent), 's1');
  assert.equal(getCwd(preEvent), '/tmp/work');
});
