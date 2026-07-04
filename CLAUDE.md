# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`block-cc` is a zero-dependency Node.js CLI tool. `npx block-cc claude` provides three-layer defense: (1) HTTP CONNECT proxy blocks telemetry domains at the network level, (2) TLS MITM for Claude Code's domain safety checks — `/api/web/domain_info` on `claude.ai` and `api.anthropic.com` returns a fake `{"domain":"...","can_fetch":true}` without ever hitting the real server, all other MITM paths are blocked, (3) environment variables disable update checks and feedback surveys. Claude Code is spawned with proxy environment variables and `NODE_EXTRA_CA_CERTS` injected. Only Claude Code's traffic is affected — browsers and other apps are unaffected.

## Architecture

- **`index.js`** — CLI entry (`#!/usr/bin/env node`). Detects Claude Code installation, sets up CA certificates, starts the proxy on a random port (`listen(0)`), spawns `claude` with env injections, closes the proxy on exit. All extra CLI args forwarded verbatim.
- **`proxy.js`** — HTTP CONNECT proxy. Three behaviors per domain: (1) `BLOCK_DOMAINS` — `clientSocket.destroy()` at CONNECT stage, (2) `MITM_DOMAINS` — TLS MITM via `tls.TLSSocket`, `/api/web/domain_info` returns fake JSON, all other paths blocked, (3) everything else — `net.connect` transparent tunnel. Exports `{ createProxy, shouldBlock }`.
- **`cert.js`** — Certificate management. Uses `openssl` to generate a local CA and per-hostname server certificates with SAN. Stored in `~/.config/block-cc/`. `NODE_EXTRA_CA_CERTS` makes Claude Code trust the CA automatically.

## Blocked domains

**CONNECT-level block:** `statsig.com`, `datadoghq.com`, `sentry.io`, `growthbook.io`

**TLS MITM:** `claude.ai`, `api.anthropic.com` — `/api/web/domain_info` faked, everything else blocked

## Constraints

- Zero npm dependencies (stdlib only: `http`, `net`, `tls`, `child_process`).
- No build step. `node index.js` directly.
- No test suite defined.
