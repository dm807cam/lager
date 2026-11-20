# Changelog

All notable changes to Lager are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lager follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, a minor release may contain breaking changes.

## [Unreleased]

### Added

- **Receiving data from outside:** an app can declare `ingest` endpoints, each of which appends JSON documents to one collection of an instance and can do nothing else: `POST https://<instance>/_ingest/<name>`. Pages on listed websites send without a secret (`auth: "none"`), scripts, webhooks, phone shortcuts and devices with a token (`auth: "token"`) that the instance page shows and replaces. Endpoints work on private instances, never read a cookie and store nothing about the sender; on request the server adds a daily visitor hash and the country. A data rule with `"write": "anyone"` lets guests of a public instance add documents from the page itself (an RSVP, a guestbook, a poll). What comes in is kept in a file of its own per instance (`inbox.sqlite`, not part of snapshots) with a quota of its own, `LAGER_INGEST_QUOTA_MB` (default 10 MiB per instance on top of the instance quota; `0` turns the feature off), and with limits per client address, endpoint, instance and day. The instance page has a card "Data from outside" with addresses, tokens, counters and a switch per endpoint; on an instance whose owner does not run the app, endpoints start switched off. New: `lager.use("ingest")`, the example `examples/pageviews.html`, the setting `LAGER_COUNTRY_HEADER`, and [Receiving data from outside](docs/building-apps.md#receiving-data-from-outside). The platform database moves to schema version 3 (one new table).

### Changed

- **Node.js 24 or newer** is needed to run Lager from source (it was 22.13). The Docker image and the installer already use Node 24, so they are not affected.
- **Images:** commits on `main` publish only `:edge`, without a `:sha-<commit>` tag, and earlier edge builds are deleted after each publish. Release images and their tags stay.
- **Docs:** the steps for adding Lager to claude.ai and Claude Desktop, ChatGPT and VS Code follow the current menus and configuration files of those products.
- **Database `add`:** the answer to an `add` request (`POST /__lager/db`) carries the `id` of the new document next to `doc`, also where the document itself is withheld because the writer may not read the path. In the browser runtime, `collection.add()` now sends that request and lets the server make up the id, instead of choosing one in the page and sending a `set`; apps notice no difference.
- **Activating versions:** a manager who is not the owner can no longer activate a version whose ingest endpoints differ from the active one, as was already the case for data rules.

### Security

- **Docker image:** the runtime image no longer contains `npm`, `npx`, `corepack` or `yarn`. Lager never runs them, and npm's own bundled packages (brace-expansion, undici) carried known vulnerabilities that image scanners report. For an online backup inside the container, use `node dist/backup.js` as the documentation shows; `npm run backup` works only in a source checkout.

## [0.1.0] - 2026-11-19

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

### Upgrading from a pre-release build

An installation that ran a build from before the first release will notice these changes, the ones that need action first:

- **First start needs an administrator:** while no account exists, Lager refuses to start unless both `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD` are set. On such a first start, a `LAGER_SECRET` shorter than 32 characters, an administrator password shorter than 10 characters, and the example passwords from `.env.example` on an address other than this machine are refused too. Installations that already have an account are not affected, except that a short `LAGER_SECRET` logs a warning at every start.
- **Database:** the platform database is migrated to schema version 2 at the first start (a new table and a new column; nothing is removed). An older build cannot open it afterwards.
- **Stricter configuration:** `LAGER_PUBLIC_URL` must be an `http(s)` address without a path, `LAGER_APPS_DOMAIN` a bare host name, `LAGER_SMTP_URL` an `smtp(s)` address, and numbers must be whole numbers in their range. A value that is refused stops the start with one line that names the variable. `LAGER_SNAPSHOT_KEEP=0` keeps working as 1, with a warning.
- **Data directory is private:** Lager now creates directories with mode 700 and files with 600, and at the next start changes an existing data directory it owns to mode 700 (one log line says so). Scripts on the host that read the data directory as another user, for example a `cp -a` or `rsync` of a bind-mounted `./data`, need to run as the owner or with `sudo`. `node dist/backup.js` itself keeps working, but the backups it writes are now readable only by the account that ran it (directories 700, files 600): a job on the host that reads or copies them as another user must run as that account or with `sudo`.
- **Installer:** an update now stops when the backup before it fails (`LAGER_SKIP_BACKUP=1` updates without one), keeps the image it was installed with (`LAGER_IMAGE` is remembered in `installer.env`), and keeps the saved mode, domain and tunnel unless `LAGER_RECONFIGURE=1` is passed.
- **Content security policy:** platform pages now allow scripts only from Lager's own files or with a per-response nonce, and send `X-Content-Type-Options: nosniff`. A reverse proxy that injects its own inline script into the platform's pages (an analytics snippet, say) will find it blocked. The platform also answers `/robots.txt` with "disallow everything".
- **A password change revokes API tokens:** changing a password on the Account page now revokes the account's API tokens, as a reset already did. Scripts and assistants that deploy with a token need a new one afterwards. Only administrators and publishers can create API tokens, over the REST API as in the dashboard.
- **Question before the first sign-in to an app:** whoever opens an instance they neither own nor maintain is asked once whether to continue, and told that the app will see their name (and their email address, if it asks for it). People an instance was shared with are asked too. Sessions on instances that exist already keep working.
- **Confirming an email address takes the password:** the link in the confirmation mail now asks for the password chosen at registration; "Forgot your password?" confirms the address as well. With mail configured, an account created through an invitation without an address has to confirm its address like any other.
- **Accounts pause under attack:** after 10 failed sign-ins in a row an account refuses sign-ins from browsers it does not know for 30 seconds, then for up to 5 minutes. Browsers that signed in before are not affected, and "Forgot your password?" ends a pause. See [Limits on signing in and registering](docs/users-and-sharing.md#limits-on-signing-in-and-registering).
- **Hourly limits for the whole server:** 30 self-registrations, 60 confirmation mails and 60 password-reset mails per hour. The limits per client address count an IPv6 address as its /64 network. With mail configured, registering an address that already has an account answers "check your mail" and mails the owner instead of naming the address.
- **Passwords:** a password may have at most 1024 characters and is no longer cut to 300 when it is set. An account whose longer password was cut by an earlier build signs in again after a reset.
- **Snapshots are bounded by size:** all snapshots of an instance together take at most 3 times the instance quota. The next snapshot of an instance that holds more deletes the oldest ones for good, except the newest and the newest that is at least a day old. Restoring a snapshot is for the owner of the instance only, no longer for people who manage it, and restores and manual version changes are limited to 10 per instance and hour.
- **Old versions are removed:** an app keeps its newest 100 deployed versions. The next deploy of an app with more deletes the surplus for good (not to the trash), except versions an instance still runs.
- **Deploy limit:** an app takes at most 60 new versions per hour, and one person starts at most 60 new apps per hour; further deploys are refused with `deploy_rate` (HTTP 409).
- **Limits on database requests:** an instance takes at most 600 reads and 300 writes per minute from one signed-in viewer (anonymous visitors: 600 and 150 per client address, and 4800 and 1200 for all of them together); further requests get HTTP 429 with `rate_limited`, and live queries retry by themselves. A query takes at most 10 `where` clauses, 5 `orderBy` fields and 30 values in a list. An app that polls in a tight loop or builds very large queries needs changing.
- **Data rules:** writing to the private area (`data/users/<id>/…`) takes contributor level; a viewer can still read and delete there. On a path a person may write but not read, `update` and `acquire` are refused, and `set` and `add` no longer return the stored document. A refused `acquire` no longer names the holder, and an app can look up the names only of people the instance knows (its owner, the people it is shared with, authors and people in its rooms).
- **Language model time limit:** a model call ends with the error `timeout` after 90 seconds instead of 180. `LAGER_AI_TIMEOUT_SECONDS` changes that; keep it below the response timeout of your proxy.
- **Home-screen install of private instances:** the manifest and icons of an instance that is not public show the app's name, description and icon only to a viewer with access; anyone else gets a manifest named "Lager" with the placeholder icon. Apps that bring their own `rel="manifest"` link need `crossorigin="use-credentials"` on it to keep their name when installed.
- **Instances for other accounts:** a publisher can create at most 5 instances per day for other accounts, and none for an account that already owns half of the instances it may own; an administrator is not limited.
- **Deleting accounts:** the administration area (Users) now offers "Delete account" for a disabled account, with its apps and instances handed to another account or moved to the trash. The account's private data in other people's instances is removed in the background afterwards. Nothing happens to existing accounts on its own.
- **Reserved names:** new apps and instances cannot be named `login`, `account`, `accounts`, `mail`, `smtp`, `ftp`, `assets`, `cdn`, `status`, `support` or `security`, nor like the platform's own host under the apps domain. Existing ones keep working.
- **Custom domains:** a parent domain of the platform host or of the apps domain (`example.com` for a platform at `lager.example.com`) and a name under the platform host (`notes.lager.example.com`) can no longer be attached to an instance. Domains that are already attached keep working.
- **OAuth redirect addresses:** a connecting assistant may register only `https://` addresses, `http://` on this computer, schemes in reverse-domain form with three parts (`com.example.app:`) and `cursor:`. Clients registered with another scheme keep their row but new ones are refused.
- **Unused OAuth clients are removed:** a registered client that holds no sign-in and was last used more than 90 days ago is deleted; the assistant registers again when you next connect.
- **Title and note:** a new app title takes at most 100 characters and a version note at most 500, one line each.
- **Plain http:** a platform that is reached without https on another address than this machine logs a warning at the start, and a request that carries two session cookies is signed out, because without https an app could have planted one of them.

[Unreleased]: https://github.com/dm807cam/lager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dm807cam/lager/releases/tag/v0.1.0
