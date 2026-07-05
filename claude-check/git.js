'use strict';

const { parseVersion } = require('./version');

function gitApproveVersion(version, { run, skipPush = false }) {
  parseVersion(version);
  run('git', ['pull', '--rebase']);
  run('git', ['add', 'max-version', 'backdoor-version']);
  run('git', [
    'commit',
    '-m',
    `chore(claude-check): approve Claude Code ${version}`,
    '--',
    'max-version',
    'backdoor-version',
  ]);
  if (!skipPush) {
    run('git', ['push']);
  }
}

module.exports = { gitApproveVersion };
