# Installation

How to run Lager on your own server: with one command, or by hand with Docker Compose and a reverse proxy.

## One-command install

For a Raspberry Pi or any 64-bit Linux server, one command installs, configures and starts Lager:

```sh
curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh | sudo bash
```

**Run it again to update.** The second run asks nothing. It takes a backup of the running server, pulls the image this installation uses (by default `:latest`, the most recently published release; see [Published images](#published-images)) and restarts Lager, keeping settings and data. If the backup fails, the installer shows the error and stops before it changes anything (the backup is the first step of an update, before settings, the Compose file or the tunnel are written), so Lager keeps running as it was; `LAGER_SKIP_BACKUP=1` updates without a backup. If Lager is not running at that moment, no backup can be taken and the installer says so. The script lives in the repository as [`install.sh`](../install.sh); read it before you pipe it into a shell.

### What it does

1. **Checks the system:** root, Linux, a 64-bit processor (amd64 or arm64). On a Raspberry Pi that means the 64-bit Raspberry Pi OS.
2. **Installs Docker** with Docker's official script if it is missing.
3. **Asks how Lager should be reached** (only on the first run):

   | Choice | Addresses | Good for |
   | --- | --- | --- |
   | **Cloudflare** (recommended) | `https://<domain>` and `https://<app>.<domain>` | Use from anywhere with https, without opening ports or handling certificates |
   | **This network only** | `http://lager.<ip>.sslip.io:8080` and `http://<app>.apps.<ip>.sslip.io:8080` | Trying Lager at home. AI assistants connect with an [API token](connecting-ai.md#the-connector-address); claude.ai and ChatGPT need https. Read the two caveats under [This network only](#this-network-only) |
   | **Own reverse proxy** | the addresses you enter | You already run a proxy with TLS and wildcard DNS (see [Reverse proxy requirements](#reverse-proxy-requirements) and [Running behind Nginx Proxy Manager](#running-behind-nginx-proxy-manager)) |

4. **Asks for the administrator's email address** and generates a password, which it shows once at the end. Change it on the Account page.
5. **Writes** `/opt/lager/.env` (your settings, kept on every run) and `/opt/lager/docker-compose.yml` (rewritten on every run), then starts Lager and waits until it answers.

### Cloudflare

You need a free Cloudflare account and a domain whose DNS Cloudflare manages. Use a domain for Lager alone (for example `mylager.net`). The platform lives on the domain itself and every app directly below it, because Cloudflare's free certificate covers exactly the domain and one level of subdomains. A layout such as `*.apps.example.com` would need a paid certificate.

The installer runs [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) in a second container:

1. It shows a link. Open it on any device, sign in to Cloudflare, choose the domain and confirm. The installer continues by itself.
2. It creates a tunnel named `lager-<hostname>` and points `<domain>` and `*.<domain>` at it.
3. It writes `/opt/lager/cloudflared/config.yml` and starts the tunnel together with Lager.

No port on your router has to be opened, and the server's address stays private. Live updates in apps work through the tunnel. If Cloudflare refuses the wildcard DNS record, the installer tells you the one record to add by hand: CNAME `*`, target `<tunnel id>.cfargotunnel.com`, proxied.

### This network only

This choice needs no domain: the addresses are names on [sslip.io](https://sslip.io), a public DNS service that answers every name containing an IP address with that address. `lager.192-168-1-23.sslip.io` resolves to `192.168.1.23`, the machine Lager runs on. Two things can break these addresses:

- **DNS rebind protection.** Many routers refuse public names that resolve to an address inside the home network. Fritz!Box does so by default, and OpenWrt and pfSense do when the protection is on. The browser then reports that the server cannot be found. Add `sslip.io` to the router's exceptions: on a Fritz!Box under Home Network → Network → Network Settings → DNS Rebind Protection; in OpenWrt as a whitelisted domain of the rebind protection (`rebind_domain`); in pfSense as a `private-domain` entry of the DNS Resolver.
- **The IP address is part of every address.** The installer writes the machine's current address into `.env`. If the router later hands out a different one, no Lager address works any more. Give the machine a fixed address (a DHCP reservation in the router). After a change, run the installer again with `LAGER_RECONFIGURE=1 LAGER_MODE=local`; apps then get new addresses, and their data stays.

The devices also need internet access to resolve the names. For anything beyond trying Lager out, use Cloudflare or your own reverse proxy.

### Answering ahead of time

Set the answers as environment variables to install without questions, for example on many machines:

```sh
curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh \
  | sudo LAGER_MODE=cloudflare LAGER_DOMAIN=mylager.net LAGER_ADMIN_EMAIL=me@example.com bash
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `LAGER_MODE` | `cloudflare`, `local` or `proxy`. Like the domain and the addresses below, it is read on the first run and with `LAGER_RECONFIGURE=1` only; a plain update keeps what was set up, and says so if you pass something else | asked |
| `LAGER_DOMAIN` | Cloudflare mode: the domain | asked |
| `LAGER_PUBLIC_URL`, `LAGER_APPS_DOMAIN` | Proxy mode: the addresses | asked |
| `LAGER_ADMIN_EMAIL` | The first administrator | asked |
| `LAGER_NONINTERACTIVE` | `1` never asks and fails when an answer is missing | `0` |
| `LAGER_RECONFIGURE` | `1` asks the questions again (data and the administrator stay) | `0` |
| `LAGER_DIR` | Where everything lives | `/opt/lager` |
| `LAGER_IMAGE` | The image to run, for example `ghcr.io/dm807cam/lager:edge` for the development version or `ghcr.io/dm807cam/lager:0.1` to stay on one release line (see [Published images](#published-images)). The installer remembers it in `installer.env`, so later runs keep it until you pass another one | `ghcr.io/dm807cam/lager:latest` |
| `LAGER_BACKUPS_KEEP` | Backups kept from updates | `5` |
| `LAGER_SKIP_BACKUP` | `1` updates without taking a backup first. Without it, a failed backup stops the update | `0` |
| `LAGER_BIND` | Proxy mode: the address of this machine on which Docker publishes Lager's port 8080. Keep `127.0.0.1` when the proxy runs on the same machine; set the machine's address (or `0.0.0.0`) when the proxy runs elsewhere, and protect the port with a firewall | `127.0.0.1` |

`LAGER_BIND` is a setting of the installer, not of the server. The installer stores it in `.env` and writes it into the `ports` line of `docker-compose.yml` (`"<LAGER_BIND>:8080:8080"`); Lager itself ignores it. Cloudflare mode always uses `127.0.0.1`, because the tunnel reaches Lager inside Docker's network, and "this network only" always uses `0.0.0.0`. To change it later, edit `LAGER_BIND` in `/opt/lager/.env` and run the installer again. Do not confuse it with [`LAGER_HOST`](#configuration), the address the server binds to inside the container or when it runs without Docker.

### Files, backups and removal

- `/opt/lager/data/`: all data (see [Backup](data-and-backup.md#backup)).
- `/opt/lager/backups/`: one backup per update in a folder named after the time (`2026-01-31-020000`), the newest five kept. They contain `secret.key`; protect them like the data itself (see [Backup](data-and-backup.md#backup)).
- `/opt/lager/.env`: settings. Edit it and run the installer again to apply them.
- `/opt/lager/installer.env`: what the installer remembers between runs (the way Lager is reached, the tunnel, the image).
- **Logs:** `cd /opt/lager && docker compose logs -f lager`.
- **Removal:** `cd /opt/lager && docker compose down`, then delete the folder. With Cloudflare, also delete the tunnel and its DNS records in the Cloudflare dashboard.

## Docker Compose

Requirement: Docker with Compose.

```sh
cp .env.example .env
# edit .env: at least LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN, LAGER_ADMIN_EMAIL, LAGER_ADMIN_PASSWORD
docker compose up -d --build
```

This builds the image from the checked-out source. To use a published image instead, see [Published images](#published-images).

The container listens on port 8080 and is reachable only from the machine itself (`127.0.0.1:8080`): a reverse proxy with TLS belongs in front of it. If the proxy runs on another machine or in another Docker network, change the `ports` line in `docker-compose.yml` (for example to `"8080:8080"`) and protect the port with a firewall so nobody can reach Lager around the proxy.

Everything is stored in the named Docker volume `lager-data`. If you prefer a directory next to the Compose file, replace `"lager-data:/data"` with `"./data:/data"`, remove the `volumes:` section at the end, and create the directory beforehand with suitable permissions, because the container runs as user `node` (UID 1000):

```sh
mkdir -p data && sudo chown 1000:1000 data
```

On first start the first administrator is created from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`. The password needs at least 10 characters; with a shorter one, or with the example value on an address other machines can reach, Lager stops with a message and creates no account. While no account exists, Lager also refuses to start if either of the two variables is missing, because nobody could ever sign in. Then open `LAGER_PUBLIC_URL` in a browser and sign in. Further accounts are created through invitations or registration (see [Users and sharing](users-and-sharing.md#accounts-and-roles)).

## Published images

Images are built for `linux/amd64` and `linux/arm64` (so a Raspberry Pi works too) and published to the GitHub Container Registry as `ghcr.io/dm807cam/lager`, after the tests pass. Which tags are written depends on what was pushed to the repository:

| Pushed | Tags written | Use it for |
| --- | --- | --- |
| A release tag `v1.2.3` | `:1.2.3`, `:1.2`, `:1`, `:latest` and `:sha-<commit>` | `:latest` follows the releases. `:1.2.3` pins one exact release, `:1.2` and `:1` follow a release line |
| A release tag `v0.4.1` | `:0.4.1`, `:0.4`, `:latest` and `:sha-<commit>` | While Lager is 0.x there is no `:0`, because every minor release may break: pin `:0.4` or `:0.4.1` |
| A pre-release tag `v1.2.3-rc.1` | `:1.2.3-rc.1` and `:sha-<commit>` | Trying a release candidate. It moves neither `:latest` nor `:1.2` or `:1` |
| A commit on `main` | `:edge` and `:sha-<commit>` | The development version, for testing. It can be ahead of `:latest` and may break |

`:latest` points at the release whose tag was pushed most recently, which is not necessarily the highest version: if a fix for an older line (`v1.1.5`) is tagged after `v1.2.0`, `:latest` and `:1` move to it until the next release is tagged. `:latest` never moves on a commit to `main` or on a pre-release tag. Until the first release is tagged, `:latest` does not exist and `:edge` is the only moving tag.

To run a published image, replace `build: .` in `docker-compose.yml` with `image: ghcr.io/dm807cam/lager:latest` and start with `docker compose up -d`. To update, run `docker compose pull && docker compose up -d`. Your data stays in the volume. Back it up before a major version change (see [Backup](data-and-backup.md#backup)).

## Configuration

Lager is configured through environment variables only. The template is `.env.example`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `LAGER_PUBLIC_URL` | Public address of the platform (login, dashboard, API, MCP): `http://` or `https://`, host and optionally a port, without a path, query or user name | required |
| `LAGER_APPS_DOMAIN` | Domain of the apps; instances run at `<slug>.<domain>`. A bare host name: no `https://`, no `*.`, no port, no `/` | required |
| `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD` | First administrator; only created while no account exists. The password needs at least 10 characters, and the example value from `.env.example` is accepted only while `LAGER_PUBLIC_URL` points at this machine (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`); otherwise Lager does not start. On such an address the example value still logs a warning: change the password before others can reach the server | none |
| `LAGER_DATA_DIR` | Data directory | `./data` (`/data` in the container) |
| `LAGER_PORT` | Port of the server, 1 to 65535 (`0` lets the system pick a free port; the start line names it) | `8080` |
| `LAGER_HOST` | Address the server binds to. Without Docker, set `127.0.0.1` when the reverse proxy runs on the same machine, so nobody reaches Lager around the proxy. Leave it empty in the container | every interface |
| `LAGER_ACCESS_LOG` | `true` writes one line per request to the log (time, client address, method, host and path without the query string, status, duration) | `false` |
| `LAGER_SECRET` | Key for sessions and for encrypting stored AI provider keys; otherwise generated and stored in `secret.key`. If set, use at least 32 random characters (for example `openssl rand -hex 32`): a first start with a shorter one is refused, and an existing installation only logs a warning at startup. Changing the secret signs everyone out and makes stored AI provider keys unreadable, so they have to be entered again | generated |
| `LAGER_SNAPSHOT_KEEP` | Data snapshots kept per instance, 1 or more (`0` is read as 1, with a warning) | `20` |
| `LAGER_TRASH_DAYS` | Days that deleted instances and apps stay in the trash (`0` = never clean up) | `30` |
| `LAGER_DEFAULT_LOCALE` | Language of pages and mails when neither the account, the `lager_lang` cookie nor the browser's `Accept-Language` names a supported one: `en`, `de`, `fr`, `es` | `en` |
| `LAGER_SMTP_URL` | SMTP access for outgoing mail, for example `smtps://user:password@smtp.example.com:465`; without a value no mail is sent. The scheme must be `smtp` or `smtps`, and special characters in the user name and password must be percent-encoded. A mail server that does not answer within 10 seconds counts as unreachable | none |
| `LAGER_MAIL_FROM` | Sender of the mails | `Lager <no-reply@<host of LAGER_PUBLIC_URL>>` |
| `LAGER_INSTANCE_QUOTA_MB` | Size of an instance's data in MiB, integer from 1 | `50` |
| `LAGER_AI_TIMEOUT_SECONDS` | Seconds a language model may take to answer an app (`lager.complete`), 5 to 600; after that the app gets the error `timeout`. Keep it below the time your proxy waits for a response: Cloudflare cuts off after about 100 seconds | `90` |
| `LAGER_TRUST_PROXY` | Number of proxy hops in front of Lager whose `X-Forwarded-*` headers are trusted: `false`/`0` none, `true` = 1, or a number (see [Reverse proxy requirements](#reverse-proxy-requirements)) | `true` (1) |

The installer adds one setting of its own to `.env`, [`LAGER_BIND`](#answering-ahead-of-time). The server does not read it.

## Mail

Lager sends mail for verifying email addresses, resetting passwords and invitations with an address. You set two variables for this:

```sh
LAGER_SMTP_URL=smtps://lager%40example.com:secret@smtp.example.com:465
LAGER_MAIL_FROM="Lager <lager@example.com>"
```

Keep the quotes around `LAGER_MAIL_FROM`: without them, loading `.env` in a shell (`set -a; . ./.env`) reads `<` as a redirect. Docker Compose accepts the quotes as well. Special characters in the user name and password of the URL must be percent-encoded (`@` becomes `%40`). If `LAGER_MAIL_FROM` is missing, the sender is `Lager <no-reply@<host of LAGER_PUBLIC_URL>>`. If sending fails, Lager writes the error to the log and shows users no error message.

Without `LAGER_SMTP_URL` Lager runs completely, just without mail:

- Email addresses are not verified; new accounts are usable at once. For this reason registration defaults to "invitation only".
- Invitations work: the link is shown once to the administrator in the administration area, who passes it on. An account created through it is usable at once.
- "Forgot password" sends nothing. Instead an administrator creates a reset link in the administration area (Users; valid for 1 hour, usable once) and passes it on.

If you enable mail later, existing accounts stay verified.

## Reverse proxy requirements

Lager speaks plain HTTP on one port and expects a reverse proxy with TLS in front. It needs two host names, both forwarded to that port: the platform (for example `lager.example.com`) and a wildcard for the apps (`*.apps.example.com`), plus every [custom domain](custom-domains.md). Whatever proxy you use, it must do the following:

| Requirement | Why | nginx default |
| --- | --- | --- |
| Pass the `Host` header on unchanged | Lager decides by the host name whether a request goes to the platform or to which app. With a changed host it answers 404. If the proxy sends `X-Forwarded-Host`, it must carry the same original host name, because Lager prefers it | replaced by the upstream's name: set `proxy_set_header Host $http_host` |
| Set `X-Forwarded-Proto` | The two event streams of live updates (`/__lager/db/events`, `/__lager/room/events`) compare the browser's `Origin` header with the address the request arrived at, and take its scheme from this header. Without it Lager sees `http`, the `Origin` of an https page does not match, and both streams are refused with 403: apps load and save, but changes by others and presence no longer arrive live. Nothing else reads the header: cookies, sign-in and OAuth follow `LAGER_PUBLIC_URL` | not set |
| Set `X-Forwarded-For` | Lager takes the client address from it, for the limit on sign-in attempts, the limits for anonymous visitors and the access log. Without it, all visitors share the proxy's address | not set |
| Allow request bodies of 24 MiB | The largest body Lager accepts is 24 MiB: a deploy sent as JSON through the REST API or MCP (the HTML itself may be 16 MiB). Uploads (`assets`) are at most 20 MiB and imports at most 20 MiB | 1 MiB (`client_max_body_size`): larger deploys and uploads fail with 413 |
| Wait at least 30 seconds for the next bytes of a response | Live updates (`/__lager/db/events`, `/__lager/room/events`) are Server-Sent Events that stay open. Lager writes a ping every 25 seconds, so the connection is never silent for longer | 60 s (`proxy_read_timeout`): enough |
| Wait longer than a model call can take | `lager.complete` (`/__lager/complete`) answers only when the language model has answered, which can take up to 90 seconds (`LAGER_AI_TIMEOUT_SECONDS`). Keep the proxy's read timeout above that, so a slow answer ends as Lager's own `timeout` error and not as the proxy's 504 | 60 s: long model calls end with 504 |
| Keep idle connections to Lager for less than 65 seconds | Lager closes a connection that has been idle for 65 seconds. A proxy that reuses connections for longer can send a request into one that is just closing and answer 502 | 60 s (`keepalive_timeout` of an `upstream` block): fine |
| Do not buffer the event streams | Buffered events arrive late or only when the connection closes | buffering is on, but Lager sends `X-Accel-Buffering: no` with these responses, which nginx obeys: nothing to configure |

If a header set in one `location` seems to get lost in nginx: `proxy_set_header` lines are inherited from the level above only when a `location` has none of its own. A `location` that sets a single header therefore has to repeat `Host` and the `X-Forwarded-*` headers.

**Security headers:** Lager sets these itself, so the proxy does not need to add them. Platform responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. Every platform page also carries a content security policy in a `<meta>` tag: scripts run only from the platform's own files or with a nonce that is new for every response (`script-src 'self' 'nonce-…'`), with `object-src 'none'` and `base-uri 'none'`, and on signed-in pages `form-action 'self'`. If your proxy adds a `Content-Security-Policy` header of its own to the platform host, both apply, and a stricter `script-src` without the nonce stops the theme from being applied before the first paint. Do not add a content security policy to the apps domain: what an app loads is the app's business. The platform answers `/robots.txt` with "disallow everything"; instance hosts have no `robots.txt` of their own.

Tell Lager how many proxies are in front of it. By default it trusts exactly one (`LAGER_TRUST_PROXY=true`, one hop) and takes the last entry of `X-Forwarded-For` as the client address. If several proxies are chained, set the number (for example `2`). Set `false` if Lager is reachable directly from the internet; otherwise anyone can forge the client address and get around the limit on sign-in attempts. With `false` Lager also ignores `X-Forwarded-Proto` and `X-Forwarded-Host`.

A minimal nginx server (add your certificates; the wildcard certificate needs a DNS challenge):

```nginx
server {
    listen 443 ssl;
    server_name lager.example.com *.apps.example.com;
    # ssl_certificate and ssl_certificate_key for both names

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 200s;
    }
}
```

A minimal Caddyfile. Caddy passes `Host` on unchanged, sets the `X-Forwarded-*` headers, has no body limit and no read timeout by default, and does not buffer event streams, so nothing else is needed. The wildcard certificate needs a Caddy build with the DNS module of your provider:

```caddyfile
lager.example.com, *.apps.example.com {
    tls {
        dns <provider> <credentials>
    }
    reverse_proxy 127.0.0.1:8080
}
```

## Running behind Nginx Proxy Manager

Nginx Proxy Manager meets the [reverse proxy requirements](#reverse-proxy-requirements) with one addition, the read timeout below. Lager needs two host names, both pointing at the same port:

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

Nginx Proxy Manager passes `Host` on, sets `X-Forwarded-Proto` and `X-Forwarded-For`, and allows large request bodies, so deploys, uploads and live updates work without further settings. Live updates need no `location` block of their own: Lager sends `X-Accel-Buffering: no` with its event streams (`/__lager/db/events`, `/__lager/room/events`), which turns nginx's buffering off for exactly these responses, and its ping every 25 seconds keeps them open. Do not add a `location` block with `proxy_set_header` for them on the "Advanced" tab: such a block loses the `Host` header that Nginx Proxy Manager sets, Lager answers 404, and live updates stop.

One setting is worth adding if apps use `lager.complete`. nginx waits 60 seconds for an answer, and a language model can take up to 90 seconds (more if you raise `LAGER_AI_TIMEOUT_SECONDS`; the timeout in the line below must stay above it). On the "Advanced" tab of the proxy host `*.apps.example.com`, enter this single line:

```nginx
proxy_read_timeout 200s;
```

The same applies to the proxy host of every custom domain (see [Custom domains](custom-domains.md)).

`LAGER_TRUST_PROXY` keeps its default (`true`, one proxy) in this setup; [Reverse proxy requirements](#reverse-proxy-requirements) explains when to change it.

## Running from source

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

Node.js 22.13 or newer is required. `npm test` runs the tests; `npm run build && npm start` starts the built server. If you want to work on Lager itself, the [contributing guide](../CONTRIBUTING.md) explains the workflow.
