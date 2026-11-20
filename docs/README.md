# Lager documentation

The [README](../README.md) gives the overview and the quick start. These pages cover the rest.

## Running Lager

| Page | What it covers |
| --- | --- |
| [Installation](installation.md) | One-command install, Docker Compose, published images, every configuration variable, mail, reverse proxy requirements (nginx, Caddy, Nginx Proxy Manager), running from source |
| [Custom domains](custom-domains.md) | Serving an instance on its own host name, and who may set one up |
| [Users and sharing](users-and-sharing.md) | Accounts, roles, registration modes, groups, sharing an instance or handing out separate instances, the "Made with Lager" badge |
| [Data, backup and operations](data-and-backup.md) | Export and import, moving apps between servers, the trash, backups, logs |
| [Limits](limits.md) | Quotas and limits Lager enforces, and what it deliberately does not do |
| [Languages and appearance](languages-and-appearance.md) | Interface languages, adding a translation, light and dark mode |

## Building on Lager

| Page | What it covers |
| --- | --- |
| [Connecting your AI](connecting-ai.md) | Connecting Claude, ChatGPT, Cursor, VS Code, Gemini CLI or any other MCP client, API tokens, the Lager skill |
| [Building apps](building-apps.md) | The `window.lager` building blocks an app can use (`db`, `user`, `assets`, `room`, `page`, `downloads`, `ingest`), receiving data from other websites, webhooks and devices, icons, home-screen install |
| [Bring your own model](ai-models.md) | Connecting a language model (Anthropic, OpenAI, OpenRouter, Ollama and others) for `lager.complete` |
| [Guide for building apps](../src/guide.md) | The runtime API and rules an AI follows when it builds for Lager. The MCP endpoint serves this file, and the skill contains the same text |

## Working on Lager

| Page | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Development setup, tests, conventions, how a pull request gets merged |
| [Architecture decisions](adr/README.md) | Why Lager is built the way it is: the decisions behind it and their consequences |
| [Security policy](../SECURITY.md) | How to report a vulnerability |
