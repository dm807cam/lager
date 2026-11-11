<img src="assets/icon.webp" alt="Lager" width="96" height="96">

# Lager

The only two apps you'll ever need: Claude + Lager.

We used to buy apps. Now Claude builds any app you can imagine, on the spot. Lager is where they run — on your server, with your data staying yours.

Lager is a self-hosted server for Claude artifacts, the small HTML apps that Claude builds for you. Instead of keeping an artifact only inside claude.ai, Claude publishes it to your server:

- Every app gets its own subdomain (`<slug>.apps.example.com`).
- Every deploy creates a numbered version. You can go back to an older version at any time.
- Every app instance has its own data store (documents with live updates) that the artifact uses through `claude.use("db")`. Before the active version changes, Lager takes a snapshot of the documents.
- More building blocks in the style of Claude artifacts: file uploads, realtime rooms with presence, pages that save themselves, and file downloads (see "Building blocks").
- An instance can also answer on a custom domain, and data can be exported, imported and moved along with the app.
- Several accounts with roles. Access per instance: private, all signed-in users, or public, plus grants for single accounts and groups at four levels.
- Lager is operated through a browser dashboard, a REST API and an MCP endpoint for Claude.

Lager runs as a single Node process with SQLite and files in one data directory. There are no other services.

## Quick start with Docker

Requirement: Docker with Compose.

```sh
cp .env.example .env
# edit .env: at least LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN, LAGER_ADMIN_EMAIL, LAGER_ADMIN_PASSWORD
docker compose up -d --build
```

The container listens on port 8080 and is reachable only from the machine itself (`127.0.0.1:8080`): a reverse proxy with TLS belongs in front of it. If the proxy runs on another machine or in another Docker network, change the `ports` line in `docker-compose.yml` (for example to `"8080:8080"`) and protect the port with a firewall so nobody can reach Lager around the proxy.

Everything is stored in the named Docker volume `lager-data`. If you prefer a directory next to the Compose file, replace `"lager-data:/data"` with `"./data:/data"`, remove the `volumes:` section at the end, and create the directory beforehand with suitable permissions, because the container runs as user `node` (UID 1000):

```sh
mkdir -p data && sudo chown 1000:1000 data
```

On first start the first administrator is created from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`. Then open `LAGER_PUBLIC_URL` in a browser and sign in. Further accounts are created through invitations or registration (see "Accounts and roles").

Configuration (environment variables only, template in `.env.example`):

| Variable | Meaning | Default |
| --- | --- | --- |
| `LAGER_PUBLIC_URL` | Public address of the platform (login, dashboard, API, MCP) | required |
| `LAGER_APPS_DOMAIN` | Domain of the apps; instances run at `<slug>.<domain>` | required |
| `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD` | First administrator; only created while no account exists | none |
| `LAGER_DATA_DIR` | Data directory | `./data` (`/data` in the container) |
| `LAGER_PORT` | Port of the server | `8080` |
| `LAGER_SECRET` | Key for sessions; otherwise generated and stored in `secret.key` | generated |
| `LAGER_SNAPSHOT_KEEP` | Data snapshots kept per instance | `20` |
| `LAGER_TRASH_DAYS` | Days that deleted instances and apps stay in the trash (`0` = never clean up) | `30` |
| `LAGER_DEFAULT_LOCALE` | Language of pages and mails when neither the account, the `lager_lang` cookie nor the browser's `Accept-Language` names a supported one: `en`, `de`, `fr`, `es` | `en` |
| `LAGER_SMTP_URL` | SMTP access for outgoing mail, for example `smtps://user:password@smtp.example.com:465`; without a value no mail is sent | none |
| `LAGER_MAIL_FROM` | Sender of the mails | `Lager <no-reply@<host of LAGER_PUBLIC_URL>>` |
| `LAGER_INSTANCE_QUOTA_MB` | Size of an instance's data in MiB, integer from 1 | `50` |
| `LAGER_TRUST_PROXY` | Number of proxy hops in front of Lager whose `X-Forwarded-*` headers are trusted: `false`/`0` none, `true` = 1, or a number | `true` (1) |

## Languages

Lager ships in English, French, Spanish and German. English is the default and the source of every text.

The language of a page is chosen in this order: the signed-in account's language setting (Account page), the language switcher in the page footer (stored in the `lager_lang` cookie), the browser's `Accept-Language` header, and finally `LAGER_DEFAULT_LOCALE`. Mails use the recipient's language where it is known. Dates and sizes are written the way the chosen language writes them.

To add a language:

1. Copy `src/i18n/en.ts` to a new file such as `src/i18n/it.ts` and translate the values. Keep the `{name}` placeholders, and keep "Lager", "Claude" and the role name "Publisher" as they are.
2. In `src/i18n/index.ts`, import the catalog and add it to `CATALOGS`, `LOCALES` and `LOCALE_NAMES`.
3. Add the language to the small table in `src/runtime/runtime.js` (`SAVE_FILE`) that holds the one sentence the browser runtime shows itself: the confirmation before a download (it also formats the file size).

The type checker reports every missing key. `npm test` checks that every catalog has the same keys and placeholders and that every value differs from the English one (except a short list of words that are the same in that language); that every key is used and every `t()` call uses an existing key; that no German appears in the source outside the catalogs; that no page handler, and not the OAuth server, contains inline human-facing text (an HTML text node, a capitalised sentence or a titled attribute in a string or template literal, in any language; error messages for programs, SQL and header values are exempt); and that the pages, the error pages, every notice and every mail render in each language without leftover placeholders. The test cannot judge whether a translation is good, or catch a lowercase phrase that sits outside any HTML.

## Accounts and roles

Lager has several accounts. Each account has exactly one role:

| Role | May |
| --- | --- |
| Administrator | Manage users, roles, invitations, groups and settings, disable instances, create reset links; also everything a publisher may do |
| Publisher | Deploy apps (dashboard, REST API, MCP), create API tokens, create instances of their apps for other accounts, maintain apps together with other publishers or administrators (collaboration) |
| User | Open instances that are shared with them or open to all signed-in users; create their own instances of apps that allow self-service |

How an account comes into being depends on the registration mode, which an administrator sets in the administration area under Settings:

- **Open:** Anyone can create a user account at `/register`.
- **Invitation only:** Registering works only through an invitation link.
- **Closed:** Nobody can register; invitation links do not work either.

The default depends on mail: if `LAGER_SMTP_URL` is set, registration is open, otherwise invitation only. Once an administrator has saved a mode, that choice applies.

An administrator creates invitations in the administration area (Invitations), with a role and optionally an email address that the link is bound to. The link is valid for 7 days and works once. Whoever creates an account through it is signed in immediately. Passwords need at least 10 characters.

Lager creates the first administrator at startup from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`, but only while there is no account at all. You appoint further administrators by changing the role of an existing account. The last active administrator can be neither demoted nor disabled. A disabled account can no longer sign in, and its sessions on the platform and on instances end immediately.

The interface shows administrators metadata only: which apps and instances exist, who owns them and how much storage they use. They can disable an instance, but the interface offers no way to open the data of someone else's instance; they cannot open another account's private instance, and they read data only if they have been granted a level, like any other account. This is a default of the interface, not a technical guarantee against a malicious administrator: administrators control the accounts (links to reset passwords, group memberships) and have access to the server and the data directory. Give the administrator role only to people whose access to the data of all instances you would accept.

## Mail

Lager sends mail for verifying email addresses, resetting passwords and invitations with an address. You set two variables for this:

```sh
LAGER_SMTP_URL=smtps://lager%40example.com:secret@smtp.example.com:465
LAGER_MAIL_FROM=Lager <lager@example.com>
```

Special characters in the user name and password of the URL must be percent-encoded (`@` becomes `%40`). If `LAGER_MAIL_FROM` is missing, the sender is `Lager <no-reply@<host of LAGER_PUBLIC_URL>>`. If sending fails, Lager writes the error to the log and shows users no error message.

Without `LAGER_SMTP_URL` Lager runs completely, just without mail:

- Email addresses are not verified; new accounts are usable at once. For this reason registration defaults to "invitation only".
- Invitations work: the link is shown once to the administrator in the administration area, who passes it on.
- "Forgot password" sends nothing. Instead an administrator creates a reset link in the administration area (Users; valid for 1 hour, usable once) and passes it on.

If you enable mail later, existing accounts stay verified.

## Sharing

There are two ways to let others use an app:

- **The same instance:** Everyone works in the same data. The owner of the instance shares it: with single accounts (by email address), with groups, or through the visibility "all signed-in users" or "public". This works on the instance page in the dashboard, through `PUT /api/instances/<slug>/grants` with `{"email": …, "level": …}` or `{"group": …, "level": …}`, and through the MCP tools `share_instance`, `unshare_instance` and `list_shares`.
- **A separate instance:** Everyone gets their own instance of the same app with separate data. A publisher can create instances for other accounts. In addition, the owner of an app can allow all signed-in users to create an instance themselves (the self-service setting on the app page); they then find the app in the catalog on their overview page and own their instance.

The levels on an instance:

| Level | May |
| --- | --- |
| Viewer (`view`) | Open the app and read data |
| Contributor (`interact`) | additionally write data, as far as the app's rules allow |
| Manager (`admin`) | additionally manage grants, visibility, versions and snapshots |
| Owner (`owner`) | everything, and delete the instance; cannot be granted |

With several routes to the same instance (direct grant, group, visibility "all signed-in users"), the highest level applies. For "all signed-in users" the owner chooses whether these accounts are viewers or contributors (default: contributors). Without app rules, everyone from viewer level reads and everyone from contributor level writes; public visitors can never write.

Administrators create groups in the administration area (Groups) and fill them with accounts. A grant to a group applies to all its members.

An app itself, that is its versions, can be seen and changed only by its owner and the collaborators the owner adds on the app page (administrators or publishers).

## Building blocks

An artifact gets additional functions through `await claude.use("<name>")`. The call never throws and returns `null` when the instance does not offer the building block. A building block is available only if the active version declares it in `capabilities` (except `permissions`). At deploy time you pass `capabilities` as JSON, for example as a query parameter of `PUT /api/apps/<slug>` or as an argument of `deploy_app`. The example `examples/board.html` (a shared pin board) uses `db`, `user`, `assets`, `room` and `downloads`:

```sh
curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
  --data-binary @examples/board.html \
  "https://lager.example.com/api/apps/board?title=Pin%20board&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%2C%22assets%22%3A%7B%7D%2C%22room%22%3A%7B%7D%2C%22downloads%22%3A%7B%7D%7D"
```

| Building block | What it does on Lager | Declaration | Limits |
| --- | --- | --- | --- |
| `db` | Document database of the instance with live updates | `{"db": {}}`, optionally `{"db": {"rules": [...]}}` | Document 256 KiB, path 1000 bytes, query 1000 results; instance storage is limited (see "Limits") |
| `user` | Name and id of the viewer, profiles, people search | `{"user": {}}`; email addresses only with `{"user": {"scopes": ["email"]}}`, search with scope `"profile"` | Every member is async, including `name()` |
| `permissions` | Shows which building blocks are available | none | none |
| `assets` | Upload, list and delete files; they are served from `/_blob/<id>` on the instance | `{"assets": {}}` | Managers and owners may upload; with `{"assets": {"upload": "interact"}}` contributors too (they see and delete only their own files); owners and managers can still list and delete files if the page no longer declares `assets`. An upload must state its `Content-Length`, and at most 2 uploads run at once per viewer and instance. At most 20 MiB per file (CSS and JavaScript 16 MiB, SVG 2 MiB) and 2000 files per instance. Allowed are images, video, audio, PDF, fonts, CSS, JavaScript, CSV, Markdown, JSON and text; HTML is refused, and the content must match the stated type. Files count toward the instance's storage |
| `room` | Ephemeral rooms with messages and presence; nothing is stored, and a server restart empties all rooms | `{"room": {}}`; contributors may send only on topics opened with `{"room": {"topics": {"<topic>": "interact"}}}` | Otherwise managers and owners send, viewers only listen. Message at most 4 KiB, presence at most 2 KiB; per viewer and instance at most 8 open connections (8 rooms) and 30 sends per second, and at most 100 open connections of anonymous visitors per instance; at most 50 rooms per instance and 100 participants per room |
| `artifact` (also `self`) | The page saves itself: `artifact.publish(html)` creates a version that belongs only to this instance and is active there at once | `{"artifact": {}}`; `{"artifact": {"publish": false}}` blocks saving | Managers and owners only. The document must start with `<!doctype html`, at most 16 MiB, 60 save attempts per hour and instance (refused ones count too), the last 20 saved versions are kept (older ones are deleted outright, not moved to the trash). Saved pages count toward the instance's storage |
| `downloads` | `downloads.save({filename, data})` offers the viewer a file to save after a confirmation in the browser; the server is not involved | `{"downloads": {}}` | At most 50 MiB, file name at most 240 bytes; the confirmation names the file and its size; allowed extensions: gif, png, jpg, jpeg, webp, mp4, webm, mov, txt, json, md, docx, pptx, epub, csv, ttf, html, svg, pdf, xlsx, zip, fig |

Whoever saves a page with `artifact.publish` detaches that instance from the app's deploys: it no longer follows new deploys automatically. A deploy lists such instances in the field `pinned` and in its warnings. To follow deploys again, turn "Update automatically" back on: on the instance page, with `POST /api/instances/<slug>/auto-update` and the body `{"on": true}`, or with the MCP tool `set_auto_update`; turning it on moves the instance to the latest deployed version at once (the saved page stays among that instance's saved versions). The saved versions do not appear in the app's version list; only the managers of the instance that saved them can download their HTML.

Everything else stays unavailable: for other names (for example `sample` or `tts`) `claude.use` always returns `null`, and `claude.complete` does not exist (the call rejects with an error message). In the `artifact` building block, `publish` with several files, `edit`, `sync` and `metadata` reject with an error code, and `room.sendToClaudeSession` rejects because Lager has no conversation with Claude beside the page. `check_artifact` (MCP) and `POST /api/check` show before a deploy what an artifact uses, what Lager does not offer and what is not yet declared. The check is best effort: it only sees `claude.use("…")` calls whose name is a string literal.

The event streams (`/__lager/db/events`, `/__lager/room/events`) and the files at `/_blob/<id>` answer only the instance's own page: a request that the browser marks as coming from another site or from another instance (even one under the same apps domain) is refused, so another page cannot open them or embed the files with the visitor's cookies.

## App icons and home-screen install

Every app has an icon, a one-sentence description and a theme colour. Claude supplies them when it deploys: `deploy_app` takes `icon_svg`, `description` and `theme_color`, `set_app_icon` changes them later. On REST, `PUT /api/apps/<slug>` accepts `description` and `theme_color` (query or JSON) and `icon_svg` (JSON only), `PUT /api/apps/<slug>/icon` takes a body of type `image/svg+xml`, and `PATCH /api/apps/<slug>` takes `{"description", "theme_color"}`. Results of `deploy_app`, `get_app` and `list_apps` carry `description`, `themeColor` and `iconUrl` (the public 192 px PNG on the platform host). Without an icon a new app gets a generated one (a gradient and a simple shape derived from its name) and the deploy result says so; a redeploy without `icon_svg` keeps the icon, and an icon that is refused never fails a deploy: the previous or generated icon stays and the reason is a warning (`set_app_icon` returns an error instead).

The SVG comes from a client you do not control, so it is checked before it is drawn and **only PNGs rendered on the server are ever served; the SVG itself never reaches a browser.** Accepted are plain shapes and paths: the root must be `<svg>`, at most 64 KiB, 2000 elements and 32 levels deep. Refused are DOCTYPE and entity declarations, processing instructions (except the XML declaration), `<script>`, `<foreignObject>`, `<iframe>`, `<image>`, `<text>` and similar elements, `on…` attributes, and every `href` or `url()` that does not point to a `#fragment` of the icon itself. Anything the checker cannot read as well-formed XML is refused too. Drawing uses `@resvg/resvg-wasm`, which is read from `node_modules` at run time (it needs no native build and no system fonts) and renders at a fixed size whatever size the SVG declares.

Icons are stored under `<data>/apps/<app id>/icon/` and go to the trash with the app. They are served at `<platform>/app-icons/<app id>/<icon version>/<64|192|512>.png` (public, cached for a year; the version changes with every icon change and a wrong version is redirected to the current one).

Every instance can be added to a phone's home screen. Its pages carry a manifest, `apple-touch-icon` and theme-colour tags (unless the artifact brings its own `rel="manifest"` link) and a viewport tag when the artifact has none. The manifest (`/__lager/manifest.webmanifest`), the icons (`/__lager/icon-180.png`, `-192`, `-512`, `-512-maskable`), `/apple-touch-icon.png` and `/favicon.ico` are public even for private instances, because the browser fetches them without signing in; they show only the name, description, colours and icon, and a disabled instance serves none of them. The platform has its own manifest and icons as well. To install, open the app on the phone and choose "Add to Home Screen"; signing in happens in the browser the first time.

## Light and dark

The web interface follows the device's light or dark setting. The account menu has a theme switch that cycles between system, light and dark; the choice is kept in that browser only (local storage), and a tiny script in the page head applies it before the first paint so there is no flash. Without JavaScript the pages work the same and simply follow the system setting. The interface loads one stylesheet and one small script from the platform host (`/static/app.<hash>.css` and `.js`, cached for a year because the hash changes with the content) and nothing from anywhere else.

## Limits

- **Storage per instance:** The data of an instance is limited to `LAGER_INSTANCE_QUOTA_MB` (default 50 MiB). This size includes the documents, the uploaded files (`assets`) and the pages an instance saved itself (`artifact`). When the limit is reached, Lager refuses further writes, uploads and saves with the error `quota_exceeded` (HTTP 507 for the database); reading and deleting keep working. Versions created by deploys, snapshots and the trash are not counted.
- **Instances per user:** Every account that is not an administrator may own at most as many instances as an administrator sets in the administration area under Settings (1 to 1000, default 20). This applies when creating further instances, including self-service.
- **New instances per day:** Accounts that are not administrators may create at most 10 instances within 24 hours; deleted instances count, and so does the instance created by the first deploy of an app. This stops anyone from filling the storage by creating, filling and deleting in a loop.
- **Open connections:** Per viewer and instance at most 8 live-update streams for the database and 8 for rooms; for anonymous visitors the viewer is the client address, and all of them together may hold at most 100 per instance. Further ones get HTTP 429, and the page works without live updates there.
- **Paths and documents:** Paths are limited to 16 segments and 1000 bytes; a document is at most 256 KiB.
- **Domains:** At most 10 custom domains per instance.
- **Saved versions:** An instance keeps its last 20 self-saved pages; older ones are deleted.
- **Snapshots:** They contain only the documents of the instance. `restore_snapshot` does not restore uploaded files or self-saved pages.
- **Reserved names:** The name of a deleted instance stays reserved for its former owner. Other accounts cannot take it over, because otherwise stored browser data and service workers of the old instance would carry over to the new one.

## Deleting and trash

When the owner deletes an instance or an app in the dashboard, Lager removes it from the platform but only moves the files to `<data directory>/trash` (`/data/trash` in the container): the data of an instance, including its uploads, as `<instance id>-<timestamp>`, and the versions of an app as `app-<app id>-<timestamp>`. Lager offers no restore for this; recovering is possible only by copying the files back. At startup and every 24 hours afterwards, Lager removes entries older than `LAGER_TRASH_DAYS` days (default 30; `0` turns the cleanup off, and you then empty the directory by hand). The age is taken from the timestamp in the name. Per run Lager writes one line to the log. An app can be deleted only while no instances of other accounts exist for it. Instances that an administrator has disabled can still be deleted by their owner.

## Trying it locally

Browsers resolve `*.localhost` to `127.0.0.1` on their own, so no DNS entry is needed locally.

```sh
npm ci
cp .env.example .env     # the values for local use are already filled in
set -a; . ./.env; set +a
LAGER_DATA_DIR=./data npm run dev
```

- Platform: `http://localhost:8080`
- Instances: `http://<slug>.apps.localhost:8080`

The platform is called `localhost` and not `lager.localhost` because the MCP SDK accepts an address without https for OAuth only for the host name `localhost`.

Node.js 22.13 or newer is required. `npm test` runs the tests; `npm run build && npm start` starts the built server.

## Running behind Nginx Proxy Manager

Lager needs two host names, both pointing at the same port:

1. The platform, for example `lager.example.com`.
2. All apps: `*.apps.example.com` (wildcard).

Preparation:

- DNS: `lager.example.com` and `*.apps.example.com` point to the proxy.
- Certificate: for `*.apps.example.com` you need a wildcard certificate. That works only with a DNS challenge, in Nginx Proxy Manager under "SSL Certificates → Add → Let's Encrypt" with "Use a DNS Challenge" and the provider of your domain.
- `.env`: `LAGER_PUBLIC_URL=https://lager.example.com`, `LAGER_APPS_DOMAIN=apps.example.com`. Instances then get addresses like `https://notes.apps.example.com`.

In Nginx Proxy Manager you create two proxy hosts:

| Domain Names | Forward | Options |
| --- | --- | --- |
| `lager.example.com` | `http`, host of the container, port 8080 | Websockets Support on, SSL certificate, Force SSL |
| `*.apps.example.com` | `http`, host of the container, port 8080 | Websockets Support on, wildcard certificate, Force SSL |

Live updates of the database (`/__lager/db/events`) and of the realtime rooms (`/__lager/room/events`) are delivered as Server-Sent Events. The proxy must not buffer these responses. On the "Advanced" tab of the proxy host `*.apps.example.com`, enter:

```nginx
location ~ ^/__lager/(db|room)/events$ {
    proxy_pass http://<host of the container>:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

Alternatively you can put the line `proxy_buffering off;` directly into the host's "Custom Nginx Configuration". Without this setting, changes and presence of other users show up late or only after a reload. The same applies to the proxy host of every custom domain (see below).

By default Lager trusts exactly one proxy in front of it (`LAGER_TRUST_PROXY=true`, one hop) and takes the last entry of `X-Forwarded-For` as the client address. If several proxies are chained, set the number (for example `2`). Set `false` if Lager is reachable directly from the internet; otherwise anyone can forge the client address and get around the limit on sign-in attempts.

## Custom domains

An instance can answer on its own host name in addition to `<slug>.apps.example.com`, for example `notes.example.org`. The address under the apps domain stays and is the first URL of the instance.

**Who may do this:** By default only administrators. An administrator can switch the setting for custom domains in the administration area (Settings) to also allow publishers; then publishers may do it too. A publisher must also manage the instance, that is be its owner or a manager (`admin`). Administrators may handle the domains of any instance, without owning it or holding a grant: in the administration area under Apps (the link "Domains" per instance), through the same REST and MCP calls. You enter the domain on the instance page in the dashboard, with `PUT /api/instances/<slug>/domains` and the body `{"host": "notes.example.org"}` (plus `GET` and `DELETE`), or with the MCP tools `add_domain` and `remove_domain`. An instance can have at most 10 custom domains. A host name belongs to at most one instance on the whole server. The host name of the platform and all names under `LAGER_APPS_DOMAIN` are not allowed.

**Host name rules:** a DNS name of at least two labels made of letters, digits and hyphens (at most 253 characters in all), written in lower case or converted to it; one trailing dot is dropped. No port, no IP address (the last label must start with a letter), no wildcard and no underscore. Names ending in `.localhost`, `.local` or `.internal` are refused.

**Lager does not verify who owns the domain.** It only decides that requests with this host name go to the instance. Whoever may enter a domain can therefore claim any host name whose DNS points to your proxy. Grant the right with care, and leave it at administrators only if you do not trust your publishers.

The steps outside Lager:

1. DNS: create an A or CNAME record for the domain that points to your proxy.
2. Certificate: in Nginx Proxy Manager, request a certificate for this domain under "SSL Certificates → Add → Let's Encrypt" (the domain must already point to the proxy; a DNS challenge is needed only for wildcards).
3. Proxy host: in Nginx Proxy Manager create a proxy host for the domain: `http`, host of the container, port 8080, Websockets Support on, the certificate from step 2, Force SSL. The proxy must pass the `Host` header on unchanged (Nginx Proxy Manager does this by default). On the "Advanced" tab, add the same `location` block for the event streams as for the apps proxy host.
4. Only then enter the domain in Lager.

**Sign-in:** Sign-in still goes through the platform (`LAGER_PUBLIC_URL`). A visitor without a session is sent from the custom domain to the platform, signs in there and returns with a one-time code to the domain they started on; the code is valid only for that host name. The instance cookie is per host name: someone who has opened the instance at `<slug>.apps.example.com` is not yet signed in on the custom domain and goes through the flow there once. Access rights are the same as under the apps domain. If you remove the domain or delete the instance, Lager answers requests for the host name with "not found".

## Connecting Claude

The dashboard shows the address of your connector: `<LAGER_PUBLIC_URL>/mcp`.

OAuth, which claude.ai and Claude Desktop use when connecting, works only if `LAGER_PUBLIC_URL` starts with `https` or the host is `localhost`. API tokens work with any address.

- **claude.ai and Claude Desktop:** Settings → Connectors → add a custom connector and enter the address `<LAGER_PUBLIC_URL>/mcp`. When connecting, you sign in to Lager and allow access.
- **Claude Code:**
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp
  ```
  Then open `/mcp` in Claude Code and complete the sign-in.
- **API token instead of OAuth:** Create a token in the dashboard under API tokens. It is shown only once. Both of these work with it:
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp \
    --header "Authorization: Bearer lgr_..."

  curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
    --data-binary @examples/notes.html \
    "https://lager.example.com/api/apps/notes?title=Notes&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%7D"
  ```

The deploy response contains the addresses of the instance (first the one under the apps domain, then custom domains), the warnings, and the instances that were not updated (`pinned`). `examples/notes.html` is a small example artifact (a note list with `claude.use("db")`), and `examples/board.html` is a shared pin board with uploads, presence and export (see "Building blocks").

## Installing the skill

The skill `skill/lager/SKILL.md` teaches Claude to build and deploy artifacts with Lager. Its content is the same guide that the MCP endpoint serves (`src/guide.md`).

- **Claude Code:** `cp -r skill/lager ~/.claude/skills/lager`
- **claude.ai and Desktop:** Pack the folder `skill/lager` as a ZIP and upload it under Settings → Skills.

## Export, import and moving

**Exporting data:** The instance page in the dashboard has a link to export the data as NDJSON. `GET /api/instances/<slug>/export` with a bearer token returns the same, as does the MCP tool `export_data`, which returns 200 documents by default (at most 1000, and about 8 MiB) and may stop early: its answer carries `truncated`, and when that is true you narrow the `prefix` and ask again. The REST export and the dashboard link are complete. The file contains one line `{"path": …, "data": …}` per document, plus the exporting account's own private area (`data/users/<id>/…`) but not the private areas of others. The account must manage the instance (owner or manager). The owner exports everything except other users' private areas; a manager gets only the documents that the app's rules let them read. Lager exports only the database as documents: uploads, snapshots, grants and domains are not included.

**Importing data:** `POST /api/instances/<slug>/import` with `Content-Type: application/x-ndjson` (one line per document, ideally the export file) or a JSON array of `{path, data}`; at most 20 MiB (a JSON array at most 5 MiB) and 100000 documents per call, and only one import runs at a time per instance (a second one is refused with HTTP 409). Document paths are limited to 1000 bytes. A manager can only write paths that the app's rules let them write; the owner is not restricted. The MCP tool `import_data` takes at most 1000 documents per call. An import replaces documents with the same path and deletes no others. Lager takes no snapshot before an import; back up existing data beforehand with an export if needed. You can import into the same instance or another one, also one of a different app, and so move data between servers. You create the second instance with `POST /api/apps/<slug>/instances` or `create_instance`.

```sh
curl -H "Authorization: Bearer $LAGER_TOKEN" https://lager.example.com/api/instances/board/export > board.ndjson
curl -X POST -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: application/x-ndjson" \
  --data-binary @board.ndjson https://lager.example.com/api/instances/board-2/import
```

**Downloading the HTML of a version:** The version list of an app has an HTML link per version; over REST it is `GET /api/apps/<slug>/versions/<n>`. The file arrives as an attachment (`text/plain`, with `X-Content-Type-Options: nosniff`) and is never rendered on the platform. Everyone who may read the app (owner and collaborators) can download deployed versions; self-saved versions only the managers of the instance that saved them.

**Moving an existing artifact with Claude:** Give Claude the source of the artifact and let it, with the Lager connector connected or the skill installed, follow the guide "Taking over existing artifacts" from `get_guide`. Claude checks the HTML with `check_artifact` (used, unsupported and undeclared building blocks, browser storage, `claude.complete`), converts what is supported, declares the building blocks, deploys, transfers data with `import_data` and spot-checks the result.

**What cannot be moved automatically:**

- Data that lives only in the user's browser (`localStorage`, `sessionStorage`, `indexedDB`): the old artifact must save it once as a file, which you then import.
- Building blocks that Lager does not offer (`claude.complete`, `sample`, `tts` and similar): the feature is dropped or must be replaced.
- Uploaded files: they must be uploaded again through the app, and the references to them change.
- Private areas of other users, grants, domains, snapshots and earlier versions from another platform.

## Backup

Everything lives in the data directory (with Docker Compose the volume `lager-data`, with a bind mount `./data`): the platform database, all versions, the data, uploads and snapshots of the instances, and `secret.key`. To back up, stop the service and copy the volume or directory. With the volume (Compose project name `lager`, otherwise `<directory name>_lager-data`; `docker volume ls` shows it):

```sh
docker compose stop
docker run --rm -v lager_lager-data:/data -v "$PWD":/backup alpine tar czf /backup/lager-backup-$(date +%F).tgz -C /data .
docker compose start
```

With a bind mount, `cp -a data data-backup-$(date +%F)` is enough.

To restore, copy the contents back (or unpack the archive into an empty volume). Keep `secret.key` (or `LAGER_SECRET`), otherwise all sessions become invalid.

## What Lager cannot do

- No sign-in through external providers (single sign-on); accounts use email and password.
- The quota applies to the data of an instance (documents, uploaded files, self-saved pages), not to deployed versions, snapshots or the trash (which is emptied after the retention period). There is no limit on the total size.
- Snapshots back up only documents, not uploaded files and not self-saved pages.
- The trash is emptied after `LAGER_TRASH_DAYS` days (default 30) and cannot be restored through Lager.
- Only the building blocks `db`, `user`, `permissions`, `assets`, `room`, `artifact` (`self`) and `downloads`; all other names return `null`, `claude.complete` is missing, and there are no messages to Claude from the page.
- Realtime rooms live only in memory: no history, nothing survives a restart, and several Lager processes do not share rooms.
- For custom domains, Lager does not check who owns the host name.
- No TLS of its own: HTTPS is handled by the proxy in front.
- No automatic backup and no replication.

## Notes

Lager is an independent project and is not affiliated with Anthropic; Claude is a trademark of Anthropic.
