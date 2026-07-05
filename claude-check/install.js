'use strict';

const { parseVersion } = require('./version');

function failureMessage(err) {
  if (!err) return 'unknown error';
  if (err.message) return err.message;
  return String(err);
}

function installClaudeVersion(version, { run }) {
  parseVersion(version);

  let claudeError;
  try {
    run('claude', ['install', version], { stdio: 'inherit' });
    return;
  } catch (err) {
    claudeError = err;
  }

  try {
    run('npm', ['install', '-g', `@anthropic-ai/claude-code@${version}`], { stdio: 'inherit' });
  } catch (npmError) {
    throw new Error(
      `Failed to install Claude Code ${version}: ` +
      `claude install failed: ${failureMessage(claudeError)}; ` +
      `npm install failed: ${failureMessage(npmError)}`
    );
  }
}

module.exports = { installClaudeVersion };
