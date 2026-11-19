# Lager documentation

The [README](../README.md) gives the overview and the quick start. These pages cover the rest.

## Running Lager

| Page | What it covers |
| --- | --- |
| [Installation](installation.md) | Docker Compose, published images, every configuration variable, mail, reverse proxy (Nginx Proxy Manager), running from source |
| [Custom domains](custom-domains.md) | Serving an instance on its own host name, and who may set one up |
| [Users and sharing](users-and-sharing.md) | Accounts, roles, registration modes, groups, sharing an instance or handing out separate instances |
| [Data, backup and operations](data-and-backup.md) | Export and import, moving apps between servers, the trash, backups, logs |
| [Limits](limits.md) | Quotas and limits Lager enforces, and what it deliberately does not do |
| [Languages and appearance](languages-and-appearance.md) | Interface languages, adding a translation, light and dark mode |

## Building on Lager

| Page | What it covers |
| --- | --- |
| [Connecting your AI](connecting-ai.md) | Connecting Claude, ChatGPT, Cursor, VS Code, Gemini CLI or any other MCP client, API tokens, the Lager skill |
| [Building apps](building-apps.md) | The building blocks an artifact can use (`db`, `user`, `assets`, `room`, `artifact`, `downloads`), icons, home-screen install |
| [Bring your own model](ai-models.md) | Connecting a language model (Anthropic, OpenAI, OpenRouter, Ollama and others) for `claude.complete` |
| [Guide for building apps](../src/guide.md) | The runtime API and rules an AI follows when it builds for Lager. The MCP endpoint serves this file, and the skill contains the same text |

## Working on Lager

| Page | What it covers |
| --- | --- |
| [Contributing](../CONTRIBUTING.md) | Development setup, tests, conventions, how a pull request gets merged |
| [Design notes](superpowers/) | Design documents and implementation plans for larger features |
| [Security policy](../SECURITY.md) | How to report a vulnerability |
