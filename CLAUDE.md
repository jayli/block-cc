# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`block-cc` is a zero-dependency Node.js CLI tool. It starts a local HTTP CONNECT proxy, prepares local MITM certificates, and spawns Claude Code with proxy-related environment variables. On macOS, Claude Code is launched inside a `sandbox-exec` sandbox that blocks direct TCP/UDP outbound at the kernel level, forcing all network traffic through the proxy.

## Commands

- `npm test` — run all tests (Node built-in test runner)
- `node --test test/proxy.test.js` — run proxy tests only
- `node --test test/index.test.js` — run index tests only
- `node index.js claude` — run the CLI directly (bypasses npx)

## Architecture

**Startup flow** (`index.js:93-151`):
1. Validate `claude` subcommand and check Claude Code is installed
2. Create CA certificate in `~/.config/block-cc/` (one-time, via openssl)
3. Start HTTP CONNECT proxy on `127.0.0.1:0` (ephemeral port)
4. Build env with proxy URL, CA cert path, and disable flags
5. Spawn Claude via `sandbox.spawnClaude()` — on macOS wraps with `sandbox-exec` for kernel-level network restriction; on other platforms direct `spawn('claude', ...)`
6. On Claude exit, close the proxy and exit with the same code

**Proxy decision tree** (`proxy.js:64-150`):
On each CONNECT request, proxy decides by hostname:
- **Block** — destroy socket immediately. Covers `BLOCK_DOMAINS` list (statsig, datadog, sentry, growthbook, status.claude.com).
- **MITM** — establish TLS server-side socket using per-hostname cert signed by local CA, then inspect HTTP requests inside the tunnel. Covers `claude.ai` and `api.anthropic.com`.
- **Tunnel** — transparent TCP passthrough for everything else.

**MITM request routing** (`proxy.js:92-128`):
Once inside a TLS tunnel (HTTP headers parsed from the decrypted stream):
- `POST /api/web/domain_info` — fake a `{can_fetch: true}` JSON response (domain allowlist check)
- `api.anthropic.com` + `/v1/...` — 403 Forbidden (blocks API calls to Anthropic)
- `api.anthropic.com` + `/api/event_logging/v2/batch` — 204 No Content (silently accept telemetry batches)
- everything else — destroy socket

**Certificate management** (`cert.js`):
- CA cert + key cached at `~/.config/block-cc/ca.{key,crt}`, reused across runs
- Per-hostname server certs cached similarly, generated on first use per hostname
- Requires openssl on PATH

**Sandbox** (`sandbox.js`):
- macOS only: wraps Claude in `sandbox-exec` with a generated `.sb` profile
- Profile rules: `(allow default)` + `(deny network-outbound)` + `(allow network-outbound (remote ip "localhost:*"))`
- This blocks direct `net.connect()` and UDP to external hosts at the kernel level while allowing proxy traffic via localhost
- Profile is written to `os.tmpdir()` and cleaned up on process exit
- Non-macOS platforms: falls back to direct `spawn('claude', ...)`, behavior unchanged

## Key exports

- `index.js`: `buildClaudeEnv({ baseEnv, proxyUrl, caCertPath })` — used by tests to verify env construction
- `proxy.js`: `createProxy({ log, getSecureContext })` — creates the HTTP CONNECT server
- `cert.js`: `setupCA()`, `getSecureContext(hostname)` — certificate lifecycle
- `sandbox.js`: `spawnClaude(args, env, log)` — platform-aware Claude launcher; `isSandboxSupported()` — returns true on darwin

## Constraints

- Use only Node.js standard library APIs.
- No build step.
- Keep changes scoped; do not update README.md or expand this file unless explicitly requested.
- Run `npm test` after behavior changes.
