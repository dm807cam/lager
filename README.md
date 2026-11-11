<img src="assets/icon.webp" alt="Lager" width="96" height="96">

# Lager

Lager ist ein selbst gehosteter Server für Claude-Artefakte, also kleine HTML-Apps, die Claude für dich baut. Statt ein Artefakt nur in claude.ai zu behalten, veröffentlicht Claude es auf deinem Server:

- Jede App bekommt eine eigene Subdomain (`<slug>.apps.example.com`).
- Jeder Deploy erzeugt eine nummerierte Version. Du kannst jederzeit auf eine ältere Version zurückgehen.
- Jede App-Instanz hat einen eigenen Datenspeicher (Dokumente mit Live-Updates), den das Artefakt über `claude.use("db")` anspricht. Beim Wechsel der aktiven Version legt Lager vorher einen Schnappschuss der Daten an.
- Zugriff pro Instanz: privat, alle Angemeldeten oder öffentlich.
- Bedient wird Lager über ein Dashboard im Browser, eine REST-API und einen MCP-Endpunkt für Claude.

Lager läuft als ein einzelner Node-Prozess mit SQLite und Dateien in einem Datenverzeichnis. Es gibt keine weiteren Dienste.

## Schnellstart mit Docker

Voraussetzung: Docker mit Compose.

```sh
cp .env.example .env
# .env anpassen: mindestens LAGER_PUBLIC_URL, LAGER_APPS_DOMAIN, LAGER_ADMIN_EMAIL, LAGER_ADMIN_PASSWORD
docker compose up -d --build
```

Der Container lauscht auf Port 8080 und speichert alles in `./data`. Beim ersten Start entsteht das Admin-Konto aus `LAGER_ADMIN_EMAIL` und `LAGER_ADMIN_PASSWORD`. Danach öffnest du `LAGER_PUBLIC_URL` im Browser und meldest dich an.

Konfiguration (nur Umgebungsvariablen, Vorlage in `.env.example`):

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `LAGER_PUBLIC_URL` | Öffentliche Adresse der Plattform (Login, Dashboard, API, MCP) | Pflicht |
| `LAGER_APPS_DOMAIN` | Domain der Apps; Instanzen laufen unter `<slug>.<Domain>` | Pflicht |
| `LAGER_ADMIN_EMAIL`, `LAGER_ADMIN_PASSWORD` | Admin-Konto beim ersten Start | keins |
| `LAGER_DATA_DIR` | Datenverzeichnis | `./data` (im Container `/data`) |
| `LAGER_PORT` | Port des Servers | `8080` |
| `LAGER_SECRET` | Schlüssel für Sitzungen; sonst erzeugt und in `secret.key` gespeichert | erzeugt |
| `LAGER_SNAPSHOT_KEEP` | Aufbewahrte Daten-Schnappschüsse pro Instanz | `20` |
| `LAGER_TRUST_PROXY` | Anzahl der Proxy-Stationen vor Lager, deren `X-Forwarded-*` vertraut wird: `false`/`0` keine, `true` = 1, oder eine Zahl | `true` (1) |

## Lokal ausprobieren

Browser lösen `*.localhost` von selbst auf `127.0.0.1` auf. Ein DNS-Eintrag ist lokal deshalb nicht nötig.

```sh
npm ci
cp .env.example .env     # die Werte für lokal sind schon eingetragen
set -a; . ./.env; set +a
LAGER_DATA_DIR=./data npm run dev
```

- Plattform: `http://localhost:8080`
- Instanzen: `http://<slug>.apps.localhost:8080`

Die Plattform heißt hier `localhost` und nicht `lager.localhost`, weil das MCP-SDK für OAuth eine Adresse ohne https nur für den Hostnamen `localhost` akzeptiert.

Voraussetzung ist Node.js 22.13 oder neuer. Mit `npm test` laufen die Tests, mit `npm run build && npm start` startest du den gebauten Server.

## Betrieb hinter Nginx Proxy Manager

Lager braucht zwei Hostnamen, beide zeigen auf denselben Port:

1. Die Plattform, zum Beispiel `lager.example.com`.
2. Alle Apps: `*.apps.example.com` (Wildcard).

Vorbereitung:

- DNS: `lager.example.com` und `*.apps.example.com` zeigen auf den Proxy.
- Zertifikat: Für `*.apps.example.com` brauchst du ein Wildcard-Zertifikat. Das geht nur mit DNS-Challenge, in Nginx Proxy Manager unter „SSL Certificates → Add → Let's Encrypt“ mit „Use a DNS Challenge“ und dem Anbieter deiner Domain.
- `.env`: `LAGER_PUBLIC_URL=https://lager.example.com`, `LAGER_APPS_DOMAIN=apps.example.com`. Instanzen erhalten dann Adressen wie `https://notes.apps.example.com`.

In Nginx Proxy Manager legst du zwei Proxy Hosts an:

| Domain Names | Forward | Optionen |
| --- | --- | --- |
| `lager.example.com` | `http`, Host des Containers, Port 8080 | Websockets Support an, SSL-Zertifikat, Force SSL |
| `*.apps.example.com` | `http`, Host des Containers, Port 8080 | Websockets Support an, Wildcard-Zertifikat, Force SSL |

Live-Updates der Datenbank laufen als Server-Sent Events über `/__lager/db/events`. Der Proxy darf diese Antworten nicht puffern. Trage im Reiter „Advanced“ des Proxy Hosts `*.apps.example.com` ein:

```nginx
location /__lager/db/events {
    proxy_pass http://<Host des Containers>:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

Alternativ kannst du die Zeile `proxy_buffering off;` direkt in die „Custom Nginx Configuration“ des Hosts setzen. Ohne diese Einstellung erscheinen Änderungen anderer Nutzer verzögert oder erst nach einem Neuladen.

Lager vertraut standardmäßig genau einem Proxy vor sich (`LAGER_TRUST_PROXY=true`, also eine Station) und nimmt als Client-Adresse den letzten Eintrag von `X-Forwarded-For`. Stehen mehrere Proxys hintereinander, setze die Anzahl (zum Beispiel `2`). Setze `false`, wenn Lager direkt aus dem Internet erreichbar ist, sonst kann jeder die Client-Adresse fälschen und die Begrenzung der Anmeldeversuche umgehen.

## Claude verbinden

Das Dashboard zeigt die Adresse deines Connectors: `<LAGER_PUBLIC_URL>/mcp`.

OAuth, das claude.ai und Claude Desktop beim Verbinden benutzen, funktioniert nur, wenn `LAGER_PUBLIC_URL` mit `https` beginnt oder der Host `localhost` ist. API-Tokens funktionieren mit jeder Adresse.

- **claude.ai und Claude Desktop:** Einstellungen → Connectors → benutzerdefinierten Connector hinzufügen, die Adresse `<LAGER_PUBLIC_URL>/mcp` eintragen. Beim Verbinden meldest du dich bei Lager an und erlaubst den Zugriff.
- **Claude Code:**
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp
  ```
  Danach `/mcp` in Claude Code öffnen und die Anmeldung abschließen.
- **API-Token statt OAuth:** Im Dashboard unter „API-Tokens“ einen Token erstellen. Er wird nur einmal angezeigt. Damit funktionieren beide Wege:
  ```sh
  claude mcp add --transport http lager https://lager.example.com/mcp \
    --header "Authorization: Bearer lgr_..."

  curl -X PUT -H "Authorization: Bearer $LAGER_TOKEN" -H "Content-Type: text/html" \
    --data-binary @examples/notes.html \
    "https://lager.example.com/api/apps/notes?title=Notizen&capabilities=%7B%22db%22%3A%7B%7D%2C%22user%22%3A%7B%7D%7D"
  ```

Die Antwort des Deploys enthält die Adresse der neuen Instanz. `examples/notes.html` ist ein kleines Beispiel-Artefakt (Notizliste mit `claude.use("db")`).

## Skill installieren

Der Skill `skill/lager/SKILL.md` bringt Claude bei, Artefakte mit Lager zu bauen und zu deployen. Sein Inhalt ist dieselbe Anleitung, die der MCP-Endpunkt ausliefert (`src/guide.md`).

- **Claude Code:** `cp -r skill/lager ~/.claude/skills/lager`
- **claude.ai und Desktop:** Den Ordner `skill/lager` als ZIP packen und unter Einstellungen → Fähigkeiten (Skills) hochladen.

## Datensicherung

Alles liegt im Datenverzeichnis (`./data` bei Docker Compose): Datenbank der Plattform, alle Versionen, die Daten und Schnappschüsse der Instanzen und `secret.key`. Zum Sichern den Dienst stoppen und das Verzeichnis kopieren:

```sh
docker compose stop
cp -a data data-backup-$(date +%F)
docker compose start
```

Zum Wiederherstellen das Verzeichnis zurückkopieren. Behalte `secret.key` (oder `LAGER_SECRET`), sonst werden alle Sitzungen ungültig.

## Was Stufe 1 nicht kann

- Es gibt genau ein Konto, das beim ersten Start angelegt wird. Weitere Konten, Rollen und eine Benutzerverwaltung folgen später.
- „Alle Angemeldeten“ meint Konten dieser Installation. Mit nur einem Konto ist das praktisch dasselbe wie „Privat“.
- Weitere Instanzen einer App legt Claude über das MCP-Werkzeug an; das Dashboard kann sie anzeigen, aber nicht anlegen.
- Keine Capabilities außer `db` und `user`; alle anderen liefern `null`.
- Kein eigenes TLS: HTTPS übernimmt der vorgeschaltete Proxy.
- Keine automatische Datensicherung und keine Replikation.
