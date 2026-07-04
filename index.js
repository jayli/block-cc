#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const { createProxy } = require('./proxy');

const USAGE = 'Usage: npx block-cc claude';

function checkClaude() {
  const result = spawnSync('claude', ['--version'], {
    shell: true,
    stdio: 'pipe',
  });
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      'Claude Code 未安装，请先执行: npm install -g @anthropic-ai/claude-code'
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Claude Code 未安装或已损坏 (exit code: ${result.status})，请执行: npm install -g @anthropic-ai/claude-code`
    );
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'claude') {
    console.error(USAGE);
    process.exit(1);
  }

  checkClaude();

  const proxy = createProxy();

  proxy.on('error', (err) => {
    console.error(`[block-cc] Proxy error: ${err.message}`);
    process.exit(1);
  });

  proxy.listen(0, '127.0.0.1', () => {
    const port = proxy.address().port;

    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
    };

    const claude = spawn('claude', args.slice(1), {
      env,
      stdio: 'inherit',
      shell: true,
    });

    claude.on('exit', (code, signal) => {
      proxy.close();
      if (signal) {
        process.exit(code || 1);
      }
      process.exit(code || 0);
    });
  });
}

main();
