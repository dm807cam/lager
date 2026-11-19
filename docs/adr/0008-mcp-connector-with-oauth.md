# 0008. An MCP connector with OAuth for any AI assistant

- Status: Accepted
- Date: 2026-11-19

## Context

Assistants need to deploy and manage apps without the user copying files around, and the connection must work with any client, not one vendor's.

## Decision

- Lager is a remote MCP server (Streamable HTTP, stateless) at `<LAGER_PUBLIC_URL>/mcp`.
- Sign-in uses OAuth 2.1 with dynamic client registration, PKCE (S256) and rotating refresh tokens. The protected resource is the MCP endpoint itself, and its metadata lives at the RFC 9728 location that the `401` challenge names.
- Redirect URIs may use https, http on the loopback interface, or a private-use scheme of a native app (RFC 8252), never schemes such as `javascript:` or `data:`.
- Static API tokens (`lgr_…`) work as bearer tokens for clients without OAuth and for scripts. `PUT /api/apps/<slug>` accepts the HTML file directly, so a client with a shell uploads it instead of sending it as a tool argument.
- Every tool has a title and MCP annotations (read-only, destructive, idempotent, closed world). Tool schemas avoid keywords that some clients reject.
- The guide (`src/guide.md`) reaches assistants in three ways: its first section as MCP server instructions, in full through `get_guide`, and as a skill for Claude. Tool descriptions point to `get_guide`, because not every client passes server instructions on to the model.

## Consequences

- Claude, ChatGPT, Cursor, VS Code, Gemini CLI and other MCP clients connect without entering client ids or secrets.
- OAuth needs `https` or `localhost` for `LAGER_PUBLIC_URL`. API tokens work everywhere.
- The guide is part of the interface: changing behaviour means changing the guide, and a test keeps the skill identical to it.
