# Changelog

All notable changes to Lager are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lager follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor release may contain breaking changes.

## [Unreleased]

### Upgrading from a pre-release build

An installation that ran a build from before the first release will notice these changes:

- **First start needs an administrator:** while no account exists, Lager refuses to start unless both `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD` are set. Installations that already have an account are not affected.
- **Stricter configuration:** `LAGER_PUBLIC_URL` must be an `http(s)` address without a path, `LAGER_APPS_DOMAIN` a bare host name, `LAGER_SMTP_URL` an `smtp(s)` address, and numbers must be whole numbers in their range. A value that is refused stops the start with one line that names the variable. `LAGER_SNAPSHOT_KEEP=0` keeps working as 1, with a warning.
- **Deploy limit:** an app takes at most 60 new versions per hour, and one person starts at most 60 new apps per hour; further deploys are refused with `deploy_rate` (HTTP 409).
- **Old versions are removed:** an app keeps its newest 100 deployed versions. The next deploy of an app with more deletes the surplus for good (not to the trash), except versions an instance still runs.
- **Language model time limit:** a model call ends with the error `timeout` after 90 seconds instead of 180. `LAGER_AI_TIMEOUT_SECONDS` changes that; keep it below the response timeout of your proxy.
- **Reserved names:** new apps and instances cannot be named `login`, `account`, `accounts`, `mail`, `smtp`, `ftp`, `assets`, `cdn`, `status`, `support` or `security`, nor like the platform's own host under the apps domain. Existing ones keep working.
- **Custom domains:** a parent domain of the platform host or of the apps domain (`example.com` for a platform at `lager.example.com`) and a name under the platform host (`notes.lager.example.com`) can no longer be attached to an instance. Domains that are already attached keep working.
- **Home-screen install of private instances:** the manifest and icons of an instance that is not public show the app's name, description and icon only to a viewer with access; anyone else gets a manifest named "Lager" with the placeholder icon. Apps that bring their own `rel="manifest"` link need `crossorigin="use-credentials"` on it to keep their name when installed.
- **Content security policy:** platform pages now allow scripts only from Lager's own files or with a per-response nonce, and send `X-Content-Type-Options: nosniff`. A reverse proxy that injects its own inline script into the platform's pages (an analytics snippet, say) will find it blocked. The platform also answers `/robots.txt` with "disallow everything".
- **Data directory is private:** Lager now creates directories with mode 700 and files with 600, and at the next start changes an existing data directory it owns to mode 700 (one log line says so). Scripts on the host that read the data directory as another user, for example a `cp -a` or `rsync` of a bind-mounted `./data`, need to run as the owner or with `sudo`. `node dist/backup.js` is not affected.
- **Instances for other accounts:** a publisher can create at most 5 instances per day for other accounts, and none for an account that already owns half of the instances it may own; an administrator is not limited.
- **Deleting accounts:** the administration area (Users) now offers "Delete account" for a disabled account, with its apps and instances handed to another account or moved to the trash. Nothing happens to existing accounts on its own.
- **Title and note:** a new app title takes at most 100 characters and a version note at most 500, one line each.
- **Question before the first sign-in to an app:** whoever opens an instance they neither own nor maintain is asked once whether to continue, and told that the app will see their name (and their email address, if it asks for it). People an instance was shared with are asked too. Sessions on instances that exist already keep working.
- **Accounts pause under attack:** after 10 failed sign-ins in a row an account refuses sign-ins from browsers it does not know for 30 seconds, then for up to 5 minutes. Browsers that signed in before are not affected, and "Forgot your password?" ends a pause. See [Limits on signing in and registering](docs/users-and-sharing.md#limits-on-signing-in-and-registering).
- **Hourly limits for the whole server:** 30 self-registrations, 60 confirmation mails and 60 password-reset mails per hour. With mail configured, registering an address that already has an account answers "check your mail" and mails the owner instead of naming the address.
- **OAuth redirect addresses:** a connecting assistant may register only `https://` addresses, `http://` on this computer, schemes in reverse-domain form with three parts (`com.example.app:`) and `cursor:`. Clients registered with another scheme keep their row but new ones are refused.
- **Unused OAuth clients are removed:** a registered client that holds no sign-in and was last used more than 90 days ago is deleted; the assistant registers again when you next connect.
- **Database:** the platform database is migrated to schema version 2 at the first start (a new table and a new column; nothing is removed). An older build cannot open it afterwards.

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
