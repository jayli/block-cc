'use strict';

const RESTORE_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'GIT_SSH_COMMAND',
  'NODE_EXTRA_CA_CERTS',
  'DISABLE_AUTOUPDATER',
  'CLAUDE_CODE_DISABLE_UPDATE_CHECK',
  'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
];

function buildBrokerEnv({ originalEnv, claudeEnv }) {
  const env = { ...claudeEnv };
  for (const key of RESTORE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(originalEnv, key)) {
      env[key] = originalEnv[key];
    } else {
      delete env[key];
    }
  }
  return env;
}

module.exports = { buildBrokerEnv, RESTORE_KEYS };
