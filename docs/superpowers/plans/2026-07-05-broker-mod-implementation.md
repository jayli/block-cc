# Broker Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement constrained broker mode so exact user-entered `!cmd` prompts can run outside the macOS sandbox while Claude-generated Bash commands remain sandboxed.

**Architecture:** Launch Claude Code with a temporary `--settings <tmp-settings.json>` hook configuration. `UserPromptSubmit` records exact explicit `!cmd` requests, `PreToolUse(Bash)` uses `updatedInput.command` to replace the matching Bash command with `broker-run <request-id>`, and an unsandboxed parent broker executes only server-side registered commands.

**Tech Stack:** Node.js standard library only (`fs`, `os`, `path`, `net`, `child_process`, `crypto`), Claude Code hooks, macOS `sandbox-exec`, Node built-in test runner.

**Design doc:** `docs/superpowers/specs/2026-07-05-broker-mod-design.md`

---

## File Structure

Create focused modules instead of growing `index.js` further:

- `broker.js`
  - Owns broker server lifecycle, pending request registry, request queue, Unix socket protocol, command execution, timeout/cancellation, output truncation, environment restoration.
- `broker-env.js`
  - Builds the environment for unsandboxed broker commands from the original parent environment and removes/restores block-cc injected Claude-only variables.
- `hooks.js`
  - Pure hook logic: parse hook JSON, detect explicit `!cmd`, match Bash command, build `updatedInput` response, parse broker-run output for `PostToolUse`.
- `hook-settings.js`
  - Creates temporary hook scripts and `--settings` JSON, manages cleanup paths, keeps hook configuration free of reusable command secrets.
- `index.js`
  - Adds CLI subcommands used by hooks: `hook user-prompt-submit`, `hook pre-tool-use`, `hook post-tool-use`, and `broker-run`.
  - Starts broker server and passes hook settings to `spawnClaude`.
- `sandbox.js`
  - Update `spawnClaude` and `spawnClaudeSync` only if argument passing needs to include generated `--settings`.
- `test/broker.test.js`
  - Unit/integration tests for broker registry, consume protocol, command execution, output limits, timeout.
- `test/broker-env.test.js`
  - Tests broker command environment restoration.
- `test/hooks.test.js`
  - Unit tests for prompt detection, strict matching, hook JSON responses.
- `test/hook-settings.test.js`
  - Tests temporary settings generation and cleanup behavior.
- `test/index.test.js`
  - Regression tests for startup argv, env construction, existing SSH proxy behavior.

Keep existing files untouched unless the task explicitly names them.

---

### Task 1: Feasibility Smoke Harness

**Files:**
- Create: `test/claude-hooks-smoke.test.js`
- Create: `test/fixtures/hook-smoke.js`

Purpose: prove the installed Claude Code supports the hook behavior the design depends on before implementing the full broker.

- [ ] **Step 1: Write a skipped-by-default smoke test skeleton**

Create `test/claude-hooks-smoke.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runSmoke = process.env.BLOCK_CC_RUN_CLAUDE_SMOKE === '1';

test('Claude Code loads temporary hooks and applies PreToolUse updatedInput', { skip: !runSmoke }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-hook-smoke-'));
  const logPath = path.join(dir, 'events.jsonl');
  const hookPath = path.join(__dirname, 'fixtures', 'hook-smoke.js');
  const settingsPath = path.join(dir, 'settings.json');

  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} user ${JSON.stringify(logPath)}` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} pre ${JSON.stringify(logPath)}` }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${JSON.stringify(hookPath)} post ${JSON.stringify(logPath)}` }] }],
    },
  }));

  const result = spawnSync('claude', [
    '--settings', settingsPath,
    '--print',
    '--permission-mode', 'bypassPermissions',
    'Run this exact shell command: echo block-cc-smoke',
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some((event) => event.hook_event_name === 'UserPromptSubmit'), true);
  assert.equal(events.some((event) => event.hook_event_name === 'PreToolUse'), true);
  assert.equal(events.some((event) => event.hook_event_name === 'PostToolUse'), true);
  assert.match(result.stdout + result.stderr, /block-cc-smoke|block-cc-rewritten/);
});
```

- [ ] **Step 2: Create hook fixture**

Create `test/fixtures/hook-smoke.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');

const [mode, logPath] = process.argv.slice(2);
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
```

- [ ] **Step 3: Run smoke test disabled**

Run: `node --test test/claude-hooks-smoke.test.js`

Expected: PASS with the test skipped.

- [ ] **Step 4: Run smoke test explicitly**

Run: `BLOCK_CC_RUN_CLAUDE_SMOKE=1 node --test test/claude-hooks-smoke.test.js`

Expected: PASS on Claude Code `2.1.201`. If this fails because `updatedInput` is ignored, stop implementation and update the design.

- [ ] **Step 5: Commit**

```bash
git add test/claude-hooks-smoke.test.js test/fixtures/hook-smoke.js
git commit -m "test: add Claude hook feasibility smoke test"
```

---

### Task 2: Hook Pure Functions

**Files:**
- Create: `hooks.js`
- Create: `test/hooks.test.js`

- [ ] **Step 1: Write failing tests for explicit command parsing**

Create `test/hooks.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseExplicitCommand,
  buildPreToolUseResponse,
  matchPendingCommand,
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
    requestId: 'abc123',
  });

  assert.equal(response.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(response.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(response.hookSpecificOutput.updatedInput.command, /broker-run abc123/);
  assert.doesNotMatch(response.hookSpecificOutput.updatedInput.command, /npm test/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/hooks.test.js`

Expected: FAIL because `../hooks` does not exist.

- [ ] **Step 3: Implement `hooks.js`**

Create `hooks.js`:

```js
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

function buildPreToolUseResponse({ nodePath, indexPath, requestId }) {
  const command = [
    shellQuote(nodePath),
    shellQuote(indexPath),
    'broker-run',
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

module.exports = {
  parseExplicitCommand,
  matchPendingCommand,
  buildPreToolUseResponse,
};
```

- [ ] **Step 4: Run tests**

Run: `node --test test/hooks.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks.js test/hooks.test.js
git commit -m "feat: add broker hook command matching helpers"
```

---

### Task 3: Broker Registry and Consume Protocol

**Files:**
- Create: `broker.js`
- Create: `test/broker.test.js`

- [ ] **Step 1: Write failing broker registry tests**

Create `test/broker.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BrokerRegistry } = require('../broker');

test('BrokerRegistry registers and consumes command once', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  const request = registry.register({
    command: 'npm test',
    cwd: process.cwd(),
    sessionId: 's1',
    now: 1000,
  });

  assert.equal(typeof request.requestId, 'string');
  const consumed = registry.consume({ requestId: request.requestId, now: 1001 });
  assert.equal(consumed.command, 'npm test');
  assert.throws(() => registry.consume({ requestId: request.requestId, now: 1002 }), /already consumed/);
});

test('BrokerRegistry rejects expired requests', () => {
  const registry = new BrokerRegistry({ ttlMs: 10 });
  const request = registry.register({
    command: 'npm test',
    cwd: process.cwd(),
    now: 1000,
  });

  assert.throws(() => registry.consume({ requestId: request.requestId, now: 1011 }), /expired/);
});

test('BrokerRegistry rejects unknown requests', () => {
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  assert.throws(() => registry.consume({ requestId: 'missing', now: 1000 }), /unknown/);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/broker.test.js`

Expected: FAIL because `../broker` does not exist.

- [ ] **Step 3: Implement registry**

Create `broker.js`:

```js
'use strict';

const crypto = require('crypto');

class BrokerRegistry {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || 30000;
    this.pending = new Map();
  }

  register({ command, cwd, sessionId, now = Date.now() }) {
    if (!command) throw new Error('command is required');
    const requestId = crypto.randomBytes(16).toString('hex');
    const request = {
      requestId,
      command,
      cwd,
      sessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      consumed: false,
    };
    this.pending.set(requestId, request);
    return request;
  }

  consume({ requestId, now = Date.now() }) {
    const request = this.pending.get(requestId);
    if (!request) throw new Error('unknown broker request');
    if (request.consumed) throw new Error('broker request already consumed');
    if (now > request.expiresAt) throw new Error('broker request expired');
    request.consumed = true;
    return { ...request };
  }
}

module.exports = { BrokerRegistry };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/broker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.js test/broker.test.js
git commit -m "feat: add broker request registry"
```

---

### Task 4: Broker Command Execution

**Files:**
- Modify: `broker.js`
- Modify: `test/broker.test.js`

- [ ] **Step 1: Add failing tests for command execution**

Append to `test/broker.test.js`:

```js
const { runBrokerCommand } = require('../broker');

test('runBrokerCommand captures stdout stderr and exit code', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "console.log('out'); console.error('err')"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /out/);
  assert.match(result.stderr, /err/);
  assert.equal(result.timedOut, false);
});

test('runBrokerCommand truncates large output', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "process.stdout.write('x'.repeat(2000))"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 100,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 160);
});

test('runBrokerCommand terminates on timeout', async () => {
  const result = await runBrokerCommand({
    command: `${process.execPath} -e "setTimeout(() => {}, 10000)"`,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 50,
    maxOutputBytes: 1024,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/broker.test.js`

Expected: FAIL because `runBrokerCommand` does not exist.

- [ ] **Step 3: Implement `runBrokerCommand`**

Add to `broker.js`:

```js
const { spawn } = require('child_process');

function appendLimited(current, chunk, state) {
  if (state.size >= state.maxOutputBytes) {
    state.truncated = true;
    return current;
  }
  const remaining = state.maxOutputBytes - state.size;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  state.size += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  return current + slice.toString();
}

function runBrokerCommand({ command, cwd, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const shell = env.SHELL || '/bin/sh';
    const startedAt = Date.now();
    const outputState = { size: 0, maxOutputBytes, truncated: false };
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(shell, ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk, outputState);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk, outputState);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}${err.message}\n`,
        timedOut,
        truncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code == null ? 1 : code,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
```

Export it:

```js
module.exports = { BrokerRegistry, runBrokerCommand };
```

- [ ] **Step 4: Run broker tests**

Run: `node --test test/broker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.js test/broker.test.js
git commit -m "feat: execute broker commands with limits"
```

---

### Task 5: Broker Command Environment

**Files:**
- Create: `broker-env.js`
- Create: `test/broker-env.test.js`

- [ ] **Step 1: Write failing environment restoration tests**

Create `test/broker-env.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBrokerEnv } = require('../broker-env');

test('buildBrokerEnv removes block-cc injected values absent from original env', () => {
  const env = buildBrokerEnv({
    originalEnv: { PATH: '/usr/bin' },
    claudeEnv: {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://127.0.0.1:1234',
      HTTPS_PROXY: 'http://127.0.0.1:1234',
      http_proxy: 'http://127.0.0.1:1234',
      https_proxy: 'http://127.0.0.1:1234',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      GIT_SSH_COMMAND: 'ssh -o ProxyCommand="node index.js ssh-proxy"',
      NODE_EXTRA_CA_CERTS: '/tmp/block-cc-ca.pem',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    },
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.no_proxy, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(env.DISABLE_AUTOUPDATER, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_UPDATE_CHECK, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, undefined);
});

test('buildBrokerEnv preserves original user proxy and Claude-related values', () => {
  const originalEnv = {
    PATH: '/usr/bin',
    HTTP_PROXY: 'http://proxy.local:8080',
    NO_PROXY: 'internal.local',
    GIT_SSH_COMMAND: 'ssh -i ~/.ssh/custom',
    NODE_EXTRA_CA_CERTS: '/tmp/original.pem',
    DISABLE_AUTOUPDATER: 'user-value',
  };

  const env = buildBrokerEnv({
    originalEnv,
    claudeEnv: {
      ...originalEnv,
      HTTP_PROXY: 'http://127.0.0.1:1234',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      GIT_SSH_COMMAND: 'ssh -o ProxyCommand="node index.js ssh-proxy"',
      NODE_EXTRA_CA_CERTS: '/tmp/original.pem:/tmp/block-cc-ca.pem',
      DISABLE_AUTOUPDATER: '1',
    },
  });

  assert.equal(env.HTTP_PROXY, 'http://proxy.local:8080');
  assert.equal(env.NO_PROXY, 'internal.local');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i ~/.ssh/custom');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/original.pem');
  assert.equal(env.DISABLE_AUTOUPDATER, 'user-value');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/broker-env.test.js`

Expected: FAIL because `../broker-env` does not exist.

- [ ] **Step 3: Implement `broker-env.js`**

Create `broker-env.js`:

```js
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
```

- [ ] **Step 4: Run tests**

Run: `node --test test/broker-env.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-env.js test/broker-env.test.js
git commit -m "feat: restore environment for broker commands"
```

---

### Task 6: Unix Socket Broker Server

**Files:**
- Modify: `broker.js`
- Modify: `test/broker.test.js`

- [ ] **Step 1: Add failing integration test for consume socket**

Append to `test/broker.test.js`:

```js
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrokerServer } = require('../broker');

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(data)));
    socket.on('connect', () => {
      socket.end(JSON.stringify(payload) + '\n');
    });
  });
}

test('createBrokerServer consumes registered command over Unix socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-broker-test-'));
  const socketPath = path.join(dir, 'b.sock');
  const registry = new BrokerRegistry({ ttlMs: 1000 });
  const pending = registry.register({
    command: `${process.execPath} -e "console.log('broker-ok')"`,
    cwd: process.cwd(),
  });
  const server = createBrokerServer({
    socketPath,
    registry,
    env: process.env,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });

  await server.listen();
  try {
    const response = await request(socketPath, { type: 'consume', requestId: pending.requestId });
    assert.equal(response.ok, true);
    assert.equal(response.result.exitCode, 0);
    assert.match(response.result.stdout, /broker-ok/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/broker.test.js`

Expected: FAIL because `createBrokerServer` does not exist.

- [ ] **Step 3: Implement server**

Add `createBrokerServer` to `broker.js` using `net.createServer`. Protocol is one JSON line request, one JSON response, then close.

Implementation requirements:

- reject malformed JSON with `{ ok: false, error: 'malformed request' }`
- reject unknown type
- consume request through `registry.consume`
- execute command with `runBrokerCommand`
- serialize `{ ok: true, result }`
- cleanup socket file on close

- [ ] **Step 4: Run broker tests**

Run: `node --test test/broker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.js test/broker.test.js
git commit -m "feat: add Unix socket broker server"
```

---

### Task 7: Hook Settings Generation

**Files:**
- Create: `hook-settings.js`
- Create: `test/hook-settings.test.js`

- [ ] **Step 1: Write failing settings tests**

Create `test/hook-settings.test.js`:

```js
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
    brokerSocketPath: '/tmp/block-cc-test/b.sock',
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/hook-settings.test.js`

Expected: FAIL because `../hook-settings` does not exist.

- [ ] **Step 3: Implement `hook-settings.js`**

Create `hook-settings.js`:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createHookSettings({ nodePath, indexPath, brokerSocketPath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-hooks-'));
  fs.chmodSync(dir, 0o700);
  const settingsPath = path.join(dir, 'settings.json');

  const base = `${quote(nodePath)} ${quote(indexPath)}`;
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${base} hook user-prompt-submit ${quote(brokerSocketPath)}` }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${base} hook pre-tool-use ${quote(brokerSocketPath)}` }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${base} hook post-tool-use ${quote(brokerSocketPath)}` }] }],
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
```

- [ ] **Step 4: Run tests**

Run: `node --test test/hook-settings.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hook-settings.js test/hook-settings.test.js
git commit -m "feat: generate temporary Claude hook settings"
```

---

### Task 8: Hook Event Parsing and Broker Client

**Files:**
- Modify: `hooks.js`
- Create: `broker-client.js`
- Create: `test/broker-client.test.js`
- Modify: `test/hooks.test.js`

- [ ] **Step 1: Add failing tests for hook event parsing**

Extend `test/hooks.test.js` with helpers that do not assume unverified field names without fallback:

```js
const {
  getPromptFromUserPromptSubmit,
  getCommandFromPreToolUse,
  getSessionId,
  getCwd,
} = require('../hooks');

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
```

- [ ] **Step 2: Add failing broker client tests**

Create `test/broker-client.test.js` with a fake Unix socket server and assert:

- client sends JSON line request
- client parses JSON response
- socket error returns a rejected promise

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --test test/hooks.test.js test/broker-client.test.js
```

Expected: FAIL because helpers/client do not exist.

- [ ] **Step 4: Implement event helpers**

In `hooks.js`, add:

```js
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
```

If smoke tests show different field names, update these helpers and tests before implementing production behavior.

- [ ] **Step 5: Implement broker client**

Create `broker-client.js`:

```js
'use strict';

const net = require('net');

function sendBrokerRequest(socketPath, payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('broker request timed out'));
    }, timeoutMs);
    timer.unref();

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('invalid broker response'));
      }
    });
  });
}

module.exports = { sendBrokerRequest };
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test test/hooks.test.js test/broker-client.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hooks.js broker-client.js test/hooks.test.js test/broker-client.test.js
git commit -m "feat: add hook event parsing and broker client"
```

---

### Task 9: Hook CLI Subcommands

**Files:**
- Modify: `index.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Add failing tests for hook subcommands**

Add tests that run:

```bash
node index.js hook user-prompt-submit <socket>
node index.js hook pre-tool-use <socket>
node index.js hook post-tool-use <socket>
```

Use a fake broker socket server to assert:

- `user-prompt-submit` sends register request for `!echo ok`
- `pre-tool-use` gets pending match from broker and prints `updatedInput`
- `pre-tool-use` prints nothing for non-match
- `pre-tool-use` prints nothing and exits 0 when broker socket is unavailable
- malformed hook JSON exits 0 without output so Claude continues normal flow

The test should invoke child processes with JSON on stdin and parse stdout.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/index.test.js`

Expected: FAIL because hook subcommands do not exist.

- [ ] **Step 3: Implement hook subcommand routing in `index.js`**

Add before `claude` command handling:

```js
if (args[0] === 'hook') {
  runHookCommand(args.slice(1));
  return;
}
```

Implementation notes:

- read JSON from stdin
- for `user-prompt-submit`, use `parseExplicitCommand`
- send `{ type: 'register', command, cwd, sessionId }` to broker
- if register fails, print nothing and exit 0 so the original prompt continues
- for `pre-tool-use`, send `{ type: 'match', command, sessionId }` to broker
- if broker returns matched request id, print `buildPreToolUseResponse(...)`
- if match fails or broker is unavailable, print nothing and exit 0 so the Bash command runs inside the sandbox
- for `post-tool-use`, initially print nothing unless smoke tests prove `additionalContext` is necessary

This requires extending broker server protocol to handle `register` and `match`, not only `consume`.

- [ ] **Step 4: Run tests**

Run: `node --test test/index.test.js test/hooks.test.js test/broker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.js broker.js test/index.test.js
git commit -m "feat: add broker hook CLI commands"
```

---

### Task 10: Broker Protocol Register, Match, and FIFO Queue

**Files:**
- Modify: `broker.js`
- Modify: `test/broker.test.js`

- [ ] **Step 1: Add failing protocol tests**

Add tests for:

- `{ type: 'register', command, cwd, sessionId }`
- `{ type: 'match', command, sessionId }`
- match returns request id without consuming
- consume later consumes that id
- non-matching command returns `{ matched: false }`
- matching uses FIFO when repeated identical commands are pending
- when session id is present on both request and match, mismatched sessions do not match
- when match lacks session id, command equality plus FIFO is used and the response includes `sessionIdMissing: true`

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/broker.test.js`

Expected: FAIL until protocol is extended.

- [ ] **Step 3: Extend `BrokerRegistry`**

Add:

```js
findMatching({ command, sessionId, now })
```

Return the oldest unconsumed non-expired request with the same command. If both
the pending request and matcher have session id, require equality. If matcher
has no session id, allow command-only matching and include a marker for logging.

- [ ] **Step 4: Extend socket server**

Handle:

- `register`: registry.register and return request id
- `match`: registry.findMatching and return `{ matched, requestId }`
- `consume`: existing execute path

- [ ] **Step 5: Run tests**

Run: `node --test test/broker.test.js test/index.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add broker.js test/broker.test.js test/index.test.js
git commit -m "feat: support broker register and match protocol"
```

---

### Task 11: Broker Execution Queue

**Files:**
- Modify: `broker.js`
- Modify: `test/broker.test.js`

- [ ] **Step 1: Add failing concurrency tests**

Add a test that registers two commands and sends two concurrent consume requests to the broker socket.

Expected behavior:

- first command starts immediately
- second command waits until first exits
- outputs are not interleaved in each response
- both responses succeed in FIFO order

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/broker.test.js`

Expected: FAIL until queueing exists.

- [ ] **Step 3: Implement single-session FIFO execution queue**

Implementation guidance:

- keep `let running = Promise.resolve()` inside broker server
- enqueue each consume execution by chaining onto `running`
- registration and matching remain immediate
- consume request should hold the socket open until its command finishes

- [ ] **Step 4: Run tests**

Run: `node --test test/broker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.js test/broker.test.js
git commit -m "feat: queue broker command execution"
```

---

### Task 12: Wire Broker Into Claude Startup

**Files:**
- Modify: `index.js`
- Modify: `sandbox.js`
- Modify: `test/index.test.js`

- [ ] **Step 1: Add failing startup test**

Extend fake `claude` in `test/index.test.js` to record argv and assert launched args include:

```text
--settings <tmp settings path>
```

Also assert the settings file exists while fake Claude runs and includes hook commands.

- [ ] **Step 1b: Add failing test for user --settings conflict**

Invoke:

```bash
node index.js claude --settings /tmp/custom-settings.json
```

Expected: exits non-zero with a clear error that broker mode does not yet support user-provided `--settings`.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/index.test.js`

Expected: FAIL because `--settings` is not passed.

- [ ] **Step 3: Update startup flow**

In `index.js`:

- create broker temp dir and socket path before spawning Claude
- create `BrokerRegistry`
- start broker server
- create hook settings with `createHookSettings`
- fail fast if user args already contain `--settings`
- append `--settings <settingsPath>` to Claude args
- on Claude exit: close proxy, close broker server, cleanup hook settings
- build broker command env with `buildBrokerEnv({ originalEnv: process.env, claudeEnv: env })`

Keep `claude --version` check unchanged except it should not require broker hooks.

- [ ] **Step 4: Update `sandbox.js` only if necessary**

If `spawnClaude(args, env, log)` already accepts arbitrary args, no change is needed.

- [ ] **Step 5: Run tests**

Run: `node --test test/index.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add index.js sandbox.js test/index.test.js
git commit -m "feat: launch Claude with broker hook settings"
```

---

### Task 13: End-to-End Local Broker Flow Without Claude

**Files:**
- Modify: `test/index.test.js`
- Modify: `test/broker.test.js`

- [ ] **Step 1: Add local full-flow test**

Use only Node processes and the broker socket:

1. Start broker server.
2. Invoke `node index.js hook user-prompt-submit <socket>` with event `{ hook_event_name: 'UserPromptSubmit', prompt: '!echo broker-ok' }`.
3. Invoke `node index.js hook pre-tool-use <socket>` with event `{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo broker-ok' } }`.
4. Parse `updatedInput.command`.
5. Execute that command with `spawnSync`.
6. Assert output contains `broker-ok`.
7. Try executing same command again and assert failure.

- [ ] **Step 2: Run local full-flow test to verify failure if needed**

Run: `node --test test/index.test.js test/broker.test.js`

Expected: PASS after prior tasks; fix gaps if it fails.

- [ ] **Step 3: Commit**

```bash
git add test/index.test.js test/broker.test.js
git commit -m "test: cover broker hook rewrite flow"
```

---

### Task 14: Real Claude and Sandbox Smoke Tests

**Files:**
- Modify: `test/claude-hooks-smoke.test.js`

- [ ] **Step 1: Extend smoke test for full broker flow**

Add a skipped-by-default smoke test that runs Claude Code with block-cc broker mode against a harmless command:

```bash
BLOCK_CC_RUN_CLAUDE_SMOKE=1 node --test test/claude-hooks-smoke.test.js
```

The command should be local-only first:

```text
! echo broker-smoke
```

Then a network command can be manually tested:

```text
! node -e "require('https').get('https://example.com', r => { console.log(r.statusCode); r.resume(); })"
```

- [ ] **Step 2: Verify smoke result**

Expected:

- hooks load through `--settings`
- `UserPromptSubmit` records request
- `PreToolUse.updatedInput` rewrites Bash
- broker-run output appears as Bash tool output
- Claude can summarize or refer to output

- [ ] **Step 3: Add sandbox-exec Unix socket smoke**

Add a skipped-by-default smoke that:

1. Starts a parent Unix socket broker outside sandbox.
2. Runs `sandbox-exec` with the current block-cc profile.
3. Inside sandbox, invokes `node index.js broker-run <request-id>`.
4. Asserts the sandboxed process can connect to the Unix socket.
5. Asserts a direct external TCP command inside sandbox fails with `Operation not permitted`.
6. Asserts the broker-executed command runs outside sandbox and can perform the intended network access when the environment allows it.

Run:

```bash
BLOCK_CC_RUN_SANDBOX_SMOKE=1 node --test test/claude-hooks-smoke.test.js
```

Expected: PASS on macOS where `sandbox-exec` is available. If Unix socket connection fails under sandbox, stop and update the design.

- [ ] **Step 4: Commit**

```bash
git add test/claude-hooks-smoke.test.js
git commit -m "test: add broker mode Claude and sandbox smoke coverage"
```

---

### Task 15: Documentation and Final Verification

**Files:**
- Modify: `README.md` only if user explicitly requests public documentation.
- Modify: `docs/superpowers/specs/2026-07-05-broker-mod-design.md` if implementation discovers behavior changes.
- Modify: `docs/superpowers/plans/2026-07-05-broker-mod-implementation.md` if task ordering changes.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test test/hooks.test.js
node --test test/broker.test.js
node --test test/broker-env.test.js
node --test test/broker-client.test.js
node --test test/hook-settings.test.js
node --test test/index.test.js
```

Expected: all pass.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run optional Claude smoke**

Run only on a machine with Claude Code configured:

```bash
BLOCK_CC_RUN_CLAUDE_SMOKE=1 node --test test/claude-hooks-smoke.test.js
```

Expected: all non-skipped smoke tests pass.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only broker mode implementation files, tests, and approved docs changed.

- [ ] **Step 5: Commit final documentation updates**

```bash
git add docs/superpowers/specs/2026-07-05-broker-mod-design.md docs/superpowers/plans/2026-07-05-broker-mod-implementation.md
git commit -m "docs: update broker mode implementation plan"
```

Do this only when the user explicitly asks to commit.
