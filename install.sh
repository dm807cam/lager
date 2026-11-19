#!/usr/bin/env bash
# Lager installer and updater: https://github.com/dm807cam/lager
#
#   curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh | sudo bash
#
# Run the same command again at any time: it updates Lager to the newest image, keeps your settings and data,
# and takes a backup first. It works on a fresh Raspberry Pi (64-bit Raspberry Pi OS) and on any 64-bit Linux server.
#
# It asks a few questions on the first run. To answer them ahead of time (for automation), set:
#   LAGER_MODE=cloudflare|local|proxy   how Lager is reached (see below)
#   LAGER_DOMAIN=example.com            cloudflare: a domain on your Cloudflare account, used only for Lager
#   LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN proxy: the addresses your own reverse proxy serves
#   LAGER_ADMIN_EMAIL=you@example.com   the first administrator
#   LAGER_NONINTERACTIVE=1              never ask; fail if an answer is missing
# Further knobs: LAGER_DIR (default /opt/lager), LAGER_IMAGE (default ghcr.io/dm807cam/lager:latest),
# LAGER_RECONFIGURE=1 (ask the questions again), LAGER_BACKUPS_KEEP (default 5).
set -Eeuo pipefail

LAGER_DIR="${LAGER_DIR:-/opt/lager}"
LAGER_IMAGE="${LAGER_IMAGE:-ghcr.io/dm807cam/lager:latest}"
CLOUDFLARED_IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"
LAGER_BACKUPS_KEEP="${LAGER_BACKUPS_KEEP:-5}"
LAGER_NONINTERACTIVE="${LAGER_NONINTERACTIVE:-0}"
LAGER_RECONFIGURE="${LAGER_RECONFIGURE:-0}"
PORT=8080
# The cloudflared image runs as this user, so its directory must belong to it.
CLOUDFLARED_UID=65532
# The Lager image runs as the user "node".
LAGER_UID=1000

# ---------------------------------------------------------------- output

if [ -t 1 ]; then BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
else BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; RESET=''; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
trap 'die "Line $LINENO failed. Nothing you set up so far is lost: fix the cause and run the installer again."' ERR

# ---------------------------------------------------------------- questions

# The script usually arrives through a pipe, so answers come from the terminal, not from standard input.
can_ask() { [ "$LAGER_NONINTERACTIVE" != 1 ] && { : </dev/tty; } 2>/dev/null; }

# ask VAR "Question" [default]: keeps a value already in VAR, otherwise asks, otherwise takes the default.
ask() {
  local var=$1 question=$2 default=${3:-} answer
  if [ -n "${!var:-}" ]; then return; fi
  if can_ask; then
    printf '%s%s%s%s: ' "$BOLD" "$question" "$RESET" "${default:+ [$default]}" >/dev/tty
    IFS= read -r answer </dev/tty || true
    answer=${answer:-$default}
  else
    answer=$default
  fi
  [ -n "$answer" ] || die "No answer for: $question (set $var to answer it ahead of time)."
  printf -v "$var" '%s' "$answer"
}

# ---------------------------------------------------------------- checks

check_system() {
  [ "$(id -u)" = 0 ] || die "Please run the installer as root, for example: curl -fsSL https://raw.githubusercontent.com/dm807cam/lager/main/install.sh | sudo bash"
  [ "$(uname -s)" = Linux ] || die "The installer supports Linux. On other systems, follow docs/installation.md."
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    armv7l|armv6l) die "Lager needs a 64-bit system. On a Raspberry Pi, install the 64-bit Raspberry Pi OS (Pi 3, 4, 5 and Zero 2 support it)." ;;
    *) die "Unsupported processor: $(uname -m). Lager images exist for amd64 and arm64." ;;
  esac
}

ensure_docker() {
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    say "Installing Docker with its official script (get.docker.com)..."
    curl -fsSL https://get.docker.com | sh
  fi
  if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
  docker compose version >/dev/null 2>&1 || die "Docker is installed, but the Compose plugin is missing. Install the package docker-compose-plugin and run the installer again."
  ok "Docker is ready."
}

# ---------------------------------------------------------------- settings

STATE="$LAGER_DIR/installer.env"
ENV_FILE="$LAGER_DIR/.env"

load_state() {
  mkdir -p "$LAGER_DIR"
  chmod 700 "$LAGER_DIR"
  # Values from an earlier run win over defaults, but answers given in the environment win over both.
  if [ -f "$STATE" ]; then
    local key value
    while IFS='=' read -r key value; do
      case "$key" in LAGER_MODE|LAGER_DOMAIN|LAGER_TUNNEL_ID|LAGER_TUNNEL_NAME) [ -n "${!key:-}" ] || printf -v "$key" '%s' "$value" ;; esac
    done <"$STATE"
  fi
}

save_state() {
  {
    echo "# Written by install.sh: how this Lager was set up. Delete it (or run with LAGER_RECONFIGURE=1) to choose again."
    echo "LAGER_MODE=${LAGER_MODE}"
    echo "LAGER_DOMAIN=${LAGER_DOMAIN:-}"
    echo "LAGER_TUNNEL_ID=${LAGER_TUNNEL_ID:-}"
    echo "LAGER_TUNNEL_NAME=${LAGER_TUNNEL_NAME:-}"
  } >"$STATE"
  chmod 600 "$STATE"
}

env_get() {
  if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; fi
}

# env_set KEY VALUE: replace the key's line, or append it. Values never contain newlines.
env_set() {
  local key=$1 value=$2 tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -v "^$key=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}

lan_ip() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] || ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  [ -n "$ip" ] || die "Could not find this machine's address in the local network."
  printf '%s' "$ip"
}

choose_mode() {
  if [ -n "${LAGER_MODE:-}" ]; then return; fi
  if can_ask; then
    cat >/dev/tty <<EOF

${BOLD}How should Lager be reached?${RESET}
  1) Through Cloudflare (recommended): https on your own domain, from anywhere, without opening ports.
     You need a free Cloudflare account and a domain on it that you use only for Lager.
  2) Only in this network, to try it out: http addresses for devices on the same Wi-Fi.
     AI assistants connect with an API token; claude.ai and ChatGPT need option 1 or 3.
  3) Through my own reverse proxy: I already have a domain, TLS and a proxy.
EOF
  fi
  local choice=''
  ask choice "Choose 1, 2 or 3" 1
  case "$choice" in
    1|cloudflare) LAGER_MODE=cloudflare ;;
    2|local) LAGER_MODE=local ;;
    3|proxy) LAGER_MODE=proxy ;;
    *) die "Please answer 1, 2 or 3." ;;
  esac
}

configure() {
  local first=$1 public_url apps_domain trust bind
  [ "$first" = 1 ] || [ "$LAGER_RECONFIGURE" = 1 ] || return 0
  if [ "$LAGER_RECONFIGURE" = 1 ] && [ -z "${LAGER_MODE_FROM_ENV:-}" ]; then LAGER_MODE=''; fi
  step "Settings"
  choose_mode
  case "$LAGER_MODE" in
    cloudflare)
      if can_ask && [ -z "${LAGER_DOMAIN:-}" ]; then
        say "Lager will live at https://<domain> and its apps at https://<app>.<domain>." >/dev/tty
        say "Cloudflare's free certificate covers exactly these two levels, so use a domain for Lager alone (for example mylager.net)." >/dev/tty
      fi
      ask LAGER_DOMAIN "Domain on your Cloudflare account"
      LAGER_DOMAIN=$(printf '%s' "$LAGER_DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##; s#\.$##')
      public_url="https://$LAGER_DOMAIN"; apps_domain="$LAGER_DOMAIN"; trust=true; bind=127.0.0.1 ;;
    local)
      local ip dashed
      ip=$(lan_ip); dashed=${ip//./-}
      # sslip.io answers every name that contains an address with that address, so app subdomains need no DNS setup.
      public_url="http://lager.$dashed.sslip.io:$PORT"; apps_domain="apps.$dashed.sslip.io"; trust=false; bind=0.0.0.0 ;;
    proxy)
      ask LAGER_PUBLIC_URL "Address of the platform (for example https://lager.example.com)"
      ask LAGER_APPS_DOMAIN "Domain of the apps, served with a wildcard (for example apps.example.com)"
      public_url=$LAGER_PUBLIC_URL; apps_domain=$LAGER_APPS_DOMAIN; trust=true; bind=${LAGER_BIND:-127.0.0.1} ;;
    *) die "Unknown LAGER_MODE \"$LAGER_MODE\": use cloudflare, local or proxy." ;;
  esac
  env_set LAGER_PUBLIC_URL "$public_url"
  env_set LAGER_APPS_DOMAIN "$apps_domain"
  env_set LAGER_TRUST_PROXY "$trust"
  env_set LAGER_BIND "$bind"
  if [ "$first" = 1 ]; then
    local default_email
    case "$LAGER_MODE" in cloudflare) default_email="admin@$LAGER_DOMAIN" ;; *) default_email="admin@example.com" ;; esac
    ask LAGER_ADMIN_EMAIL "Email address for your administrator account" "$default_email"
    GENERATED_PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 20 || true)
    env_set LAGER_ADMIN_EMAIL "$LAGER_ADMIN_EMAIL"
    env_set LAGER_ADMIN_PASSWORD "$GENERATED_PASSWORD"
  fi
  save_state
}

write_compose() {
  local bind
  bind=$(env_get LAGER_BIND); bind=${bind:-127.0.0.1}
  {
    echo "# Written by install.sh, which rewrites it on every run. Settings belong in .env."
    echo "services:"
    echo "  lager:"
    echo "    image: ${LAGER_IMAGE}"
    echo "    env_file: .env"
    echo "    ports:"
    echo "      - \"${bind}:${PORT}:${PORT}\""
    echo "    volumes:"
    echo "      - ./data:/data"
    echo "      - ./backups:/backups"
    echo "    restart: unless-stopped"
    if [ "$LAGER_MODE" = cloudflare ]; then
      echo "  cloudflared:"
      echo "    image: ${CLOUDFLARED_IMAGE}"
      echo "    command: tunnel --no-autoupdate --config /etc/cloudflared/config.yml run"
      echo "    volumes:"
      echo "      - ./cloudflared:/etc/cloudflared:ro"
      echo "    depends_on:"
      echo "      - lager"
      echo "    restart: unless-stopped"
    fi
  } >"$LAGER_DIR/docker-compose.yml"
  mkdir -p "$LAGER_DIR/data" "$LAGER_DIR/backups"
  chown "$LAGER_UID:$LAGER_UID" "$LAGER_DIR/data" "$LAGER_DIR/backups"
  chmod 600 "$ENV_FILE"
}

# ---------------------------------------------------------------- Cloudflare Tunnel

CF_DIR="$LAGER_DIR/cloudflared"
cloudflared() { docker run --rm -v "$CF_DIR:/home/nonroot/.cloudflared" "$CLOUDFLARED_IMAGE" "$@"; }

setup_tunnel() {
  [ "$LAGER_MODE" = cloudflare ] || return 0
  step "Cloudflare Tunnel"
  mkdir -p "$CF_DIR"
  chown "$CLOUDFLARED_UID:$CLOUDFLARED_UID" "$CF_DIR"
  chmod 700 "$CF_DIR"

  if [ ! -s "$CF_DIR/cert.pem" ]; then
    cat <<EOF

${BOLD}One step in your browser:${RESET} a link follows. Open it on any device (phone or laptop),
sign in to Cloudflare, choose ${BOLD}${LAGER_DOMAIN}${RESET} and confirm. The installer continues by itself.

EOF
    cloudflared tunnel login
    [ -s "$CF_DIR/cert.pem" ] || die "Cloudflare did not confirm the login. Run the installer again to get a new link."
  fi
  ok "Signed in to Cloudflare."

  if [ -z "${LAGER_TUNNEL_ID:-}" ] || [ ! -s "$CF_DIR/$LAGER_TUNNEL_ID.json" ]; then
    LAGER_TUNNEL_NAME=${LAGER_TUNNEL_NAME:-lager-$(hostname | tr -cd 'A-Za-z0-9-' | head -c 40)}
    local out
    if ! out=$(cloudflared tunnel create "$LAGER_TUNNEL_NAME" 2>&1); then
      if printf '%s' "$out" | grep -qi 'already exists'; then
        # A tunnel of that name exists from an earlier installation whose credentials are gone; use a fresh name.
        LAGER_TUNNEL_NAME="$LAGER_TUNNEL_NAME-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 6 || true)"
        out=$(cloudflared tunnel create "$LAGER_TUNNEL_NAME" 2>&1) || die "Could not create the tunnel: $out"
      else
        die "Could not create the tunnel: $out"
      fi
    fi
    LAGER_TUNNEL_ID=$(printf '%s' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1)
    [ -n "$LAGER_TUNNEL_ID" ] && [ -s "$CF_DIR/$LAGER_TUNNEL_ID.json" ] || die "The tunnel was created, but its credentials are missing: $out"
    save_state
  fi
  ok "Tunnel $LAGER_TUNNEL_NAME is ready."

  # Both names point at the tunnel: the platform at the domain itself, every app at a name directly below it.
  cloudflared tunnel route dns --overwrite-dns "$LAGER_TUNNEL_ID" "$LAGER_DOMAIN" >/dev/null 2>&1 \
    || die "Could not point $LAGER_DOMAIN at the tunnel. Is $LAGER_DOMAIN on the Cloudflare account you signed in with?"
  if cloudflared tunnel route dns --overwrite-dns "$LAGER_TUNNEL_ID" "*.$LAGER_DOMAIN" >/dev/null 2>&1; then
    ok "$LAGER_DOMAIN and *.$LAGER_DOMAIN point at the tunnel."
  else
    warn "Could not create the DNS record for the apps automatically. Add it once in the Cloudflare dashboard (DNS → Records):"
    warn "  Type CNAME, name *, target $LAGER_TUNNEL_ID.cfargotunnel.com, proxied (orange cloud)."
  fi

  cat >"$CF_DIR/config.yml" <<EOF
# Written by install.sh, which rewrites it on every run.
tunnel: $LAGER_TUNNEL_ID
credentials-file: /etc/cloudflared/$LAGER_TUNNEL_ID.json
ingress:
  - hostname: $LAGER_DOMAIN
    service: http://lager:$PORT
  - hostname: "*.$LAGER_DOMAIN"
    service: http://lager:$PORT
  - service: http_status:404
EOF
  chmod 644 "$CF_DIR/config.yml"
}

# ---------------------------------------------------------------- start or update

compose() { docker compose --project-directory "$LAGER_DIR" -f "$LAGER_DIR/docker-compose.yml" "$@"; }

backup_before_update() {
  # Only an update has something to back up; the server keeps running while the backup is taken.
  compose ps --status running --services 2>/dev/null | grep -qx lager || return 0
  step "Backup"
  local name
  name=$(date +%Y-%m-%d-%H%M%S)
  if compose exec -T lager node dist/backup.js "/backups/$name" >/dev/null 2>&1; then
    ok "Saved a backup to $LAGER_DIR/backups/$name."
    # Keep the newest ones.
    find "$LAGER_DIR/backups" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n "-$LAGER_BACKUPS_KEEP" | sed "s#^#$LAGER_DIR/backups/#" | xargs -r rm -rf
  else
    warn "The backup did not work; continuing with the update. Your data directory is untouched."
  fi
}

start() {
  step "Starting Lager"
  compose pull --quiet || die "Could not download $LAGER_IMAGE. If Lager has not published a release yet, run with LAGER_IMAGE=ghcr.io/dm807cam/lager:edge."
  compose up -d --remove-orphans
  local host _
  host=$(env_get LAGER_PUBLIC_URL | sed 's#^[a-z]*://##; s#/.*$##')
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null -H "Host: $host" "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
      ok "Lager is running."
      return 0
    fi
    sleep 1
  done
  compose logs --tail 30 lager >&2 || true
  die "Lager did not start. The last log lines are above."
}

summary() {
  local first=$1 url
  url=$(env_get LAGER_PUBLIC_URL)
  step "Done"
  if [ "$first" = 1 ]; then
    cat <<EOF

  Open ${BOLD}${url}${RESET} and sign in:
    Email:    $(env_get LAGER_ADMIN_EMAIL)
    Password: ${BOLD}${GENERATED_PASSWORD}${RESET}   ${DIM}(change it on the Account page)${RESET}
EOF
  else
    say "  Lager is up to date: ${BOLD}${url}${RESET}"
  fi
  cat <<EOF

  Connect your AI assistant with this address: ${BOLD}${url}/mcp${RESET}
    ${DIM}How, for Claude, ChatGPT, Cursor and others: https://github.com/dm807cam/lager/blob/main/docs/connecting-ai.md${RESET}

  Update later by running the same command again. Everything lives in ${LAGER_DIR}
  (data in data/, backups in backups/, settings in .env).
EOF
  if [ "$LAGER_MODE" = local ]; then
    cat <<EOF

  ${YELLOW}This address works only in this network and without https.${RESET} AI assistants that sign in
  with OAuth (claude.ai, ChatGPT) need https: run the installer with LAGER_RECONFIGURE=1 to switch to Cloudflare.
EOF
  fi
  if [ "$LAGER_MODE" = cloudflare ] && ! curl -fsS -o /dev/null "$url/healthz" 2>/dev/null; then
    say ""
    warn "${url} does not answer yet. New DNS names can take a few minutes; try again shortly."
  fi
}

main() {
  if [ -n "${LAGER_MODE:-}" ]; then LAGER_MODE_FROM_ENV=1; fi
  check_system
  ensure_docker
  load_state
  local first=0
  [ -s "$ENV_FILE" ] || first=1
  if [ "$first" = 0 ] && [ -z "${LAGER_MODE:-}" ]; then
    die "$ENV_FILE exists but $STATE is missing. Run with LAGER_MODE=cloudflare, local or proxy to say how this Lager is reached."
  fi
  configure "$first"
  write_compose
  setup_tunnel
  [ "$first" = 1 ] || backup_before_update
  start
  summary "$first"
}

main "$@"
