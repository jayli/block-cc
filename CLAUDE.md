# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`block-cc` is a zero-dependency Node.js CLI tool. `npx block-cc claude` starts a local HTTP CONNECT proxy that blocks telemetry/analytics domains, then spawns Claude Code with `HTTP_PROXY`/`HTTPS_PROXY` injected. Only Claude Code's traffic goes through the proxy — browsers and other apps are unaffected.

## Architecture

- **`index.js`** — CLI entry (`#!/usr/bin/env node`). Detects Claude Code installation (cross-platform via `spawnSync` + `shell: true`), starts the proxy on a random port (`listen(0)`), spawns `claude` with `HTTP_PROXY`/`HTTPS_PROXY` in env, then closes the proxy when the claude process exits. All extra CLI args after `claude` are forwarded verbatim to `claude` (e.g. `npx block-cc claude -c`).
- **`proxy.js`** — HTTP CONNECT proxy (`http.createServer`). In the `connect` event, checks the target hostname against `BLOCK_DOMAINS`. Blocked: `clientSocket.destroy()`. Allowed: `net.connect` tunnel with bidirectional pipe. No TLS certificate needed — blocking happens at the CONNECT stage before the TLS handshake. Exports `{ createProxy, shouldBlock }`.

## Blocked domains

`statsig.com`, `datadoghq.com`, `sentry.io`, `growthbook.io`, `claude.ai`, `api.anthropic.com` — case-insensitive match with subdomain support. Hardcoded, no config file.

## Constraints

- Zero npm dependencies (stdlib only: `http`, `net`, `child_process`).
- No build step. `node index.js` directly.
- No test suite defined. Test manually with `node -e "require('./proxy')"` for load check and the `shouldBlock` test pattern used during development.
