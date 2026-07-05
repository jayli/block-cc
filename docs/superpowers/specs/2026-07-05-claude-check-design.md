# Claude Check Design

## Goal

Add a scheduled checker for new Claude Code releases. The checker should only run when the latest `@anthropic-ai/claude-code` npm version is higher than the repository's `max-version`. For each newer version, it installs that version, runs Claude Code in a temporary low-data environment without the block-cc sandbox, observes its network activity, and records whether the version appears to bypass the configured proxy with direct external TCP or UDP traffic.

If the version passes, the checker updates `max-version`, records the result in `backdoor-version`, commits, and pushes. If it fails, it records the version as suspicious in `backdoor-version` and does not update `max-version`.

## Scope

In scope:

- Add `npm run claude_check`.
- Put all checker scripts under `claude-check/`.
- Query the latest Claude Code version from `npm view @anthropic-ai/claude-code version`.
- Compare that version against local `max-version`.
- Install the target version with `claude install <version>`, with a fallback to `npm install -g @anthropic-ai/claude-code@<version>`.
- Run the checker from a temporary `HOME` and temporary working directory.
- Start a local HTTP CONNECT proxy so legitimate proxy-aware traffic has a valid route.
- Monitor Claude Code network activity with `lsof -i -n -P` polling.
- Detect direct external TCP and UDP activity from Claude-related processes.
- Write a durable result record to `backdoor-version`.
- On pass, update `max-version`, commit both files, and push.
- Provide a PM2-friendly shell scheduler that runs the npm script every day at 07:00 local time.

Out of scope:

- Packet payload inspection.
- Root-only tooling such as `tcpdump`, `dtrace`, or EndpointSecurity.
- Full proof against short-lived connections that appear and disappear between polling intervals.
- Changes to `README.md` or `CLAUDE.md`.

## Architecture

The checker is implemented as a small zero-dependency Node.js program in `claude-check/`, matching the rest of the project.

Proposed files:

- `claude-check/index.js`: main orchestration.
- `claude-check/version.js`: read `max-version`, query npm, validate and compare versions.
- `claude-check/install.js`: install requested Claude Code version.
- `claude-check/proxy.js`: minimal HTTP CONNECT proxy for the check run.
- `claude-check/monitor.js`: process discovery and `lsof` network sampling.
- `claude-check/git.js`: guarded git commit and push helpers.
- `claude-check/pm2-cron.sh`: PM2-friendly daily scheduler.

`package.json` gets one script:

```json
"claude_check": "node claude-check/index.js"
```

## Flow

1. Read `max-version`.
2. Run `npm view @anthropic-ai/claude-code version`.
3. If latest version is less than or equal to `max-version`, log that no check is needed and exit 0.
4. If latest version is higher, install it:
   - Try `claude install <version>`.
   - If that fails, try `npm install -g @anthropic-ai/claude-code@<version>`.
5. Start a local CONNECT proxy on `127.0.0.1:0`.
6. Create a temporary directory containing:
   - `home/` used as `HOME`.
   - `work/` used as Claude's current working directory.
7. Start the `lsof` polling loop before Claude is spawned, with the target PID filled in as soon as spawn returns. This reduces the chance of missing startup-time network activity.
8. Spawn `claude` without `sandbox-exec`.
9. Inject proxy environment variables pointing at the local proxy:
   - `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`.
   - `NO_PROXY` and `no_proxy` limited to loopback addresses.
   - Disable updater and surveys as in the main CLI.
10. Let the process run quietly for a bounded duration.
11. Poll `lsof -i -n -P` and collect TCP/UDP records belonging to the current check process tree.
12. Stop Claude's process group and the local proxy.
13. Remove the temporary directory.
14. Classify the sample:
   - Pass if no direct external TCP or UDP records are found.
   - Fail if any Claude-related process opens external TCP outside the local proxy or any external UDP.
   - Fail as inconclusive if monitoring tools fail, Claude exits before the observation window, or the checker cannot confirm the full observation completed.
15. Append a result record to `backdoor-version`.
16. If pass:
   - Write latest version to `max-version`.
   - Commit `max-version` and `backdoor-version`.
   - Push the commit.
17. If fail:
   - Leave `max-version` unchanged.
   - Exit non-zero after recording the suspicious result.

## Monitoring Design

The checker uses `lsof` because it is available on macOS, works without root for the user's own processes, and fits the project's zero-dependency constraint.

Process matching should be scoped to the current check run:

- The spawned Claude PID.
- Descendant processes of the spawned PID, discovered through `ps` parent PID traversal.
- Claude-named processes only when they can be tied back to the spawned process tree.

The monitor should avoid treating unrelated user Claude sessions as evidence for the checked version. A broad `lsof -c claude` scan may be useful as a fallback diagnostic, but it must not be the primary source of suspicious findings unless the process can be attributed to the check run.

The monitor should start before `claude` is spawned. Until the child PID is known, it can collect no process-scoped records; once spawn returns, each polling tick should refresh the process tree and sample only those PIDs. If `ps` or `lsof` fails, the run is inconclusive and must not approve the version.

The monitor parses `lsof -i -n -P` output and records at least:

- timestamp
- command
- pid
- protocol
- local address
- remote address
- state
- raw line

Allowed network activity:

- Connections to the local proxy address and port.
- Loopback-only traffic.

Suspicious network activity:

- TCP with an external remote address that is not the local proxy.
- UDP with an external remote address.
- UDP sockets that show external endpoints or are not clearly loopback-only.

The result should include sample lines, capped to a small number, so a human can inspect what triggered the decision.

## Isolation And Risk

The check intentionally runs Claude Code without the block-cc macOS sandbox. This is necessary because the goal is to discover whether the new Claude Code version attempts direct external network access when only proxy environment variables are provided.

To reduce exposure:

- Use a temporary empty `HOME`.
- Use a temporary empty working directory.
- Build a minimal child environment from a small allowlist such as `PATH`, `HOME`, `TMPDIR`, locale variables, and proxy-related variables. Avoid passing project-specific secrets and API keys.
- Keep the runtime bounded.
- Run with stdio ignored or piped so the process does not prompt interactively.
- Spawn with `detached: true` so Claude owns a process group.
- Kill the process group at the end of the observation window with `process.kill(-child.pid, 'SIGTERM')`, then escalate to `SIGKILL` if needed.
- Capture stderr with a small cap, such as 64KB, so early crashes are diagnosable.
- Treat early Claude exit before the observation window completes as inconclusive/failure, not pass.
- Remove the temporary directory in cleanup.

This does not make the run risk-free. It is a pragmatic check for direct network behavior, not a formal sandbox.

## Result File

`backdoor-version` is an append-only text log. Each record includes:

- ISO timestamp.
- version.
- latest npm version observed.
- result: `pass` or `backdoor`.
- npm latest source.
- duration and polling interval.
- suspicious sample count.
- stderr tail when Claude exits unexpectedly or the checker fails.
- capped suspicious samples when present.

Example:

```text
2026-07-05T23:00:00.000Z version=2.1.202 latest=2.1.202 result=pass duration_ms=180000 interval_ms=1000 suspicious=0
```

For a suspicious version, include indented sample lines after the summary.

## Git Behavior

On pass, the checker commits only `max-version` and `backdoor-version`:

```text
chore(claude-check): approve Claude Code <version>
```

Then it runs `git push`.

If there are unrelated worktree changes, the checker should not stage or revert them. It only stages the two expected files. If commit or push fails, the checker exits non-zero after leaving files on disk.

On fail, the checker does not commit or push automatically because `max-version` must remain unchanged. The suspicious result stays in the worktree for human review.

## PM2 Scheduler

`claude-check/pm2-cron.sh` is a long-running shell script intended to be started with PM2:

```sh
pm2 start claude-check/pm2-cron.sh --name block-cc-claude-check
```

It calculates the next local 07:00, sleeps until then, runs `npm run claude_check`, logs the result, then repeats.

This keeps the scheduler simple and avoids adding a cron dependency inside the repository.

## Tests

Add focused Node tests for:

- Version parsing and comparison.
- `max-version` read/write validation.
- `lsof` parser classification for allowed proxy TCP, direct external TCP, loopback traffic, and UDP.
- PID tree scoping so unrelated Claude processes are ignored.
- Main flow behavior with mocked command runners:
  - no-op when latest is not newer.
  - pass updates files and calls git helpers.
  - fail records suspicious result without updating `max-version`.

The tests should not invoke real `npm view`, install Claude Code, run real `claude`, or call `git push`.

## Open Constraints

- The `lsof` polling approach can miss extremely short-lived connections.
- Output format differences across macOS versions should be handled defensively.
- The fallback global npm install may require permissions depending on the user's Node installation.
- The automatic push assumes the local repository has a configured remote and credentials.
