# Installation

How to run Lager on your own server, configure it and put it behind a reverse proxy.

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

On first start the first administrator is created from `LAGER_ADMIN_EMAIL` and `LAGER_ADMIN_PASSWORD`. Then open `LAGER_PUBLIC_URL` in a browser and sign in. Further accounts are created through invitations or registration (see [Users and sharing](users-and-sharing.md#accounts-and-roles)).

## Published images

Every release and every commit on `main` is published as a multi-architecture image (`linux/amd64` and `linux/arm64`, so a Raspberry Pi works too) to the GitHub Container Registry:

| Tag | Contains |
| --- | --- |
| `ghcr.io/dm807cam/lager:latest` | the newest release |
| `ghcr.io/dm807cam/lager:1`, `:1.2`, `:1.2.3` | a release line or one exact release (while Lager is 0.x there is no `:0`, because every minor release may break: pin `:0.4` or `:0.4.1`) |
| `ghcr.io/dm807cam/lager:edge` | the current `main` branch, for testing |

To run a published image, replace `build: .` in `docker-compose.yml` with `image: ghcr.io/dm807cam/lager:latest` and start with `docker compose up -d`. To update, run `docker compose pull && docker compose up -d`. Your data stays in the volume. Back it up before a major version change (see [Backup](data-and-backup.md#backup)).

## Configuration

Lager is configured through environment variables only. The template is `.env.example`.

| Variable | Meaning | Default |
| --- | --- | --- |
| `LAGER_PUBLIC_URL` | Public address of the platform (login, dashboard, API, MCP) | required |
| `LAGER_APPS_DOMAIN` | Domain of the apps; instances run at `<slug>.<domain>` | required |
| `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD` | First administrator; only created while no account exists | none |
| `LAGER_DATA_DIR` | Data directory | `./data` (`/data` in the container) |
| `LAGER_PORT` | Port of the server | `8080` |
| `LAGER_HOST` | Address the server binds to. Without Docker, set `127.0.0.1` when the reverse proxy runs on the same machine, so nobody reaches Lager around the proxy. Leave it empty in the container | every interface |
| `LAGER_ACCESS_LOG` | `true` writes one line per request to the log (time, client address, method, host and path without the query string, status, duration) | `false` |
| `LAGER_SECRET` | Key for sessions; otherwise generated and stored in `secret.key` | generated |
| `LAGER_SNAPSHOT_KEEP` | Data snapshots kept per instance | `20` |
| `LAGER_TRASH_DAYS` | Days that deleted instances and apps stay in the trash (`0` = never clean up) | `30` |
| `LAGER_DEFAULT_LOCALE` | Language of pages and mails when neither the account, the `lager_lang` cookie nor the browser's `Accept-Language` names a supported one: `en`, `de`, `fr`, `es` | `en` |
| `LAGER_SMTP_URL` | SMTP access for outgoing mail, for example `smtps://user:password@smtp.example.com:465`; without a value no mail is sent | none |
| `LAGER_MAIL_FROM` | Sender of the mails | `Lager <no-reply@<host of LAGER_PUBLIC_URL>>` |
| `LAGER_INSTANCE_QUOTA_MB` | Size of an instance's data in MiB, integer from 1 | `50` |
| `LAGER_TRUST_PROXY` | Number of proxy hops in front of Lager whose `X-Forwarded-*` headers are trusted: `false`/`0` none, `true` = 1, or a number | `true` (1) |

## Mail

Lager sends mail for verifying email addresses, resetting passwords and invitations with an address. You set two variables for this:

```sh
LAGER_SMTP_URL=smtps://lager%40example.com:secret@smtp.example.com:465
LAGER_MAIL_FROM="Lager <lager@example.com>"
```

Keep the quotes around `LAGER_MAIL_FROM`: without them, loading `.env` in a shell (`set -a; . ./.env`) reads `<` as a redirect. Docker Compose accepts the quotes as well. Special characters in the user name and password of the URL must be percent-encoded (`@` becomes `%40`). If `LAGER_MAIL_FROM` is missing, the sender is `Lager <no-reply@<host of LAGER_PUBLIC_URL>>`. If sending fails, Lager writes the error to the log and shows users no error message.

Without `LAGER_SMTP_URL` Lager runs completely, just without mail:

- Email addresses are not verified; new accounts are usable at once. For this reason registration defaults to "invitation only".
- Invitations work: the link is shown once to the administrator in the administration area, who passes it on.
- "Forgot password" sends nothing. Instead an administrator creates a reset link in the administration area (Users; valid for 1 hour, usable once) and passes it on.

If you enable mail later, existing accounts stay verified.

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

Alternatively you can put the line `proxy_buffering off;` directly into the host's "Custom Nginx Configuration". Without this setting, changes and presence of other users show up late or only after a reload. The same applies to the proxy host of every custom domain (see [Custom domains](custom-domains.md)).

By default Lager trusts exactly one proxy in front of it (`LAGER_TRUST_PROXY=true`, one hop) and takes the last entry of `X-Forwarded-For` as the client address. If several proxies are chained, set the number (for example `2`). Set `false` if Lager is reachable directly from the internet; otherwise anyone can forge the client address and get around the limit on sign-in attempts.

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
