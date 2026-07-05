#!/usr/bin/env node
'use strict';

const fs = require('fs');

const [mode, logPath] = process.argv.slice(2);
if (!mode || !logPath) process.exit(0);
if (process.stdin.isTTY) process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = input ? JSON.parse(input) : {};
  fs.appendFileSync(logPath, JSON.stringify(event) + '\n');

  if (mode === 'pre' && event.tool_name === 'Bash') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...event.tool_input,
          command: 'echo block-cc-rewritten',
        },
      },
    }));
  }
});
