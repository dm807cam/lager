# Changelog

All notable changes to Lager are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lager follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor release may contain breaking changes.

## [Unreleased]

## [0.1.0] - unreleased

The first public release.

### Added

- **Deploying from your AI:** an MCP endpoint (Streamable HTTP) with OAuth 2.1 and dynamic client registration, or API tokens, through which Claude, ChatGPT, Cursor, VS Code, Gemini CLI and other MCP clients build and deploy apps; a REST API and a browser dashboard for the same tasks.
- **Apps:** single HTML files with the injected `window.lager` runtime, an own subdomain per instance, numbered versions with rollback and a note per deploy, icons, descriptions and theme colours, home-screen install, custom domains.
- **Data:** a document database per instance with live updates and access rules, file uploads, realtime rooms with presence, pages that save themselves, file downloads, snapshots before the active version changes, NDJSON export and import.
- **People and sharing:** several accounts with roles (administrator, publisher, user), invitations, open or closed registration, groups, four access levels per instance, public instances; share one instance or hand out separate instances of an app.
- **Language models:** `lager.complete()` routed to the providers you connect (Anthropic, OpenAI, OpenRouter, Mistral, Ollama or any OpenAI-compatible server), a catalog of named models, a model per app, AI groups that decide which models their people may use and how often, provider keys stored encrypted.
- **Moving apps over:** a guide served through MCP and a check tool, with which an assistant converts apps from elsewhere, such as claude.ai artifacts, to Lager.
- **Interface:** English, German, French and Spanish, in light and dark mode.
- **Operations:** a single Node.js process with SQLite and one data directory, no telemetry, an online backup command, a trash with retention, optional mail over SMTP.
- **Installation:** a one-command installer and updater for Raspberry Pi and 64-bit Linux servers, with Cloudflare Tunnel, a mode for the local network or your own reverse proxy, and a backup before every update.
- **Images:** multi-architecture Docker images (`linux/amd64`, `linux/arm64`) on the GitHub Container Registry: `:latest` and version tags for releases, `:edge` for the `main` branch.

[Unreleased]: https://github.com/dm807cam/lager/commits/main
[0.1.0]: https://github.com/dm807cam/lager/releases/tag/v0.1.0
