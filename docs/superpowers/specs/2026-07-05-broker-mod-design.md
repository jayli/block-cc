# Broker Mode Design

## Goal

`block-cc` currently launches the whole Claude Code process tree inside a macOS
`sandbox-exec` profile. This blocks direct outbound network access for Claude
Code itself, but it also blocks user-initiated shell commands such as `!openssl`,
`!npm test`, or other debugging commands that need external network access.

Broker mode should preserve the core privacy boundary:

- Claude Code's own network activity remains sandboxed and forced through the
  block-cc proxy.
- Explicit user-entered `!cmd` shell commands run outside the sandbox.
- Broker command output is injected back into Claude Code as conversation
  context so Claude can reason over the result.
- Claude-generated Bash commands are not automatically unsandboxed.

The initial scope is exactly one explicit `!cmd` prompt. Natural-language
requests such as "run the network test" are intentionally not treated as
explicit permission.

This design has a hard feasibility gate: the implementation must prove that the
broker can distinguish a real `UserPromptSubmit` hook invocation from arbitrary
sandboxed Bash code. If that cannot be proven with the installed Claude Code and
Node.js standard library APIs, broker mode must be treated as a best-effort
developer convenience mode, not a complete security boundary.

Secure broker mode also depends on non-persistent hook injection. The
implementation must prove that block-cc can install temporary hooks for the
launched Claude Code process without writing broker capabilities into persistent
user settings, project settings, command-line arguments, or files readable by
ordinary sandboxed Bash. If this cannot be proven, secure broker mode must not
launch.

## Non-Goals

- Do not make all Bash tool calls unsandboxed.
- Do not attempt to infer user intent from arbitrary natural language.
- Do not change proxy block/MITM rules.
- Do not modify global shell, SSH, or Claude Code user configuration
  permanently.
- Do not depend on unsupported mutation of Claude Code tool input.
- Do not support non-macOS kernel isolation in this design.

## Feasibility Constraint

Claude Code hooks support observing and controlling lifecycle events. The
documented `PreToolUse` flow can inspect Bash tool input and return decisions
such as deny, but it does not document a supported way to rewrite
`tool_input.command`.

Therefore broker mode must not rely on modifying an existing Bash tool call.
Instead, it handles explicit `!cmd` earlier, at `UserPromptSubmit`, before the
prompt is processed by Claude.

There is a second, more important feasibility constraint. A hook process and a
Claude-generated Bash process both run as descendants of the sandboxed Claude
Code process and normally share the same user identity, filesystem visibility,
and inherited environment. A reusable broker credential exposed to the hook is
therefore also potentially exposed to Claude-generated Bash. The design is only
security-valid if implementation can establish a hook-only capability.

## Architecture

`block-cc claude` will start three local components:

1. The existing HTTP CONNECT proxy.
2. A new unsandboxed broker server owned by the parent `block-cc` process.
3. Claude Code inside the existing macOS sandbox.

Claude Code receives a temporary hook configuration and broker environment:

- `UserPromptSubmit` hook detects prompts that are exactly explicit shell
  commands.
- For an eligible `!cmd`, the hook calls a sandboxed `broker-run` helper.
- `broker-run` connects to the unsandboxed parent broker over a private Unix
  domain socket.
- The broker executes the command outside the sandbox and streams output back to
  the hook.
- The hook returns a structured `UserPromptSubmit` response that blocks the
  original `!cmd` prompt from being processed again and injects the broker
  result through `hookSpecificOutput.additionalContext`.
- `PreToolUse(Bash)` is optional in the initial implementation and can log or
  deny attempts that look like a replay of an already-brokered command, but it
  must not be required for command rewriting.

The broker must not expose a reusable "run arbitrary command" capability to the
sandboxed Claude environment. Before implementing full broker execution, the
project must run a feasibility spike to determine whether one of these
authentication strategies is viable:

- verified peer identity for Unix socket clients, if Node.js standard library
  exposes enough information on macOS
- a one-shot capability delivered only to the hook process and not visible to
  Claude-generated Bash
- a parent-observed hook invocation channel that sandboxed Bash cannot forge

Any peer-identity strategy must name the exact Node.js standard library
primitive used. Same-UID validation is not sufficient, because the hook process
and Claude-generated Bash run as the same user. If Node's standard library
cannot identify the hook process more specifically than UID, this strategy is
rejected.

If none of these is viable, broker mode can still be implemented as an explicit
`!cmd` convenience mode, but its documentation and logs must state that a
malicious or compromised Claude Code process with Bash execution can potentially
reuse the broker path.

The process boundary is:

```text
block-cc parent process
  |- HTTP CONNECT proxy, unsandboxed
  |- broker server, unsandboxed
  `- sandbox-exec claude
       |- Claude network: sandboxed, localhost-only direct access
       |- Claude HTTP(S): block-cc proxy/MITM/blocklist
       |- UserPromptSubmit hook
       |    `- explicit !cmd: broker-run -> parent broker -> unsandboxed shell
       `- Bash tool
            `- Claude-generated commands remain sandboxed
```

## Hook Flow

### UserPromptSubmit

The hook reads the JSON event from stdin and extracts:

- raw prompt text
- current working directory, if available
- session identifier, if available
- timestamp

The prompt is eligible only when all conditions hold:

- after trimming one trailing newline, the prompt starts with `!`
- the prompt contains no embedded newline
- the text after `!` is not empty
- the entire prompt is only the command; there are no extra natural-language
  instructions

No shell-aware whitespace normalization is performed. The command is the exact
byte-for-byte text after the leading `!`, minus only the single optional space
immediately after `!`.

Examples:

- `!git push` -> `git push`
- `! git push` -> `git push`
- `! npm test -- --grep network` -> `npm test -- --grep network`

Rejected examples:

- `!npm test\nthen summarize failures`
- `please run !npm test`
- `!`

When eligible, the hook calls:

```text
node <block-cc index.js> broker-run
```

The hook passes the request JSON to `broker-run` over stdin. The command is not
put on the process command line.

If broker execution succeeds, the hook prints the command output in the hook
result as structured JSON. The JSON includes:

```json
{
  "decision": "block",
  "reason": "handled by block-cc broker",
  "suppressOriginalPrompt": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "..."
  }
}
```

`additionalContext` contains a factual summary of:

- original command
- cwd
- exit code
- duration
- stdout and stderr, subject to output limits
- truncation marker or full-output path when applicable

This prevents Claude from also processing the raw `!cmd` prompt while still
making the broker result available to Claude's context.

If broker execution fails, the hook returns a block decision with the broker
error and captured command exit code. The hook process itself should still exit
successfully after emitting a structured hook response, because hook process
failure may be interpreted as hook infrastructure failure rather than an
intentional block. The original prompt is intentionally consumed and blocked
whether or not the broker actually executed the command, so it should not
continue into the model.

Claude Code documentation states that `additionalContext` is inserted into
Claude's context at the point where the hook fired and read on the next model
request. The feasibility smoke test must verify whether a blocked
`UserPromptSubmit` response with `additionalContext` triggers an immediate model
turn or only becomes available on the next user prompt. If it only becomes
available on the next prompt, the UI should clearly report that behavior.

### PreToolUse for Bash

The initial broker mode does not require `PreToolUse` for successful operation.
It can be added later for observability:

- log when Claude tries to run a network-capable command inside the sandbox
- optionally deny exact replay of a command already handled by `UserPromptSubmit`

It must not be used to rewrite commands unless a future Claude Code version
documents a supported mutation API and a smoke test proves it works.

## Broker Protocol

The broker listens on a per-run Unix domain socket under a private temporary
directory. TCP fallback is disabled by default because the broker runs commands
outside the sandbox.

Temporary path requirements:

- create with `fs.mkdtemp` under `os.tmpdir()`
- directory mode `0700`
- state files mode `0600`
- avoid symlink-following writes
- remove the directory and socket on parent process exit

The sandboxed `broker-run` helper receives request data through stdin, not
command-line arguments.

No reusable broker secret may be placed in the general Claude environment. A
secret inherited by Claude is also inherited by Claude-generated Bash and is not
an adequate security boundary.

If the feasibility spike proves a hook-only capability, `broker-run` sends that
capability through the protected channel. If not, the protocol is explicitly
best-effort and must only claim to preserve normal workflow intent, not to
resist hostile sandboxed Bash.

`broker-run` sends a single JSON request:

```json
{
  "type": "run",
  "capability": "...",
  "requestId": "...",
  "cwd": "...",
  "command": "..."
}
```

The broker validates:

- capability is valid for this hook invocation, if a hook-only capability is
  available
- request id has not been used
- command is non-empty
- request age is within the configured TTL
- cwd resolves successfully and satisfies the cwd policy below

### Cwd Policy

The initial cwd policy is:

- use the cwd reported by the hook event when available
- otherwise use the original cwd from which `block-cc claude` was launched
- resolve with `fs.realpath`
- reject if the path cannot be resolved, no longer exists, or is not a directory
- do not restrict to the original workspace in the initial design, because user
  commands may intentionally operate elsewhere

This intentionally preserves user shell behavior. A later hardening mode may
restrict broker execution to the original workspace.

The broker executes the command with the user's default shell:

```text
${SHELL:-/bin/sh} -lc <command>
```

It streams stdout and stderr back to `broker-run` and returns the child exit
code.

### Output, Timeout, and Cancellation

Broker-run must be bounded so an explicit command cannot wedge Claude Code
indefinitely through the hook path.

Initial limits:

- default command timeout: 10 minutes
- configurable timeout through a block-cc-owned environment variable or CLI flag
- maximum `additionalContext` returned through the hook response: 10,000
  characters, aligned with Claude Code hook output limits
- maximum captured full output retained by broker: 1 MiB combined stdout and
  stderr
- after the output limit is reached, continue draining the child process but
  truncate returned context with a clear marker
- preserve stdout/stderr as separate streams when the hook response format
  supports it; otherwise preserve arrival order with stream labels
- on timeout, send SIGTERM, wait briefly, then SIGKILL if the process remains
  alive

Interactive commands are not supported in the initial broker hook path. Commands
that require stdin should fail or hang until timeout unless a later design adds
interactive streaming.

## Environment Handling

Broker commands execute with an environment derived from a before/after snapshot
captured by the parent `block-cc` process.

Rules:

- start from the original parent environment captured before block-cc injects
  Claude-specific variables
- preserve any original user-provided `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
  `https_proxy`, `NO_PROXY`, `no_proxy`, `GIT_SSH_COMMAND`, and
  `NODE_EXTRA_CA_CERTS`
- remove block-cc-generated values for those variables when they were absent in
  the original environment
- include only minimal block-cc diagnostic variables needed for broker tracing

This preserves direct-network behavior for explicit user commands while avoiding
global shell mutation.

The sandboxed Claude process keeps the existing environment behavior:

- `HTTP_PROXY` and `HTTPS_PROXY` point to the block-cc proxy.
- `NODE_EXTRA_CA_CERTS` includes the local CA when available.
- disable-update and disable-survey variables remain injected.
- `GIT_SSH_COMMAND` can continue to route Git SSH through the proxy for
  sandboxed Git SSH commands.

## Security Model

The trust boundary is explicit user shell input.

Allowed:

- User enters `!curl https://example.com`.
- User enters `!npm test`, and the test suite performs external network access.
- User enters `!openssl s_client ...`.

Not automatically allowed:

- Claude decides to run `curl`.
- Claude transforms "please debug this" into a networked Bash command.
- Claude tries to run any Bash command that did not come from an exact `!cmd`
  prompt.

This security claim only holds if the feasibility gate proves hook-only broker
authentication. Without that proof, the mode is still useful for developer
workflows, but it cannot claim to prevent a malicious Claude-generated Bash
command from attempting to use the broker.

## Failure Behavior

- If hooks are unavailable, broker mode fails closed and Claude remains in the
  current strict sandbox behavior.
- If the broker is unavailable for an explicit `!cmd`, the hook blocks the
  prompt and reports the broker error.
- If capability validation fails, broker-run reports rejection in the structured
  hook response and logs the reason.
- If command execution exits non-zero, broker-run reports the command exit code
  in the structured hook response while the hook process itself exits
  successfully.

## Logging

Log broker decisions to the existing block-cc log:

- explicit user command detected
- broker execution start and exit code
- broker rejection reason
- hook or broker setup failure

Do not log full command output. Do not log full command text by default, because
shell commands often contain tokens, URLs, and inline secrets. Default logs
should include command metadata only, such as command length, a short hash, exit
code, duration, and whether output was truncated. Full command logging can be a
separate opt-in debug mode.

## Testing Plan

Feasibility smoke test:

- run the installed Claude Code with temporary hooks
- confirm `UserPromptSubmit` receives the raw prompt for `!echo ok`
- confirm the hook can block that prompt and display broker output
- confirm broker output can be injected through `additionalContext`
- determine whether blocked `UserPromptSubmit` plus `additionalContext` produces
  an immediate assistant turn or only affects the next model request
- confirm ordinary prompts continue into Claude
- prove or disprove non-persistent hook injection without exposing broker
  capabilities through persistent user/project settings, command-line arguments,
  or sandbox-readable files
- prove or disprove hook-only broker authentication with a concrete adversary
  test:
  - adversary is Claude-generated Bash inside the sandbox
  - adversary can read inherited environment variables
  - adversary can read argv-visible hook commands
  - adversary can read project files
  - adversary can inspect temp paths allowed by the sandbox
  - adversary can invoke `node index.js broker-run`
  - broker execution must still fail in secure mode
- negative test: a Claude-generated Bash command must not be able to trigger
  broker execution unless the mode is explicitly documented as best-effort

Unit tests:

- explicit `!cmd` detection
- multi-line and natural-language prompt rejection
- capability validation, if available
- request id single-use validation
- environment restoration for broker commands
- cwd resolution and rejection cases
- broker output and exit-code propagation
- output truncation
- timeout and process termination behavior

Integration tests with local sockets:

- `broker-run` executes a command outside a simulated sandbox boundary
- stdout, stderr, and exit code are preserved
- stale or reused request is rejected
- broker socket under private temp directory is cleaned up

Regression tests:

- existing proxy/MITM tests pass unchanged
- existing Git SSH proxy support remains available
- `claude --version` check remains sandboxed on macOS

## Open Questions

1. The exact Claude Code hook JSON shape must be verified against the installed
   Claude Code version before implementation.
2. The exact JSON block decision for `UserPromptSubmit` must be verified during
   the feasibility smoke test.
3. The implementation needs a verified non-persistent hook configuration
   strategy that does not expose broker capabilities through persistent user or
   project settings, command-line arguments, or sandbox-readable files.
4. The implementation must determine whether hook-only broker authentication is
   possible. If not, the design must be explicitly downgraded to best-effort
   developer convenience mode before coding full broker execution.
