# Claude Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `npm run claude_check`, a zero-dependency checker that installs newer Claude Code releases, observes whether they bypass proxy configuration with direct TCP/UDP traffic, records results, and auto-approves passing versions.

**Architecture:** Add a focused `claude-check/` Node.js module set: version lookup/comparison, installer, local CONNECT proxy, `lsof` monitor, result writer, git helper, and main orchestrator. Keep external side effects injectable so tests can mock npm, Claude, `lsof`, timers, and git without real installs or pushes.

**Tech Stack:** Node.js CommonJS, Node built-in test runner, standard library only, macOS `lsof`/`ps` at runtime.

---

## Implementation Constraints

- Do not commit or push during implementation unless the user explicitly confirms.
- Do not change `README.md` or `CLAUDE.md`.
- Keep all checker implementation files under `claude-check/`.
- Use only Node.js standard library APIs.
- Tests must not invoke real `npm view`, install Claude Code, spawn real `claude`, or push git.
- Run `npm test` after behavior changes.

## File Map

- Create `claude-check/version.js`: version validation, comparison, `max-version` read/write, npm latest lookup through injectable runner.
- Create `claude-check/install.js`: `claude install <version>` with npm global install fallback.
- Create `claude-check/proxy.js`: minimal HTTP CONNECT proxy used only by the checker.
- Create `claude-check/monitor.js`: parse `lsof`, discover PID descendants with `ps`, classify direct TCP/UDP findings.
- Create `claude-check/result.js`: format and append `backdoor-version` records.
- Create `claude-check/git.js`: stage only `max-version` and `backdoor-version`, commit approval, push.
- Create `claude-check/index.js`: orchestrate the full checker flow.
- Create `claude-check/pm2-cron.sh`: daily 07:00 PM2-friendly scheduler.
- Modify `package.json`: add `claude_check` script.
- Create `test/claude-check-version.test.js`: version module tests.
- Create `test/claude-check-monitor.test.js`: `lsof` parsing, PID scoping, and classification tests.
- Create `test/claude-check-flow.test.js`: orchestrator tests with mocked dependencies.

## Runtime Defaults

- Observation duration: `60000` ms.
- Poll interval: `1000` ms.
- Suspicious sample cap in `backdoor-version`: `20`.
- Environment overrides for tests/manual runs:
  - `CLAUDE_CHECK_DURATION_MS`
  - `CLAUDE_CHECK_INTERVAL_MS`
  - `CLAUDE_CHECK_SKIP_PUSH`

---

### Task 1: Version Module

**Files:**
- Create: `claude-check/version.js`
- Test: `test/claude-check-version.test.js`

- [ ] **Step 1: Write failing tests for version validation and comparison**

Add tests:

```js
test('compareVersions orders semver triples', () => {
  assert.equal(compareVersions('2.1.202', '2.1.201'), 1);
  assert.equal(compareVersions('2.1.201', '2.1.201'), 0);
  assert.equal(compareVersions('2.1.200', '2.1.201'), -1);
});

test('parseVersion rejects unsupported version strings', () => {
  assert.throws(() => parseVersion('2.1'), /Invalid version/);
  assert.throws(() => parseVersion('latest'), /Invalid version/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/claude-check-version.test.js`

Expected: FAIL because `claude-check/version.js` does not exist.

- [ ] **Step 3: Implement minimal version helpers**

Export:

```js
module.exports = {
  parseVersion,
  compareVersions,
  readMaxVersion,
  writeMaxVersion,
  getLatestClaudeVersion,
};
```

Implementation notes:

- `parseVersion(version)` accepts only `^\d+\.\d+\.\d+$` and returns numeric parts.
- `compareVersions(a, b)` compares major, minor, patch in order.
- `readMaxVersion(rootDir)` reads `${rootDir}/max-version`.
- `writeMaxVersion(rootDir, version)` writes `${version}\n`.
- `getLatestClaudeVersion({ run })` calls `run('npm', ['view', '@anthropic-ai/claude-code', 'version'])`, trims stdout, validates it, and returns it.

- [ ] **Step 4: Add read/write and npm lookup tests**

Test temp-dir `max-version` read/write and mocked `run`:

```js
test('getLatestClaudeVersion reads npm view output', () => {
  const calls = [];
  const latest = getLatestClaudeVersion({
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '2.1.202\n' };
    },
  });
  assert.equal(latest, '2.1.202');
  assert.deepEqual(calls[0], {
    command: 'npm',
    args: ['view', '@anthropic-ai/claude-code', 'version'],
  });
});
```

- [ ] **Step 5: Run version tests**

Run: `node --test test/claude-check-version.test.js`

Expected: PASS.

---

### Task 2: Installer Module

**Files:**
- Create: `claude-check/install.js`
- Test: `test/claude-check-version.test.js`

- [ ] **Step 1: Write failing installer fallback test**

Add test:

```js
test('installClaudeVersion falls back to npm global install', () => {
  const calls = [];
  installClaudeVersion('2.1.202', {
    run(command, args) {
      calls.push({ command, args });
      if (command === 'claude') {
        const err = new Error('install failed');
        err.status = 1;
        throw err;
      }
      return { stdout: '' };
    },
  });

  assert.deepEqual(calls, [
    { command: 'claude', args: ['install', '2.1.202'] },
    { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@2.1.202'] },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/claude-check-version.test.js`

Expected: FAIL because installer is missing.

- [ ] **Step 3: Implement installer**

Export:

```js
module.exports = { installClaudeVersion };
```

Behavior:

- Validate version via `parseVersion`.
- Try `run('claude', ['install', version], { stdio: 'inherit' })`.
- On failure, run `run('npm', ['install', '-g', `@anthropic-ai/claude-code@${version}`], { stdio: 'inherit' })`.
- If both fail, throw an error that includes both failure messages.

- [ ] **Step 4: Add success-without-fallback test**

Assert only `claude install` is called when it succeeds.

- [ ] **Step 5: Run installer-related tests**

Run: `node --test test/claude-check-version.test.js`

Expected: PASS.

---

### Task 3: Checker Proxy

**Files:**
- Create: `claude-check/proxy.js`
- Test: `test/claude-check-flow.test.js`

- [ ] **Step 1: Write failing CONNECT proxy test**

Add test that starts:

- A local TCP target server that writes `ok`.
- `createConnectProxy()`.
- A raw client that sends `CONNECT 127.0.0.1:<targetPort> HTTP/1.1`.

Assert:

- Proxy responds `HTTP/1.1 200 Connection Established`.
- Bytes from target pass through.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-check-flow.test.js`

Expected: FAIL because proxy module does not exist.

- [ ] **Step 3: Implement minimal CONNECT proxy**

Export:

```js
module.exports = { createConnectProxy, listen };
```

Behavior:

- `createConnectProxy({ log })` returns an `http.createServer()` with a `connect` handler.
- Parse `req.url` as `host:port`.
- `net.connect(port, host)`.
- On upstream connect, write `HTTP/1.1 200 Connection Established\r\n\r\n`, pipe both sockets.
- On upstream error, write `502 Bad Gateway` when possible and destroy sockets.
- `listen(server)` returns a promise resolving `{ server, host: '127.0.0.1', port, url }`.

- [ ] **Step 4: Run proxy test**

Run: `node --test test/claude-check-flow.test.js`

Expected: PASS for the proxy test.

---

### Task 4: Monitor Parser And Classifier

**Files:**
- Create: `claude-check/monitor.js`
- Test: `test/claude-check-monitor.test.js`

- [ ] **Step 1: Write failing `lsof` parser tests**

Use representative lines:

```text
claude 123 user 42u IPv4 0x0 0t0 TCP 127.0.0.1:50000->127.0.0.1:61234 (ESTABLISHED)
claude 123 user 43u IPv4 0x0 0t0 TCP 192.168.1.5:50001->18.238.1.2:443 (ESTABLISHED)
claude 123 user 44u IPv4 0x0 0t0 UDP 192.168.1.5:55555->8.8.8.8:53
```

Assert parser extracts command, pid, protocol, local address, remote address, state, and raw line.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/claude-check-monitor.test.js`

Expected: FAIL because monitor module does not exist.

- [ ] **Step 3: Implement parser and address helpers**

Export:

```js
module.exports = {
  parseLsofLine,
  parseLsofOutput,
  isLoopbackHost,
  classifyRecords,
  collectDescendantPids,
  sampleNetwork,
  monitorClaudeNetwork,
};
```

Implementation notes:

- Parse by locating protocol token `TCP` or `UDP`, then parse the following name field.
- Support `local->remote`, listener-only, and state suffix forms.
- Treat `127.0.0.0/8`, `::1`, `localhost`, and `*.localhost` as loopback.
- Keep raw line for diagnostics.
- If `ps` or `lsof` fails at runtime, surface the error and fail the check instead of approving a version with no samples.

- [ ] **Step 4: Add classification tests**

Cases:

- TCP to `127.0.0.1:<proxyPort>` is allowed.
- TCP to external `18.238.1.2:443` is suspicious.
- UDP to external `8.8.8.8:53` is suspicious.
- Loopback-only UDP is allowed.

Use:

```js
const result = classifyRecords(records, {
  proxyHost: '127.0.0.1',
  proxyPort: 61234,
});
assert.equal(result.suspicious.length, 1);
```

- [ ] **Step 5: Add PID scoping tests**

Test `sampleNetwork({ rootPid, run })` with mocked `ps` and `lsof`:

- `ps` reports descendants `124` and `125`.
- `lsof` includes PID `124` and unrelated PID `999`.
- Assert only PID `124` record is returned.

- [ ] **Step 6: Run monitor tests**

Run: `node --test test/claude-check-monitor.test.js`

Expected: PASS.

---

### Task 5: Result And Git Helpers

**Files:**
- Create: `claude-check/git.js`
- Create: `claude-check/result.js`
- Test: `test/claude-check-flow.test.js`

- [ ] **Step 1: Write failing result formatting tests**

Expected pass line:

```text
2026-07-05T23:00:00.000Z version=2.1.202 latest=2.1.202 result=pass duration_ms=180000 interval_ms=1000 suspicious=0
```

Expected suspicious record includes capped indented samples.
Expected inconclusive record can include a capped stderr tail for diagnostics.

- [ ] **Step 2: Implement result writer**

Export:

```js
module.exports = { formatResultRecord, appendResultRecord };
```

Behavior:

- `formatResultRecord(result)` returns deterministic text.
- `appendResultRecord(rootDir, result)` appends to `${rootDir}/backdoor-version`.
- Include `latest=<version>` in every summary line.
- Cap samples at 20 by default.
- Cap stderr at 64KB before formatting, then write only a useful tail in the result record.

- [ ] **Step 3: Write failing git helper test**

Use mocked `run` and assert exact calls:

```js
gitApproveVersion('2.1.202', { run });
```

Expected calls:

- `git add max-version backdoor-version`
- `git commit -m "chore(claude-check): approve Claude Code 2.1.202"`
- `git push`

- [ ] **Step 4: Implement git helper**

Export:

```js
module.exports = { gitApproveVersion };
```

Behavior:

- Stage only `max-version` and `backdoor-version`.
- Commit with exact message.
- Push unless `skipPush` is true.
- Throw on any command failure.

- [ ] **Step 5: Run flow tests**

Run: `node --test test/claude-check-flow.test.js`

Expected: PASS for result/git helper tests.

---

### Task 6: Main Orchestrator

**Files:**
- Create: `claude-check/index.js`
- Modify: `package.json`
- Test: `test/claude-check-flow.test.js`

- [ ] **Step 1: Write no-op flow test**

Test `runClaudeCheck({ rootDir, deps })` with:

- `max-version` = `2.1.202`
- latest = `2.1.202`

Assert:

- Installer not called.
- Monitor not called.
- `max-version` unchanged.
- result file not required.
- exit result is `{ checked: false, version: '2.1.202' }`.

- [ ] **Step 2: Write pass flow test**

Mock:

- latest = `2.1.203`
- install succeeds.
- proxy returns `url: http://127.0.0.1:61234`.
- spawned Claude has pid `123`.
- monitor returns no suspicious records.
- monitor starts before `spawnClaude` is called and receives the child PID when available.

Assert:

- `backdoor-version` contains `result=pass`.
- `backdoor-version` contains `latest=2.1.203`.
- `max-version` is `2.1.203`.
- git helper called with `2.1.203`.

- [ ] **Step 3: Write suspicious flow test**

Mock monitor returns one external TCP or UDP finding.

Assert:

- `backdoor-version` contains `result=backdoor`.
- `max-version` remains old.
- git helper is not called.
- `runClaudeCheck` returns or throws a non-zero failure result.

- [ ] **Step 4: Write early-exit and cleanup tests**

Mock `spawnClaude` to exit before the full observation duration. Assert:

- result is `backdoor` or `inconclusive`, not `pass`.
- `max-version` remains old.
- git helper is not called.
- stderr tail is included when stderr was captured.

Mock temp directory creation and cleanup. Assert `fs.rmSync(tempBase, { recursive: true, force: true })` is called after the child process and proxy are stopped.

- [ ] **Step 5: Implement injectable orchestrator**

Export:

```js
module.exports = { runClaudeCheck, main };
```

Orchestrator dependencies:

- `run`: sync command runner based on `spawnSync`.
- `spawnClaude`: async child process starter based on `spawn('claude', [], ...)`.
- `startProxy`.
- `monitorClaudeNetwork`.
- `installClaudeVersion`.
- `gitApproveVersion`.
- `now`.
- `setTimeout`/sleep helper.
- filesystem helpers for testable temp cleanup.

Runtime behavior:

- Root dir is `path.join(__dirname, '..')`.
- Read durations from env with safe integer parsing.
- Create temp base with `fs.mkdtempSync(path.join(os.tmpdir(), 'block-cc-claude-check-'))`.
- Create `home/` and `work/`.
- Build minimal env:
  - `PATH`
  - `HOME`
  - `TMPDIR`
  - `USER`, `LOGNAME`, `TERM`, `SHELL` when present
  - `LANG`, `LC_ALL`, `LC_CTYPE` when present
  - proxy variables
  - disable updater/survey variables
- Start monitoring before spawning `claude`; the monitor should begin polling immediately and receive the root PID as soon as spawn returns.
- Spawn `claude` directly, no `sandbox-exec`, with `detached: true`.
- Pipe stderr, cap it at 64KB, and include a tail in inconclusive/failure records.
- Use stdio that cannot prompt interactively.
- Treat early process exit before the observation duration completes as inconclusive/failure, not pass.
- Stop the process group with `process.kill(-child.pid, 'SIGTERM')`, then escalate to `SIGKILL` if it does not exit.
- Always stop child process group, close proxy, and remove the temp directory in `finally`.

- [ ] **Step 6: Add package script**

Modify `package.json`:

```json
"scripts": {
  "test": "node --test",
  "claude_check": "node claude-check/index.js"
}
```

- [ ] **Step 7: Run orchestrator tests**

Run: `node --test test/claude-check-flow.test.js`

Expected: PASS.

---

### Task 7: PM2 Scheduler

**Files:**
- Create: `claude-check/scheduler.js`
- Create: `claude-check/pm2-cron.sh`
- Test: `test/claude-check-flow.test.js` or no automated test if shell portability becomes awkward.

- [ ] **Step 1: Write shell script**

Script requirements:

```sh
#!/bin/sh
set -u

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

next_sleep_seconds() {
  node "$ROOT_DIR/claude-check/scheduler.js" next-sleep
}

should_run_now() {
  node "$ROOT_DIR/claude-check/scheduler.js" should-run-now
}

while :; do
  sleep "$(next_sleep_seconds)"
  if ! should_run_now; then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') skipped missed 07:00 window"
    continue
  fi
  cd "$ROOT_DIR"
  npm run claude_check
done
```

Implementation notes:

- Print timestamped log lines before and after each run.
- If `npm run claude_check` fails, keep the scheduler alive and try again the next day.
- Use local time.
- If the machine wakes from sleep after missing the 07:00 window by more than five minutes, skip that stale run and calculate the next future 07:00.
- Always calculate sleep from the current time to a future 07:00; never sleep a negative or stale duration.

- [ ] **Step 2: Mark executable**

Run: `chmod +x claude-check/pm2-cron.sh`

- [ ] **Step 3: Validate shell syntax**

Run: `sh -n claude-check/pm2-cron.sh`

Expected: exit 0.

Manual PM2 command for user:

```sh
pm2 start claude-check/pm2-cron.sh --name block-cc-claude-check
```

---

### Task 8: Full Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run targeted tests**

Run:

```sh
node --test test/claude-check-version.test.js
node --test test/claude-check-monitor.test.js
node --test test/claude-check-flow.test.js
```

Expected: all PASS.

- [ ] **Step 2: Run full test suite**

Run:

```sh
npm test
```

Expected: all PASS.

- [ ] **Step 3: Check git status**

Run:

```sh
git status --short
```

Expected: only intended files are modified/added.

- [ ] **Step 4: Manual real-chain verification**

After unit tests pass, ask the user before running this command because it can query npm, install/update Claude Code, and write result files:

```sh
CLAUDE_CHECK_SKIP_PUSH=1 npm run claude_check
```

Expected:

- If no newer version exists, exits 0 without installing or checking.
- If a newer version exists, runs the real install/check path but skips `git push`.
- Any generated `backdoor-version` entry includes `latest=`.

- [ ] **Step 5: Do not commit yet**

Stop and report:

- Files changed.
- Tests run and results.
- Any runtime commands not exercised because they would install Claude or push git.
- Ask the user for confirmation before committing.
