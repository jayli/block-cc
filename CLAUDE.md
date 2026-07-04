# CLAUDE.md

## Project

`block-cc` is a zero-dependency Node.js CLI tool. It starts a local HTTP CONNECT proxy, prepares local MITM certificates, and spawns Claude Code with proxy-related environment variables.

## Files

- `index.js` — CLI entry, proxy startup, Claude Code subprocess environment.
- `proxy.js` — CONNECT proxy, block rules, MITM request handling.
- `cert.js` — local CA and per-host certificate generation.
- `test/` — Node built-in test runner tests.

## Constraints

- Use only Node.js standard library APIs.
- No build step.
- Keep changes scoped; do not update README.md or expand this file unless explicitly requested.
- Run `npm test` after behavior changes.
