'use strict';

const fs = require('fs');
const path = require('path');

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createHookSettings({ nodePath, indexPath, brokerPort, brokerToken }) {
  // Use /tmp instead of os.tmpdir() — sandbox-exec blocks access to /var/folders
  const dir = fs.mkdtempSync(path.join('/tmp', 'block-cc-hooks-'));
  fs.chmodSync(dir, 0o700);
  const settingsPath = path.join(dir, 'settings.json');

  const base = `${quote(nodePath)} ${quote(indexPath)}`;
  const settings = {
    hooks: {
      UserPromptSubmit: [{
        hooks: [
          { type: 'command', command: `touch /tmp/hook-ups-ok-${brokerPort}` },
          { type: 'command', command: `${base} hook user-prompt-submit ${brokerPort} ${quote(brokerToken)}` },
        ],
      }],
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: `touch /tmp/hook-ptu-ok-${brokerPort}` },
          { type: 'command', command: `${base} hook pre-tool-use ${brokerPort} ${quote(brokerToken)}` },
        ],
      }],
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: `touch /tmp/hook-post-ok-${brokerPort}` },
          { type: 'command', command: `${base} hook post-tool-use ${brokerPort} ${quote(brokerToken)}` },
        ],
      }],
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  fs.chmodSync(settingsPath, 0o600);

  return {
    dir,
    settingsPath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { createHookSettings };
