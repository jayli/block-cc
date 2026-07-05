# Broker Mode Design

## Goal

`block-cc` launches Claude Code in a macOS `sandbox-exec` profile. This blocks
Claude Code's direct outbound network access, but it also blocks user-entered
debugging commands such as `!openssl`, `!npm test`, and other test commands that
need external network access.

Broker mode should preserve the practical privacy boundary:

- Claude Code's own network activity remains sandboxed and forced through the
  block-cc proxy.
- Explicit user-entered `!cmd` shell commands can run outside the sandbox.
- Broker command output is injected back into Claude Code context so Claude can
  reason over the result.
- Claude-generated Bash commands are not automatically unsandboxed.

The initial scope is exactly one explicit `!cmd` prompt. Natural-language
requests such as "run the network test" are not treated as explicit permission.

## Updated Feasibility Findings

The installed Claude Code version used for design validation is `2.1.201`.
Official Claude Code docs and local CLI help show:

- `claude --settings <file-or-json>` can load session settings from a JSON file
  or inline JSON.
- Hooks are configured through settings and related configuration sources; there
  is no dedicated `--hooks` CLI flag in `claude --help`.
- `UserPromptSubmit` receives the raw user prompt before Claude processes it.
- `UserPromptSubmit` supports `decision: "block"`, `suppressOriginalPrompt`,
  and `hookSpecificOutput.additionalContext`.
- `PreToolUse` supports `hookSpecificOutput.updatedInput`, which can replace a
  tool's input before the tool runs.

This changes the design direction. Broker mode should not execute commands
directly from `UserPromptSubmit`. Instead:

1. `UserPromptSubmit` records an exact explicit `!cmd`.
2. Claude Code turns that prompt into a Bash tool call.
3. `PreToolUse(Bash)` strictly matches the Bash command against an unconsumed
   recorded `!cmd`.
4. On match, `PreToolUse` uses `updatedInput.command` to replace the Bash
   command with `broker-run <request-id>`.
5. The broker executes only the already-registered command for that request id.

This is stronger than a best-effort open broker because sandboxed Bash cannot
ask the broker to execute arbitrary caller-provided command text. It is still not
a cryptographic security boundary because the hook configuration and request
metadata may be visible to the sandboxed process tree.

## Security Position

Broker mode is a **constrained broker**:

- It is intended to prevent ordinary Claude-generated Bash commands from gaining
  unsandboxed network access.
- It only unsandboxes commands that match a recently recorded explicit user
  `!cmd`.
- It does not claim to resist a malicious or compromised Claude Code process
  that can inspect hook settings, temp files, argv, and invoke internal helper
  commands.

If future Claude Code releases provide signed hook events, private per-hook
capabilities, or an official unsandboxed user-command API, this design can be
hardened into a stronger security boundary.

## Non-Goals

- Do not make all Bash tool calls unsandboxed.
- Do not infer user intent from arbitrary natural language.
- Do not change proxy block/MITM rules.
- Do not modify global shell, SSH, or Claude Code user configuration
  permanently.
- Do not support non-macOS kernel isolation in this design.
- Do not promise cryptographic hook-only authentication in Phase 1.

## Architecture

`block-cc claude` starts:

1. The existing HTTP CONNECT proxy.
2. A new unsandboxed broker server owned by the parent `block-cc` process.
3. Claude Code inside the existing macOS sandbox.

Claude Code is launched with `--settings <tmp-settings.json>`. The temporary
settings file contains hook commands for this session only. It is created in a
private temp directory and removed on exit. The file path is visible in argv and
the file may be readable from sandboxed Bash, so it must not contain reusable
secrets that authorize arbitrary broker execution.

If the user already passes `--settings`, Phase 1 fails fast with a clear error
instead of trying to merge settings. Settings merging is deferred because hook
array ordering and user-defined hooks affect security and behavior.

Process boundary:

```text
block-cc parent process
  |- HTTP CONNECT proxy, unsandboxed
  |- broker server, unsandboxed
  `- sandbox-exec claude --settings <tmp-settings.json>
       |- Claude network: sandboxed, localhost-only direct access
       |- Claude HTTP(S): block-cc proxy/MITM/blocklist
       |- UserPromptSubmit hook: records exact !cmd
       |- PreToolUse(Bash): exact-match gate + updatedInput rewrite
       |- Bash tool: runs broker-run <request-id> inside sandbox
       `- broker-run: asks parent broker to execute registered command
```

## Hook Configuration

Use `--settings <tmp-settings.json>` as the preferred injection method.

Requirements:

- create temp directory with `fs.mkdtemp` under `os.tmpdir()`
- directory mode `0700`
- settings file mode `0600`
- no permanent writes to `.claude/settings.local.json`
- no reusable broker secret in settings JSON
- cleanup on normal exit
- log recovery instructions if cleanup fails

Smoke test must verify that Claude Code 2.1.201 loads hooks from
`--settings <tmp-settings.json>` in interactive mode and print mode where
applicable.

## Hook Flow

### UserPromptSubmit

The hook reads JSON from stdin and extracts:

- raw prompt text
- current working directory, if present
- session id, if present
- timestamp

The prompt is eligible only when:

- after trimming one trailing newline, the prompt starts with `!`
- the prompt contains no embedded newline
- the text after `!` is not empty
- the entire prompt is the shell command, with no extra natural-language text

No shell-aware normalization is performed. The command is the exact text after
`!`, minus only one optional space immediately after `!`.

Examples:

- `!git push` -> `git push`
- `! git push` -> `git push`
- `! npm test -- --grep network` -> `npm test -- --grep network`

Rejected examples:

- `!npm test\nthen summarize failures`
- `please run !npm test`
- `!`

For an eligible command, `UserPromptSubmit` registers a pending broker request in
the parent broker:

```json
{
  "requestId": "...",
  "command": "npm test",
  "cwd": "...",
  "createdAt": 1234567890
}
```

It then allows the prompt to continue. It may add minimal
`additionalContext` such as "block-cc registered explicit command request
<request-id>", but it must not execute the command itself.

### PreToolUse for Bash

The hook reads JSON from stdin and extracts `tool_input.command`.

It compares the Bash command with pending explicit commands using deterministic
FIFO matching:

- candidate request is unconsumed
- candidate request is not expired
- candidate command is byte-for-byte equal to `tool_input.command`
- if both hook event and request have session id, session ids must match
- if the hook event lacks session id, match only within this broker process by
  command equality and FIFO order, and log `session_id_missing`
- if multiple requests match, choose the oldest registered request

This avoids races where a later `!cmd` prevents an earlier matching Bash tool
call from being brokered, and gives repeated identical commands predictable
ordering.

On match, it returns a structured hook response with `updatedInput`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "command": "node <block-cc index.js> broker-run <request-id>",
      "description": "Run explicit user command through block-cc broker"
    }
  }
}
```

The original user command is not embedded in the rewritten Bash command. The
request id is not sufficient to execute arbitrary command text; the broker only
looks up registered pending commands.

On non-match, the hook leaves the Bash command unchanged. The command therefore
runs inside the sandbox and remains subject to the existing network restrictions.

### Broker-Run

`broker-run <request-id>` runs inside the sandboxed Bash process. It connects to
the parent broker over a private Unix domain socket and asks to consume the
registered request id.

The broker validates:

- request id exists
- request id has not been consumed
- request is recent
- request was registered by `UserPromptSubmit`
- command is stored server-side; caller does not provide command text
- cwd resolves and satisfies cwd policy

The broker then executes the registered command outside the sandbox.

### PostToolUse and Context Injection

The broker-run command prints a compact structured result to stdout. Because the
rewritten command is a normal Bash tool execution, Claude Code should receive the
Bash tool output through its normal tool-result path.

Additionally, `PostToolUse(Bash)` can inspect broker-run output and add
`hookSpecificOutput.additionalContext` with a concise summary:

- original command
- cwd
- exit code
- duration
- stdout/stderr excerpt
- truncation marker or output file path

Smoke tests must verify:

- the Bash tool result is visible to the user
- Claude can reason over the broker output in the same turn or, if not, on the
  next model request
- `PostToolUse.additionalContext` behavior with broker-run output

If normal Bash tool output already enters Claude context reliably,
`PostToolUse.additionalContext` may be redundant and should be kept minimal.

## Broker Protocol

The broker listens on a per-run Unix domain socket under a private temp
directory. TCP fallback is disabled by default.

Temporary path requirements:

- create with `fs.mkdtemp` under `os.tmpdir()`
- keep socket path short enough for macOS Unix socket limits
- directory mode `0700`
- state files mode `0600`
- remove directory and socket on parent process exit

The request model is intentionally server-side:

```json
{
  "type": "consume",
  "requestId": "..."
}
```

The broker does not accept command text from `broker-run`. This limits abuse by
sandboxed Bash to attempting to consume an already-registered explicit user
command.

## Cwd Policy

Initial policy:

- use cwd reported by hook event when available
- otherwise use the original cwd from which `block-cc claude` was launched
- resolve with `fs.realpath`
- reject if the path cannot be resolved, no longer exists, or is not a directory
- do not restrict to original workspace in Phase 1, because explicit user
  commands may intentionally operate elsewhere

A future hardening mode may restrict broker execution to the original workspace.

## Environment Handling

Broker commands execute with an environment derived from the original parent
environment captured before block-cc injects Claude-specific variables.

Rules:

- preserve original user-provided `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
  `https_proxy`, `NO_PROXY`, `no_proxy`, `GIT_SSH_COMMAND`, and
  `NODE_EXTRA_CA_CERTS`
- remove block-cc-generated values for those variables when they were absent in
  the original environment
- remove block-cc-generated Claude-only disable flags when they were absent in
  the original environment: `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_UPDATE_CHECK`, and
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`
- include only minimal block-cc diagnostic variables needed for broker tracing

This preserves direct-network behavior for explicit user commands while avoiding
global shell mutation.

The sandboxed Claude process keeps the existing environment behavior:

- `HTTP_PROXY` and `HTTPS_PROXY` point to the block-cc proxy.
- `NODE_EXTRA_CA_CERTS` includes the local CA when available.
- disable-update and disable-survey variables remain injected.
- `GIT_SSH_COMMAND` can continue to route sandboxed Git SSH through the proxy.

## Output, Timeout, and Cancellation

Initial limits:

- default command timeout: 10 minutes
- configurable timeout through a block-cc CLI flag or environment variable
- maximum result printed to Bash stdout: 1 MiB combined stdout/stderr
- maximum context injected through hooks: 10,000 characters
- after output limit is reached, continue draining child process and truncate
  displayed/context output with a clear marker
- preserve stdout/stderr labels; exact byte interleaving is not guaranteed
- on timeout, send SIGTERM, wait briefly, then SIGKILL
- if Claude exits or broker socket disconnects, terminate active broker child
  processes

Interactive commands are not supported in Phase 1. Commands requiring stdin may
fail or time out.

## Concurrency

Phase 1 queues broker commands. Only one broker command executes at a time per
Claude session.

Rationale:

- avoids interleaved output
- preserves prompt/result ordering
- keeps context injection deterministic

If a second explicit `!cmd` arrives while one is running, it waits in FIFO order.

## Logging

Log broker metadata to the existing block-cc log:

- explicit command detected
- request id registered
- request id consumed
- execution start and exit code
- duration
- output truncation
- rejection reason

Do not log full command output. Do not log full command text by default, because
shell commands often contain tokens, URLs, and inline secrets. Default logs
should include command length and a short hash. Full command logging can be an
opt-in debug mode.

## Failure Behavior

- If hooks are unavailable, broker mode fails closed and Claude remains in the
  current strict sandbox behavior.
- If `UserPromptSubmit` registration fails, the prompt continues unchanged and
  normal sandbox behavior applies.
- If `PreToolUse` cannot match the command, it leaves Bash unchanged.
- If broker-run cannot consume the request id, it exits non-zero and prints a
  clear error through Bash output.
- If command execution exits non-zero, broker-run returns that exit code and
  prints captured output.

## Security Model

Allowed:

- User enters `!curl https://example.com`.
- User enters `!npm test`, and the test suite performs external network access.
- User enters `!openssl s_client ...`.

Not automatically allowed:

- Claude decides to run `curl`.
- Claude transforms "please debug this" into a networked Bash command.
- Claude runs a Bash command that differs from the last explicit `!cmd`.

Known limitation:

- A malicious or compromised Claude Code process with Bash execution may be able
  to inspect hook configuration and attempt to invoke `broker-run` directly.
  Because broker-run cannot provide command text, the worst Phase 1 path should
  be consuming a pending explicit user request, not arbitrary command execution.
  This must be verified by adversary tests.

## Testing Plan

Feasibility smoke tests:

- `claude --settings <tmp-settings.json>` loads temporary hooks.
- `UserPromptSubmit` receives raw prompt for `!echo ok`.
- `PreToolUse(Bash)` receives `tool_input.command`.
- `PreToolUse.updatedInput.command` actually replaces the Bash command.
- `sandbox-exec` still allows sandboxed hook/broker-run processes to connect to
  the parent Unix domain socket.
- direct external TCP from sandboxed Bash remains blocked.
- broker-executed command runs outside the sandbox and can perform intended
  external network access.
- Normal Bash tool output from broker-run is visible to the user.
- Claude can reason over broker-run output in the same turn, or the behavior is
  documented if only available on the next request.
- `PostToolUse.additionalContext` works as expected, if used.

Adversary tests:

- A Claude-generated Bash command cannot ask broker to execute arbitrary command
  text.
- Direct `node index.js broker-run <fake-id>` fails.
- Reusing a consumed request id fails.
- Consuming an expired request id fails.
- Invoking broker-run before matching `PreToolUse` registration fails.

Unit tests:

- explicit `!cmd` detection
- multi-line and natural-language prompt rejection
- strict command matching
- FIFO matching with repeated identical commands
- session-id-present and session-id-missing matching behavior
- request id single-use validation
- request expiry
- environment restoration
- cwd resolution and rejection
- output truncation
- timeout and child termination

Regression tests:

- existing proxy/MITM tests pass unchanged
- existing Git SSH proxy support remains available
- `claude --version` check remains sandboxed on macOS

## Open Questions

1. Confirm exact JSON shapes for `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `updatedInput`, and `additionalContext` on Claude Code
   `2.1.201`.
2. Confirm whether broker-run Bash output is enough for Claude context, or
   whether `PostToolUse.additionalContext` is required.
3. Confirm macOS Unix socket path behavior from the chosen temp directory.
4. Decide whether future secure mode requires upstream support such as signed
   hook events, private hook-only capabilities, or an official unsandboxed
   user-command API.

## References

- Claude Code hooks reference: `https://code.claude.com/docs/en/hooks`
- Claude Code CLI reference: `https://code.claude.com/docs/en/cli-reference`
- Claude Code settings reference: `https://code.claude.com/docs/en/settings`
