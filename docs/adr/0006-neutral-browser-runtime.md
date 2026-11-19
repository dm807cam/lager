# 0006. One neutral browser runtime, `window.lager`, for every AI

- Status: Accepted
- Date: 2026-11-19

## Context

Apps are single HTML files written by an AI assistant. They need durable data, the viewer's identity, uploads, realtime, a language model and a few more functions, without bundling a client library. The first version of Lager copied the runtime of claude.ai artifacts (`window.claude`, `window.storage` and stubs for functions Lager does not offer). Lager is meant for any assistant, and an API named after one vendor, plus shims for another host, would confuse other models and leave code behind that only exists for compatibility.

## Decision

Lager injects one script into every page it serves, which provides `window.lager`:

- `lager.use(name)` resolves a namespace or `null` and never throws. A namespace exists only if the active version declares it in `capabilities`. The namespaces are `db` (documents with live updates and queries), `user`, `permissions`, `assets`, `room`, `page` and `downloads`.
- `lager.complete(prompt, options?)` asks the language model the administrator connected (see 0011), if the app declares `complete`.

There are no aliases, no `window.claude`, no `window.storage` and no members that only reject. Apps written for claude.ai are converted when they move, not emulated: the `check_app` tool flags `window.claude` and `window.storage`, and the guide explains the conversion.

## Consequences

- An app runs the same whichever assistant wrote it, and the guide that every assistant reads through MCP explains the whole API with a tested example.
- Moving a claude.ai artifact needs a small rewrite, which the assistant does as part of the move.
- New capabilities extend `window.lager` and must be declared, documented in the guide and covered by the check.
