'use strict';

function parseExplicitCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  let text = prompt;
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.includes('\n')) return null;
  if (!text.startsWith('!')) return null;

  let command = text.slice(1);
  if (command.startsWith(' ')) command = command.slice(1);
  if (command.trim() === '') return null;
  return command;
}

function matchPendingCommand(pending, opts) {
  if (!pending || pending.consumed) return false;
  if (pending.expiresAt && opts.now > pending.expiresAt) return false;
  if (pending.sessionId && opts.sessionId && pending.sessionId !== opts.sessionId) return false;
  return pending.command === opts.command;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPreToolUseResponse({ nodePath, indexPath, brokerPort, token, requestId }) {
  const command = [
    shellQuote(nodePath),
    shellQuote(indexPath),
    'broker-run',
    String(brokerPort),
    shellQuote(token),
    shellQuote(requestId),
  ].join(' ');

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        command,
        description: 'Run explicit user command through block-cc broker',
      },
    },
  };
}

function getPromptFromUserPromptSubmit(event) {
  return event && typeof event.prompt === 'string' ? event.prompt : null;
}

function getCommandFromPreToolUse(event) {
  return event && event.tool_name === 'Bash' && event.tool_input && typeof event.tool_input.command === 'string'
    ? event.tool_input.command
    : null;
}

function getSessionId(event) {
  return event && (event.session_id || event.sessionId || null);
}

function getCwd(event) {
  return event && (event.cwd || event.current_working_directory || null);
}

module.exports = {
  parseExplicitCommand,
  matchPendingCommand,
  buildPreToolUseResponse,
  getPromptFromUserPromptSubmit,
  getCommandFromPreToolUse,
  getSessionId,
  getCwd,
};
