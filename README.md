<p align="center">
  <img src="assets/icon.webp" alt="Lager logo" width="112" height="112">
</p>

<h1 align="center">Lager</h1>

<p align="center">
  <strong>The only two apps you'll ever need: your AI + Lager.</strong><br>
  Your AI builds the app. Lager runs it on your own server, keeps its data and lets you share it with anyone.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> •
  <a href="docs/README.md">Documentation</a> •
  <a href="CONTRIBUTING.md">Contributing</a> •
  <a href="https://github.com/dm807cam/lager/discussions">Discussions</a> •
  <a href="https://github.com/dm807cam/lager/issues">Issues</a>
  <br><br>
  <a href="https://github.com/dm807cam/lager/actions/workflows/ci.yml"><img src="https://github.com/dm807cam/lager/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="License: AGPL-3.0-or-later"></a>
  <a href="https://github.com/dm807cam/lager/pkgs/container/lager"><img src="https://img.shields.io/badge/docker-ghcr.io%2Fdm807cam%2Flager-2496ED?logo=docker&logoColor=white" alt="Docker image"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white" alt="Node.js 22.13 or newer">
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="Pull requests welcome"></a>
</p>

<p align="center">
  <img src="docs/images/hero.png" alt="The Lager dashboard in a browser showing four apps (Groceries, Pin board, Notes, Habits), next to a phone with the shared Groceries list open" width="880">
</p>

---

Ask an AI assistant such as Claude or ChatGPT for a shopping list your family shares, a booking sheet for your club or a tracker for your plants, and it builds one in a minute. But the result stays inside a chat. To use it on your phone or share it with someone who has no AI account, you would normally have to host it yourself: a server, a container, a database, a domain.

**Lager removes that step.** Connect your Lager server to your assistant once. From then on it publishes every app it builds straight to your server: with its own address, its own data, versions you can roll back, and an icon on your home screen. The people you share it with need only a browser.

## Why Lager? 🤩

- 🚀 **From prompt to app in one step.** Your assistant deploys through Lager's MCP connector. You get a link such as `groceries.apps.example.com`, not a file to download.
- 💾 **Data that stays.** Every app instance has its own document database with live updates, plus file uploads, so the app keeps its state across devices and people.
- 👪 **Share with anyone.** Share one instance so everyone works in the same data, or hand out separate copies of the app. Your family and friends do not need an AI subscription.
- ⏪ **Versions and rollback.** Every deploy is a numbered version. Lager takes a snapshot of the data before the active version changes, so you can always go back.
- 🤝 **Works with your AI.** Claude, ChatGPT, Cursor, VS Code, Gemini CLI: any assistant that speaks MCP can build and deploy apps, and the apps run the same whoever built them.
- 🧠 **Bring your own model.** Apps that call `lager.complete()` use a model you connect: Anthropic, OpenAI, OpenRouter, Mistral, a local Ollama, or any OpenAI-compatible server. You set the limits per person.
- 📱 **Feels like a real app.** Icons, theme colours and home-screen install for every app, in light and dark mode.
- 🔒 **Yours.** One Node.js process, SQLite and a data directory. No other services and no telemetry: the server only contacts the outside world when you set up mail or connect a model.
- 🌍 **Multilingual.** The interface is available in English, German, French and Spanish, and [adding a language](CONTRIBUTING.md#translations) takes one catalog file and two small registrations.

## How it works

```
 You ──"build me a shared groceries list"──▶ your AI
                                               │  deploy_app (MCP)
                                               ▼
                                      ┌─────────────────┐
                                      │      Lager      │  versions, data, sharing,
                                      │  (your server)  │  icons, custom domains
                                      └────────┬────────┘
                                               │  https://groceries.apps.example.com
                       ┌───────────────────────┼───────────────────────┐
                       ▼                       ▼                       ▼
                   your phone             your laptop         a friend without AI
```

Apps are single HTML files. Lager injects a small runtime, `window.lager`, into every page: `lager.use("db")` for a live document database, `lager.use("user")` for the viewer, `lager.complete()` for a language model, and more. Any AI can write against it, because the guide it reads through MCP explains the API with a complete example. Apps from elsewhere, such as claude.ai artifacts, move over with a few changes, and your assistant does the conversion.

## Quick start

### One command on a Raspberry Pi or any Linux server

```sh
curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh | sudo bash
```

The installer sets up Docker if needed, asks three short questions and starts Lager. The easiest choice is **Cloudflare**: you get https on your own domain, reachable from anywhere, without opening ports or handling certificates. When asked, open the link it shows on your phone or laptop and pick your domain. That is the only step outside the terminal.

**Updating** is the same command again. It keeps your settings and data, takes a backup first (and stops if the backup fails) and starts the most recently published release, the image tagged `:latest`. Works on a fresh Raspberry Pi 3, 4, 5 or Zero 2 with the 64-bit Raspberry Pi OS, and on any 64-bit Linux server. Details: [One-command install](docs/installation.md#one-command-install).

### By hand with Docker Compose

You need Docker with Compose, a domain, and a reverse proxy that terminates TLS. Lager needs two host names: one for the platform (`lager.example.com`) and a wildcard for the apps (`*.apps.example.com`).

```sh
git clone https://github.com/dm807cam/lager.git && cd lager
cp .env.example .env    # set LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN and the first admin account
docker compose up -d --build
```

Then open `LAGER_PUBLIC_URL`, sign in and copy the connector address from the dashboard.

- **What the reverse proxy must do** (pass `Host` on, body size, timeouts), with nginx and Caddy examples: [Reverse proxy requirements](docs/installation.md#reverse-proxy-requirements)
- **Wildcard certificate, Nginx Proxy Manager, configuration:** [Installation](docs/installation.md)
- **Published images:** `ghcr.io/dm807cam/lager:latest` is the most recently published release (written when a release tag `v*.*.*` is pushed, together with the version tags such as `:0.1.0` and `:0.1`; pre-release tags such as `v0.2.0-rc.1` do not move it), and `:edge` follows the `main` branch. [Published images](docs/installation.md#published-images)
- **Just trying it?** Run it on your own machine without DNS or certificates: [Running from source](docs/installation.md#running-from-source)

### Connect your AI

Lager works with every assistant that supports remote MCP servers. Sign-in uses OAuth, so you only enter the address:

| Assistant | How |
| --- | --- |
| claude.ai and Claude Desktop | Settings → Connectors → add a custom connector with `https://lager.example.com/mcp` |
| Claude Code | `claude mcp add --transport http lager https://lager.example.com/mcp` |
| ChatGPT | Developer mode → create a connector with `https://lager.example.com/mcp` and OAuth |
| Cursor, VS Code, Gemini CLI, … | Add `https://lager.example.com/mcp` as an HTTP MCP server |

Then ask for an app, for example *"Build a shared groceries list for my family and put it on Lager."* Configuration snippets for each assistant, API tokens and the optional skill for Claude: [Connecting your AI](docs/connecting-ai.md).

## Features

| | |
| --- | --- |
| **Apps** | Own subdomain per instance, numbered versions with rollback, notes per deploy, icons and descriptions, home-screen install, custom domains |
| **Data** | Document database with live updates and access rules, file uploads, realtime rooms with presence, pages that save themselves, file downloads, snapshots, NDJSON export and import |
| **People** | Several accounts with roles (administrator, publisher, user), invitations, open or closed registration, groups, four access levels per instance, public instances |
| **Interfaces** | Browser dashboard, REST API, MCP endpoint (Streamable HTTP) with OAuth 2.1 and dynamic client registration, or API tokens |
| **AI** | `lager.complete()` routed to the providers you connect, a catalog of named models, a model per app that the building AI picks, AI groups that decide which models their people may use and how often, keys stored encrypted |
| **Operations** | Single process, SQLite, one data directory, online backup command, trash with retention, multi-architecture Docker images |

What Lager deliberately does not do (no single sign-on, no built-in TLS, no replication, …) is listed under [Limits](docs/limits.md#what-lager-cannot-do).

## Documentation

All documentation lives in [`docs/`](docs/README.md):
[Installation](docs/installation.md) ·
[Connecting your AI](docs/connecting-ai.md) ·
[Building apps](docs/building-apps.md) ·
[Bring your own model](docs/ai-models.md) ·
[Users and sharing](docs/users-and-sharing.md) ·
[Custom domains](docs/custom-domains.md) ·
[Data, backup and operations](docs/data-and-backup.md) ·
[Limits](docs/limits.md) ·
[Languages and appearance](docs/languages-and-appearance.md)

What changed between releases: [Changelog](CHANGELOG.md).

## Join in 👋

Lager is young, and there is room to shape it. Writing code is only one of many ways to help:

- 🌍 **Translate** the interface into your language. Mostly one file, and the tests check it for you. [How to add a language](CONTRIBUTING.md#translations)
- 🧩 **Share an example app** that shows what Lager can do. [Example apps](CONTRIBUTING.md#example-apps)
- 🐛 **Report a bug** or **suggest an idea** in the [issue tracker](https://github.com/dm807cam/lager/issues/new/choose).
- 📖 **Improve the documentation.** If something confused you, it will confuse the next person too.
- 👩‍💻 **Write code.** Start with a [good first issue](https://github.com/dm807cam/lager/labels/good%20first%20issue).
- 💬 **Help others** in [Discussions](https://github.com/dm807cam/lager/discussions).

The [contributing guide](CONTRIBUTING.md) explains the development setup, the tests and how a pull request gets merged. Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

### Development in 30 seconds

```sh
git clone https://github.com/dm807cam/lager.git && cd lager
npm ci
cp .env.example .env && set -a && . ./.env && set +a
LAGER_DATA_DIR=./data npm run dev    # platform at http://localhost:8080, apps at http://<slug>.apps.localhost:8080
npm test                             # about 1150 tests, under a minute (Node 22.22+)
```

## Security

Please do not report security problems in public issues. Read the [security policy](SECURITY.md) to learn how to report a vulnerability privately.

## License and trademarks

Lager is free software, licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). You may use, study, change and share it. If you run a modified version that other people use over a network, the AGPL requires you to offer them its source code.

Lager is an independent project and is not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.
