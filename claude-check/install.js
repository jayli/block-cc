'use strict';

const { parseVersion } = require('./version');

function failureMessage(err) {
  if (!err) return 'unknown error';
  if (err.message) return err.message;
  return String(err);
}

function installClaudeVersion(version, { run }) {
  const explicitVersion = Boolean(version);
  if (explicitVersion) parseVersion(version);
  const claudeArgs = explicitVersion ? ['install', version] : ['install'];

  let claudeError;
  try {
    run('claude', claudeArgs, { stdio: 'inherit' });
    return;
  } catch (err) {
    claudeError = err;
  }

  if (!explicitVersion) {
    throw new Error(`Failed to install latest Claude Code: claude install failed: ${failureMessage(claudeError)}`);
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
